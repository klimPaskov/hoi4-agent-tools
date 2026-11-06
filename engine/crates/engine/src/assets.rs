//! Assets, for `hoi4-engine assets` and the MCP tool `hoi4.asset_inspect`: sprites with their
//! textures, sounds and music (`.asset` files) with their audio files, and country flags.
//!
//! - One id: every definition in load order, the facts the game reads (texture size and format,
//!   frames, audio file, flag sizes), each file or name it points at with whether it exists, the
//!   files that mention it, and its problems.
//! - Audit: the same checks for everything the checked layer defines, with counts per code. The
//!   flag audit also finds country tags of the mod that have no flag at all.
//!
//! Texture headers come from the engine's image header reader. A BC7 texture is risky because in
//! an in-game check on 1.19.4.1 one failed to load and the game crashed. Flags are drawn at 82x52,
//! 41x26 (`medium/`) and 10x7 (`small/`) pixels.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use hoi4_syntax::{Block, Document, Item, Value};
use rayon::prelude::*;
use serde::Deserialize;

use crate::ideas::{self, Audit, AuditProblem, Field, Loaded, Problem};
use crate::imagehdr::TextureHeader;
use crate::index::Kind;
use crate::localisation;
use crate::sprites::{ResolvedTexture, SpriteDef, SpriteKind};
use crate::system::{Definition, Part, Reference, Response};
use crate::workspace::WorkspaceOptions;

const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 100;
const MAX_LISTED: usize = 100;
const MAX_REFERENCES: usize = 40;

/// The sizes the game draws flags at: folder, width and height.
const FLAG_SIZES: [(&str, u32, u32); 3] = [("", 82, 52), ("medium/", 41, 26), ("small/", 10, 7)];

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub game: Option<PathBuf>,
    #[serde(rename = "mod")]
    pub target: Option<PathBuf>,
    #[serde(default)]
    pub dependencies: Vec<PathBuf>,
    #[serde(default = "yes")]
    pub include_dlc: bool,
    pub kind: AssetKind,
    /// A sprite name, a sound, sound effect, category or music name, or a flag (`TAG` or
    /// `TAG_ideology`); not used by an audit.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub audit: bool,
    pub limit: Option<usize>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Sprite,
    Sound,
    Flag,
}

impl AssetKind {
    fn label(self) -> &'static str {
        match self {
            AssetKind::Sprite => "sprite",
            AssetKind::Sound => "sound",
            AssetKind::Flag => "flag",
        }
    }
}

/// Uneven frames shift each frame by part of a pixel, and the game fills some sprites without a
/// texture itself (the flag sprites of `interface/mapicons.gfx`), so both are information.
fn severity(code: &str) -> &'static str {
    if matches!(code, "ASSET_FRAMES_MISMATCH" | "ASSET_TEXTURE_NONE" | "ASSET_TEXTURE_EMPTY" | "ASSET_FLAG_SIZE_CLOSE") { "info" } else { "warning" }
}

fn problem(code: &'static str, message: String, line: u32) -> Problem {
    Problem { code, severity: severity(code), message, line }
}

pub fn respond_json(text: &str) -> (String, u8) {
    let request: Request = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => return (error("ASSET_INVALID_REQUEST", &e.to_string()), 2),
    };
    if request.audit {
        return (serde_json::to_string(&audit(&request)).unwrap_or_else(|e| error("ASSET_INTERNAL", &e.to_string())), 0);
    }
    if request.id.is_empty() || request.id.len() > 256 {
        return (error("ASSET_ID_REQUIRED", "pass an id of 1 to 256 characters, or audit"), 2);
    }
    (serde_json::to_string(&respond(&request)).unwrap_or_else(|e| error("ASSET_INTERNAL", &e.to_string())), 0)
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
}

/// A `sound`, `soundeffect`, `category` or `music` block of a `.asset` file.
struct SoundDef {
    what: &'static str,
    name: String,
    file: usize,
    line: u32,
    /// `file = …`, as written, with its line.
    audio: Option<(String, u32)>,
    /// Sounds a sound effect plays, or sound effects a category lists.
    plays: Vec<(String, u32)>,
    /// Other fields as written.
    fields: Vec<Field>,
}

/// One flag file: its size folder, layer and path.
struct FlagFile {
    size: usize,
    layer: usize,
    relative: String,
    texture: ResolvedTexture,
}

struct State {
    loaded: Loaded,
    kind: AssetKind,
    sounds: Vec<SoundDef>,
    /// Flag files by lower-case file stem, in load order.
    flags: BTreeMap<String, Vec<FlagFile>>,
}

fn load(request: &Request) -> State {
    let options = WorkspaceOptions {
        game: request.game.clone(),
        include_dlc: request.include_dlc,
        dependencies: request.dependencies.clone(),
        target: request.target.clone(),
    };
    let extra: &[&str] = if request.kind == AssetKind::Flag { &["common/country_tags/"] } else { &[] };
    let loaded = ideas::load_with(&options, extra);
    let sounds = if request.kind == AssetKind::Sound { sounds(&loaded) } else { Vec::new() };
    let flags = if request.kind == AssetKind::Flag { flags(&loaded) } else { BTreeMap::new() };
    State { loaded, kind: request.kind, sounds, flags }
}

fn sounds(loaded: &Loaded) -> Vec<SoundDef> {
    let workspace = &loaded.workspace;
    let files: Vec<usize> = workspace
        .loaded_files()
        .filter(|(_, f)| {
            let p = f.relative.to_ascii_lowercase();
            (p.starts_with("sound/") || p.starts_with("music/")) && p.ends_with(".asset")
        })
        .map(|(i, _)| i)
        .collect();
    let mut out: Vec<SoundDef> = files
        .par_iter()
        .flat_map_iter(|&file| {
            let Ok(bytes) = fs::read(&workspace.files[file].absolute) else { return Vec::new() };
            let doc = Document::parse(bytes);
            let mut defs = Vec::new();
            for entry in doc.root.entries() {
                let what = match doc.key(entry).as_ref() {
                    "sound" => "sound",
                    "soundeffect" => "soundeffect",
                    "category" => "category",
                    "music" => "music",
                    _ => continue,
                };
                let Some(block) = entry.value.as_block() else { continue };
                let Some((name, _)) = scalar(&doc, block, "name") else { continue };
                let line = ideas::line_at(&doc, doc.token(entry.key).start);
                let mut plays = Vec::new();
                if let Some(sounds) = block.entries().find(|e| doc.key(e) == "sounds").and_then(|e| e.value.as_block()) {
                    for e in sounds.entries() {
                        match (doc.key(e).as_ref(), &e.value) {
                            ("sound", Value::Scalar(t)) => plays.push((unquote(&doc.text(*t)), ideas::line_at(&doc, doc.token(*t).start))),
                            ("weighted_sound", Value::Block(b)) => plays.extend(scalar(&doc, b, "sound")),
                            _ => {}
                        }
                    }
                }
                if let Some(effects) = block.entries().find(|e| doc.key(e) == "soundeffects").and_then(|e| e.value.as_block()) {
                    for item in &effects.items {
                        if let Item::Value(Value::Scalar(t)) = item {
                            plays.push((unquote(&doc.text(*t)), ideas::line_at(&doc, doc.token(*t).start)));
                        }
                    }
                }
                let fields = block
                    .entries()
                    .filter(|e| !matches!(doc.key(e).as_ref(), "sounds" | "soundeffects"))
                    .take(12)
                    .map(|e| Field { name: doc.key(e).into_owned(), text: ideas::raw(&doc, e), line: ideas::line_at(&doc, doc.token(e.key).start) })
                    .collect();
                defs.push(SoundDef { what, name, file, line, audio: scalar(&doc, block, "file"), plays, fields });
            }
            defs
        })
        .collect();
    out.sort_by_key(|d| (workspace.files[d.file].layer, d.file, d.line));
    out
}

/// Every flag file of every layer, by size folder. A later layer's file at the same path replaces
/// an earlier one, and both are listed.
fn flags(loaded: &Loaded) -> BTreeMap<String, Vec<FlagFile>> {
    let workspace = &loaded.workspace;
    let mut out: BTreeMap<String, Vec<FlagFile>> = BTreeMap::new();
    for (layer, l) in workspace.layers.iter().enumerate() {
        for (size, (folder, _, _)) in FLAG_SIZES.iter().enumerate() {
            let Ok(entries) = fs::read_dir(l.path.join("gfx/flags").join(folder)) else { continue };
            let mut names: Vec<String> = entries.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            for name in names {
                let Some(stem) = name.strip_suffix(".tga").or_else(|| name.strip_suffix(".TGA")) else { continue };
                let relative = format!("gfx/flags/{folder}{name}");
                let texture = loaded.sprites.texture(&relative);
                out.entry(stem.to_ascii_lowercase()).or_default().push(FlagFile { size, layer, relative, texture });
            }
        }
    }
    out
}

fn unquote(text: &str) -> String {
    text.trim_matches('"').to_owned()
}

fn scalar(doc: &Document, block: &Block, key: &str) -> Option<(String, u32)> {
    block.entries().find(|e| doc.key(e) == key).and_then(|e| e.value.as_scalar().map(|t| (unquote(&doc.text(t)), ideas::line_at(doc, doc.token(t).start))))
}

fn describe(texture: &ResolvedTexture) -> String {
    match (&texture.header, &texture.header_error) {
        (Some(h), _) => format!("{} ({}): {}", texture.relative.as_deref().unwrap_or(&texture.key), texture.layer.as_deref().unwrap_or(""), header_text(h)),
        (None, Some(e)) => format!("{}: unreadable ({e})", texture.key),
        (None, None) if texture.exists => texture.relative.clone().unwrap_or_default(),
        (None, None) => format!("{}: no layer has it", texture.key),
    }
}

fn header_text(h: &TextureHeader) -> String {
    let mips = h.mip_count.map(|m| format!(", {m} mips")).unwrap_or_default();
    format!("{} {} {}x{}{mips}", h.container, h.pixel_format, h.width, h.height)
}

fn risky(h: &TextureHeader) -> bool {
    matches!(h.dxgi_format, Some(98 | 99))
}

/// What checking one definition found.
#[derive(Default)]
struct Found {
    fields: Vec<Field>,
    parts: Vec<Part>,
    references: Vec<Reference>,
    problems: Vec<Problem>,
}

impl Found {
    fn field(&mut self, name: &str, text: String, line: u32) {
        self.fields.push(Field { name: name.to_owned(), text, line });
    }
}

fn check_sprite(state: &State, def: &SpriteDef) -> Found {
    let loaded = &state.loaded;
    let mut out = Found::default();
    let own = Some(loaded.workspace.files[def.file].layer) == loaded.workspace.target_layer();
    out.field("type", def.block_type.clone(), def.line);
    if def.frames > 1 {
        out.field("noOfFrames", def.frames.to_string(), def.line);
    }
    if let Some(effect) = &def.effect_file {
        out.field("effectFile", effect.clone(), def.line);
    }
    let Some(path) = &def.texturefile else {
        if def.kind != SpriteKind::TextSpriteType && own {
            out.problems.push(problem(
                "ASSET_TEXTURE_NONE",
                format!("`{}` has no `texturefile`; unless the game fills it, as it does flag sprites, it draws nothing", def.name),
                def.line,
            ));
        }
        return out;
    };
    let Some(texture) = loaded.sprites.texture_of(def) else { return out };
    out.field("texture", describe(texture), def.line);
    out.references.push(Reference { field: "texturefile".into(), target: "texture", value: path.clone(), known: texture.exists, line: def.line });
    if !texture.exists {
        // A texture of the game that no file has is supplied by a DLC that is not installed here.
        if own && loaded.judge_sprites && !loaded.game_textures.contains(&texture.key) {
            out.problems.push(problem(
                "ASSET_TEXTURE_MISSING",
                format!("`texturefile` names `{path}`, which no layer has, so the game draws nothing"),
                def.line,
            ));
        }
        return out;
    }
    if let Some(e) = &texture.header_error {
        // An empty file is how mods hide a picture of the game.
        if texture.absolute.as_ref().and_then(|p| fs::metadata(p).ok()).is_some_and(|m| m.len() == 0) {
            out.problems.push(problem(
                "ASSET_TEXTURE_EMPTY",
                format!("`{path}` is an empty file, so the game draws nothing; mods do this to hide a picture"),
                def.line,
            ));
        } else {
            out.problems.push(problem("ASSET_TEXTURE_UNREADABLE", format!("`{path}` cannot be read as a texture: {e}"), def.line));
        }
    }
    if let Some(h) = &texture.header {
        if def.frames > 1 && h.width % def.frames != 0 {
            out.problems.push(problem(
                "ASSET_FRAMES_MISMATCH",
                format!(
                    "`noOfFrames = {}`, but `{path}` is {} pixels wide, which {} frames do not divide evenly, so the frames drift by part of a pixel",
                    def.frames, h.width, def.frames
                ),
                def.line,
            ));
        }
        if risky(h) {
            out.problems.push(problem(
                "ASSET_TEXTURE_FORMAT_RISKY",
                format!("`{path}` is {}; in an in-game check on 1.19.4.1 a BC7 texture failed to load and the game crashed, so save it as BC3 (DXT5) or uncompressed", h.pixel_format),
                def.line,
            ));
        }
    }
    out
}

fn check_sound(state: &State, def: &SoundDef) -> Found {
    let workspace = &state.loaded.workspace;
    let mut out = Found { fields: def.fields.clone(), ..Found::default() };
    if matches!(def.what, "sound" | "music") {
        match &def.audio {
            None => out.problems.push(problem("ASSET_FILE_MISSING", format!("the {} `{}` has no `file`, so it plays nothing", def.what, def.name), def.line)),
            Some((file, line)) => {
                // The path is relative to the folder of the `.asset` file.
                let relative = &workspace.files[def.file].relative;
                let folder = relative.rsplit_once('/').map_or("", |(dir, _)| dir);
                let path = format!("{folder}/{file}");
                let found = state.loaded.sprites.texture(&path);
                out.references.push(Reference { field: "file".into(), target: "audio_file", value: path.clone(), known: found.exists, line: *line });
                if !found.exists {
                    out.problems.push(problem(
                        "ASSET_FILE_MISSING",
                        format!("`file` names `{path}`, which no layer has, so the {} plays nothing", def.what),
                        *line,
                    ));
                }
            }
        }
    }
    let (target, names): (&'static str, HashSet<String>) = match def.what {
        "soundeffect" => ("sound", state.sounds.iter().filter(|s| s.what == "sound").map(|s| s.name.to_ascii_lowercase()).collect()),
        "category" => ("soundeffect", state.sounds.iter().filter(|s| s.what == "soundeffect").map(|s| s.name.to_ascii_lowercase()).collect()),
        _ => ("", HashSet::new()),
    };
    for (name, line) in &def.plays {
        out.parts.push(Part { what: target, id: name.clone(), line: *line });
        let known = names.contains(&name.to_ascii_lowercase());
        if !known {
            out.problems.push(problem(
                "ASSET_REFERENCE_UNKNOWN",
                format!("`{}` lists the {target} `{name}`, which no loaded .asset file defines", def.name),
                *line,
            ));
        }
        out.references.push(Reference {
            field: if target == "sound" { "sounds".into() } else { "soundeffects".into() },
            target,
            value: name.clone(),
            known,
            line: *line,
        });
    }
    out
}

fn check_flag(stem: &str, files: &[FlagFile]) -> Found {
    let mut out = Found::default();
    // The file the game uses at each size: the last layer's.
    let mut used: [Option<&FlagFile>; 3] = [None, None, None];
    for f in files {
        used[f.size] = Some(f);
    }
    for (size, (folder, width, height)) in FLAG_SIZES.iter().enumerate() {
        let label = if folder.is_empty() { "large" } else { folder.trim_end_matches('/') };
        let Some(f) = used[size] else {
            // Without the large flag the name is not in use, and a stray smaller file is no problem.
            if used[0].is_none() {
                continue;
            }
            out.problems.push(problem(
                "ASSET_FLAG_MISSING",
                format!("no layer has `gfx/flags/{folder}{stem}.tga`, so the {label} flag ({width}x{height}) shows the game's fallback"),
                1,
            ));
            continue;
        };
        out.field(label, describe(&f.texture), 1);
        out.references.push(Reference { field: label.into(), target: "texture", value: f.relative.clone(), known: true, line: 1 });
        match (&f.texture.header, &f.texture.header_error) {
            // Kaiserreich's 984 small flags are 11x7 and look right in game, so one pixel off is information.
            (Some(h), _) if h.width.abs_diff(*width) <= 1 && h.height.abs_diff(*height) <= 1 && (h.width != *width || h.height != *height) => {
                out.problems.push(problem(
                    "ASSET_FLAG_SIZE_CLOSE",
                    format!("`{}` is {}x{}, one pixel off the {width}x{height} the game draws {label} flags at", f.relative, h.width, h.height),
                    1,
                ))
            }
            (Some(h), _) if h.width != *width || h.height != *height => out.problems.push(problem(
                "ASSET_FLAG_SIZE",
                format!("`{}` is {}x{}, but the game draws {label} flags at {width}x{height}, so it is stretched", f.relative, h.width, h.height),
                1,
            )),
            (None, Some(e)) => out.problems.push(problem("ASSET_TEXTURE_UNREADABLE", format!("`{}` cannot be read as a texture: {e}", f.relative), 1)),
            _ => {}
        }
    }
    out
}

fn finish(out: Found, response: &mut Response) {
    response.fields = out.fields;
    response.parts_truncated = out.parts.len() > MAX_LISTED;
    response.parts = out.parts.into_iter().take(MAX_LISTED).collect();
    let mut references = out.references;
    references.sort_by_key(|r| r.known);
    response.references_truncated = references.len() > MAX_REFERENCES;
    references.truncate(MAX_REFERENCES);
    response.references = references;
    response.problems = out.problems;
}

pub fn respond(request: &Request) -> Response {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let state = load(request);
    let workspace = &state.loaded.workspace;
    let id = request.id.as_str();
    let mut response = Response {
        kind: state.kind.label(),
        id: id.to_owned(),
        found: false,
        definitions: Vec::new(),
        fields: Vec::new(),
        parts: Vec::new(),
        parts_truncated: false,
        references: Vec::new(),
        references_truncated: false,
        texts: Vec::new(),
        mentions: Vec::new(),
        mentions_truncated: false,
        problems: Vec::new(),
        suggestions: Vec::new(),
    };
    let names: BTreeSet<String> = match state.kind {
        AssetKind::Sprite => {
            let defs = state.loaded.sprites.definitions_of(id);
            response.definitions = defs.iter().map(|d| Definition { what: "sprite", place: ideas::place(workspace, d.file, d.line) }).collect();
            if let Some(def) = defs.last() {
                finish(check_sprite(&state, def), &mut response);
            }
            state.loaded.sprites.effective().map(|d| d.name.clone()).collect()
        }
        AssetKind::Sound => {
            let defs: Vec<&SoundDef> = state.sounds.iter().filter(|d| d.name.eq_ignore_ascii_case(id)).collect();
            response.definitions = defs.iter().map(|d| Definition { what: d.what, place: ideas::place(workspace, d.file, d.line) }).collect();
            // A sound and a sound effect may share a name; check the last of each.
            let mut checked = Found::default();
            for what in ["sound", "soundeffect", "category", "music"] {
                if let Some(def) = defs.iter().rev().find(|d| d.what == what) {
                    let found = check_sound(&state, def);
                    checked.fields.extend(found.fields);
                    checked.parts.extend(found.parts);
                    checked.references.extend(found.references);
                    checked.problems.extend(found.problems);
                }
            }
            if !defs.is_empty() {
                finish(checked, &mut response);
            }
            state.sounds.iter().map(|d| d.name.clone()).collect()
        }
        AssetKind::Flag => {
            if let Some(files) = state.flags.get(&id.to_ascii_lowercase()) {
                response.definitions = files
                    .iter()
                    .map(|f| Definition {
                        what: "flag",
                        place: ideas::Place {
                            path: f.relative.clone(),
                            line: 1,
                            layer: workspace.layers[f.layer].name.clone(),
                            layer_kind: ideas::layer_kind(workspace.layers[f.layer].kind),
                        },
                    })
                    .collect();
                finish(check_flag(id, files), &mut response);
            }
            state.flags.keys().map(|k| k.to_ascii_uppercase()).collect()
        }
    };
    response.found = !response.definitions.is_empty();
    if !response.found {
        response.suggestions = ideas::suggest(id, names.into_iter());
        return response;
    }
    // A flag's tag appears in nearly every file of its country, so its mentions say nothing.
    if state.kind != AssetKind::Flag {
        let (mentions, truncated) = localisation::mentions(workspace, id, limit);
        response.mentions = mentions;
        response.mentions_truncated = truncated;
    }
    response
}

/// Everything the checked layer defines, with the checks of the single inspection.
pub fn audit(request: &Request) -> Audit {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let state = load(request);
    let workspace = &state.loaded.workspace;
    let target = workspace.target_layer();
    let mut checked = 0;
    let mut found: Vec<(String, String, Found)> = Vec::new();
    match state.kind {
        AssetKind::Sprite => {
            let own: Vec<&SpriteDef> = state.loaded.sprites.definitions().iter().filter(|d| Some(workspace.files[d.file].layer) == target).collect();
            checked = own.len();
            found = own.par_iter().map(|d| (d.name.clone(), d.path.clone(), check_sprite(&state, d))).collect();
        }
        AssetKind::Sound => {
            let own: Vec<&SoundDef> = state.sounds.iter().filter(|d| Some(workspace.files[d.file].layer) == target).collect();
            checked = own.len();
            found = own.iter().map(|d| (d.name.clone(), workspace.files[d.file].relative.clone(), check_sound(&state, d))).collect();
        }
        AssetKind::Flag => {
            for (stem, files) in &state.flags {
                if !files.iter().any(|f| Some(f.layer) == target) {
                    continue;
                }
                checked += 1;
                let name = files
                    .last()
                    .map(|f| f.relative.rsplit('/').next().unwrap_or("").trim_end_matches(".tga").trim_end_matches(".TGA").to_owned())
                    .unwrap_or_else(|| stem.clone());
                // The mod's large flag when it has one, else its last smaller file.
                let own: Vec<&FlagFile> = files.iter().filter(|f| Some(f.layer) == target).collect();
                let path = own.iter().find(|f| f.size == 0).or(own.last()).map(|f| f.relative.clone()).unwrap_or_default();
                found.push((name.clone(), path, check_flag(&name, files)));
            }
            found.extend(tags_without_flags(&state));
        }
    }
    let mut counts = BTreeMap::new();
    let mut problems = Vec::new();
    for (id, path, f) in found {
        let mut seen = HashSet::new();
        for p in f.problems {
            if !seen.insert((p.code, p.message.clone(), p.line)) {
                continue;
            }
            let count = counts.entry(p.code).or_insert(0);
            *count += 1;
            if *count <= limit {
                problems.push(AuditProblem { code: p.code, severity: p.severity, id: id.clone(), path: path.clone(), line: p.line, message: p.message });
            }
        }
    }
    let truncated = counts.values().any(|&c| c > limit);
    Audit { kind: state.kind.label(), checked, counts, problems, truncated }
}

/// Country tags the checked layer defines whose flag no layer has at any size, neither `TAG.tga`
/// nor an ideology flag such as `TAG_fascism.tga`.
fn tags_without_flags(state: &State) -> Vec<(String, String, Found)> {
    let workspace = &state.loaded.workspace;
    let target = workspace.target_layer();
    let mut stems: HashMap<String, ()> = HashMap::new();
    for stem in state.flags.keys() {
        stems.insert(stem.split('_').next().unwrap_or(stem).to_owned(), ());
    }
    // Tags of a `dynamic_tags = yes` file take the flag of the country they are made for.
    let mut dynamic: HashMap<usize, bool> = HashMap::new();
    let mut out = Vec::new();
    for (tag, defs) in state.loaded.index.definitions(Kind::CountryTag) {
        let Some(def) = defs.iter().rev().find(|d| Some(workspace.files[d.file].layer) == target) else { continue };
        if tag.len() != 3 || stems.contains_key(&tag.to_ascii_lowercase()) {
            continue;
        }
        let is_dynamic = *dynamic.entry(def.file).or_insert_with(|| {
            fs::read(&workspace.files[def.file].absolute).is_ok_and(|b| {
                let doc = Document::parse(b);
                doc.root.entries().any(|e| doc.key(e) == "dynamic_tags" && e.value.as_scalar().is_some_and(|t| doc.text(t) == "yes"))
            })
        });
        if is_dynamic {
            continue;
        }
        let mut f = Found::default();
        f.problems.push(problem(
            "ASSET_FLAG_MISSING",
            format!("the country `{tag}` has no flag in any layer, neither `gfx/flags/{tag}.tga` nor an ideology flag"),
            def.line,
        ));
        out.push((tag.clone(), workspace.files[def.file].relative.clone(), f));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

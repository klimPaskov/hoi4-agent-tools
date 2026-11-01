//! The sprite index: every sprite the loaded `interface/**/*.gfx` files define, with the texture
//! it points at resolved across the game, DLC and mod folders and its header read.
//!
//! A sprite is a `spriteType`, `SpriteType`, `frameAnimatedSpriteType`, `corneredTileSpriteType`
//! or `textSpriteType` block inside a `spriteTypes = { ... }` block (keys are case-insensitive).
//! Files come from [`Workspace`], so a later layer's file with the same path replaces an earlier
//! one and a mod's `replace_path` unloads the folder. When two loaded files define the same name
//! (compared without case), the one loaded last is effective, as in the game's load order: layer
//! by layer, files sorted by path.
//!
//! A texture path is resolved against the layers from last to first without regard to case. A
//! layer's file is skipped when a later layer's `replace_path` unloads its folder.
//!
//! ```no_run
//! use hoi4_engine::sprites::SpriteIndex;
//! use hoi4_engine::{Workspace, WorkspaceOptions};
//!
//! let ws = Workspace::load(&WorkspaceOptions {
//!     game: Some("C:/Games/Hearts of Iron IV".into()),
//!     include_dlc: true,
//!     ..WorkspaceOptions::default()
//! });
//! let index = SpriteIndex::build(&ws);
//! if let Some(sprite) = index.get("GFX_goal_unknown") {
//!     let size = index.texture_of(sprite).and_then(|t| t.header.as_ref()).map(|h| (h.width, h.height));
//!     println!("{} -> {:?} {:?}", sprite.name, sprite.texturefile, size);
//! }
//! ```

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hoi4_syntax::{Block, Document, Value};
use rayon::prelude::*;
use serde::Serialize;

use crate::imagehdr::{TextureHeader, read_header};
use crate::workspace::Workspace;

/// The block type that defined a sprite.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpriteKind {
    SpriteType,
    FrameAnimatedSpriteType,
    CorneredTileSpriteType,
    TextSpriteType,
}

impl SpriteKind {
    fn from_key(key: &str) -> Option<SpriteKind> {
        match key.to_ascii_lowercase().as_str() {
            "spritetype" => Some(SpriteKind::SpriteType),
            "frameanimatedspritetype" => Some(SpriteKind::FrameAnimatedSpriteType),
            "corneredtilespritetype" => Some(SpriteKind::CorneredTileSpriteType),
            "textspritetype" => Some(SpriteKind::TextSpriteType),
            _ => None,
        }
    }
}

/// One sprite definition.
#[derive(Clone, Debug, Serialize)]
pub struct SpriteDef {
    pub name: String,
    pub kind: SpriteKind,
    /// The block's key as written (`spriteType`, `SpriteType`, ...).
    pub block_type: String,
    /// `texturefile` with forward slashes, in the case it was written.
    pub texturefile: Option<String>,
    /// Lower-case form of `texturefile`, the key of [`SpriteIndex::texture`].
    pub texture_key: Option<String>,
    /// `noOfFrames`, 1 when absent.
    pub frames: u32,
    pub effect_file: Option<String>,
    pub legacy_lazy_load: Option<bool>,
    pub load_type: Option<String>,
    /// Number of `animation = { ... }` blocks.
    pub animation_blocks: usize,
    /// Name of the layer that holds the defining file.
    pub layer: String,
    /// Path relative to the layer root, forward slashes.
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub start: u32,
    pub end: u32,
    /// Workspace file index of the defining file.
    #[serde(skip)]
    pub file: usize,
    /// True for the definition the game uses (the last one loaded for this name).
    pub effective: bool,
}

/// What resolving a texture path found.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedTexture {
    /// Lower-case, forward-slash path that was looked up.
    pub key: String,
    pub exists: bool,
    /// Layer that supplies the file; the last layer that has it wins.
    pub layer: Option<String>,
    /// Path relative to the layer root with the case the file system has.
    pub relative: Option<String>,
    #[serde(skip)]
    pub absolute: Option<PathBuf>,
    pub header: Option<TextureHeader>,
    /// Why the header could not be read, when the file exists.
    pub header_error: Option<String>,
}

/// Forward slashes, no leading `/` or `./`, trimmed. The case is kept.
pub fn normalize_texture_path(raw: &str) -> String {
    let mut path = raw.trim().replace('\\', "/");
    while path.contains("//") {
        path = path.replace("//", "/");
    }
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    path.trim_start_matches('/').to_string()
}

/// The comparison key of a texture path.
pub fn texture_key(raw: &str) -> String {
    normalize_texture_path(raw).to_ascii_lowercase()
}

struct ResolverLayer {
    name: String,
    root: PathBuf,
    replace: Vec<String>,
}

#[derive(Default)]
struct TextureResolver {
    layers: Vec<ResolverLayer>,
    dirs: HashMap<PathBuf, Option<HashMap<String, String>>>,
}

impl TextureResolver {
    fn new(ws: &Workspace) -> TextureResolver {
        TextureResolver {
            layers: ws
                .layers
                .iter()
                .map(|l| ResolverLayer {
                    name: l.name.clone(),
                    root: l.path.clone(),
                    replace: l.replace_paths.iter().map(|p| p.to_ascii_lowercase()).collect(),
                })
                .collect(),
            dirs: HashMap::new(),
        }
    }

    fn listing(&mut self, dir: &Path) -> Option<&HashMap<String, String>> {
        self.dirs
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                let entries = fs::read_dir(dir).ok()?;
                let mut map = HashMap::new();
                let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                names.sort();
                for name in names {
                    map.entry(name.to_ascii_lowercase()).or_insert(name);
                }
                Some(map)
            })
            .as_ref()
    }

    /// Finds the file for a lower-case key: `(layer index, absolute path, relative path)`.
    fn locate(&mut self, key: &str) -> Option<(usize, PathBuf, String)> {
        let folder = key.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
        let parts: Vec<&str> = key.split('/').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() || parts.contains(&"..") {
            return None;
        }
        for index in (0..self.layers.len()).rev() {
            let hidden = self.layers.iter().skip(index + 1).any(|l| l.replace.contains(&folder));
            if hidden {
                continue;
            }
            let mut current = self.layers[index].root.clone();
            let mut relative = Vec::new();
            let mut found = true;
            for (n, part) in parts.iter().enumerate() {
                let Some(actual) = self.listing(&current).and_then(|m| m.get(*part)).cloned() else {
                    found = false;
                    break;
                };
                current.push(&actual);
                relative.push(actual);
                if n + 1 == parts.len() && !current.is_file() {
                    found = false;
                }
            }
            if found {
                return Some((index, current, relative.join("/")));
            }
        }
        None
    }

    fn layer_name(&self, index: usize) -> String {
        self.layers[index].name.clone()
    }
}

fn resolved(resolver: &mut TextureResolver, key: &str) -> ResolvedTexture {
    match resolver.locate(key) {
        Some((layer, absolute, relative)) => ResolvedTexture {
            key: key.to_string(),
            exists: true,
            layer: Some(resolver.layer_name(layer)),
            relative: Some(relative),
            absolute: Some(absolute),
            header: None,
            header_error: None,
        },
        None => ResolvedTexture { key: key.to_string(), exists: false, layer: None, relative: None, absolute: None, header: None, header_error: None },
    }
}

fn fill_header(t: &mut ResolvedTexture) {
    if let Some(path) = &t.absolute {
        match read_header(path) {
            Ok(h) => t.header = Some(h),
            Err(e) => t.header_error = Some(e),
        }
    }
}

/// The index. Build it once per workspace.
pub struct SpriteIndex {
    defs: Vec<SpriteDef>,
    by_name: HashMap<String, Vec<usize>>,
    textures: HashMap<String, ResolvedTexture>,
    resolver: Mutex<TextureResolver>,
}

fn scalar_text(doc: &Document, block: &Block, key: &str) -> Option<String> {
    block.entries().find(|e| doc.key(e).eq_ignore_ascii_case(key)).and_then(|e| e.value.as_scalar()).map(|t| doc.text(t).trim().to_string())
}

fn yes(text: &str) -> bool {
    matches!(text.to_ascii_lowercase().as_str(), "yes" | "true" | "1")
}

/// Sprite definitions of one parsed `.gfx` file, without the layer fields.
fn parse_gfx(doc: &Document, file: usize, layer: &str, path: &str) -> Vec<SpriteDef> {
    let mut out = Vec::new();
    for sprites in doc.root.entries().filter(|e| doc.key(e).eq_ignore_ascii_case("spriteTypes")) {
        let Some(list) = sprites.value.as_block() else { continue };
        for entry in list.entries() {
            let block_type = doc.key(entry).into_owned();
            let Some(kind) = SpriteKind::from_key(&block_type) else { continue };
            let Some(block) = entry.value.as_block() else { continue };
            let Some(name_token) = block.entries().find(|e| doc.key(e).eq_ignore_ascii_case("name")).and_then(|e| e.value.as_scalar()) else { continue };
            let name = doc.text(name_token).trim().to_string();
            if name.is_empty() {
                continue;
            }
            let texturefile = scalar_text(doc, block, "texturefile").filter(|t| !t.is_empty()).map(|t| normalize_texture_path(&t));
            let frames = scalar_text(doc, block, "noOfFrames").and_then(|t| t.parse::<u32>().ok()).unwrap_or(1);
            let start = doc.token(entry.key).start;
            let end = doc.byte_range(&entry.tokens).end;
            out.push(SpriteDef {
                name,
                kind,
                block_type,
                texture_key: texturefile.as_deref().map(str::to_ascii_lowercase),
                texturefile,
                frames,
                effect_file: scalar_text(doc, block, "effectFile").filter(|t| !t.is_empty()),
                legacy_lazy_load: scalar_text(doc, block, "legacy_lazy_load").map(|t| yes(&t)),
                load_type: scalar_text(doc, block, "loadType"),
                animation_blocks: block.entries().filter(|e| doc.key(e).eq_ignore_ascii_case("animation") && matches!(e.value, Value::Block(_))).count(),
                layer: layer.to_string(),
                path: path.to_string(),
                line: doc.position(start).0,
                column: doc.position(start).1,
                start,
                end,
                file,
                effective: false,
            });
        }
    }
    out
}

impl SpriteIndex {
    /// Indexes the sprites of every loaded `interface/**/*.gfx` file and resolves their textures.
    pub fn build(ws: &Workspace) -> SpriteIndex {
        let files: Vec<(usize, &str, &Path, &str)> = ws
            .loaded_files()
            .filter(|(_, f)| {
                let key = f.key();
                key.starts_with("interface/") && key.ends_with(".gfx")
            })
            .map(|(i, f)| (i, f.relative.as_str(), f.absolute.as_path(), ws.layers[f.layer].name.as_str()))
            .collect();
        let parsed: Vec<Vec<SpriteDef>> = files
            .par_iter()
            .map(|(index, relative, absolute, layer)| match fs::read(absolute) {
                Ok(bytes) => parse_gfx(&Document::parse(bytes), *index, layer, relative),
                Err(_) => Vec::new(),
            })
            .collect();
        let mut defs: Vec<SpriteDef> = parsed.into_iter().flatten().collect();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, def) in defs.iter().enumerate() {
            by_name.entry(def.name.to_ascii_lowercase()).or_default().push(i);
        }
        for list in by_name.values() {
            if let Some(&last) = list.last() {
                defs[last].effective = true;
            }
        }
        let mut resolver = TextureResolver::new(ws);
        let mut textures: HashMap<String, ResolvedTexture> = HashMap::new();
        let mut keys: Vec<&String> = defs.iter().filter_map(|d| d.texture_key.as_ref()).collect();
        keys.sort();
        keys.dedup();
        for key in keys {
            textures.insert(key.clone(), resolved(&mut resolver, key));
        }
        textures.par_iter_mut().for_each(|(_, t)| fill_header(t));
        SpriteIndex { defs, by_name, textures, resolver: Mutex::new(resolver) }
    }

    /// Every definition in load order, shadowed ones included.
    pub fn definitions(&self) -> &[SpriteDef] {
        &self.defs
    }

    /// The definitions the game uses, one per name.
    pub fn effective(&self) -> impl Iterator<Item = &SpriteDef> {
        self.defs.iter().filter(|d| d.effective)
    }

    /// Number of distinct sprite names.
    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    /// The effective definition of a sprite name, compared without case.
    pub fn get(&self, name: &str) -> Option<&SpriteDef> {
        self.by_name.get(&name.to_ascii_lowercase()).and_then(|l| l.last()).map(|&i| &self.defs[i])
    }

    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// Every definition of a name, in load order (the last is effective).
    pub fn definitions_of(&self, name: &str) -> Vec<&SpriteDef> {
        self.by_name.get(&name.to_ascii_lowercase()).map(|l| l.iter().map(|&i| &self.defs[i]).collect()).unwrap_or_default()
    }

    /// Effective sprites whose `texturefile` is this path, compared without case and slash style.
    pub fn by_texture(&self, path: &str) -> Vec<&SpriteDef> {
        let key = texture_key(path);
        self.defs.iter().filter(|d| d.effective && d.texture_key.as_deref() == Some(key.as_str())).collect()
    }

    /// Resolves a texture path that a sprite or a script names. Paths sprites use are cached.
    pub fn texture(&self, path: &str) -> ResolvedTexture {
        let key = texture_key(path);
        if let Some(t) = self.textures.get(&key) {
            return t.clone();
        }
        let mut resolver = self.resolver.lock().unwrap_or_else(|e| e.into_inner());
        let mut t = resolved(&mut resolver, &key);
        fill_header(&mut t);
        t
    }

    /// The resolved texture of a sprite definition.
    pub fn texture_of(&self, def: &SpriteDef) -> Option<&ResolvedTexture> {
        def.texture_key.as_ref().and_then(|k| self.textures.get(k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texture_paths_normalise_slashes_and_case() {
        assert_eq!(normalize_texture_path(" .\\gfx\\Interface/A.dds "), "gfx/Interface/A.dds");
        assert_eq!(texture_key("/GFX/Interface/A.DDS"), "gfx/interface/a.dds");
    }

    #[test]
    fn parses_every_block_type_and_defaults() {
        let text = br#"spriteTypes = {
            SpriteType = { name = "GFX_a" texturefile = "gfx\\x\\A.dds" }
            frameAnimatedSpriteType = { name = GFX_b texturefile = gfx/x/b.dds noOfFrames = 2 effectFile = "gfx/FX/f.lua" legacy_lazy_load = no loadType = "INGAME"
                animation = { animationtype = scrolling } animation = { animationtype = pulsing } }
            corneredTileSpriteType = { name = GFX_c texturefile = gfx/x/c.dds }
            textSpriteType = { name = GFX_d }
            progressbartype = { name = GFX_not_a_sprite }
        }"#;
        let doc = Document::parse(text.to_vec());
        let defs = parse_gfx(&doc, 0, "game", "interface/a.gfx");
        assert_eq!(defs.len(), 4);
        assert_eq!(defs[0].texturefile.as_deref(), Some("gfx/x/A.dds"));
        assert_eq!(defs[0].texture_key.as_deref(), Some("gfx/x/a.dds"));
        assert_eq!(defs[0].frames, 1);
        assert_eq!((defs[1].frames, defs[1].animation_blocks, defs[1].legacy_lazy_load), (2, 2, Some(false)));
        assert_eq!(defs[1].load_type.as_deref(), Some("INGAME"));
        assert_eq!(defs[1].effect_file.as_deref(), Some("gfx/FX/f.lua"));
        assert_eq!(defs[2].kind, SpriteKind::CorneredTileSpriteType);
        assert!(defs[3].texturefile.is_none());
    }
}

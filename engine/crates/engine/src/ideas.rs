//! Ideas and characters, for `hoi4-engine ideas` and the MCP tools `hoi4.idea_inspect` and
//! `hoi4.character_inspect`. It reads only the folders these need (ideas, characters, traits,
//! modifier definitions, the interface sprites and localisation) in every layer, so it does not
//! pay for a whole-workspace analysis.
//!
//! - `idea`: the idea's category, every definition in load order, its picture sprite and texture,
//!   its modifiers checked against the game's documentation and the mod's modifier definitions,
//!   its conditions and effects as written, its name and description in every language, the
//!   character whose advisor role it is, and the script files that mention it.
//! - `character`: the character's name in every language, each role (country leader, advisor,
//!   general, field marshal, admiral, operative) with its traits checked against their
//!   definitions, each portrait with its sprite or file, and the files that mention it.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::PathBuf;

use hoi4_syntax::{Block, Document, Entry};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::context::is_dynamic;
use crate::defs;
use crate::index::{Kind, SymbolIndex, levenshtein};
use crate::localisation::{self, Definition as Text, Mention};
use crate::sprites::SpriteIndex;
use crate::vocab::Vocabulary;
use crate::workspace::{LayerKind, Workspace, WorkspaceOptions};

const MAX_RAW: usize = 600;
const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 100;

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
    pub kind: Subject,
    /// The idea or character; not used by an audit.
    #[serde(default)]
    pub id: String,
    /// Check every idea or character the mod defines instead of one.
    #[serde(default)]
    pub audit: bool,
    pub limit: Option<usize>,
}

/// A missing name may be intended (generic leaders, literal names), so it is information.
fn severity(code: &str) -> &'static str {
    if matches!(code, "IDEA_NAME_MISSING" | "CHARACTER_NAME_MISSING") { "info" } else { "warning" }
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Subject {
    Idea,
    Character,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub path: String,
    pub line: u32,
    pub layer: String,
    pub layer_kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: &'static str,
    /// `warning` for something players see, `info` for something that may be intended.
    pub severity: &'static str,
    pub message: String,
    pub line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    /// The value or block as written, at most 600 characters.
    pub text: String,
    pub line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Modifier {
    /// The block it sits in: `modifier`, `research_bonus`, `equipment_bonus`, `targeted_modifier`.
    pub block: String,
    pub key: String,
    pub value: String,
    /// Documented by the game, defined by `common/modifier_definitions`, or computed.
    pub known: bool,
    pub line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    pub sprite: String,
    pub defined: bool,
    pub texture: Option<String>,
    pub texture_exists: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trait {
    pub name: String,
    pub known: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    /// `country_leader`, `advisor`, `corps_commander`, `field_marshal`, `navy_leader`, `operative`.
    pub role: String,
    /// The `instance` block (from 0) the role belongs to, when the character has instances.
    pub instance: Option<usize>,
    pub fields: Vec<Field>,
    pub traits: Vec<Trait>,
    pub line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portrait {
    /// `civilian.large`, `army.small` and so on.
    pub slot: String,
    pub value: String,
    pub exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub kind: &'static str,
    pub id: String,
    pub found: bool,
    /// Every definition in load order; the last one is the one the game uses.
    pub definitions: Vec<Place>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<Picture>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<Modifier>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<Role>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub portraits: Vec<Portrait>,
    /// The character whose advisor role defines this idea through `idea_token`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advisor_of: Option<String>,
    /// Name and description texts by key, in every language.
    pub texts: Vec<KeyTexts>,
    pub mentions: Vec<Mention>,
    pub mentions_truncated: bool,
    pub problems: Vec<Problem>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyTexts {
    pub key: String,
    pub texts: Vec<Text>,
}

pub(crate) fn layer_kind(kind: LayerKind) -> &'static str {
    match kind {
        LayerKind::Game => "game",
        LayerKind::Dlc => "dlc",
        LayerKind::Dependency => "dependency",
        LayerKind::Mod => "mod",
    }
}

/// Folders whose definitions this module needs: ideas and characters, their traits, and what
/// modifier names are built from (buildings, equipment, resources, sub-units, combat tactics).
const FOLDERS: &[&str] = &[
    "common/ideas/",
    "common/characters/",
    "common/country_leader/",
    "common/unit_leader/",
    "common/modifier_definitions/",
    "common/ideologies/",
    "common/buildings/",
    "common/units/",
    "common/resources/",
    "common/combat_tactics",
    "common/static_modifiers/",
    "common/idea_tags/",
    "common/unit_tags/",
    "common/operations/",
];

pub fn respond_json(text: &str) -> (String, u8) {
    let request: Request = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => return (error("IDEAS_INVALID_REQUEST", &e.to_string()), 2),
    };
    if request.audit {
        let audit = audit(&request);
        return (serde_json::to_string(&audit).unwrap_or_else(|e| error("IDEAS_INTERNAL", &e.to_string())), 0);
    }
    if request.id.is_empty() || request.id.len() > 256 {
        return (error("IDEAS_ID_REQUIRED", "pass an id of 1 to 256 characters, or audit"), 2);
    }
    let response = respond(&request);
    (serde_json::to_string(&response).unwrap_or_else(|e| error("IDEAS_INTERNAL", &e.to_string())), 0)
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
}

pub(crate) struct Loaded {
    pub(crate) workspace: Workspace,
    pub(crate) index: SymbolIndex,
    pub(crate) modifier_definitions: HashSet<String>,
    pub(crate) sprites: SpriteIndex,
    /// Idea categories and their slots from `common/idea_tags`: each has a `<name>_cost_factor`.
    pub(crate) idea_slots: HashSet<String>,
    /// Categories marked `hidden = yes`, whose ideas show no picture or name.
    pub(crate) hidden_categories: HashSet<String>,
    /// `sub_unit_categories` and operations, which modifier names are built from.
    pub(crate) unit_categories: HashSet<String>,
    pub(crate) operations: HashSet<String>,
    /// Texture paths the game's own sprites use. A missing one is supplied by a DLC that is not
    /// installed here, so a mod's sprite that reuses it is not judged.
    pub(crate) game_textures: HashSet<String>,
    /// The checked layer is a mod. A sprite of the game that no loaded file defines may come from
    /// a DLC that is not installed here, so undefined sprites are judged only for a mod's content.
    pub(crate) judge_sprites: bool,
}

fn load(request: &Request) -> Loaded {
    load_with(
        &WorkspaceOptions {
            game: request.game.clone(),
            include_dlc: request.include_dlc,
            dependencies: request.dependencies.clone(),
            target: request.target.clone(),
        },
        &[],
    )
}

/// The workspace with the definitions of `FOLDERS` and `extra` indexed, the modifier names and
/// the sprites. `hoi4-engine system` passes the folders of the system it checks.
pub(crate) fn load_with(options: &WorkspaceOptions, extra: &[&str]) -> Loaded {
    let workspace = Workspace::load(options);
    let files: Vec<usize> = workspace
        .loaded_files()
        .filter(|(_, f)| {
            let p = f.relative.to_ascii_lowercase();
            p.ends_with(".txt") && FOLDERS.iter().chain(extra).any(|folder| p.starts_with(folder))
        })
        .map(|(i, _)| i)
        .collect();
    /// Per file: definitions, modifier definitions, idea categories and other built-from names.
    type Categories = Vec<(String, bool, Vec<String>)>;
    type Names = Vec<(&'static str, String)>;
    type FileFacts = (Vec<crate::index::Definition>, Vec<String>, Categories, Names);
    let parsed: Vec<FileFacts> = files
        .par_iter()
        .filter_map(|&file| {
            let bytes = fs::read(&workspace.files[file].absolute).ok()?;
            let doc = Document::parse(bytes);
            let path = workspace.files[file].relative.to_ascii_lowercase();
            let custom = if path.starts_with("common/modifier_definitions/") {
                doc.root.entries().map(|e| doc.key(e).to_ascii_lowercase()).collect()
            } else {
                Vec::new()
            };
            let mut categories = Vec::new();
            let mut names = Vec::new();
            if path.starts_with("common/unit_tags/") {
                for block in doc.root.entries().filter(|e| doc.key(e) == "sub_unit_categories").filter_map(|e| e.value.as_block()) {
                    for item in &block.items {
                        if let hoi4_syntax::Item::Value(hoi4_syntax::Value::Scalar(t)) = item {
                            names.push(("unit_category", doc.text(*t).to_ascii_lowercase()));
                        }
                    }
                }
            } else if path.starts_with("common/operations/") {
                names.extend(doc.root.entries().map(|e| ("operation", doc.key(e).to_ascii_lowercase())));
            }
            if path.starts_with("common/idea_tags/") {
                for block in doc.root.entries().filter(|e| doc.key(e) == "idea_categories").filter_map(|e| e.value.as_block()) {
                    for category in block.entries() {
                        let Some(inner) = category.value.as_block() else { continue };
                        let hidden = inner.entries().any(|e| doc.key(e) == "hidden" && e.value.as_scalar().is_some_and(|t| doc.text(t) == "yes"));
                        let slots = inner
                            .entries()
                            .filter(|e| matches!(doc.key(e).as_ref(), "slot" | "character_slot"))
                            .filter_map(|e| e.value.as_scalar().map(|t| doc.text(t).to_ascii_lowercase()))
                            .collect();
                        categories.push((doc.key(category).to_ascii_lowercase(), hidden, slots));
                    }
                }
            }
            Some((defs::script_definitions(&doc, &path, file), custom, categories, names))
        })
        .collect();
    let mut index = SymbolIndex::default();
    let mut modifier_definitions = HashSet::new();
    let mut idea_slots = HashSet::new();
    let mut hidden_categories = HashSet::new();
    let mut unit_categories = HashSet::new();
    let mut operations = HashSet::new();
    for (definitions, custom, categories, names) in parsed {
        for (kind, name) in names {
            if kind == "operation" {
                operations.insert(name)
            } else {
                unit_categories.insert(name)
            };
        }
        for d in definitions {
            index.insert(d);
        }
        modifier_definitions.extend(custom);
        for (name, hidden, slots) in categories {
            if hidden {
                hidden_categories.insert(name.clone());
            }
            idea_slots.insert(name);
            idea_slots.extend(slots);
        }
    }
    let sprites = SpriteIndex::build(&workspace);
    let judge_sprites = workspace.target_layer().is_some_and(|t| workspace.layers[t].kind == LayerKind::Mod);
    // Every game and DLC .gfx file, including those a mod's same-path file replaces.
    let game_textures = workspace
        .files
        .par_iter()
        .filter(|f| matches!(workspace.layers[f.layer].kind, LayerKind::Game | LayerKind::Dlc) && f.relative.to_ascii_lowercase().ends_with(".gfx"))
        .flat_map_iter(|f| {
            let text = fs::read(&f.absolute).map(|b| String::from_utf8_lossy(&b).to_ascii_lowercase()).unwrap_or_default();
            text.match_indices("texturefile")
                .filter_map(|(at, _)| {
                    let rest = &text[at..];
                    let open = rest.find('"')?;
                    let close = rest[open + 1..].find('"')?;
                    Some(crate::sprites::texture_key(&rest[open + 1..open + 1 + close]))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    Loaded { workspace, index, modifier_definitions, sprites, idea_slots, hidden_categories, unit_categories, operations, game_textures, judge_sprites }
}

pub(crate) fn place(workspace: &Workspace, file: usize, line: u32) -> Place {
    let source = &workspace.files[file];
    let layer = &workspace.layers[source.layer];
    Place { path: source.relative.clone(), line, layer: layer.name.clone(), layer_kind: layer_kind(layer.kind) }
}

pub(crate) fn line_at(doc: &Document, offset: u32) -> u32 {
    1 + doc.line_starts().partition_point(|&s| s <= offset).saturating_sub(1) as u32
}

pub(crate) fn raw(doc: &Document, entry: &Entry) -> String {
    let start = doc.token(entry.tokens.start).start as usize;
    let end = doc.token(entry.tokens.end.saturating_sub(1)).end as usize;
    let text = String::from_utf8_lossy(&doc.bytes[start..end.max(start)]);
    let mut out: String = text.chars().take(MAX_RAW).collect();
    if text.chars().count() > MAX_RAW {
        out.push('…');
    }
    out
}

/// The definition block named `id` inside `parent`, searched one level of nesting deep.
fn find_block<'d>(doc: &'d Document, parent: &'d Block, id: &str, depth: usize) -> Option<(&'d Entry, &'d Block, Option<String>)> {
    for entry in parent.entries() {
        let key = doc.key(entry);
        if let Some(block) = entry.value.as_block() {
            if key == id {
                return Some((entry, block, None));
            }
            if depth > 0
                && let Some((found, inner, _)) = find_block(doc, block, id, depth - 1)
            {
                return Some((found, inner, Some(key.into_owned())));
            }
        }
    }
    None
}

pub(crate) fn suggest(id: &str, names: impl Iterator<Item = String>) -> Vec<String> {
    let wanted: Vec<char> = id.to_ascii_lowercase().chars().collect();
    let first = id.as_bytes().first().map(u8::to_ascii_lowercase);
    let mut close: Vec<(usize, String)> = names
        .filter(|n| n.len().abs_diff(id.len()) <= 3 && n.as_bytes().first().map(u8::to_ascii_lowercase) == first)
        .filter_map(|n| {
            let d = levenshtein(&n.to_ascii_lowercase().chars().collect::<Vec<_>>(), &wanted);
            (d <= 3).then_some((d, n))
        })
        .collect();
    close.sort();
    close.into_iter().take(3).map(|(_, n)| n).collect()
}

pub fn respond(request: &Request) -> Response {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let loaded = load(request);
    let (kind, label) = match request.kind {
        Subject::Idea => (Kind::Idea, "idea"),
        Subject::Character => (Kind::Character, "character"),
    };
    let id = request.id.as_str();
    let mut definitions: Vec<&crate::index::Definition> = loaded.index.get(kind, id).iter().collect();
    definitions.sort_by_key(|d| (loaded.workspace.files[d.file].layer, d.file, d.line));
    let mut response = Response {
        kind: label,
        id: id.to_owned(),
        found: !definitions.is_empty(),
        definitions: definitions.iter().map(|d| place(&loaded.workspace, d.file, d.line)).collect(),
        category: None,
        picture: None,
        modifiers: Vec::new(),
        fields: Vec::new(),
        roles: Vec::new(),
        portraits: Vec::new(),
        advisor_of: None,
        texts: Vec::new(),
        mentions: Vec::new(),
        mentions_truncated: false,
        problems: Vec::new(),
        suggestions: Vec::new(),
    };
    let Some(active) = definitions.last() else {
        response.suggestions = suggest(id, loaded.index.names(kind).cloned());
        return response;
    };
    let Ok(bytes) = fs::read(&loaded.workspace.files[active.file].absolute) else { return response };
    let doc = Document::parse(bytes);
    let path = loaded.workspace.files[active.file].relative.to_ascii_lowercase();
    let vocab = loaded.workspace.game_root().map(Vocabulary::from_game).unwrap_or_default();
    let mut text_keys: Vec<String> = Vec::new();
    let mut shown_idea = false;
    match request.kind {
        Subject::Idea if path.starts_with("common/characters/") => {
            // An advisor's idea_token: the character defines it.
            if let Some((character, _, _)) = character_with_token(&doc, id) {
                response.advisor_of = Some(character.clone());
                text_keys.push(character);
            }
        }
        Subject::Idea => {
            let found = doc.root.entries().filter(|e| doc.key(e) == "ideas").find_map(|ideas| ideas.value.as_block().and_then(|b| find_block(&doc, b, id, 1)));
            if let Some((_, block, category)) = found {
                response.category = category.clone();
                idea_details(&doc, block, id, &loaded, &vocab, &mut response);
                let hidden = category.as_deref().is_some_and(|c| c == "hidden_ideas" || loaded.hidden_categories.contains(&c.to_ascii_lowercase()))
                    || never_visible(&doc, block);
                // `name = key` replaces the id as the name key; the description is that key with _desc.
                let name = block
                    .entries()
                    .find(|e| doc.key(e) == "name")
                    .and_then(|e| e.value.as_scalar())
                    .map(|t| doc.text(t).into_owned())
                    .unwrap_or_else(|| id.to_owned());
                text_keys.push(name.clone());
                text_keys.push(format!("{name}_desc"));
                if hidden {
                    // Hidden ideas show no picture or name; their absence is not a problem.
                    response.problems.retain(|p| p.code != "IDEA_PICTURE_MISSING");
                }
                shown_idea = !hidden;
            }
        }
        Subject::Character => {
            let found = doc.root.entries().filter(|e| doc.key(e) == "characters").find_map(|c| c.value.as_block().and_then(|b| find_block(&doc, b, id, 0)));
            if let Some((_, block, _)) = found {
                character_details(&doc, block, &loaded, &mut response);
                let name = block.entries().find(|e| doc.key(e) == "name").and_then(|e| e.value.as_scalar()).map(|t| doc.text(t).into_owned());
                text_keys.push(name.unwrap_or_else(|| id.to_owned()));
            }
        }
    }
    let wanted: HashSet<String> = text_keys.iter().cloned().collect();
    let mut texts = localisation::texts(&loaded.workspace, &wanted);
    response.texts = text_keys.iter().map(|k| KeyTexts { key: k.clone(), texts: texts.remove(k).unwrap_or_default() }).collect();
    if shown_idea && response.texts.first().is_some_and(|t| t.texts.is_empty() && !t.key.contains(' ')) {
        response.problems.push(Problem {
            code: "IDEA_NAME_MISSING",
            severity: severity("IDEA_NAME_MISSING"),
            message: format!("no language defines `{}`, so the idea shows its key as its name", response.texts[0].key),
            line: active.line,
        });
    }
    let (mentions, truncated) = localisation::mentions(&loaded.workspace, id, limit);
    response.mentions = mentions;
    response.mentions_truncated = truncated;
    response
}

fn character_with_token(doc: &Document, token: &str) -> Option<(String, u32, ())> {
    for characters in doc.root.entries().filter(|e| doc.key(e) == "characters") {
        for character in characters.value.as_block().into_iter().flat_map(|b| b.entries()) {
            let mut found = false;
            defs::visit_entries(character.value.as_block()?, &mut |entry| {
                if doc.key(entry) == "idea_token" && entry.value.as_scalar().is_some_and(|t| doc.text(t) == token) {
                    found = true;
                }
            });
            if found {
                return Some((doc.key(character).into_owned(), doc.token(character.key).start, ()));
            }
        }
    }
    None
}

const IDEA_FIELDS: &[&str] = &[
    "allowed",
    "visible",
    "available",
    "allowed_civil_war",
    "cancel",
    "on_add",
    "on_remove",
    "do_effect",
    "removal_cost",
    "cost",
    "level",
    "ledger",
    "traits",
];
const MODIFIER_BLOCKS: &[&str] = &["modifier", "research_bonus", "equipment_bonus", "targeted_modifier", "rule"];

pub(crate) fn known_modifier(loaded: &Loaded, vocab: &Vocabulary, key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    !vocab.has_modifiers()
        || vocab.modifiers.contains(&lower)
        || loaded.modifier_definitions.contains(&lower)
        || is_dynamic(key)
        || loaded.index.contains(Kind::StaticModifier, key)
        || lower.strip_suffix("_cost_factor").is_some_and(|slot| loaded.idea_slots.contains(slot))
        || built_from_units(loaded, &lower)
        || ["_outcome", "_cost", "_risk"].iter().any(|suffix| lower.strip_suffix(suffix).is_some_and(|op| loaded.operations.contains(op)))
        || lower.strip_prefix("state_production_speed_").and_then(|r| r.strip_suffix("_factor")).is_some_and(|b| loaded.index.contains(Kind::Building, b))
        || crate::lints::DERIVED_MODIFIERS.iter().any(|(prefix, kind, suffix)| {
            key.strip_prefix(prefix).and_then(|rest| rest.strip_suffix(suffix)).is_some_and(|name| !name.is_empty() && loaded.index.contains(*kind, name))
        })
        // Per-ideology and per-building modifiers (`fascism_drift`, `arms_factory_...`).
        || loaded.index.names(Kind::Ideology).any(|i| lower.starts_with(&i.to_ascii_lowercase()))
}

/// `visible = { always = no }`: the game never shows the idea, so its picture and name are unused.
fn never_visible(doc: &Document, block: &Block) -> bool {
    block.entries().filter(|e| doc.key(e) == "visible").filter_map(|e| e.value.as_block()).any(|v| {
        let mut entries = v.entries();
        matches!((entries.next(), entries.next()), (Some(only), None) if doc.key(only) == "always" && only.value.as_scalar().is_some_and(|t| doc.text(t) == "no"))
    })
}

/// `modifier_army_sub_unit_<sub-unit>_<stat>_factor` and
/// `modifier_army_sub_unit_category_<category>_<stat>_factor`: the documentation lists them for a
/// few vanilla units only, and the game builds them for every sub-unit and unit category.
fn built_from_units(loaded: &Loaded, lower: &str) -> bool {
    let Some(rest) = lower.strip_prefix("modifier_army_sub_unit_").and_then(|r| r.strip_suffix("_factor")) else { return false };
    if let Some(category) = rest.strip_prefix("category_")
        && loaded
            .unit_categories
            .iter()
            .any(|c| c.strip_prefix("category_").is_some_and(|c| category.strip_prefix(c).is_some_and(|stat| stat.starts_with('_'))))
    {
        return true;
    }
    loaded.index.names(Kind::SubUnit).any(|unit| rest.strip_prefix(unit.to_ascii_lowercase().as_str()).is_some_and(|stat| stat.starts_with('_')))
}

fn idea_details(doc: &Document, block: &Block, id: &str, loaded: &Loaded, vocab: &Vocabulary, response: &mut Response) {
    let picture = block.entries().find(|e| doc.key(e) == "picture").and_then(|e| e.value.as_scalar()).map(|t| doc.text(t).into_owned());
    let sprite = match &picture {
        Some(p) if p.starts_with("GFX_") => p.clone(),
        Some(p) => format!("GFX_idea_{p}"),
        None => format!("GFX_idea_{id}"),
    };
    let sprites = &loaded.sprites;
    let defined = sprites.get(&sprite);
    let texture = defined.and_then(|d| sprites.texture_of(d));
    response.picture = Some(Picture {
        sprite: sprite.clone(),
        defined: defined.is_some(),
        texture: defined.and_then(|d| d.texturefile.clone()),
        texture_exists: texture.map(|t| t.exists),
    });
    let line = line_at(doc, doc.token(block.tokens.start).start);
    if defined.is_none() && loaded.judge_sprites {
        response.problems.push(Problem {
            code: "IDEA_PICTURE_MISSING",
            severity: severity("IDEA_PICTURE_MISSING"),
            message: format!("no loaded .gfx file defines `{sprite}`, so the idea shows no picture (unless a DLC not installed here defines it)"),
            line,
        });
    } else if texture.is_some_and(|t| !t.exists)
        && loaded.judge_sprites
        && defined.is_some_and(|d| {
            Some(loaded.workspace.files[d.file].layer) == loaded.workspace.target_layer()
                && d.texture_key.as_ref().is_none_or(|k| !loaded.game_textures.contains(k))
        })
    {
        // Only the mod's own sprites: a game sprite's texture may come from a DLC not installed here.
        response.problems.push(Problem {
            code: "IDEA_PICTURE_MISSING",
            severity: severity("IDEA_PICTURE_MISSING"),
            message: format!("`{sprite}` names a texture no layer has"),
            line,
        });
    }
    for entry in block.entries() {
        let key = doc.key(entry);
        let entry_line = line_at(doc, doc.token(entry.key).start);
        if MODIFIER_BLOCKS.contains(&key.as_ref()) {
            for m in entry.value.as_block().into_iter().flat_map(|b| b.entries()) {
                let mkey = doc.key(m).into_owned();
                // A targeted modifier names its target with `tag`; a nested block is not a key.
                // A targeted modifier names its target with `tag`; `custom_modifier_tooltip` adds a
                // tooltip line; a nested block is not a key.
                if mkey.eq_ignore_ascii_case("tag") || mkey == "custom_modifier_tooltip" || m.value.as_block().is_some() {
                    continue;
                }
                let value = m.value.as_scalar().map(|t| doc.text(t).into_owned()).unwrap_or_default();
                let known = key == "research_bonus" || key == "equipment_bonus" || key == "rule" || known_modifier(loaded, vocab, &mkey);
                let mline = line_at(doc, doc.token(m.key).start);
                if !known {
                    response.problems.push(Problem {
                        code: "IDEA_UNKNOWN_MODIFIER",
                        severity: severity("IDEA_UNKNOWN_MODIFIER"),
                        message: format!("`{mkey}` is not a modifier the game documents or the mod defines, so it does nothing"),
                        line: mline,
                    });
                }
                response.modifiers.push(Modifier { block: key.to_string(), key: mkey, value, known, line: mline });
            }
        } else if IDEA_FIELDS.contains(&key.as_ref()) {
            response.fields.push(Field { name: key.into_owned(), text: raw(doc, entry), line: entry_line });
        }
    }
}

const ROLES: &[&str] = &["country_leader", "advisor", "corps_commander", "field_marshal", "navy_leader", "operative"];

fn character_details(doc: &Document, block: &Block, loaded: &Loaded, response: &mut Response) {
    let sprites = &loaded.sprites;
    let visit = |block: &Block, instance: Option<usize>, response: &mut Response| {
        for entry in block.entries() {
            let key = doc.key(entry);
            let entry_line = line_at(doc, doc.token(entry.key).start);
            if ROLES.contains(&key.as_ref()) {
                let Some(role_block) = entry.value.as_block() else { continue };
                let trait_kind =
                    if key == "corps_commander" || key == "field_marshal" || key == "navy_leader" { Kind::UnitLeaderTrait } else { Kind::CountryLeaderTrait };
                let mut fields = Vec::new();
                let mut traits = Vec::new();
                for field in role_block.entries() {
                    let name = doc.key(field);
                    if name == "traits" {
                        for item in field.value.as_block().into_iter().flat_map(|b| b.items.iter()) {
                            if let hoi4_syntax::Item::Value(hoi4_syntax::Value::Scalar(t)) = item {
                                let trait_name = doc.text(*t).into_owned();
                                let known = loaded.index.contains(trait_kind, &trait_name) || is_dynamic(&trait_name);
                                if !known {
                                    response.problems.push(Problem {
                                        code: "CHARACTER_TRAIT_UNKNOWN",
                                        severity: severity("CHARACTER_TRAIT_UNKNOWN"),
                                        message: format!(
                                            "{key} trait `{trait_name}` is defined in no loaded {} file",
                                            if trait_kind == Kind::UnitLeaderTrait { "common/unit_leader" } else { "common/country_leader" }
                                        ),
                                        line: line_at(doc, doc.token(*t).start),
                                    });
                                }
                                traits.push(Trait { name: trait_name, known });
                            }
                        }
                    } else {
                        fields.push(Field { name: name.into_owned(), text: raw(doc, field), line: line_at(doc, doc.token(field.key).start) });
                    }
                }
                response.roles.push(Role { role: key.into_owned(), instance, fields, traits, line: entry_line });
            } else if key == "portraits" {
                for group in entry.value.as_block().into_iter().flat_map(|b| b.entries()) {
                    for size in group.value.as_block().into_iter().flat_map(|b| b.entries()) {
                        let Some(t) = size.value.as_scalar() else { continue };
                        let value = doc.text(t).into_owned();
                        let exists = if value.starts_with("GFX_") { sprites.contains(&value) } else { sprites.texture(&value).exists };
                        let slot = format!("{}.{}", doc.key(group), doc.key(size));
                        // A file path or a sprite the mod defines can be judged; an undefined sprite
                        // of the game may belong to a DLC that is not installed here.
                        if !exists && !is_dynamic(&value) && loaded.judge_sprites {
                            response.problems.push(Problem {
                                code: "CHARACTER_PORTRAIT_MISSING",
                                severity: severity("CHARACTER_PORTRAIT_MISSING"),
                                message: format!(
                                    "portrait {slot} `{value}` names {}",
                                    if value.starts_with("GFX_") { "a sprite no loaded .gfx file defines" } else { "a file no layer has" }
                                ),
                                line: line_at(doc, doc.token(t).start),
                            });
                        }
                        response.portraits.push(Portrait { slot, value, exists });
                    }
                }
            }
        }
    };
    visit(block, None, response);
    for (n, instance) in block.entries().filter(|e| doc.key(e) == "instance").enumerate() {
        if let Some(inner) = instance.value.as_block() {
            visit(inner, Some(n), response);
        }
    }
    // The same portrait listed per instance is reported once.
    let mut seen = BTreeSet::new();
    response.problems.retain(|p| seen.insert((p.code, p.message.clone())));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditProblem {
    pub code: &'static str,
    pub severity: &'static str,
    pub id: String,
    pub path: String,
    pub line: u32,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    pub kind: &'static str,
    /// Ideas or characters of the mod (the checked layer) that were checked.
    pub checked: usize,
    pub counts: std::collections::BTreeMap<&'static str, usize>,
    /// Up to `limit` examples of each code.
    pub problems: Vec<AuditProblem>,
    pub truncated: bool,
}

/// Every idea or character the checked layer defines, with the checks of the single inspection.
pub fn audit(request: &Request) -> Audit {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let loaded = load(request);
    let target = loaded.workspace.target_layer();
    let vocab = loaded.workspace.game_root().map(Vocabulary::from_game).unwrap_or_default();
    let (folder, label) = match request.kind {
        Subject::Idea => ("common/ideas/", "idea"),
        Subject::Character => ("common/characters/", "character"),
    };
    let files: Vec<usize> = loaded
        .workspace
        .loaded_files()
        .filter(|(_, f)| Some(f.layer) == target && f.relative.to_ascii_lowercase().starts_with(folder) && f.relative.to_ascii_lowercase().ends_with(".txt"))
        .map(|(i, _)| i)
        .collect();
    // (problem, id, file) and the name keys that must exist, per file.
    /// Per file: problems with their id, name keys to look up (id, key, file, line), ideas checked.
    type Checked = (Vec<(Problem, String, usize)>, Vec<(String, String, usize, u32)>, usize);
    let checked: Vec<Checked> = files
        .par_iter()
        .filter_map(|&file| {
            let doc = Document::parse(fs::read(&loaded.workspace.files[file].absolute).ok()?);
            let mut problems = Vec::new();
            let mut names = Vec::new();
            let mut count = 0;
            let scratch = |id: &str| Response {
                kind: label,
                id: id.to_owned(),
                found: true,
                definitions: Vec::new(),
                category: None,
                picture: None,
                modifiers: Vec::new(),
                fields: Vec::new(),
                roles: Vec::new(),
                portraits: Vec::new(),
                advisor_of: None,
                texts: Vec::new(),
                mentions: Vec::new(),
                mentions_truncated: false,
                problems: Vec::new(),
                suggestions: Vec::new(),
            };
            match request.kind {
                Subject::Idea => {
                    for ideas in doc.root.entries().filter(|e| doc.key(e) == "ideas") {
                        for category in ideas.value.as_block().into_iter().flat_map(|b| b.entries()) {
                            let cat = doc.key(category).into_owned();
                            for idea in category.value.as_block().into_iter().flat_map(|b| b.entries()) {
                                let Some(block) = idea.value.as_block() else { continue };
                                let id = doc.key(idea).into_owned();
                                count += 1;
                                let mut r = scratch(&id);
                                idea_details(&doc, block, &id, &loaded, &vocab, &mut r);
                                let hidden =
                                    cat == "hidden_ideas" || loaded.hidden_categories.contains(&cat.to_ascii_lowercase()) || never_visible(&doc, block);
                                for p in r.problems.into_iter().filter(|p| !(hidden && p.code == "IDEA_PICTURE_MISSING")) {
                                    problems.push((p, id.clone(), file));
                                }
                                if !hidden {
                                    let name = block
                                        .entries()
                                        .find(|e| doc.key(e) == "name")
                                        .and_then(|e| e.value.as_scalar())
                                        .map(|t| doc.text(t).into_owned())
                                        .unwrap_or_else(|| id.clone());
                                    names.push((id.clone(), name, file, line_at(&doc, doc.token(idea.key).start)));
                                }
                            }
                        }
                    }
                }
                Subject::Character => {
                    for characters in doc.root.entries().filter(|e| doc.key(e) == "characters") {
                        for character in characters.value.as_block().into_iter().flat_map(|b| b.entries()) {
                            let Some(block) = character.value.as_block() else { continue };
                            let id = doc.key(character).into_owned();
                            count += 1;
                            let mut r = scratch(&id);
                            character_details(&doc, block, &loaded, &mut r);
                            problems.extend(r.problems.into_iter().map(|p| (p, id.clone(), file)));
                            let name = block
                                .entries()
                                .find(|e| doc.key(e) == "name")
                                .and_then(|e| e.value.as_scalar())
                                .map(|t| doc.text(t).into_owned())
                                .unwrap_or_else(|| id.clone());
                            names.push((id.clone(), name, file, line_at(&doc, doc.token(character.key).start)));
                        }
                    }
                }
            }
            Some((problems, names, count))
        })
        .collect();
    let mut counts = std::collections::BTreeMap::new();
    let mut problems = Vec::new();
    let mut push = |code: &'static str, problem: AuditProblem| {
        let count = counts.entry(code).or_insert(0);
        *count += 1;
        if *count <= limit {
            problems.push(problem);
        }
    };
    let mut total = 0;
    let mut name_checks = Vec::new();
    for (found, names, count) in checked {
        total += count;
        name_checks.extend(names);
        for (p, id, file) in found {
            push(
                p.code,
                AuditProblem { code: p.code, severity: p.severity, id, path: loaded.workspace.files[file].relative.clone(), line: p.line, message: p.message },
            );
        }
    }
    // Names: a key no language defines shows as the raw key in game.
    let wanted: HashSet<String> = name_checks.iter().map(|(_, name, _, _)| name.clone()).collect();
    let texts = localisation::texts(&loaded.workspace, &wanted);
    let code = if request.kind == Subject::Idea { "IDEA_NAME_MISSING" } else { "CHARACTER_NAME_MISSING" };
    for (id, name, file, line) in name_checks {
        // A name with a space is literal text the game shows as written.
        if !texts.contains_key(&name) && !is_dynamic(&name) && !name.contains(' ') {
            push(
                code,
                AuditProblem {
                    code,
                    severity: severity(code),
                    id,
                    path: loaded.workspace.files[file].relative.clone(),
                    line,
                    message: format!("no language defines `{name}`, so the game shows the key as the name"),
                },
            );
        }
    }
    let truncated = counts.values().any(|&c| c > limit);
    Audit { kind: label, checked: total, counts, problems, truncated }
}

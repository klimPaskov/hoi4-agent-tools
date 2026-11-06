//! The newer game systems, for `hoi4-engine system` and the MCP tool `hoi4.system_inspect`:
//! on_actions, military-industrial organizations (with their policies), balance of power, special
//! projects (with prototype rewards, specializations and project tags), operations (with phases
//! and tokens) and raids (with raid categories).
//!
//! - One id: every definition in load order, its fields as written, its parts (traits, ranges,
//!   sides, options, phases), every reference it makes with whether something defines the target,
//!   its name and description in every language, the files that mention it, and its problems.
//! - Audit: the same checks for every definition the checked layer makes, with counts per code.
//!
//! The rules follow the game's own documentation in each folder, corrected where the shipped files
//! differ from it (`target_type` in raids, trait names that are their token, operation `name` and
//! `desc` keys). Only references the documentation defines are judged. Effect and trigger blocks
//! are left to `hoi4.script_validate`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use hoi4_syntax::{Block, Document, Entry, Item, Value};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::context::is_dynamic;
use crate::ideas::{self, Audit, AuditProblem, Field, KeyTexts, Loaded, Place, Problem};
use crate::index::Kind;
use crate::localisation::{self, Mention};
use crate::vocab::Vocabulary;
use crate::workspace::{Hidden, LayerKind, Workspace, WorkspaceOptions};

mod units;

const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 100;
const MAX_FIELDS: usize = 12;
const MAX_FIELD_TEXT: usize = 240;
const MAX_LISTED: usize = 100;
const MAX_TEXT_KEYS: usize = 6;
const MAX_REFERENCES: usize = 40;

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
    pub kind: System,
    /// The definition (or on_actions hook); not used by an audit.
    #[serde(default)]
    pub id: String,
    /// Check every definition the mod makes instead of one.
    #[serde(default)]
    pub audit: bool,
    pub limit: Option<usize>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum System {
    OnActions,
    Mio,
    BalanceOfPower,
    SpecialProject,
    Operation,
    Raid,
    // The kinds of `hoi4-engine units` and `hoi4.unit_inspect`.
    Oob,
    SubUnit,
    Equipment,
    Variant,
}

impl System {
    fn label(self) -> &'static str {
        match self {
            System::OnActions => "on_actions",
            System::Mio => "mio",
            System::BalanceOfPower => "balance_of_power",
            System::SpecialProject => "special_project",
            System::Operation => "operation",
            System::Raid => "raid",
            System::Oob => "oob",
            System::SubUnit => "sub_unit",
            System::Equipment => "equipment",
            System::Variant => "variant",
        }
    }

    /// The kind belongs to `hoi4-engine units` rather than `hoi4-engine system`.
    pub fn is_unit(self) -> bool {
        matches!(self, System::Oob | System::SubUnit | System::Equipment | System::Variant)
    }

    /// Where each kind of definition lives, most specific folder first.
    fn sources(self) -> &'static [Source] {
        match self {
            System::OnActions => &[Source { folder: "common/on_actions/", container: Some("on_actions"), what: "on_action", bare: false, ..NESTED }],
            System::Mio => &[
                Source { folder: "common/military_industrial_organization/organizations/", container: None, what: "organization", bare: false, ..NESTED },
                Source { folder: "common/military_industrial_organization/policies/", container: None, what: "policy", bare: false, ..NESTED },
            ],
            System::BalanceOfPower => &[Source { folder: "common/bop/", container: None, what: "balance_of_power", bare: false, ..NESTED }],
            System::SpecialProject => &[
                Source { folder: "common/special_projects/projects/", container: None, what: "project", bare: false, ..NESTED },
                Source { folder: "common/special_projects/prototype_rewards/", container: None, what: "prototype_reward", bare: false, ..NESTED },
                Source { folder: "common/special_projects/specialization/", container: None, what: "specialization", bare: false, ..NESTED },
                Source { folder: "common/special_projects/project_tags/", container: Some("project_tags"), what: "project_tag", bare: true, ..NESTED },
            ],
            System::Operation => &[
                Source { folder: "common/operations/", container: None, what: "operation", bare: false, ..NESTED },
                Source { folder: "common/operation_phases/", container: None, what: "phase", bare: false, ..NESTED },
                Source { folder: "common/operation_tokens/", container: None, what: "token", bare: false, ..NESTED },
            ],
            System::Raid => &[
                Source { folder: "common/raids/categories/", container: Some("categories"), what: "raid_category", bare: false, ..NESTED },
                Source { folder: "common/raids/", container: Some("types"), what: "raid", bare: false, ..NESTED },
            ],
            System::Oob => &[Source { folder: "history/units/", what: "oob", flat: true, whole_file: true, ..NESTED }],
            System::SubUnit => &[Source { folder: "common/units/", container: Some("sub_units"), what: "sub_unit", flat: true, ..NESTED }],
            System::Equipment => &[
                Source { folder: "common/units/equipment/modules/", container: Some("equipment_modules"), what: "module", flat: true, ..NESTED },
                Source { folder: "common/units/equipment/", container: Some("equipments"), what: "equipment", flat: true, ..NESTED },
            ],
            System::Variant => VARIANT_SOURCES,
        }
    }

    /// Folders whose definitions the references of this system point at.
    fn referenced(self) -> &'static [&'static str] {
        match self {
            System::OnActions => &["events/"],
            System::Oob => &["history/states/"],
            _ => &[],
        }
    }
}

struct Source {
    folder: &'static str,
    /// The block the definitions sit in, such as `types` in raids; `None` for top-level ids.
    container: Option<&'static str>,
    /// What one definition is: `organization`, `policy`, `project`, `raid` and so on.
    what: &'static str,
    /// The container lists bare names rather than blocks.
    bare: bool,
    /// Only files directly in the folder, not in its subfolders.
    flat: bool,
    /// The file is the definition, named by its file name: an order of battle.
    whole_file: bool,
    /// Definitions are blocks with this key anywhere in the file, named by their `name` field:
    /// `create_equipment_variant`.
    named: Option<&'static str>,
}

const NESTED: Source = Source { folder: "", container: None, what: "", bare: false, flat: false, whole_file: false, named: None };

/// Variants are created by an effect, in country history, orders of battle and any effect block.
const VARIANT_SOURCES: &[Source] = &[
    Source { folder: "history/", what: "variant", named: Some("create_equipment_variant"), ..NESTED },
    Source { folder: "events/", what: "variant", named: Some("create_equipment_variant"), ..NESTED },
    Source { folder: "common/", what: "variant", named: Some("create_equipment_variant"), ..NESTED },
];

fn source_of(system: System, relative: &str) -> Option<&'static Source> {
    let lower = relative.to_ascii_lowercase();
    if !lower.ends_with(".txt") {
        return None;
    }
    system.sources().iter().find(|s| lower.starts_with(s.folder) && !(s.flat && lower[s.folder.len()..].contains('/')))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    /// `organization`, `policy`, `project`, `raid`, `on_action` and so on.
    pub what: &'static str,
    #[serde(flatten)]
    pub place: Place,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// The field that names it, such as `include`, `category` or `trait.parent`.
    pub field: String,
    /// What it names: `organization`, `sprite`, `event`, `sub_unit` and so on.
    pub target: &'static str,
    pub value: String,
    pub known: bool,
    pub line: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// `trait`, `range`, `side`, `option`, `phase`, `reward`.
    pub what: &'static str,
    pub id: String,
    pub line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub kind: &'static str,
    pub id: String,
    pub found: bool,
    /// Every definition in load order; the last one is the one the game uses. Each on_actions
    /// file that adds to the hook is one, and all of them run.
    pub definitions: Vec<Definition>,
    pub fields: Vec<Field>,
    pub parts: Vec<Part>,
    pub parts_truncated: bool,
    pub references: Vec<Reference>,
    pub references_truncated: bool,
    pub texts: Vec<KeyTexts>,
    pub mentions: Vec<Mention>,
    pub mentions_truncated: bool,
    pub problems: Vec<Problem>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<String>,
}

/// A missing name may be intended or covered by a fallback, and an unlisted hook may be newer than
/// the documentation, so both are information.
fn severity(code: &str) -> &'static str {
    if matches!(code, "SYSTEM_NAME_MISSING" | "ON_ACTION_HOOK_UNDOCUMENTED") { "info" } else { "warning" }
}

fn problem(code: &'static str, message: String, line: u32) -> Problem {
    Problem { code, severity: severity(code), message, line }
}

/// `hoi4-engine system`: the newer game systems.
pub fn respond_json(text: &str) -> (String, u8) {
    respond_group(text, false)
}

/// `hoi4-engine units`: orders of battle, sub-units, equipment (with modules) and variants.
pub fn respond_units_json(text: &str) -> (String, u8) {
    respond_group(text, true)
}

fn respond_group(text: &str, units: bool) -> (String, u8) {
    let prefix = if units { "UNIT" } else { "SYSTEM" };
    let request: Request = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => return (error(&format!("{prefix}_INVALID_REQUEST"), &e.to_string()), 2),
    };
    if request.kind.is_unit() != units {
        let command = if units { "system" } else { "units" };
        return (error(&format!("{prefix}_INVALID_REQUEST"), &format!("`{}` is a kind of `hoi4-engine {command}`", request.kind.label())), 2);
    }
    if request.audit {
        return (serde_json::to_string(&audit(&request)).unwrap_or_else(|e| error(&format!("{prefix}_INTERNAL"), &e.to_string())), 0);
    }
    if request.id.is_empty() || request.id.len() > 256 {
        return (error(&format!("{prefix}_ID_REQUIRED"), "pass an id of 1 to 256 characters, or audit"), 2);
    }
    (serde_json::to_string(&respond(&request)).unwrap_or_else(|e| error(&format!("{prefix}_INTERNAL"), &e.to_string())), 0)
}

/// The unit kinds report the shared codes under their own prefix.
fn renamed(system: System, code: &'static str) -> &'static str {
    if !system.is_unit() {
        return code;
    }
    match code {
        "SYSTEM_REFERENCE_UNKNOWN" => "UNIT_REFERENCE_UNKNOWN",
        "SYSTEM_NAME_MISSING" => "UNIT_NAME_MISSING",
        "SYSTEM_PICTURE_MISSING" => "UNIT_PICTURE_MISSING",
        "SYSTEM_DUPLICATE_TOKEN" => "UNIT_DUPLICATE",
        other => other,
    }
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
}

/// One definition found in a system file.
struct Def {
    what: &'static str,
    id: String,
    /// Index into `State::docs`.
    doc: usize,
    file: usize,
    line: u32,
}

struct State {
    loaded: Loaded,
    vocab: Vocabulary,
    system: System,
    /// The parsed system files: (file, document).
    docs: Vec<(usize, Document)>,
    defs: Vec<Def>,
    /// Ids by what they are, lower case for the case-insensitive lookups the game does.
    names: HashMap<&'static str, HashSet<String>>,
    /// Equipment modules, which special projects enable.
    modules: HashSet<String>,
    /// Hooks the game documents, with `_TAG` hooks as prefixes.
    hooks: HashSet<String>,
    hook_prefixes: Vec<String>,
    /// The division designer's grid: regiment columns and rows, support columns and rows.
    grid: [i64; 4],
}

fn load(request: &Request) -> State {
    let system = request.kind;
    let options = WorkspaceOptions {
        game: request.game.clone(),
        include_dlc: request.include_dlc,
        dependencies: request.dependencies.clone(),
        target: request.target.clone(),
    };
    let loaded = ideas::load_with(&options, system.referenced());
    let vocab = loaded.workspace.game_root().map(Vocabulary::from_game).unwrap_or_default();
    let workspace = &loaded.workspace;
    let files: Vec<usize> = workspace.loaded_files().filter(|(_, f)| source_of(system, &f.relative).is_some()).map(|(i, _)| i).collect();
    let docs = parse_files(workspace, &files, system.sources().iter().find_map(|s| s.named));
    let mut defs = Vec::new();
    let mut names: HashMap<&'static str, HashSet<String>> = HashMap::new();
    for (index, (file, doc)) in docs.iter().enumerate() {
        let relative = &workspace.files[*file].relative;
        let Some(source) = source_of(system, relative) else { continue };
        for (id, line) in definitions_in(doc, source, relative) {
            names.entry(source.what).or_default().insert(id.to_ascii_lowercase());
            defs.push(Def { what: source.what, id, doc: index, file: *file, line });
        }
    }
    defs.sort_by_key(|d| (workspace.files[d.file].layer, d.file, d.line));
    let modules = if matches!(system, System::SpecialProject | System::Equipment | System::Variant) {
        read_ids(workspace, "common/units/equipment/modules/", "equipment_modules")
    } else {
        HashSet::new()
    };
    for (what, set) in units::extra_names(system, workspace, &docs) {
        names.entry(what).or_default().extend(set);
    }
    let (hooks, hook_prefixes) = if system == System::OnActions { known_hooks(&loaded) } else { (HashSet::new(), Vec::new()) };
    let grid = if system == System::Oob { units::grid(workspace) } else { units::DEFAULT_GRID };
    State { loaded, vocab, system, docs, defs, names, modules, hooks, hook_prefixes, grid }
}

/// Parses the files; with `needle`, only those whose text contains it.
fn parse_files(workspace: &Workspace, files: &[usize], needle: Option<&str>) -> Vec<(usize, Document)> {
    files
        .par_iter()
        .filter_map(|&file| {
            let bytes = fs::read(&workspace.files[file].absolute).ok()?;
            if needle.is_some_and(|n| memchr::memmem::find(&bytes, n.as_bytes()).is_none()) {
                return None;
            }
            Some((file, Document::parse(bytes)))
        })
        .collect()
}

/// The keys of the `container` blocks of every file under `folder`, lower case.
fn read_ids(workspace: &Workspace, folder: &str, container: &str) -> HashSet<String> {
    let files: Vec<usize> = workspace
        .loaded_files()
        .filter(|(_, f)| {
            let p = f.relative.to_ascii_lowercase();
            p.starts_with(folder) && p.ends_with(".txt")
        })
        .map(|(i, _)| i)
        .collect();
    files
        .par_iter()
        .flat_map_iter(|&file| {
            let doc = fs::read(&workspace.files[file].absolute).map(Document::parse).ok();
            let mut out = Vec::new();
            if let Some(doc) = doc {
                for entry in doc.root.entries().filter(|e| doc.key(e) == container) {
                    out.extend(entry.value.as_block().into_iter().flat_map(|b| b.entries()).map(|e| doc.key(e).to_ascii_lowercase()));
                }
            }
            out
        })
        .collect()
}

/// Hooks the game runs. The documentation (`common/on_actions/_documentation.md`) lags the game,
/// so the hooks of every game and DLC on_actions file count too, including files a mod replaces,
/// and so do the `on_` names in the game's executable. Empty when no documentation is found, and
/// then no hook is judged.
fn known_hooks(loaded: &Loaded) -> (HashSet<String>, Vec<String>) {
    let workspace = &loaded.workspace;
    let Some(root) = workspace.game_root() else { return (HashSet::new(), Vec::new()) };
    let Ok(text) = fs::read_to_string(root.join("common/on_actions/_documentation.md")) else { return (HashSet::new(), Vec::new()) };
    let mut hooks = HashSet::new();
    let mut prefixes = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix("- `") else { continue };
        let Some(name) = rest.split('`').next() else { continue };
        if let Some(prefix) = name.strip_suffix("_TAG") {
            prefixes.push(format!("{prefix}_"));
        } else if name.starts_with("on_") {
            hooks.insert(name.to_owned());
        }
    }
    let source = &System::OnActions.sources()[0];
    let files: Vec<usize> = (0..workspace.files.len())
        .filter(|&i| {
            let file = &workspace.files[i];
            matches!(workspace.layers[file.layer].kind, LayerKind::Game | LayerKind::Dlc) && source_of(System::OnActions, &file.relative).is_some()
        })
        .collect();
    let used: Vec<String> = files
        .par_iter()
        .flat_map_iter(|&i| fs::read(&workspace.files[i].absolute).map(|b| definitions_in(&Document::parse(b), source, "")).unwrap_or_default())
        .map(|(hook, _)| hook)
        .collect();
    hooks.extend(used);
    for binary in ["hoi4.exe", "hoi4", "hoi4.app/Contents/MacOS/hoi4"] {
        if let Ok(bytes) = fs::read(root.join(binary)) {
            hooks.extend(binary_hooks(&bytes));
            break;
        }
    }
    (hooks, prefixes)
}

/// The `on_<name>` strings in the game's executable.
fn binary_hooks(bytes: &[u8]) -> Vec<String> {
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_';
    memchr::memmem::find_iter(bytes, b"on_")
        .filter(|&at| at == 0 || !word(bytes[at - 1]))
        .filter_map(|at| {
            let end = bytes[at..].iter().position(|&b| !word(b)).map_or(bytes.len(), |n| at + n);
            (end - at > 4).then(|| String::from_utf8_lossy(&bytes[at..end]).into_owned())
        })
        .collect()
}

fn definitions_in(doc: &Document, source: &Source, relative: &str) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    let line = |offset| ideas::line_at(doc, offset);
    if source.whole_file {
        let name = relative.rsplit('/').next().unwrap_or(relative);
        return vec![(name[..name.len() - ".txt".len()].to_owned(), 1)];
    }
    if let Some(key) = source.named {
        let mut found = Vec::new();
        named_blocks(doc, &doc.root, key, &mut found);
        return found
            .into_iter()
            .filter_map(|e| e.value.as_block().and_then(|b| scalar(doc, b, "name")).map(|(name, _)| (name, line(doc.token(e.key).start))))
            .collect();
    }
    for entry in doc.root.entries() {
        let key = doc.key(entry);
        match source.container {
            Some(container) if key == container => {
                let Some(block) = entry.value.as_block() else { continue };
                if source.bare {
                    for item in &block.items {
                        if let Item::Value(Value::Scalar(t)) = item {
                            out.push((doc.text(*t).into_owned(), line(doc.token(*t).start)));
                        }
                    }
                } else {
                    // `limit` is the condition of a whole `equipment_modules` or `equipments` block.
                    for inner in block.entries().filter(|e| e.value.as_block().is_some() && doc.key(e) != "limit") {
                        out.push((doc.key(inner).into_owned(), line(doc.token(inner.key).start)));
                    }
                }
            }
            None if entry.value.as_block().is_some() && !key.starts_with('@') => out.push((key.into_owned(), line(doc.token(entry.key).start))),
            _ => {}
        }
    }
    out
}

/// The entry of one definition, found again in its document.
fn entry_of<'d>(doc: &'d Document, source: &Source, id: &str, line: u32) -> Option<&'d Entry> {
    let at = |e: &Entry| ideas::line_at(doc, doc.token(e.key).start) == line && doc.key(e) == id;
    if let Some(key) = source.named {
        let mut found = Vec::new();
        named_blocks(doc, &doc.root, key, &mut found);
        return found.into_iter().find(|e| {
            ideas::line_at(doc, doc.token(e.key).start) == line && e.value.as_block().and_then(|b| scalar(doc, b, "name")).is_some_and(|(n, _)| n == id)
        });
    }
    match source.container {
        Some(container) => doc.root.entries().filter(|e| doc.key(e) == container).filter_map(|e| e.value.as_block()).flat_map(|b| b.entries()).find(|e| at(e)),
        None => doc.root.entries().find(|e| at(e)),
    }
}

/// Every block with this key, at any depth.
fn named_blocks<'d>(doc: &'d Document, block: &'d Block, key: &str, out: &mut Vec<&'d Entry>) {
    for entry in block.entries() {
        let Some(inner) = entry.value.as_block() else { continue };
        if doc.key(entry) == key {
            out.push(entry);
        } else {
            named_blocks(doc, inner, key, out);
        }
    }
}

/// What checking one definition found.
#[derive(Default)]
struct Found {
    fields: Vec<Field>,
    parts: Vec<Part>,
    references: Vec<Reference>,
    problems: Vec<Problem>,
    /// Localisation keys the game looks up, with the line that implies each.
    texts: Vec<(String, u32)>,
    /// A key the game reads when the first one of the pair is missing, such as `<mio>_<token>`.
    fallbacks: Vec<(String, String)>,
}

fn unquote(text: &str) -> String {
    text.trim_matches('"').to_owned()
}

fn scalar(doc: &Document, block: &Block, key: &str) -> Option<(String, u32)> {
    block.entries().find(|e| doc.key(e) == key).and_then(|e| e.value.as_scalar().map(|t| (unquote(&doc.text(t)), ideas::line_at(doc, doc.token(t).start))))
}

/// The names a field gives: one scalar, or the bare values of a list block.
fn values(doc: &Document, entry: &Entry) -> Vec<(String, u32)> {
    match &entry.value {
        Value::Scalar(t) => vec![(unquote(&doc.text(*t)), ideas::line_at(doc, doc.token(*t).start))],
        Value::Block(block) => block
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Value(Value::Scalar(t)) => Some((unquote(&doc.text(*t)), ideas::line_at(doc, doc.token(*t).start))),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A name built at run time (variables, scripted localisation, constants) is not judged.
fn computed(value: &str) -> bool {
    is_dynamic(value) || value.starts_with('@') || value.contains(':') || value.contains('[') || value.contains('$')
}

struct Checker<'s> {
    state: &'s State,
    /// The definition is the checked mod's own, so its sprites are judged.
    own: bool,
}

impl Checker<'_> {
    fn known(&self, target: &'static str, value: &str) -> bool {
        let state = self.state;
        let lower = value.to_ascii_lowercase();
        let index = &state.loaded.index;
        match target {
            "event" => index.contains_folded(Kind::Event, value),
            "equipment" => index.contains_folded(Kind::Equipment, value) || state.names.get("derived_equipment").is_some_and(|n| n.contains(&lower)),
            "sub_unit" => index.contains(Kind::SubUnit, value),
            "building" => index.contains(Kind::Building, value),
            "equipment_module" => state.modules.contains(&lower),
            "state" => index.contains(Kind::State, value),
            "resource" => index.contains(Kind::Resource, value),
            "unit_category" => state.loaded.unit_categories.contains(&lower),
            _ => state.names.get(target).is_some_and(|n| n.contains(&lower)),
        }
    }

    fn refer(&self, out: &mut Found, field: &str, target: &'static str, value: &str, line: u32) {
        if value.is_empty() || computed(value) {
            return;
        }
        let known = self.known(target, value);
        if !known {
            out.problems.push(problem(
                "SYSTEM_REFERENCE_UNKNOWN",
                format!("`{field}` names the {} `{value}`, which no loaded file defines", target.replace('_', " ")),
                line,
            ));
        }
        out.references.push(Reference { field: field.to_owned(), target, value: value.to_owned(), known, line });
    }

    fn refer_all(&self, out: &mut Found, doc: &Document, block: &Block, key: &str, field: &str, target: &'static str) {
        for entry in block.entries().filter(|e| doc.key(e) == key) {
            for (value, line) in values(doc, entry) {
                self.refer(out, field, target, &value, line);
            }
        }
    }

    fn sprite(&self, out: &mut Found, field: &str, value: &str, line: u32) {
        if value.is_empty() || computed(value) {
            return;
        }
        let loaded = &self.state.loaded;
        let defined = loaded.sprites.get(value);
        out.references.push(Reference { field: field.to_owned(), target: "sprite", value: value.to_owned(), known: defined.is_some(), line });
        if !(self.own && loaded.judge_sprites) {
            return;
        }
        match defined {
            None => out.problems.push(problem(
                "SYSTEM_PICTURE_MISSING",
                format!("no loaded .gfx file defines `{value}` for `{field}`, so the game shows a placeholder (unless a DLC not installed here defines it)"),
                line,
            )),
            Some(d)
                if loaded.sprites.texture_of(d).is_some_and(|t| !t.exists)
                    && Some(loaded.workspace.files[d.file].layer) == loaded.workspace.target_layer()
                    && d.texture_key.as_ref().is_none_or(|k| !loaded.game_textures.contains(k)) =>
            {
                out.problems.push(problem("SYSTEM_PICTURE_MISSING", format!("`{value}` names a texture no layer has"), line))
            }
            _ => {}
        }
    }

    fn sprites(&self, out: &mut Found, doc: &Document, block: &Block, keys: &[&str], prefix: &str) {
        for key in keys {
            if let Some((value, line)) = scalar(doc, block, key) {
                self.sprite(out, &format!("{prefix}{key}"), &value, line);
            }
        }
    }

    fn modifiers(&self, out: &mut Found, doc: &Document, block: &Block, key: &str) {
        for entry in block.entries().filter(|e| doc.key(e) == key) {
            for m in entry.value.as_block().into_iter().flat_map(|b| b.entries()) {
                let name = doc.key(m);
                if m.value.as_block().is_some() || name == "custom_modifier_tooltip" || name.eq_ignore_ascii_case("tag") {
                    continue;
                }
                if !self.known_modifier(&name) {
                    out.problems.push(problem(
                        "SYSTEM_UNKNOWN_MODIFIER",
                        format!("`{name}` in `{key}` is not a modifier the game documents or the mod defines, so it does nothing"),
                        ideas::line_at(doc, doc.token(m.key).start),
                    ));
                }
            }
        }
    }

    fn known_modifier(&self, name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        ideas::known_modifier(&self.state.loaded, &self.state.vocab, name)
            // Each project tag makes `<tag>_speed_factor`.
            || lower.strip_suffix("_speed_factor").is_some_and(|tag| self.state.names.get("project_tag").is_some_and(|t| t.contains(tag)))
    }

    fn text(out: &mut Found, key: &str, line: u32) {
        if !key.is_empty() && !key.contains(' ') && !computed(key) {
            out.texts.push((key.to_owned(), line));
        }
    }

    fn part(out: &mut Found, what: &'static str, id: &str, line: u32) {
        out.parts.push(Part { what, id: id.to_owned(), line });
    }

    fn check(&self, doc: &Document, what: &'static str, id: &str, entry: &Entry, out: &mut Found) {
        let line = ideas::line_at(doc, doc.token(entry.key).start);
        let Some(block) = entry.value.as_block() else {
            // A bare name: a project tag.
            Self::text(out, id, line);
            return;
        };
        fields(doc, block, out);
        match what {
            "on_action" => self.on_action(doc, id, block, line, out),
            "organization" => self.organization(doc, id, block, line, out),
            "policy" => {
                match scalar(doc, block, "name") {
                    Some((name, l)) => Self::text(out, &name, l),
                    None => Self::text(out, id, line),
                }
                self.sprites(out, doc, block, &["icon"], "");
                self.modifiers(out, doc, block, "organization_modifier");
            }
            "balance_of_power" => self.balance_of_power(doc, id, block, line, out),
            "project" => self.project(doc, id, block, line, out),
            "prototype_reward" => self.reward(doc, id, block, line, out, ""),
            "specialization" => {
                Self::text(out, id, line);
                self.sprites(out, doc, block, &["icon", "blueprint_image", "program_background"], "");
            }
            "operation" | "phase" | "token" => {
                for key in ["name", "desc"] {
                    match scalar(doc, block, key) {
                        Some((value, l)) => Self::text(out, &value, l),
                        None if what == "operation" => Self::text(out, &if key == "name" { id.to_owned() } else { format!("{id}_desc") }, line),
                        None => {}
                    }
                }
                self.sprites(out, doc, block, &["icon", "map_icon", "picture", "text_icon"], "");
                for equipment in block.entries().filter(|e| doc.key(e) == "equipment").filter_map(|e| e.value.as_block()) {
                    for e in equipment.entries().filter(|e| doc.key(e) != "civilian_factories") {
                        self.refer(out, "equipment", "equipment", &doc.key(e), ideas::line_at(doc, doc.token(e.key).start));
                    }
                }
                for phases in block.entries().filter(|e| doc.key(e) == "phases").filter_map(|e| e.value.as_block()) {
                    for phase in phases.entries().filter(|e| e.value.as_block().is_some()) {
                        let l = ideas::line_at(doc, doc.token(phase.key).start);
                        Self::part(out, "phase", &doc.key(phase), l);
                        self.refer(out, "phases", "phase", &doc.key(phase), l);
                    }
                }
                self.refer_all(out, doc, block, "awarded_tokens", "awarded_tokens", "token");
                self.refer_all(out, doc, block, "required_tokens", "required_tokens", "token");
            }
            "raid" => {
                // The game's raids use `raid_type_<id>`; mods also name them by the id alone.
                for (key, fallback) in [(format!("raid_type_{id}"), id.to_owned()), (format!("raid_type_{id}_desc"), format!("{id}_desc"))] {
                    Self::text(out, &key, line);
                    out.fallbacks.push((key, fallback));
                }
                self.refer_all(out, doc, block, "category", "category", "raid_category");
                self.sprites(out, doc, block, &["custom_map_icon", "custom_terrain_icon", "unit_icon", "target_icon", "equipment_icon"], "");
                for requirement in block.entries().filter(|e| doc.key(e) == "unit_requirements").filter_map(|e| e.value.as_block()) {
                    for types in requirement.entries().filter(|e| doc.key(e) == "battalion_types").filter_map(|e| e.value.as_block()) {
                        for unit in types.entries() {
                            self.refer(out, "unit_requirements.battalion_types", "sub_unit", &doc.key(unit), ideas::line_at(doc, doc.token(unit.key).start));
                        }
                    }
                }
                for target in block.entries().filter(|e| matches!(doc.key(e).as_ref(), "target_type" | "target_types")).filter_map(|e| e.value.as_block()) {
                    for building in target.entries().filter(|e| doc.key(e) == "building").filter_map(|e| e.value.as_block()) {
                        self.refer_all(out, doc, building, "type", "target_type.building.type", "building");
                    }
                }
            }
            "raid_category" => Self::text(out, &format!("raid_category_{id}"), line),
            "sub_unit" => self.sub_unit(doc, id, block, line, out),
            "equipment" => self.equipment(doc, id, block, line, out),
            "module" => self.module(doc, id, block, line, out),
            "variant" => self.variant(doc, block, out),
            _ => {}
        }
    }

    fn on_action(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        let state = self.state;
        if !state.hooks.is_empty()
            && !state.hooks.contains(id)
            && !state.hook_prefixes.iter().any(|p| id.strip_prefix(p.as_str()).is_some_and(|tag| tag.len() == 3))
        {
            out.problems.push(problem(
                "ON_ACTION_HOOK_UNDOCUMENTED",
                format!("neither the game's on_actions documentation nor its own files use `{id}`; check the name, since the game never runs an unknown hook"),
                line,
            ));
        }
        self.refer_all(out, doc, block, "events", "events", "event");
        for random in block.entries().filter(|e| doc.key(e) == "random_events").filter_map(|e| e.value.as_block()) {
            for item in &random.items {
                let (value, at) = match item {
                    Item::Entry(e) => match e.value.as_scalar() {
                        Some(t) => (doc.text(t), t),
                        None => continue,
                    },
                    Item::Value(Value::Scalar(t)) => (doc.text(*t), *t),
                    _ => continue,
                };
                // `100 = 0` is the weight of firing nothing.
                if value != "0" {
                    self.refer(out, "random_events", "event", &value, ideas::line_at(doc, doc.token(at).start));
                }
            }
        }
    }

    fn organization(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        let include = scalar(doc, block, "include");
        match (scalar(doc, block, "name"), &include) {
            (Some((name, l)), _) => Self::text(out, &name, l),
            // An included organization's name may carry over, so only a standalone one is judged.
            (None, None) => Self::text(out, id, line),
            (None, Some(_)) => {}
        }
        if let Some((value, l)) = &include {
            self.refer(out, "include", "organization", value, *l);
        }
        self.sprites(out, doc, block, &["icon", "background"], "");
        self.modifiers(out, doc, block, "organization_modifier");
        if let Some(initial) = block.entries().find(|e| doc.key(e) == "initial_trait").and_then(|e| e.value.as_block()) {
            self.sprites(out, doc, initial, &["icon"], "initial_trait.");
            self.modifiers(out, doc, initial, "organization_modifier");
        }
        let inherited = include.as_ref().map(|(name, _)| self.trait_tokens(name, &mut HashSet::new())).unwrap_or_default();
        let mut own: BTreeMap<String, u32> = BTreeMap::new();
        let mut links = Vec::new();
        for entry in block.entries().filter(|e| matches!(doc.key(e).as_ref(), "trait" | "add_trait")) {
            let Some(t) = entry.value.as_block() else { continue };
            let l = ideas::line_at(doc, doc.token(entry.key).start);
            let Some((token, tl)) = scalar(doc, t, "token") else {
                out.problems.push(problem("SYSTEM_TOKEN_MISSING", "a trait has no `token`, which the game needs to place and complete it".into(), l));
                continue;
            };
            // Redeclaring an included trait edits it, as the game's own organizations do.
            if own.insert(token.to_ascii_lowercase(), tl).is_some() {
                out.problems.push(problem("SYSTEM_DUPLICATE_TOKEN", format!("two traits of this organization use the token `{token}`"), tl));
            }
            Self::part(out, "trait", &token, l);
            match scalar(doc, t, "name") {
                Some((name, nl)) => Self::text(out, &name, nl),
                None => {
                    Self::text(out, &token, tl);
                    out.fallbacks.push((token.clone(), format!("{id}_{token}")));
                }
            }
            self.sprites(out, doc, t, &["icon"], "trait.");
            self.modifiers(out, doc, t, "organization_modifier");
            for key in ["any_parent", "all_parents", "mutually_exclusive", "relative_position_id"] {
                for e in t.entries().filter(|e| doc.key(e) == key) {
                    links.extend(values(doc, e).into_iter().map(|(v, vl)| (format!("trait.{key}"), v, vl)));
                }
            }
            for parent in t.entries().filter(|e| doc.key(e) == "parent").filter_map(|e| e.value.as_block()) {
                for e in parent.entries().filter(|e| doc.key(e) == "traits") {
                    links.extend(values(doc, e).into_iter().map(|(v, vl)| ("trait.parent".to_owned(), v, vl)));
                }
            }
        }
        let mut tokens: HashSet<String> = inherited.clone();
        tokens.extend(own.keys().cloned());
        for entry in block.entries() {
            let key = doc.key(entry);
            let named = match key.as_ref() {
                "remove_trait" => values(doc, entry),
                "override_trait" => entry.value.as_block().and_then(|b| scalar(doc, b, "token")).into_iter().collect(),
                _ => continue,
            };
            for (value, l) in named {
                self.trait_link(out, &format!("{key}"), &value, l, include.is_some(), &inherited);
            }
        }
        for (field, value, l) in links {
            self.trait_link(out, &field, &value, l, include.is_some(), &tokens);
        }
    }

    /// A trait token named inside an organization: it must be one of its own or included traits.
    fn trait_link(&self, out: &mut Found, field: &str, value: &str, line: u32, included: bool, tokens: &HashSet<String>) {
        if computed(value) {
            return;
        }
        let known = tokens.contains(&value.to_ascii_lowercase());
        if !known {
            let whose = if included { "this organization or the one it includes" } else { "this organization" };
            out.problems.push(problem("SYSTEM_REFERENCE_UNKNOWN", format!("`{field}` names the trait `{value}`, which {whose} does not have"), line));
        }
        out.references.push(Reference { field: field.to_owned(), target: "trait", value: value.to_owned(), known, line });
    }

    /// The trait tokens an organization ends up with: its include's, less removed ones, plus its own.
    fn trait_tokens(&self, id: &str, seen: &mut HashSet<String>) -> HashSet<String> {
        let state = self.state;
        if !seen.insert(id.to_ascii_lowercase()) {
            return HashSet::new();
        }
        let Some(def) = state.defs.iter().rev().find(|d| d.what == "organization" && d.id.eq_ignore_ascii_case(id)) else { return HashSet::new() };
        let doc = &state.docs[def.doc].1;
        let Some(block) = state.system.sources().first().and_then(|s| entry_of(doc, s, &def.id, def.line)).and_then(|e| e.value.as_block()) else {
            return HashSet::new();
        };
        let mut tokens = scalar(doc, block, "include").map(|(name, _)| self.trait_tokens(&name, seen)).unwrap_or_default();
        for entry in block.entries() {
            match doc.key(entry).as_ref() {
                "trait" | "add_trait" => {
                    if let Some((token, _)) = entry.value.as_block().and_then(|b| scalar(doc, b, "token")) {
                        tokens.insert(token.to_ascii_lowercase());
                    }
                }
                "remove_trait" => {
                    for (token, _) in values(doc, entry) {
                        tokens.remove(&token.to_ascii_lowercase());
                    }
                }
                _ => {}
            }
        }
        tokens
    }

    fn balance_of_power(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        Self::text(out, id, line);
        // `decision_category` names the category the balance creates for its decisions (the game's
        // `common/decisions/SWE.txt` files decisions under one no category file defines), so it
        // refers to nothing and is not checked.
        let mut sides = HashSet::new();
        let mut ranges: HashSet<String> = HashSet::new();
        let mut range = |out: &mut Found, r: &Block, l: u32| {
            if let Some((rid, rl)) = scalar(doc, r, "id") {
                if !ranges.insert(rid.to_ascii_lowercase()) {
                    out.problems.push(problem("SYSTEM_DUPLICATE_TOKEN", format!("two ranges use the id `{rid}`"), rl));
                }
                Self::part(out, "range", &rid, l);
                Self::text(out, &rid, rl);
            }
            self.modifiers(out, doc, r, "modifier");
        };
        for entry in block.entries() {
            let l = ideas::line_at(doc, doc.token(entry.key).start);
            match (doc.key(entry).as_ref(), entry.value.as_block()) {
                ("range", Some(r)) => range(out, r, l),
                ("side", Some(s)) => {
                    if let Some((sid, sl)) = scalar(doc, s, "id") {
                        sides.insert(sid.to_ascii_lowercase());
                        Self::part(out, "side", &sid, l);
                        Self::text(out, &sid, sl);
                    }
                    self.sprites(out, doc, s, &["icon"], "side.");
                    for r in s.entries().filter(|e| doc.key(e) == "range") {
                        if let Some(rb) = r.value.as_block() {
                            range(out, rb, ideas::line_at(doc, doc.token(r.key).start));
                        }
                    }
                }
                _ => {}
            }
        }
        for key in ["left_side", "right_side"] {
            if let Some((value, l)) = scalar(doc, block, key) {
                let known = sides.contains(&value.to_ascii_lowercase());
                if !known {
                    out.problems.push(problem("SYSTEM_REFERENCE_UNKNOWN", format!("`{key}` names the side `{value}`, which no `side` block here has"), l));
                }
                out.references.push(Reference { field: key.to_owned(), target: "side", value, known, line: l });
            }
        }
    }

    fn project(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        let narrative = block.entries().find(|e| doc.key(e) == "narrative").and_then(|e| e.value.as_block());
        match narrative.and_then(|n| scalar(doc, n, "name")) {
            Some((name, l)) => Self::text(out, &name, l),
            None => Self::text(out, id, line),
        }
        match narrative.and_then(|n| scalar(doc, n, "desc")) {
            Some((desc, l)) => Self::text(out, &desc, l),
            None => Self::text(out, &format!("{id}_desc"), line),
        }
        self.refer_all(out, doc, block, "specialization", "specialization", "specialization");
        self.refer_all(out, doc, block, "project_tags", "project_tags", "project_tag");
        self.refer_all(out, doc, block, "special_project_parent", "special_project_parent", "project");
        self.refer_all(out, doc, block, "generic_prototype_rewards", "generic_prototype_rewards", "prototype_reward");
        for cost in block.entries().filter(|e| doc.key(e) == "breakthrough_cost").filter_map(|e| e.value.as_block()) {
            for e in cost.entries() {
                self.refer(out, "breakthrough_cost", "specialization", &doc.key(e), ideas::line_at(doc, doc.token(e.key).start));
            }
        }
        self.sprites(out, doc, block, &["icon", "blueprint_image"], "");
        self.output(doc, block, "project_output", out);
        for unique in block.entries().filter(|e| doc.key(e) == "unique_prototype_rewards").filter_map(|e| e.value.as_block()) {
            for reward in unique.entries() {
                let Some(r) = reward.value.as_block() else { continue };
                let rid = doc.key(reward);
                let l = ideas::line_at(doc, doc.token(reward.key).start);
                Self::part(out, "reward", &rid, l);
                self.reward(doc, &rid, r, l, out, "unique_prototype_rewards.");
            }
        }
    }

    fn reward(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found, prefix: &str) {
        Self::text(out, id, line);
        self.sprites(out, doc, block, &["icon"], prefix);
        let mut tokens = HashSet::new();
        let options: Vec<&Entry> = block.entries().filter(|e| doc.key(e) == "option").collect();
        if options.is_empty() {
            out.problems.push(problem("SYSTEM_TOKEN_MISSING", format!("the reward `{id}` has no `option`, and the game needs at least one"), line));
        }
        // The player picks between options only when there are several; a lone option's name is never shown.
        let choice = options.len() > 1;
        for option in options {
            let Some(o) = option.value.as_block() else { continue };
            let l = ideas::line_at(doc, doc.token(option.key).start);
            let Some((token, tl)) = scalar(doc, o, "token") else {
                out.problems.push(problem("SYSTEM_TOKEN_MISSING", format!("an option of `{id}` has no `token`, which the game needs"), l));
                continue;
            };
            if !tokens.insert(token.to_ascii_lowercase()) {
                out.problems.push(problem("SYSTEM_DUPLICATE_TOKEN", format!("two options of `{id}` use the token `{token}`"), tl));
            }
            Self::part(out, "option", &token, l);
            match o.entries().find(|e| doc.key(e) == "narrative").and_then(|e| e.value.as_block()).and_then(|n| scalar(doc, n, "name")) {
                Some((name, nl)) => Self::text(out, &name, nl),
                None if choice => Self::text(out, &token, tl),
                None => {}
            }
            self.output(doc, o, "iteration_output", out);
        }
    }

    /// `project_output` and `iteration_output`: the equipment, modules and sub-units they enable.
    fn output(&self, doc: &Document, block: &Block, key: &str, out: &mut Found) {
        for output in block.entries().filter(|e| doc.key(e) == key).filter_map(|e| e.value.as_block()) {
            for (field, target) in [("enable_equipments", "equipment"), ("enable_equipment_modules", "equipment_module"), ("enable_subunits", "sub_unit")] {
                self.refer_all(out, doc, output, field, &format!("{key}.{field}"), target);
            }
        }
    }
}

/// Top-level scalar fields and short blocks as written, for the single inspection.
fn fields(doc: &Document, block: &Block, out: &mut Found) {
    const PARTS: &[&str] = &["trait", "add_trait", "range", "side", "option", "phases", "unique_prototype_rewards"];
    for entry in block.entries().filter(|e| !PARTS.contains(&doc.key(e).as_ref())) {
        if out.fields.len() >= MAX_FIELDS {
            break;
        }
        let mut text = ideas::raw(doc, entry);
        if text.chars().count() > MAX_FIELD_TEXT {
            text = text.chars().take(MAX_FIELD_TEXT).collect::<String>() + "…";
        }
        out.fields.push(Field { name: doc.key(entry).into_owned(), text, line: ideas::line_at(doc, doc.token(entry.key).start) });
    }
}

fn check_def(state: &State, def: &Def) -> Found {
    let mut out = Found::default();
    let doc = &state.docs[def.doc].1;
    let Some(source) = source_of(state.system, &state.loaded.workspace.files[def.file].relative) else { return out };
    let own = Some(state.loaded.workspace.files[def.file].layer) == state.loaded.workspace.target_layer();
    let checker = Checker { state, own };
    if source.bare {
        Checker::text(&mut out, &def.id, def.line);
        return out;
    }
    if source.whole_file {
        checker.oob(doc, &def.id, &mut out);
        return out;
    }
    if let Some(entry) = entry_of(doc, source, &def.id, def.line) {
        checker.check(doc, def.what, &def.id, entry, &mut out);
    }
    out
}

/// The wanted keys no language defines, counting a key as defined when its fallback is.
fn missing_texts(state: &State, wanted: &[(String, u32)], fallbacks: &[(String, String)]) -> HashSet<String> {
    let mut keys: HashSet<String> = wanted.iter().map(|(k, _)| k.clone()).collect();
    keys.extend(fallbacks.iter().map(|(_, f)| f.clone()));
    let found = localisation::texts(&state.loaded.workspace, &keys);
    wanted.iter().map(|(k, _)| k).filter(|k| !found.contains_key(*k) && !fallbacks.iter().any(|(key, f)| key == *k && found.contains_key(f))).cloned().collect()
}

fn name_problem(key: &str, line: u32) -> Problem {
    problem("SYSTEM_NAME_MISSING", format!("no language defines `{key}`, so the game shows the key instead of text"), line)
}

pub fn respond(request: &Request) -> Response {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let state = load(request);
    let workspace = &state.loaded.workspace;
    let id = request.id.as_str();
    let matching: Vec<&Def> = state.defs.iter().filter(|d| d.id == id).collect();
    let mut response = Response {
        kind: state.system.label(),
        id: id.to_owned(),
        found: !matching.is_empty(),
        definitions: matching.iter().map(|d| Definition { what: d.what, place: ideas::place(workspace, d.file, d.line) }).collect(),
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
    let Some(active) = matching.last() else {
        let names: BTreeSet<String> = state.defs.iter().map(|d| d.id.clone()).collect();
        response.suggestions = ideas::suggest(id, names.into_iter());
        return response;
    };
    // Every on_actions file adds to the hook; the other systems use the last definition.
    let checked: Vec<&Def> = if active.what == "on_action" { matching.clone() } else { vec![active] };
    let mut text_keys: Vec<(String, u32)> = Vec::new();
    let mut fallbacks: Vec<(String, String)> = Vec::new();
    for def in checked {
        let found = check_def(&state, def);
        response.fields.extend(found.fields);
        response.parts.extend(found.parts);
        response.references.extend(found.references);
        response.problems.extend(found.problems);
        fallbacks.extend(found.fallbacks);
        for (key, line) in found.texts {
            if !text_keys.iter().any(|(k, _)| *k == key) {
                text_keys.push((key, line));
            }
        }
    }
    if active.what == "on_action" {
        response.problems.extend(dropped_hooks(&state).into_iter().filter(|(hook, _, _)| hook == id).map(|(_, _, p)| p));
    }
    let mut keys: HashSet<String> = text_keys.iter().map(|(k, _)| k.clone()).collect();
    keys.extend(fallbacks.iter().map(|(_, f)| f.clone()));
    let mut texts = localisation::texts(workspace, &keys);
    for (key, line) in &text_keys {
        let mut shown = key.clone();
        let mut found = texts.remove(key).unwrap_or_default();
        if found.is_empty()
            && let Some((_, fallback)) = fallbacks.iter().find(|(k, f)| k == key && texts.contains_key(f))
        {
            shown = fallback.clone();
            found = texts.remove(fallback).unwrap_or_default();
        }
        if found.is_empty() {
            response.problems.push(name_problem(key, *line));
        }
        // The definition's name in every language; other texts in one language, English when there
        // is one, so the answer stays small.
        if response.texts.len() < MAX_TEXT_KEYS {
            let mut texts = found;
            if !response.texts.is_empty() && texts.len() > 1 {
                let keep = texts.iter().position(|t| t.language == "english").unwrap_or(0);
                texts = vec![texts.swap_remove(keep)];
            }
            for text in &mut texts {
                if text.text.chars().count() > MAX_FIELD_TEXT {
                    text.text = text.text.chars().take(MAX_FIELD_TEXT).collect::<String>() + "…";
                }
            }
            response.texts.push(KeyTexts { key: shown, texts });
        }
    }
    let mut seen = BTreeSet::new();
    response.problems.retain(|p| seen.insert((p.code, p.message.clone(), p.line)));
    response.fields.truncate(MAX_FIELDS);
    response.parts_truncated = response.parts.len() > MAX_LISTED;
    response.parts.truncate(MAX_LISTED);
    // References that point at nothing first; the problems list every one of them as well.
    response.references.sort_by_key(|r| r.known);
    response.references_truncated = response.references.len() > MAX_REFERENCES;
    response.references.truncate(MAX_REFERENCES);
    let (mentions, truncated) = localisation::mentions(workspace, id, limit);
    response.mentions = mentions;
    response.mentions_truncated = truncated;
    for p in &mut response.problems {
        p.code = renamed(state.system, p.code);
    }
    response
}

/// Hooks a checked-layer on_actions file drops by replacing a file at the same path, when no other
/// loaded file adds to them: (hook, file, problem).
fn dropped_hooks(state: &State) -> Vec<(String, usize, Problem)> {
    let workspace = &state.loaded.workspace;
    let Some(target) = workspace.target_layer() else { return Vec::new() };
    let loaded: HashSet<String> = state.defs.iter().filter(|d| d.what == "on_action").map(|d| d.id.clone()).collect();
    let mut out = Vec::new();
    for (file, hidden) in workspace.hidden.iter().enumerate() {
        let Some(Hidden::Overridden { by }) = hidden else { continue };
        if workspace.files[*by].layer != target || source_of(state.system, &workspace.files[file].relative).is_none() {
            continue;
        }
        let Ok(bytes) = fs::read(&workspace.files[file].absolute) else { continue };
        let doc = Document::parse(bytes);
        let hooks: BTreeSet<String> = definitions_in(&doc, &state.system.sources()[0], "").into_iter().map(|(h, _)| h).collect();
        for hook in hooks.into_iter().filter(|h| !loaded.contains(h)) {
            let layer = &workspace.layers[workspace.files[file].layer].name;
            out.push((
                hook.clone(),
                *by,
                problem(
                    "ON_ACTION_HOOK_DROPPED",
                    format!("this file replaces `{}` from {layer}, which adds to `{hook}`; nothing else adds to it now, so that hook no longer runs its effects or events", workspace.files[file].relative),
                    1,
                ),
            ));
        }
    }
    out
}

/// Every definition the checked layer makes, with the checks of the single inspection.
pub fn audit(request: &Request) -> Audit {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let state = load(request);
    let workspace = &state.loaded.workspace;
    let target = workspace.target_layer();
    let own: Vec<&Def> = state.defs.iter().filter(|d| Some(workspace.files[d.file].layer) == target).collect();
    let checked: Vec<(&Def, Found)> = own.par_iter().map(|def| (*def, check_def(&state, def))).collect();
    let mut counts = BTreeMap::new();
    let mut problems = Vec::new();
    let mut push = |p: Problem, id: &str, file: usize| {
        let code = renamed(state.system, p.code);
        let count = counts.entry(code).or_insert(0);
        *count += 1;
        if *count <= limit {
            problems.push(AuditProblem {
                code,
                severity: p.severity,
                id: id.to_owned(),
                path: workspace.files[file].relative.clone(),
                line: p.line,
                message: p.message,
            });
        }
    };
    let wanted: Vec<(String, u32)> = checked.iter().flat_map(|(_, f)| f.texts.iter().cloned()).collect();
    let fallbacks: Vec<(String, String)> = checked.iter().flat_map(|(_, f)| f.fallbacks.iter().cloned()).collect();
    let missing = missing_texts(&state, &wanted, &fallbacks);
    for (def, found) in &checked {
        let mut seen = HashSet::new();
        for p in &found.problems {
            if seen.insert((p.code, p.message.clone(), p.line)) {
                push(Problem { code: p.code, severity: p.severity, message: p.message.clone(), line: p.line }, &def.id, def.file);
            }
        }
        let mut reported = HashSet::new();
        for (key, line) in &found.texts {
            if missing.contains(key) && reported.insert(key) {
                push(name_problem(key, *line), &def.id, def.file);
            }
        }
    }
    if state.system == System::OnActions {
        for (hook, file, p) in dropped_hooks(&state) {
            push(p, &hook, file);
        }
    }
    if state.system == System::Oob {
        for (name, file, p) in units::missing_oobs(&state) {
            push(p, &name, file);
        }
    }
    let truncated = counts.values().any(|&c| c > limit);
    Audit { kind: state.system.label(), checked: own.len(), counts, problems, truncated }
}

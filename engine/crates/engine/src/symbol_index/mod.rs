//! The shared symbol index: every definition the TypeScript core's index recorded, under the same
//! kind names and with the same `overridden` and `sourceShadowed` rules, for `hoi4.mod_index` and
//! then `hoi4.source_lookup`.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/index.ts` (`SymbolIndex`,
//! `possibleSymbolKinds`, `selectedDefinitionFiles`, `walkBlock`, the map tables and `finalize`)
//! at commit `5c75b21`. The engine's own [`crate::index`] has a different taxonomy for its checks;
//! this module keeps the TypeScript one, because the tools' answers name these kinds.
//!
//! Each record keeps its kind, id, file (root, load order and display path) and line, and whether
//! it is `overridden` (a higher load order defines the same kind and id, or its file is shadowed)
//! and `source_shadowed` (its file is shadowed). Kinds that add up instead of replacing each other
//! (`decision_category`, `technology_category`, `gui_element`, `texture`) are overridden only when
//! their file is shadowed.
//!
//! Not carried over: references, diagnostics other than the coverage that makes the index
//! partial, record metadata (positions, colours, provinces) and the incremental segment cache. The
//! TypeScript index also became partial past two million references; this one does not record
//! references, so that ceiling cannot be reached here.

pub mod reader;
pub mod scan;
mod walk;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;

use rayon::prelude::*;
use serde::Serialize;

use reader::{Limit, decode, parse_clausewitz, parse_localisation};
pub use scan::{Limits, Patterns, Root, RootKind, ScanError, ScannedFile, compare_code_units};

/// `INDEX_RECORD_LIMIT`.
pub const INDEX_RECORD_LIMIT: usize = 2_000_000;
/// `INDEX_TABLE_RECORD_LIMIT`: lines of one map table.
pub const INDEX_TABLE_RECORD_LIMIT: u32 = 100_000;
/// `INDEX_TABLE_FIELD_LIMIT`: fields of one map-table row.
pub const INDEX_TABLE_FIELD_LIMIT: usize = 10_000;
/// `INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT`.
pub const SKIPPED_SOURCE_SAMPLE_LIMIT: usize = 100;

macro_rules! kinds {
    ($($variant:ident => $name:literal,)*) => {
        /// `SymbolKind` of the TypeScript core.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        pub enum SymbolKind {
            $(#[serde(rename = $name)] $variant,)*
        }

        impl SymbolKind {
            pub const ALL: &'static [SymbolKind] = &[$(SymbolKind::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(SymbolKind::$variant => $name,)*
                }
            }

            pub fn parse(name: &str) -> Option<SymbolKind> {
                match name {
                    $($name => Some(SymbolKind::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

kinds! {
    FocusTree => "focus_tree",
    Focus => "focus",
    ContinuousFocusPalette => "continuous_focus_palette",
    ContinuousFocus => "continuous_focus",
    Decision => "decision",
    DecisionCategory => "decision_category",
    Event => "event",
    Idea => "idea",
    Leader => "leader",
    Formable => "formable",
    ScriptedEffect => "scripted_effect",
    ScriptedTrigger => "scripted_trigger",
    ScriptConstant => "script_constant",
    MtthVariable => "mtth_variable",
    AiStrategy => "ai_strategy",
    AiStrategyPlan => "ai_strategy_plan",
    Sprite => "sprite",
    Texture => "texture",
    GuiElement => "gui_element",
    ScriptedGui => "scripted_gui",
    Technology => "technology",
    TechnologyFolder => "technology_folder",
    TechnologyCategory => "technology_category",
    TechnologyTag => "technology_tag",
    Equipment => "equipment",
    EquipmentModule => "equipment_module",
    SubUnit => "sub_unit",
    UnitCategory => "unit_category",
    Building => "building",
    Ability => "ability",
    CombatTactic => "combat_tactic",
    DoctrineFolder => "doctrine_folder",
    GrandDoctrine => "grand_doctrine",
    DoctrineTrack => "doctrine_track",
    Subdoctrine => "subdoctrine",
    Localisation => "localisation",
    Variable => "variable",
    Flag => "flag",
    EventTarget => "event_target",
    State => "state",
    Province => "province",
    ProvinceColor => "province_color",
    StrategicRegion => "strategic_region",
    Adjacency => "adjacency",
    SupplyNode => "supply_node",
    Railway => "railway",
}

impl SymbolKind {
    /// Kinds whose definitions add up instead of replacing each other.
    pub fn is_additive(self) -> bool {
        matches!(self, SymbolKind::DecisionCategory | SymbolKind::TechnologyCategory | SymbolKind::GuiElement | SymbolKind::Texture)
    }
}

/// One definition.
#[derive(Clone, Debug)]
pub struct Symbol {
    pub kind: SymbolKind,
    pub id: String,
    /// Index into [`SymbolIndex::files`].
    pub file: u32,
    /// 1-based line of the definition; map-table records name their table line.
    pub line: u32,
    /// 1-based last line of the definition (its closing brace); equal to `line` for a record of a
    /// map table, a localisation key or a scalar.
    pub end_line: u32,
    pub overridden: bool,
    pub source_shadowed: bool,
}

/// A source the index could not read whole, so a definition it holds may be missing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSource {
    pub path: String,
    pub reason_codes: Vec<String>,
    pub possible_symbol_kinds: Vec<SymbolKind>,
}

/// The index of one workspace's selected files.
#[derive(Debug, Default)]
pub struct SymbolIndex {
    pub roots: Vec<Root>,
    /// In load order, then by relative path.
    pub files: Vec<ScannedFile>,
    /// In indexing order: by load order and display path, then in each file's order.
    pub symbols: Vec<Symbol>,
    /// False when a source was skipped or a ceiling was reached.
    pub complete: bool,
    pub skipped_source_count: usize,
    /// At most [`SKIPPED_SOURCE_SAMPLE_LIMIT`].
    pub skipped_sources: Vec<SkippedSource>,
    pub skipped_possible_kinds: BTreeSet<SymbolKind>,
    skipped_paths: HashSet<usize>,
}

/// What reading one file produced.
#[derive(Default)]
struct FileRecords {
    symbols: Vec<walk::Found>,
    /// The file was skipped: its partial-limit codes.
    skipped: Option<Vec<String>>,
    /// A map table hit its line or field ceiling; records before it are kept.
    table_blocked: bool,
    /// The definition walk passed the nesting ceiling.
    nesting_blocked: bool,
}

/// An unreadable file ends the build, as a failed read ended the TypeScript scan.
#[derive(Debug)]
pub struct BuildError {
    pub code: &'static str,
    pub message: String,
}

impl From<ScanError> for BuildError {
    fn from(error: ScanError) -> Self {
        BuildError { code: error.code, message: error.message }
    }
}

fn lower_path(file: &ScannedFile) -> String {
    file.relative.replace('\\', "/").to_lowercase()
}

/// `possibleSymbolKinds`.
fn possible_symbol_kinds(file: &ScannedFile, definition_file: bool) -> Vec<SymbolKind> {
    use SymbolKind as K;
    let path = lower_path(file);
    let mut kinds = BTreeSet::new();
    if path.ends_with(".yml") || path.ends_with(".yaml") {
        kinds.insert(K::Localisation);
    }
    if definition_file || path.rsplit('/').next() == Some("default.map") {
        kinds.insert(K::Province);
        kinds.insert(K::ProvinceColor);
    }
    if path.ends_with("adjacencies.csv") {
        kinds.insert(K::Adjacency);
    }
    if path.ends_with("supply_nodes.txt") {
        kinds.insert(K::SupplyNode);
    }
    if path.ends_with("railways.txt") {
        kinds.insert(K::Railway);
    }
    if path.ends_with(".gfx") {
        kinds.insert(K::Sprite);
        kinds.insert(K::Texture);
    }
    if path.ends_with(".gui") {
        kinds.insert(K::GuiElement);
    }
    if path.ends_with(".txt") {
        let starts = |prefix: &str| path.starts_with(prefix);
        if starts("common/technologies/") {
            kinds.insert(K::Technology);
        }
        if starts("common/technology_tags/") {
            kinds.extend([K::TechnologyFolder, K::TechnologyCategory, K::TechnologyTag]);
        }
        if starts("common/units/equipment/modules/") {
            kinds.insert(K::EquipmentModule);
        } else if starts("common/units/equipment/") {
            kinds.insert(K::Equipment);
        } else if starts("common/units/") {
            kinds.insert(K::SubUnit);
        }
        for (prefix, kind) in [
            ("common/unit_tags/", K::UnitCategory),
            ("common/buildings/", K::Building),
            ("common/abilities/", K::Ability),
            ("common/doctrines/folders/", K::DoctrineFolder),
            ("common/doctrines/grand_doctrines/", K::GrandDoctrine),
            ("common/doctrines/tracks/", K::DoctrineTrack),
            ("common/doctrines/subdoctrines/", K::Subdoctrine),
            ("events/", K::Event),
            ("common/scripted_effects/", K::ScriptedEffect),
            ("common/scripted_triggers/", K::ScriptedTrigger),
            ("common/script_constants/", K::ScriptConstant),
            ("common/mtth/", K::MtthVariable),
            ("common/ai_strategy/", K::AiStrategy),
            ("common/ai_strategy_plans/", K::AiStrategyPlan),
            ("common/ideas/", K::Idea),
            ("common/characters/", K::Leader),
            ("common/scripted_guis/", K::ScriptedGui),
        ] {
            if starts(prefix) {
                kinds.insert(kind);
            }
        }
        if path == "common/combat_tactics.txt" || starts("common/combat_tactics/") {
            kinds.insert(K::CombatTactic);
        }
        if walk::focus_path(&path) {
            kinds.extend([K::FocusTree, K::Focus, K::ContinuousFocusPalette, K::ContinuousFocus]);
        }
        if starts("common/decisions/") {
            kinds.extend([K::Decision, K::DecisionCategory, K::Formable]);
        }
        if starts("history/states/") || path.contains("/history/states/") {
            kinds.insert(K::State);
        }
        if starts("strategicregions/") || path.contains("/strategicregions/") {
            kinds.insert(K::StrategicRegion);
        }
    }
    kinds.into_iter().collect()
}

/// `path.posix.normalize` of a joined relative path.
fn posix_normalize(path: &str) -> String {
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() {
        out.push('.');
    }
    if trailing && out != "." {
        out.push('/');
    }
    out
}

fn posix_join(directory: &str, name: &str) -> String {
    posix_normalize(&format!("{directory}/{name}"))
}

fn posix_dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => path[..i].to_string(),
        None => ".".into(),
    }
}

fn posix_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `normalizedRelative`.
fn normalized_relative(value: &str) -> String {
    let value = value.replace('\\', "/");
    value.strip_prefix("./").unwrap_or(&value).to_lowercase()
}

/// `selectedDefinitionFiles`: which `definition.csv` files hold provinces, following each map
/// folder's `default.map` `definitions` entry. Returns the selected files and the `default.map`
/// files that could not be read whole, with their partial-limit codes.
/// The selected definition files, and the unreadable `default.map` files with their codes.
type DefinitionSelection = (BTreeSet<usize>, Vec<(usize, Vec<String>)>);

fn selected_definition_files(files: &[ScannedFile]) -> Result<DefinitionSelection, BuildError> {
    let defaults: Vec<usize> = (0..files.len()).filter(|&i| posix_basename(&normalized_relative(&files[i].relative)) == "default.map").collect();
    let mut directories: Vec<String> = Vec::new();
    for &i in &defaults {
        let directory = posix_dirname(&normalized_relative(&files[i].relative));
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    // The `definitions` value of each readable default.map, or the reasons it was skipped.
    let mut parsed: HashMap<usize, Result<Option<String>, Vec<String>>> = HashMap::new();
    let mut parse_default = |i: usize| -> Result<Result<Option<String>, Vec<String>>, BuildError> {
        if let Some(known) = parsed.get(&i) {
            return Ok(known.clone());
        }
        let bytes = read(&files[i])?;
        let (text, lossy) = decode(&bytes);
        let document = parse_clausewitz(&text, bytes.len(), lossy);
        let result = if document.diagnostics.is_partial() {
            Err(document.diagnostics.partial_limits().iter().map(|l| l.code().to_string()).collect())
        } else {
            Ok(document.root.first_scalar("definitions").map(|s| s.value.to_string()))
        };
        parsed.insert(i, result.clone());
        Ok(result)
    };
    let mut by_priority = defaults.clone();
    by_priority.sort_by(|&a, &b| files[b].load_order.cmp(&files[a].load_order).then_with(|| compare_code_units(&files[a].display, &files[b].display)));
    let mut active_selector: HashMap<String, String> = HashMap::new();
    let mut decided: BTreeSet<String> = BTreeSet::new();
    let mut blocked: BTreeSet<String> = BTreeSet::new();
    let mut skipped: Vec<(usize, Vec<String>)> = Vec::new();
    for &i in &by_priority {
        let directory = posix_dirname(&normalized_relative(&files[i].relative));
        if !decided.insert(directory.clone()) {
            continue;
        }
        match parse_default(i)? {
            Err(codes) => {
                if !skipped.iter().any(|(s, _)| *s == i) {
                    skipped.push((i, codes));
                }
                blocked.insert(directory);
            }
            Ok(selector) => {
                active_selector.insert(directory, selector.unwrap_or_else(|| "definition.csv".into()));
            }
        }
    }
    // Groups by root kind and load order, in first-seen order.
    let mut groups: Vec<((RootKind, i64), Vec<usize>)> = Vec::new();
    for (i, file) in files.iter().enumerate() {
        let key = (file.kind, file.load_order);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, members)) => members.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    let mut selected = BTreeSet::new();
    for (_, members) in &groups {
        let mut by_relative: HashMap<String, usize> = HashMap::new();
        for &i in members {
            by_relative.insert(normalized_relative(&files[i].relative), i);
        }
        for directory in &directories {
            if blocked.contains(directory) {
                continue;
            }
            let default_map = by_relative.get(&posix_join(directory, "default.map")).copied();
            let own = match default_map {
                Some(i) => match parse_default(i)? {
                    Ok(selector) => selector,
                    Err(codes) => {
                        if !skipped.iter().any(|(s, _)| *s == i) {
                            skipped.push((i, codes));
                        }
                        continue;
                    }
                },
                None => None,
            };
            let selector = own.or_else(|| active_selector.get(directory).cloned()).unwrap_or_else(|| "definition.csv".into());
            let target = normalized_relative(&posix_join(directory, &selector).replace('\\', "/"));
            if let Some(&definition) = by_relative.get(&target) {
                selected.insert(definition);
            }
        }
    }
    for (i, file) in files.iter().enumerate() {
        let relative = normalized_relative(&file.relative);
        if posix_basename(&relative) == "definition.csv" && !directories.contains(&posix_dirname(&relative)) {
            selected.insert(i);
        }
    }
    Ok((selected, skipped))
}

fn read(file: &ScannedFile) -> Result<Vec<u8>, BuildError> {
    fs::read(&file.absolute).map_err(|e| BuildError { code: "SCAN_READ_FAILED", message: format!("cannot read {}: {e}", file.display) })
}

/// `tableLines`: the lines of a map table, decoded leniently as UTF-8, with the trailing empty
/// line after a final line break. Returns false when the line ceiling stopped it.
fn table_lines(text: &str, mut each: impl FnMut(&str, u32)) -> bool {
    let mut rest = text;
    let mut line = 1u32;
    loop {
        if line > INDEX_TABLE_RECORD_LIMIT {
            return false;
        }
        let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
        each(&rest[..end], line);
        if end >= rest.len() {
            return true;
        }
        let skip = if rest[end..].starts_with("\r\n") { 2 } else { 1 };
        rest = &rest[end + skip..];
        line += 1;
    }
}

/// `splitDelimitedBounded`.
fn split_bounded(value: &str, delimiter: char, maximum: usize) -> Vec<&str> {
    value.splitn(maximum, delimiter).collect()
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

fn index_table(bytes: &[u8], kind: TableKind, records: &mut FileRecords) {
    if bytes.len() > reader::SOURCE_MAX_BYTES {
        records.skipped = Some(vec!["INDEX_TABLE_FILE_LIMIT".into()]);
        return;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut blocked = false;
    let finished = table_lines(&text, |row, line| {
        match kind {
            TableKind::Definitions => {
                let parts = split_bounded(row, ';', 8);
                if parts.len() >= 4 && digits(parts[0]) {
                    let color = format!("{},{},{}", parts[1], parts[2], parts[3]);
                    records.symbols.push((SymbolKind::Province, parts[0].to_string(), line, line));
                    records.symbols.push((SymbolKind::ProvinceColor, color, line, line));
                }
            }
            TableKind::Adjacencies => {
                if line != 1 {
                    let parts = split_bounded(row, ';', 4);
                    if parts.len() >= 3 && digits(parts[0]) && digits(parts[1]) {
                        records.symbols.push((SymbolKind::Adjacency, format!("{}:{}:{}:{line}", parts[0], parts[1], parts[2]), line, line));
                    }
                }
            }
            TableKind::Network(kind) => {
                let mut values: Vec<&str> = Vec::new();
                for field in row.split(reader::is_js_space).filter(|f| !f.is_empty()) {
                    if values.len() >= INDEX_TABLE_FIELD_LIMIT {
                        // A field ceiling skips the row; the table goes on.
                        blocked = true;
                        return;
                    }
                    values.push(field);
                }
                if values.len() >= 2 && values.iter().all(|v| digits(v)) {
                    records.symbols.push((kind, format!("{line}:{}", values.join(":")), line, line));
                }
            }
        }
    });
    records.table_blocked = blocked || !finished;
}

#[derive(Clone, Copy)]
enum TableKind {
    Definitions,
    Adjacencies,
    Network(SymbolKind),
}

/// `indexFile`: the records of one file.
fn index_file(file: &ScannedFile, definition_file: bool) -> Result<FileRecords, BuildError> {
    let mut records = FileRecords::default();
    let lower = file.relative.to_lowercase();
    let is_yml = lower.ends_with(".yml");
    let table = if is_yml {
        None
    } else if definition_file {
        Some(TableKind::Definitions)
    } else if lower.ends_with("adjacencies.csv") {
        Some(TableKind::Adjacencies)
    } else if lower.ends_with("supply_nodes.txt") {
        Some(TableKind::Network(SymbolKind::SupplyNode))
    } else if lower.ends_with("railways.txt") {
        Some(TableKind::Network(SymbolKind::Railway))
    } else {
        None
    };
    let script = !is_yml && table.is_none() && (lower.ends_with(".txt") || lower.ends_with(".gui") || lower.ends_with(".gfx"));
    if !is_yml && table.is_none() && !script {
        return Ok(records);
    }
    let bytes = read(file)?;
    if let Some(table) = table {
        index_table(&bytes, table, &mut records);
        return Ok(records);
    }
    if is_yml {
        let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let (text, _) = decode(&bytes);
        let parsed = parse_localisation(&text, bytes.len(), bom);
        if parsed.diagnostics.is_partial() {
            records.skipped = Some(codes(&parsed.diagnostics.partial_limits()));
            return Ok(records);
        }
        records.symbols = parsed.entries.into_iter().map(|e| (SymbolKind::Localisation, format!("{}:{}", e.language, e.key), e.line, e.line)).collect();
        return Ok(records);
    }
    // Map position and network tables are not Clausewitz assignment sources.
    if !bytes.contains(&b'=') {
        return Ok(records);
    }
    let (text, lossy) = decode(&bytes);
    let document = parse_clausewitz(&text, bytes.len(), lossy);
    if document.diagnostics.is_partial() {
        records.skipped = Some(codes(&document.diagnostics.partial_limits()));
        return Ok(records);
    }
    let walked = walk::walk(&document.root, &lower_path(file));
    records.nesting_blocked = walked.nesting_blocked;
    records.symbols = walked.symbols;
    Ok(records)
}

fn codes(limits: &[Limit]) -> Vec<String> {
    limits.iter().map(|l| l.code().to_string()).collect()
}

impl SymbolIndex {
    /// Scans the roots with the patterns and indexes every selected file.
    pub fn build(roots: Vec<Root>, patterns: &Patterns, limits: Limits) -> Result<SymbolIndex, BuildError> {
        let files = scan::scan(&roots, patterns, limits)?;
        let mut index = SymbolIndex { roots, files, complete: true, ..SymbolIndex::default() };
        let (definitions, skipped_defaults) = selected_definition_files(&index.files)?;
        for (file, reasons) in skipped_defaults {
            index.record_skipped(file, reasons, &definitions);
        }
        let mut order: Vec<usize> = (0..index.files.len()).collect();
        order.sort_by(|&a, &b| {
            index.files[a].load_order.cmp(&index.files[b].load_order).then_with(|| compare_code_units(&index.files[a].display, &index.files[b].display))
        });
        let results: Vec<Result<FileRecords, BuildError>> = order.par_iter().map(|&i| index_file(&index.files[i], definitions.contains(&i))).collect();
        for (&i, result) in order.iter().zip(results) {
            let records = result?;
            if let Some(reasons) = records.skipped {
                index.record_skipped(i, reasons, &definitions);
                continue;
            }
            if records.table_blocked || records.nesting_blocked {
                index.complete = false;
            }
            let shadowed = index.files[i].shadowed_by.is_some();
            for (kind, id, line, end_line) in records.symbols {
                if index.symbols.len() >= INDEX_RECORD_LIMIT {
                    index.complete = false;
                    index.skipped_possible_kinds.insert(kind);
                    continue;
                }
                index.symbols.push(Symbol { kind, id, file: i as u32, line, end_line, overridden: shadowed, source_shadowed: shadowed });
            }
        }
        index.finalize();
        Ok(index)
    }

    /// `recordSkippedSource`: a shadowed file, or one outside the indexed domains, does not make
    /// the index partial.
    fn record_skipped(&mut self, file: usize, reasons: Vec<String>, definitions: &BTreeSet<usize>) {
        let source = &self.files[file];
        if source.shadowed_by.is_some() || self.skipped_paths.contains(&file) {
            return;
        }
        let kinds = possible_symbol_kinds(source, definitions.contains(&file));
        if kinds.is_empty() {
            return;
        }
        self.skipped_paths.insert(file);
        self.complete = false;
        self.skipped_source_count += 1;
        self.skipped_possible_kinds.extend(kinds.iter().copied());
        if self.skipped_sources.len() < SKIPPED_SOURCE_SAMPLE_LIMIT {
            let mut reason_codes = reasons;
            reason_codes.sort();
            reason_codes.dedup();
            self.skipped_sources.push(SkippedSource { path: source.display.clone(), reason_codes, possible_symbol_kinds: kinds });
        }
    }

    /// `finalize`: the active definition of each kind and id is the one of the highest load order
    /// (then the first display path) whose file is not shadowed; every other one is overridden.
    fn finalize(&mut self) {
        let mut groups: HashMap<(SymbolKind, &str), Vec<usize>> = HashMap::new();
        for (i, symbol) in self.symbols.iter().enumerate() {
            groups.entry((symbol.kind, symbol.id.as_str())).or_default().push(i);
        }
        let mut overridden = vec![false; self.symbols.len()];
        for ((kind, _), mut group) in groups {
            group.sort_by(|&a, &b| {
                let (left, right) = (&self.symbols[a], &self.symbols[b]);
                let (lf, rf) = (&self.files[left.file as usize], &self.files[right.file as usize]);
                rf.load_order.cmp(&lf.load_order).then_with(|| compare_code_units(&lf.display, &rf.display))
            });
            let active = group.iter().copied().find(|&i| !self.symbols[i].source_shadowed);
            for &i in &group {
                let symbol = &self.symbols[i];
                overridden[i] = match active {
                    None => symbol.overridden,
                    Some(_) if kind.is_additive() => symbol.source_shadowed,
                    Some(active) => i != active,
                };
            }
        }
        for (symbol, overridden) in self.symbols.iter_mut().zip(overridden) {
            symbol.overridden = overridden;
        }
    }

    /// The display path of a symbol's file.
    pub fn path(&self, symbol: &Symbol) -> &str {
        &self.files[symbol.file as usize].display
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_paths_follow_node() {
        assert_eq!(posix_join(".", "default.map"), "default.map");
        assert_eq!(posix_join("map", "definition.csv"), "map/definition.csv");
        assert_eq!(posix_join("map", "../x/./y.csv"), "x/y.csv");
        assert_eq!(posix_dirname("default.map"), ".");
        assert_eq!(posix_dirname("map/default.map"), "map");
    }

    #[test]
    fn tables_keep_the_trailing_line_and_stop_at_the_ceiling() {
        let mut lines = Vec::new();
        assert!(table_lines("a\r\nb\rc\n", |row, line| {
            lines.push((row.to_string(), line));
        }));
        assert_eq!(lines, [("a".into(), 1), ("b".into(), 2), ("c".into(), 3), (String::new(), 4)]);
        let rows = "1 2\n".repeat(INDEX_TABLE_RECORD_LIMIT as usize);
        // 100,000 rows and the empty line after the last break: the 100,001st line is the ceiling.
        assert!(!table_lines(&rows, |_, _| {}));
        assert!(table_lines(&rows[..rows.len() - 1], |_, _| {}));
    }

    #[test]
    fn every_kind_name_round_trips() {
        for kind in SymbolKind::ALL {
            assert_eq!(SymbolKind::parse(kind.as_str()), Some(*kind));
        }
        assert_eq!(SymbolKind::ALL.len(), 46);
    }
}

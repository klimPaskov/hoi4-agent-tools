//! One pass over a workspace: parse every loaded file, index definitions, then resolve the
//! checked layer's references and run the lints and the override audit.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::time::Instant;

use hoi4_syntax::{Document, Grammar, LocFile, grammar_for, position_in};
use rayon::prelude::*;
use serde::Serialize;

use crate::context::{self, CommandUse, Ctx, FileFacts, Walker, is_dynamic, is_tag_shaped};
use crate::defs;
use crate::findings::{Finding, Severity, finalize};
use crate::index::{Definition, Kind, SymbolIndex};
use crate::lints;
use crate::overrides;
use crate::vocab::Vocabulary;
use crate::workspace::Workspace;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FlagOp {
    Set,
    Clear,
    Check,
}

#[derive(Clone, Debug)]
pub struct FlagUse {
    pub family: &'static str,
    pub name: String,
    pub op: FlagOp,
    pub file: usize,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug)]
pub struct DlcUse {
    pub name: String,
    pub file: usize,
    pub start: u32,
    pub end: u32,
}

/// Facts from one parsed file.
pub struct Parsed {
    pub file: usize,
    pub definitions: Vec<Definition>,
    pub facts: Option<FileFacts>,
    pub flags: Vec<FlagUse>,
    pub dlc: Vec<DlcUse>,
    pub syntax: Vec<(&'static str, String, u32, u32)>,
    pub line_starts: Vec<u32>,
    pub script: bool,
    pub unreadable: bool,
    /// Calls, outside the checked layer's modelled files, of scripted effects or triggers that
    /// only unloaded files define: `(name, start, end)`.
    pub unloaded_calls: Vec<(String, u32, u32)>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Tally {
    pub resolved: usize,
    pub unresolved: usize,
    pub unknown: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Coverage {
    /// References by target kind, including kinds with no references.
    pub references: BTreeMap<&'static str, Tally>,
    /// Commands in effect and trigger positions.
    pub effect_commands: Tally,
    pub trigger_commands: Tally,
    pub checked_files: usize,
    /// `.txt` script files that can hold effects or triggers.
    pub checked_script_files: usize,
    pub modelled_script_files: usize,
    /// Script files of the checked layer with no context model, by folder. Their references are
    /// not checked, so they are listed instead of counted as passing.
    pub unmodelled_script_folders: BTreeMap<String, usize>,
    /// True when the game's documentation was found; without it every command is unknown.
    pub vocabulary_available: bool,
    /// True when a game layer is loaded; without it a missing name cannot be told from a vanilla one.
    pub game_layer: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Stats {
    pub layers: usize,
    pub files: usize,
    pub loaded_files: usize,
    pub unreadable_files: usize,
    pub definitions: BTreeMap<&'static str, usize>,
    pub elapsed_ms: u128,
}

pub struct Analysis {
    pub workspace: Workspace,
    pub vocab: Vocabulary,
    pub index: SymbolIndex,
    pub dlc_names: BTreeSet<String>,
    pub parsed: Vec<Parsed>,
    parsed_by_file: std::collections::HashMap<usize, usize>,
    pub findings: Vec<Finding>,
    pub coverage: Coverage,
    pub stats: Stats,
    pub overrides: Vec<overrides::OverrideEntry>,
}

/// Folders whose files only list definitions, with no effect or trigger blocks to check.
const DEFINITION_ONLY_FOLDERS: &[&str] = &["common/country_tags/", "common/country_tag_aliases/"];

const FLAG_FAMILIES: &[(&str, &str)] =
    &[("country", "country"), ("global", "global"), ("state", "state"), ("character", "character"), ("unit_leader", "unit_leader"), ("mio", "mio")];

fn flag_command(key: &str) -> Option<(&'static str, FlagOp)> {
    for (suffix, family) in FLAG_FAMILIES {
        let flag = format!("{suffix}_flag");
        if let Some(prefix) = key.strip_suffix(flag.as_str()) {
            let op = match prefix {
                "set_" | "modify_" => FlagOp::Set,
                "clr_" => FlagOp::Clear,
                "has_" => FlagOp::Check,
                _ => return None,
            };
            return Some((family, op));
        }
    }
    None
}

/// Names of scripted effects and triggers defined in files that do not load (replaced by a
/// same-path file or unloaded by `replace_path`).
fn unloaded_scripted_names(ws: &Workspace) -> HashSet<String> {
    let mut names = HashSet::new();
    for (index, file) in ws.files.iter().enumerate() {
        if ws.is_loaded(index) {
            continue;
        }
        let path = file.relative.to_ascii_lowercase();
        if !(path.starts_with("common/scripted_effects/") || path.starts_with("common/scripted_triggers/")) {
            continue;
        }
        let Ok(bytes) = fs::read(&file.absolute) else { continue };
        let doc = Document::parse(bytes);
        names.extend(defs::script_definitions(&doc, &path, index).into_iter().map(|d| d.name));
    }
    names
}

fn parse_file(ws: &Workspace, vocab: &Vocabulary, file: usize, target: Option<usize>, unloaded: &HashSet<String>) -> Parsed {
    let source = &ws.files[file];
    let in_target = Some(source.layer) == target;
    let mut parsed = Parsed {
        file,
        definitions: Vec::new(),
        facts: None,
        flags: Vec::new(),
        dlc: Vec::new(),
        syntax: Vec::new(),
        line_starts: Vec::new(),
        script: false,
        unreadable: false,
        unloaded_calls: Vec::new(),
    };
    let Ok(bytes) = fs::read(&source.absolute) else {
        parsed.unreadable = true;
        return parsed;
    };
    let path = source.relative.to_ascii_lowercase();
    match grammar_for(&path) {
        Some(Grammar::Localisation) => {
            let loc = LocFile::parse(bytes);
            parsed.definitions = defs::localisation_definitions(&loc, file);
            if in_target {
                parsed.line_starts = hoi4_syntax::line_starts(&loc.bytes);
                parsed.syntax = loc.diagnostics.iter().map(|d| (d.code, d.message.clone(), d.start, d.end)).collect();
            }
        }
        Some(Grammar::Script) => {
            parsed.script = true;
            let doc = Document::parse(bytes);
            parsed.definitions = defs::script_definitions(&doc, &path, file);
            let model = context::file_model(&path);
            if let Some(slot) = model {
                let mut walker = Walker::new(&doc, vocab, in_target);
                walker.walk_file(slot);
                parsed.facts = Some(walker.facts);
            }
            // The closure already checks the checked layer's modelled files; everywhere else a
            // call of a scripted effect or trigger that only an unloaded file defines is found by
            // name, whatever the folder.
            let scan_unloaded = !unloaded.is_empty() && !(in_target && model.is_some());
            defs::visit_entries(&doc.root, &mut |entry| {
                let key = doc.key(entry);
                if scan_unloaded && unloaded.contains(key.as_ref()) {
                    let tok = doc.token(entry.key);
                    parsed.unloaded_calls.push((key.to_string(), tok.start, tok.end));
                }
                if let Some((family, op)) = flag_command(&key) {
                    let token = match &entry.value {
                        hoi4_syntax::Value::Scalar(t) => Some(*t),
                        value => value.as_block().and_then(|b| b.entries().find(|e| doc.key(e) == "flag")).and_then(|e| e.value.as_scalar()),
                    };
                    if let Some(t) = token {
                        let tok = doc.token(t);
                        parsed.flags.push(FlagUse { family, name: doc.text(t).into_owned(), op, file, start: tok.start, end: tok.end });
                    }
                } else if in_target
                    && key == "has_dlc"
                    && let Some(t) = entry.value.as_scalar()
                {
                    let tok = doc.token(t);
                    parsed.dlc.push(DlcUse { name: doc.text(t).into_owned(), file, start: tok.start, end: tok.end });
                }
            });
            if in_target {
                parsed.syntax = doc.diagnostics.iter().map(|d| (d.code, d.message.clone(), d.start, d.end)).collect();
            }
            if in_target || !parsed.unloaded_calls.is_empty() {
                parsed.line_starts = doc.line_starts().to_vec();
            }
        }
        None => {}
    }
    parsed
}

/// DLC names the game knows: `dlc_metadata/dlc_info/*.txt` lists every DLC, installed or not,
/// and each installed `.dlc` descriptor names its own.
pub fn known_dlc_names(ws: &Workspace) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = BTreeSet::new();
    let Some(game) = ws.game_root() else { return names };
    names.extend(crate::workspace::dlc_names(game));
    if let Ok(entries) = fs::read_dir(game.join("dlc_metadata").join("dlc_info")) {
        for entry in entries.flatten() {
            let Ok(bytes) = fs::read(entry.path()) else { continue };
            let doc = Document::parse(bytes);
            defs::visit_entries(&doc.root, &mut |e| {
                if doc.key(e) == "name"
                    && let Some(t) = e.value.as_scalar()
                {
                    names.insert(doc.text(t).into_owned());
                }
            });
        }
    }
    names
}

impl Analysis {
    pub fn run(workspace: Workspace, vocab: Vocabulary) -> Analysis {
        let started = Instant::now();
        let target = workspace.target_layer();
        let loaded: Vec<usize> = workspace.loaded_files().map(|(i, _)| i).collect();
        let unloaded = unloaded_scripted_names(&workspace);
        let parsed: Vec<Parsed> = loaded.par_iter().map(|&file| parse_file(&workspace, &vocab, file, target, &unloaded)).collect();

        let mut index = SymbolIndex::default();
        for p in &parsed {
            for d in &p.definitions {
                index.insert(d.clone());
            }
        }
        let dlc_names = known_dlc_names(&workspace);
        let mut analysis = Analysis {
            stats: Stats {
                layers: workspace.layers.len(),
                files: workspace.files.len(),
                loaded_files: loaded.len(),
                unreadable_files: parsed.iter().filter(|p| p.unreadable).count(),
                definitions: index.counts(),
                elapsed_ms: 0,
            },
            workspace,
            vocab,
            index,
            dlc_names,
            parsed_by_file: parsed.iter().enumerate().map(|(i, p)| (p.file, i)).collect(),
            parsed,
            findings: Vec::new(),
            coverage: Coverage::default(),
            overrides: Vec::new(),
        };
        analysis.coverage.vocabulary_available = analysis.vocab.has_commands();
        analysis.coverage.game_layer = analysis.workspace.game_root().is_some();
        for kind in Kind::ALL {
            analysis.coverage.references.insert(kind.as_str(), Tally::default());
        }
        analysis.syntax_findings();
        analysis.resolve_references();
        analysis.resolve_commands();
        lints::run(&mut analysis);
        overrides::run(&mut analysis);
        finalize(&mut analysis.findings);
        analysis.stats.elapsed_ms = started.elapsed().as_millis();
        analysis
    }

    pub fn target_layer(&self) -> Option<usize> {
        self.workspace.target_layer()
    }

    /// Parsed results of files in the checked layer.
    pub fn target_parsed(&self) -> impl Iterator<Item = &Parsed> {
        let target = self.target_layer();
        self.parsed.iter().filter(move |p| Some(self.workspace.files[p.file].layer) == target)
    }

    fn parsed_for(&self, file: usize) -> Option<&Parsed> {
        self.parsed_by_file.get(&file).map(|&i| &self.parsed[i])
    }

    /// Builds a finding located in a file of the workspace.
    pub fn finding(&self, code: &str, severity: Severity, message: impl Into<String>, file: usize, start: u32, end: u32) -> Finding {
        let source = &self.workspace.files[file];
        let mut f = Finding::new(code, severity, message);
        f.path = source.relative.clone();
        f.layer = self.workspace.layers[source.layer].name.clone();
        f.start = start;
        f.end = end;
        if let Some(p) = self.parsed_for(file)
            && !p.line_starts.is_empty()
        {
            let (line, column) = position_in(&p.line_starts, start);
            f.line = line;
            f.column = column;
        }
        f
    }

    fn syntax_findings(&mut self) {
        let mut out = Vec::new();
        let mut coverage = std::mem::take(&mut self.coverage);
        for p in self.target_parsed() {
            coverage.checked_files += 1;
            let relative = self.workspace.files[p.file].relative.to_ascii_lowercase();
            let needs_model = relative.ends_with(".txt") && !DEFINITION_ONLY_FOLDERS.iter().any(|f| relative.starts_with(f));
            if p.script && needs_model {
                coverage.checked_script_files += 1;
                if p.facts.as_ref().is_some_and(|f| f.modelled) {
                    coverage.modelled_script_files += 1;
                } else {
                    let folder = self.workspace.files[p.file].folder().to_string();
                    *coverage.unmodelled_script_folders.entry(folder).or_default() += 1;
                }
            }
            for (code, message, start, end) in &p.syntax {
                let severity = if code.starts_with("LOC_") { Severity::Warning } else { Severity::Error };
                out.push(self.finding(code, severity, message.clone(), p.file, *start, *end));
            }
        }
        self.coverage = coverage;
        self.findings.extend(out);
    }

    fn resolve_references(&mut self) {
        let mut out = Vec::new();
        let mut tallies: BTreeMap<&'static str, Tally> = BTreeMap::new();
        let game_layer = self.coverage.game_layer;
        for p in self.target_parsed() {
            let Some(facts) = &p.facts else { continue };
            for r in &facts.references {
                let tally = tallies.entry(r.kind.as_str()).or_default();
                if is_dynamic(&r.name) || r.name.contains(':') {
                    tally.unknown += 1;
                    continue;
                }
                if self.index.contains(r.kind, &r.name) {
                    tally.resolved += 1;
                    continue;
                }
                if !game_layer {
                    tally.unknown += 1;
                    continue;
                }
                if self.index.contains_folded(r.kind, &r.name) {
                    // Defined with other letter case. Whether the game matches it depends on the
                    // kind, so this is a warning, not a missing definition.
                    tally.resolved += 1;
                    let mut f = self.finding(
                        "REF_CASE_MISMATCH",
                        Severity::Warning,
                        format!("{} `{}` is defined only with different letter case", r.kind.as_str().replace('_', " "), r.name),
                        p.file,
                        r.start,
                        r.end,
                    );
                    f.subject = Some(r.name.clone());
                    f.context = r.context.clone();
                    f.suggestion = self.index.suggest(r.kind, &r.name);
                    out.push(f);
                    continue;
                }
                tally.unresolved += 1;
                let code = format!("REF_MISSING_{}", r.kind.as_str().to_ascii_uppercase());
                let mut f = self.finding(
                    &code,
                    Severity::Error,
                    format!("{} `{}` (from `{}`) is not defined in any loaded file", r.kind.as_str().replace('_', " "), r.name, r.via),
                    p.file,
                    r.start,
                    r.end,
                );
                f.subject = Some(r.name.clone());
                f.context = r.context.clone();
                f.suggestion = self.index.suggest(r.kind, &r.name);
                out.push(f);
            }
        }
        for (kind, tally) in tallies {
            self.coverage.references.insert(kind, tally);
        }
        self.findings.extend(out);
    }

    fn resolve_commands(&mut self) {
        let mut out = Vec::new();
        let vocabulary = self.coverage.vocabulary_available;
        let mut effect = Tally::default();
        let mut trigger = Tally::default();
        let mut scope_refs: Vec<(Kind, bool)> = Vec::new();
        for p in self.target_parsed() {
            let Some(facts) = &p.facts else { continue };
            for c in &facts.commands {
                let tally = match c.ctx {
                    Ctx::Effect => &mut effect,
                    Ctx::Trigger => &mut trigger,
                };
                match self.classify_command(c) {
                    CommandClass::Resolved(kind) => {
                        tally.resolved += 1;
                        if let Some(kind) = kind {
                            scope_refs.push((kind, true));
                        }
                    }
                    CommandClass::Unknown => tally.unknown += 1,
                    CommandClass::MissingScope(kind) => {
                        tally.resolved += 1;
                        scope_refs.push((kind, false));
                        let code = format!("REF_MISSING_{}", kind.as_str().to_ascii_uppercase());
                        let mut f = self.finding(
                            &code,
                            Severity::Error,
                            format!("{} `{}` is used as a scope but is not defined", kind.as_str().replace('_', " "), c.key),
                            p.file,
                            c.start,
                            c.end,
                        );
                        f.subject = Some(c.key.clone());
                        f.context = c.context.clone();
                        f.suggestion = self.index.suggest(kind, &c.key);
                        out.push(f);
                    }
                    CommandClass::Unresolved => {
                        if !vocabulary {
                            tally.unknown += 1;
                            continue;
                        }
                        tally.unresolved += 1;
                        out.push(self.unknown_command_finding(p.file, c));
                    }
                }
            }
        }
        for p in self.target_parsed() {
            if let Some(facts) = &p.facts {
                // Control words, scope switches and documented commands resolve without the index.
                for (tally, counts) in [(&mut effect, &facts.counts[0]), (&mut trigger, &facts.counts[1])] {
                    tally.resolved += counts.documented + counts.control + counts.scope;
                    tally.unknown += counts.unknown;
                }
            }
        }
        for (kind, found) in scope_refs {
            let tally = self.coverage.references.entry(kind.as_str()).or_default();
            if found {
                tally.resolved += 1;
            } else {
                tally.unresolved += 1;
            }
        }
        self.coverage.effect_commands = effect;
        self.coverage.trigger_commands = trigger;
        self.findings.extend(out);
    }

    fn classify_command(&self, c: &CommandUse) -> CommandClass {
        let scripted = match c.ctx {
            Ctx::Effect => Kind::ScriptedEffect,
            Ctx::Trigger => Kind::ScriptedTrigger,
        };
        if self.index.contains(scripted, &c.key) || self.index.contains_folded(scripted, &c.key) {
            return CommandClass::Resolved(Some(scripted));
        }
        if is_tag_shaped(&c.key) {
            if self.index.contains(Kind::CountryTag, &c.key) {
                return CommandClass::Resolved(Some(Kind::CountryTag));
            }
            if !self.coverage.game_layer {
                return CommandClass::Unknown;
            }
            if c.has_block {
                return CommandClass::MissingScope(Kind::CountryTag);
            }
        }
        if !c.key.is_empty() && c.key.bytes().all(|b| b.is_ascii_digit()) {
            if self.index.contains(Kind::State, &c.key) {
                return CommandClass::Resolved(Some(Kind::State));
            }
            // A number that is not a state can be a province (`supply_node` in a state scope).
            return CommandClass::Unknown;
        }
        if self.index.contains(Kind::Character, &c.key) {
            return CommandClass::Resolved(Some(Kind::Character));
        }
        if !self.coverage.game_layer && !self.index.contains(scripted, &c.key) {
            // Without the game, a scripted effect or trigger may come from vanilla.
            return CommandClass::Unknown;
        }
        CommandClass::Unresolved
    }

    fn unknown_command_finding(&self, file: usize, c: &CommandUse) -> Finding {
        let (code, what, other_kind, other_doc) = match c.ctx {
            Ctx::Effect => ("REF_UNKNOWN_EFFECT", "effect", Kind::ScriptedTrigger, self.vocab.triggers.contains_key(&c.key)),
            Ctx::Trigger => ("REF_UNKNOWN_TRIGGER", "trigger", Kind::ScriptedEffect, self.vocab.effects.contains_key(&c.key)),
        };
        let mut message = format!("`{}` is neither a documented {what} nor a scripted {what} defined in any loaded file", c.key);
        if other_doc || self.index.contains(other_kind, &c.key) {
            let other = if c.ctx == Ctx::Effect { "trigger" } else { "effect" };
            message.push_str(&format!("; it is a {other}, used where {what}s are expected"));
        }
        let mut f = self.finding(code, Severity::Error, message, file, c.start, c.end);
        f.subject = Some(c.key.clone());
        f.context = c.context.clone();
        let scripted = if c.ctx == Ctx::Effect { Kind::ScriptedEffect } else { Kind::ScriptedTrigger };
        f.suggestion = self.index.suggest(scripted, &c.key).or_else(|| {
            let documented: Vec<&String> = match c.ctx {
                Ctx::Effect => self.vocab.effects.keys().collect(),
                Ctx::Trigger => self.vocab.triggers.keys().collect(),
            };
            suggest_from(&c.key, documented)
        });
        f
    }

    pub fn verdict(&self) -> &'static str {
        let unresolved = self.findings.iter().any(|f| f.severity == Severity::Error);
        let unknown = self.coverage.references.values().any(|t| t.unknown > 0)
            || self.coverage.effect_commands.unknown > 0
            || self.coverage.trigger_commands.unknown > 0
            || !self.coverage.unmodelled_script_folders.is_empty()
            || !self.coverage.vocabulary_available
            || !self.coverage.game_layer;
        if unresolved {
            "fail"
        } else if unknown {
            "incomplete"
        } else {
            "pass"
        }
    }
}

enum CommandClass {
    Resolved(Option<Kind>),
    MissingScope(Kind),
    Unresolved,
    Unknown,
}

/// The single candidate one edit away, or a case-insensitive match.
pub fn suggest_from<'a>(name: &str, candidates: impl IntoIterator<Item = &'a String>) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let target: Vec<char> = name.chars().collect();
    let mut found = None;
    for candidate in candidates {
        if candidate.to_ascii_lowercase() == lower {
            return Some(candidate.clone());
        }
        if target.len() >= 4 && crate::index::within_one_edit(name, candidate) {
            if found.is_some() {
                return None;
            }
            found = Some(candidate.clone());
        }
    }
    found
}

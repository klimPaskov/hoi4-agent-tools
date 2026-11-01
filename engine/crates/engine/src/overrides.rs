//! Override and load-order audit (proposal P3).
//!
//! * A checked-layer file at the same path as an earlier file replaces it whole. Definitions and
//!   `on_actions` hooks the earlier file had, that the copy lacks and that no other loaded file
//!   provides, are dropped (`OVERRIDE_DROPS_DEFINITION`, `OVERRIDE_DROPS_ON_ACTION_HOOK`).
//! * A path that differs from the replaced file only in letter case replaces it on Windows but
//!   loads beside it on Linux and macOS (`OVERRIDE_CASE_ONLY_SHADOW`).
//! * A `replace_path` unloads every earlier file directly in that folder. With no file of its own
//!   there the folder is empty (`OVERRIDE_REPLACE_PATH_EMPTY`); otherwise the unloaded
//!   definitions nothing else provides are counted (`OVERRIDE_REPLACE_PATH_DROPS`).
//! * Every replaced file is listed with the layer that wins (`OVERRIDE_REPLACES_FILE`, info).
//! * A file that still loads, in any layer, and calls a scripted effect or trigger that only an
//!   unloaded file defined now fails in the game ("Unknown trigger-type", "Unknown effect-type")
//!   (`OVERRIDE_BREAKS_REFERENCE`). This is how a total conversion's `replace_path` breaks the
//!   game's own files that it left loaded.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use hoi4_syntax::Document;
use serde::Serialize;

use crate::analysis::Analysis;
use crate::context::{self, Walker};
use crate::defs;
use crate::findings::{Finding, Severity};
use crate::index::Kind;
use crate::workspace::Hidden;

#[derive(Clone, Debug, Serialize)]
pub struct OverrideEntry {
    pub path: String,
    pub winner: String,
    pub replaced: Vec<String>,
}

struct Unit {
    definitions: BTreeSet<(Kind, String)>,
    hooks: Vec<(String, String)>,
}

fn read_unit(analysis: &Analysis, file: usize) -> Option<Unit> {
    let source = &analysis.workspace.files[file];
    let path = source.relative.to_ascii_lowercase();
    if hoi4_syntax::grammar_for(&path) != Some(hoi4_syntax::Grammar::Script) {
        return None;
    }
    let bytes = fs::read(&source.absolute).ok()?;
    let doc = Document::parse(bytes);
    let definitions = defs::script_definitions(&doc, &path, file).into_iter().map(|d| (d.kind, d.name)).collect();
    let mut hooks = Vec::new();
    if let Some(slot) = context::file_model(&path) {
        let mut walker = Walker::new(&doc, &analysis.vocab, false);
        walker.walk_file(slot);
        hooks = walker.facts.hooks.into_iter().map(|(on_action, hook, _)| (on_action, hook)).collect();
    }
    Some(Unit { definitions, hooks })
}

fn describe_unloading(analysis: &Analysis, name: &str, defined_in: &BTreeMap<&str, (usize, &Hidden)>) -> String {
    for (relative, (index, hidden)) in defined_in {
        let Some(unit) = read_unit(analysis, *index) else { continue };
        if !unit.definitions.iter().any(|(_, n)| n == name) {
            continue;
        }
        let owner = &analysis.workspace.layers[analysis.workspace.files[*index].layer].name;
        return match hidden {
            Hidden::ReplacePath { by_layer, path } => {
                format!("its definition in {owner}:{relative} is unloaded by {}'s replace_path \"{path}\"", analysis.workspace.layers[*by_layer].name)
            }
            Hidden::Overridden { by } => {
                let winner = &analysis.workspace.files[*by];
                format!("its definition in {owner}:{relative} is replaced by {}:{} without it", analysis.workspace.layers[winner.layer].name, winner.relative)
            }
        };
    }
    "its only definition is in a file that no longer loads".to_string()
}

pub fn run(analysis: &mut Analysis) {
    let Some(target) = analysis.target_layer() else { return };
    let mut findings = Vec::new();
    let mut entries = Vec::new();

    // Hooks provided by loaded files, for "is it hooked somewhere else".
    let mut loaded_hooks: BTreeMap<(String, String), usize> = BTreeMap::new();
    for p in &analysis.parsed {
        for (on_action, hook, _) in p.facts.iter().flat_map(|f| f.hooks.iter()) {
            *loaded_hooks.entry((on_action.clone(), hook.clone())).or_default() += 1;
        }
    }

    // Same-path replacements made by the checked layer.
    let mut replaced_by: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (index, hidden) in analysis.workspace.hidden.iter().enumerate() {
        if let Some(Hidden::Overridden { by }) = hidden {
            // Follow the chain to the loaded file.
            let mut winner = *by;
            while let Some(Hidden::Overridden { by }) = &analysis.workspace.hidden[winner] {
                winner = *by;
            }
            replaced_by.entry(winner).or_default().push(index);
        }
    }
    for (winner, replaced) in &replaced_by {
        let source = &analysis.workspace.files[*winner];
        if source.layer != target {
            continue;
        }
        entries.push(OverrideEntry {
            path: source.relative.clone(),
            winner: analysis.workspace.layers[source.layer].name.clone(),
            replaced: replaced
                .iter()
                .map(|r| format!("{}:{}", analysis.workspace.layers[analysis.workspace.files[*r].layer].name, analysis.workspace.files[*r].relative))
                .collect(),
        });
        let mine = read_unit(analysis, *winner);
        for &old in replaced {
            let base = &analysis.workspace.files[old];
            let base_layer = analysis.workspace.layers[base.layer].name.clone();
            let mut info = analysis.finding(
                "OVERRIDE_REPLACES_FILE",
                Severity::Info,
                format!("this file replaces {base_layer}:{} entirely", base.relative),
                *winner,
                0,
                0,
            );
            info.subject = Some(format!("{base_layer}:{}", base.relative));
            findings.push(info);
            if base.relative != source.relative {
                let mut f = analysis.finding(
                    "OVERRIDE_CASE_ONLY_SHADOW",
                    Severity::Warning,
                    format!(
                        "this path differs from {base_layer}:{} only in letter case: it replaces that file on Windows but both load on Linux and macOS",
                        base.relative
                    ),
                    *winner,
                    0,
                    0,
                );
                f.subject = Some(base.relative.clone());
                findings.push(f);
            }
            let (Some(old_unit), Some(new_unit)) = (read_unit(analysis, old), mine.as_ref()) else { continue };
            let dropped: Vec<_> = old_unit
                .definitions
                .iter()
                .filter(|(kind, name)| !new_unit.definitions.contains(&(*kind, name.clone())) && !analysis.index.contains(*kind, name))
                .collect();
            for (kind, name) in dropped {
                let mut f = analysis.finding(
                    "OVERRIDE_DROPS_DEFINITION",
                    Severity::Warning,
                    format!(
                        "{} `{name}` from {base_layer}:{} is missing from this copy and no other loaded file defines it",
                        kind.as_str().replace('_', " "),
                        base.relative
                    ),
                    *winner,
                    0,
                    0,
                );
                f.subject = Some(format!("{}:{name}", kind.as_str()));
                findings.push(f);
            }
            let new_hooks: BTreeSet<_> = new_unit.hooks.iter().collect();
            let mut reported = BTreeSet::new();
            for hook in &old_unit.hooks {
                if new_hooks.contains(hook) || loaded_hooks.contains_key(hook) || !reported.insert(hook.clone()) {
                    continue;
                }
                let (on_action, value) = hook;
                let what = match value.split_once(':') {
                    Some(("events", id)) => format!("event `{id}`"),
                    Some(("random_events", id)) => format!("random event `{id}`"),
                    _ => "an effect block".to_string(),
                };
                let mut f = analysis.finding(
                    "OVERRIDE_DROPS_ON_ACTION_HOOK",
                    Severity::Warning,
                    format!("`{on_action}` in {base_layer}:{} runs {what}, which this copy no longer hooks and no other loaded file hooks", base.relative),
                    *winner,
                    0,
                    0,
                );
                f.subject = Some(format!("{on_action}:{value}"));
                f.context = Some(format!("on_action:{on_action}"));
                findings.push(f);
            }
        }
    }

    // replace_path declared by the checked layer.
    let layer = &analysis.workspace.layers[target];
    for replace in &layer.replace_paths {
        let folder = replace.to_ascii_lowercase();
        let unloaded: Vec<usize> = analysis
            .workspace
            .hidden
            .iter()
            .enumerate()
            .filter(|(_, h)| matches!(h, Some(Hidden::ReplacePath { by_layer, path }) if *by_layer == target && path.eq_ignore_ascii_case(replace)))
            .map(|(i, _)| i)
            .collect();
        let own = analysis.workspace.files.iter().any(|f| f.layer == target && f.folder().to_ascii_lowercase() == folder);
        let mut lost = 0usize;
        for &file in &unloaded {
            if let Some(unit) = read_unit(analysis, file) {
                lost += unit.definitions.iter().filter(|(kind, name)| !analysis.index.contains(*kind, name)).count();
            }
        }
        // The finding belongs to the descriptor, which is not a game source file.
        let descriptor_finding = |code: &str, severity: Severity, message: String| {
            let mut f = Finding::new(code, severity, message);
            f.path = "descriptor.mod".into();
            f.layer = layer.name.clone();
            f.subject = Some(replace.clone());
            f
        };
        if !own && !unloaded.is_empty() {
            findings.push(descriptor_finding(
                "OVERRIDE_REPLACE_PATH_EMPTY",
                Severity::Error,
                format!(
                    "replace_path \"{replace}\" unloads {} earlier file(s) and the mod has no file of its own there, so the folder loads empty",
                    unloaded.len()
                ),
            ));
        } else if lost > 0 {
            findings.push(descriptor_finding(
                "OVERRIDE_REPLACE_PATH_DROPS",
                Severity::Info,
                format!(
                    "replace_path \"{replace}\" unloads {} earlier file(s); {lost} of their definitions are not provided by any loaded file",
                    unloaded.len()
                ),
            ));
        }
    }

    // Calls whose only definitions were unloaded.
    let mut defined_in: BTreeMap<&str, (usize, &Hidden)> = BTreeMap::new();
    for (index, hidden) in analysis.workspace.hidden.iter().enumerate() {
        let Some(hidden) = hidden else { continue };
        let file = &analysis.workspace.files[index];
        let path = file.relative.to_ascii_lowercase();
        if path.starts_with("common/scripted_effects/") || path.starts_with("common/scripted_triggers/") {
            defined_in.entry(file.relative.as_str()).or_insert((index, hidden));
        }
    }
    for p in &analysis.parsed {
        for (name, start, end) in &p.unloaded_calls {
            if analysis.index.contains(Kind::ScriptedEffect, name) || analysis.index.contains(Kind::ScriptedTrigger, name) {
                continue;
            }
            let why = describe_unloading(analysis, name, &defined_in);
            let mut f = analysis.finding(
                "OVERRIDE_BREAKS_REFERENCE",
                Severity::Error,
                format!("`{name}` is called here, but {why}, so the game reports it as unknown"),
                p.file,
                *start,
                *end,
            );
            f.subject = Some(name.clone());
            findings.push(f);
        }
    }

    for f in &mut findings {
        if f.line == 0 && f.path != "descriptor.mod" {
            f.line = 1;
            f.column = 1;
        }
    }
    analysis.findings.extend(findings);
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    analysis.overrides = entries;
}

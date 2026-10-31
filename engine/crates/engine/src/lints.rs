//! Lints (proposal P2 and the harvested Hagane rules). Each lint reports only in files of the
//! checked layer, and reads facts from every loaded layer so that a mod's use of vanilla content
//! is judged against vanilla.
//!
//! | Code | Rule |
//! |---|---|
//! | `LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL` | Focus A lists B as mutually exclusive but B does not list A |
//! | `LINT_EVENT_NAMESPACE_COLLISION` | The mod declares an event namespace the game already declares in another file |
//! | `LINT_INERT_MTTH` | A triggered-only event has a `mean_time_to_happen` timer, which never runs |
//! | `LINT_EVENT_LOC_KEY_REUSED` | One event uses the same localisation key for two texts |
//! | `LINT_UNKNOWN_MODIFIER` | A modifier block uses a key the game does not document |
//! | `LINT_FLAG_NEVER_SET` | A flag is checked but no loaded file ever sets it (Hagane dead-flag rule) |
//! | `LINT_FLAG_NEVER_CHECKED` | A flag is set but no loaded file ever checks it (Hagane dead-flag rule) |
//! | `LINT_UNKNOWN_DLC` | `has_dlc` names a DLC the game does not know (Hagane DLC rule) |
//! | `LINT_DUPLICATE_DEFINITION` | The checked layer defines the same event, scripted effect or scripted trigger twice |

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::analysis::{Analysis, FlagOp, suggest_from};
use crate::findings::Severity;
use crate::index::Kind;
use crate::workspace::LayerKind;

pub const LINT_CODES: &[&str] = &[
    "LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL",
    "LINT_EVENT_NAMESPACE_COLLISION",
    "LINT_INERT_MTTH",
    "LINT_EVENT_LOC_KEY_REUSED",
    "LINT_UNKNOWN_MODIFIER",
    "LINT_FLAG_NEVER_SET",
    "LINT_FLAG_NEVER_CHECKED",
    "LINT_UNKNOWN_DLC",
    "LINT_DUPLICATE_DEFINITION",
];

pub fn run(analysis: &mut Analysis) {
    mutually_exclusive(analysis);
    namespaces(analysis);
    events(analysis);
    modifiers(analysis);
    flags(analysis);
    dlc(analysis);
    duplicates(analysis);
}

fn mutually_exclusive(analysis: &mut Analysis) {
    let target = analysis.target_layer();
    let mut exclusive: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    for p in &analysis.parsed {
        for focus in p.facts.iter().flat_map(|f| f.focuses.iter()) {
            exclusive.entry(focus.id.as_str()).or_default().extend(focus.exclusive.iter().map(|(other, _)| other.as_str()));
        }
    }
    let mut out = Vec::new();
    for p in &analysis.parsed {
        if Some(analysis.workspace.files[p.file].layer) != target {
            continue;
        }
        for focus in p.facts.iter().flat_map(|f| f.focuses.iter()) {
            for (other, at) in &focus.exclusive {
                // A missing target is a reference finding, not a symmetry finding.
                let Some(back) = exclusive.get(other.as_str()) else { continue };
                if !back.contains(focus.id.as_str()) {
                    let mut f = analysis.finding(
                        "LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL",
                        Severity::Warning,
                        format!("focus `{}` is mutually exclusive with `{other}`, but `{other}` does not list `{}`", focus.id, focus.id),
                        p.file,
                        *at,
                        *at + other.len() as u32,
                    );
                    f.subject = Some(other.clone());
                    f.context = Some(format!("focus:{}", focus.id));
                    out.push(f);
                }
            }
        }
    }
    analysis.findings.extend(out);
}

fn namespaces(analysis: &mut Analysis) {
    let Some(target) = analysis.target_layer() else { return };
    if analysis.workspace.layers[target].kind == LayerKind::Game {
        return;
    }
    let mut out = Vec::new();
    for (name, defs) in analysis.index.definitions(Kind::EventNamespace) {
        let layer_of = |file: usize| analysis.workspace.files[file].layer;
        let base: Vec<_> = defs.iter().filter(|d| matches!(analysis.workspace.layers[layer_of(d.file)].kind, LayerKind::Game | LayerKind::Dlc)).collect();
        if base.is_empty() {
            continue;
        }
        for d in defs.iter().filter(|d| layer_of(d.file) == target) {
            // A mod file at the same path as the game's file replaces it, so reusing the namespace there is intended.
            let same_path = base.iter().any(|b| analysis.workspace.files[b.file].key() == analysis.workspace.files[d.file].key());
            if same_path {
                continue;
            }
            let base_path = &analysis.workspace.files[base[0].file].relative;
            let mut f = analysis.finding(
                "LINT_EVENT_NAMESPACE_COLLISION",
                Severity::Warning,
                format!("event namespace `{name}` is also declared by the game in {base_path}; use a namespace unique to the mod"),
                d.file,
                d.start,
                d.start + name.len() as u32,
            );
            f.subject = Some(name.clone());
            out.push(f);
        }
    }
    analysis.findings.extend(out);
}

fn events(analysis: &mut Analysis) {
    let mut out = Vec::new();
    for p in analysis.target_parsed() {
        for event in p.facts.iter().flat_map(|f| f.events.iter()) {
            let context = event.id.as_ref().map(|id| format!("event:{id}"));
            if event.triggered_only
                && let Some(at) = event.mtth
            {
                let mut f = analysis.finding(
                    "LINT_INERT_MTTH",
                    Severity::Warning,
                    "the event is `is_triggered_only = yes`, so its `mean_time_to_happen` timer never runs; it fires only when called",
                    p.file,
                    at,
                    at + "mean_time_to_happen".len() as u32,
                );
                f.subject = event.id.clone();
                f.context = context.clone();
                out.push(f);
            }
            // Options that share a key are fine when each has its own trigger (only one shows);
            // a key shared between the title, the description and an option, or by options
            // that always show together, is a collision.
            let mut seen: BTreeMap<&str, (&str, bool)> = BTreeMap::new();
            for (key, role, at, conditional) in &event.loc_keys {
                match seen.get(key.as_str()) {
                    Some((first_role, first_conditional)) => {
                        let both_options = *first_role == "option" && *role == "option";
                        if both_options && (*first_conditional || *conditional) {
                            continue;
                        }
                        let mut f = analysis.finding(
                            "LINT_EVENT_LOC_KEY_REUSED",
                            Severity::Warning,
                            format!("localisation key `{key}` is used for the event {first_role} and again for an {role}"),
                            p.file,
                            *at,
                            *at + key.len() as u32,
                        );
                        f.subject = Some(key.clone());
                        f.context = context.clone();
                        out.push(f);
                    }
                    None => {
                        seen.insert(key, (role, *conditional));
                    }
                }
            }
        }
    }
    analysis.findings.extend(out);
}

/// Modifier families the game builds from definitions but `modifiers_documentation.md` does not
/// list, for example `production_speed_arms_factory_factor` from the `arms_factory` building.
/// Each family is used by vanilla 1.19.3.0 with names built from the named definition kind.
const DERIVED_MODIFIERS: &[(&str, Kind, &str)] = &[
    ("production_speed_", Kind::Building, "_factor"),
    ("repair_speed_", Kind::Building, "_factor"),
    ("production_cost_max_", Kind::Equipment, ""),
    ("country_resource_", Kind::Resource, ""),
    ("local_resources_", Kind::Resource, "_factor"),
    ("unit_", Kind::SubUnit, "_design_cost_factor"),
    ("experience_gain_", Kind::SubUnit, "_combat_factor"),
    ("experience_gain_", Kind::SubUnit, "_training_factor"),
    ("trait_", Kind::UnitLeaderTrait, "_xp_gain_factor"),
    // The documentation lists these templates with the game's own types only; a mod that adds
    // a tactic, sub-unit or building gets the same modifiers for it.
    ("", Kind::CombatTactic, "_preferred_weight_factor"),
    ("modifier_army_sub_unit_", Kind::SubUnit, "_attack_factor"),
    ("modifier_army_sub_unit_", Kind::SubUnit, "_defence_factor"),
    ("modifier_army_sub_unit_", Kind::SubUnit, "_speed_factor"),
    ("", Kind::Building, "_max_level_terrain_limit"),
    ("", Kind::Equipment, "_design_cost_factor"),
    ("", Kind::Ideology, "_drift"),
    ("", Kind::Ideology, "_acceptance"),
];

fn derived_modifier(analysis: &Analysis, key: &str) -> bool {
    DERIVED_MODIFIERS.iter().any(|(prefix, kind, suffix)| {
        key.strip_prefix(prefix).and_then(|rest| rest.strip_suffix(suffix)).is_some_and(|name| !name.is_empty() && analysis.index.contains(*kind, name))
    })
}

fn modifiers(analysis: &mut Analysis) {
    if !analysis.vocab.has_modifiers() {
        return;
    }
    let mut out = Vec::new();
    for p in analysis.target_parsed() {
        for m in p.facts.iter().flat_map(|f| f.modifiers.iter()) {
            if analysis.vocab.modifiers.contains(&m.key.to_ascii_lowercase()) || crate::context::is_dynamic(&m.key) || derived_modifier(analysis, &m.key) {
                continue;
            }
            // Static and dynamic modifiers can nest another modifier's name in some blocks.
            if analysis.index.contains(Kind::StaticModifier, &m.key) {
                continue;
            }
            let mut f = analysis.finding(
                "LINT_UNKNOWN_MODIFIER",
                Severity::Warning,
                format!("`{}` is not a modifier listed in the game's modifiers_documentation.md", m.key),
                p.file,
                m.start,
                m.end,
            );
            f.subject = Some(m.key.clone());
            f.context = m.context.clone();
            f.suggestion = suggest_from(&m.key, analysis.vocab.modifiers.iter());
            out.push(f);
        }
    }
    analysis.findings.extend(out);
}

/// Provenance: the dead-flag rule of Hagane Studio, `internal/domains/focus/lint.go`
/// (hagane-works/hagane-studio at 1e831623ed162e1a64763c242c55b249376ba20c, GPL-3.0-only), adapted
/// under the copyright holder's written permission to the maintainer (decision D-05). See
/// `engine/PROVENANCE.md`.
fn flags(analysis: &mut Analysis) {
    let target = analysis.target_layer();
    let mut set: BTreeSet<(&str, &str)> = BTreeSet::new();
    let mut checked: BTreeSet<(&str, &str)> = BTreeSet::new();
    let mut dynamic_setters: Vec<(&str, String)> = Vec::new();
    let mut dynamic_checks: Vec<(&str, String)> = Vec::new();
    for p in &analysis.parsed {
        for flag in &p.flags {
            let dynamic = crate::context::is_dynamic(&flag.name);
            let stem = || flag.name.split(['@', '[', '$', '?', '^']).next().unwrap_or_default().to_string();
            match (flag.op, dynamic) {
                (FlagOp::Set, false) => {
                    set.insert((flag.family, &flag.name));
                }
                (FlagOp::Set, true) => dynamic_setters.push((flag.family, stem())),
                (FlagOp::Check, false) => {
                    checked.insert((flag.family, &flag.name));
                }
                (FlagOp::Check, true) => dynamic_checks.push((flag.family, stem())),
                (FlagOp::Clear, _) => {}
            }
        }
    }
    let covered_by = |dynamic: &[(&str, String)], family: &str, name: &str| {
        dynamic.iter().any(|(f, stem)| *f == family && !stem.is_empty() && name.starts_with(stem.as_str()))
    };
    let mut out = Vec::new();
    let mut reported: BTreeSet<(usize, &str, &str, FlagOp)> = BTreeSet::new();
    for p in &analysis.parsed {
        if Some(analysis.workspace.files[p.file].layer) != target {
            continue;
        }
        for flag in &p.flags {
            if crate::context::is_dynamic(&flag.name) {
                continue;
            }
            let key = (flag.family, flag.name.as_str());
            let (code, severity, message) = match flag.op {
                FlagOp::Check if !set.contains(&key) && !covered_by(&dynamic_setters, flag.family, &flag.name) => (
                    "LINT_FLAG_NEVER_SET",
                    Severity::Warning,
                    format!("{} flag `{}` is checked but no loaded file sets it, so the check is always false", flag.family, flag.name),
                ),
                FlagOp::Set if !checked.contains(&key) && !covered_by(&dynamic_checks, flag.family, &flag.name) => {
                    ("LINT_FLAG_NEVER_CHECKED", Severity::Info, format!("{} flag `{}` is set but no loaded file checks it", flag.family, flag.name))
                }
                _ => continue,
            };
            // One finding per flag and file.
            if !reported.insert((p.file, flag.family, &flag.name, flag.op)) {
                continue;
            }
            let mut f = analysis.finding(code, severity, message, p.file, flag.start, flag.end);
            f.subject = Some(format!("{}:{}", flag.family, flag.name));
            out.push(f);
        }
    }
    analysis.findings.extend(out);
}

/// Provenance: the DLC rule of Hagane Studio, `internal/hoi4/exportengine/dlc_conditional_lint.go`
/// (hagane-works/hagane-studio at 1e831623ed162e1a64763c242c55b249376ba20c, GPL-3.0-only), adapted
/// under the copyright holder's written permission to the maintainer (decision D-05). See
/// `engine/PROVENANCE.md`.
fn dlc(analysis: &mut Analysis) {
    if analysis.dlc_names.is_empty() {
        return;
    }
    let mut out = Vec::new();
    for p in analysis.target_parsed() {
        for use_ in &p.dlc {
            if analysis.dlc_names.contains(&use_.name) {
                continue;
            }
            let mut f = analysis.finding(
                "LINT_UNKNOWN_DLC",
                Severity::Error,
                format!("`has_dlc = \"{}\"` names no DLC the game knows, so it is always false", use_.name),
                p.file,
                use_.start,
                use_.end,
            );
            f.subject = Some(use_.name.clone());
            f.suggestion = analysis
                .dlc_names
                .iter()
                .map(|n| (crate::index::levenshtein(&n.to_lowercase().chars().collect::<Vec<_>>(), &use_.name.to_lowercase().chars().collect::<Vec<_>>()), n))
                .filter(|(d, _)| *d <= 3)
                .min()
                .map(|(_, n)| n.clone());
            out.push(f);
        }
    }
    analysis.findings.extend(out);
}

fn duplicates(analysis: &mut Analysis) {
    let Some(target) = analysis.target_layer() else { return };
    let mut out = Vec::new();
    for kind in [Kind::Event, Kind::ScriptedEffect, Kind::ScriptedTrigger] {
        for (name, defs) in analysis.index.definitions(kind) {
            let mine: Vec<_> = defs.iter().filter(|d| analysis.workspace.files[d.file].layer == target).collect();
            if mine.len() < 2 {
                continue;
            }
            for d in &mine[1..] {
                let first = &analysis.workspace.files[mine[0].file].relative;
                let mut f = analysis.finding(
                    "LINT_DUPLICATE_DEFINITION",
                    Severity::Error,
                    format!("{} `{name}` is defined again; the first definition is in {first} line {}", kind.as_str().replace('_', " "), mine[0].line),
                    d.file,
                    d.start,
                    d.start + name.len() as u32,
                );
                f.subject = Some(name.clone());
                out.push(f);
            }
        }
    }
    analysis.findings.extend(out);
}

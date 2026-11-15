//! The semantic references of the TypeScript core: the typed script edges of events, focuses,
//! decisions, ideas, technologies, scripted effects and triggers, scripted GUIs and on-actions.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/impact-semantic.ts`
//! (`scanImpactSemanticReferences`, `ownerFor`, `staticTarget`, `stateKeyTarget`) at commit
//! `20fdb4a`, with `includeOnActions` on, as `hoi4.source_lookup` called it. The scan keeps only
//! the references to one target symbol, because a lookup asks for those alone, but it counts every
//! reference and every unresolved one, so the answer's ceilings and `unresolvedReferenceCount`
//! are the whole scan's, as in TypeScript.
//!
//! Not carried over: the unresolved references' locations and reasons (a lookup reports their
//! number only) and the retained-reference list of other targets.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use rayon::prelude::*;

use super::reader::{Block, Value, decode, parse_clausewitz};
use super::walk::Collect;
use super::{BuildError, Reference, References, SymbolIndex, SymbolKind as K, compare_code_units, lower_path, read};

/// `IMPACT_SEMANTIC_MAX_REFERENCES`.
pub const MAX_REFERENCES: usize = 1_000_000;

/// The typed edges to one target, and the scan's totals.
#[derive(Debug, Default)]
pub struct Semantic {
    /// References to the target: sorted by path, owner, target kind, target and edge kind; each
    /// with the index of its file.
    pub references: Vec<(u32, Reference)>,
    /// Unresolved references of the whole scan (at most [`MAX_REFERENCES`]).
    pub unresolved_count: usize,
    /// With [`References::OwnFiles`]: the kind each unresolved reference of an own file would reach.
    pub unresolved_kinds: Vec<K>,
    /// With [`References::OwnFiles`]: the variables, flags and event targets any scanned file sets,
    /// which is what a read of one resolves to.
    pub writes: HashSet<(K, String)>,
    /// False when a source was skipped or a ceiling was reached.
    pub complete: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OwnerKind {
    Symbol(K),
    OnAction,
}

struct Owner {
    kind: OwnerKind,
    id: String,
}

impl Owner {
    fn is(&self, kinds: &[K]) -> bool {
        matches!(self.kind, OwnerKind::Symbol(kind) if kinds.contains(&kind))
    }
}

const EVENT_KEYS: &[&str] = &["country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event"];

/// `scalarTargets`.
fn scalar_target(key: &str) -> Option<K> {
    Some(match key {
        "activate_decision" | "remove_decision" | "complete_decision" => K::Decision,
        "add_ideas" | "remove_ideas" | "has_idea" => K::Idea,
        "has_completed_focus" => K::Focus,
        "load_focus_tree" => K::FocusTree,
        "has_tech" => K::Technology,
        "country_event" | "news_event" | "state_event" => K::Event,
        _ => return None,
    })
}

/// `stateKeyOperations`: the kind of key an operation names, its edge kind and its scope prefix.
fn state_operation(key: &str) -> Option<(K, &'static str, Option<&'static str>)> {
    Some(match key {
        "set_variable" | "add_to_variable" | "subtract_from_variable" | "multiply_variable" | "divide_variable" => (K::Variable, "variable_write", None),
        "check_variable" | "has_variable" => (K::Variable, "variable_read", None),
        "set_country_flag" | "clr_country_flag" => (K::Flag, "flag_write", Some("country")),
        "has_country_flag" => (K::Flag, "flag_read", Some("country")),
        "set_state_flag" | "clr_state_flag" => (K::Flag, "flag_write", Some("state")),
        "has_state_flag" => (K::Flag, "flag_read", Some("state")),
        "set_global_flag" | "clr_global_flag" => (K::Flag, "flag_write", Some("global")),
        "has_global_flag" => (K::Flag, "flag_read", Some("global")),
        "save_event_target_as" | "save_global_event_target_as" | "clear_global_event_target" => (K::EventTarget, "event_target_write", None),
        "has_event_target" => (K::EventTarget, "event_target_read", None),
        _ => return None,
    })
}

/// `staticTarget`: a name a script can resolve without running, not a scope, variable or
/// event-target reference.
fn static_target(value: &str) -> bool {
    let starts = |prefix: &str| value.len() >= prefix.len() && value.is_char_boundary(prefix.len()) && value[..prefix.len()].eq_ignore_ascii_case(prefix);
    !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
        && !["event_target:", "scope:", "var:", "constant:"].iter().any(|prefix| starts(prefix))
        && !["ROOT", "FROM", "PREV", "THIS"].iter().any(|word| value.eq_ignore_ascii_case(word))
}

/// `stateKeyTarget`: the key a state operation names.
fn state_key_target<'b>(value: &'b Value<'_>, kind: K) -> Option<&'b str> {
    match value {
        Value::Scalar(scalar) => Some(&scalar.value),
        Value::Block(_) if kind != K::Variable => None,
        Value::Block(block) => {
            if let Some(explicit) = block.first_scalar("var") {
                return Some(&explicit.value);
            }
            block.assignments().map(|a| a.key.value.as_ref()).find(|key| !["compare", "value", "tooltip", "var", "value_name"].contains(key))
        }
    }
}

/// What walking one file found.
#[derive(Default)]
struct FileSemantic {
    /// References kept, with their position among all the file's static references.
    matches: Vec<(usize, Reference)>,
    static_total: usize,
    unresolved_total: usize,
    unresolved_kinds: Vec<K>,
    writes: Vec<(K, String)>,
}

struct Walker<'a> {
    /// `(kind, id)` of every active definition of a kind an owner can have, with its file.
    active: &'a HashMap<(K, &'a str), u32>,
    file: u32,
    path: &'a str,
    collect: Collect<'a>,
    /// Note the state keys this file sets (for a closure).
    track_writes: bool,
    found: FileSemantic,
}

impl Walker<'_> {
    /// `emit`.
    fn emit(&mut self, at: (u32, u32), owner: &Owner, to_kind: K, value: &str, kind: &str) {
        if !static_target(value) {
            self.note_unresolved(to_kind);
            return;
        }
        let ordinal = self.found.static_total;
        self.found.static_total += 1;
        if self.track_writes && kind.ends_with("_write") {
            self.found.writes.push((to_kind, value.to_string()));
        }
        let keep = match self.collect {
            Collect::Symbol(target) => value == target,
            Collect::All => true,
            Collect::Nothing | Collect::Count => false,
        };
        if keep {
            self.found.matches.push((
                ordinal,
                Reference {
                    kind: Cow::Owned(kind.to_string()),
                    from: owner.id.clone(),
                    to_kind,
                    to: value.to_string(),
                    line: at.0,
                    offset: at.1,
                    end: at.1,
                    ordinal: ordinal as u32,
                },
            ));
        }
    }

    fn note_unresolved(&mut self, to_kind: K) {
        self.found.unresolved_total += 1;
        if matches!(self.collect, Collect::All) {
            self.found.unresolved_kinds.push(to_kind);
        }
    }

    /// `ownerFor` with `includeOnActions`.
    fn owner_for(&self, key: &str, value: &Value<'_>, ancestors: &[&str]) -> Option<Owner> {
        let Value::Block(block) = value else { return None };
        let path = self.path;
        let starts = |prefix: &str| path.starts_with(prefix);
        if starts("common/on_actions/") && ancestors.len() == 1 && ancestors[0] == "on_actions" {
            return Some(Owner { kind: OwnerKind::OnAction, id: key.to_string() });
        }
        let owner: Option<(K, String)> = if starts("events/") && ancestors.is_empty() && EVENT_KEYS.contains(&key) {
            block.first_scalar("id").map(|id| (K::Event, id.value.to_string()))
        } else if key == "focus" {
            block.first_scalar("id").map(|id| {
                let kind = if ancestors.contains(&"continuous_focus_palette") { K::ContinuousFocus } else { K::Focus };
                (kind, id.value.to_string())
            })
        } else if starts("common/decisions/") && !starts("common/decisions/categories/") && ancestors.len() == 1 {
            Some((K::Decision, key.to_string()))
        } else if starts("common/decisions/categories/") && ancestors.is_empty() {
            Some((K::DecisionCategory, key.to_string()))
        } else if starts("common/ideas/") && ancestors.len() == 2 && ancestors[0] == "ideas" {
            Some((K::Idea, key.to_string()))
        } else if starts("common/technologies/") && ancestors.len() == 1 && ancestors[0] == "technologies" {
            Some((K::Technology, key.to_string()))
        } else if starts("common/scripted_effects/") && ancestors.is_empty() {
            Some((K::ScriptedEffect, key.to_string()))
        } else if starts("common/scripted_triggers/") && ancestors.is_empty() {
            Some((K::ScriptedTrigger, key.to_string()))
        } else if starts("common/scripted_guis/") && ancestors.len() == 1 && ancestors[0] == "scripted_gui" {
            Some((K::ScriptedGui, key.to_string()))
        } else {
            None
        };
        let (kind, id) = owner?;
        // The definition must be the active one, and it must sit in this file.
        (self.active.get(&(kind, id.as_str())) == Some(&self.file)).then_some(Owner { kind: OwnerKind::Symbol(kind), id })
    }

    fn walk<'b>(&mut self, block: &'b Block<'_>, ancestors: &mut Vec<&'b str>, owner: Option<&Owner>) {
        for assignment in block.assignments() {
            let key: &'b str = &assignment.key.value;
            let at = (assignment.key.line, assignment.key.start);
            let identified = self.owner_for(key, &assignment.value, ancestors);
            let current = identified.as_ref().or(owner);
            if let Some(identified) = &identified
                && identified.is(&[K::Decision])
                && ancestors.len() == 1
            {
                self.emit(at, identified, K::DecisionCategory, ancestors[0], "decision_category_membership");
            }
            if let Some(current) = current
                && identified.is_none()
            {
                self.statement(assignment, at, ancestors, current);
            }
            if let Value::Block(child) = &assignment.value {
                ancestors.push(key);
                self.walk(child, ancestors, current);
                ancestors.pop();
            }
        }
    }

    /// The edges one assignment inside an owner makes.
    fn statement(&mut self, assignment: &super::reader::Assignment<'_>, at: (u32, u32), ancestors: &[&str], current: &Owner) {
        let key: &str = &assignment.key.value;
        if let Value::Scalar(scalar) = &assignment.value {
            let value: &str = &scalar.value;
            let localisation = (current.is(&[K::Event])
                && (key == "title" || key == "desc" || (key == "name" && ancestors.contains(&"option")) || (key == "text" && ancestors.contains(&"desc"))))
                || key == "custom_effect_tooltip";
            if localisation {
                self.emit(at, current, K::Localisation, value, "localisation_key");
            }
            let decision_like = current.is(&[K::Decision, K::DecisionCategory]);
            if (key == "picture" || (key == "icon" && decision_like)) && value.starts_with("GFX_") {
                self.emit(at, current, K::Sprite, value, "display_sprite");
            }
            if key == "scripted_gui" && decision_like {
                self.emit(at, current, K::ScriptedGui, value, "scripted_gui_binding");
            }
            if current.is(&[K::ScriptedGui]) && key == "parent_window_window" {
                self.emit(at, current, K::GuiElement, value, key);
            }
            if current.is(&[K::ScriptedGui]) && key == "parent_scripted_gui" {
                self.emit(at, current, K::ScriptedGui, value, key);
            }
        }
        if let Some(name) = key.strip_prefix("event_target:") {
            self.emit(at, current, K::EventTarget, name, "event_target_read");
        }
        if let Some((kind, edge, scope)) = state_operation(key) {
            match state_key_target(&assignment.value, kind) {
                None => self.note_unresolved(kind),
                Some(name) => {
                    let named = match scope {
                        Some(scope) => format!("{scope}:{name}"),
                        None => name.to_string(),
                    };
                    self.emit(at, current, kind, &named, edge);
                }
            }
        }
        let target_kind = scalar_target(key);
        if key == "set_technology"
            && let Value::Block(block) = &assignment.value
        {
            for technology in block.assignments() {
                if technology.key.value != "popup" {
                    self.emit((technology.key.line, technology.key.start), current, K::Technology, &technology.key.value, "set_technology");
                }
            }
        }
        if let Some(to_kind) = target_kind {
            match &assignment.value {
                Value::Scalar(scalar) => self.emit(at, current, to_kind, &scalar.value, key),
                Value::Block(block) => match block.first_scalar("id").or_else(|| block.first_scalar("decision")) {
                    Some(id) => self.emit(at, current, to_kind, &id.value, key),
                    None => {
                        for entry in block.scalars() {
                            self.emit(at, current, to_kind, &entry.value, key);
                        }
                    }
                },
            }
        }
        let helper = if self.active.contains_key(&(K::ScriptedEffect, key)) {
            Some(K::ScriptedEffect)
        } else if self.active.contains_key(&(K::ScriptedTrigger, key)) {
            Some(K::ScriptedTrigger)
        } else {
            None
        };
        if let Some(helper) = helper {
            self.emit(at, current, helper, key, "scripted_helper_call");
        }
    }
}

/// The directories whose sources the scan reads (`scanImpactSemanticReferences`).
fn scanned(path: &str) -> bool {
    path.ends_with(".txt")
        && [
            "events/",
            "common/national_focus/",
            "common/continuous_focus/",
            "common/decisions/",
            "common/ideas/",
            "common/technologies/",
            "common/scripted_effects/",
            "common/scripted_triggers/",
            "common/scripted_guis/",
            "common/on_actions/",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// The semantic scan over an index's files, keeping the references `want` names.
pub fn scan(index: &SymbolIndex, want: References<'_>) -> Result<Semantic, BuildError> {
    let owner_kinds = [
        K::Event,
        K::Focus,
        K::ContinuousFocus,
        K::Decision,
        K::DecisionCategory,
        K::Idea,
        K::Technology,
        K::ScriptedEffect,
        K::ScriptedTrigger,
        K::ScriptedGui,
    ];
    let active: HashMap<(K, &str), u32> =
        index.symbols.iter().filter(|s| s.active && owner_kinds.contains(&s.kind)).map(|s| ((s.kind, s.id.as_str()), s.file)).collect();
    let mut complete = true;
    let mut work: Vec<(usize, String)> = Vec::new();
    for (i, file) in index.files.iter().enumerate() {
        if file.shadowed_by.is_some() {
            continue;
        }
        let path = lower_path(file);
        if !scanned(&path) {
            continue;
        }
        if index.skipped_paths.contains(&i) {
            complete = false;
            continue;
        }
        work.push((i, path));
    }
    let results: Vec<Result<FileSemantic, BuildError>> = work
        .par_iter()
        .map(|(i, path)| {
            let file = &index.files[*i];
            let bytes = read(file)?;
            let (text, lossy) = decode(&bytes);
            let document = parse_clausewitz(&text, bytes.len(), lossy);
            let (collect, track_writes) = match want {
                References::None => (Collect::Nothing, false),
                References::To(target) => (Collect::Symbol(target), false),
                References::OwnFiles if file.kind.is_workspace_owned() => (Collect::All, true),
                References::OwnFiles => (Collect::Count, true),
            };
            let mut walker = Walker { active: &active, file: *i as u32, path, collect, track_writes, found: FileSemantic::default() };
            walker.walk(&document.root, &mut Vec::new(), None);
            Ok(walker.found)
        })
        .collect();
    let mut references: Vec<(u32, Reference)> = Vec::new();
    let (mut statics, mut unresolved) = (0usize, 0usize);
    let mut unresolved_kinds: Vec<K> = Vec::new();
    let mut writes: HashSet<(K, String)> = HashSet::new();
    for ((i, _), result) in work.iter().zip(results) {
        let found = result?;
        if statics + found.static_total > MAX_REFERENCES {
            complete = false;
        }
        for (ordinal, reference) in found.matches {
            if statics + ordinal < MAX_REFERENCES {
                references.push((*i as u32, reference));
            }
        }
        statics = (statics + found.static_total).min(MAX_REFERENCES);
        if unresolved + found.unresolved_total > MAX_REFERENCES {
            complete = false;
        }
        unresolved = (unresolved + found.unresolved_total).min(MAX_REFERENCES);
        unresolved_kinds.extend(found.unresolved_kinds);
        writes.extend(found.writes);
    }
    references.sort_by(|(left_file, left), (right_file, right)| {
        compare_code_units(&index.files[*left_file as usize].display, &index.files[*right_file as usize].display)
            .then_with(|| compare_code_units(&left.from, &right.from))
            .then_with(|| compare_code_units(left.to_kind.as_str(), right.to_kind.as_str()))
            .then_with(|| compare_code_units(&left.to, &right.to))
            .then_with(|| compare_code_units(&left.kind, &right.kind))
    });
    Ok(Semantic { references, unresolved_count: unresolved, unresolved_kinds, writes, complete })
}

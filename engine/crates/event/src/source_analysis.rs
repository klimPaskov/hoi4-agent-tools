//! Per-file event source analysis: the fragment of nodes, edges, state accesses, issues and
//! unresolved references one source file contributes to the event graph.
//!
//! Adapted from `src/hoi4_agent_tools/event/source-analysis.ts` (`analyzeEventSource`) at the
//! port branch, reading through `hoi4_engine::symbol_index::reader`. Output is the TypeScript
//! `EventSourceFragment` as JSON, so the TypeScript graph stage can consume it unchanged.
//!
//! Differences from the source, none visible in the output:
//! - the TypeScript `semanticPath` arrays are never read by anything that reaches the output
//!   (ids hash other fields), so they are not built, which also avoids hashing every entry twice;
//! - the fragment cache key is computed by the caller (it includes the tool version and absolute
//!   paths) and is echoed back.

use std::collections::{HashMap, HashSet};

use hoi4_core::canonical::{compare_code_units, hash_canonical};
use hoi4_engine::symbol_index::reader::{
    Assignment, Block, Diagnostics, Document, Entry, Scalar, Value as Src, decode, is_js_space, parse_clausewitz_detailed, parse_localisation_detailed,
    windows_1252_loss,
};
use hoi4_engine::symbol_index::records::Positions;
use serde_json::{Map, Value, json};

use crate::algorithms::{WORK_LIMIT, WorkBlocked};
use crate::native_effects::is_native_effect_key;

/// `EVENT_GRAPH_MAX_CONDITION_TEXT`.
const MAX_CONDITION_TEXT: usize = 16_384;

const EVENT_TYPES: [&str; 5] = ["country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event"];

const CONTROL_BLOCKS: [&str; 12] = [
    "if",
    "else_if",
    "else",
    "while",
    "every_country",
    "every_state",
    "every_owned_state",
    "every_character",
    "random_country",
    "random_state",
    "random_list",
    "hidden_effect",
];

/// `SCOPE_BLOCKS`.
fn scope_block(key: &str) -> Option<&'static str> {
    Some(match key {
        "country"
        | "every_country"
        | "every_enemy_country"
        | "every_faction_member"
        | "every_neighbor_country"
        | "every_subject_country"
        | "random_country"
        | "random_enemy_country"
        | "random_neighbor_country"
        | "random_occupied_country"
        | "random_other_country"
        | "random_subject_country"
        | "owner"
        | "controller" => "country",
        "capital_scope"
        | "state"
        | "every_controlled_state"
        | "every_core_state"
        | "every_neighbor_state"
        | "every_state"
        | "every_owned_state"
        | "random_controlled_state"
        | "random_core_state"
        | "random_neighbor_state"
        | "random_owned_state"
        | "random_state" => "state",
        "unit_leader" => "unit_leader",
        "operative_leader" | "every_operative" | "random_operative" => "operative",
        "character" | "every_army_leader" | "every_character" | "every_navy_leader" | "every_unit_leader" | "random_army_leader" | "random_character"
        | "random_navy_leader" | "random_unit_leader" => "character",
        "root" | "prev" | "from" | "this" => "unknown",
        _ => return None,
    })
}

struct StateRule {
    kind: &'static str,
    access: &'static str,
    name_field: Option<&'static str>,
    storage: Option<&'static str>,
    temporary: bool,
}

/// `STATE_RULES`.
fn state_rule(key: &str) -> Option<StateRule> {
    let rule = |kind, access, name_field, storage, temporary| Some(StateRule { kind, access, name_field, storage, temporary });
    match key {
        "set_country_flag" => rule("country_flag", "write", Some("flag"), None, false),
        "clr_country_flag" => rule("country_flag", "clear", Some("flag"), None, false),
        "has_country_flag" => rule("country_flag", "read", Some("flag"), None, false),
        "set_global_flag" => rule("global_flag", "write", Some("flag"), None, false),
        "clr_global_flag" => rule("global_flag", "clear", Some("flag"), None, false),
        "has_global_flag" => rule("global_flag", "read", Some("flag"), None, false),
        "set_state_flag" => rule("state_flag", "write", Some("flag"), None, false),
        "clr_state_flag" => rule("state_flag", "clear", Some("flag"), None, false),
        "has_state_flag" => rule("state_flag", "read", Some("flag"), None, false),
        "set_variable" | "set_variable_to_random" => rule("variable", "write", None, None, false),
        "add_to_variable"
        | "subtract_from_variable"
        | "multiply_variable"
        | "divide_variable"
        | "clamp_variable"
        | "round_variable"
        | "modulo_variable"
        | "randomize_variable" => rule("variable", "read_write", None, None, false),
        "set_temp_variable" | "set_temp_variable_to_random" => rule("variable", "write", None, None, true),
        "add_to_temp_variable"
        | "subtract_from_temp_variable"
        | "multiply_temp_variable"
        | "divide_temp_variable"
        | "clamp_temp_variable"
        | "round_temp_variable"
        | "modulo_temp_variable"
        | "randomize_temp_variable" => rule("variable", "read_write", None, None, true),
        "check_variable" | "has_variable" | "is_variable_equal" => rule("variable", "read", None, None, false),
        "clr_variable" | "clear_variable" => rule("variable", "clear", None, None, false),
        "set_global_variable" => rule("global_variable", "write", None, None, false),
        "add_to_global_variable" | "subtract_from_global_variable" => rule("global_variable", "read_write", None, None, false),
        "check_global_variable" | "has_global_variable" => rule("global_variable", "read", None, None, false),
        "clear_global_variable" => rule("global_variable", "clear", None, None, false),
        "add_to_array" | "resize_array" => rule("array", "write", Some("array"), None, false),
        "remove_from_array" => rule("array", "read_write", Some("array"), None, false),
        "is_in_array" => rule("array", "read", Some("array"), None, false),
        "clear_array" => rule("array", "clear", None, None, false),
        "add_to_temp_array" | "resize_temp_array" => rule("array", "write", Some("array"), None, true),
        "remove_from_temp_array" => rule("array", "read_write", Some("array"), None, true),
        "clear_temp_array" => rule("array", "clear", None, None, true),
        "save_event_target_as" => rule("event_target", "replace", None, None, false),
        "has_event_target" => rule("event_target", "read", None, None, false),
        "save_global_event_target_as" => rule("global_event_target", "replace", None, None, false),
        "has_global_event_target" => rule("global_event_target", "read", None, None, false),
        "clear_global_event_target" | "clear_global_event_targets" => rule("global_event_target", "clear", None, None, false),
        "save_scope_as" => rule("saved_scope", "replace", None, Some("local"), false),
        "save_global_scope_as" => rule("saved_scope", "replace", None, Some("global"), false),
        "clear_saved_scope" => rule("saved_scope", "clear", None, Some("local"), false),
        "clear_global_scope" => rule("saved_scope", "clear", None, Some("global"), false),
        _ => None,
    }
}

fn is_control_block(key: &str) -> bool {
    CONTROL_BLOCKS.contains(&key)
}

/// `NON_HELPER_BLOCKS`: effect wrappers plus condition and tooltip blocks.
fn is_non_helper_block(key: &str) -> bool {
    is_control_block(key)
        || matches!(
            key,
            "effect"
                | "completion_reward"
                | "meta_effect"
                | "text"
                | "trigger"
                | "limit"
                | "ai_chance"
                | "modifier"
                | "random_events"
                | "mean_time_to_happen"
                | "effect_tooltip"
                | "custom_effect_tooltip"
        )
}

/// `NON_EXECUTING_BLOCKS`.
fn is_non_executing_block(key: &str) -> bool {
    matches!(
        key,
        "trigger"
            | "limit"
            | "ai_chance"
            | "modifier"
            | "mean_time_to_happen"
            | "effect_tooltip"
            | "custom_effect_tooltip"
            | "visible"
            | "available"
            | "allowed"
            | "allowed_civil_war"
            | "allowed_to_remove"
            | "cancel_trigger"
            | "remove_trigger"
            | "target_trigger"
            | "target_root_trigger"
            | "activation"
            | "ai_will_do"
            | "bypass"
            | "allow_branch"
            | "hidden_trigger"
            | "custom_trigger_tooltip"
            | "and"
            | "or"
            | "not"
            | "nor"
            | "nand"
    )
}

/// `NATIVE_EFFECT_CONTAINERS`.
fn is_native_effect_container(key: &str) -> bool {
    matches!(
        key,
        "create_dynamic_country"
            | "custom_override_tooltip"
            | "effect_tooltip"
            | "for_each_loop"
            | "for_each_scope_loop"
            | "for_loop_effect"
            | "hidden_effect"
            | "if"
            | "random"
            | "random_list"
            | "random_scope_in_array"
            | "while_loop_effect"
    )
}

fn is_tooltip_only(key: &str) -> bool {
    matches!(key, "effect_tooltip" | "custom_effect_tooltip")
}

fn is_native_effect(key: &str, documented: Option<&HashSet<String>>) -> bool {
    is_native_effect_key(key) || documented.is_some_and(|set| set.contains(key))
}

fn is_native_argument_block(key: &str, documented: Option<&HashSet<String>>) -> bool {
    is_native_effect(key, documented)
        && !is_native_effect_container(key)
        && !is_control_block(key)
        && scope_block(key).is_none()
        && !(key.starts_with("every_") || key.starts_with("random_") || key.starts_with("global_every_"))
}

/// `/^on_[a-z0-9_]+$|(?:^|_)effects?$/`.
fn is_conventional_effect_block(key: &str) -> bool {
    let on = key.strip_prefix("on_").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'));
    let tail = |suffix: &str| key.strip_suffix(suffix).is_some_and(|head| head.is_empty() || head.ends_with('_'));
    on || tail("effect") || tail("effects")
}

fn is_trigger_iterator(key: &str) -> bool {
    key.starts_with("any_") || key.starts_with("all_")
}

fn lower_ascii_prefix(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len() && value.is_char_boundary(prefix.len()) && value[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `/\[|\]|\?|@|^event_target:|^var:|^scope:/iu`.
fn is_dynamic(value: &str) -> bool {
    value.contains(['[', ']', '?', '@'])
        || lower_ascii_prefix(value, "event_target:")
        || lower_ascii_prefix(value, "var:")
        || lower_ascii_prefix(value, "scope:")
}

/// `/^(?:event_target|global_event_target|scope|var|temp_var):\S+$/iu`.
fn is_qualified_dynamic_scope(value: &str) -> bool {
    ["event_target:", "global_event_target:", "scope:", "var:", "temp_var:"].iter().any(|prefix| {
        lower_ascii_prefix(value, prefix) && {
            let rest = &value[prefix.len()..];
            !rest.is_empty() && !rest.chars().any(is_js_space)
        }
    })
}

/// `/^(?:root|prev|from|this)(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/iu`.
fn is_scope_chain(value: &str) -> bool {
    ["root", "prev", "from", "this"].iter().any(|head| {
        lower_ascii_prefix(value, head) && {
            let rest = &value[head.len()..];
            !rest.is_empty()
                && rest.split('.').enumerate().all(|(index, part)| {
                    if index == 0 {
                        return part.is_empty();
                    }
                    let mut bytes = part.bytes();
                    bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_') && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
                })
        }
    })
}

fn is_literal_country_tag(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 3 && bytes[0].is_ascii_uppercase() && bytes[1..].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// `/^\d+(?:\.\d+)?$/u`.
fn is_plain_number(value: &str) -> bool {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    match value.split_once('.') {
        Some((whole, fraction)) => digits(whole) && digits(fraction),
        None => digits(value),
    }
}

/// `/^[+-]?\d+(?:\.\d+)?$/u`.
fn is_signed_number(value: &str) -> bool {
    is_plain_number(value.strip_prefix(['+', '-']).unwrap_or(value))
}

/// `/^\d{1,4}\.\d{1,2}\.\d{1,2}$/u`.
fn is_date(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    let within = |part: &str, max: usize| (1..=max).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    parts.len() == 3 && within(parts[0], 4) && within(parts[1], 2) && within(parts[2], 2)
}

fn on_action_scope(name: &str) -> &'static str {
    let normalized = name.to_lowercase();
    let periodic = ["on_daily_", "on_weekly_", "on_monthly_"].iter().any(|prefix| {
        normalized.strip_prefix(prefix).is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
    });
    if matches!(normalized.as_str(), "on_startup" | "on_daily" | "on_weekly" | "on_monthly" | "on_state_control_changed") || periodic {
        return "country";
    }
    if matches!(
        normalized.as_str(),
        "on_unit_leader_created"
            | "on_army_leader_daily"
            | "on_army_leader_won_combat"
            | "on_army_leader_lost_combat"
            | "on_unit_leader_level_up"
            | "on_army_leader_promoted"
            | "on_deployed_leader_defeated"
    ) {
        return "unit_leader";
    }
    if matches!(
        normalized.as_str(),
        "on_operative_detected_during_operation"
            | "on_operative_on_mission_spotted"
            | "on_operative_captured"
            | "on_operative_created"
            | "on_operative_death"
            | "on_operative_recruited"
    ) {
        return "operative";
    }
    "unknown"
}

fn expected_scope(event_type: &str) -> &'static str {
    match event_type {
        "state_event" => "state",
        "unit_leader_event" => "unit_leader",
        "operative_leader_event" => "operative",
        _ => "country",
    }
}

/// `/^(?:(?:var|temp_var|global_var|constant):)?[A-Za-z_][A-Za-z0-9_.:@^-]*$/u` and plain numbers.
fn weight_validity(weight: &str) -> Value {
    if is_plain_number(weight) {
        return Value::Bool(true);
    }
    let body = ["var:", "temp_var:", "global_var:", "constant:"].iter().find_map(|prefix| weight.strip_prefix(prefix)).unwrap_or(weight);
    let mut bytes = body.bytes();
    let symbolic = bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'@' | b'^' | b'-'));
    if symbolic { json!("unknown") } else { Value::Bool(false) }
}

fn missing_helper_candidate(key: &str, value: &Src, effect_context: bool, documented: Option<&HashSet<String>>) -> bool {
    let normalized = key.to_lowercase();
    if !effect_context
        || is_native_effect(&normalized, documented)
        || is_non_helper_block(&normalized)
        || scope_block(&normalized).is_some()
        || state_rule(&normalized).is_some()
        || is_dynamic(key)
        || is_plain_number(key)
        || lower_ascii_prefix(key, "event_target:")
        || lower_ascii_prefix(key, "global_event_target:")
        || lower_ascii_prefix(key, "scope:")
    {
        return false;
    }
    match value {
        Src::Scalar(scalar) => scalar.value.eq_ignore_ascii_case("yes") || scalar.value.eq_ignore_ascii_case("no"),
        Src::Block(_) => normalized.ends_with("_helper") || normalized.ends_with("_scripted_effect"),
    }
}

/// JavaScript `String.prototype.trim` over [`is_js_space`] and line terminators.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `.slice(0, limit)` in UTF-16 code units (a split surrogate pair is dropped).
fn truncate_units(text: &str, limit: usize) -> &str {
    let mut units = 0usize;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > limit {
            return &text[..index];
        }
    }
    text
}

/// The partial-source ceiling of the work budget, shared by extraction and graph construction.
#[derive(Debug)]
pub struct Budget {
    spent: u64,
    maximum: u64,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { spent: 0, maximum: WORK_LIMIT }
    }
}

impl Budget {
    pub fn spend(&mut self, label: &'static str) -> Result<(), WorkBlocked> {
        self.spent += 1;
        if self.spent > self.maximum { Err(WorkBlocked { label, spent: self.spent }) } else { Ok(()) }
    }
}

/// `EventSourceAnalysisContext` without the abort signal and the cache.
#[derive(Debug, Default, Clone)]
pub struct Context {
    pub known_event_ids: Option<HashSet<String>>,
    pub known_event_types: HashMap<String, String>,
    pub known_helper_ids: Option<HashSet<String>>,
    pub known_decision_ids: Option<HashSet<String>>,
    pub active_event_paths: Option<HashMap<String, String>>,
    pub retained_event_paths: Option<HashMap<String, HashSet<String>>>,
    pub active_helper_paths: Option<HashMap<String, String>>,
    pub active_decision_paths: Option<HashMap<String, String>>,
    pub inventory_complete: Option<bool>,
    pub documented_effect_keys: Option<HashSet<String>>,
}

/// The parts of a `ScannedFile` the analysis reads.
pub struct SourceFile<'a> {
    pub relative_path: &'a str,
    pub display_path: &'a str,
    pub sha256: &'a str,
    pub bytes: &'a [u8],
}

/// `deterministicId`: the prefix and the first 24 hex digits of the canonical hash.
pub fn deterministic_id(prefix: &str, value: &Value) -> String {
    format!("{prefix}_{}", &hash_canonical(value)[..24])
}

#[derive(Clone)]
struct Cond {
    id: String,
    json: Value,
}

#[derive(Clone)]
struct Walk {
    owner_id: String,
    source_scope: &'static str,
    phase: &'static str,
    conditions: Vec<Cond>,
    helper_stack: Vec<String>,
    weight: Option<String>,
    weight_modifiers: Option<Vec<Cond>>,
    reason: Option<&'static str>,
    scope_expression: Option<String>,
    effect_context: Option<bool>,
    native_arguments: bool,
    infer_missing_helpers: Option<bool>,
    suppress_semantics: bool,
}

impl Walk {
    fn new(owner_id: &str, source_scope: &'static str, phase: &'static str, conditions: Vec<Cond>, helper_stack: Vec<String>) -> Self {
        Walk {
            owner_id: owner_id.to_string(),
            source_scope,
            phase,
            conditions,
            helper_stack,
            weight: None,
            weight_modifiers: None,
            reason: None,
            scope_expression: None,
            effect_context: None,
            native_arguments: false,
            infer_missing_helpers: None,
            suppress_semantics: false,
        }
    }
}

type Span = (u32, u32);

struct Timing {
    mode: &'static str,
    value: Value,
}

struct EdgeExtra {
    phase: &'static str,
    source_scope: &'static str,
    helper_stack: Vec<String>,
    timing: Option<Timing>,
    weight: Option<String>,
    weight_modifiers: Option<Vec<Cond>>,
    target_event_id: Option<String>,
    scope_expression: Option<String>,
}

impl EdgeExtra {
    fn new(phase: &'static str, source_scope: &'static str) -> Self {
        EdgeExtra {
            phase,
            source_scope,
            helper_stack: Vec::new(),
            timing: None,
            weight: None,
            weight_modifiers: None,
            target_event_id: None,
            scope_expression: None,
        }
    }
}

/// One fragment under construction.
struct Analyzer<'a, 'd> {
    file: &'a SourceFile<'a>,
    doc: &'d Document<'d>,
    text: &'d str,
    positions: &'d Positions<'d>,
    ctx: &'a Context,
    budget: &'a mut Budget,
    empty_helpers: HashSet<String>,
    nodes: Vec<Value>,
    edges: Vec<Value>,
    state_accesses: Vec<Value>,
    issues: Vec<Value>,
    unresolved: Vec<Value>,
    seen_state_writers: HashSet<String>,
    edge_collisions: HashMap<String, u32>,
    condition_collisions: HashMap<String, u32>,
    state_collisions: HashMap<String, u32>,
    unresolved_collisions: HashMap<String, u32>,
}

fn sem_scalar(scalar: &Scalar) -> Value {
    json!({ "type": "scalar", "value": scalar.value })
}

fn sem_block(text: &str, block: &Block) -> Value {
    json!({ "type": "block", "entries": block.entries.iter().map(|entry| sem_entry(text, entry)).collect::<Vec<_>>() })
}

fn sem_value(text: &str, value: &Src) -> Value {
    match value {
        Src::Scalar(scalar) => sem_scalar(scalar),
        Src::Block(block) => sem_block(text, block),
    }
}

/// `semanticSourceEntry`: location- and trivia-independent content used only for identity.
fn sem_entry(text: &str, entry: &Entry) -> Value {
    match entry {
        Entry::Scalar(scalar) => sem_scalar(scalar),
        Entry::Assignment(a) => {
            json!({ "type": "assignment", "key": a.key.value, "operator": &text[a.operator.0 as usize..a.operator.1 as usize], "value": sem_value(text, &a.value) })
        }
        Entry::Block(block) => sem_block(text, block),
    }
}

fn assignment_span(a: &Assignment) -> Span {
    (a.key.start, a.end())
}

fn value_span(value: &Src) -> Span {
    match value {
        Src::Scalar(s) => (s.start, s.end),
        Src::Block(b) => (b.start, b.end),
    }
}

fn scalar_span(s: &Scalar) -> Span {
    (s.start, s.end)
}

fn block_span(b: &Block) -> Span {
    (b.start, b.end)
}

fn first_scalar_value<'b>(value: &'b Src, field: &str) -> Option<&'b str> {
    match value {
        Src::Scalar(s) => Some(&s.value),
        Src::Block(b) => b.first_scalar(field).map(|s| &*s.value),
    }
}

/// `firstScalarForKey`: the first scalar value among the assignments of `key`.
fn first_scalar_for_key<'b>(block: &'b Block, key: &str) -> Option<&'b str> {
    block.assignments().filter(|a| a.key.value == key).find_map(|a| match &a.value {
        Src::Scalar(s) => Some(&*s.value),
        Src::Block(_) => None,
    })
}

fn sorted_unique(mut keys: Vec<String>) -> Vec<String> {
    keys.sort_by(|a, b| compare_code_units(a, b));
    keys.dedup();
    keys
}

fn localisation_keys(value: &Src) -> Vec<String> {
    let block = match value {
        Src::Scalar(s) => return vec![s.value.to_string()],
        Src::Block(b) => b,
    };
    let mut keys = Vec::new();
    for a in block.assignments() {
        let key = a.key.value.to_lowercase();
        if key == "text" || key == "fallback" || key == "localisation_key" {
            match &a.value {
                Src::Scalar(s) => keys.push(s.value.to_string()),
                Src::Block(_) => keys.extend(localisation_keys(&a.value)),
            }
        }
    }
    sorted_unique(keys)
}

fn push_opt(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_string(), value);
    }
}

impl<'a, 'd> Analyzer<'a, 'd> {
    fn location(&self, span: Span, symbol: Option<&str>) -> Value {
        Positions::location(self.file.display_path, self.positions.position(span.0), self.positions.position(span.1), symbol)
    }

    fn source_text(&self, span: Span) -> &'d str {
        &self.text[span.0 as usize..span.1 as usize]
    }

    fn value_text(&self, span: Span) -> String {
        truncate_units(js_trim(self.source_text(span)), MAX_CONDITION_TEXT).to_string()
    }

    fn unique_id(&self, prefix: &str, semantic: Value) -> String {
        deterministic_id(prefix, &json!({ "source": self.file.display_path, "semantic": semantic }))
    }

    fn occurrence_id(&self, prefix: &str, semantic: Value, collisions: &mut HashMap<String, u32>) -> String {
        let identity = self.unique_id(prefix, semantic.clone());
        let ordinal = collisions.get(&identity).copied().unwrap_or(0);
        collisions.insert(identity.clone(), ordinal + 1);
        if ordinal == 0 { identity } else { self.unique_id(prefix, json!({ "semantic": semantic, "duplicateOrdinal": ordinal })) }
    }

    fn add_node(&mut self, node: Value) -> Result<(), WorkBlocked> {
        self.budget.spend("event source node")?;
        self.nodes.push(node);
        Ok(())
    }

    fn analyze(&mut self) -> Result<(), WorkBlocked> {
        let path = normalized_path(self.file.relative_path);
        if path.starts_with("events/") {
            self.analyze_events()
        } else if path.starts_with("common/scripted_effects/") {
            self.analyze_helpers()
        } else if path.starts_with("common/on_actions/") {
            self.analyze_on_actions()
        } else if path.contains("common/focus") || path.contains("common/national_focus") {
            self.analyze_focuses()
        } else if path.starts_with("common/decisions/") {
            self.analyze_decisions()
        } else if path.starts_with("history/countries/") {
            self.analyze_setup("country_setup", "country")
        } else if path.starts_with("history/states/") {
            self.analyze_setup("state_setup", "state")
        } else {
            self.analyze_other()
        }
    }

    fn condition(&mut self, owner_id: &str, kind: &'static str, span: Span, content: Value) -> Cond {
        let semantic = json!({ "ownerId": owner_id, "kind": kind, "content": content });
        let mut collisions = std::mem::take(&mut self.condition_collisions);
        let id = self.occurrence_id("event_condition", semantic, &mut collisions);
        self.condition_collisions = collisions;
        let json = json!({
            "id": id,
            "kind": kind,
            "expression": truncate_units(js_trim(self.source_text(span)), MAX_CONDITION_TEXT),
            "location": self.location(span, None),
            "confidence": "confirmed",
        });
        Cond { id, json }
    }

    fn block_condition(&mut self, owner_id: &str, kind: &'static str, block: &Block) -> Cond {
        let content = sem_block(self.text, block);
        self.condition(owner_id, kind, block_span(block), content)
    }

    fn analyze_events(&mut self) -> Result<(), WorkBlocked> {
        let doc = self.doc;
        let mut occurrences: HashMap<String, u32> = HashMap::new();
        for assignment in doc.root.assignments() {
            let Src::Block(body) = &assignment.value else { continue };
            let event_type = &*assignment.key.value;
            if !EVENT_TYPES.contains(&event_type) {
                continue;
            }
            let Some(id_scalar) = body.first_scalar("id") else { continue };
            let id = id_scalar.value.to_string();
            let skip = match self.ctx.retained_event_paths.as_ref().and_then(|map| map.get(&id)) {
                Some(paths) => !paths.contains(self.file.display_path),
                None => self.ctx.active_event_paths.as_ref().is_some_and(|map| map.get(&id).map(String::as_str) != Some(self.file.display_path)),
            };
            if skip {
                continue;
            }
            let ordinal = occurrences.get(&id).copied().unwrap_or(0);
            occurrences.insert(id.clone(), ordinal + 1);
            let owner_id = self.unique_id("event_definition", json!({ "id": id, "ordinal": ordinal }));
            let title_assignments: Vec<&Assignment> = body.assignments().filter(|a| a.key.value.to_lowercase() == "title").collect();
            let description_assignments: Vec<&Assignment> = body.assignments().filter(|a| a.key.value.to_lowercase() == "desc").collect();
            let title_keys = sorted_unique(title_assignments.iter().flat_map(|a| localisation_keys(&a.value)).collect());
            let description_keys = sorted_unique(description_assignments.iter().flat_map(|a| localisation_keys(&a.value)).collect());
            let triggered_only_scalar = body.first_scalar("is_triggered_only");
            let triggered_only = triggered_only_scalar.is_some_and(|s| s.value == "yes");
            let hidden = body.first_scalar("hidden").is_some_and(|s| s.value == "yes") || body.first_scalar("hide_window").is_some_and(|s| s.value == "yes");
            let mut metadata = Map::new();
            metadata.insert("eventType".into(), json!(event_type));
            metadata.insert("expectedScope".into(), json!(expected_scope(event_type)));
            metadata.insert("hidden".into(), json!(hidden));
            metadata.insert("hasTitle".into(), json!(!title_assignments.is_empty()));
            metadata.insert("hasDescription".into(), json!(!description_assignments.is_empty()));
            if triggered_only_scalar.is_some() {
                metadata.insert("isTriggeredOnly".into(), json!(triggered_only));
            }
            if let Some(key) = title_keys.first() {
                metadata.insert("titleKey".into(), json!(key));
            }
            if let Some(key) = description_keys.first() {
                metadata.insert("descKey".into(), json!(key));
            }
            if !title_keys.is_empty() {
                metadata.insert("titleKeys".into(), json!(title_keys));
            }
            if !description_keys.is_empty() {
                metadata.insert("descriptionKeys".into(), json!(description_keys));
            }
            if !title_keys.is_empty() || !description_keys.is_empty() {
                let all = sorted_unique(title_keys.iter().chain(description_keys.iter()).cloned().collect());
                metadata.insert("localisationKeys".into(), json!(all));
            }
            let namespace = match id.rfind('.') {
                Some(at) if id.contains('.') => &id[..at],
                _ => id.as_str(),
            };
            self.add_node(json!({
                "id": owner_id,
                "kind": "event",
                "label": id,
                "eventId": id,
                "namespace": namespace,
                "sourcePath": self.file.display_path,
                "location": self.location(assignment_span(assignment), Some(&id)),
                "metadata": metadata,
            }))?;
            let scope = expected_scope(event_type);
            let trigger = body.child_blocks("trigger").next();
            let event_conditions: Vec<Cond> = match trigger {
                Some(block) => vec![self.block_condition(&owner_id, "event_trigger", block)],
                None => Vec::new(),
            };
            if let Some(block) = trigger {
                self.walk(block, &Walk::new(&owner_id, scope, "other", event_conditions.clone(), Vec::new()))?;
            }
            for fields in [&title_assignments, &description_assignments] {
                for field in fields {
                    let Src::Block(block) = &field.value else { continue };
                    let mut context = Walk::new(&owner_id, scope, "other", Vec::new(), Vec::new());
                    context.effect_context = Some(false);
                    self.walk(block, &context)?;
                }
            }
            for (phase, key) in [("immediate", "immediate"), ("after", "after")] {
                for block in body.child_blocks(key) {
                    self.walk(block, &Walk::new(&owner_id, scope, phase, event_conditions.clone(), Vec::new()))?;
                }
            }
            let options: Vec<&Block> = body.child_blocks("option").collect();
            let mut name_counts: HashMap<String, u32> = HashMap::new();
            for option in &options {
                let name = option.first_scalar("name").map_or("<unnamed>".to_string(), |s| s.value.to_string());
                *name_counts.entry(name).or_insert(0) += 1;
            }
            let mut option_occurrences: HashMap<String, u32> = HashMap::new();
            for (option_index, option) in options.iter().enumerate() {
                let name_key = option.first_scalar("name").map(|s| s.value.to_string());
                let semantic_name = name_key.clone().unwrap_or_else(|| "<unnamed>".to_string());
                let option_semantic = if name_key.is_some() && name_counts.get(&semantic_name) == Some(&1) {
                    json!({ "nameKey": name_key })
                } else {
                    json!({ "nameKey": semantic_name, "content": sem_block(self.text, option) })
                };
                let segment_id = deterministic_id("event_semantic_path", &json!({ "label": "option", "semantic": option_semantic }));
                let duplicate = option_occurrences.get(&segment_id).copied().unwrap_or(0);
                option_occurrences.insert(segment_id.clone(), duplicate + 1);
                let option_occurrence = if duplicate == 0 { segment_id } else { format!("{segment_id}:{duplicate}") };
                let option_id = self.unique_id("option", json!({ "eventDefinition": owner_id, "optionOccurrence": option_occurrence }));
                let conditions: Vec<Cond> = match option.child_blocks("trigger").next() {
                    Some(block) => vec![self.block_condition(&option_id, "option_trigger", block)],
                    None => Vec::new(),
                };
                let effect_count = option.assignments().filter(|a| !matches!(&*a.key.value, "name" | "trigger" | "ai_chance")).count();
                let mut option_metadata = Map::new();
                option_metadata.insert("optionIndex".into(), json!(option_index));
                option_metadata.insert("effectCount".into(), json!(effect_count));
                option_metadata.insert("hasEffects".into(), json!(effect_count > 0));
                option_metadata.insert("hasName".into(), json!(name_key.is_some()));
                if let Some(name) = &name_key {
                    option_metadata.insert("nameKey".into(), json!(name));
                }
                let label = name_key.clone().unwrap_or_else(|| format!("Option {}", option_index + 1));
                self.add_node(json!({
                    "id": option_id,
                    "kind": "option",
                    "label": label,
                    "eventId": id,
                    "sourcePath": self.file.display_path,
                    "location": self.location(block_span(option), Some(name_key.as_deref().unwrap_or(&id))),
                    "metadata": option_metadata,
                }))?;
                self.add_edge(&owner_id, &option_id, "option_branch", block_span(option), &conditions, EdgeExtra::new("option", scope));
                self.walk(option, &Walk::new(&option_id, scope, "option", conditions, Vec::new()))?;
            }
            let mean_time = body.child_blocks("mean_time_to_happen").next();
            if !triggered_only && (trigger.is_some() || mean_time.is_some()) {
                let mean_conditions: Vec<Cond> = match mean_time {
                    Some(block) => block
                        .child_blocks("modifier")
                        .collect::<Vec<_>>()
                        .into_iter()
                        .map(|modifier| self.block_condition(&owner_id, "weight_modifier", modifier))
                        .collect(),
                    None => Vec::new(),
                };
                if let Some(block) = mean_time {
                    let mut context = Walk::new(&owner_id, scope, "other", mean_conditions.clone(), Vec::new());
                    context.effect_context = Some(false);
                    self.walk(block, &context)?;
                }
                let entry_id = self.unique_id("entry", json!({ "kind": "implicit_event_trigger", "event": id, "ordinal": ordinal }));
                self.add_node(json!({
                    "id": entry_id,
                    "kind": "entry",
                    "label": format!("{id} automatic trigger"),
                    "sourcePath": self.file.display_path,
                    "location": self.location(assignment_span(assignment), Some(&id)),
                    "metadata": { "entryKind": "implicit_event_trigger", "scope": scope },
                }))?;
                let evidence = mean_time.map(block_span).or(trigger.map(block_span)).unwrap_or_else(|| assignment_span(assignment));
                let mut conditions = event_conditions.clone();
                conditions.extend(mean_conditions);
                let mut extra = EdgeExtra::new("entry", scope);
                extra.timing = mean_time.map(|block| self.mean_time_timing(block));
                self.add_edge(&entry_id, &owner_id, "implicit_event_entry", evidence, &conditions, extra);
            }
        }
        Ok(())
    }

    fn analyze_helpers(&mut self) -> Result<(), WorkBlocked> {
        let doc = self.doc;
        for assignment in doc.root.assignments() {
            let Src::Block(body) = &assignment.value else { continue };
            let name = &*assignment.key.value;
            if self.ctx.known_helper_ids.as_ref().is_some_and(|known| !known.contains(name)) {
                continue;
            }
            if self.ctx.active_helper_paths.as_ref().is_some_and(|map| map.get(name).map(String::as_str) != Some(self.file.display_path)) {
                continue;
            }
            let owner_id = format!("helper:{name}");
            self.add_node(json!({
                "id": owner_id,
                "kind": "helper",
                "label": name,
                "sourcePath": self.file.display_path,
                "location": self.location(assignment_span(assignment), Some(name)),
                "metadata": { "name": name },
            }))?;
            self.walk(body, &Walk::new(&owner_id, "unknown", "helper", Vec::new(), vec![name.to_string()]))?;
        }
        Ok(())
    }

    fn analyze_on_actions(&mut self) -> Result<(), WorkBlocked> {
        let doc = self.doc;
        let containers: Vec<&Block> = doc.root.child_blocks("on_actions").collect();
        let roots: Vec<&Block> = if containers.is_empty() { vec![&doc.root] } else { containers.clone() };
        for root in roots {
            for action in root.assignments() {
                let Src::Block(body) = &action.value else { continue };
                if containers.is_empty() && !action.key.value.starts_with("on_") {
                    continue;
                }
                let action_scope = on_action_scope(&action.key.value);
                let owner_id = self.entry_node("on_action", &action.key.value, assignment_span(action), action_scope)?;
                for events in body.child_blocks("events") {
                    for entry in &events.entries {
                        let Entry::Scalar(scalar) = entry else { continue };
                        let mut context = Walk::new(&owner_id, action_scope, "entry", Vec::new(), Vec::new());
                        context.reason = Some("on_action_entry");
                        self.record_event_call(&scalar.value, scalar_span(scalar), None, &context)?;
                    }
                }
                self.walk(body, &Walk::new(&owner_id, action_scope, "entry", Vec::new(), Vec::new()))?;
            }
        }
        Ok(())
    }

    fn visit_assignments<'b>(block: &'b Block<'d>, ancestors: &[String], out: &mut Vec<(&'b Assignment<'d>, Vec<String>)>) {
        for entry in &block.entries {
            let Entry::Assignment(a) = entry else { continue };
            out.push((a, ancestors.to_vec()));
            if let Src::Block(inner) = &a.value {
                let mut next = ancestors.to_vec();
                next.push(a.key.value.to_string());
                Self::visit_assignments(inner, &next, out);
            }
        }
    }

    fn analyze_focuses(&mut self) -> Result<(), WorkBlocked> {
        let doc = self.doc;
        let mut visited = Vec::new();
        Self::visit_assignments(&doc.root, &[], &mut visited);
        for (assignment, _) in visited {
            if !matches!(&*assignment.key.value, "focus" | "shared_focus" | "joint_focus") {
                continue;
            }
            let Src::Block(body) = &assignment.value else { continue };
            let Some(id) = body.first_scalar("id").map(|s| s.value.to_string()) else { continue };
            let owner_id = self.entry_node("focus", &id, assignment_span(assignment), "country")?;
            for key in ["available", "bypass", "allow_branch"] {
                for block in body.child_blocks(key) {
                    let condition = self.block_condition(&owner_id, "branch_guard", block);
                    self.walk(block, &Walk::new(&owner_id, "country", "other", vec![condition], Vec::new()))?;
                }
            }
            for key in ["completion_reward", "completion_reward_joint_originator", "completion_reward_joint_member"] {
                for block in body.child_blocks(key) {
                    self.walk(block, &Walk::new(&owner_id, "country", "entry", Vec::new(), Vec::new()))?;
                }
            }
        }
        Ok(())
    }

    fn analyze_decisions(&mut self) -> Result<(), WorkBlocked> {
        let doc = self.doc;
        let mut visited = Vec::new();
        Self::visit_assignments(&doc.root, &[], &mut visited);
        for (assignment, ancestors) in visited {
            let Src::Block(body) = &assignment.value else { continue };
            let id = &*assignment.key.value;
            if self.ctx.known_decision_ids.as_ref().is_some_and(|known| !known.contains(id)) {
                continue;
            }
            if self.ctx.active_decision_paths.as_ref().is_some_and(|map| map.get(id).map(String::as_str) != Some(self.file.display_path)) {
                continue;
            }
            if self.ctx.known_decision_ids.is_none() && ancestors.len() != 1 {
                continue;
            }
            let mission = body.first_scalar("days_mission_timeout").is_some();
            let owner_id = self.entry_node(if mission { "mission" } else { "decision" }, id, assignment_span(assignment), "country")?;
            for key in ["visible", "available", "allowed", "activation", "remove_trigger", "complete_trigger", "target_trigger"] {
                for block in body.child_blocks(key) {
                    let condition = self.block_condition(&owner_id, "branch_guard", block);
                    self.walk(block, &Walk::new(&owner_id, "country", "other", vec![condition], Vec::new()))?;
                }
            }
            for key in ["complete_effect", "remove_effect", "timeout_effect", "cancel_effect", "select_effect"] {
                for block in body.child_blocks(key) {
                    self.walk(block, &Walk::new(&owner_id, "country", "entry", Vec::new(), Vec::new()))?;
                }
            }
        }
        Ok(())
    }

    fn analyze_setup(&mut self, kind: &'static str, scope: &'static str) -> Result<(), WorkBlocked> {
        let relative = self.file.relative_path.replace('\\', "/");
        let name = relative.rsplit('/').next().unwrap_or(self.file.display_path).to_string();
        let owner_id = self.unique_id("entry", json!({ "kind": kind, "name": name }));
        let edge_count = self.edges.len();
        let state_count = self.state_accesses.len();
        let doc = self.doc;
        self.walk(&doc.root, &Walk::new(&owner_id, scope, "entry", Vec::new(), Vec::new()))?;
        if self.edges.len() == edge_count {
            self.state_accesses.truncate(state_count);
            return Ok(());
        }
        self.add_node(json!({
            "id": owner_id,
            "kind": "entry",
            "label": name,
            "sourcePath": self.file.display_path,
            "location": self.location(block_span(&doc.root), Some(&name)),
            "metadata": { "entryKind": kind, "scope": scope },
        }))
    }

    fn analyze_other(&mut self) -> Result<(), WorkBlocked> {
        let owner_id = self.unique_id("entry", json!({ "kind": "other", "path": self.file.display_path }));
        let before = self.edges.len() + self.state_accesses.len();
        let doc = self.doc;
        let mut context = Walk::new(&owner_id, "unknown", "other", Vec::new(), Vec::new());
        context.effect_context = Some(true);
        context.infer_missing_helpers = Some(false);
        self.walk(&doc.root, &context)?;
        if self.edges.len() + self.state_accesses.len() > before {
            self.add_node(json!({
                "id": owner_id,
                "kind": "entry",
                "label": self.file.relative_path,
                "sourcePath": self.file.display_path,
                "location": self.location(block_span(&doc.root), Some(self.file.relative_path)),
                "metadata": { "entryKind": "other", "scope": "unknown" },
            }))?;
        }
        Ok(())
    }

    fn entry_node(&mut self, kind: &'static str, name: &str, span: Span, scope: &'static str) -> Result<String, WorkBlocked> {
        let id = self.unique_id("entry", json!({ "kind": kind, "name": name }));
        self.add_node(json!({
            "id": id,
            "kind": "entry",
            "label": name,
            "sourcePath": self.file.display_path,
            "location": self.location(span, Some(name)),
            "metadata": { "entryKind": kind, "scope": scope, "reason": kind },
        }))?;
        Ok(id)
    }

    fn walk(&mut self, block: &Block, context: &Walk) -> Result<(), WorkBlocked> {
        for entry in &block.entries {
            self.budget.spend("event effect entry")?;
            let Entry::Assignment(assignment) = entry else { continue };
            self.walk_assignment(assignment, context)?;
        }
        Ok(())
    }

    fn walk_assignment(&mut self, entry: &Assignment, context: &Walk) -> Result<(), WorkBlocked> {
        let key = &*entry.key.value;
        let normalized = key.to_lowercase();
        let effect_context = context.effect_context.unwrap_or(context.phase != "other");
        let qualified_dynamic_scope = is_qualified_dynamic_scope(key);
        let chained_scope = is_scope_chain(key);
        let literal_country_tag = is_literal_country_tag(key);
        let span = assignment_span(entry);
        if effect_context && EVENT_TYPES.contains(&normalized.as_str()) {
            match first_scalar_value(&entry.value, "id") {
                Some(id) => self.record_event_call(id, span, Some(&entry.value), context)?,
                None => {
                    let expression = self.value_text(value_span(&entry.value));
                    self.record_dynamic_event(&expression, span, &context.owner_id)?;
                }
            }
            return Ok(());
        }
        if !context.suppress_semantics {
            self.record_state(entry, context);
        }
        let empty = &self.empty_helpers;
        let known_helpers = self.ctx.known_helper_ids.as_ref().unwrap_or(empty);
        if effect_context && known_helpers.contains(key) {
            let mut extra = EdgeExtra::new(context.phase, context.source_scope);
            extra.helper_stack = context.helper_stack.clone();
            self.add_edge(&context.owner_id, &format!("helper:{key}"), "scripted_effect_call", span, &context.conditions, extra);
            return Ok(());
        }
        if self.ctx.inventory_complete != Some(false)
            && !context.native_arguments
            && context.infer_missing_helpers != Some(false)
            && missing_helper_candidate(key, &entry.value, effect_context, self.ctx.documented_effect_keys.as_ref())
        {
            let target = self.unresolved_node("missing_helper", key, span, &context.owner_id)?;
            let mut extra = EdgeExtra::new(context.phase, context.source_scope);
            extra.helper_stack = context.helper_stack.clone();
            self.add_edge(&context.owner_id, &target, "scripted_effect_call", span, &context.conditions, extra);
            return Ok(());
        }
        if effect_context && is_dynamic(key) && !qualified_dynamic_scope {
            let target = self.unresolved_node("dynamic_helper", key, span, &context.owner_id)?;
            self.add_edge(&context.owner_id, &target, "unresolved_dynamic_reference", span, &[], EdgeExtra::new("helper", "unknown"));
            return Ok(());
        }
        if effect_context
            && normalized == "random_events"
            && let Src::Block(body) = &entry.value
        {
            for weighted in body.assignments() {
                let Src::Scalar(target) = &weighted.value else { continue };
                if target.value == "0" {
                    continue;
                }
                let mut member = context.clone();
                member.weight = Some(weighted.key.value.to_string());
                member.reason = Some("random_event_call");
                self.record_event_call(&target.value, assignment_span(weighted), Some(&weighted.value), &member)?;
            }
            return Ok(());
        }
        let Src::Block(body) = &entry.value else { return Ok(()) };
        let mut conditions = context.conditions.clone();
        if matches!(normalized.as_str(), "if" | "else_if" | "while")
            && let Some(limit) = body.child_blocks("limit").next()
        {
            conditions.push(self.block_condition(&context.owner_id, "limit", limit));
        }
        if normalized == "limit" {
            conditions.push(self.block_condition(&context.owner_id, "limit", body));
        }
        if normalized == "trigger" {
            conditions.push(self.block_condition(&context.owner_id, "branch_guard", body));
        }
        if normalized == "random"
            && let Some(chance) = body.first_scalar("chance")
        {
            let content = sem_scalar(chance);
            conditions.push(self.condition(&context.owner_id, "random_chance", scalar_span(chance), content));
        }
        let scope_kind = scope_block(&normalized);
        let explicit_dynamic_scope = qualified_dynamic_scope || chained_scope;
        let scope = if explicit_dynamic_scope {
            "unknown"
        } else if literal_country_tag {
            "country"
        } else {
            scope_kind.unwrap_or(context.source_scope)
        };
        let scope_expression =
            if explicit_dynamic_scope || literal_country_tag || scope_kind.is_some() { Some(key.to_string()) } else { context.scope_expression.clone() };
        let phase = if normalized == "hidden_effect" { "hidden" } else { context.phase };
        if effect_context && normalized == "random_list" {
            for weighted in body.assignments() {
                let Src::Block(branch) = &weighted.value else { continue };
                let mut weight_modifiers = Vec::new();
                for modifier in branch.child_blocks("modifier") {
                    weight_modifiers.push(self.block_condition(&context.owner_id, "weight_modifier", modifier));
                }
                let mut next = context.clone();
                next.conditions = conditions.clone();
                next.source_scope = scope;
                next.scope_expression = scope_expression.clone();
                next.weight = Some(weighted.key.value.to_string());
                next.weight_modifiers = Some(weight_modifiers);
                next.reason = Some("weighted_event_call");
                next.effect_context = Some(true);
                self.walk(branch, &next)?;
            }
            return Ok(());
        }
        let mut next = context.clone();
        next.conditions = conditions;
        next.source_scope = scope;
        next.scope_expression = scope_expression;
        next.suppress_semantics = context.suppress_semantics || is_tooltip_only(&normalized);
        if is_control_block(&normalized) || scope_kind.is_some() || matches!(normalized.as_str(), "effect" | "completion_reward" | "random") {
            next.phase = phase;
            next.effect_context = Some(if is_non_executing_block(&normalized) { false } else { effect_context });
            if normalized == "random" {
                next.reason = Some("random_event_call");
            }
        } else {
            next.phase = phase;
            next.effect_context = Some(if is_non_executing_block(&normalized) || is_trigger_iterator(&normalized) { false } else { effect_context });
            next.native_arguments = context.native_arguments || is_native_argument_block(&normalized, self.ctx.documented_effect_keys.as_ref());
            if context.infer_missing_helpers == Some(false) && is_conventional_effect_block(&normalized) {
                next.infer_missing_helpers = Some(true);
            }
        }
        self.walk(body, &next)
    }

    fn record_event_call(&mut self, id: &str, span: Span, assignment_value: Option<&Src>, context: &Walk) -> Result<(), WorkBlocked> {
        if is_dynamic(id) {
            return self.record_dynamic_event(id, span, &context.owner_id);
        }
        let known = self.ctx.known_event_ids.as_ref().is_none_or(|known| known.contains(id));
        let target = if known {
            format!("event:{id}")
        } else {
            let kind = if self.ctx.inventory_complete == Some(false) { "partial_source" } else { "missing_event" };
            self.unresolved_node(kind, id, span, &context.owner_id)?
        };
        let timing = assignment_value.and_then(|value| self.timing(value));
        let reason = match context.reason {
            Some(reason) => reason,
            None => self.edge_reason(context.phase, timing.as_ref(), context.weight.as_deref()),
        };
        let mut extra = EdgeExtra::new(context.phase, context.source_scope);
        extra.helper_stack = context.helper_stack.clone();
        extra.timing = timing;
        extra.weight = context.weight.clone();
        extra.weight_modifiers = context.weight_modifiers.clone();
        extra.scope_expression = context.scope_expression.clone();
        extra.target_event_id = Some(id.to_string());
        self.add_edge(&context.owner_id, &target, reason, span, &context.conditions, extra);
        Ok(())
    }

    fn edge_reason(&self, phase: &str, timing: Option<&Timing>, weight: Option<&str>) -> &'static str {
        if weight.is_some() {
            return "weighted_event_call";
        }
        if timing.is_some_and(|t| t.mode != "immediate") {
            return "delayed_event_call";
        }
        match phase {
            "option" => "option_event_call",
            "hidden" => "hidden_event_call",
            "after" => "after_event_call",
            "entry" => "other_entry",
            _ => "immediate_event_call",
        }
    }

    fn mean_time_timing(&self, block: &Block) -> Timing {
        let timing = self.timing_of(block);
        if timing.as_ref().is_some_and(|t| t.mode == "unknown") {
            return timing.unwrap_or(Timing { mode: "unknown", value: Value::Null });
        }
        let mut fields = match timing {
            Some(Timing { value: Value::Object(map), .. }) => map,
            _ => Map::new(),
        };
        fields.insert("mode".into(), json!("mean_time_to_happen"));
        fields.insert("expression".into(), json!(self.value_text(block_span(block))));
        Timing { mode: "mean_time_to_happen", value: Value::Object(fields) }
    }

    fn timing(&self, value: &Src) -> Option<Timing> {
        match value {
            Src::Block(block) => self.timing_of(block),
            Src::Scalar(_) => None,
        }
    }

    fn timing_of(&self, block: &Block) -> Option<Timing> {
        let scalar = |key: &str| block.first_scalar(key).map(|s| s.value.to_string());
        let years = scalar("years");
        let hours = scalar("hours");
        let days = scalar("days");
        let months = scalar("months");
        let random_hours = scalar("random_hours").or_else(|| first_scalar_for_key(block, "random").map(str::to_string));
        let random_days = scalar("random_days");
        let random_months = scalar("random_months");
        let date = scalar("date");
        let all = [&years, &hours, &days, &months, &random_hours, &random_days, &random_months, &date];
        if all.iter().all(|field| field.is_none()) {
            return None;
        }
        let numeric = [&years, &hours, &days, &months, &random_hours, &random_days, &random_months];
        let dynamic =
            numeric.iter().any(|field| field.as_ref().is_some_and(|text| !is_signed_number(text))) || date.as_ref().is_some_and(|text| !is_date(text));
        let fixed = years.is_some() || hours.is_some() || days.is_some() || months.is_some();
        let random = random_hours.is_some() || random_days.is_some() || random_months.is_some();
        let mode = if dynamic {
            "unknown"
        } else if date.is_some() {
            "date"
        } else if fixed && random {
            "fixed_and_random"
        } else if random {
            "random"
        } else {
            "fixed"
        };
        let mut fields = Map::new();
        fields.insert("mode".into(), json!(mode));
        for (name, field) in [
            ("years", &years),
            ("hours", &hours),
            ("days", &days),
            ("months", &months),
            ("randomHours", &random_hours),
            ("randomDays", &random_days),
            ("randomMonths", &random_months),
            ("date", &date),
        ] {
            if let Some(text) = field {
                fields.insert(name.into(), json!(text));
            }
        }
        if dynamic {
            fields.insert("expression".into(), json!(self.value_text(block_span(block))));
        }
        Some(Timing { mode, value: Value::Object(fields) })
    }

    fn add_edge(&mut self, from: &str, to: &str, reason: &'static str, span: Span, conditions: &[Cond], extra: EdgeExtra) {
        let location = self.location(span, None);
        let mut identity = Map::new();
        identity.insert("from".into(), json!(from));
        identity.insert("to".into(), json!(to));
        identity.insert("reason".into(), json!(reason));
        identity.insert("phase".into(), json!(extra.phase));
        identity.insert("sourceScope".into(), json!(extra.source_scope));
        identity.insert("conditions".into(), json!(conditions.iter().map(|c| &c.id).collect::<Vec<_>>()));
        identity.insert("helperStack".into(), json!(extra.helper_stack));
        push_opt(&mut identity, "timing", extra.timing.as_ref().map(|t| t.value.clone()));
        push_opt(&mut identity, "weight", extra.weight.as_ref().map(|w| json!(w)));
        push_opt(&mut identity, "weightModifiers", extra.weight_modifiers.as_ref().map(|list| json!(list.iter().map(|c| &c.id).collect::<Vec<_>>())));
        push_opt(&mut identity, "targetEventId", extra.target_event_id.as_ref().map(|t| json!(t)));
        push_opt(&mut identity, "scopeExpression", extra.scope_expression.as_ref().map(|s| json!(s)));
        let collision_key = deterministic_id("event_edge", &Value::Object(identity.clone()));
        let ordinal = self.edge_collisions.get(&collision_key).copied().unwrap_or(0);
        self.edge_collisions.insert(collision_key.clone(), ordinal + 1);
        let id = if ordinal == 0 {
            collision_key
        } else {
            identity.insert("collisionOrdinal".into(), json!(ordinal));
            deterministic_id("event_edge", &Value::Object(identity))
        };
        let destination_type = extra.target_event_id.as_ref().and_then(|target| self.ctx.known_event_types.get(target));
        let timing_unknown = extra.timing.as_ref().is_some_and(|t| t.mode == "unknown");
        let role = if reason == "scripted_effect_call" {
            "helper_call"
        } else if extra.phase == "entry" {
            "entry"
        } else {
            "invocation"
        };
        let confidence = if to.starts_with("unresolved_") {
            "unresolved"
        } else if timing_unknown {
            "low"
        } else {
            "confirmed"
        };
        let mut edge = Map::new();
        edge.insert("id".into(), json!(id));
        edge.insert("from".into(), json!(from));
        edge.insert("to".into(), json!(to));
        edge.insert("reason".into(), json!(reason));
        edge.insert("conditions".into(), json!(conditions.iter().map(|c| &c.json).collect::<Vec<_>>()));
        edge.insert("helperStack".into(), json!(extra.helper_stack));
        edge.insert("location".into(), location.clone());
        edge.insert("provenance".into(), json!([{ "role": role, "location": location }]));
        edge.insert("confidence".into(), json!(confidence));
        edge.insert("derived".into(), json!(false));
        push_opt(&mut edge, "timing", extra.timing.as_ref().map(|t| t.value.clone()));
        if let Some(weight) = &extra.weight {
            let modifiers: Vec<&Value> = extra.weight_modifiers.iter().flatten().map(|c| &c.json).collect();
            edge.insert("weight".into(), json!({ "value": weight, "modifiers": modifiers, "valid": weight_validity(weight) }));
        }
        if let Some(destination) = destination_type {
            let mut scope = Map::new();
            scope.insert("source".into(), json!(extra.source_scope));
            scope.insert("destination".into(), json!(expected_scope(destination)));
            push_opt(&mut scope, "expression", extra.scope_expression.as_ref().map(|s| json!(s)));
            scope.insert("confidence".into(), json!(if extra.source_scope == "unknown" { "low" } else { "high" }));
            edge.insert("scope".into(), Value::Object(scope));
        }
        let mut metadata = Map::new();
        push_opt(&mut metadata, "targetEventId", extra.target_event_id.as_ref().map(|t| json!(t)));
        if timing_unknown {
            metadata.insert("blocker".into(), json!("Event timing could not be resolved statically."));
        }
        edge.insert("metadata".into(), Value::Object(metadata));
        self.edges.push(Value::Object(edge));
    }

    fn record_dynamic_event(&mut self, expression: &str, span: Span, owner_id: &str) -> Result<(), WorkBlocked> {
        let target = self.unresolved_node("dynamic_event", expression, span, owner_id)?;
        self.add_edge(owner_id, &target, "unresolved_dynamic_reference", span, &[], EdgeExtra::new("other", "unknown"));
        Ok(())
    }

    fn unresolved_node(&mut self, kind: &'static str, expression: &str, span: Span, owner_id: &str) -> Result<String, WorkBlocked> {
        let mut collisions = std::mem::take(&mut self.unresolved_collisions);
        let id = self.occurrence_id("unresolved", json!({ "kind": kind, "ownerId": owner_id, "expression": expression }), &mut collisions);
        self.unresolved_collisions = collisions;
        let blocker = match kind {
            "missing_event" => json!({ "code": "EVENT_REFERENCE_MISSING", "message": format!("Event {expression} is absent from the active catalog") }),
            "missing_helper" => {
                json!({ "code": "EVENT_HELPER_UNRESOLVED", "message": format!("Scripted helper {expression} is absent from the active catalog") })
            }
            "partial_source" => json!({ "code": "PARTIAL_SOURCE_INVENTORY", "message": "A skipped source could contain this definition" }),
            _ => json!({
                "code": if kind == "dynamic_helper" { "EVENT_HELPER_UNRESOLVED" } else { "EVENT_DYNAMIC_DISPATCH_UNRESOLVED" },
                "message": "Runtime expression cannot be resolved",
            }),
        };
        let location = self.location(span, None);
        self.add_node(json!({
            "id": id,
            "kind": "unresolved",
            "label": expression,
            "sourcePath": self.file.display_path,
            "location": location,
            "metadata": { "unresolvedKind": kind, "expression": expression },
        }))?;
        self.unresolved.push(json!({
            "id": id,
            "kind": kind,
            "expression": expression,
            "ownerId": owner_id,
            "location": location,
            "confidence": "unresolved",
            "blockers": [blocker],
        }));
        Ok(id)
    }

    fn record_state(&mut self, assignment: &Assignment, context: &Walk) {
        let key = &*assignment.key.value;
        if let Some((head, name)) = keyed_target(key) {
            let kind = match head {
                "global_event_target" => "global_event_target",
                "scope" => "saved_scope",
                _ => "event_target",
            };
            self.add_state(context, kind, name, "read", scalar_span(&assignment.key), false, Map::new());
        }
        let Some(rule) = state_rule(key) else {
            // The whole value: a name that runs on into `[...]` or `$...$` is built at run time.
            let raw = self.source_text(value_span(&assignment.value));
            for (head, name) in event_target_mentions(raw) {
                let kind = if head == "global_event_target" { "global_event_target" } else { "event_target" };
                self.add_state(context, kind, name, "read", assignment_span(assignment), false, Map::new());
            }
            return;
        };
        let mut kind = rule.kind;
        let mut name: Option<String> = first_scalar_value(&assignment.value, rule.name_field.unwrap_or("name")).map(str::to_string);
        if name.is_none()
            && let Src::Block(block) = &assignment.value
        {
            name = block.assignments().find(|a| !matches!(&*a.key.value, "value" | "compare" | "tooltip")).map(|a| a.key.value.to_string());
        }
        if key == "clear_global_event_targets" {
            name = Some("*".to_string());
        }
        let Some(mut name) = name else { return };
        if (kind == "variable" || kind == "global_variable") && name.starts_with("global.") {
            kind = "global_variable";
            name = name["global.".len()..].to_string();
        }
        let mut access = rule.access;
        let writer_key = format!("{kind}:{name}:{}", rule.storage.unwrap_or(""));
        if access == "replace" && matches!(kind, "event_target" | "global_event_target" | "saved_scope") {
            access = if self.seen_state_writers.contains(&writer_key) { "replace" } else { "write" };
            self.seen_state_writers.insert(writer_key);
        } else if access == "write" {
            self.seen_state_writers.insert(writer_key);
        }
        let mut metadata = Map::new();
        if let Some(storage) = rule.storage {
            metadata.insert("storage".into(), json!(storage));
        }
        if rule.temporary {
            metadata.insert("temporary".into(), json!(true));
        }
        if matches!(key, "has_event_target" | "has_global_event_target") {
            metadata.insert("presence".into(), json!(true));
        }
        let dynamic = is_dynamic(&name);
        self.add_state(context, kind, &name, access, assignment_span(assignment), dynamic, metadata);
    }

    #[allow(clippy::too_many_arguments)]
    fn add_state(&mut self, context: &Walk, kind: &'static str, name: &str, access: &'static str, span: Span, dynamic: bool, metadata: Map<String, Value>) {
        let condition_ids: Vec<&String> = context.conditions.iter().map(|c| &c.id).collect();
        let semantic = json!({
            "ownerId": context.owner_id,
            "kind": kind,
            "name": name,
            "access": access,
            "scope": context.source_scope,
            "helperStack": context.helper_stack,
            "conditions": condition_ids,
            "dynamic": dynamic,
            "metadata": metadata,
        });
        let mut collisions = std::mem::take(&mut self.state_collisions);
        let id = self.occurrence_id("event_state", semantic, &mut collisions);
        self.state_collisions = collisions;
        let location = self.location(span, Some(name));
        self.state_accesses.push(json!({
            "id": id,
            "ownerId": context.owner_id,
            "kind": kind,
            "name": name,
            "access": access,
            "location": location,
            "confidence": if dynamic { "unresolved" } else { "confirmed" },
            "scope": context.source_scope,
            "helperStack": context.helper_stack,
            "conditions": context.conditions.iter().map(|c| &c.json).collect::<Vec<_>>(),
            "dynamic": dynamic,
            "metadata": metadata,
        }));
    }
}

/// `/^(event_target|global_event_target|scope):([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_.-]+)?$/u`.
fn keyed_target(key: &str) -> Option<(&str, &str)> {
    let (head, rest) = key.split_once(':')?;
    if !matches!(head, "event_target" | "global_event_target" | "scope") {
        return None;
    }
    let name_end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len());
    if name_end == 0 {
        return None;
    }
    let tail = &rest[name_end..];
    let tail_ok =
        tail.is_empty() || (tail.starts_with('.') && tail.len() > 1 && tail[1..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')));
    tail_ok.then(|| (head, &rest[..name_end]))
}

/// `/\b(event_target|global_event_target):([A-Za-z0-9_-]+)(?![A-Za-z0-9_[$-])/gu`.
fn event_target_mentions(raw: &str) -> Vec<(&str, &str)> {
    let bytes = raw.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let boundary = at == 0 || !word(bytes[at - 1]);
        let head = if !boundary {
            None
        } else if bytes[at..].starts_with(b"global_event_target:") {
            Some("global_event_target")
        } else if bytes[at..].starts_with(b"event_target:") {
            Some("event_target")
        } else {
            None
        };
        let Some(head) = head else {
            at += 1;
            continue;
        };
        let name_start = at + head.len() + 1;
        let mut name_end = name_start;
        while name_end < bytes.len() && (bytes[name_end].is_ascii_alphanumeric() || bytes[name_end] == b'_' || bytes[name_end] == b'-') {
            name_end += 1;
        }
        let blocked = bytes.get(name_end).is_some_and(|b| matches!(b, b'[' | b'$'));
        if name_end == name_start || blocked {
            at += 1;
            continue;
        }
        found.push((head, &raw[name_start..name_end]));
        at = name_end;
    }
    found
}

/// `normalizedPath`.
fn normalized_path(relative_path: &str) -> String {
    let slashed = relative_path.replace('\\', "/");
    slashed.strip_prefix("./").unwrap_or(&slashed).to_lowercase()
}

fn issue_from_diagnostic(diagnostic: &Value) -> Value {
    let mut issue = Map::new();
    issue.insert("code".into(), diagnostic["code"].clone());
    issue.insert("classification".into(), json!("unresolved_analysis"));
    issue.insert("severity".into(), diagnostic["severity"].clone());
    issue.insert("message".into(), diagnostic["message"].clone());
    issue.insert("confidence".into(), json!("unresolved"));
    if let Some(location) = diagnostic.get("location") {
        issue.insert("location".into(), location.clone());
    }
    issue.insert("blockers".into(), json!([{ "code": diagnostic["code"], "message": diagnostic["message"] }]));
    issue.insert("details".into(), json!({}));
    Value::Object(issue)
}

fn diagnostics_issues(positions: &Positions, path: &str, diagnostics: &Diagnostics) -> Vec<Value> {
    diagnostics.retained().iter().map(|d| issue_from_diagnostic(&positions.diagnostic(path, d))).collect()
}

/// `analyzeEventSource`: the fragment one file contributes, as `EventSourceFragment` JSON.
pub fn analyze_event_source(file: &SourceFile, context: &Context, cache_key: &str, budget: &mut Budget) -> Result<Value, WorkBlocked> {
    let path = normalized_path(file.relative_path);
    let mut fragment = Map::new();
    fragment.insert("cacheKey".into(), json!(cache_key));
    fragment.insert("sourcePath".into(), json!(file.display_path));
    fragment.insert("sourceHash".into(), json!(file.sha256));
    let empty = |mut fragment: Map<String, Value>, issues: Vec<Value>, localisation: Vec<Value>| {
        fragment.insert("nodes".into(), json!([]));
        fragment.insert("edges".into(), json!([]));
        fragment.insert("stateAccesses".into(), json!([]));
        fragment.insert("issues".into(), Value::Array(issues));
        fragment.insert("unresolved".into(), json!([]));
        fragment.insert("localisation".into(), Value::Array(localisation));
        Value::Object(fragment)
    };
    if path.ends_with(".yml") || path.ends_with(".yaml") {
        let bom = file.bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let (text, _) = decode(file.bytes);
        let parsed = parse_localisation_detailed(&text, file.bytes.len(), bom);
        let positions = Positions::new(&text);
        let issues = diagnostics_issues(&positions, file.display_path, &parsed.diagnostics);
        let mut entries = parsed.entries;
        entries.sort_by(|a, b| compare_code_units(&a.key, &b.key).then_with(|| compare_code_units(&a.language, &b.language)));
        let localisation = entries
            .iter()
            .map(|entry| {
                let start = positions.unit(entry.start);
                let end = positions.unit(entry.end);
                json!({
                    "key": entry.key,
                    "language": entry.language,
                    "value": entry.value,
                    "location": {
                        "path": file.display_path,
                        "start": { "line": entry.line, "column": 1, "offset": start },
                        "end": { "line": entry.line, "column": (end - start + 1).max(1), "offset": end },
                    },
                })
            })
            .collect();
        return Ok(empty(fragment, issues, localisation));
    }
    if !path.ends_with(".txt") {
        return Ok(empty(fragment, Vec::new(), Vec::new()));
    }
    let (text, lossy) = decode(file.bytes);
    let loss = if lossy { windows_1252_loss(file.bytes) } else { None };
    let document = parse_clausewitz_detailed(&text, file.bytes.len(), loss.as_ref());
    let positions = Positions::new(&text);
    let mut analyzer = Analyzer {
        file,
        doc: &document,
        text: &text,
        positions: &positions,
        ctx: context,
        budget,
        empty_helpers: HashSet::new(),
        nodes: Vec::new(),
        edges: Vec::new(),
        state_accesses: Vec::new(),
        issues: diagnostics_issues(&positions, file.display_path, &document.diagnostics),
        unresolved: Vec::new(),
        seen_state_writers: HashSet::new(),
        edge_collisions: HashMap::new(),
        condition_collisions: HashMap::new(),
        state_collisions: HashMap::new(),
        unresolved_collisions: HashMap::new(),
    };
    let partial = document.diagnostics.retained_limits();
    if !partial.is_empty() {
        let blockers: Vec<Value> = partial
            .iter()
            .map(|d| {
                let diagnostic = positions.diagnostic(file.display_path, d);
                let mut blocker = Map::new();
                blocker.insert("code".into(), diagnostic["code"].clone());
                blocker.insert("message".into(), diagnostic["message"].clone());
                if let Some(location) = diagnostic.get("location") {
                    blocker.insert("location".into(), location.clone());
                }
                Value::Object(blocker)
            })
            .collect();
        analyzer.unresolved.push(json!({
            "id": deterministic_id("unresolved", &json!({ "source": file.display_path, "hash": file.sha256, "kind": "partial_source" })),
            "kind": "partial_source",
            "expression": file.display_path,
            "confidence": "unresolved",
            "blockers": blockers,
        }));
    } else {
        analyzer.analyze()?;
    }
    fragment.insert("nodes".into(), Value::Array(analyzer.nodes));
    fragment.insert("edges".into(), Value::Array(analyzer.edges));
    fragment.insert("stateAccesses".into(), Value::Array(analyzer.state_accesses));
    fragment.insert("issues".into(), Value::Array(analyzer.issues));
    fragment.insert("unresolved".into(), Value::Array(analyzer.unresolved));
    fragment.insert("localisation".into(), json!([]));
    Ok(Value::Object(fragment))
}

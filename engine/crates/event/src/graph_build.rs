//! The event semantic graph: merge file fragments, resolve cross-file calls, project helpers and
//! derive state links and findings.
//!
//! Adapted from `src/hoi4_agent_tools/event/graph.ts` (`buildEventGraph`) and the dependency walk
//! of `src/hoi4_agent_tools/core/dependency-walk.ts` at the port branch. The caller keeps the scan
//! snapshot and the fragment cache: it sends the fragments, the active files' hashes and the
//! snapshot facts, and gets the `EventGraphSnapshot` back. Records stay `serde_json::Value`, so
//! fields this crate does not read pass through unchanged.

use std::collections::{HashMap, HashSet, VecDeque};

use hoi4_core::canonical::{compare_code_units as cmp, hash_canonical};
use serde_json::{Map, Value, json};

use crate::algorithms::{WORK_LIMIT, WorkBlocked, strongly_connected};
use crate::source_analysis::Budget;
use crate::state_keys::{compatible_producer_keys, has_unknown_saved_scope_storage, state_key};

const MAX_NODES: usize = 250_000;
const MAX_EDGES: usize = 500_000;
const MAX_STATE_ACCESSES: usize = 1_000_000;
const MAX_STATE_LINKS: usize = 1_000_000;
const MAX_STATE_LINK_CANDIDATES: usize = 2_000_000;
const MAX_ISSUES: usize = 100_000;
const MAX_UNRESOLVED: usize = 50_000;
const MAX_HELPER_DEPTH: usize = 64;
const MAX_HELPER_PROJECTIONS: usize = 200_000;
const MAX_HELPER_STATE_PROJECTIONS: usize = 50_000;

/// What the caller knows about the scan: the active files, the snapshot facts and the options.
#[derive(Debug, Clone, Default)]
pub struct Input {
    pub fragments: Vec<Value>,
    /// `(displayPath, sha256)` of every active file the graph covers.
    pub files: Vec<(String, String)>,
    pub workspace_id: String,
    pub workspace_identity: Option<String>,
    pub revision: String,
    pub complete: bool,
    pub skipped_source_count: u64,
    pub skipped_sources: Vec<Value>,
    pub diagnostics: Vec<Value>,
    pub project_helpers: bool,
    pub focused: bool,
}

#[derive(Debug)]
pub enum BuildError {
    /// A fixed result ceiling (`EVENT_NODE_LIMIT` and the others).
    Limit {
        code: &'static str,
        label: &'static str,
        count: usize,
        maximum: usize,
    },
    Work(WorkBlocked),
    /// The walk input is invalid, for example duplicate edge ids (`DEPENDENCY_WALK_INPUT_INVALID`).
    Input(String),
}

impl From<WorkBlocked> for BuildError {
    fn from(value: WorkBlocked) -> Self {
        BuildError::Work(value)
    }
}

type Done<T> = Result<T, BuildError>;

// ---------------------------------------------------------------------------------------------
// Value accessors
// ---------------------------------------------------------------------------------------------

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn text_opt<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn meta<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get("metadata").and_then(|m| m.get(key)).filter(|v| !v.is_null())
}

fn meta_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    meta(value, key).and_then(Value::as_str)
}

pub(crate) fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn offset(location: &Value, end: bool) -> i64 {
    location.get(if end { "end" } else { "start" }).and_then(|p| p.get("offset")).and_then(Value::as_i64).unwrap_or(-1)
}

fn location_key(location: Option<&Value>) -> String {
    match location {
        Some(location) => format!("{}:{}:{}", text(location, "path"), offset(location, false), offset(location, true)),
        None => ":-1:-1".to_string(),
    }
}

fn confidence_rank(value: &str) -> u8 {
    match value {
        "confirmed" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

fn worst_confidence<'a>(values: impl IntoIterator<Item = &'a str>) -> &'a str {
    let mut iter = values.into_iter();
    let mut worst = iter.next().unwrap_or("confirmed");
    for value in iter {
        if confidence_rank(value) > confidence_rank(worst) {
            worst = value;
        }
    }
    worst
}

fn sorted_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut list: Vec<String> = values.into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    list.sort_by(|a, b| cmp(a, b));
    list
}

fn stable_unique(values: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut kept: Vec<Value> = values.into_iter().filter(|value| seen.insert(text(value, "id").to_string())).collect();
    kept.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
    kept
}

/// The first 32 hex digits of the canonical hash.
fn short(value: &Value) -> String {
    hash_canonical(value)[..32].to_string()
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Spec {
    code: &'static str,
    classification: &'static str,
    severity: &'static str,
    message: String,
    confidence: String,
    location: Option<Value>,
    related: Option<Vec<Value>>,
    blockers: Vec<Value>,
    subjects: Vec<String>,
    details: Map<String, Value>,
}

fn blocker(code: &str, message: &str, location: Option<&Value>, details: Option<Value>) -> Value {
    let mut map = Map::new();
    map.insert("code".into(), json!(code));
    map.insert("message".into(), json!(message));
    if let Some(location) = location {
        map.insert("location".into(), location.clone());
    }
    if let Some(details) = details {
        map.insert("details".into(), details);
    }
    Value::Object(map)
}

fn add_issue(issues: &mut Vec<Value>, spec: Spec) {
    let subjects = sorted_strings(spec.subjects);
    let mut details = spec.details;
    if !subjects.is_empty() {
        details.insert("subjectIds".into(), json!(subjects));
    }
    let mut map = Map::new();
    map.insert("code".into(), json!(spec.code));
    map.insert("classification".into(), json!(spec.classification));
    map.insert("severity".into(), json!(spec.severity));
    map.insert("message".into(), json!(spec.message));
    map.insert("confidence".into(), json!(spec.confidence));
    if let Some(location) = spec.location {
        map.insert("location".into(), location);
    }
    if let Some(related) = spec.related {
        map.insert("related".into(), Value::Array(related));
    }
    map.insert("blockers".into(), Value::Array(spec.blockers));
    map.insert("details".into(), Value::Object(details));
    issues.push(Value::Object(map));
}

fn details(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect()
}

fn issue_key(issue: &Value) -> String {
    let mut subject = issue.get("details").and_then(Value::as_object).cloned().unwrap_or_default();
    let subject_ids = subject.remove("subjectIds");
    subject.remove("accessId");
    subject.remove("stateLinkId");
    let subject_ids = match subject_ids {
        Some(Value::Array(items)) => Value::Array(items),
        _ => json!([]),
    };
    hash_canonical(&json!({
        "code": issue.get("code"),
        "classification": issue.get("classification"),
        "subjectIds": subject_ids,
        "subject": subject,
    }))
}

fn stable_issues(values: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut keyed: Vec<(String, Value)> = Vec::new();
    for value in values {
        let key = issue_key(&value);
        if seen.insert(key.clone()) {
            keyed.push((key, value));
        }
    }
    keyed.sort_by(|(left_key, left), (right_key, right)| {
        cmp(text(left, "code"), text(right, "code"))
            .then_with(|| cmp(&location_key(left.get("location")), &location_key(right.get("location"))))
            .then_with(|| cmp(left_key, right_key))
    });
    keyed.into_iter().map(|(_, value)| value).collect()
}

// ---------------------------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct G {
    nodes: Vec<Value>,
    edges: Vec<Value>,
    accesses: Vec<Value>,
    issues: Vec<Value>,
    unresolved: Vec<Value>,
    localisation: Vec<Value>,
}

type Nodes<'a> = HashMap<&'a str, &'a Value>;

fn node_map(nodes: &[Value]) -> Nodes<'_> {
    nodes.iter().map(|node| (text(node, "id"), node)).collect()
}

fn option_parents(edges: &[Value]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for edge in edges {
        if text(edge, "reason") == "option_branch" {
            result.entry(text(edge, "to").to_string()).or_insert_with(|| text(edge, "from").to_string());
        }
    }
    result
}

fn semantic_owner(owner: &str, nodes: &Nodes<'_>, parents: &HashMap<String, String>) -> String {
    let node = nodes.get(owner);
    if let Some(node) = node {
        if text(node, "kind") == "option" {
            return parents.get(owner).cloned().unwrap_or_else(|| owner.to_string());
        }
        if let Some(parent) = meta_text(node, "eventNodeId") {
            return parent.to_string();
        }
        if let Some(event_id) = meta_text(node, "eventId") {
            return format!("event:{event_id}");
        }
    }
    owner.to_string()
}

fn kind_of<'a>(nodes: &Nodes<'a>, id: &str) -> Option<&'a str> {
    nodes.get(id).map(|node| text(node, "kind"))
}

fn assert_limit(count: usize, maximum: usize, code: &'static str, label: &'static str) -> Done<()> {
    if count <= maximum { Ok(()) } else { Err(BuildError::Limit { code, label, count, maximum }) }
}

fn is_derived(edge: &Value) -> bool {
    edge.get("derived").and_then(Value::as_bool).unwrap_or(false)
}

fn definitions(nodes: &[Value]) -> Vec<(String, Vec<&Value>)> {
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for node in nodes {
        if text(node, "kind") != "event" {
            continue;
        }
        if let Some(event_id) = text_opt(node, "eventId") {
            groups.entry(event_id.to_string()).or_default().push(node);
        }
    }
    let mut ordered: Vec<(String, Vec<&Value>)> = groups.into_iter().collect();
    ordered.sort_by(|(a, _), (b, _)| cmp(a, b));
    for (_, values) in &mut ordered {
        values.sort_by(|a, b| cmp(&location_key(a.get("location")), &location_key(b.get("location"))).then_with(|| cmp(text(a, "id"), text(b, "id"))));
    }
    ordered
}

fn take_list(fragment: &mut Value, key: &str) -> Vec<Value> {
    match fragment.get_mut(key).map(Value::take) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn merge_fragments(fragments: Vec<Value>) -> G {
    let mut graph = G::default();
    for mut fragment in fragments {
        graph.nodes.extend(take_list(&mut fragment, "nodes"));
        graph.edges.extend(take_list(&mut fragment, "edges"));
        graph.accesses.extend(take_list(&mut fragment, "stateAccesses"));
        graph.issues.extend(take_list(&mut fragment, "issues"));
        graph.unresolved.extend(take_list(&mut fragment, "unresolved"));
        graph.localisation.extend(take_list(&mut fragment, "localisation"));
    }
    graph
}

fn normalized_entry_reason(node: &Value) -> Option<&'static str> {
    Some(match meta_text(node, "entryKind")? {
        "on_action" => "on_action_entry",
        "focus" => "focus_entry",
        "decision" => "decision_entry",
        "mission" => "mission_entry",
        "country_setup" => "country_setup_entry",
        "state_setup" => "state_setup_entry",
        "implicit_event_trigger" => "implicit_event_entry",
        "other" => "other_entry",
        _ => return None,
    })
}

fn normalize_public_event_node_ids(graph: &mut G) {
    let mut replacements: HashMap<String, String> = HashMap::new();
    for (event_id, values) in definitions(&graph.nodes) {
        for (index, node) in values.iter().enumerate() {
            let replacement = if index == 0 {
                format!("event:{event_id}")
            } else {
                let digest = hash_canonical(&json!({ "location": location_key(node.get("location")), "ordinal": index }));
                format!("event:{event_id}:duplicate:{}", &digest[..16])
            };
            replacements.insert(text(node, "id").to_string(), replacement);
        }
    }
    if replacements.is_empty() {
        return;
    }
    let map = |id: &str| replacements.get(id).cloned().unwrap_or_else(|| id.to_string());
    let set = |value: &mut Value, key: &str| {
        if let Some(current) = text_opt(value, key).map(str::to_string) {
            value[key] = json!(map(&current));
        }
    };
    for node in &mut graph.nodes {
        set(node, "id");
    }
    for edge in &mut graph.edges {
        set(edge, "from");
        set(edge, "to");
    }
    for access in &mut graph.accesses {
        set(access, "ownerId");
    }
    for unresolved in &mut graph.unresolved {
        set(unresolved, "ownerId");
    }
    for issue in &mut graph.issues {
        if let Some(Value::Array(subjects)) = issue.get_mut("details").and_then(|d| d.get_mut("subjectIds")) {
            for subject in subjects {
                if let Some(current) = subject.as_str().map(str::to_string) {
                    *subject = json!(map(&current));
                }
            }
        }
    }
}

/// Resolve file-local call placeholders against the active cross-file definition catalog.
fn normalize_cross_file_edges(graph: &mut G) {
    let targets: HashMap<String, String> =
        definitions(&graph.nodes).into_iter().filter_map(|(event_id, values)| values.first().map(|n| (event_id, text(n, "id").to_string()))).collect();
    let nodes = node_map(&graph.nodes);
    let mut changed: Vec<(usize, Value)> = Vec::new();
    for (index, edge) in graph.edges.iter().enumerate() {
        let target_event_id = edge.get("metadata").and_then(|m| m.get("targetEventId")).and_then(Value::as_str);
        let target = target_event_id.and_then(|id| targets.get(id));
        let from_node = nodes.get(text(edge, "from"));
        let entry_reason = from_node.filter(|n| text(n, "kind") == "entry").and_then(|n| normalized_entry_reason(n));
        let helper_expansion =
            from_node.is_some_and(|n| text(n, "kind") == "helper") && target_event_id.is_some() && text(edge, "reason") != "unresolved_dynamic_reference";
        let reason = if helper_expansion {
            "scripted_effect_expansion"
        } else if let Some(entry) = entry_reason
            && text(edge, "reason") != "scripted_effect_call"
        {
            entry
        } else {
            text(edge, "reason")
        };
        if target.is_none() && reason == text(edge, "reason") {
            continue;
        }
        let mut next = edge.clone();
        if let Some(target) = target {
            next["to"] = json!(target);
        }
        next["reason"] = json!(reason);
        let role = if helper_expansion {
            Some("dispatch")
        } else if entry_reason.is_some() {
            Some("entry")
        } else {
            None
        };
        if let Some(provenance) = next.get_mut("provenance").and_then(Value::as_array_mut) {
            for item in provenance {
                if let (Some(role), Some(map)) = (role, item.as_object_mut()) {
                    map.insert("role".into(), json!(role));
                }
            }
        }
        changed.push((index, next));
    }
    for (index, edge) in changed {
        graph.edges[index] = edge;
    }
}

fn ensure_referenced_nodes(graph: &mut G) {
    let mut known: HashSet<String> = graph.nodes.iter().map(|n| text(n, "id").to_string()).collect();
    for edge in &graph.edges {
        let to = text(edge, "to");
        if known.contains(to) {
            continue;
        }
        let is_event = to.starts_with("event:");
        let is_helper = to.starts_with("helper:");
        if !is_event && !is_helper {
            continue;
        }
        let expression = &to[to.find(':').map_or(0, |at| at + 1)..];
        let kind = if is_event { "missing_event" } else { "missing_helper" };
        let location = edge.get("location").cloned().unwrap_or(Value::Null);
        let mut node = Map::new();
        node.insert("id".into(), json!(to));
        node.insert("kind".into(), json!("unresolved"));
        node.insert("label".into(), json!(format!("Missing {}: {expression}", if is_event { "event" } else { "helper" })));
        if is_event {
            node.insert("eventId".into(), json!(expression));
            let namespace = expression.rfind('.').map_or(expression, |at| &expression[..at]);
            node.insert("namespace".into(), json!(namespace));
        }
        node.insert("sourcePath".into(), json!(text(&location, "path")));
        node.insert("location".into(), location.clone());
        node.insert("metadata".into(), json!({ "expression": expression, "unresolvedKind": kind }));
        graph.nodes.push(Value::Object(node));
        known.insert(to.to_string());
        let digest = short(&json!({ "expression": expression, "ownerId": text(edge, "from"), "location": location_key(Some(&location)) }));
        graph.unresolved.push(json!({
            "id": format!("unresolved:{kind}:{digest}"),
            "kind": kind,
            "expression": expression,
            "ownerId": text(edge, "from"),
            "location": location,
            "confidence": "confirmed",
            "blockers": [blocker(
                if is_event { "MISSING_EVENT" } else { "MISSING_HELPER" },
                &format!("No active {} definition matches the reference.", if is_event { "event" } else { "scripted-effect" }),
                Some(&location),
                None,
            )],
        }));
    }
}

// ---------------------------------------------------------------------------------------------
// Dependency walk
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Record {
    Visit,
    Terminal,
    Cycle,
    Depth,
}

pub(crate) struct Walk {
    /// `(id, from, to)` of every edge.
    edges: Vec<(String, String, String)>,
    /// `(edge index, parent path)`.
    paths: Vec<(usize, Option<usize>)>,
    pub(crate) records: Vec<(Record, usize)>,
    pub(crate) truncated: bool,
    root: usize,
    total_roots: usize,
}

impl Walk {
    /// The edges of a path, root first.
    fn path(&self, index: usize) -> Vec<usize> {
        let mut values = Vec::new();
        let mut cursor = Some(index);
        while let Some(at) = cursor {
            values.push(self.paths[at].0);
            cursor = self.paths[at].1;
        }
        values.reverse();
        values
    }
}

/// A bounded depth-first walk over reversed adjacency, one proof per reachable branch node.
pub(crate) fn walk(edges: Vec<(String, String, String)>, roots: &[String], branches: &HashSet<String>, maximum_depth: usize, maximum_steps: u64) -> Done<Walk> {
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (index, (id, _, _)) in edges.iter().enumerate() {
        by_id.insert(id.as_str(), index);
    }
    if by_id.len() != edges.len() || roots.iter().any(|id| !by_id.contains_key(id.as_str())) {
        return Err(BuildError::Input("Dependency edge identities must be unique and roots must exist".into()));
    }
    let mut outgoing: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, (_, from, _)) in edges.iter().enumerate() {
        outgoing.entry(from.as_str()).or_default().push(index);
    }
    for values in outgoing.values_mut() {
        values.reverse();
    }
    let root_edges: Vec<usize> = roots.iter().map(|id| by_id[id.as_str()]).collect();
    let mut state = Walk { edges: Vec::new(), paths: Vec::new(), records: Vec::new(), truncated: false, root: 0, total_roots: roots.len() };
    let mut complete = roots.is_empty();
    let mut started = false;
    let mut stack: Vec<usize> = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    let mut visited: HashSet<&str> = HashSet::new();
    let mut steps: u64 = 0;
    let record = |state: &mut Walk, kind: Record, path: usize| state.records.push((kind, path));
    while !complete {
        if steps >= maximum_steps {
            state.truncated = true;
            break;
        }
        steps += 1;
        if !started {
            let edge = root_edges[state.root];
            state.paths.push((edge, None));
            stack.push(state.paths.len() - 1);
            visited.clear();
            visited.insert(edges[edge].2.as_str());
            started = true;
            continue;
        }
        let Some((path, cursor)) = current else {
            match stack.pop() {
                None => {
                    state.root += 1;
                    started = false;
                    complete = state.root == roots.len();
                }
                Some(path) => {
                    record(&mut state, Record::Visit, path);
                    current = Some((path, 0));
                }
            }
            continue;
        };
        let node = edges[state.paths[path].0].2.as_str();
        let candidates = outgoing.get(node).map(Vec::as_slice).unwrap_or(&[]);
        current = Some((path, cursor + 1));
        let Some(&edge_index) = candidates.get(cursor) else {
            current = None;
            continue;
        };
        let to = edges[edge_index].2.as_str();
        if !branches.contains(to) {
            state.paths.push((edge_index, Some(path)));
            let added = state.paths.len() - 1;
            record(&mut state, Record::Terminal, added);
            continue;
        }
        let ancestors: Vec<usize> = {
            let mut values = Vec::new();
            let mut at = Some(path);
            while let Some(index) = at {
                values.push(state.paths[index].0);
                at = state.paths[index].1;
            }
            values
        };
        if ancestors.iter().any(|&edge| edges[edge].2 == to) {
            state.paths.push((edge_index, Some(path)));
            let added = state.paths.len() - 1;
            record(&mut state, Record::Cycle, added);
            continue;
        }
        if ancestors.len() >= maximum_depth {
            state.paths.push((edge_index, Some(path)));
            let added = state.paths.len() - 1;
            record(&mut state, Record::Depth, added);
            continue;
        }
        if !visited.insert(to) {
            continue;
        }
        state.paths.push((edge_index, Some(path)));
        stack.push(state.paths.len() - 1);
    }
    state.edges = edges;
    Ok(state)
}

fn helper_name(node: &Value) -> String {
    if let Some(name) = meta_text(node, "name") {
        return name.to_string();
    }
    let label = text(node, "label");
    if label.is_empty() { text(node, "id").strip_prefix("helper:").unwrap_or(text(node, "id")).to_string() } else { label.to_string() }
}

fn helper_caller_scope(nodes: &Nodes<'_>, parents: &HashMap<String, String>, start: &Value) -> String {
    let from = text(start, "from");
    let caller = nodes.get(parents.get(from).map_or(from, String::as_str));
    let candidate = start
        .get("scope")
        .and_then(|s| s.get("source"))
        .filter(|v| !v.is_null())
        .or_else(|| caller.and_then(|c| meta(c, "expectedScope")))
        .or_else(|| caller.and_then(|c| meta(c, "scope")))
        .and_then(Value::as_str);
    match candidate {
        Some(scope @ ("country" | "state" | "unit_leader" | "operative" | "character" | "global")) => scope.to_string(),
        _ => "unknown".to_string(),
    }
}

fn helper_projections(graph: &mut G, budget: &mut Budget, walked: &Walk) -> Done<Vec<Value>> {
    let edges: HashMap<&str, &Value> = graph.edges.iter().map(|edge| (text(edge, "id"), edge)).collect();
    let nodes = node_map(&graph.nodes);
    let parents = option_parents(&graph.edges);
    let mut projected: Vec<Value> = Vec::new();
    let mut projected_keys: HashSet<String> = HashSet::new();
    let mut reported: HashSet<String> = HashSet::new();
    let mut caller_scopes: HashMap<String, String> = HashMap::new();
    for (kind, path) in &walked.records {
        budget.spend("helper_projection")?;
        if *kind == Record::Visit {
            continue;
        }
        let structural: Vec<&Value> = walked.path(*path).into_iter().map(|index| edges[walked.edges[index].0.as_str()]).collect();
        let start = structural[0];
        let final_edge = structural[structural.len() - 1];
        let helpers: Vec<&Value> = structural[..structural.len() - 1].iter().map(|edge| nodes[text(edge, "to")]).collect();
        if matches!(kind, Record::Cycle | Record::Depth) {
            let cycle = *kind == Record::Cycle;
            let chain: Vec<String> = helpers.iter().map(|node| text(node, "id").to_string()).collect();
            let from = chain.iter().position(|id| id == text(final_edge, "to")).unwrap_or(0);
            let members: Vec<String> = chain[from..].to_vec();
            let key = if cycle {
                format!("cycle:{}", sorted_strings(members.clone()).join("\0"))
            } else {
                format!("depth:{}:{}", text(start, "id"), text(final_edge, "to"))
            };
            if !reported.insert(key) {
                continue;
            }
            let location = final_edge.get("location").cloned();
            add_issue(
                &mut graph.issues,
                Spec {
                    code: if cycle { "EVENT_HELPER_CYCLE" } else { "EVENT_HELPER_DEPTH_LIMIT" },
                    classification: "unresolved_analysis",
                    severity: if cycle { "warning" } else { "blocker" },
                    message: (if cycle {
                        "A scripted-effect cycle prevents complete helper expansion."
                    } else {
                        "Scripted-effect expansion reached the fixed nesting ceiling."
                    })
                    .into(),
                    confidence: "unresolved".into(),
                    location: location.clone(),
                    blockers: vec![blocker(
                        if cycle { "HELPER_CYCLE" } else { "HELPER_DEPTH_LIMIT" },
                        if cycle {
                            "Static expansion stopped at the repeated scripted effect."
                        } else {
                            "The helper chain is deeper than the supported static boundary."
                        },
                        location.as_ref(),
                        if cycle { None } else { Some(json!({ "maximumDepth": MAX_HELPER_DEPTH })) },
                    )],
                    subjects: if cycle { members } else { vec![text(start, "from").to_string(), text(final_edge, "to").to_string()] },
                    ..Spec::default()
                },
            );
            continue;
        }
        let projection_key = format!("{}\0{}", text(start, "id"), text(final_edge, "to"));
        if !projected_keys.insert(projection_key) {
            continue;
        }
        if projected.len() >= MAX_HELPER_PROJECTIONS {
            let location = start.get("location").cloned();
            add_issue(
                &mut graph.issues,
                Spec {
                    code: "EVENT_HELPER_PROJECTION_LIMIT",
                    classification: "unresolved_analysis",
                    severity: "blocker",
                    message: "Collapsed helper projection reached its materialization ceiling; structural helper calls remain available.".into(),
                    confidence: "unresolved".into(),
                    location: location.clone(),
                    blockers: vec![blocker(
                        "HELPER_PROJECTION_LIMIT",
                        "Use a bounded helper-expanded trace for paths omitted from the collapsed workspace graph.",
                        location.as_ref(),
                        Some(json!({ "maximum": MAX_HELPER_PROJECTIONS })),
                    )],
                    subjects: vec![text(start, "from").to_string(), text(start, "to").to_string()],
                    ..Spec::default()
                },
            );
            break;
        }
        let caller_scope = caller_scopes.entry(text(start, "id").to_string()).or_insert_with(|| helper_caller_scope(&nodes, &parents, start)).clone();
        let edge_ids: Vec<&str> = structural.iter().map(|edge| text(edge, "id")).collect();
        let digest = short(&json!({ "from": text(start, "from"), "to": text(final_edge, "to"), "edges": edge_ids }));
        let mut edge = Map::new();
        edge.insert("id".into(), json!(format!("edge:helper-projection:{digest}")));
        edge.insert("from".into(), json!(text(start, "from")));
        edge.insert("to".into(), json!(text(final_edge, "to")));
        edge.insert("reason".into(), json!("scripted_effect_expansion"));
        edge.insert("conditions".into(), Value::Array(structural.iter().flat_map(|e| list(e, "conditions").iter().cloned()).collect()));
        edge.insert("helperStack".into(), json!(helpers.iter().map(|n| helper_name(n)).collect::<Vec<_>>()));
        if let Some(location) = start.get("location") {
            edge.insert("location".into(), location.clone());
        }
        edge.insert("provenance".into(), Value::Array(structural.iter().flat_map(|e| list(e, "provenance").iter().cloned()).collect()));
        edge.insert("confidence".into(), json!(worst_confidence(structural.iter().map(|e| text(e, "confidence")))));
        edge.insert("derived".into(), json!(true));
        for key in ["timing", "weight"] {
            if let Some(value) = final_edge.get(key).filter(|v| !v.is_null()) {
                edge.insert(key.into(), value.clone());
            }
        }
        if let Some(scope) = final_edge.get("scope").filter(|v| !v.is_null()) {
            let mut scope = scope.clone();
            if text(&scope, "source") == "unknown" && caller_scope != "unknown" {
                scope["source"] = json!(caller_scope);
                scope["confidence"] = json!("high");
            }
            edge.insert("scope".into(), scope);
        }
        edge.insert("metadata".into(), json!({ "structuralEdgeIds": edge_ids, "terminalDispatchLocation": location_key(final_edge.get("location")) }));
        projected.push(Value::Object(edge));
    }
    Ok(stable_unique(projected))
}

fn project_helper_state_accesses(graph: &mut G, budget: &mut Budget, walked: &Walk) -> Done<Vec<Value>> {
    let nodes = node_map(&graph.nodes);
    let edges: HashMap<&str, &Value> = graph.edges.iter().map(|edge| (text(edge, "id"), edge)).collect();
    let parents = option_parents(&graph.edges);
    let mut accesses: HashMap<&str, Vec<&Value>> = HashMap::new();
    for access in &graph.accesses {
        accesses.entry(text(access, "ownerId")).or_default().push(access);
    }
    let mut projected: Vec<Value> = Vec::new();
    let mut projected_keys: HashSet<String> = HashSet::new();
    let mut caller_scopes: HashMap<String, String> = HashMap::new();
    for (kind, path) in &walked.records {
        if *kind != Record::Visit {
            continue;
        }
        budget.spend("helper_state_projection")?;
        let calls: Vec<&Value> = walked.path(*path).into_iter().map(|index| edges[walked.edges[index].0.as_str()]).collect();
        let start = calls[0];
        let target = text(calls[calls.len() - 1], "to");
        let caller_scope = caller_scopes.entry(text(start, "id").to_string()).or_insert_with(|| helper_caller_scope(&nodes, &parents, start)).clone();
        for access in accesses.get(target).map(Vec::as_slice).unwrap_or(&[]) {
            let key = format!("{}\0{}", text(start, "id"), text(access, "id"));
            if !projected_keys.insert(key) {
                continue;
            }
            if projected.len() >= MAX_HELPER_STATE_PROJECTIONS || graph.accesses.len() + projected.len() >= MAX_STATE_ACCESSES {
                let location = start.get("location").cloned();
                add_issue(
                    &mut graph.issues,
                    Spec {
                        code: "EVENT_HELPER_STATE_PROJECTION_LIMIT",
                        classification: "unresolved_analysis",
                        severity: "blocker",
                        message: "Helper state-flow projection reached its fixed materialization ceiling; structural helper evidence remains available.".into(),
                        confidence: "unresolved".into(),
                        location: location.clone(),
                        blockers: vec![blocker(
                            "HELPER_STATE_PROJECTION_LIMIT",
                            "Use an expanded bounded helper trace for state evidence omitted from the collapsed workspace graph.",
                            location.as_ref(),
                            Some(json!({ "maximum": MAX_HELPER_STATE_PROJECTIONS })),
                        )],
                        subjects: vec![text(start, "from").to_string(), text(start, "to").to_string()],
                        ..Spec::default()
                    },
                );
                return Ok(projected);
            }
            let edge_ids: Vec<&str> = calls.iter().map(|edge| text(edge, "id")).collect();
            let digest = short(&json!({ "caller": text(start, "from"), "access": text(access, "id"), "edges": edge_ids }));
            let mut next = (*access).clone();
            next["id"] = json!(format!("state:helper-projection:{digest}"));
            next["ownerId"] = json!(text(start, "from"));
            if text(access, "scope") == "unknown" {
                next["scope"] = json!(caller_scope);
            }
            next["confidence"] = json!(worst_confidence(std::iter::once(text(access, "confidence")).chain(calls.iter().map(|e| text(e, "confidence")))));
            next["helperStack"] = json!(calls.iter().map(|edge| helper_name(nodes[text(edge, "to")])).collect::<Vec<_>>());
            next["conditions"] =
                Value::Array(calls.iter().flat_map(|e| list(e, "conditions").iter().cloned()).chain(list(access, "conditions").iter().cloned()).collect());
            let mut metadata = access.get("metadata").and_then(Value::as_object).cloned().unwrap_or_default();
            metadata.insert("projectedFromAccessId".into(), json!(text(access, "id")));
            metadata.insert("structuralEdgeIds".into(), json!(edge_ids));
            next["metadata"] = Value::Object(metadata);
            projected.push(next);
        }
    }
    Ok(stable_unique(projected))
}

// ---------------------------------------------------------------------------------------------
// Terminals, flow and state links
// ---------------------------------------------------------------------------------------------

fn fallback_location(node: &Value) -> Value {
    node.get("location").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| {
        json!({
            "path": text_opt(node, "sourcePath").unwrap_or("<event-graph>"),
            "start": { "line": 1, "column": 1, "offset": 0 },
            "end": { "line": 1, "column": 1, "offset": 0 },
            "symbol": text_opt(node, "eventId").unwrap_or_else(|| text(node, "label")),
        })
    })
}

fn add_terminal_nodes(graph: &mut G) {
    let mut known: HashSet<String> = graph.nodes.iter().map(|n| text(n, "id").to_string()).collect();
    let structural_outgoing: HashSet<&str> = graph
        .edges
        .iter()
        .filter(|e| !is_derived(e) && text(e, "reason") != "option_branch" && text(e, "reason") != "terminal")
        .map(|e| text(e, "from"))
        .collect();
    let option_parent = option_parents(&graph.edges);
    let events_with_options: HashSet<&str> = option_parent.values().map(String::as_str).collect();
    let mut candidates: Vec<Value> = graph
        .nodes
        .iter()
        .filter(|node| {
            let id = text(node, "id");
            (text(node, "kind") == "option" && !structural_outgoing.contains(id))
                || (text(node, "kind") == "event" && !events_with_options.contains(id) && !structural_outgoing.contains(id))
        })
        .cloned()
        .collect();
    candidates.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
    let mut new_nodes = Vec::new();
    let mut new_edges = Vec::new();
    let mut new_issues = Vec::new();
    for owner in &candidates {
        let owner_id = text(owner, "id");
        let terminal_id = format!("terminal:{owner_id}");
        if known.insert(terminal_id.clone()) {
            let mut terminal = Map::new();
            terminal.insert("id".into(), json!(terminal_id));
            terminal.insert("kind".into(), json!("terminal"));
            terminal.insert("label".into(), json!(format!("{} exit", text(owner, "label"))));
            for key in ["eventId", "namespace", "sourcePath", "location"] {
                if let Some(value) = owner.get(key).filter(|v| !v.is_null()) {
                    terminal.insert(key.into(), value.clone());
                }
            }
            terminal.insert("metadata".into(), json!({ "ownerId": owner_id }));
            new_nodes.push(Value::Object(terminal));
        }
        let location = fallback_location(owner);
        new_edges.push(json!({
            "id": format!("edge:terminal:{}", short(&json!({ "from": owner_id, "to": terminal_id }))),
            "from": owner_id,
            "to": terminal_id,
            "reason": "terminal",
            "conditions": [],
            "helperStack": [],
            "location": location,
            "provenance": [{ "role": "invocation", "location": location }],
            "confidence": "confirmed",
            "derived": false,
            "metadata": {},
        }));
        if text(owner, "kind") != "option" {
            continue;
        }
        let explicit = meta(owner, "hasEffect").or_else(|| meta(owner, "hasEffects")).or_else(|| meta(owner, "effectCount"));
        let is_zero = |value: &Value| value.as_bool() == Some(false) || value.as_f64() == Some(0.0);
        if !explicit.is_some_and(is_zero) {
            continue;
        }
        add_issue(
            &mut new_issues,
            Spec {
                code: "EVENT_OPTION_DANGLING",
                classification: "design_warning",
                severity: "warning",
                message: "An event option has no visible effect or dispatch.".into(),
                confidence: "confirmed".into(),
                location: owner.get("location").cloned(),
                subjects: vec![option_parent.get(owner_id).cloned().unwrap_or_else(|| owner_id.to_string())],
                ..Spec::default()
            },
        );
    }
    graph.nodes.extend(new_nodes);
    graph.edges.extend(new_edges);
    graph.issues.extend(new_issues);
}

fn collapsed_flow_edges<'a>(nodes: &Nodes<'_>, edges: &'a [Value]) -> Vec<&'a Value> {
    let mut flow: Vec<&Value> = edges
        .iter()
        .filter(|edge| is_derived(edge) || (kind_of(nodes, text(edge, "from")) != Some("helper") && kind_of(nodes, text(edge, "to")) != Some("helper")))
        .collect();
    flow.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
    flow
}

type Owned<'a> = HashMap<String, HashMap<String, &'a Value>>;

fn retain_owner_access<'a>(target: &mut Owned<'a>, key: &str, owner: &str, access: &'a Value) {
    let values = target.entry(key.to_string()).or_default();
    if values.get(owner).is_none_or(|previous| cmp(text(access, "id"), text(previous, "id")).is_lt()) {
        values.insert(owner.to_string(), access);
    }
}

fn state_links_for(graph: &mut G, budget: &mut Budget) -> Done<Vec<Value>> {
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    let flow = collapsed_flow_edges(&nodes, &graph.edges);
    let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
    let mut owner_set: HashSet<String> = HashSet::new();
    for edge in &flow {
        let from = semantic_owner(text(edge, "from"), &nodes, &parent);
        let to = semantic_owner(text(edge, "to"), &nodes, &parent);
        owner_set.insert(from.clone());
        owner_set.insert(to.clone());
        outgoing.entry(from).or_default().push(to);
    }
    for access in &graph.accesses {
        owner_set.insert(semantic_owner(text(access, "ownerId"), &nodes, &parent));
    }
    let owner_ids = sorted_strings(owner_set);
    let owner_index: HashMap<&str, usize> = owner_ids.iter().enumerate().map(|(index, id)| (id.as_str(), index)).collect();
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); owner_ids.len()];
    for (from, targets) in &outgoing {
        let Some(&from_index) = owner_index.get(from.as_str()) else { continue };
        let unique = sorted_strings(targets.iter().cloned());
        adjacency[from_index] = unique.iter().filter_map(|target| owner_index.get(target.as_str()).copied()).collect();
    }
    let words = owner_ids.len().div_ceil(32);
    let maximum_entries = std::cmp::max(1, 134_217_728 / std::cmp::max(4, words * 4));
    let mut cache: HashMap<usize, Vec<u32>> = HashMap::new();
    let mut order: VecDeque<usize> = VecDeque::new();
    let mut queue = vec![0usize; owner_ids.len()];
    let mut reachable = |start: usize, target: usize, budget: &mut Budget| -> Done<bool> {
        let hit = |reached: &[u32]| reached[target >> 5] & (1u32 << (target & 31)) != 0;
        if let Some(cached) = cache.get(&start) {
            return Ok(hit(cached));
        }
        let mut reached = vec![0u32; words];
        reached[start >> 5] |= 1 << (start & 31);
        let (mut head, mut tail) = (0usize, 1usize);
        queue[0] = start;
        while head < tail {
            budget.spend("state_reachability")?;
            let current = queue[head];
            head += 1;
            for &target in &adjacency[current] {
                let mask = 1u32 << (target & 31);
                if reached[target >> 5] & mask != 0 {
                    continue;
                }
                reached[target >> 5] |= mask;
                queue[tail] = target;
                tail += 1;
            }
        }
        let answer = hit(&reached);
        cache.insert(start, reached);
        order.push_back(start);
        while cache.len() > maximum_entries {
            match order.pop_front() {
                Some(oldest) => {
                    cache.remove(&oldest);
                }
                None => break,
            }
        }
        Ok(answer)
    };

    let mut producers: Owned<'_> = HashMap::new();
    let mut consumers: Owned<'_> = HashMap::new();
    for access in &graph.accesses {
        let mode = text(access, "access");
        let key = state_key(access);
        let owner = semantic_owner(text(access, "ownerId"), &nodes, &parent);
        if matches!(mode, "write" | "read_write" | "replace") {
            retain_owner_access(&mut producers, &key, &owner, access);
        }
        if matches!(mode, "read" | "read_write") {
            retain_owner_access(&mut consumers, &key, &owner, access);
        }
    }
    let mut links: Vec<Value> = Vec::new();
    let mut candidate_count = 0usize;
    let mut consumer_keys: Vec<&String> = consumers.keys().collect();
    consumer_keys.sort_by(|a, b| cmp(a, b));
    let mut issues: Vec<Value> = Vec::new();
    for key in consumer_keys {
        let mut reads: Vec<&Value> = consumers[key].values().copied().collect();
        reads.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
        for consumer in reads {
            let writes: Vec<&Value> = {
                let mut found: Vec<&Value> = Vec::new();
                for producer_key in compatible_producer_keys(consumer) {
                    if let Some(values) = producers.get(&producer_key) {
                        found.extend(values.values().copied());
                    }
                }
                let mut seen = HashSet::new();
                found.retain(|value| seen.insert(text(value, "id")));
                found.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
                found
            };
            let consumer_owner = semantic_owner(text(consumer, "ownerId"), &nodes, &parent);
            for producer in &writes {
                candidate_count += 1;
                if candidate_count > MAX_STATE_LINK_CANDIDATES {
                    let location = consumer.get("location").cloned();
                    add_issue(
                        &mut issues,
                        Spec {
                            code: "EVENT_STATE_LINK_ANALYSIS_LIMIT",
                            classification: "unresolved_analysis",
                            severity: "blocker",
                            message: "State-flow candidate analysis reached its fixed work ceiling; accesses remain available for bounded subject queries."
                                .into(),
                            confidence: "unresolved".into(),
                            location: location.clone(),
                            blockers: vec![blocker(
                                "STATE_LINK_ANALYSIS_LIMIT",
                                "Use stateSubject to inspect candidate producers for this value.",
                                location.as_ref(),
                                Some(json!({ "maximum": MAX_STATE_LINK_CANDIDATES })),
                            )],
                            subjects: vec![consumer_owner.clone()],
                            ..Spec::default()
                        },
                    );
                    graph.issues.extend(issues);
                    return Ok(stable_unique(links));
                }
                budget.spend("state_link")?;
                let producer_owner = semantic_owner(text(producer, "ownerId"), &nodes, &parent);
                let confirmed = match (owner_index.get(producer_owner.as_str()), owner_index.get(consumer_owner.as_str())) {
                    (Some(&from), Some(&to)) => reachable(from, to, budget)?,
                    _ => false,
                };
                if !confirmed {
                    continue;
                }
                if links.len() >= MAX_STATE_LINKS {
                    let location = consumer.get("location").cloned();
                    add_issue(
                        &mut issues,
                        Spec {
                            code: "EVENT_STATE_LINK_LIMIT",
                            classification: "unresolved_analysis",
                            severity: "blocker",
                            message:
                                "Confirmed state-flow links reached the fixed materialization ceiling; state accesses remain available for bounded queries."
                                    .into(),
                            confidence: "unresolved".into(),
                            location: location.clone(),
                            blockers: vec![blocker(
                                "STATE_LINK_LIMIT",
                                "Use a stateSubject filter to inspect omitted producer candidates.",
                                location.as_ref(),
                                Some(json!({ "maximum": MAX_STATE_LINKS })),
                            )],
                            subjects: vec![consumer_owner.clone()],
                            ..Spec::default()
                        },
                    );
                    graph.issues.extend(issues);
                    return Ok(stable_unique(links));
                }
                let confidence = if has_unknown_saved_scope_storage(consumer) {
                    "unresolved"
                } else {
                    worst_confidence([text(producer, "confidence"), text(consumer, "confidence")])
                };
                links.push(json!({
                    "id": format!("state-link:{}", short(&json!({ "producer": text(producer, "id"), "consumer": text(consumer, "id") }))),
                    "stateKind": text(consumer, "kind"),
                    "name": text(consumer, "name"),
                    "producerId": text(producer, "id"),
                    "consumerId": text(consumer, "id"),
                    "confidence": confidence,
                    "pathConfirmed": confirmed,
                }));
            }
        }
    }
    graph.issues.extend(issues);
    Ok(stable_unique(links))
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

fn duplicate_and_reference_issues(graph: &mut G) {
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    let mut issues = Vec::new();
    for (event_id, defs) in definitions(&graph.nodes) {
        if defs.len() < 2 {
            continue;
        }
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_DUPLICATE_ID",
                classification: "confirmed_error",
                severity: "error",
                message: format!("Multiple active event definitions use {event_id}."),
                confidence: "confirmed".into(),
                location: defs[0].get("location").cloned(),
                related: Some(defs[1..].iter().filter_map(|d| d.get("location").cloned()).collect()),
                subjects: vec![format!("event:{event_id}")],
                details: details(&[("eventId", json!(event_id)), ("definitionCount", json!(defs.len()))]),
                ..Spec::default()
            },
        );
    }
    for unresolved in &graph.unresolved {
        let kind = text(unresolved, "kind");
        if kind != "missing_event" && kind != "missing_helper" {
            continue;
        }
        let missing_event = kind == "missing_event";
        let owner = text_opt(unresolved, "ownerId").map(|id| semantic_owner(id, &nodes, &parent));
        add_issue(
            &mut issues,
            Spec {
                code: if missing_event { "EVENT_REFERENCE_MISSING" } else { "EVENT_HELPER_UNRESOLVED" },
                classification: if missing_event { "confirmed_error" } else { "unresolved_analysis" },
                severity: if missing_event { "error" } else { "warning" },
                message: if missing_event {
                    format!("A call references missing event {}.", text(unresolved, "expression"))
                } else {
                    format!("A call references unresolved scripted effect {}.", text(unresolved, "expression"))
                },
                confidence: text(unresolved, "confidence").into(),
                location: unresolved.get("location").cloned(),
                blockers: list(unresolved, "blockers").to_vec(),
                subjects: owner.into_iter().collect(),
                details: details(&[("expression", json!(text(unresolved, "expression")))]),
                ..Spec::default()
            },
        );
    }
    graph.issues.extend(issues);
}

fn is_delayed(edge: &Value) -> bool {
    text(edge, "reason") == "delayed_event_call"
        || edge.get("timing").filter(|t| !t.is_null()).is_some_and(|t| !matches!(text(t, "mode"), "immediate" | "unknown"))
}

fn callable_from(event_type: Option<&str>, scope: &Value) -> bool {
    let Some(event_type) = event_type else { return true };
    let source = text(scope, "source");
    match event_type {
        "state_event" => source == "country" || source == "state",
        "unit_leader_event" => source == "character" || source == "unit_leader",
        "operative_leader_event" => source == "character" || source == "operative",
        _ => source == "country",
    }
}

struct Flow<'a> {
    edge: &'a Value,
    from: String,
    to: String,
}

/// Event-to-event flows by semantic owner, ordered by edge id.
fn owner_flows<'a>(nodes: &Nodes<'_>, parent: &HashMap<String, String>, edges: Vec<&'a Value>) -> Vec<Flow<'a>> {
    let mut flows: Vec<Flow<'a>> = edges
        .into_iter()
        .map(|edge| Flow { edge, from: semantic_owner(text(edge, "from"), nodes, parent), to: semantic_owner(text(edge, "to"), nodes, parent) })
        .filter(|flow| kind_of(nodes, &flow.from) == Some("event") && kind_of(nodes, &flow.to) == Some("event"))
        .collect();
    flows.sort_by(|a, b| cmp(text(a.edge, "id"), text(b.edge, "id")));
    flows
}

fn structural_call_issues(graph: &mut G, budget: &mut Budget) -> Done<()> {
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    let mut issues: Vec<Value> = Vec::new();
    let immediate =
        owner_flows(&nodes, &parent, graph.edges.iter().filter(|edge| !is_derived(edge) && text(edge, "reason") == "immediate_event_call").collect());
    for flow in &immediate {
        if flow.from != flow.to {
            continue;
        }
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_IMMEDIATE_SELF_CALL",
                classification: "confirmed_error",
                severity: "error",
                message: "An event immediately calls itself without a visible delay.".into(),
                confidence: text(flow.edge, "confidence").into(),
                location: flow.edge.get("location").cloned(),
                subjects: vec![flow.from.clone()],
                ..Spec::default()
            },
        );
    }
    let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
    for flow in immediate.iter().filter(|flow| flow.from != flow.to) {
        outgoing.entry(flow.from.clone()).or_default().push(flow.to.clone());
    }
    for values in outgoing.values_mut() {
        values.sort_by(|a, b| cmp(a, b));
    }
    let node_ids: Vec<String> = immediate.iter().flat_map(|flow| [flow.from.clone(), flow.to.clone()]).collect();
    let components = strongly_connected(&node_ids, &outgoing, &mut || budget.spend("immediate_cycle"))?;
    for component in components.iter().filter(|c| c.len() > 1) {
        let members: HashSet<&str> = component.iter().map(String::as_str).collect();
        let evidence = immediate.iter().find(|flow| members.contains(flow.from.as_str()) && members.contains(flow.to.as_str())).map(|flow| flow.edge);
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_IMMEDIATE_CYCLE",
                classification: "probable_defect",
                severity: "error",
                message: "An immediate event cycle can recurse without a visible scheduling boundary.".into(),
                confidence: evidence.map_or("high", |edge| text(edge, "confidence")).into(),
                location: evidence.and_then(|edge| edge.get("location").cloned()),
                subjects: component.clone(),
                ..Spec::default()
            },
        );
    }

    let collapsed = owner_flows(
        &nodes,
        &parent,
        collapsed_flow_edges(&nodes, &graph.edges).into_iter().filter(|edge| !matches!(text(edge, "reason"), "terminal" | "option_branch")).collect(),
    );
    let mut cyclic_outgoing: HashMap<String, Vec<String>> = HashMap::new();
    for flow in &collapsed {
        cyclic_outgoing.entry(flow.from.clone()).or_default().push(flow.to.clone());
    }
    for values in cyclic_outgoing.values_mut() {
        values.sort_by(|a, b| cmp(a, b));
    }
    let node_ids: Vec<String> = collapsed.iter().flat_map(|flow| [flow.from.clone(), flow.to.clone()]).collect();
    let flow_components = strongly_connected(&node_ids, &cyclic_outgoing, &mut || budget.spend("event_cycle"))?;
    let mut component_of: HashMap<&str, usize> = HashMap::new();
    for (index, component) in flow_components.iter().enumerate() {
        for member in component {
            component_of.insert(member.as_str(), index);
        }
    }
    let mut internal: HashMap<usize, Vec<&Flow<'_>>> = HashMap::new();
    for flow in &collapsed {
        let Some(&component) = component_of.get(flow.from.as_str()) else { continue };
        if component_of.get(flow.to.as_str()) != Some(&component) {
            continue;
        }
        internal.entry(component).or_default().push(flow);
    }
    for (index, component) in flow_components.iter().enumerate() {
        let edges = internal.get(&index).map(Vec::as_slice).unwrap_or(&[]);
        let cyclic = component.len() > 1 || edges.iter().any(|flow| flow.from == flow.to);
        if !cyclic {
            continue;
        }
        if edges.iter().all(|flow| text(flow.edge, "reason") == "immediate_event_call" && list(flow.edge, "conditions").is_empty()) {
            continue;
        }
        let gated = edges.iter().any(|flow| {
            let edge = flow.edge;
            let probabilistic = matches!(text(edge, "reason"), "random_event_call" | "weighted_event_call") || edge.get("weight").is_some_and(|w| !w.is_null());
            is_delayed(edge) || probabilistic || !list(edge, "conditions").is_empty()
        });
        if gated {
            continue;
        }
        let evidence = edges.first().map(|flow| flow.edge);
        let location = evidence.and_then(|edge| edge.get("location").cloned());
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_CYCLE_GUARD_UNRESOLVED",
                classification: "unresolved_analysis",
                severity: "warning",
                message: "A cyclic event route has no statically visible gate, delay, or random boundary.".into(),
                confidence: "low".into(),
                location: location.clone(),
                blockers: vec![blocker(
                    "CYCLE_GUARD_NOT_PROVEN",
                    "Static analysis cannot establish a scheduling or gating boundary for the cycle.",
                    location.as_ref(),
                    None,
                )],
                subjects: component.clone(),
                ..Spec::default()
            },
        );
    }

    for edge in graph.edges.iter().filter(|edge| !is_derived(edge) && edge.get("weight").and_then(|w| w.get("valid")).and_then(Value::as_bool) == Some(false)) {
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_RANDOM_WEIGHT_INVALID",
                classification: "confirmed_error",
                severity: "error",
                message: "A random event branch has a missing or invalid weight.".into(),
                confidence: text(edge, "confidence").into(),
                location: edge.get("location").cloned(),
                subjects: vec![semantic_owner(text(edge, "from"), &nodes, &parent)],
                details: details(&[
                    ("edgeId", json!(text(edge, "id"))),
                    ("value", edge.get("weight").and_then(|w| w.get("value")).cloned().unwrap_or(json!(""))),
                ]),
                ..Spec::default()
            },
        );
    }

    for edge in &graph.edges {
        if is_derived(edge) {
            continue;
        }
        let Some(scope) = edge.get("scope").filter(|s| !s.is_null()) else { continue };
        if text(scope, "source") == "unknown" || text(scope, "destination") == "unknown" {
            continue;
        }
        let destination = nodes.get(text(edge, "to"));
        let event_type = destination.filter(|d| text(d, "kind") == "event").and_then(|d| meta_text(d, "eventType"));
        if callable_from(event_type, scope) {
            continue;
        }
        let owner = semantic_owner(text(edge, "from"), &nodes, &parent);
        if kind_of(&nodes, &owner) == Some("entry") {
            continue;
        }
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_SCOPE_MISMATCH",
                classification: "probable_defect",
                severity: "warning",
                message: format!(
                    "An event call expects {} scope from {} scope without a visible transition.",
                    text(scope, "destination"),
                    text(scope, "source")
                ),
                confidence: text(scope, "confidence").into(),
                location: edge.get("location").cloned(),
                subjects: vec![owner],
                details: details(&[
                    ("edgeId", json!(text(edge, "id"))),
                    ("source", json!(text(scope, "source"))),
                    ("destination", json!(text(scope, "destination"))),
                ]),
                ..Spec::default()
            },
        );
    }
    graph.issues.extend(issues);
    Ok(())
}

fn is_key_text(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'@' | b'-'))
}

fn localisation_keys(node: &Value) -> Vec<String> {
    let mut candidates: Vec<&Value> =
        ["titleKey", "descriptionKey", "descKey", "nameKey", "localisationKey"].iter().filter_map(|key| meta(node, key)).collect();
    if let Some(Value::Array(items)) = meta(node, "localisationKeys") {
        candidates.extend(items.iter());
    }
    sorted_strings(candidates.into_iter().filter_map(Value::as_str).filter(|s| is_key_text(s)).map(str::to_string))
}

fn localisation_issues(graph: &mut G) {
    let available: HashSet<&str> = graph.localisation.iter().map(|record| text(record, "key")).collect();
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    struct Missing {
        keys: HashSet<String>,
        fields: HashSet<String>,
        locations: Vec<Value>,
    }
    let mut by_owner: HashMap<String, Missing> = HashMap::new();
    for node in graph.nodes.iter().filter(|n| matches!(text(n, "kind"), "event" | "option")) {
        let owner = semantic_owner(text(node, "id"), &nodes, &parent);
        if let Some(owner_node) = nodes.get(owner.as_str())
            && text(owner_node, "kind") == "event"
            && meta(owner_node, "hidden").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let missing: Vec<String> = localisation_keys(node).into_iter().filter(|key| !available.contains(key.as_str())).collect();
        let mut fields: Vec<&str> = Vec::new();
        if text(node, "kind") == "event" {
            if meta(node, "hasTitle").and_then(Value::as_bool) != Some(true) {
                fields.push("title");
            }
            if meta(node, "hasDescription").and_then(Value::as_bool) != Some(true) {
                fields.push("description");
            }
        } else if meta(node, "hasName").and_then(Value::as_bool) != Some(true) {
            fields.push("option_name");
        }
        if missing.is_empty() && fields.is_empty() {
            continue;
        }
        let record = by_owner.entry(owner).or_insert_with(|| Missing { keys: HashSet::new(), fields: HashSet::new(), locations: Vec::new() });
        record.keys.extend(missing);
        record.fields.extend(fields.into_iter().map(str::to_string));
        if let Some(location) = node.get("location").filter(|l| !l.is_null()) {
            record.locations.push(location.clone());
        }
    }
    let mut owners: Vec<(String, Missing)> = by_owner.into_iter().collect();
    owners.sort_by(|(a, _), (b, _)| cmp(a, b));
    for (owner, mut record) in owners {
        record.locations.sort_by(|a, b| cmp(&location_key(Some(a)), &location_key(Some(b))));
        add_issue(
            &mut graph.issues,
            Spec {
                code: "EVENT_LOCALISATION_MISSING",
                classification: "probable_defect",
                severity: "warning",
                message: "A visible event or option is missing required localisation fields or referenced keys.".into(),
                confidence: "high".into(),
                location: record.locations.first().cloned(),
                related: Some(record.locations.iter().skip(1).cloned().collect()),
                subjects: vec![owner],
                details: details(&[("missingKeys", json!(sorted_strings(record.keys))), ("missingFields", json!(sorted_strings(record.fields)))]),
                ..Spec::default()
            },
        );
    }
}

fn unresolved_issues(graph: &mut G) {
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    let mut issues = Vec::new();
    for unresolved in &graph.unresolved {
        let kind = text(unresolved, "kind");
        if kind != "dynamic_event" && kind != "dynamic_helper" {
            continue;
        }
        let owner = text_opt(unresolved, "ownerId").map(|id| semantic_owner(id, &nodes, &parent));
        let dynamic_event = kind == "dynamic_event";
        add_issue(
            &mut issues,
            Spec {
                code: if dynamic_event { "EVENT_DYNAMIC_DISPATCH_UNRESOLVED" } else { "EVENT_HELPER_UNRESOLVED" },
                classification: "unresolved_analysis",
                severity: "warning",
                message: (if dynamic_event {
                    "A dynamic event expression cannot be resolved statically."
                } else {
                    "A dynamic scripted-effect call cannot be resolved statically."
                })
                .into(),
                confidence: "unresolved".into(),
                location: unresolved.get("location").cloned(),
                blockers: list(unresolved, "blockers").to_vec(),
                subjects: owner.into_iter().collect(),
                details: details(&[("expression", json!(text(unresolved, "expression")))]),
                ..Spec::default()
            },
        );
    }
    graph.issues.extend(issues);
}

fn state_lifecycle_issues(graph: &mut G, links: &[Value], budget: &mut Budget) -> Done<()> {
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    let mut producers: HashMap<String, Vec<&Value>> = HashMap::new();
    let mut clearers: HashMap<String, Vec<&Value>> = HashMap::new();
    let by_id: HashMap<&str, &Value> = graph.accesses.iter().map(|a| (text(a, "id"), a)).collect();
    for access in &graph.accesses {
        let key = state_key(access);
        match text(access, "access") {
            "write" | "read_write" | "replace" => producers.entry(key.clone()).or_default().push(access),
            _ => {}
        }
        if text(access, "access") == "clear" {
            clearers.entry(key).or_default().push(access);
        }
    }
    let mut presence: HashMap<String, Vec<&Value>> = HashMap::new();
    for access in &graph.accesses {
        if meta(access, "presence").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        presence.entry(format!("{}\u{0}{}", text(access, "ownerId"), state_key(access))).or_default().push(access);
    }
    let guarded = |access: &Value| -> bool {
        presence.get(&format!("{}\u{0}{}", text(access, "ownerId"), state_key(access))).is_some_and(|checks| {
            let location = access.get("location").unwrap_or(&Value::Null);
            checks.iter().any(|check| {
                let at = check.get("location").unwrap_or(&Value::Null);
                text(at, "path") == text(location, "path") && offset(at, false) < offset(location, true)
            })
        })
    };
    let mut issues: Vec<Value> = Vec::new();
    for access in &graph.accesses {
        if !matches!(text(access, "access"), "read" | "read_write") {
            continue;
        }
        if compatible_producer_keys(access).iter().any(|key| producers.get(key).is_some_and(|v| !v.is_empty())) {
            continue;
        }
        let owner = semantic_owner(text(access, "ownerId"), &nodes, &parent);
        let kind = text(access, "kind");
        if matches!(kind, "event_target" | "global_event_target" | "saved_scope") && meta(access, "presence").and_then(Value::as_bool) != Some(true) {
            if guarded(access) {
                continue;
            }
            add_issue(
                &mut issues,
                Spec {
                    code: "EVENT_TARGET_READ_BEFORE_SAVE",
                    classification: "probable_defect",
                    severity: "warning",
                    message: format!("The {} {} is read without a visible producer.", kind.replace('_', " "), text(access, "name")),
                    confidence: text(access, "confidence").into(),
                    location: access.get("location").cloned(),
                    subjects: vec![owner],
                    details: details(&[("stateKind", json!(kind)), ("name", json!(text(access, "name"))), ("accessId", json!(text(access, "id")))]),
                    ..Spec::default()
                },
            );
            continue;
        }
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_GATE_WITHOUT_WRITER",
                classification: "design_warning",
                severity: "warning",
                message: format!("The branch reads {} {} without a visible writer.", kind.replace('_', " "), text(access, "name")),
                confidence: text(access, "confidence").into(),
                location: access.get("location").cloned(),
                subjects: vec![owner],
                details: details(&[("stateKind", json!(kind)), ("name", json!(text(access, "name"))), ("accessId", json!(text(access, "id")))]),
                ..Spec::default()
            },
        );
    }
    let mut writes_by_key: Vec<(&String, &Vec<&Value>)> = producers.iter().collect();
    writes_by_key.sort_by(|(a, _), (b, _)| cmp(a, b));
    for (key, writes) in writes_by_key {
        if !key.starts_with("global_event_target:")
            || clearers.get(key).is_some_and(|v| !v.is_empty())
            || clearers.get("global_event_target:*").is_some_and(|v| !v.is_empty())
        {
            continue;
        }
        let mut ordered: Vec<&Value> = writes.clone();
        ordered.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_GLOBAL_TARGET_WITHOUT_CLEANUP",
                classification: "design_warning",
                severity: "warning",
                message: "A global event target is saved without a visible cleanup.".into(),
                confidence: worst_confidence(ordered.iter().map(|a| text(a, "confidence"))).into(),
                location: ordered[0].get("location").cloned(),
                related: Some(ordered.iter().skip(1).filter_map(|a| a.get("location").cloned()).collect()),
                subjects: ordered.iter().map(|a| semantic_owner(text(a, "ownerId"), &nodes, &parent)).collect(),
                details: details(&[("name", json!(&key["global_event_target:".len()..]))]),
                ..Spec::default()
            },
        );
    }

    let flow = collapsed_flow_edges(&nodes, &graph.edges);
    let mut outgoing: HashMap<String, Vec<(String, bool)>> = HashMap::new();
    for edge in flow {
        let from = semantic_owner(text(edge, "from"), &nodes, &parent);
        let to = semantic_owner(text(edge, "to"), &nodes, &parent);
        outgoing.entry(from).or_default().push((to, is_delayed(edge)));
    }
    for values in outgoing.values_mut() {
        values.sort_by(|a, b| cmp(&a.0, &b.0));
    }
    let mut delayed_cache: HashMap<String, bool> = HashMap::new();
    let mut has_delayed_path = |from: &str, to: &str, budget: &mut Budget| -> Done<bool> {
        let key = format!("{from}\0{to}");
        if let Some(&cached) = delayed_cache.get(&key) {
            return Ok(cached);
        }
        let mut queue: Vec<(String, bool)> = vec![(from.to_string(), false)];
        let mut visited: HashSet<String> = HashSet::from([format!("{from}:false")]);
        let mut at = 0;
        while at < queue.len() {
            budget.spend("delayed_state_path")?;
            let (current, current_delayed) = queue[at].clone();
            at += 1;
            for (next, edge_delayed) in outgoing.get(&current).map(Vec::as_slice).unwrap_or(&[]) {
                let delayed = current_delayed || *edge_delayed;
                if next == to && delayed {
                    delayed_cache.insert(key, true);
                    return Ok(true);
                }
                if visited.insert(format!("{next}:{delayed}")) {
                    queue.push((next.clone(), delayed));
                }
            }
        }
        delayed_cache.insert(key, false);
        Ok(false)
    };
    for link in links {
        if text(link, "stateKind") != "event_target" || link.get("pathConfirmed").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let (Some(producer), Some(consumer)) = (by_id.get(text(link, "producerId")), by_id.get(text(link, "consumerId"))) else { continue };
        let producer_owner = semantic_owner(text(producer, "ownerId"), &nodes, &parent);
        let consumer_owner = semantic_owner(text(consumer, "ownerId"), &nodes, &parent);
        if !has_delayed_path(&producer_owner, &consumer_owner, budget)? {
            continue;
        }
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_DELAYED_TRANSIENT_CONTEXT",
                classification: "probable_defect",
                severity: "warning",
                message: "A delayed event route reads a regular event target whose context may not persist.".into(),
                confidence: worst_confidence([text(producer, "confidence"), text(consumer, "confidence")]).into(),
                location: consumer.get("location").cloned(),
                related: Some(producer.get("location").cloned().into_iter().collect()),
                subjects: vec![producer_owner, consumer_owner],
                details: details(&[("name", json!(text(link, "name"))), ("stateLinkId", json!(text(link, "id")))]),
                ..Spec::default()
            },
        );
    }
    graph.issues.extend(issues);
    Ok(())
}

fn unreachable_issues(graph: &mut G, budget: &mut Budget) -> Done<()> {
    let nodes = node_map(&graph.nodes);
    let flow = collapsed_flow_edges(&nodes, &graph.edges);
    let roots = sorted_strings(
        graph
            .nodes
            .iter()
            .filter(|node| {
                text(node, "kind") == "entry"
                    || (text(node, "kind") == "event"
                        && (matches!(meta(node, "isTriggeredOnly"), Some(Value::Bool(false))) || meta_text(node, "isTriggeredOnly") == Some("no")))
            })
            .map(|node| text(node, "id").to_string()),
    );
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &flow {
        outgoing.entry(text(edge, "from")).or_default().push(text(edge, "to"));
    }
    for values in outgoing.values_mut() {
        values.sort_by(|a, b| cmp(a, b));
    }
    let mut reachable: HashSet<&str> = roots.iter().map(String::as_str).collect();
    let mut queue: Vec<&str> = roots.iter().map(String::as_str).collect();
    let mut at = 0;
    while at < queue.len() {
        budget.spend("unreachable_analysis")?;
        let current = queue[at];
        at += 1;
        for next in outgoing.get(current).map(Vec::as_slice).unwrap_or(&[]) {
            if reachable.insert(next) {
                queue.push(next);
            }
        }
    }
    let mut missing: Vec<&Value> = graph.nodes.iter().filter(|n| text(n, "kind") == "event" && !reachable.contains(text(n, "id"))).collect();
    missing.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
    let mut issues = Vec::new();
    for node in missing {
        add_issue(
            &mut issues,
            Spec {
                code: "EVENT_UNREACHABLE_IN_SELECTION",
                classification: "design_warning",
                severity: "warning",
                message: "An event has no statically discovered caller or root entry point.".into(),
                confidence: "high".into(),
                location: node.get("location").cloned(),
                subjects: vec![text(node, "id").to_string()],
                ..Spec::default()
            },
        );
    }
    graph.issues.extend(issues);
    Ok(())
}

fn normalize_issue_subjects(graph: &mut G) {
    let nodes = node_map(&graph.nodes);
    let parent = option_parents(&graph.edges);
    for issue in &mut graph.issues {
        let Some(Value::Array(subjects)) = issue.get("details").and_then(|d| d.get("subjectIds")) else {
            continue;
        };
        let mapped: Vec<String> = subjects.iter().filter_map(Value::as_str).map(|id| semantic_owner(id, &nodes, &parent)).collect();
        let kept: Vec<String> = mapped
            .iter()
            .filter(|id| kind_of(&nodes, id) != Some("unresolved") || !mapped.iter().any(|candidate| kind_of(&nodes, candidate) != Some("unresolved")))
            .cloned()
            .collect();
        issue["details"]["subjectIds"] = json!(sorted_strings(kept));
    }
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

fn partial_inventory(input: &Input) -> (Vec<Value>, Vec<Value>) {
    if input.complete {
        return (Vec::new(), Vec::new());
    }
    let skipped: Vec<Value> = input
        .skipped_sources
        .iter()
        .take(16)
        .map(|source| json!({ "path": source.get("path").cloned().unwrap_or(Value::Null), "reasonCodes": source.get("reasonCodes").cloned().unwrap_or(Value::Null) }))
        .collect();
    let diagnostic = json!({
        "code": "EVENT_INVENTORY_PARTIAL",
        "severity": "blocker",
        "category": "reference",
        "message": "Event-chain analysis is partial because the shared source inventory is incomplete.",
        "details": {
            "skippedSourceCount": input.skipped_source_count,
            "retainedSkippedSources": input.skipped_sources.len(),
            "skippedSources": skipped,
        },
    });
    let digest = short(&json!({ "revision": input.revision, "skipped": input.skipped_source_count }));
    let unresolved = json!({
        "id": format!("unresolved:partial-source:{digest}"),
        "kind": "partial_source",
        "expression": format!("{} skipped source(s)", input.skipped_source_count),
        "confidence": "unresolved",
        "blockers": [{
            "code": "PARTIAL_SOURCE_INVENTORY",
            "message": "A skipped or over-limit source can contain additional definitions or calls.",
            "details": { "skippedSourceCount": input.skipped_source_count },
        }],
    });
    (vec![diagnostic], vec![unresolved])
}

fn sort_nodes(values: &mut [Value]) {
    values.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")).then_with(|| cmp(&location_key(a.get("location")), &location_key(b.get("location")))));
}

fn severity_order(value: &str) -> u8 {
    match value {
        "blocker" => 0,
        "error" => 1,
        "warning" => 2,
        _ => 3,
    }
}

fn sort_diagnostics(mut values: Vec<Value>) -> Vec<Value> {
    values.sort_by(|a, b| {
        severity_order(text(a, "severity"))
            .cmp(&severity_order(text(b, "severity")))
            .then_with(|| cmp(a.get("location").map_or("", |l| text(l, "path")), b.get("location").map_or("", |l| text(l, "path"))))
            .then_with(|| a.get("location").map_or(0, |l| offset(l, false)).cmp(&b.get("location").map_or(0, |l| offset(l, false))))
            .then_with(|| cmp(text(a, "code"), text(b, "code")))
    });
    values
}

fn statistics(nodes: &[Value], edges: &[Value], accesses: &[Value], issues: &[Value]) -> Value {
    let count = |kind: &str| nodes.iter().filter(|node| text(node, "kind") == kind).count();
    json!({
        "eventCount": count("event"),
        "optionCount": count("option"),
        "entryCount": count("entry"),
        "helperCount": count("helper"),
        "unresolvedNodeCount": count("unresolved"),
        "terminalCount": count("terminal"),
        "edgeCount": edges.len(),
        "derivedEdgeCount": edges.iter().filter(|e| is_derived(e)).count(),
        "stateAccessCount": accesses.len(),
        "issueCount": issues.len(),
    })
}

/// The graph and the wall time of each phase, in milliseconds.
pub struct Built {
    pub graph: Value,
    pub timings: Vec<(&'static str, u64)>,
}

/// Build the event semantic graph from the fragments of the active files, leaving the input intact.
pub fn build_graph(input: &Input) -> Done<Value> {
    build_owned(input.clone()).map(|built| built.graph)
}

/// Build the event semantic graph, consuming the fragments so no copy of them is kept.
pub fn build_owned(mut input: Input) -> Done<Built> {
    let mut budget = Budget::default();
    let mut timings: Vec<(&'static str, u64)> = Vec::new();
    let mut clock = std::time::Instant::now();
    let mut mark = |name: &'static str| {
        timings.push((name, clock.elapsed().as_millis() as u64));
        clock = std::time::Instant::now();
    };
    let mut fragments = std::mem::take(&mut input.fragments);
    fragments.sort_by(|a, b| cmp(text(a, "sourcePath"), text(b, "sourcePath")).then_with(|| cmp(text(a, "sourceHash"), text(b, "sourceHash"))));
    let mut graph = merge_fragments(fragments);
    let input = &input;
    mark("merge");
    let (partial_diagnostics, partial_unresolved) = partial_inventory(input);
    graph.unresolved.extend(partial_unresolved);

    let limits = |graph: &G| -> Done<()> {
        assert_limit(graph.nodes.len(), MAX_NODES, "EVENT_NODE_LIMIT", "node count")?;
        assert_limit(graph.edges.len(), MAX_EDGES, "EVENT_EDGE_LIMIT", "edge count")?;
        assert_limit(graph.accesses.len(), MAX_STATE_ACCESSES, "EVENT_STATE_ACCESS_LIMIT", "state-access count")?;
        assert_limit(graph.unresolved.len(), MAX_UNRESOLVED, "EVENT_UNRESOLVED_LIMIT", "unresolved-analysis count")
    };
    limits(&graph)?;

    normalize_public_event_node_ids(&mut graph);
    normalize_cross_file_edges(&mut graph);
    ensure_referenced_nodes(&mut graph);
    mark("normalize");
    if input.project_helpers {
        let nodes = node_map(&graph.nodes);
        let mut walk_edges: Vec<&Value> = graph.edges.iter().filter(|edge| !is_derived(edge)).collect();
        walk_edges.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
        let roots: Vec<String> = walk_edges
            .iter()
            .filter(|edge| kind_of(&nodes, text(edge, "to")) == Some("helper") && kind_of(&nodes, text(edge, "from")) != Some("helper"))
            .map(|edge| text(edge, "id").to_string())
            .collect();
        let branches: HashSet<String> = graph.nodes.iter().filter(|n| text(n, "kind") == "helper").map(|n| text(n, "id").to_string()).collect();
        let triples: Vec<(String, String, String)> =
            walk_edges.iter().map(|e| (text(e, "id").to_string(), text(e, "from").to_string(), text(e, "to").to_string())).collect();
        let walked = walk(triples, &roots, &branches, MAX_HELPER_DEPTH, WORK_LIMIT)?;
        if walked.truncated {
            add_issue(
                &mut graph.issues,
                Spec {
                    code: "EVENT_HELPER_PROJECTION_LIMIT",
                    classification: "unresolved_analysis",
                    severity: "blocker",
                    message: "Helper expansion reached its fixed work ceiling; helper calls from the remaining roots stay structural.".into(),
                    confidence: "unresolved".into(),
                    blockers: vec![blocker(
                        "HELPER_PROJECTION_LIMIT",
                        "Select a namespace, event or file, or use helper_expansion mode, for paths beyond the ceiling.",
                        None,
                        Some(json!({ "maximum": WORK_LIMIT, "completedRoots": walked.root, "totalRoots": walked.total_roots })),
                    )],
                    details: details(&[("completedRoots", json!(walked.root)), ("totalRoots", json!(walked.total_roots))]),
                    ..Spec::default()
                },
            );
        }
        let projections = helper_projections(&mut graph, &mut budget, &walked)?;
        graph.edges.extend(projections);
        let accesses = project_helper_state_accesses(&mut graph, &mut budget, &walked)?;
        graph.accesses.extend(accesses);
    }
    mark("helpers");
    add_terminal_nodes(&mut graph);

    sort_nodes(&mut graph.nodes);
    graph.edges = stable_unique(std::mem::take(&mut graph.edges));
    graph.accesses = stable_unique(std::mem::take(&mut graph.accesses));
    graph.unresolved = stable_unique(std::mem::take(&mut graph.unresolved));
    if input.focused {
        graph.unresolved.push(json!({
            "id": "event-analysis-focused-boundary",
            "kind": "partial_source",
            "expression": "workspace-wide event helper projections and lifecycle diagnostics",
            "confidence": "unresolved",
            "blockers": [{
                "code": "EVENT_FOCUSED_ANALYSIS_DEFERRED",
                "message": "Large event workspaces defer workspace-wide helper projections and lifecycle passes; direct source evidence remains available.",
            }],
        }));
    }
    mark("terminals and sorting");
    let links = if input.focused { Vec::new() } else { state_links_for(&mut graph, &mut budget)? };
    mark("state links");
    if !input.focused {
        duplicate_and_reference_issues(&mut graph);
        unresolved_issues(&mut graph);
        structural_call_issues(&mut graph, &mut budget)?;
        mark("call findings");
        localisation_issues(&mut graph);
        state_lifecycle_issues(&mut graph, &links, &mut budget)?;
        mark("state findings");
        unreachable_issues(&mut graph, &mut budget)?;
        normalize_issue_subjects(&mut graph);
    }
    graph.issues = stable_issues(std::mem::take(&mut graph.issues));
    mark("other findings");

    limits(&graph)?;
    assert_limit(links.len(), MAX_STATE_LINKS, "EVENT_STATE_LINK_LIMIT", "state-link count")?;
    assert_limit(graph.issues.len(), MAX_ISSUES, "EVENT_ISSUE_LIMIT", "issue count")?;

    let mut diagnostics = input.diagnostics.clone();
    diagnostics.extend(partial_diagnostics);
    let diagnostics = sort_diagnostics(diagnostics);
    let complete = !input.focused
        && input.complete
        && !graph
            .issues
            .iter()
            .any(|issue| matches!(text(issue, "code"), "EVENT_HELPER_DEPTH_LIMIT" | "EVENT_HELPER_PROJECTION_LIMIT" | "EVENT_HELPER_STATE_PROJECTION_LIMIT"));
    // Already sorted and unique above; the sorts are idempotent, so nothing is repeated here.
    let G { nodes, edges, accesses, issues, unresolved, .. } = graph;
    let mut source_hashes = Map::new();
    let mut files = input.files.clone();
    files.sort_by(|a, b| cmp(&a.0, &b.0));
    for (path, hash) in &files {
        source_hashes.insert(path.clone(), json!(hash));
    }
    let statistics = statistics(&nodes, &edges, &accesses, &issues);
    let identity = input.workspace_identity.clone().unwrap_or_else(|| hash_canonical(&json!({ "workspaceId": input.workspace_id })));
    // The big lists move into the result; `json!` would copy every one of them.
    let mut graph = Map::new();
    graph.insert("schemaVersion".into(), json!(1));
    graph.insert("parserVersion".into(), json!("clausewitz-cst.v1"));
    graph.insert("analysisMode".into(), json!(if input.focused { "focused" } else { "full" }));
    graph.insert("workspaceId".into(), json!(input.workspace_id));
    graph.insert("workspaceIdentity".into(), json!(identity));
    graph.insert("revision".into(), json!(input.revision));
    graph.insert("complete".into(), json!(complete));
    graph.insert("sourceHashes".into(), Value::Object(source_hashes));
    graph.insert("filesScanned".into(), json!(files.iter().map(|(path, _)| path.clone()).collect::<Vec<_>>()));
    graph.insert("skippedSourceCount".into(), json!(input.skipped_source_count));
    graph.insert("skippedSources".into(), Value::Array(input.skipped_sources.clone()));
    graph.insert("nodes".into(), Value::Array(nodes));
    graph.insert("edges".into(), Value::Array(edges));
    graph.insert("stateAccesses".into(), Value::Array(accesses));
    graph.insert("stateLinks".into(), Value::Array(links));
    graph.insert("issues".into(), Value::Array(issues));
    graph.insert("diagnostics".into(), Value::Array(diagnostics));
    graph.insert("unresolved".into(), Value::Array(unresolved));
    graph.insert("statistics".into(), statistics);
    let graph = Value::Object(graph);
    mark("assemble");
    Ok(Built { graph, timings })
}

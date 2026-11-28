//! The event graph queries: node selection, roots, trace, route explanation, state flow, findings
//! selection and impact.
//!
//! Adapted from `src/hoi4_agent_tools/event/queries.ts` at the port branch. The graph stays a
//! `serde_json::Value` (as `event.graph` built it), so every node, edge and access reaches the
//! report exactly as the build made it. The typed [`Graph`] view feeds the graph algorithms.

use std::collections::{BTreeMap, HashMap, HashSet};

use hoi4_core::canonical::compare_code_units as cmp;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::algorithms::{self, Boundary, Component, Direction, PathOptions, WorkBlocked};
use crate::graph::Graph;
use crate::graph_build::{list, location_key, meta, offset, text, text_opt};
use crate::state_keys::{compatible_producer_keys, has_unknown_saved_scope_storage, state_key};

/// `EventFeatureManifest`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub event_ids: Option<Vec<String>>,
    #[serde(default)]
    pub namespaces: Option<Vec<String>>,
    #[serde(default)]
    pub source_paths: Option<Vec<String>>,
    #[serde(default)]
    pub node_ids: Option<Vec<String>>,
}

/// `EventSelector`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Selector {
    Event {
        #[serde(rename = "eventId")]
        event_id: String,
    },
    Namespace {
        namespace: String,
    },
    File {
        #[serde(rename = "sourcePath")]
        source_path: String,
    },
    Source {
        #[serde(rename = "sourcePath")]
        source_path: String,
        line: i64,
        #[serde(default)]
        column: Option<i64>,
    },
    Node {
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    Manifest {
        manifest: Manifest,
    },
}

/// `EventImpactSubject`.
#[derive(Debug, Clone, Deserialize)]
pub struct ImpactSubject {
    pub kind: String,
    pub name: String,
}

/// The graph a query reads: the value as built and the typed nodes and edges the algorithms use.
pub struct Query<'a> {
    pub graph: &'a Value,
    pub typed: Graph,
}

pub type Failed = WorkBlocked;

impl<'a> Query<'a> {
    pub fn new(graph: &'a Value) -> Result<Query<'a>, serde_json::Error> {
        let typed = Graph { nodes: serde_json::from_value(graph["nodes"].clone())?, edges: serde_json::from_value(graph["edges"].clone())? };
        Ok(Query { graph, typed })
    }

    pub fn nodes(&self) -> &'a [Value] {
        list(self.graph, "nodes")
    }

    pub fn edges(&self) -> &'a [Value] {
        list(self.graph, "edges")
    }

    pub fn accesses(&self) -> &'a [Value] {
        list(self.graph, "stateAccesses")
    }

    pub fn issues(&self) -> &'a [Value] {
        list(self.graph, "issues")
    }

    pub fn unresolved(&self) -> &'a [Value] {
        list(self.graph, "unresolved")
    }

    pub fn node_by_id(&self) -> HashMap<&'a str, &'a Value> {
        self.nodes().iter().map(|node| (text(node, "id"), node)).collect()
    }
}

fn sort_by_id(values: &mut [&Value]) {
    values.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
}

fn sorted_ids(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut list: Vec<String> = ids.into_iter().collect();
    list.sort_by(|a, b| cmp(a, b));
    list
}

fn unique_sorted(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    crate::graph_build::sorted_strings(ids)
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

fn location_contains(location: Option<&Value>, line: i64, column: Option<i64>) -> bool {
    let Some(location) = location else { return false };
    let point = |end: bool, key: &str| location.get(if end { "end" } else { "start" }).and_then(|p| p.get(key)).and_then(Value::as_i64).unwrap_or(0);
    if line < point(false, "line") || line > point(true, "line") {
        return false;
    }
    let Some(column) = column else { return true };
    if line == point(false, "line") && column < point(false, "column") {
        return false;
    }
    if line == point(true, "line") && column > point(true, "column") {
        return false;
    }
    true
}

fn path_matches(actual: Option<&str>, requested: &str) -> bool {
    let Some(actual) = actual else { return false };
    let actual = actual.replace('\\', "/").to_lowercase();
    let requested = requested.replace('\\', "/").to_lowercase();
    actual == requested || actual.ends_with(&format!(":{requested}")) || actual.ends_with(&format!("/{requested}"))
}

fn manifest_matches(node: &Value, manifest: &Manifest) -> bool {
    if manifest.node_ids.as_ref().is_some_and(|ids| ids.iter().any(|id| id == text(node, "id"))) {
        return true;
    }
    if let Some(event_id) = text_opt(node, "eventId")
        && manifest.event_ids.as_ref().is_some_and(|ids| ids.iter().any(|id| id == event_id))
    {
        return true;
    }
    if let Some(namespace) = text_opt(node, "namespace")
        && manifest.namespaces.as_ref().is_some_and(|ids| ids.iter().any(|id| id == namespace))
    {
        return true;
    }
    manifest.source_paths.as_ref().is_some_and(|paths| paths.iter().any(|path| path_matches(text_opt(node, "sourcePath"), path)))
}

fn node_source_path(node: &Value) -> Option<&str> {
    text_opt(node, "sourcePath").or_else(|| node.get("location").and_then(|l| text_opt(l, "path")))
}

/// `selectEventNodes`: the nodes a selector names, by id.
pub fn select_event_nodes<'a>(query: &Query<'a>, selector: &Selector) -> Vec<&'a Value> {
    let mut matched: Vec<&Value> = query
        .nodes()
        .iter()
        .filter(|node| match selector {
            Selector::Event { event_id } => text_opt(node, "eventId") == Some(event_id.as_str()),
            Selector::Namespace { namespace } => text_opt(node, "namespace") == Some(namespace.as_str()),
            Selector::File { source_path } => path_matches(node_source_path(node), source_path),
            Selector::Source { source_path, line, column } => {
                path_matches(node_source_path(node), source_path) && location_contains(node.get("location"), *line, *column)
            }
            Selector::Node { node_id } => text(node, "id") == node_id,
            Selector::Manifest { manifest } => manifest_matches(node, manifest),
        })
        .collect();
    sort_by_id(&mut matched);
    matched
}

fn selected_ids(query: &Query<'_>, selector: &Selector) -> HashSet<String> {
    select_event_nodes(query, selector).into_iter().map(|node| text(node, "id").to_string()).collect()
}

// ---------------------------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------------------------

pub struct Roots<'a> {
    pub entry_points: Vec<&'a Value>,
    pub automatic_events: Vec<&'a Value>,
    pub known_root_event_ids: Vec<String>,
    pub callerless_triggered_events: Vec<&'a Value>,
    pub components: Vec<Component>,
}

impl Roots<'_> {
    pub fn to_json(&self) -> Value {
        json!({
            "entryPoints": self.entry_points,
            "automaticEvents": self.automatic_events,
            "knownRootEventIds": self.known_root_event_ids,
            "callerlessTriggeredEvents": self.callerless_triggered_events,
            "stronglyConnectedComponents": self.components,
        })
    }
}

fn flag(node: &Value, key: &str) -> Option<bool> {
    meta(node, key).and_then(Value::as_bool)
}

fn all_roots<'a>(query: &Query<'a>) -> Result<Roots<'a>, Failed> {
    let edges = algorithms::flow_edges(&query.typed, false);
    let mut incoming: HashMap<&str, usize> = HashMap::new();
    for edge in edges.iter().copied().chain(algorithms::flow_edges(&query.typed, true)) {
        *incoming.entry(edge.to.as_str()).or_default() += 1;
    }
    let event_flow_sources: HashSet<&str> = edges.iter().map(|edge| edge.from.as_str()).collect();
    let mut entry_points: Vec<&Value> =
        query.nodes().iter().filter(|node| text(node, "kind") == "entry" && event_flow_sources.contains(text(node, "id"))).collect();
    sort_by_id(&mut entry_points);
    let mut automatic_events: Vec<&Value> = query
        .nodes()
        .iter()
        .filter(|node| text(node, "kind") == "event" && (flag(node, "isTriggeredOnly") == Some(false) || flag(node, "automatic") == Some(true)))
        .collect();
    sort_by_id(&mut automatic_events);
    let entry_ids: HashSet<&str> = entry_points.iter().map(|node| text(node, "id")).collect();
    let mut root_event_node_ids: HashSet<&str> = automatic_events.iter().map(|node| text(node, "id")).collect();
    for edge in &edges {
        if entry_ids.contains(edge.from.as_str()) {
            root_event_node_ids.insert(edge.to.as_str());
        }
    }
    let mut callerless: Vec<&Value> = query
        .nodes()
        .iter()
        .filter(|node| {
            text(node, "kind") == "event" && flag(node, "isTriggeredOnly") == Some(true) && incoming.get(text(node, "id")).copied().unwrap_or(0) == 0
        })
        .collect();
    sort_by_id(&mut callerless);
    let known = sorted_ids(
        query
            .nodes()
            .iter()
            .filter(|node| text(node, "kind") == "event" && root_event_node_ids.contains(text(node, "id")))
            .filter_map(|node| text_opt(node, "eventId").map(str::to_string)),
    );
    let components = algorithms::components(&query.typed, false, None)?.into_iter().filter(|component| component.cyclic).collect();
    Ok(Roots { entry_points, automatic_events, known_root_event_ids: known, callerless_triggered_events: callerless, components })
}

/// `discoverEventRoots`.
pub fn discover_event_roots<'a>(query: &Query<'a>, selector: Option<&Selector>) -> Result<Roots<'a>, Failed> {
    let roots = all_roots(query)?;
    let Some(selector) = selector else { return Ok(roots) };
    let selected = selected_ids(query, selector);
    let starts_selected: HashSet<&str> =
        algorithms::flow_edges(&query.typed, false).into_iter().filter(|edge| selected.contains(edge.to.as_str())).map(|edge| edge.from.as_str()).collect();
    let ids: HashSet<&str> = query
        .nodes()
        .iter()
        .filter(|node| text(node, "kind") == "event" && selected.contains(text(node, "id")))
        .filter_map(|node| text_opt(node, "eventId"))
        .collect();
    Ok(Roots {
        entry_points: roots.entry_points.into_iter().filter(|node| selected.contains(text(node, "id")) || starts_selected.contains(text(node, "id"))).collect(),
        automatic_events: roots.automatic_events.into_iter().filter(|node| selected.contains(text(node, "id"))).collect(),
        known_root_event_ids: roots.known_root_event_ids.into_iter().filter(|id| ids.contains(id.as_str())).collect(),
        callerless_triggered_events: roots.callerless_triggered_events.into_iter().filter(|node| selected.contains(text(node, "id"))).collect(),
        components: roots.components.into_iter().filter(|component| component.node_ids.iter().any(|id| selected.contains(id))).collect(),
    })
}

// ---------------------------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------------------------

/// `traceSelectedEvents`.
pub fn trace_selected_events(query: &Query<'_>, selector: &Selector, boundary: &Boundary) -> Value {
    let start: Vec<String> = select_event_nodes(query, selector).into_iter().map(|node| text(node, "id").to_string()).collect();
    serde_json::to_value(algorithms::trace(&query.typed, &start, boundary)).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------------------------
// Route explanation
// ---------------------------------------------------------------------------------------------

fn state_for_node<'a>(query: &Query<'a>, node_id: &str, accesses: &[&str]) -> Vec<&'a Value> {
    let mut found: Vec<&Value> = query
        .accesses()
        .iter()
        .filter(|access| {
            let mode = text(access, "access");
            text(access, "ownerId") == node_id
                && (accesses.contains(&mode) || (mode == "read_write" && (accesses.contains(&"read") || accesses.contains(&"write"))))
        })
        .collect();
    sort_by_id(&mut found);
    found
}

fn relevant_unresolved_from<'a>(query: &Query<'a>, start_ids: &[String]) -> Vec<&'a Value> {
    let reachable: HashSet<String> = algorithms::reachable(&query.typed, start_ids, Direction::Downstream, false).into_iter().collect();
    let mut source_paths: HashSet<&str> = HashSet::new();
    for node in query.nodes() {
        if reachable.contains(text(node, "id")) {
            if let Some(path) = text_opt(node, "sourcePath") {
                source_paths.insert(path);
            }
            if let Some(path) = node.get("location").and_then(|l| text_opt(l, "path")) {
                source_paths.insert(path);
            }
        }
    }
    query
        .unresolved()
        .iter()
        .filter(|item| {
            if reachable.contains(text(item, "id")) || text_opt(item, "ownerId").is_some_and(|owner| reachable.contains(owner)) {
                return true;
            }
            if text(item, "kind") != "partial_source" {
                return false;
            }
            let path = item
                .get("location")
                .and_then(|l| text_opt(l, "path"))
                .or_else(|| list(item, "blockers").iter().find_map(|blocker| blocker.get("location").and_then(|l| text_opt(l, "path"))));
            if path.is_some_and(|path| source_paths.contains(path)) {
                return true;
            }
            source_paths.contains(text(item, "expression"))
        })
        .collect()
}

fn path_unresolved_assumptions(query: &Query<'_>, node_ids: &[String], edges: &[Value]) -> Vec<Value> {
    let mut assumptions: Vec<Value> = Vec::new();
    for edge in edges {
        let id = text(edge, "id");
        let confidence = text(edge, "confidence");
        if confidence != "confirmed" {
            let blocker = meta(edge, "blocker").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("Edge confidence is {confidence}."));
            assumptions.push(json!({ "edgeId": id, "blocker": blocker }));
        }
        if let Some(scope) = edge.get("scope").filter(|s| !s.is_null())
            && (text(scope, "confidence") != "confirmed" || text(scope, "source") == "unknown" || text(scope, "destination") == "unknown")
        {
            let mut entry = Map::new();
            entry.insert("edgeId".into(), json!(id));
            if let Some(expression) = scope.get("expression").filter(|e| !e.is_null()) {
                entry.insert("expression".into(), expression.clone());
            }
            entry.insert(
                "blocker".into(),
                json!(format!("Scope transition {} to {} is {}.", text(scope, "source"), text(scope, "destination"), text(scope, "confidence"))),
            );
            assumptions.push(Value::Object(entry));
        }
        if let Some(timing) = edge.get("timing").filter(|t| !t.is_null())
            && text(timing, "mode") == "unknown"
        {
            let mut entry = Map::new();
            entry.insert("edgeId".into(), json!(id));
            if let Some(expression) = timing.get("expression").filter(|e| !e.is_null()) {
                entry.insert("expression".into(), expression.clone());
            }
            entry.insert("blocker".into(), json!("Event timing could not be resolved statically."));
            assumptions.push(Value::Object(entry));
        }
        let weight = edge.get("weight").filter(|w| !w.is_null());
        if let Some(weight) = weight {
            match weight.get("valid") {
                Some(Value::Bool(false)) => {
                    assumptions.push(json!({ "edgeId": id, "expression": weight.get("value").cloned().unwrap_or(Value::Null), "blocker": "The event weight is missing or invalid." }));
                }
                Some(Value::String(valid)) if valid == "unknown" => {
                    assumptions.push(json!({ "edgeId": id, "expression": weight.get("value").cloned().unwrap_or(Value::Null), "blocker": "The symbolic event weight is evaluated at runtime." }));
                }
                _ => {}
            }
        }
        let modifiers: &[Value] = weight.map(|w| list(w, "modifiers")).unwrap_or(&[]);
        for condition in list(edge, "conditions").iter().chain(modifiers) {
            if text(condition, "confidence") == "confirmed" {
                continue;
            }
            assumptions.push(json!({
                "edgeId": id,
                "expression": condition.get("expression").cloned().unwrap_or(Value::Null),
                "blocker": format!("{} confidence is {}.", text(condition, "kind").replace('_', " "), text(condition, "confidence")),
            }));
        }
    }
    let path_nodes: HashSet<&str> = node_ids.iter().map(String::as_str).collect();
    for access in query.accesses() {
        let dynamic = access.get("dynamic").and_then(Value::as_bool).unwrap_or(false);
        if !path_nodes.contains(text(access, "ownerId")) || (!dynamic && text(access, "confidence") == "confirmed") {
            continue;
        }
        assumptions.push(json!({
            "nodeId": text(access, "ownerId"),
            "expression": format!("{}:{}", text(access, "kind"), text(access, "name")),
            "blocker": if dynamic { "A dynamic state name cannot be resolved statically.".to_string() } else { format!("State access confidence is {}.", text(access, "confidence")) },
        }));
    }
    let mut seen = HashSet::new();
    assumptions.retain(|assumption| seen.insert(serde_json::to_string(assumption).unwrap_or_default()));
    assumptions
}

pub struct PathBoundary {
    pub max_depth: u64,
    pub max_nodes: usize,
    pub expand_helpers: bool,
}

/// `explainEventPath`.
pub fn explain_event_path(query: &Query<'_>, from: &Selector, to: &Selector, boundary: &PathBoundary) -> Value {
    let from_ids: Vec<String> = select_event_nodes(query, from).into_iter().map(|node| text(node, "id").to_string()).collect();
    let to_ids: Vec<String> = select_event_nodes(query, to).into_iter().map(|node| text(node, "id").to_string()).collect();
    let boundary_json = json!({ "maxDepth": boundary.max_depth, "maxNodes": boundary.max_nodes, "expandHelpers": boundary.expand_helpers });
    if from_ids.is_empty() || to_ids.is_empty() {
        return json!({
            "found": false,
            "fromNodeIds": from_ids,
            "toNodeIds": to_ids,
            "steps": [],
            "failureReason": "unsupported_analysis",
            "failureMessage": if from_ids.is_empty() { "The source selector did not resolve to an indexed event-chain node." } else { "The destination selector did not resolve to an indexed event-chain node." },
            "unresolvedAssumptions": [],
            "boundary": boundary_json,
        });
    }
    let options = PathOptions { expand_helpers: boundary.expand_helpers, max_depth: boundary.max_depth, max_nodes: boundary.max_nodes };
    if let Some(path) = algorithms::shortest_path(&query.typed, &from_ids, &to_ids, options) {
        let by_id = query.node_by_id();
        let edges: Vec<Value> = path.edges.iter().map(|edge| serde_json::to_value(edge).unwrap_or(Value::Null)).collect();
        let mut steps = Vec::new();
        for (index, node_id) in path.node_ids.iter().enumerate() {
            let Some(node) = by_id.get(node_id.as_str()) else { continue };
            let mut step = Map::new();
            step.insert("index".into(), json!(index));
            step.insert("node".into(), (*node).clone());
            if index > 0 {
                step.insert("via".into(), edges[index - 1].clone());
            }
            step.insert("requiredState".into(), json!(state_for_node(query, node_id, &["read"])));
            step.insert("producedState".into(), json!(state_for_node(query, node_id, &["write", "replace", "clear"])));
            steps.push(Value::Object(step));
        }
        return json!({
            "found": true,
            "fromNodeIds": from_ids,
            "toNodeIds": to_ids,
            "steps": steps,
            "unresolvedAssumptions": path_unresolved_assumptions(query, &path.node_ids, &edges),
            "boundary": boundary_json,
        });
    }
    let node_count = query.nodes().len();
    let unrestricted = algorithms::shortest_path(
        &query.typed,
        &from_ids,
        &to_ids,
        PathOptions {
            expand_helpers: boundary.expand_helpers,
            max_depth: (node_count as u64).max(boundary.max_depth),
            max_nodes: node_count.max(boundary.max_nodes),
        },
    );
    let relevant = relevant_unresolved_from(query, &from_ids);
    let has_dynamic = relevant.iter().any(|item| matches!(text(item, "kind"), "dynamic_event" | "dynamic_helper"));
    let has_unsupported = relevant.iter().any(|item| !matches!(text(item, "kind"), "dynamic_event" | "dynamic_helper"));
    let inventory_partial = query.graph.get("skippedSourceCount").and_then(Value::as_u64).unwrap_or(0) > 0
        || list(query.graph, "diagnostics").iter().any(|diagnostic| text(diagnostic, "code") == "EVENT_INVENTORY_PARTIAL");
    let (reason, message) = if unrestricted.is_some() {
        ("trace_boundary", "A path exists outside the requested trace boundary.")
    } else if has_unsupported {
        ("unsupported_analysis", "Reachable missing or unsupported source prevents a conclusive path result.")
    } else if has_dynamic {
        ("dynamic_dispatch", "A statically unresolved dispatch may connect the selected route.")
    } else if inventory_partial {
        ("unsupported_analysis", "Skipped or unsupported source prevents a conclusive reachability result.")
    } else {
        ("unreachable", "No statically proven path connects the selected nodes.")
    };
    let assumptions: Vec<Value> = relevant
        .iter()
        .map(|item| {
            let mut entry = Map::new();
            if let Some(owner) = text_opt(item, "ownerId") {
                entry.insert("nodeId".into(), json!(owner));
            }
            entry.insert("expression".into(), item.get("expression").cloned().unwrap_or(Value::Null));
            if let Some(blocker) = list(item, "blockers").first() {
                entry.insert("blocker".into(), blocker.get("message").cloned().unwrap_or(Value::Null));
            }
            Value::Object(entry)
        })
        .collect();
    json!({
        "found": false,
        "fromNodeIds": from_ids,
        "toNodeIds": to_ids,
        "steps": [],
        "failureReason": reason,
        "failureMessage": message,
        "unresolvedAssumptions": assumptions,
        "boundary": boundary_json,
    })
}

// ---------------------------------------------------------------------------------------------
// State flow
// ---------------------------------------------------------------------------------------------

fn is_producer(access: &Value) -> bool {
    matches!(text(access, "access"), "write" | "read_write" | "replace")
}

fn is_consumer(access: &Value) -> bool {
    matches!(text(access, "access"), "read" | "read_write")
}

fn compatible_producers<'a>(producers: &HashMap<String, Vec<&'a Value>>, consumer: &Value) -> Vec<&'a Value> {
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for key in compatible_producer_keys(consumer) {
        for producer in producers.get(&key).map(Vec::as_slice).unwrap_or(&[]) {
            by_id.insert(text(producer, "id"), producer);
        }
    }
    let mut found: Vec<&Value> = by_id.into_values().collect();
    sort_by_id(&mut found);
    found
}

fn logical_state_key(access: &Value) -> String {
    format!("{}:{}", text(access, "kind"), text(access, "name"))
}

fn selected_ownership_ids(query: &Query<'_>, selector: &Selector) -> HashSet<String> {
    let mut selected = selected_ids(query, selector);
    let mut ownership: Vec<&Value> =
        query.edges().iter().filter(|edge| !is_derived(edge) && matches!(text(edge, "reason"), "option_branch" | "scripted_effect_call")).collect();
    sort_by_id(&mut ownership);
    let mut changed = true;
    while changed {
        changed = false;
        for edge in &ownership {
            let (from, to) = (text(edge, "from"), text(edge, "to"));
            if selected.contains(from) && !selected.contains(to) {
                selected.insert(to.to_string());
                changed = true;
            }
            if text(edge, "reason") == "option_branch" && selected.contains(to) && !selected.contains(from) {
                selected.insert(from.to_string());
                changed = true;
            }
        }
    }
    selected
}

fn is_derived(edge: &Value) -> bool {
    edge.get("derived").and_then(Value::as_bool).unwrap_or(false)
}

pub struct StateSubject {
    pub kind: String,
    pub name: String,
}

/// `inspectEventStateFlow`.
pub fn inspect_event_state_flow(query: &Query<'_>, selector: Option<&Selector>, subject: Option<&StateSubject>) -> Value {
    let selected_owners = selector.map(|selector| selected_ownership_ids(query, selector));
    let mut selected_accesses: Vec<&Value> = query
        .accesses()
        .iter()
        .filter(|access| {
            selected_owners.as_ref().is_none_or(|owners| owners.contains(text(access, "ownerId")))
                && subject.is_none_or(|subject| {
                    text(access, "kind") == subject.kind
                        && (text(access, "name") == subject.name
                            || (text(access, "kind") == "global_event_target" && text(access, "access") == "clear" && text(access, "name") == "*"))
                })
        })
        .collect();
    sort_by_id(&mut selected_accesses);
    let mut all_producers: HashMap<String, Vec<&Value>> = HashMap::new();
    let mut logical_producers: HashMap<String, Vec<&Value>> = HashMap::new();
    for access in query.accesses() {
        if !is_producer(access) {
            continue;
        }
        all_producers.entry(state_key(access)).or_default().push(access);
        logical_producers.entry(logical_state_key(access)).or_default().push(access);
    }
    let access_by_id: HashMap<&str, &Value> = query.accesses().iter().map(|access| (text(access, "id"), access)).collect();
    let selected_access_ids: HashSet<&str> = selected_accesses.iter().map(|access| text(access, "id")).collect();
    let mut links: Vec<Value> = Vec::new();
    for link in list(query.graph, "stateLinks") {
        let (Some(producer), Some(consumer)) = (access_by_id.get(text(link, "producerId")), access_by_id.get(text(link, "consumerId"))) else { continue };
        if !selected_access_ids.contains(text(consumer, "id")) {
            continue;
        }
        if subject.is_some_and(|subject| text(link, "stateKind") != subject.kind || text(link, "name") != subject.name) {
            continue;
        }
        links.push(json!({
            "id": text(link, "id"),
            "kind": text(link, "stateKind"),
            "name": text(link, "name"),
            "producerId": text(producer, "id"),
            "consumerId": text(consumer, "id"),
            "producerOwnerId": text(producer, "ownerId"),
            "consumerOwnerId": text(consumer, "ownerId"),
            "confidence": text(link, "confidence"),
            "pathConfirmed": link.get("pathConfirmed").cloned().unwrap_or(Value::Null),
        }));
    }
    let linked_consumers: HashSet<String> = links.iter().map(|link| text(link, "consumerId").to_string()).collect();
    for consumer in selected_accesses.iter().filter(|access| is_consumer(access)) {
        if linked_consumers.contains(text(consumer, "id")) {
            continue;
        }
        let compatible = compatible_producers(&all_producers, consumer);
        let ambiguous = has_unknown_saved_scope_storage(consumer);
        for producer in &compatible {
            let confidence = if ambiguous {
                "unresolved"
            } else if text(producer, "confidence") == "confirmed" && text(consumer, "confidence") == "confirmed" {
                "confirmed"
            } else {
                text(consumer, "confidence")
            };
            links.push(json!({
                "id": format!("{}:{}:{}", if ambiguous { "state-link:storage-ambiguous" } else { "state-link" }, text(producer, "id"), text(consumer, "id")),
                "kind": text(consumer, "kind"),
                "name": text(consumer, "name"),
                "producerId": text(producer, "id"),
                "consumerId": text(consumer, "id"),
                "producerOwnerId": text(producer, "ownerId"),
                "consumerOwnerId": text(consumer, "ownerId"),
                "confidence": confidence,
                "pathConfirmed": false,
            }));
        }
        if compatible.is_empty() && matches!(text(consumer, "kind"), "variable" | "array") {
            for producer in logical_producers.get(&logical_state_key(consumer)).map(Vec::as_slice).unwrap_or(&[]) {
                links.push(json!({
                    "id": format!("state-link:scope-ambiguous:{}:{}", text(producer, "id"), text(consumer, "id")),
                    "kind": text(consumer, "kind"),
                    "name": text(consumer, "name"),
                    "producerId": text(producer, "id"),
                    "consumerId": text(consumer, "id"),
                    "producerOwnerId": text(producer, "ownerId"),
                    "consumerOwnerId": text(consumer, "ownerId"),
                    "confidence": "unresolved",
                    "pathConfirmed": false,
                }));
            }
        }
    }
    let mut evidence_ids: HashSet<String> = selected_accesses.iter().map(|access| text(access, "id").to_string()).collect();
    for link in &links {
        evidence_ids.insert(text(link, "producerId").to_string());
    }
    let mut accesses: Vec<&Value> = query.accesses().iter().filter(|access| evidence_ids.contains(text(access, "id"))).collect();
    sort_by_id(&mut accesses);
    let clear_keys: HashSet<String> = query.accesses().iter().filter(|access| text(access, "access") == "clear").map(state_key).collect();
    let clears_all_global_targets = clear_keys.contains("global_event_target:*");
    links.sort_by(|a, b| cmp(text(a, "id"), text(b, "id")));
    let pick = |predicate: &dyn Fn(&Value) -> bool| -> Vec<&Value> { accesses.iter().copied().filter(|access| predicate(access)).collect() };
    json!({
        "accesses": accesses,
        "producers": pick(&|access| matches!(text(access, "access"), "write" | "read_write" | "replace")),
        "consumers": pick(&|access| matches!(text(access, "access"), "read" | "read_write")),
        "clears": pick(&|access| text(access, "access") == "clear"),
        "links": links,
        "unproducedReads": pick(&|access| is_consumer(access) && compatible_producers(&all_producers, access).is_empty()),
        "globalTargetLeaks": pick(&|access| {
            text(access, "kind") == "global_event_target"
                && matches!(text(access, "access"), "write" | "replace")
                && !clears_all_global_targets
                && !clear_keys.contains(&state_key(access))
        }),
    })
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

/// `issueSubjectIds`.
pub fn issue_subject_ids(issue: &Value) -> Vec<String> {
    let details = issue.get("details");
    let candidate = details.and_then(|d| d.get("subjectIds")).filter(|v| !v.is_null()).or_else(|| details.and_then(|d| d.get("subjects")));
    match candidate {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// `lintEventGraph`: every finding, or those of a selection.
pub fn lint_event_graph<'a>(query: &Query<'a>, selector: Option<&Selector>) -> Vec<&'a Value> {
    let Some(selector) = selector else { return query.issues().iter().collect() };
    let selected = selected_ownership_ids(query, selector);
    let mut ranges: HashMap<&str, Vec<(i64, i64)>> = HashMap::new();
    for node in query.nodes() {
        let Some(location) = node.get("location").filter(|l| !l.is_null()) else { continue };
        if !selected.contains(text(node, "id")) {
            continue;
        }
        ranges.entry(text(location, "path")).or_default().push((offset(location, false), offset(location, true)));
    }
    query
        .issues()
        .iter()
        .filter(|issue| {
            if issue_subject_ids(issue).iter().any(|id| selected.contains(id)) {
                return true;
            }
            let Some(location) = issue.get("location").filter(|l| !l.is_null()) else { return false };
            ranges
                .get(text(location, "path"))
                .is_some_and(|spans| spans.iter().any(|(start, end)| offset(location, false) >= *start && offset(location, true) <= *end))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------------------------

fn reachable_from_roots_without(query: &Query<'_>, root_ids: &[String], removed: &HashSet<String>) -> HashSet<String> {
    let retained: HashSet<&str> = query.nodes().iter().map(|node| text(node, "id")).filter(|id| !removed.contains(*id)).collect();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in algorithms::flow_edges(&query.typed, true) {
        let (from, to) = (edge.from.as_str(), edge.to.as_str());
        if removed.contains(from) || removed.contains(to) || !retained.contains(from) || !retained.contains(to) {
            continue;
        }
        outgoing.entry(from).or_default().push(to);
    }
    for targets in outgoing.values_mut() {
        targets.sort_by(|a, b| cmp(a, b));
    }
    let starts: Vec<String> = unique_sorted(root_ids.iter().filter(|id| retained.contains(id.as_str())).cloned());
    let mut reachable: HashSet<String> = starts.iter().cloned().collect();
    let mut queue: Vec<String> = starts;
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor].clone();
        cursor += 1;
        for target in outgoing.get(current.as_str()).map(Vec::as_slice).unwrap_or(&[]) {
            if reachable.insert((*target).to_string()) {
                queue.push((*target).to_string());
            }
        }
    }
    reachable
}

/// `analyzeEventImpact`.
pub fn analyze_event_impact(query: &Query<'_>, subject: &ImpactSubject) -> Result<Value, Failed> {
    let mut direct_node_ids: HashSet<String> = HashSet::new();
    let mut state_access_ids: Vec<String> = Vec::new();
    match subject.kind.as_str() {
        "event" => {
            for node in query.nodes() {
                if text_opt(node, "eventId") == Some(subject.name.as_str()) {
                    direct_node_ids.insert(text(node, "id").to_string());
                }
            }
        }
        "helper" => {
            for node in query.nodes() {
                if text(node, "kind") == "helper"
                    && (text(node, "label") == subject.name || meta(node, "name").and_then(Value::as_str) == Some(subject.name.as_str()))
                {
                    direct_node_ids.insert(text(node, "id").to_string());
                }
            }
        }
        _ => {
            for access in query.accesses() {
                let kind = text(access, "kind");
                let kind_matches = kind == subject.kind
                    || (subject.kind == "flag" && kind.ends_with("_flag"))
                    || (subject.kind == "variable" && kind.ends_with("variable"))
                    || (subject.kind == "event_target" && kind.ends_with("event_target"));
                if kind_matches && text(access, "name") == subject.name {
                    direct_node_ids.insert(text(access, "ownerId").to_string());
                    state_access_ids.push(text(access, "id").to_string());
                }
            }
        }
    }
    let direct = unique_sorted(direct_node_ids.iter().cloned());
    let expand_helpers = subject.kind == "helper";
    let upstream = algorithms::reachable(&query.typed, &direct, Direction::Upstream, expand_helpers);
    let downstream = algorithms::reachable(&query.typed, &direct, Direction::Downstream, expand_helpers);
    let affected: HashSet<&str> = upstream.iter().chain(downstream.iter()).map(String::as_str).collect();
    let roots = discover_event_roots(query, None)?;
    let root_ids = sorted_ids(roots.entry_points.iter().chain(roots.automatic_events.iter()).map(|node| text(node, "id").to_string()));
    let structural_removal = subject.kind == "event" || subject.kind == "helper";
    let removed: HashSet<String> = if structural_removal { direct.iter().cloned().collect() } else { HashSet::new() };
    let baseline = reachable_from_roots_without(query, &root_ids, &HashSet::new());
    let after = reachable_from_roots_without(query, &root_ids, &removed);
    let would_disconnect: Vec<String> =
        if structural_removal { sorted_ids(baseline.iter().filter(|id| !removed.contains(*id) && !after.contains(*id)).cloned()) } else { Vec::new() };
    let terminal_ids: HashSet<&str> = query.nodes().iter().filter(|node| text(node, "kind") == "terminal").map(|node| text(node, "id")).collect();
    let nodes_of_kind = |kind: &str| -> Vec<String> {
        sorted_ids(
            query.nodes().iter().filter(|node| text(node, "kind") == kind && affected.contains(text(node, "id"))).map(|node| text(node, "id").to_string()),
        )
    };
    Ok(json!({
        "subject": { "kind": subject.kind, "name": subject.name },
        "directNodeIds": direct,
        "upstreamNodeIds": upstream,
        "downstreamNodeIds": downstream,
        "stateAccessIds": sorted_ids(state_access_ids),
        "affectedRootIds": sorted_ids(root_ids.iter().filter(|id| affected.contains(id.as_str())).cloned()),
        "affectedTerminalIds": nodes_of_kind("terminal"),
        "removedRootIds": root_ids.iter().filter(|id| removed.contains(*id)).collect::<Vec<_>>(),
        "wouldDisconnectNodeIds": would_disconnect,
        "wouldDisconnectTerminalIds": would_disconnect.iter().filter(|id| terminal_ids.contains(id.as_str())).collect::<Vec<_>>(),
        "unresolvedNodeIds": nodes_of_kind("unresolved"),
    }))
}

/// Strings sorted by code unit order, as a map key order helper for callers that need it.
pub fn counts_by<T>(values: impl IntoIterator<Item = T>, key: impl Fn(&T) -> String) -> Map<String, Value> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for value in values {
        *counts.entry(key(&value)).or_default() += 1;
    }
    let mut ordered: Vec<(String, u64)> = counts.into_iter().collect();
    ordered.sort_by(|(a, _), (b, _)| cmp(a, b));
    ordered.into_iter().map(|(key, count)| (key, json!(count))).collect()
}

/// A short location key, for callers that group findings.
pub fn key_of(location: Option<&Value>) -> String {
    location_key(location)
}

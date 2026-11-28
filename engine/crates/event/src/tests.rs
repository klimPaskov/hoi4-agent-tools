//! Tests ported from `tests/unit/event-algorithms.test.ts` and `event-explain-path-278.test.ts`
//! on the same synthetic graph shape.

use hoi4_core::ops::{OpContext, Registry};
use serde_json::{Value, json};

use crate::algorithms::{self, Boundary, Direction, PathOptions};
use crate::graph::Graph;

fn node(id: &str, kind: &str, name: Option<&str>) -> Value {
    let metadata = name.map_or(json!({}), |n| json!({ "name": n }));
    json!({ "id": id, "kind": kind, "label": id, "metadata": metadata })
}

fn edge(id: &str, from: &str, to: &str, reason: &str, derived: bool, stack: &[&str]) -> Value {
    json!({
        "id": id, "from": from, "to": to, "reason": reason, "conditions": [], "helperStack": stack,
        "location": { "path": "mod:events/unit.txt" }, "provenance": [], "confidence": "confirmed",
        "derived": derived, "metadata": {}
    })
}

/// The shared test graph; `with_derived` adds the materialised helper projection.
fn graph(with_derived: bool) -> Graph {
    let mut edges = vec![
        edge("edge:entry", "entry:on_startup", "event:unit.1", "on_action_entry", false, &[]),
        edge("edge:option", "event:unit.1", "option:unit.1:a", "option_branch", false, &[]),
        edge("edge:helper", "option:unit.1:a", "helper:unit_followup", "scripted_effect_call", false, &[]),
        edge("edge:helper-event", "helper:unit_followup", "event:unit.2", "scripted_effect_expansion", false, &[]),
        edge("edge:cycle", "event:unit.2", "event:unit.1", "delayed_event_call", false, &[]),
        edge("edge:terminal", "event:unit.2", "terminal:unit.2", "terminal", false, &[]),
    ];
    if with_derived {
        edges.push(edge("edge:collapsed", "option:unit.1:a", "event:unit.2", "scripted_effect_expansion", true, &["unit_followup"]));
    }
    let nodes = vec![
        node("entry:on_startup", "entry", None),
        node("event:unit.1", "event", None),
        node("option:unit.1:a", "option", None),
        node("helper:unit_followup", "helper", Some("unit_followup")),
        node("event:unit.2", "event", None),
        node("terminal:unit.2", "terminal", None),
    ];
    serde_json::from_value(json!({ "nodes": nodes, "edges": edges })).unwrap()
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).to_string()).collect()
}

fn boundary(direction: Direction, expand_helpers: bool) -> Boundary {
    Boundary { max_depth: 6, max_nodes: 100, max_edges: 100, direction, expand_helpers }
}

fn options(expand_helpers: bool) -> PathOptions {
    PathOptions { expand_helpers, max_depth: 12, max_nodes: 2_000 }
}

#[test]
fn a_trace_collapses_helpers_or_expands_them() {
    let g = graph(true);
    let collapsed = algorithms::trace(&g, &ids(&["event:unit.1"]), &boundary(Direction::Downstream, false));
    assert!(collapsed.nodes.iter().any(|n| n.id == "event:unit.2"));
    assert!(collapsed.edges.iter().any(|e| e.id == "edge:collapsed"));
    assert!(!collapsed.edges.iter().any(|e| e.id == "edge:helper"));
    let expanded = algorithms::trace(&g, &ids(&["event:unit.1"]), &boundary(Direction::Downstream, true));
    assert!(expanded.edges.iter().any(|e| e.id == "edge:helper"));
    assert!(!expanded.edges.iter().any(|e| e.id == "edge:collapsed"));
}

#[test]
fn a_trace_without_derived_edges_collapses_helpers_lazily() {
    let g = graph(false);
    let trace = algorithms::trace(&g, &ids(&["event:unit.1"]), &boundary(Direction::Downstream, false));
    let lazy = trace.edges.iter().find(|e| e.id.starts_with("edge:lazy-helper-projection:")).expect("a lazy edge");
    assert_eq!((lazy.from.as_str(), lazy.to.as_str()), ("option:unit.1:a", "event:unit.2"));
    assert_eq!(lazy.helper_stack, vec!["unit_followup".to_string()]);
    assert_eq!(lazy.metadata["structuralEdgeIds"], json!(["edge:helper", "edge:helper-event"]));
    assert!(lazy.derived);
}

#[test]
fn a_trace_marks_the_boundary_when_depth_ends_it() {
    let g = graph(true);
    let b = Boundary { max_depth: 1, ..boundary(Direction::Downstream, false) };
    let trace = algorithms::trace(&g, &ids(&["event:unit.1"]), &b);
    assert!(trace.truncated);
    assert_eq!(trace.boundary_node_ids, ids(&["option:unit.1:a"]));
    assert_eq!(trace.layers.len(), 2);
}

#[test]
fn the_node_ceiling_applies_to_broad_start_sets() {
    let g = graph(true);
    let b = Boundary { max_nodes: 2, ..boundary(Direction::Both, false) };
    let trace = algorithms::trace(&g, &ids(&["event:unit.1", "event:unit.2", "entry:on_startup"]), &b);
    assert!(trace.truncated);
    assert_eq!(trace.start_node_ids.len(), 2);
}

#[test]
fn paths_are_collapsed_or_expanded() {
    let g = graph(true);
    let collapsed = algorithms::shortest_path(&g, &ids(&["event:unit.1"]), &ids(&["event:unit.2"]), options(false)).unwrap();
    assert_eq!(collapsed.node_ids, ids(&["event:unit.1", "option:unit.1:a", "event:unit.2"]));
    assert_eq!(collapsed.edges[1].helper_stack, vec!["unit_followup".to_string()]);
    let expanded = algorithms::shortest_path(&g, &ids(&["event:unit.1"]), &ids(&["event:unit.2"]), options(true)).unwrap();
    assert_eq!(expanded.node_ids, ids(&["event:unit.1", "option:unit.1:a", "helper:unit_followup", "event:unit.2"]));
}

/// Issue 278: the trace reports a helper-collapsed route on a graph with no derived edge, and
/// the path search must find the same route.
#[test]
fn the_path_search_agrees_with_the_trace_on_a_focused_graph() {
    let g = graph(false);
    let path = algorithms::shortest_path(&g, &ids(&["event:unit.1"]), &ids(&["event:unit.2"]), options(false)).expect("the route the trace reports");
    assert_eq!(path.node_ids, ids(&["event:unit.1", "option:unit.1:a", "event:unit.2"]));
    assert_eq!(path.edges[1].helper_stack, vec!["unit_followup".to_string()]);
}

#[test]
fn the_path_search_gives_up_at_the_node_ceiling_and_the_depth_limit() {
    let g = graph(true);
    let tight = PathOptions { expand_helpers: false, max_depth: 12, max_nodes: 2 };
    assert!(algorithms::shortest_path(&g, &ids(&["event:unit.1"]), &ids(&["event:unit.2"]), tight).is_none());
    let shallow = PathOptions { expand_helpers: false, max_depth: 1, max_nodes: 100 };
    assert!(algorithms::shortest_path(&g, &ids(&["event:unit.1"]), &ids(&["event:unit.2"]), shallow).is_none());
    assert!(algorithms::shortest_path(&g, &ids(&["event:unit.1"]), &ids(&["entry:on_startup"]), options(false)).is_none());
}

#[test]
fn strongly_connected_components_find_the_cycle() {
    let g = graph(true);
    let cyclic: Vec<_> = algorithms::components(&g, false, None).unwrap().into_iter().filter(|c| c.cyclic).collect();
    assert_eq!(cyclic.len(), 1);
    assert_eq!(cyclic[0].node_ids, ids(&["event:unit.1", "event:unit.2", "option:unit.1:a"]));
}

#[test]
fn a_self_loop_is_cyclic_and_a_chain_is_not() {
    let g: Graph = serde_json::from_value(json!({
        "nodes": [node("event:a", "event", None), node("event:b", "event", None)],
        "edges": [edge("e1", "event:a", "event:a", "immediate_event_call", false, &[]), edge("e2", "event:a", "event:b", "immediate_event_call", false, &[])]
    }))
    .unwrap();
    let components = algorithms::components(&g, false, None).unwrap();
    assert_eq!(components.iter().filter(|c| c.cyclic).count(), 1);
    assert_eq!(components.len(), 2);
}

#[test]
fn the_work_ceiling_blocks_a_runaway_traversal() {
    let nodes = ids(&["a", "b"]);
    let adjacency = std::collections::HashMap::from([("a".to_string(), ids(&["b"])), ("b".to_string(), ids(&["a"]))]);
    let mut spent = 0;
    let mut spend = || {
        spent += 1;
        if spent > 3 { Err(algorithms::WorkBlocked { label: "test", spent }) } else { Ok(()) }
    };
    assert!(algorithms::strongly_connected(&nodes, &adjacency, &mut spend).is_err());
}

#[test]
fn reachable_follows_the_direction() {
    let g = graph(true);
    let down = algorithms::reachable(&g, &ids(&["event:unit.1"]), Direction::Downstream, false);
    assert!(down.contains(&"event:unit.2".to_string()));
    let up = algorithms::reachable(&g, &ids(&["event:unit.2"]), Direction::Upstream, false);
    assert!(up.contains(&"entry:on_startup".to_string()));
}

#[test]
fn operations_are_registered_and_refuse_a_malformed_request() {
    let mut registry = Registry::new();
    crate::register(&mut registry);
    assert_eq!(registry.names(), vec!["event.components", "event.fragments", "event.graph", "event.inspect", "event.path", "event.reachable", "event.trace"]);
    let bad = registry.dispatch("event.path", &OpContext::default(), &json!({ "graph": 1 }), &[]).unwrap();
    assert_eq!(bad.result.unwrap_err()["code"], "invalid_request");
    let request = json!({
        "graph": serde_json::to_value(graph(false)).unwrap(),
        "from": ["event:unit.1"], "to": ["event:unit.2"],
        "options": { "expandHelpers": false, "maxDepth": 12, "maxNodes": 2000 }
    });
    let answer = registry.dispatch("event.path", &OpContext::default(), &request, &[]).unwrap().result.unwrap();
    assert_eq!(answer["path"]["nodeIds"], json!(["event:unit.1", "option:unit.1:a", "event:unit.2"]));
}

fn analysis_registry() -> Registry {
    let mut registry = Registry::new();
    crate::register(&mut registry);
    registry
}

fn fixture_file(name: &str, text: &str) -> (std::path::PathBuf, String, u64) {
    let directory = std::env::temp_dir().join(format!("hoi4-event-tests-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("a temporary directory");
    let path = directory.join(name);
    std::fs::write(&path, text).expect("a fixture file");
    (path, hoi4_core::canonical::sha256_hex(text.as_bytes()), text.len() as u64)
}

fn path_entry(path: &std::path::Path, sha256: &str, size: u64) -> Value {
    json!({
        "relativePath": "events/a.txt", "displayPath": "fixture:events/a.txt", "sha256": sha256, "cacheKey": "key",
        "path": path.to_string_lossy(), "size": size
    })
}

const ONE_EVENT: &str = "country_event = { id = p.1 title = p.1.t desc = p.1.d option = { name = p.1.a } }\n";

#[test]
fn fragments_are_read_by_path_and_a_changed_file_is_refused() {
    let registry = analysis_registry();
    let (path, sha, size) = fixture_file("fresh.txt", ONE_EVENT);
    let fresh = json!({ "files": [path_entry(&path, &sha, size)], "context": {} });
    let answer = registry.dispatch("event.fragments", &OpContext::default(), &fresh, &[]).unwrap();
    let fragments: Vec<Value> = serde_json::from_slice(&answer.payload).expect("fragments in the payload");
    assert_eq!(fragments.len(), 1);
    assert!(fragments[0]["nodes"].as_array().unwrap().iter().any(|node| node["kind"] == "event" && node["eventId"] == "p.1"));

    let changed_hash = json!({ "files": [path_entry(&path, &"0".repeat(64), size)], "context": {} });
    let refused = registry.dispatch("event.fragments", &OpContext::default(), &changed_hash, &[]).unwrap();
    assert_eq!(refused.result.unwrap_err()["code"], "EVENT_SOURCE_STALE");
    let changed_size = json!({ "files": [path_entry(&path, &sha, size + 1)], "context": {} });
    let refused = registry.dispatch("event.fragments", &OpContext::default(), &changed_size, &[]).unwrap();
    assert_eq!(refused.result.unwrap_err()["code"], "EVENT_SOURCE_STALE");
}

#[test]
fn unreadable_and_incomplete_file_entries_are_refused() {
    let registry = analysis_registry();
    let missing = std::env::temp_dir().join("hoi4-event-tests-missing").join("nothing.txt");
    let unreadable = json!({ "files": [path_entry(&missing, &"0".repeat(64), 1)], "context": {} });
    let refused = registry.dispatch("event.fragments", &OpContext::default(), &unreadable, &[]).unwrap();
    assert_eq!(refused.result.unwrap_err()["code"], "EVENT_SOURCE_UNREADABLE");
    let neither = json!({
        "files": [{ "relativePath": "events/a.txt", "displayPath": "fixture:events/a.txt", "sha256": "x", "cacheKey": "key" }],
        "context": {}
    });
    let refused = registry.dispatch("event.fragments", &OpContext::default(), &neither, &[]).unwrap();
    assert_eq!(refused.result.unwrap_err()["code"], "invalid_request");
    let past_the_end = json!({
        "files": [{ "relativePath": "events/a.txt", "displayPath": "fixture:events/a.txt", "sha256": "x", "cacheKey": "key", "payload": [0, 99] }],
        "context": {}
    });
    let refused = registry.dispatch("event.fragments", &OpContext::default(), &past_the_end, &[1, 2, 3]).unwrap();
    assert_eq!(refused.result.unwrap_err()["code"], "invalid_request");
}

#[test]
fn the_graph_is_built_from_files_read_by_path() {
    let registry = analysis_registry();
    let (path, sha, size) = fixture_file("graph.txt", ONE_EVENT);
    let request = json!({
        "analyze": { "files": [path_entry(&path, &sha, size)], "context": {} },
        "files": [{ "displayPath": "fixture:events/a.txt", "sha256": sha }],
        "workspaceId": "synthetic", "revision": "r1", "complete": true
    });
    let answer = registry.dispatch("event.graph", &OpContext::default(), &request, &[]).unwrap();
    let header = answer.result.unwrap();
    assert!(header["timingsMs"]["analysis"].is_u64());
    let graph: Value = serde_json::from_slice(&answer.payload).expect("the graph in the payload");
    assert_eq!(graph["statistics"]["eventCount"], 1);
    let stale = json!({
        "analyze": { "files": [path_entry(&path, &"0".repeat(64), size)], "context": {} },
        "files": [], "workspaceId": "synthetic", "revision": "r1", "complete": true
    });
    let refused = registry.dispatch("event.graph", &OpContext::default(), &stale, &[]).unwrap();
    assert_eq!(refused.result.unwrap_err()["code"], "EVENT_SOURCE_STALE");
}

#[test]
fn an_answer_over_the_response_limit_is_refused_instead_of_sent() {
    let value = json!({ "text": "x".repeat(200) });
    let refused = crate::ops::payload_response_for_test(&value, 100).result.unwrap_err();
    assert_eq!(refused["code"], "EVENT_RESULT_TOO_LARGE");
    let sent = crate::ops::payload_response_for_test(&value, 10_000);
    assert!(sent.result.is_ok());
    assert!(!sent.payload.is_empty());
}

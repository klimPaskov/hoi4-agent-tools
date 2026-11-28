//! Tests of the event queries and `event.inspect` over graphs built from synthetic sources.

use hoi4_core::ops::{OpContext, Registry};
use serde_json::{Value, json};

use crate::graph_build::{build_graph, list, text};
use crate::graph_build_tests::{ENTRY, HELPER, SECOND, input};
use crate::inspect::{self, Request};

fn graph() -> Value {
    build_graph(&input(&[("events/a.txt", ENTRY), ("common/scripted_effects/h.txt", HELPER), ("events/b.txt", SECOND)])).expect("graph")
}

fn request(value: Value) -> Request {
    serde_json::from_value(value).expect("a request")
}

fn inspect_ok(graph: &Value, value: Value) -> inspect::Inspection {
    inspect::inspect(graph, &request(value)).unwrap_or_else(|refusal| panic!("refused: {} {}", refusal.code, refusal.message))
}

fn refusal(graph: &Value, value: Value) -> inspect::Refusal {
    match inspect::inspect(graph, &request(value)) {
        Ok(_) => panic!("expected a refusal"),
        Err(refusal) => refusal,
    }
}

#[test]
fn roots_name_the_callerless_triggered_events() {
    let graph = graph();
    let answer = inspect_ok(&graph, json!({ "mode": "roots" }));
    let callerless: Vec<&str> = list(&answer.report["roots"], "callerlessTriggeredEvents").iter().filter_map(|node| node["eventId"].as_str()).collect();
    assert_eq!(callerless, ["a.1"]);
    assert_eq!(answer.summary.expect("a summary")["callerlessTriggeredEvents"], 1);
}

#[test]
fn a_missing_event_is_not_found_with_near_names() {
    let graph = graph();
    let refused = refusal(&graph, json!({ "mode": "roots", "selector": { "kind": "event", "eventId": "a.3" } }));
    assert_eq!(refused.code, "EVENT_NOT_FOUND");
    assert!(refused.message.contains("did you mean"), "{}", refused.message);
    let suggestions: Vec<&str> = refused.details["suggestions"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(suggestions.contains(&"a.1") && suggestions.contains(&"a.2"));
    let namespace = refusal(&graph, json!({ "mode": "lint", "selector": { "kind": "namespace", "namespace": "zzz" } }));
    assert_eq!(namespace.code, "EVENT_NAMESPACE_NOT_FOUND");
    let node = refusal(&graph, json!({ "mode": "lint", "selector": { "kind": "node", "nodeId": "nothing" } }));
    assert_eq!(node.code, "EVENT_NODE_NOT_FOUND");
    let file = refusal(&graph, json!({ "mode": "lint", "selector": { "kind": "file", "sourcePath": "nowhere.txt" } }));
    assert_eq!(file.code, "EVENT_SOURCE_NOT_FOUND");
}

#[test]
fn modes_refuse_a_request_without_what_they_need() {
    let graph = graph();
    assert_eq!(refusal(&graph, json!({ "mode": "trace" })).code, "EVENT_SELECTOR_REQUIRED");
    assert_eq!(refusal(&graph, json!({ "mode": "explain_path", "from": { "kind": "event", "eventId": "a.1" } })).code, "EVENT_PATH_SELECTORS_REQUIRED");
    assert_eq!(refusal(&graph, json!({ "mode": "impact" })).code, "EVENT_IMPACT_SUBJECT_REQUIRED");
    assert_eq!(refusal(&graph, json!({ "mode": "helper_expansion" })).code, "invalid_request");
    let state = refusal(&graph, json!({ "mode": "state_flow", "stateSubject": { "kind": "country_flag", "name": "never_set" } }));
    assert_eq!(state.code, "EVENT_STATE_NOT_FOUND");
}

#[test]
fn a_route_through_a_helper_is_explained_and_its_reverse_is_not() {
    let graph = graph();
    let from = json!({ "kind": "event", "eventId": "a.1" });
    let to = json!({ "kind": "event", "eventId": "a.2" });
    let found = inspect_ok(&graph, json!({ "mode": "explain_path", "from": from, "to": to }));
    let explanation = &found.report["explanation"];
    assert_eq!(explanation["found"], true);
    assert!(list(explanation, "steps").len() >= 2);
    assert_eq!(found.summary.expect("a summary")["found"], true);
    let reverse = inspect_ok(&graph, json!({ "mode": "explain_path", "from": to, "to": from }));
    assert_eq!(reverse.report["explanation"]["found"], false);
    assert!(reverse.report["explanation"]["failureReason"].is_string());
}

#[test]
fn a_selector_narrows_the_findings() {
    let graph = graph();
    let all = inspect_ok(&graph, json!({ "mode": "lint" }));
    let narrowed = inspect_ok(&graph, json!({ "mode": "lint", "selector": { "kind": "event", "eventId": "a.2" } }));
    assert!(list(&narrowed.report, "issues").len() < list(&all.report, "issues").len());
    assert!(list(&narrowed.report, "issues").iter().all(|issue| text(issue, "code") != "EVENT_REFERENCE_MISSING"));
}

#[test]
fn a_trace_reports_its_boundary_and_a_summary() {
    let graph = graph();
    let answer =
        inspect_ok(&graph, json!({ "mode": "trace", "selector": { "kind": "event", "eventId": "a.1" }, "direction": "downstream", "expandHelpers": true }));
    let trace = &answer.report["trace"];
    assert!(list(trace, "nodes").iter().any(|node| node["eventId"] == "a.2"));
    let summary = answer.summary.expect("a summary");
    assert!(summary["trace"]["events"].as_u64().unwrap() >= 2);
    assert!(summary["issues"].is_u64());
}

#[test]
fn impact_of_a_helper_reaches_the_event_it_fires() {
    let graph = graph();
    let answer = inspect_ok(&graph, json!({ "mode": "impact", "impactSubject": { "kind": "helper", "name": "my_helper" } }));
    let impact = &answer.report["impact"];
    assert_eq!(list(impact, "directNodeIds").len(), 1);
    assert!(!list(impact, "downstreamNodeIds").is_empty());
}

#[test]
fn a_large_scan_reports_a_summary_instead_of_the_graph() {
    let graph = graph();
    let small = inspect::inspect_with_limit(&graph, &request(json!({ "mode": "scan" })), 1_000_000).unwrap();
    assert!(small.report["graph"].is_object());
    let large = inspect::inspect_with_limit(&graph, &request(json!({ "mode": "scan" })), 0).unwrap();
    assert!(large.report["graph"].is_null());
    assert_eq!(large.report["artifactProjection"]["mode"], "large-scan-summary");
    assert!(large.report["graphSummary"]["recordCounts"]["nodes"].as_u64().unwrap() > 0);
}

#[test]
fn source_hash_evidence_is_bounded_and_committed_to_every_entry() {
    let mut hashes = serde_json::Map::new();
    for index in 0..300 {
        hashes.insert(format!("mod:events/{index:04}.txt"), json!(format!("{index:064}")));
    }
    let (retained, inventory) = inspect::bounded_source_hash_evidence(&Value::Object(hashes.clone()));
    assert_eq!(retained.as_object().unwrap().len(), 256);
    assert_eq!(inventory["count"], 300);
    assert_eq!(inventory["truncated"], true);
    let (_, again) = inspect::bounded_source_hash_evidence(&Value::Object(hashes.clone()));
    assert_eq!(inventory["digest"], again["digest"]);
    hashes.insert("mod:events/9999.txt".into(), json!("f".repeat(64)));
    let (_, changed) = inspect::bounded_source_hash_evidence(&Value::Object(hashes));
    assert_ne!(inventory["digest"], changed["digest"]);
}

fn registry() -> Registry {
    let mut registry = Registry::new();
    crate::register(&mut registry);
    registry
}

#[test]
fn the_inspect_operation_answers_from_a_graph_in_the_payload_and_refuses_a_bad_one() {
    let registry = registry();
    let graph = graph();
    let bytes = serde_json::to_vec(&graph).unwrap();
    let request = json!({ "graphPayload": [0, bytes.len()], "params": { "mode": "roots" } });
    let answer = registry.dispatch("event.inspect", &OpContext::default(), &request, &bytes).unwrap();
    assert!(answer.result.is_ok());
    let body: Value = serde_json::from_slice(&answer.payload).expect("the body in the payload");
    assert!(body["report"]["roots"].is_object());

    let missing = json!({ "graphPayload": [0, bytes.len()], "params": { "mode": "roots", "selector": { "kind": "event", "eventId": "none.1" } } });
    let refused = registry.dispatch("event.inspect", &OpContext::default(), &missing, &bytes).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "EVENT_NOT_FOUND");
    assert!(refused["details"]["suggestions"].is_array());

    let past_the_end = json!({ "graphPayload": [0, bytes.len() + 1], "params": { "mode": "roots" } });
    let refused = registry.dispatch("event.inspect", &OpContext::default(), &past_the_end, &bytes).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "invalid_request");
    let not_json = json!({ "graphPayload": [0, 3], "params": { "mode": "roots" } });
    let refused = registry.dispatch("event.inspect", &OpContext::default(), &not_json, b"abc").unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "invalid_request");
    let malformed = json!({ "graphPayload": [0, 2], "params": { "mode": "roots" } });
    let refused = registry.dispatch("event.inspect", &OpContext::default(), &malformed, b"{}").unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "invalid_request");
}

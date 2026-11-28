//! Ported tests of the event queries, summaries and inspect modes, with exact expected values.
//!
//! Ported from `tests/unit/event-summary.test.ts` (own findings first, layer counts, callerless
//! events by layer, a path that does not exist), `tests/unit/event-explain-path-278.test.ts`
//! (explain_path agrees with trace on collapsed helper edges), and the inspect behaviours of
//! `src/hoi4_agent_tools/event/service.ts` that no other test pins: the selectors (manifest,
//! node, source with a column), the bounds (2000-entry inventories, trace limits), the work
//! ceiling and the not-found suggestions. `tests/unit/event-partial-reasons.test.ts` tests
//! `eventPartialReasons` in `operations.ts`, which stays in TypeScript, so it is not ported.

use serde_json::{Value, json};

use crate::graph_build::{build_graph, list, text};
use crate::graph_build_tests::{ENTRY, HELPER, SECOND, input};
use crate::inspect::{self, Request};
use crate::queries::Roots;
use crate::summary;

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

// ---- event-summary.test.ts ---------------------------------------------------------------

fn issue(code: &str, classification: &str, path: &str, line: u64, name: Option<&str>) -> Value {
    json!({
        "code": code,
        "classification": classification,
        "severity": "warning",
        "message": format!("{code} at {path}:{line}"),
        "confidence": "confirmed",
        "location": {
            "path": path,
            "start": { "line": line, "column": 1, "offset": line * 10 },
            "end": { "line": line, "column": 2, "offset": line * 10 + 1 },
        },
        "blockers": [],
        "details": name.map_or(json!({}), |name| json!({ "name": name })),
    })
}

fn event_node(event_id: &str, source_path: &str) -> Value {
    json!({ "id": format!("event:{event_id}"), "kind": "event", "label": event_id, "eventId": event_id, "sourcePath": source_path, "metadata": {} })
}

#[test]
fn the_summary_ranks_the_mods_own_findings_first_then_by_severity_and_bounds_the_list() {
    let mut issues = vec![
        issue("EVENT_REFERENCE_MISSING", "confirmed_error", "game:events/a.txt", 1, None),
        issue("EVENT_GATE_WITHOUT_WRITER", "design_warning", "mod:events/b.txt", 9, Some("late_flag")),
        issue("EVENT_TARGET_READ_BEFORE_SAVE", "probable_defect", "mod:events/b.txt", 4, Some("target")),
    ];
    for index in 0..12 {
        issues.push(issue("EVENT_OPTION_DANGLING", "design_warning", "mod:events/c.txt", index + 1, None));
    }
    let refs: Vec<&Value> = issues.iter().collect();
    let summary = summary::summarize_event_issues(&refs);
    assert_eq!(summary["issues"], 15);
    assert_eq!(summary["byLayer"], json!({ "game": 1, "mod": 14 }));
    // The most frequent code leads the list of codes.
    assert_eq!(summary["topCodes"]["EVENT_OPTION_DANGLING"], 12);
    let findings = summary["findings"].as_array().unwrap();
    assert_eq!(findings.len(), 10, "the inline finding count");
    assert_eq!(findings[0]["code"], "EVENT_TARGET_READ_BEFORE_SAVE");
    assert_eq!(findings[0]["path"], "mod:events/b.txt");
    assert_eq!(findings[0]["subject"], "target");
    assert!(findings.iter().all(|finding| !finding["path"].as_str().unwrap().starts_with("game:")), "the game finding is pushed out of the ten");
}

#[test]
fn callerless_events_of_the_mod_come_before_vanilla_and_are_counted_by_layer() {
    let vanilla = event_node("AAA_vanilla.1", "game:events/vanilla.txt");
    let own = event_node("zzz_mod.1", "mod:events/mod.txt");
    let roots = Roots {
        entry_points: Vec::new(),
        automatic_events: Vec::new(),
        known_root_event_ids: Vec::new(),
        callerless_triggered_events: vec![&vanilla, &own],
        components: Vec::new(),
    };
    let summary = summary::summarize_event_roots(&roots);
    assert_eq!(summary["callerlessTriggeredEventIds"], json!(["zzz_mod.1", "AAA_vanilla.1"]));
    assert_eq!(summary["callerlessTriggeredByLayer"], json!({ "game": 1, "mod": 1 }));
}

#[test]
fn a_path_summary_states_that_no_route_exists_and_why() {
    let summary = summary::summarize_event_path(&json!({
        "found": false,
        "fromNodeIds": ["event:a.1"],
        "toNodeIds": ["event:a.2"],
        "steps": [],
        "failureReason": "unreachable",
        "failureMessage": "No route connects the selected events",
        "unresolvedAssumptions": [],
        "boundary": { "maxDepth": 8, "maxNodes": 500, "expandHelpers": true },
    }));
    assert_eq!(
        summary,
        json!({
            "found": false,
            "steps": 0,
            "eventIds": [],
            "failureReason": "unreachable",
            "failureMessage": "No route connects the selected events",
            "unresolvedAssumptions": 0,
        })
    );
}

// ---- event-explain-path-278.test.ts ------------------------------------------------------

fn at(symbol: &str, offset: u64) -> Value {
    json!({
        "path": "mod:events/p.txt",
        "start": { "line": offset + 1, "column": 1, "offset": offset },
        "end": { "line": offset + 1, "column": 8, "offset": offset + 7 },
        "symbol": symbol,
    })
}

fn node(id: &str, kind: &str, metadata: Value) -> Value {
    let mut node = json!({ "id": id, "kind": kind, "label": id, "sourcePath": "mod:events/p.txt", "location": at(id, id.len() as u64), "metadata": metadata });
    if kind == "event" {
        let event_id = id.replace("event:", "");
        node["namespace"] = json!(event_id.split('.').next().unwrap());
        node["eventId"] = json!(event_id);
    }
    node
}

fn edge(id: &str, from: &str, to: &str, reason: &str) -> Value {
    json!({
        "id": id, "from": from, "to": to, "reason": reason, "conditions": [], "helperStack": [],
        "location": at(id, id.len() as u64 + 20),
        "provenance": [{ "role": "invocation", "location": at(id, id.len() as u64 + 20) }],
        "confidence": "confirmed", "derived": false, "metadata": {},
    })
}

/// A focused graph (issue 278): helpers are structural nodes and no derived edge is materialised.
fn focused_graph() -> Value {
    let edges = vec![
        edge("edge:a-option", "event:p.1", "option:p.1:a", "option_branch"),
        edge("edge:option-helper", "option:p.1:a", "helper:p_follow", "scripted_effect_call"),
        edge("edge:helper-event", "helper:p_follow", "event:p.2", "scripted_effect_expansion"),
    ];
    json!({
        "schemaVersion": 1, "parserVersion": "clausewitz-cst.v1", "workspaceId": "p", "revision": "p-revision", "complete": true,
        "sourceHashes": { "mod:events/p.txt": "00" }, "filesScanned": ["mod:events/p.txt"], "skippedSourceCount": 0, "skippedSources": [],
        "nodes": [
            node("event:p.1", "event", json!({})),
            node("option:p.1:a", "option", json!({})),
            node("helper:p_follow", "helper", json!({ "name": "p_follow" })),
            node("event:p.2", "event", json!({})),
        ],
        "edges": edges, "stateAccesses": [], "stateLinks": [], "issues": [], "diagnostics": [], "unresolved": [],
        "statistics": { "eventCount": 2, "optionCount": 1, "entryCount": 0, "helperCount": 1, "unresolvedNodeCount": 0, "terminalCount": 0, "edgeCount": 3, "derivedEdgeCount": 0, "stateAccessCount": 0, "issueCount": 0 },
    })
}

#[test]
fn explain_path_finds_the_path_the_trace_reports_when_helpers_are_collapsed_and_no_derived_edge_exists() {
    let graph = focused_graph();
    let trace = inspect_ok(
        &graph,
        json!({ "mode": "trace", "selector": { "kind": "event", "eventId": "p.1" }, "maxDepth": 6, "maxNodes": 100, "maxEdges": 100, "direction": "downstream", "expandHelpers": false }),
    );
    let ids: Vec<&str> = list(&trace.report["trace"], "nodes").iter().map(|node| text(node, "id")).collect();
    assert!(ids.contains(&"event:p.2"), "{ids:?}");
    let explained = inspect_ok(
        &graph,
        json!({
            "mode": "explain_path", "from": { "kind": "event", "eventId": "p.1" }, "to": { "kind": "event", "eventId": "p.2" },
            "maxDepth": 12, "maxNodes": 2000, "expandHelpers": false,
        }),
    );
    let explanation = &explained.report["explanation"];
    assert_eq!(explanation["found"], true);
    let steps: Vec<&str> = list(explanation, "steps").iter().map(|step| text(&step["node"], "id")).collect();
    assert_eq!(steps, ["event:p.1", "option:p.1:a", "event:p.2"]);
}

// ---- selectors ---------------------------------------------------------------------------

#[test]
fn a_manifest_selects_by_source_path_node_id_event_id_and_namespace() {
    let graph = graph();
    let b = graph["nodes"].as_array().unwrap().iter().find(|node| node["eventId"] == "a.2").expect("a.2");
    let path = b["sourcePath"].as_str().unwrap().to_string();
    let by_path = inspect_ok(&graph, json!({ "mode": "lint", "selector": { "kind": "manifest", "manifest": { "sourcePaths": [path] } } }));
    assert!(by_path.report["issues"].is_array());
    // The manifest resolves to the nodes of that file: tracing from it reaches a.2.
    let traced =
        inspect_ok(&graph, json!({ "mode": "trace", "selector": { "kind": "manifest", "manifest": { "sourcePaths": [path] } }, "direction": "downstream" }));
    let ids: Vec<&str> = list(&traced.report["trace"], "nodes").iter().filter_map(|node| node["eventId"].as_str()).collect();
    assert!(ids.contains(&"a.2"), "{ids:?}");
    let by_id = inspect_ok(&graph, json!({ "mode": "trace", "selector": { "kind": "manifest", "manifest": { "eventIds": ["a.1"] } } }));
    assert!(list(&by_id.report["trace"], "nodes").iter().any(|node| node["eventId"] == "a.1"));
    let missing = refusal(&graph, json!({ "mode": "lint", "selector": { "kind": "manifest", "manifest": { "sourcePaths": ["nowhere.txt"] } } }));
    assert_eq!(missing.code, "EVENT_SOURCE_NOT_FOUND");
}

#[test]
fn a_node_selector_that_matches_answers_and_the_source_selector_honours_the_column() {
    let graph = graph();
    let a1 = graph["nodes"].as_array().unwrap().iter().find(|node| node["eventId"] == "a.1").expect("a.1").clone();
    let found = inspect_ok(&graph, json!({ "mode": "trace", "selector": { "kind": "node", "nodeId": a1["id"] }, "direction": "downstream" }));
    assert!(list(&found.report["trace"], "nodes").iter().any(|node| node["id"] == a1["id"]));
    let location = &a1["location"];
    let line = location["start"]["line"].as_u64().unwrap();
    let column = location["start"]["column"].as_u64().unwrap();
    let inside =
        inspect_ok(&graph, json!({ "mode": "trace", "selector": { "kind": "source", "sourcePath": location["path"], "line": line, "column": column } }));
    assert!(list(&inside.report["trace"], "nodes").iter().any(|node| node["id"] == a1["id"]));
    // A column past the end of the line selects nothing on a single-line event, as in TypeScript.
    let end_line = location["end"]["line"].as_u64().unwrap();
    if end_line == line {
        let past = refusal(&graph, json!({ "mode": "trace", "selector": { "kind": "source", "sourcePath": location["path"], "line": line, "column": 9999 } }));
        assert_eq!(past.code, "EVENT_SOURCE_NOT_FOUND");
    }
}

// ---- bounds ------------------------------------------------------------------------------

#[test]
fn unresolved_and_issue_inventories_stop_at_two_thousand_entries_and_say_so() {
    let mut graph = graph();
    let unresolved: Vec<Value> = (0..2100)
        .map(|index| json!({ "id": format!("u{index:04}"), "kind": "dynamic_event", "expression": "x", "confidence": "unresolved", "blockers": [] }))
        .collect();
    let issues: Vec<Value> = (0..2100)
        .map(|index| json!({ "code": "EVENT_OPTION_DANGLING", "classification": "design_warning", "severity": "warning", "message": format!("m{index}"), "confidence": "confirmed", "blockers": [], "details": {} }))
        .collect();
    graph["unresolved"] = Value::Array(unresolved);
    graph["issues"] = Value::Array(issues);
    let lint = inspect_ok(&graph, json!({ "mode": "lint" }));
    assert_eq!(list(&lint.report, "issues").len(), 2000);
    assert_eq!(lint.report["issueInventory"], json!({ "count": 2100, "retainedCount": 2000, "truncated": true }));
    assert_eq!(list(&lint.report, "unresolved").len(), 2000);
    assert_eq!(lint.report["unresolvedInventory"], json!({ "count": 2100, "retainedCount": 2000, "truncated": true }));
    // Under the bound nothing is reported as cut.
    let small = inspect_ok(&self::graph(), json!({ "mode": "lint" }));
    assert!(small.report.get("issueInventory").is_none() && small.report.get("unresolvedInventory").is_none());
}

#[test]
fn a_trace_that_reaches_its_edge_limit_is_marked_truncated_and_keeps_the_limit() {
    let graph = graph();
    let cut = inspect_ok(
        &graph,
        json!({ "mode": "trace", "selector": { "kind": "event", "eventId": "a.1" }, "direction": "downstream", "expandHelpers": true, "maxEdges": 1, "maxNodes": 500, "maxDepth": 8 }),
    );
    assert_eq!(cut.report["trace"]["truncated"], true);
    assert!(list(&cut.report["trace"], "edges").len() <= 1);
    assert_eq!(cut.summary.expect("a summary")["trace"]["truncated"], true);
    let whole =
        inspect_ok(&graph, json!({ "mode": "trace", "selector": { "kind": "event", "eventId": "a.1" }, "direction": "downstream", "expandHelpers": true }));
    assert_eq!(whole.report["trace"]["truncated"], false);
}

// ---- work ceiling and suggestions --------------------------------------------------------

fn blocked(graph: &Value, value: Value) -> inspect::Refusal {
    match inspect::inspect_with_limits(graph, &request(value), 100_000, 1) {
        Ok(_) => panic!("expected the work ceiling to refuse"),
        Err(refusal) => refusal,
    }
}

#[test]
fn the_whole_graph_passes_stop_at_the_work_ceiling_instead_of_running_on() {
    let graph = graph();
    let owner = json!({ "kind": "event", "eventId": "a.1" });
    let cases = [
        json!({ "mode": "state_flow", "selector": owner }),
        json!({ "mode": "lint", "selector": owner }),
        json!({ "mode": "explain_path", "from": owner, "to": { "kind": "event", "eventId": "a.2" } }),
        json!({ "mode": "impact", "impactSubject": { "kind": "helper", "name": "my_helper" } }),
    ];
    for case in cases {
        let refused = blocked(&graph, case.clone());
        assert_eq!(refused.code, "EVENT_ANALYSIS_WORK_BLOCKED", "{case}");
        assert!(refused.message.contains("fixed work ceiling"), "{}", refused.message);
    }
    // The same requests pass under the real ceiling.
    assert!(inspect::inspect(&graph, &request(json!({ "mode": "state_flow", "selector": owner }))).is_ok());
}

#[test]
fn an_unknown_state_name_suggests_the_nearest_names() {
    let mut graph = graph();
    let access = |name: &str, id: &str| json!({ "id": id, "ownerId": "event:a.1", "kind": "country_flag", "name": name, "access": "write", "confidence": "confirmed", "scope": "country", "helperStack": [], "conditions": [], "dynamic": false, "metadata": {} });
    graph["stateAccesses"] = json!([access("flag_one", "s1"), access("flag_two", "s2"), access("unrelated_entirely", "s3")]);
    let refused = refusal(&graph, json!({ "mode": "state_flow", "stateSubject": { "kind": "country_flag", "name": "flag_onee" } }));
    assert_eq!(refused.code, "EVENT_STATE_NOT_FOUND");
    assert_eq!(refused.details["suggestions"], json!(["flag_one"]));
    assert!(refused.message.ends_with("; did you mean flag_one?"), "{}", refused.message);
    assert_eq!(refused.details["name"], "flag_onee");
    let far = refusal(&graph, json!({ "mode": "state_flow", "stateSubject": { "kind": "country_flag", "name": "zzzzzzzz" } }));
    assert_eq!(far.details["suggestions"], json!([]));
    assert!(!far.message.contains("did you mean"));
}

// ---- text rules ---------------------------------------------------------------------------

#[test]
fn near_names_that_tie_are_ordered_as_icu_orders_punctuation_digits_and_case() {
    // `new Intl.Collator('en').compare` on these pairs: punctuation before digits before letters,
    // lower case before upper case at the first difference, a shorter prefix first.
    let order = |a: &str, b: &str| inspect::locale_compare(a, b);
    use std::cmp::Ordering::{Greater, Less};
    assert_eq!(order("ns_1", "ns.1"), Less);
    assert_eq!(order("ns_1", "ns1"), Less);
    assert_eq!(order("ns.1", "ns1"), Less);
    assert_eq!(order("a", "A"), Less);
    assert_eq!(order("ab", "a_"), Greater);
    assert_eq!(order("a-b", "a_b"), Greater);
    assert_eq!(order("Ab", "aB"), Greater);
    assert_eq!(order("x", "x "), Less);
    assert_eq!(order(" x", "x"), Less);
    assert_eq!(order("event.10", "event.9"), Less);
}

#[test]
fn a_name_cut_inside_a_surrogate_pair_drops_the_half_pair() {
    // TypeScript's slice keeps a lone surrogate, which a Rust string cannot hold and strict JSON
    // refuses; the engine drops the half pair, so the cut text is valid UTF-8 and valid JSON.
    let name = format!("{}\u{1F600}tail", "a".repeat(255));
    let shown = inspect::slice_units(&name, 256);
    assert_eq!(shown, "a".repeat(255));
    let whole = format!("{}\u{1F600}", "a".repeat(254));
    assert_eq!(inspect::slice_units(&whole, 256), whole);
    assert!(serde_json::to_string(&shown).is_ok());
}

#[test]
fn a_request_with_a_fractional_or_negative_number_is_refused_as_invalid() {
    // The tool schemas (`schemas/event.ts`) accept only integers of 1 or more, so the adapter never
    // sends these; a caller that bypasses it gets the engine's generic refusal.
    for bad in [json!({ "mode": "trace", "maxDepth": 1.5 }), json!({ "mode": "trace", "maxNodes": -1 }), json!({ "mode": "trace", "maxEdges": "x" })] {
        assert!(serde_json::from_value::<Request>(bad.clone()).is_err(), "{bad}");
    }
    let registry = {
        let mut registry = hoi4_core::ops::Registry::new();
        crate::register(&mut registry);
        registry
    };
    let bytes = serde_json::to_vec(&graph()).unwrap();
    let request = json!({ "graphPayload": [0, bytes.len()], "params": { "mode": "roots", "maxDepth": 1.5 } });
    let refused = registry.dispatch("event.inspect", &hoi4_core::ops::OpContext::default(), &request, &bytes).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "invalid_request");
}

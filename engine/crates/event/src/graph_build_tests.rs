//! Tests of the event graph build over synthetic sources.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::graph_build::{BuildError, Input, Record, build_graph, list, text, text_opt, walk};
use crate::source_analysis::{Budget, Context, SourceFile, analyze_event_source};

fn fragments(files: &[(&str, &str)]) -> Vec<Value> {
    let analyze = |context: &Context| -> Vec<Value> {
        let mut budget = Budget::default();
        files
            .iter()
            .map(|(path, source)| {
                let file = SourceFile { relative_path: path, display_path: path, sha256: "hash", bytes: source.as_bytes() };
                analyze_event_source(&file, context, "key", &mut budget).expect("analysis stays within the work ceiling")
            })
            .collect()
    };
    let first = analyze(&Context::default());
    let mut events = HashSet::new();
    let mut helpers = HashSet::new();
    for fragment in &first {
        for node in list(fragment, "nodes") {
            match text(node, "kind") {
                "event" => {
                    if let Some(id) = text_opt(node, "eventId") {
                        events.insert(id.to_string());
                    }
                }
                "helper" => {
                    helpers.insert(text(node, "label").to_string());
                }
                _ => {}
            }
        }
    }
    analyze(&Context { known_event_ids: Some(events), known_helper_ids: Some(helpers), inventory_complete: Some(true), ..Context::default() })
}

fn input(files: &[(&str, &str)]) -> Input {
    Input {
        fragments: fragments(files),
        files: files.iter().map(|(path, _)| ((*path).to_string(), "hash".to_string())).collect(),
        workspace_id: "synthetic".into(),
        revision: "r1".into(),
        complete: true,
        project_helpers: true,
        ..Input::default()
    }
}

fn issue_codes(graph: &Value) -> Vec<String> {
    list(graph, "issues").iter().map(|issue| text(issue, "code").to_string()).collect()
}

const ENTRY: &str = "add_namespace = a\ncountry_event = { id = a.1 title = a.1.t desc = a.1.d is_triggered_only = yes immediate = { country_event = a.9 } option = { name = a.1.a my_helper = yes } }\n";
const HELPER: &str = "my_helper = { country_event = a.2 }\n";
const SECOND: &str = "country_event = { id = a.2 title = a.2.t desc = a.2.d is_triggered_only = yes option = { name = a.2.a } }\n";

fn derived(edge: &Value) -> bool {
    edge.get("derived").and_then(Value::as_bool).unwrap_or(false)
}

#[test]
fn a_call_to_an_undefined_event_adds_a_missing_node_and_a_finding() {
    let graph = build_graph(&input(&[("events/a.txt", ENTRY), ("common/scripted_effects/h.txt", HELPER), ("events/b.txt", SECOND)])).expect("graph");
    assert!(issue_codes(&graph).contains(&"EVENT_REFERENCE_MISSING".to_string()));
    let missing: Vec<&Value> =
        list(&graph, "nodes").iter().filter(|node| text(node, "kind") == "unresolved" && node["metadata"]["expression"] == json!("a.9")).collect();
    assert_eq!(missing.len(), 1, "one placeholder node for the missing event");
    let reports: Vec<&Value> = list(&graph, "unresolved").iter().filter(|u| text(u, "kind") == "missing_event" && text(u, "expression") == "a.9").collect();
    assert_eq!(reports.len(), 1);
}

#[test]
fn helper_calls_project_to_the_events_they_fire() {
    let sources = [("events/a.txt", ENTRY), ("common/scripted_effects/h.txt", HELPER), ("events/b.txt", SECOND)];
    let graph = build_graph(&input(&sources)).expect("graph");
    let projected: Vec<&Value> = list(&graph, "edges").iter().filter(|edge| derived(edge)).collect();
    assert_eq!(projected.len(), 1);
    assert_eq!(text(projected[0], "to"), "event:a.2");
    assert_eq!(text(projected[0], "reason"), "scripted_effect_expansion");
    let mut flat = input(&sources);
    flat.project_helpers = false;
    let flat = build_graph(&flat).expect("graph");
    assert!(list(&flat, "edges").iter().all(|edge| !derived(edge)));
}

#[test]
fn the_graph_does_not_depend_on_fragment_order() {
    let sources = [("events/a.txt", ENTRY), ("common/scripted_effects/h.txt", HELPER), ("events/b.txt", SECOND)];
    let forward = input(&sources);
    let mut reversed = forward.clone();
    reversed.fragments.reverse();
    assert_eq!(build_graph(&forward).expect("graph"), build_graph(&reversed).expect("graph"));
}

#[test]
fn an_event_that_fires_itself_at_once_is_reported() {
    let source = "country_event = { id = s.1 title = s.1.t desc = s.1.d immediate = { country_event = s.1 } option = { name = s.1.a } }\n";
    let graph = build_graph(&input(&[("events/s.txt", source)])).expect("graph");
    assert!(issue_codes(&graph).contains(&"EVENT_IMMEDIATE_SELF_CALL".to_string()));
}

#[test]
fn two_definitions_of_one_id_keep_both_nodes_and_report_the_duplicate() {
    let graph = build_graph(&input(&[("events/x.txt", SECOND), ("events/y.txt", SECOND)])).expect("graph");
    assert!(issue_codes(&graph).contains(&"EVENT_DUPLICATE_ID".to_string()));
    let ids: Vec<&str> = list(&graph, "nodes").iter().filter(|n| text(n, "kind") == "event").map(|n| text(n, "id")).collect();
    assert!(ids.contains(&"event:a.2"));
    assert!(ids.iter().any(|id| id.starts_with("event:a.2:duplicate:")));
}

#[test]
fn a_flag_written_before_a_call_and_read_after_it_is_linked() {
    let first = "country_event = { id = f.1 title = f.1.t desc = f.1.d is_triggered_only = yes immediate = { set_country_flag = seen country_event = f.2 } option = { name = f.1.a } }\n";
    let second =
        "country_event = { id = f.2 title = f.2.t desc = f.2.d is_triggered_only = yes trigger = { has_country_flag = seen } option = { name = f.2.a } }\n";
    let graph = build_graph(&input(&[("events/f1.txt", first), ("events/f2.txt", second)])).expect("graph");
    let links = list(&graph, "stateLinks");
    assert_eq!(links.len(), 1);
    assert_eq!(text(&links[0], "name"), "seen");
    assert_eq!(links[0]["pathConfirmed"], json!(true));
}

#[test]
fn a_partial_inventory_is_reported_and_the_graph_is_not_complete() {
    let mut partial = input(&[("events/b.txt", SECOND)]);
    partial.complete = false;
    partial.skipped_source_count = 2;
    let graph = build_graph(&partial).expect("graph");
    assert_eq!(graph["complete"], json!(false));
    assert!(list(&graph, "diagnostics").iter().any(|d| text(d, "code") == "EVENT_INVENTORY_PARTIAL"));
    assert!(list(&graph, "unresolved").iter().any(|u| text(u, "kind") == "partial_source"));
}

#[test]
fn focused_mode_defers_the_workspace_wide_passes() {
    let mut focused = input(&[("events/a.txt", ENTRY), ("events/b.txt", SECOND)]);
    focused.focused = true;
    let graph = build_graph(&focused).expect("graph");
    assert_eq!(graph["analysisMode"], json!("focused"));
    assert_eq!(graph["complete"], json!(false));
    assert!(list(&graph, "stateLinks").is_empty());
    assert!(list(&graph, "unresolved").iter().any(|u| text(u, "id") == "event-analysis-focused-boundary"));
}

#[test]
fn the_walk_refuses_duplicate_edge_ids_and_unknown_roots() {
    let edges = vec![("e".to_string(), "a".to_string(), "b".to_string()), ("e".to_string(), "b".to_string(), "c".to_string())];
    assert!(matches!(walk(edges, &["e".to_string()], &HashSet::new(), 4, 100), Err(BuildError::Input(_))));
    let edges = vec![("e".to_string(), "a".to_string(), "b".to_string())];
    assert!(matches!(walk(edges, &["missing".to_string()], &HashSet::new(), 4, 100), Err(BuildError::Input(_))));
}

#[test]
fn the_walk_stops_at_cycles_and_reports_truncation_at_its_step_ceiling() {
    let edges = vec![
        ("r".to_string(), "e".to_string(), "h1".to_string()),
        ("c1".to_string(), "h1".to_string(), "h2".to_string()),
        ("c2".to_string(), "h2".to_string(), "h1".to_string()),
    ];
    let branches: HashSet<String> = ["h1".to_string(), "h2".to_string()].into();
    let walked = walk(edges.clone(), &["r".to_string()], &branches, 8, 1_000).expect("walk");
    assert!(!walked.truncated);
    assert!(walked.records.iter().any(|(kind, _)| *kind == Record::Cycle));
    let cut = walk(edges, &["r".to_string()], &branches, 8, 2).expect("walk");
    assert!(cut.truncated);
}

#[test]
fn non_ascii_text_beside_event_targets_does_not_panic_the_analysis() {
    let source = "country_event = { id = n.1 title = n.1.t trigger = { check_variable = { v\u{e1}\u{e9} = event_target:foo } } option = { name = n.1.a } }\n# \u{e1} global_event_target:bar\n";
    let graph = build_graph(&input(&[("events/n.txt", source)])).expect("graph");
    assert!(list(&graph, "nodes").iter().any(|node| text(node, "id") == "event:n.1"));
}

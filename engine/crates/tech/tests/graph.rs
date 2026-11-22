//! Ports of the technology analysis tests onto synthetic sources: fragments, graph assembly,
//! diagnosis and queries. The fixtures are written here and copy no game or mod file.

use std::collections::HashSet;

use hoi4_core::canonical::sha256_hex;
use hoi4_core::files::{RootKind, ScannedFile};
use hoi4_tech::graph::{Lookups, Scan, build_graph};
use hoi4_tech::queries::{self, ImpactInput, LintFilter, TraceInput};
use hoi4_tech::source_analysis::{Context, analyze_source};
use serde_json::{Value, json};

fn file(relative: &str, text: &str, load_order: u32) -> (ScannedFile, Vec<u8>) {
    let bytes = text.as_bytes().to_vec();
    (
        ScannedFile {
            absolute_path: format!("/virtual/{relative}"),
            display_path: format!("mod:{relative}"),
            relative_path: relative.into(),
            root_kind: RootKind::Mod,
            load_order,
            size: bytes.len() as u64,
            modified_ms: 0,
            sha256: sha256_hex(&bytes),
            bytes: Vec::new(),
            shadowed_by: None,
        },
        bytes,
    )
}

const TECHNOLOGIES: &str = "technologies = {\n\
\talpha = {\n\t\tresearch_cost = 2\n\t\tstart_year = 1936\n\t\tfolder = { name = infantry_folder position = { x = 0 y = 0 } }\n\
\t\tpath = { leads_to_tech = beta research_cost_coeff = 1 }\n\t\tcategories = { infantry_tech }\n\t\tenable_equipments = { rifle_1 }\n\t\tmax_organisation = 0.1\n\t}\n\
\tbeta = {\n\t\tresearch_cost = 2\n\t\tstart_year = 1938\n\t\tfolder = { name = infantry_folder position = { x = 0 y = 1 } }\n\
\t\tcategories = { infantry_tech missing_tech }\n\t\tpath = { leads_to_tech = gone }\n\t\tmax_organisation = 0.2\n\t}\n}\n";

fn fragments() -> (Vec<Value>, Vec<ScannedFile>) {
    let context = Context { helper_ids: HashSet::from(["grant_alpha".to_string()]) };
    let sources = [
        file("common/technologies/infantry.txt", TECHNOLOGIES, 1),
        file("common/technology_tags/tags.txt", "technology_categories = {\n\tinfantry_tech\n}\n", 1),
        file("common/technology_tags/folders.txt", "technology_folders = {\n\tinfantry_folder = { }\n}\n", 1),
        file("common/units/equipment/rifles.txt", "equipments = {\n\trifle_1 = { year = 1936 }\n}\n", 1),
        file(
            "common/scripted_effects/fx.txt",
            "grant_alpha = {\n\tset_technology = { alpha = 1 }\n\tadd_tech_bonus = { name = b technology = beta bonus = 1 uses = 1 }\n}\n",
            1,
        ),
        file("events/e.txt", "country_event = {\n\tid = t.1\n\timmediate = { grant_alpha = yes\n\t\tset_technology = { nowhere = 1 } }\n}\n", 1),
    ];
    let mut fragments = Vec::new();
    let mut files = Vec::new();
    for (scanned, bytes) in sources {
        fragments.push(analyze_source(&scanned, &bytes, &context));
        files.push(scanned);
    }
    (fragments, files)
}

fn graph() -> Value {
    let (fragments, files) = fragments();
    let scan = Scan {
        workspace_id: "w".into(),
        workspace_identity: "id".into(),
        revision: "r".into(),
        complete: true,
        skipped_source_count: 0,
        skipped_sources: json!([]),
        diagnostics: vec![],
        files,
        asset_files: vec![],
        analysis_mode: None,
    };
    build_graph(&fragments, &scan, &Lookups::default()).expect("graph")
}

fn issue_codes(graph: &Value) -> Vec<String> {
    graph["issues"].as_array().unwrap().iter().map(|i| i["code"].as_str().unwrap().to_string()).collect()
}

#[test]
fn a_technology_file_gives_definitions_edges_placements_and_unlocks() {
    let graph = graph();
    assert_eq!(graph["technologies"].as_array().unwrap().len(), 2);
    assert_eq!(graph["edges"].as_array().unwrap().len(), 2);
    assert_eq!(graph["placements"].as_array().unwrap().len(), 2);
    assert_eq!(graph["unlocks"][0]["targetId"], "rifle_1");
    assert_eq!(graph["unlocks"][0]["resolved"], true);
    assert_eq!(graph["technologies"][0]["effectKeys"], json!(["max_organisation"]));
    assert_eq!(graph["technologies"][0]["startYear"], "1936");
    assert_eq!(graph["categories"][0]["id"], "infantry_tech");
    assert!(graph["technologies"][0].get("iconSprite").is_none());
}

#[test]
fn the_graph_is_deterministic() {
    assert_eq!(graph(), graph());
    assert_eq!(graph()["revision"], graph()["revision"]);
}

#[test]
fn diagnosis_finds_missing_targets_categories_and_references() {
    let codes = issue_codes(&graph());
    for expected in [
        "TECH_TARGET_MISSING",
        "TECH_CATEGORY_REFERENCE_MISSING",
        "TECH_EXTERNAL_REFERENCE_MISSING",
        "TECH_LOCALISATION_MISSING",
        "TECH_ICON_SPRITE_MISSING",
    ] {
        assert!(codes.iter().any(|c| c == expected), "{expected} in {codes:?}");
    }
    assert!(!codes.iter().any(|c| c == "TECH_PREREQUISITE_CYCLE"));
}

#[test]
fn helper_calls_project_the_scripted_effect_references_onto_the_caller() {
    let graph = graph();
    let references = graph["externalReferences"].as_array().unwrap();
    let projected: Vec<&Value> = references.iter().filter(|r| r["sourceKind"] == "event").collect();
    assert!(projected.iter().any(|r| r["technologyId"] == "alpha" && r["kind"] == "grant" && r["helperStack"] == json!(["grant_alpha"])));
    assert!(projected.iter().any(|r| r["technologyId"] == "nowhere" && r["kind"] == "grant"));
}

#[test]
fn a_prerequisite_cycle_is_reported_once() {
    let context = Context { helper_ids: HashSet::new() };
    let text = "technologies = {\n\ta = { path = { leads_to_tech = b } }\n\tb = { path = { leads_to_tech = a } }\n}\n";
    let (scanned, bytes) = file("common/technologies/c.txt", text, 1);
    let fragment = analyze_source(&scanned, &bytes, &context);
    let scan = Scan {
        workspace_id: "w".into(),
        workspace_identity: "id".into(),
        revision: "r".into(),
        complete: true,
        skipped_source_count: 0,
        skipped_sources: json!([]),
        diagnostics: vec![],
        files: vec![scanned],
        asset_files: vec![],
        analysis_mode: None,
    };
    let graph = build_graph(&[fragment], &scan, &Lookups::default()).unwrap();
    let cycles: Vec<&Value> = graph["issues"].as_array().unwrap().iter().filter(|i| i["code"] == "TECH_PREREQUISITE_CYCLE").collect();
    assert_eq!(cycles.len(), 1);
    assert_eq!(cycles[0]["details"]["technologyIds"], json!(["a", "b"]));
}

#[test]
fn queries_trace_explain_and_refuse_unknown_subjects() {
    let graph = graph();
    let trace = queries::trace(&graph, &TraceInput { technology_id: "beta", direction: "prerequisites", max_depth: 4, max_nodes: 10, include_sub_technologies: true }).unwrap();
    assert_eq!(trace["nodes"], json!(["alpha", "beta"]));
    assert_eq!(trace["truncated"], false);
    let limited = queries::trace(&graph, &TraceInput { technology_id: "beta", direction: "prerequisites", max_depth: 0, max_nodes: 10, include_sub_technologies: true }).unwrap();
    assert_eq!(limited["truncated"], true);
    assert_eq!(limited["boundary"], json!(["alpha"]));
    let bad = queries::trace(&graph, &TraceInput { technology_id: "beta", direction: "both", max_depth: 999, max_nodes: 10, include_sub_technologies: false }).unwrap_err();
    assert_eq!(bad.code, "TECH_TRACE_LIMIT_INVALID");
    assert_eq!(queries::explain(&graph, "zzz").unwrap_err().code, "TECHNOLOGY_NOT_FOUND");
    let report = queries::explain(&graph, "alpha").unwrap();
    let summary = queries::explain_summary(&report).unwrap();
    assert_eq!(summary["leadsTo"], json!(["beta"]));
    assert_eq!(summary["allDescendants"], 1);
    assert_eq!(summary["unlockCount"], 1);
}

#[test]
fn lint_unlock_bonus_and_impact_queries_filter_the_graph() {
    let graph = graph();
    let classes = vec!["confirmed_error".to_string()];
    let lint = queries::lint(&graph, &LintFilter { classifications: Some(&classes), codes: None, folder_id: None, technology_id: Some("beta") });
    assert!(lint["issueCount"].as_u64().unwrap() >= 1);
    assert!(lint["issues"].as_array().unwrap().iter().all(|i| i["classification"] == "confirmed_error"));
    let unlocks = queries::inspect_unlocks(&graph, Some("alpha"), None, None).unwrap();
    assert_eq!(unlocks["unlocks"].as_array().unwrap().len(), 1);
    assert_eq!(unlocks["targets"].as_array().unwrap().len(), 1);
    let coverage = queries::bonus_coverage(&graph, Some("infantry_tech"), None).unwrap();
    assert_eq!(coverage["rows"][0]["technologyIds"], json!(["alpha", "beta"]));
    assert_eq!(queries::bonus_coverage(&graph, Some("nope"), None).unwrap_err().code, "TECH_CATEGORY_NOT_FOUND");
    let impact = queries::impact(&graph, &ImpactInput { kind: "technology", id: "alpha", operation: "rename", replacement_id: Some("beta") }).unwrap();
    assert_eq!(impact["replacementCollision"], true);
    assert_eq!(impact["wouldBreakReferences"], true);
    assert_eq!(queries::impact(&graph, &ImpactInput { kind: "technology", id: "alpha", operation: "rename", replacement_id: None }).unwrap_err().code, "TECH_IMPACT_REPLACEMENT_REQUIRED");
}

#[test]
fn a_scan_report_includes_the_graph_below_the_record_limit_and_a_summary_above_it() {
    let graph = graph();
    assert_eq!(queries::scan_report(&graph, None)["authoritativeGraphIncluded"], true);
    let large = queries::scan_report(&graph, Some(3));
    assert_eq!(large["authoritativeGraphIncluded"], false);
    assert_eq!(large["artifactProjection"]["fullGraphRecordLimit"], 3);
}

#[test]
fn dynamic_references_stay_unresolved_instead_of_guessed() {
    let context = Context { helper_ids: HashSet::new() };
    let text = "technologies = {\n\ta = { path = { leads_to_tech = \"[This.GetName]\" } enable_equipments = { var:x } }\n}\n";
    let (scanned, bytes) = file("common/technologies/d.txt", text, 1);
    let fragment = analyze_source(&scanned, &bytes, &context);
    assert_eq!(fragment["edges"].as_array().unwrap().len(), 0);
    assert_eq!(fragment["unresolved"].as_array().unwrap().len(), 2);
    assert_eq!(fragment["unresolved"][0]["confidence"], "unresolved");
}

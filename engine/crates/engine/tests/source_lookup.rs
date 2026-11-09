//! `hoi4-engine source-lookup` on synthetic layers written here.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::source_lookup::respond_json;
use serde_json::{Value, json};

const PATTERNS: &[&str] = &["events/**/*.txt", "common/scripted_effects/**/*.txt", "localisation/english/**/*.yml"];

fn layer(test: &str, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("source-lookup").join(test).join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    for (path, text) in files {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, text).unwrap();
    }
    root
}

fn root(kind: &str, path: &Path, load_order: i64) -> Value {
    json!({ "kind": kind, "path": path, "loadOrder": load_order, "replacePaths": [] })
}

fn request(roots: Vec<Value>, extra: Value) -> String {
    let mut request = json!({ "schema": "hoi4-source-lookup-request/1", "roots": roots, "patterns": PATTERNS });
    for (key, value) in extra.as_object().unwrap() {
        request[key] = value.clone();
    }
    request.to_string()
}

fn answer(text: &str) -> Value {
    let (json, code) = respond_json(text);
    assert_eq!(code, 0, "{json}");
    serde_json::from_str(&json).unwrap()
}

const EVENTS: &str = "add_namespace = ns\ncountry_event = {\n  id = ns.1\n  title = a\n}\ncountry_event = { id = ns.2 }\n";

#[test]
fn a_definition_names_its_lines_file_and_hash() {
    let game = layer("lines", "game", &[("events/a.txt", EVENTS)]);
    let text = request(vec![root("game", &game, 0)], json!({ "symbol": "ns.1" }));
    let response = answer(&text);
    assert_eq!(response["schema"], "hoi4-source-lookup/1");
    assert_eq!(response["definitionCount"], 1);
    assert_eq!(response["kindCount"], 1);
    let definition = &response["definitions"][0];
    assert_eq!(definition["kind"], "event");
    assert_eq!(definition["path"], "game:events/a.txt");
    assert_eq!(definition["rootKind"], "game");
    assert_eq!(definition["startLine"], 2);
    assert_eq!(definition["endLine"], 5);
    assert_eq!(definition["overridden"], false);
    assert!(definition["absolutePath"].as_str().unwrap().ends_with("a.txt"));
    assert_eq!(definition["sha256"].as_str().unwrap().len(), 64);
    // A one-line definition starts and ends on its line.
    let one = answer(&request(vec![root("game", &game, 0)], json!({ "symbol": "ns.2" })));
    assert_eq!(one["definitions"][0]["startLine"], 6);
    assert_eq!(one["definitions"][0]["endLine"], 6);
    assert!(response["suggestionCandidates"].as_array().unwrap().is_empty());
}

#[test]
fn the_active_definition_comes_first_and_the_total_counts_all() {
    let game = layer("order", "game", &[("events/a.txt", EVENTS)]);
    let changed = "country_event = { id = ns.1 }\n";
    let patch = layer("order", "mod", &[("events/a.txt", changed), ("events/b.txt", changed)]);
    let roots = || vec![root("game", &game, 0), root("mod", &patch, 1)];
    let all = answer(&request(roots(), json!({ "symbol": "ns.1", "maxDefinitions": 10 })));
    assert_eq!(all["definitionCount"], 3);
    let overridden: Vec<bool> = all["definitions"].as_array().unwrap().iter().map(|d| d["overridden"].as_bool().unwrap()).collect();
    assert!(!overridden[0]);
    assert_eq!(all["definitions"][0]["rootKind"], "mod");
    let first = answer(&request(roots(), json!({ "symbol": "ns.1" })));
    assert_eq!(first["definitions"].as_array().unwrap().len(), 1);
    assert_eq!(first["definitionCount"], 3);
}

#[test]
fn a_kind_filter_and_distinct_kinds() {
    let game =
        layer("kinds", "game", &[("events/a.txt", "country_event = { id = shared }\n"), ("common/scripted_effects/a.txt", "shared = { add_stability = 1 }\n")]);
    let both = answer(&request(vec![root("game", &game, 0)], json!({ "symbol": "shared", "maxDefinitions": 5 })));
    assert_eq!(both["kindCount"], 2);
    assert_eq!(both["definitionCount"], 2);
    let one = answer(&request(vec![root("game", &game, 0)], json!({ "symbol": "shared", "kind": "scripted_effect" })));
    assert_eq!(one["kindCount"], 1);
    assert_eq!(one["definitions"][0]["kind"], "scripted_effect");
}

#[test]
fn the_revision_follows_the_files() {
    let game = layer("revision", "game", &[("events/a.txt", EVENTS)]);
    let text = request(vec![root("game", &game, 0)], json!({ "symbol": "ns.1" }));
    let first = answer(&text);
    assert_eq!(first["revision"].as_str().unwrap().len(), 64);
    assert_eq!(answer(&text)["revision"], first["revision"]);
    fs::write(game.join("events/a.txt"), format!("{EVENTS}# edit\n")).unwrap();
    let second = answer(&text);
    assert_ne!(second["revision"], first["revision"]);
    assert_ne!(second["definitions"][0]["sha256"], first["definitions"][0]["sha256"]);
}

#[test]
fn a_missed_lookup_offers_near_names() {
    let game = layer("near", "game", &[("events/a.txt", EVENTS)]);
    let response = answer(&request(vec![root("game", &game, 0)], json!({ "symbol": "ns.3" })));
    assert_eq!(response["definitionCount"], 0);
    assert!(response["definitions"].as_array().unwrap().is_empty());
    let names: Vec<&str> = response["suggestionCandidates"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert!(names.contains(&"ns.1") && names.contains(&"ns.2"), "{names:?}");
    assert!(response["suggestionCandidates"][0]["distance"].as_u64().unwrap() <= 3);
}

#[test]
fn bad_requests_are_refused_with_codes() {
    let game = layer("refuse", "game", &[("events/a.txt", EVENTS)]);
    let (json, code) = respond_json(&request(vec![root("game", &game, 0)], json!({ "symbol": "x", "kind": "nope" })));
    assert_eq!(code, 2);
    assert!(json.contains("SOURCE_LOOKUP_INVALID_REQUEST"), "{json}");
    let relative = json!({ "kind": "game", "path": "relative/path", "loadOrder": 0, "replacePaths": [] });
    let (json, code) = respond_json(&request(vec![relative], json!({ "symbol": "x" })));
    assert_eq!(code, 2);
    assert!(json.contains("not an absolute path"), "{json}");
    let (json, code) = respond_json(&json!({ "schema": "other/1", "roots": [], "patterns": [], "symbol": "x" }).to_string());
    assert_eq!(code, 2);
    assert!(json.contains("schema must be"), "{json}");
    let (_, code) = respond_json(&request(vec![root("game", &game, 0)], json!({ "symbol": "x", "unknown": 1 })));
    assert_eq!(code, 2);
}

const REFERENCE_PATTERNS: &[&str] = &[
    "events/**/*.txt",
    "common/national_focus/**/*.txt",
    "common/technologies/**/*.txt",
    "common/ideas/**/*.txt",
    "common/decisions/**/*.txt",
    "common/scripted_effects/**/*.txt",
    "common/on_actions/**/*.txt",
];

fn references_request(roots: Vec<Value>, symbol: &str, extra: Value) -> String {
    let mut request = json!({
        "schema": "hoi4-source-lookup-request/1",
        "roots": roots,
        "patterns": REFERENCE_PATTERNS,
        "symbol": symbol,
        "includeReferences": true,
        "maxReferences": 20,
    });
    for (key, value) in extra.as_object().unwrap() {
        request[key] = value.clone();
    }
    request.to_string()
}

fn kinds_of(response: &Value) -> Vec<(String, String)> {
    response["references"].as_array().unwrap().iter().map(|r| (r["kind"].as_str().unwrap().to_string(), r["from"].as_str().unwrap().to_string())).collect()
}

const FOCUSES: &str = "focus_tree = {
  id = tree_a
  focus = { id = F1 icon = GFX_x }
  focus = {
    id = F2
    prerequisite = { focus = F1 focus = F1 }
    mutually_exclusive = { focus = F3 }
    relative_position_id = F1
  }
  focus = { id = F3 }
}
shared_focus = { id = S1 prerequisite = { focus = F1 } }
";

#[test]
fn focus_references_come_from_the_definition_walk() {
    let game = layer("focus-refs", "game", &[("common/national_focus/t.txt", FOCUSES)]);
    let response = answer(&references_request(vec![root("game", &game, 0)], "F1", json!({})));
    // Two prerequisites on one line stay two references; a shared focus records none.
    assert_eq!(response["referenceCount"], 3);
    assert_eq!(
        kinds_of(&response),
        [("focus_prerequisite".into(), "F2".into()), ("focus_prerequisite".into(), "F2".into()), ("focus_relative_position".into(), "F2".into())]
    );
    assert_eq!(response["references"][0]["toKind"], "focus");
    assert_eq!(response["references"][0]["path"], "game:common/national_focus/t.txt");
    assert_eq!(response["references"][0]["line"], 6);
    let icon = answer(&references_request(vec![root("game", &game, 0)], "GFX_x", json!({})));
    assert_eq!(kinds_of(&icon), [("focus_icon".into(), "F1".into())]);
    assert_eq!(icon["references"][0]["toKind"], "sprite");
    // The list is cut at maxReferences, the count is not.
    let cut = answer(&references_request(vec![root("game", &game, 0)], "F1", json!({ "maxReferences": 1 })));
    assert_eq!(cut["references"].as_array().unwrap().len(), 1);
    assert_eq!(cut["referenceCount"], 3);
    // Without includeReferences the answer names none.
    let plain = answer(&request(vec![root("game", &game, 0)], json!({ "symbol": "F1" })));
    assert_eq!(plain["referenceCount"], 0);
    assert!(plain["references"].as_array().unwrap().is_empty());
}

const TECHNOLOGIES: &str = "technologies = {
  tech_a = { path = { leads_to_tech = tech_b } xor = { tech_c } categories = { cat_x } enable_equipments = { eq_1 } enable_building = { building = bld } }
  tech_b = { folder = { name = fold } }
  tech_c = { }
}
";

#[test]
fn technology_references_cover_paths_exclusions_unlocks_and_buildings() {
    let game = layer("tech-refs", "game", &[("common/technologies/t.txt", TECHNOLOGIES)]);
    let roots = || vec![root("game", &game, 0)];
    assert_eq!(kinds_of(&answer(&references_request(roots(), "tech_b", json!({})))), [("technology_prerequisite".into(), "tech_a".into())]);
    assert_eq!(kinds_of(&answer(&references_request(roots(), "tech_c", json!({})))), [("technology_exclusive".into(), "tech_a".into())]);
    for (symbol, kind, to_kind) in [
        ("cat_x", "technology_category", "technology_category"),
        ("eq_1", "technology_enable_equipments", "equipment"),
        ("bld", "technology_enable_building", "building"),
        ("fold", "technology_folder", "technology_folder"),
    ] {
        let response = answer(&references_request(roots(), symbol, json!({})));
        assert_eq!(response["references"][0]["kind"], kind, "{symbol}");
        assert_eq!(response["references"][0]["toKind"], to_kind, "{symbol}");
    }
}

const EVENT_USES: &str = "country_event = {
  id = ns.1
  title = ns.1.t
  option = {
    name = ns.1.a
    add_ideas = idea_x
    add_ideas = idea_x
    has_idea = dyn_$X$
    set_country_flag = my_flag
    other_effect = { has_idea = idea_x }
  }
}
";

#[test]
fn semantic_references_are_deduplicated_by_place_and_count_unresolved() {
    let game = layer("semantic", "game", &[("events/a.txt", EVENT_USES)]);
    let roots = || vec![root("game", &game, 0)];
    let idea = answer(&references_request(roots(), "idea_x", json!({})));
    // Three uses at three places; the semantic list is sorted by path, owner, kind, target and edge.
    assert_eq!(idea["referenceCount"], 3);
    assert_eq!(kinds_of(&idea), [("add_ideas".into(), "ns.1".into()), ("add_ideas".into(), "ns.1".into()), ("has_idea".into(), "ns.1".into())]);
    assert_eq!(idea["references"][0]["toKind"], "idea");
    // `dyn_$X$` is a dynamic target: counted as unresolved for the whole scan, never a reference.
    assert_eq!(idea["unresolvedReferenceCount"], 1);
    assert_eq!(idea["semanticComplete"], true);
    let flag = answer(&references_request(roots(), "country:my_flag", json!({})));
    assert_eq!(kinds_of(&flag), [("flag_write".into(), "ns.1".into())]);
    let text = answer(&references_request(roots(), "ns.1.t", json!({})));
    assert_eq!(kinds_of(&text), [("localisation_key".into(), "ns.1".into())]);
    assert_eq!(text["references"][0]["toKind"], "localisation");
    // A kind filter keeps only references to that kind.
    let none = answer(&references_request(roots(), "idea_x", json!({ "kind": "event" })));
    assert_eq!(none["referenceCount"], 0);
}

#[test]
fn only_the_active_definition_owns_its_references() {
    let used = "country_event = { id = ns.1 option = { add_ideas = idea_x } }\n";
    let game = layer("owner", "game", &[("events/a.txt", used)]);
    // The mod defines the same event in another file: the mod's definition is the active one.
    let patch = layer("owner", "mod", &[("events/b.txt", "country_event = { id = ns.1 }\n")]);
    let response = answer(&references_request(vec![root("game", &game, 0), root("mod", &patch, 1)], "idea_x", json!({})));
    assert_eq!(response["referenceCount"], 0);
    // Without the override the game's event owns the use.
    let alone = answer(&references_request(vec![root("game", &game, 0)], "idea_x", json!({})));
    assert_eq!(alone["referenceCount"], 1);
}

#[test]
fn a_shadowed_file_records_no_references() {
    let game = layer("shadow", "game", &[("common/national_focus/t.txt", FOCUSES)]);
    let patch = layer("shadow", "mod", &[("common/national_focus/t.txt", "focus_tree = { id = tree_a focus = { id = F9 } }\n")]);
    let response = answer(&references_request(vec![root("game", &game, 0), root("mod", &patch, 1)], "F1", json!({})));
    assert_eq!(response["referenceCount"], 0);
}

#[test]
fn on_actions_own_their_events_and_a_skipped_source_makes_the_scan_incomplete() {
    let game = layer(
        "on-action",
        "game",
        &[
            ("common/on_actions/o.txt", "on_actions = { on_daily = { effect = { country_event = { id = ns.1 } } } }\n"),
            ("events/a.txt", "country_event = { id = ns.1 }\n"),
        ],
    );
    let response = answer(&references_request(vec![root("game", &game, 0)], "ns.1", json!({})));
    assert_eq!(kinds_of(&response), [("country_event".into(), "on_daily".into())]);
    assert_eq!(response["semanticComplete"], true);
    // A source past the parser's line ceiling is skipped; the semantic scan reports that.
    let big = format!("country_event = {{ id = ns.9 }}\n{}", "# padding\n".repeat(2_100_000));
    let game = layer("on-action", "big", &[("events/big.txt", &big)]);
    let response = answer(&references_request(vec![root("game", &game, 0)], "ns.9", json!({})));
    assert_eq!(response["semanticComplete"], false);
    assert_eq!(response["complete"], false);
}

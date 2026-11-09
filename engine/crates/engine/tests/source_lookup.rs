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

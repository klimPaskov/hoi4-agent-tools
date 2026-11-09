//! `hoi4-engine closure` on synthetic layers written here.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::closure::respond_json;
use serde_json::{Value, json};

const PATTERNS: &[&str] = &[
    "events/**/*.txt",
    "common/national_focus/**/*.txt",
    "common/ideas/**/*.txt",
    "common/technologies/**/*.txt",
    "common/scripted_effects/**/*.txt",
    "interface/**/*.gfx",
    "localisation/**/*.yml",
];

fn layer(test: &str, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("closure").join(test).join(name);
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

fn answer(roots: Vec<Value>) -> Value {
    let text = json!({ "schema": "hoi4-closure-request/1", "roots": roots, "patterns": PATTERNS }).to_string();
    let (json, code) = respond_json(&text);
    assert_eq!(code, 0, "{json}");
    serde_json::from_str(&json).unwrap()
}

fn counts<'a>(response: &'a Value, kind: &str) -> &'a Value {
    response["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == kind).unwrap_or_else(|| panic!("no {kind} in {response}"))
}

const GAME_IDEAS: &str = "ideas = { country = { game_idea = { } } }\n";
const GAME_GFX: &str = "spriteTypes = { spriteType = { name = GFX_game texturefile = \"gfx/a.dds\" } }\n";

#[test]
fn every_reference_of_the_mod_resolves_against_the_game_and_the_mod() {
    let game = layer("closed", "game", &[("common/ideas/g.txt", GAME_IDEAS), ("interface/g.gfx", GAME_GFX)]);
    let patch = layer(
        "closed",
        "mod",
        &[
            ("events/e.txt", "country_event = { id = ns.1 title = ns.1.t option = { add_ideas = game_idea add_ideas = mod_idea } }\n"),
            ("common/ideas/m.txt", "ideas = { country = { mod_idea = { } } }\n"),
            ("localisation/english/e_l_english.yml", "l_english:\n ns.1.t:0 \"Title\"\n"),
            ("common/national_focus/f.txt", "focus_tree = { id = t focus = { id = A icon = GFX_game } focus = { id = B prerequisite = { focus = A } } }\n"),
        ],
    );
    let response = answer(vec![root("game", &game, 0), root("mod", &patch, 1)]);
    assert_eq!(response["schema"], "hoi4-closure/1");
    assert_eq!(response["verdict"], "closed", "{response}");
    assert_eq!(response["totals"]["unresolved"], 0);
    assert_eq!(response["totals"]["unknown"], 0);
    assert_eq!(counts(&response, "idea")["resolved"], 2);
    assert_eq!(counts(&response, "localisation")["resolved"], 1);
    assert_eq!(counts(&response, "focus")["resolved"], 1);
    assert_eq!(counts(&response, "sprite")["resolved"], 1);
    assert_eq!(response["sources"], 2);
    assert_eq!(response["revision"].as_str().unwrap().len(), 64);
}

#[test]
fn a_missing_definition_is_unresolved_and_the_game_alone_is_not_counted() {
    // The game itself points at a missing idea; only the mod's own sources count.
    let game = layer("missing", "game", &[("events/g.txt", "country_event = { id = g.1 option = { add_ideas = game_missing } }\n")]);
    let patch = layer("missing", "mod", &[("events/e.txt", "country_event = { id = ns.1 option = { add_ideas = nowhere } }\n")]);
    let response = answer(vec![root("game", &game, 0), root("mod", &patch, 1)]);
    assert_eq!(response["verdict"], "unresolved", "{response}");
    assert_eq!(counts(&response, "idea")["unresolved"], 1);
    assert_eq!(counts(&response, "idea")["resolved"], 0);
    assert_eq!(response["totals"]["unresolved"], 1);
}

#[test]
fn dynamic_targets_and_unwritten_flags_are_unknown() {
    let patch = layer(
        "unknown",
        "mod",
        &[(
            "events/e.txt",
            "country_event = { id = ns.1 option = { add_ideas = dyn_$X$ has_country_flag = never_set set_country_flag = set_here has_country_flag = set_here } }\n",
        )],
    );
    let response = answer(vec![root("mod", &patch, 0)]);
    assert_eq!(response["verdict"], "incomplete", "{response}");
    // The dynamic idea and the flag nobody writes are unknown; the write and its read resolve.
    assert_eq!(counts(&response, "idea")["unknown"], 1);
    assert_eq!(counts(&response, "flag")["unknown"], 1);
    assert_eq!(counts(&response, "flag")["resolved"], 2);
    assert_eq!(response["totals"]["unknown"], 2);
}

#[test]
fn a_skipped_source_makes_the_verdict_incomplete() {
    let big = format!("country_event = {{ id = ns.9 }}\n{}", "# padding\n".repeat(2_100_000));
    let patch = layer("skipped", "mod", &[("events/big.txt", &big), ("events/e.txt", "country_event = { id = ns.1 option = { add_ideas = absent } }\n")]);
    let response = answer(vec![root("mod", &patch, 0)]);
    assert_eq!(response["complete"], false);
    // The idea is missing, but the skipped events file cannot define ideas, so it stays unresolved
    // in the counts; the verdict is still incomplete because the index is partial.
    assert_eq!(counts(&response, "idea")["unresolved"], 1);
    assert_eq!(response["verdict"], "incomplete");
}

#[test]
fn bad_requests_are_refused_with_codes() {
    let (json, code) = respond_json("not json");
    assert_eq!(code, 2);
    assert!(json.contains("CLOSURE_INVALID_REQUEST"), "{json}");
    let relative = json!({ "kind": "mod", "path": "relative/path", "loadOrder": 0, "replacePaths": [] });
    let (json, code) = respond_json(&json!({ "schema": "hoi4-closure-request/1", "roots": [relative], "patterns": [] }).to_string());
    assert_eq!(code, 2);
    assert!(json.contains("not an absolute path"), "{json}");
    let (_, code) = respond_json(&json!({ "schema": "hoi4-closure-request/1", "roots": [], "patterns": [], "extra": 1 }).to_string());
    assert_eq!(code, 2);
}

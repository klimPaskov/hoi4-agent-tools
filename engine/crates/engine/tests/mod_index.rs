//! `hoi4-engine mod-index` and the shared symbol index on synthetic layers written here.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::mod_index::{respond_json, respond_symbols_json};
use serde_json::{Value, json};

const BOM: &str = "\u{feff}";

/// The patterns the MCP server sends for a workspace with the default source roots.
const PATTERNS: &[&str] = &[
    "common/national_focus/**/*.txt",
    "common/decisions/**/*.txt",
    "common/ideas/**/*.txt",
    "common/scripted_effects/**/*.txt",
    "common/technology_tags/**/*.txt",
    "common/combat_tactics.txt",
    "events/**/*.txt",
    "history/states/**/*.txt",
    "map/**/*.map",
    "map/**/*.csv",
    "map/**/supply_nodes.txt",
    "interface/**/*.{gui,gfx}",
    "localisation/english/**/*.{yml,yaml}",
    "localisation/*.{yml,yaml}",
];

fn layer(test: &str, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("mod-index").join(test).join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    for (path, text) in files {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, text.replace("{BOM}", BOM)).unwrap();
    }
    root
}

fn root(kind: &str, path: &Path, load_order: i64, replace: &[&str]) -> Value {
    json!({ "kind": kind, "path": path, "loadOrder": load_order, "replacePaths": replace })
}

fn request(roots: Vec<Value>, extra: Value) -> String {
    let mut request = json!({ "schema": "hoi4-mod-index-request/1", "roots": roots, "patterns": PATTERNS });
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

fn kind_count(response: &Value, kind: &str) -> u64 {
    response["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == kind).map_or(0, |k| k["count"].as_u64().unwrap())
}

fn symbols(text: &str) -> Vec<(String, String, String, bool)> {
    let (json, code) = respond_symbols_json(text);
    assert_eq!(code, 0, "{json}");
    let response: Value = serde_json::from_str(&json).unwrap();
    response["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["kind"].as_str().unwrap().to_owned(),
                s["id"].as_str().unwrap().to_owned(),
                s["path"].as_str().unwrap().to_owned(),
                s["overridden"].as_bool().unwrap(),
            )
        })
        .collect()
}

const GAME: &[(&str, &str)] = &[
    ("events/base.txt", "add_namespace = ns\ncountry_event = { id = ns.1 }\ncountry_event = { id = ns.9 }\n"),
    ("common/ideas/base.txt", "ideas = { country = { shared_idea = { } game_idea = { } } }\n"),
    ("common/ideas/sub/deep.txt", "ideas = { country = { deep_idea = { } } }\n"),
    ("common/decisions/base.txt", "cat = { d_game = { } }\n"),
    ("common/scripted_effects/same.txt", "game_effect = { }\n"),
    ("common/technology_tags/t.txt", "technology_categories = { land air }\n"),
    ("localisation/english/a_l_english.yml", "{BOM}l_english:\n key_a:0 \"A\"\n key_b:0 \"B\"\n"),
    ("map/default.map", "definitions = \"provinces.csv\"\n"),
    ("map/provinces.csv", "0;0;0;0;land;false;unknown;0\n1;10;20;30;land;false;plains;1\n"),
    ("map/definition.csv", "7;1;1;1;land;false;plains;1\n"),
    ("map/supply_nodes.txt", "1 100\n1 101\n"),
    ("interface/x.gfx", "spriteTypes = { spriteType = { name = GFX_a texturefile = \"gfx/a.dds\" } }\n"),
];

const MOD: &[(&str, &str)] = &[
    ("events/mod.txt", "add_namespace = ns\ncountry_event = { id = ns.1 }\ncountry_event = { id = ns.2 }\nnews_event = { id = other.5 }\n"),
    ("common/ideas/mod.txt", "ideas = { country = { shared_idea = { } mod_idea = { } } }\n"),
    ("common/decisions/mod.txt", "cat = { d_mod = { } }\n"),
    ("common/scripted_effects/same.txt", "mod_effect = { }\n"),
    ("common/technology_tags/t.txt", "technology_categories = { land }\n"),
    ("docs/readme.txt", "not = a source\n"),
];

#[test]
fn overview_counts_active_definitions_across_layers() {
    let game = layer("overview", "game", GAME);
    let target = layer("overview", "mod", MOD);
    let all = answer(&request(vec![root("game", &game, 0, &[]), root("mod", &target, 1, &[])], json!({})));
    assert_eq!(all["schema"], "hoi4-mod-index/1");
    assert_eq!(all["complete"], true);
    assert_eq!(all["files"], 17);
    // shared_idea is defined twice; the mod's copy is the active one.
    assert_eq!(kind_count(&all, "idea"), 4);
    // Decision categories add up across files instead of replacing each other.
    assert_eq!(kind_count(&all, "decision_category"), 2);
    // The mod's same.txt shadows the game's: game_effect is overridden.
    assert_eq!(kind_count(&all, "scripted_effect"), 1);
    // technology_categories: the game's file is shadowed, so only the mod's `land` counts.
    assert_eq!(kind_count(&all, "technology_category"), 1);
    // default.map selects provinces.csv; definition.csv in the same folder is not read.
    assert_eq!(kind_count(&all, "province"), 2);
    assert_eq!(kind_count(&all, "province_color"), 2);
    assert_eq!(kind_count(&all, "supply_node"), 2);
    assert_eq!(kind_count(&all, "localisation"), 2);
    assert_eq!(kind_count(&all, "sprite"), 1);
    assert_eq!(kind_count(&all, "texture"), 1);
    assert_eq!(
        all["namespaces"],
        json!([
            { "namespace": "ns", "events": 3, "lowest": 1, "highest": 9, "files": 2 },
            { "namespace": "other", "events": 1, "lowest": 5, "highest": 5, "files": 1 },
        ])
    );
    let folders = all["folders"].as_array().unwrap();
    let ideas = folders.iter().find(|f| f["folder"] == "common/ideas").unwrap();
    assert_eq!(ideas["files"], 3);
    assert!(!folders.iter().any(|f| f["folder"] == "docs"));

    let mod_only = answer(&request(vec![root("mod", &target, 1, &[])], json!({})));
    assert_eq!(mod_only["files"], 5);
    assert_eq!(kind_count(&mod_only, "idea"), 2);
    assert_eq!(kind_count(&mod_only, "event"), 3);
}

#[test]
fn records_keep_paths_and_the_overridden_flag() {
    let game = layer("records", "game", GAME);
    let target = layer("records", "mod", MOD);
    let records = symbols(&request(vec![root("game", &game, 0, &[]), root("mod", &target, 1, &[])], json!({})));
    let find = |kind: &str, id: &str| records.iter().filter(|r| r.0 == kind && r.1 == id).map(|r| (r.2.as_str(), r.3)).collect::<Vec<_>>();
    assert_eq!(find("idea", "shared_idea"), [("game:common/ideas/base.txt", true), ("mod:common/ideas/mod.txt", false)]);
    assert_eq!(find("scripted_effect", "game_effect"), [("game:common/scripted_effects/same.txt", true)]);
    assert_eq!(find("event", "ns.1"), [("game:events/base.txt", true), ("mod:events/mod.txt", false)]);
    assert_eq!(find("decision_category", "cat"), [("game:common/decisions/base.txt", false), ("mod:common/decisions/mod.txt", false)]);
    assert_eq!(find("localisation", "l_english:key_a"), [("game:localisation/english/a_l_english.yml", false)]);
    assert_eq!(find("province", "1"), [("game:map/provinces.csv", false)]);
}

#[test]
fn replace_paths_hide_earlier_folders_and_their_subfolders() {
    let game = layer("replace", "game", GAME);
    let target = layer("replace", "mod", MOD);
    let all = answer(&request(vec![root("game", &game, 0, &[]), root("mod", &target, 1, &["common/ideas"])], json!({})));
    // Neither base.txt nor sub/deep.txt of the game is read.
    assert_eq!(kind_count(&all, "idea"), 2);
    assert_eq!(all["files"], 15);
}

#[test]
fn next_id_counts_every_layer_and_finds_the_first_gap() {
    let game = layer("next", "game", GAME);
    let target = layer("next", "mod", MOD);
    let roots = vec![root("game", &game, 0, &[]), root("mod", &target, 1, &[])];
    let next = answer(&request(roots.clone(), json!({ "mode": "next_id", "kind": "event", "prefix": "ns." })));
    assert_eq!(next["next"], json!({ "used": 3, "highest": 9, "firstGap": 3 }));
    assert!(next.get("kinds").is_none());
    let none = answer(&request(roots.clone(), json!({ "mode": "next_id", "kind": "focus", "prefix": "ns." })));
    assert_eq!(none["next"], json!({ "used": 0 }));
    let (json, code) = respond_json(&request(roots, json!({ "mode": "next_id", "kind": "event" })));
    assert_eq!(code, 2);
    let refused: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(refused["status"], "invalid");
    assert_eq!(refused["error"]["code"], "MOD_INDEX_PREFIX_REQUIRED");
}

#[test]
fn a_partial_source_makes_the_index_incomplete_unless_it_is_shadowed() {
    // 101 stray braces: one diagnostic past the per-file ceiling. A file without `=` is never
    // parsed, so it needs one assignment.
    let broken = format!("a = b\n{}", "}\n".repeat(101));
    let game = layer("partial", "game", &[("events/broken.txt", broken.as_str()), ("events/fine.txt", "country_event = { id = g.1 }\n")]);
    let target = layer("partial", "mod", &[("events/fine.txt", broken.as_str())]);
    let mod_only = answer(&request(vec![root("mod", &target, 1, &[])], json!({})));
    assert_eq!(mod_only["complete"], false);
    assert_eq!(mod_only["skippedSourceCount"], 1);
    assert_eq!(mod_only["skippedSources"][0]["path"], "mod:events/fine.txt");
    assert_eq!(mod_only["skippedSources"][0]["reasonCodes"], json!(["SOURCE_DIAGNOSTICS_TRUNCATED"]));
    assert_eq!(mod_only["skippedSources"][0]["possibleSymbolKinds"], json!(["event"]));
    // The game's broken.txt is not shadowed, so the whole index is partial too.
    let all = answer(&request(vec![root("game", &game, 0, &[]), root("mod", &target, 1, &[])], json!({})));
    assert_eq!(all["complete"], false);
    assert_eq!(all["skippedSourceCount"], 2);
    // Shadowed by a readable file: complete.
    let fixed = layer("partial", "fixed", &[("events/broken.txt", "country_event = { id = m.1 }\n")]);
    let game_only = layer("partial", "game-only", &[("events/broken.txt", broken.as_str())]);
    let shadowed = answer(&request(vec![root("game", &game_only, 0, &[]), root("mod", &fixed, 1, &[])], json!({})));
    assert_eq!(shadowed["complete"], true);
}

#[test]
fn ceilings_and_bad_requests_are_refused_with_their_codes() {
    let target = layer("refusals", "mod", MOD);
    let refused = |text: String| -> String {
        let (json, code) = respond_json(&text);
        assert_eq!(code, 2, "{json}");
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["schema"], "hoi4-mod-index/1");
        value["error"]["code"].as_str().unwrap().to_owned()
    };
    let roots = vec![root("mod", &target, 1, &[])];
    assert_eq!(refused(request(roots.clone(), json!({ "limits": { "maxFiles": 2, "maxBytes": 1_000_000, "maxFileBytes": 1_000_000 } }))), "SCAN_FILE_LIMIT");
    assert_eq!(refused(request(roots.clone(), json!({ "limits": { "maxFiles": 100, "maxBytes": 40, "maxFileBytes": 1_000_000 } }))), "SCAN_BYTE_LIMIT");
    assert_eq!(refused(request(roots.clone(), json!({ "limits": { "maxFiles": 100, "maxBytes": 1_000_000, "maxFileBytes": 10 } }))), "SCAN_BYTE_LIMIT");
    assert_eq!(refused(request(roots.clone(), json!({ "patterns": ["../outside/*.txt"] }))), "SCAN_PATTERN_ESCAPE");
    assert_eq!(refused(request(roots.clone(), json!({ "patterns": ["events/[ab].txt"] }))), "SCAN_PATTERN_UNSUPPORTED");
    assert_eq!(refused(request(roots.clone(), json!({ "schema": "other/1" }))), "MOD_INDEX_INVALID_REQUEST");
    assert_eq!(refused(request(roots.clone(), json!({ "unknown": true }))), "MOD_INDEX_INVALID_REQUEST");
    assert_eq!(refused(request(vec![json!({ "kind": "mod", "path": "relative", "loadOrder": 1 })], json!({}))), "MOD_INDEX_INVALID_REQUEST");
    assert_eq!(refused(request(roots, json!({ "mode": "next_id", "kind": "not_a_kind", "prefix": "x." }))), "MOD_INDEX_INVALID_REQUEST");
    assert_eq!(refused("not json".into()), "MOD_INDEX_INVALID_REQUEST");
}

#[test]
fn a_missing_root_contributes_no_files() {
    let missing = Path::new(env!("CARGO_TARGET_TMPDIR")).join("mod-index").join("does-not-exist");
    let empty = answer(&request(vec![root("mod", &missing, 1, &[])], json!({})));
    assert_eq!(empty["files"], 0);
    assert_eq!(empty["complete"], true);
}

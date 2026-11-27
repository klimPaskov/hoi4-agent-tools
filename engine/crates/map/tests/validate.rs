//! A synthetic map, indexed and validated end to end, and the `map.validate` and `map.index`
//! operations over a framed request. Every file here is written by the test.

use hoi4_core::diagnostics::Severity;
use hoi4_core::files::{RootKind, ScannedFile};
use hoi4_core::ops::{OpContext, Registry};
use hoi4_map::model::{MapIndex, SourceRoots};
use hoi4_map::parse::bmp::encode_bmp;
use hoi4_map::validate::{self, Options};
use serde_json::{Value, json};

fn file(path: &str, bytes: Vec<u8>) -> ScannedFile {
    ScannedFile {
        absolute_path: String::new(),
        display_path: format!("mod:{path}"),
        relative_path: path.into(),
        root_kind: RootKind::Mod,
        load_order: 1,
        size: bytes.len() as u64,
        modified_ms: 0,
        sha256: hoi4_core::canonical::sha256_hex(&bytes),
        bytes,
        shadowed_by: None,
    }
}

/// 256 x 256: province 1 (red) on the left half, 2 (green) top right, 3 (blue, sea) bottom right.
fn map_files() -> Vec<ScannedFile> {
    let bitmap = encode_bmp(256, 256, 24, &[], |x, y| match (x < 128, y < 128) {
        (true, _) => [255, 0, 0],
        (false, true) => [0, 255, 0],
        (false, false) => [0, 0, 255],
    });
    let definitions =
        "0;0;0;0;land;false;unknown;0\n1;255;0;0;land;true;plains;1\n2;0;255;0;land;false;plains;1\n3;0;0;255;sea;true;ocean;0\n5;9;9;9;land;false;plains;1\n";
    let state = "state = { id = 1 name = STATE_1 provinces = { 1 2 } history = { owner = AAA victory_points = { 7 1 } } }\n";
    let region = "strategic_region = { id = 1 name = R provinces = { 1 2 3 } }\n";
    let mut localisation = vec![0xEF, 0xBB, 0xBF];
    localisation.extend_from_slice(b"l_english:\n STATE_1:0 \"One\"\n");
    vec![
        file("map/provinces.bmp", bitmap),
        file("map/definition.csv", definitions.as_bytes().to_vec()),
        file("history/states/1-one.txt", state.as_bytes().to_vec()),
        file("map/strategicregions/1-r.txt", region.as_bytes().to_vec()),
        file("localisation/english/states_l_english.yml", localisation),
        file("map/adjacencies.csv", b"From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment\n1;3;sea;-1;-1;-1;-1;-1;;\n".to_vec()),
    ]
}

fn codes(result: &validate::ValidationResult) -> Vec<&str> {
    result.diagnostics.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn validates_a_synthetic_map() {
    let index = MapIndex::build(map_files(), SourceRoots::default()).unwrap();
    assert_eq!(index.definitions.len(), 5);
    assert_eq!(index.states.len(), 1);
    assert!(index.coastal(1) && index.coastal(2) && index.coastal(3));
    let result = validate::validate(&index, &Options::default());
    let found = codes(&result);
    for expected in [
        "MAP_PROVINCE_ID_GAP",
        "MAP_DEFINITION_UNUSED",
        "MAP_COASTAL_MISMATCH",
        "MAP_VICTORY_POINT_OUTSIDE_STATE",
        "MAP_LAND_PROVINCE_STATE_MISSING",
        "MAP_ADJACENCY_TERMINATOR_MISSING",
        "MAP_EDGE_LAND_CUT",
        "MAP_POLAR_LAND",
    ] {
        assert!(found.contains(&expected), "{expected} missing from {found:?}");
    }
    // Province 2 touches the sea below it but its row says it is not coastal.
    let coastal: Vec<_> = result.diagnostics.iter().filter(|d| d.code == "MAP_COASTAL_MISMATCH").collect();
    assert_eq!(coastal.len(), 1, "{coastal:?}");
    assert!(coastal[0].message.contains("Province 2"));
    assert!(!result.passed);
    let failed: Vec<_> = result.checks.iter().filter(|c| !c.passed).map(|c| c.id).collect();
    assert_eq!(failed, ["map-files-and-definitions", "map-state-region-membership", "map-networks-adjacencies"]);
    // Sorted: errors before warnings before information.
    let ranks: Vec<u8> = result
        .diagnostics
        .iter()
        .map(|d| {
            if d.severity.blocks() {
                0
            } else if d.severity == Severity::Warning {
                1
            } else {
                2
            }
        })
        .collect();
    assert!(ranks.windows(2).all(|w| w[0] <= w[1]));
}

#[test]
fn reports_a_new_state_without_localisation_against_the_baseline() {
    let index = MapIndex::build(map_files(), SourceRoots::default()).unwrap();
    let mut files = map_files();
    files.push(file("history/states/2-two.txt", b"state = { id = 2 name = STATE_2 provinces = { } }\n".to_vec()));
    let after = MapIndex::build(files, SourceRoots::default()).unwrap();
    let baseline = validate::Baseline { state_ids: index.state_ids().collect(), province_bitmap: index.province_bitmap.clone() };
    let result = validate::validate(&after, &Options { baseline: Some(baseline), operation_id: Some("op-1".into()), ..Options::default() });
    let new_state = result.diagnostics.iter().find(|d| d.code == "MAP_NEW_STATE_LOCALISATION_MISSING").unwrap();
    assert_eq!(new_state.severity, Severity::Error);
    assert_eq!(new_state.operation_id.as_deref(), Some("op-1"));
}

#[test]
fn refuses_an_untrusted_default_map() {
    let mut files = map_files();
    files.push(file("map/default.map", b"definitions = {".to_vec()));
    let error = MapIndex::build(files, SourceRoots::default()).err().unwrap();
    assert_eq!(error.code, "MAP_DEFAULT_MAP_SELECTOR_BLOCKED");
}

fn request(files: &[ScannedFile]) -> (Value, Vec<u8>) {
    let mut payload = Vec::new();
    let entries: Vec<Value> = files
        .iter()
        .map(|f| {
            payload.extend_from_slice(&f.bytes);
            json!({ "displayPath": f.display_path, "relativePath": f.relative_path, "rootKind": "mod", "loadOrder": f.load_order, "sha256": f.sha256, "length": f.bytes.len() })
        })
        .collect();
    (json!({ "id": 1, "op": "map.validate", "files": entries, "toolVersion": "4.20.0", "options": { "diagnosticLimit": 50000 } }), payload)
}

/// The answer of `map.validate`: `{format:'json'}` in the header, the findings in the payload.
fn validated(registry: &Registry, body: &Value, payload: &[u8]) -> Value {
    let response = registry.dispatch("map.validate", &OpContext::default(), body, payload).unwrap();
    assert_eq!(response.result.unwrap(), json!({ "format": "json" }));
    serde_json::from_slice(&response.payload).unwrap()
}

/// Files the engine reads itself: a request of paths and checksums, no bytes.
#[test]
fn reads_scanned_files_by_path_and_refuses_a_stale_one() {
    let dir = std::env::temp_dir().join(format!("hoi4-map-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let files = map_files();
    let mut entries = Vec::new();
    for f in &files {
        let path = dir.join(f.relative_path.replace('/', "_"));
        std::fs::write(&path, &f.bytes).unwrap();
        entries.push(json!({ "displayPath": f.display_path, "relativePath": f.relative_path, "rootKind": "mod", "loadOrder": f.load_order,
            "size": f.bytes.len(), "sha256": f.sha256, "path": path.to_string_lossy() }));
    }
    let mut registry = Registry::new();
    hoi4_map::register(&mut registry);
    let body = json!({ "id": 1, "op": "map.validate", "files": entries, "toolVersion": "4.20.0", "options": { "diagnosticLimit": 50000 } });
    let (inline_body, inline_payload) = request(&files);
    let by_path = validated(&registry, &body, &[]);
    assert_eq!(by_path, validated(&registry, &inline_body, &inline_payload));
    // A changed file (same length, other bytes) is refused, never validated as it is now.
    let definition = dir.join("map_definition.csv");
    let mut changed = std::fs::read(&definition).unwrap();
    changed[2] = b'9';
    std::fs::write(&definition, &changed).unwrap();
    let refused = registry.dispatch("map.validate", &OpContext::default(), &body, &[]).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "MAP_SOURCE_STALE");
    // A file of another size is refused on its size alone; a missing one is unreadable.
    std::fs::write(&definition, b"short").unwrap();
    let refused = registry.dispatch("map.validate", &OpContext::default(), &body, &[]).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "MAP_SOURCE_STALE");
    std::fs::remove_file(&definition).unwrap();
    let refused = registry.dispatch("map.validate", &OpContext::default(), &body, &[]).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "MAP_SOURCE_UNREADABLE");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn answers_the_registered_operations() {
    let mut registry = Registry::new();
    hoi4_map::register(&mut registry);
    assert_eq!(registry.names(), ["map.index", "map.validate"]);
    let files = map_files();
    let (body, payload) = request(&files);
    let answer = validated(&registry, &body, &payload);
    assert_eq!(answer["passed"], false);
    assert_eq!(answer["baselineFingerprint"].as_str().unwrap().len(), 64);
    assert!(answer["diagnostics"].as_array().unwrap().iter().any(|d| d["code"] == "MAP_PROVINCE_ID_GAP"));
    let index = registry.dispatch("map.index", &OpContext::default(), &body, &payload).unwrap().result.unwrap();
    assert_eq!(index["definitions"].as_array().unwrap().len(), 5);
    assert_eq!(index["states"][0]["provinces"], json!([1, 2]));
    // A payload shorter than the files it lists is refused, not read past its end.
    let refused = registry.dispatch("map.validate", &OpContext::default(), &body, &payload[..10]).unwrap().result.unwrap_err();
    assert_eq!(refused["code"], "MAP_ENGINE_REQUEST_INVALID");
    let mut crossings = body.clone();
    crossings["only"] = json!("crossings");
    let answer = validated(&registry, &crossings, &payload);
    assert!(answer.get("passed").is_none());
    let mut unknown = body;
    unknown["only"] = json!("everything");
    assert!(registry.dispatch("map.validate", &OpContext::default(), &unknown, &payload).unwrap().result.is_err());
}

#[test]
fn keeps_a_hard_marker_when_errors_exceed_the_ceiling() {
    // 64 undefined colours give 64 errors; a ceiling of 10 keeps 9 and a blocking marker.
    let bitmap = encode_bmp(256, 256, 24, &[], |x, _| [(x / 4) as u8 + 100, 1, 1]);
    let files = vec![file("map/provinces.bmp", bitmap), file("map/definition.csv", b"0;0;0;0;land;false;unknown;0\n".to_vec())];
    let index = MapIndex::build(files, SourceRoots::default()).unwrap();
    let result = validate::validate(&index, &Options { diagnostic_limit: Some(10), ..Options::default() });
    assert_eq!(result.diagnostics.len(), 10);
    let marker = result.diagnostics.iter().find(|d| d.code == "MAP_DIAGNOSTICS_TRUNCATED").unwrap();
    assert_eq!(marker.severity, Severity::Blocker);
}

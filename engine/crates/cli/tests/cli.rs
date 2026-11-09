//! End-to-end tests of the `hoi4-engine` binary on the synthetic fixtures.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn engine(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hoi4-engine")).args(args).env_remove("HOI4_GAME_DIR").output().expect("run hoi4-engine")
}

fn path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn check(target: &Path, extra: &[&str]) -> Output {
    let game = path(&fixtures().join("game"));
    let target = path(target);
    let mut args = vec!["check", "--game", &game, "--mod", &target];
    args.extend_from_slice(extra);
    engine(&args)
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

#[test]
fn b001_fails_and_its_fixed_twin_passes() {
    let broken = check(&fixtures().join("mods/b001"), &[]);
    assert_eq!(broken.status.code(), Some(1), "{}", stdout(&broken));
    let text = stdout(&broken);
    assert!(text.contains("REF_UNKNOWN_TRIGGER") && text.contains("b001_unknown_scripted_trigger"), "{text}");
    assert!(text.contains("REF_UNKNOWN_EFFECT") && text.contains("b001_undefined_effect"), "{text}");
    assert!(text.contains("verdict: fail"), "{text}");

    let fixed = check(&fixtures().join("mods/b001_valid"), &[]);
    assert_eq!(fixed.status.code(), Some(0), "{}", stdout(&fixed));
    assert!(stdout(&fixed).contains("verdict: pass"));
}

#[test]
fn json_report_has_schema_verdict_and_every_kind() {
    let out = check(&fixtures().join("mods/b001"), &["--format", "json"]);
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(report["schema"], "hoi4-engine-report/1");
    assert_eq!(report["verdict"], "fail");
    let references = report["coverage"]["references"].as_object().unwrap();
    assert!(references.len() >= 30, "every kind is listed, including zeros");
    assert_eq!(references["focus"]["resolved"], 0);
    assert_eq!(report["coverage"]["trigger_commands"]["unresolved"], 1);
    for f in report["findings"].as_array().unwrap() {
        assert_eq!(f["status"], "new");
        assert!(f["fingerprint"].as_str().unwrap().len() == 24);
    }
}

#[test]
fn without_a_game_the_result_is_incomplete_not_pass() {
    let target = path(&fixtures().join("mods/b001"));
    let out = engine(&["check", "--mod", &target]);
    assert_eq!(out.status.code(), Some(0), "nothing can be shown missing, so nothing fails");
    assert!(stdout(&out).contains("verdict: incomplete"), "{}", stdout(&out));
}

#[test]
fn baseline_fails_only_on_new_findings_and_only_shrinks() {
    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-baseline");
    let _ = fs::remove_dir_all(&work);
    let mod_dir = work.join("mod");
    let src = fixtures().join("mods/b001");
    for rel in ["descriptor.mod", "events/b001_test.txt", "localisation/english/b001_l_english.yml"] {
        fs::create_dir_all(mod_dir.join(rel).parent().unwrap()).unwrap();
        fs::copy(src.join(rel), mod_dir.join(rel)).unwrap();
    }
    let baseline = work.join("baseline.json");
    let game = path(&fixtures().join("game"));
    let (m, b) = (path(&mod_dir), path(&baseline));

    let init = engine(&["baseline", "init", "--game", &game, "--mod", &m, "--baseline", &b]);
    assert_eq!(init.status.code(), Some(0), "{}", String::from_utf8_lossy(&init.stderr));
    let again = engine(&["baseline", "init", "--game", &game, "--mod", &m, "--baseline", &b]);
    assert_eq!(again.status.code(), Some(2), "init refuses to overwrite");

    let baselined = check(&mod_dir, &["--baseline", &b]);
    assert_eq!(baselined.status.code(), Some(0), "{}", stdout(&baselined));
    assert!(stdout(&baselined).contains("baseline: 2 entries, 2 still present, 0 new, 0 fixed"), "{}", stdout(&baselined));

    // A new problem fails even with the baseline.
    let event = mod_dir.join("events/b001_test.txt");
    let text = fs::read_to_string(&event).unwrap();
    fs::write(&event, text.replace("add_political_power = 25", "add_political_power = 25\n\t\tanother_missing_effect = yes")).unwrap();
    let with_new = check(&mod_dir, &["--baseline", &b]);
    assert_eq!(with_new.status.code(), Some(1), "{}", stdout(&with_new));
    assert!(stdout(&with_new).contains("1 new"), "{}", stdout(&with_new));

    // Fixing a baselined problem shows it as fixed, and update shrinks the baseline.
    let fixed_text = fs::read_to_string(&event).unwrap().replace("\t\tb001_undefined_effect = yes\n", "").replace("\n\t\tanother_missing_effect = yes", "");
    fs::write(&event, fixed_text).unwrap();
    let after_fix = check(&mod_dir, &["--baseline", &b]);
    assert!(stdout(&after_fix).contains("1 fixed"), "{}", stdout(&after_fix));
    let update = engine(&["baseline", "update", "--game", &game, "--mod", &m, "--baseline", &b]);
    assert!(stdout(&update).contains("2 entries before, 1 after"), "{}", stdout(&update));
}

#[test]
fn delta_classifies_two_reports() {
    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-delta");
    fs::create_dir_all(&work).unwrap();
    let before = work.join("before.json");
    let after = work.join("after.json");
    fs::write(&before, check(&fixtures().join("mods/b001"), &["--format", "json"]).stdout).unwrap();
    fs::write(&after, check(&fixtures().join("mods/b001_valid"), &["--format", "json"]).stdout).unwrap();
    let out = engine(&["delta", &path(&before), &path(&after)]);
    assert!(stdout(&out).contains("resolved 2"), "{}", stdout(&out));
}

#[test]
fn roundtrip_and_drawio_commands_work() {
    let out = engine(&["roundtrip", &path(&fixtures().join("game"))]);
    assert_eq!(out.status.code(), Some(0));
    assert!(stdout(&out).contains("0 mismatched"), "{}", stdout(&out));

    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-drawio");
    fs::create_dir_all(&work).unwrap();
    let sketch = work.join("tree.drawio");
    fs::write(
        &sketch,
        r#"<mxGraphModel><root><mxCell id="a" value="Rearm" vertex="1"><mxGeometry x="0" y="0"/></mxCell><mxCell id="b" value="Expand" vertex="1"><mxGeometry x="100" y="100"/></mxCell><mxCell id="e" edge="1" source="a" target="b"/></root></mxGraphModel>"#,
    )
    .unwrap();
    let out = engine(&["drawio", &path(&sketch), "--prefix", "GER"]);
    let import: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(import["nodes"][1]["focus_id"], "GER_Expand");
    assert_eq!(import["edges"][0]["target"], "GER_Expand");
}

#[test]
fn usage_errors_exit_with_two() {
    assert_eq!(engine(&["check"]).status.code(), Some(2));
    assert_eq!(engine(&["check", "--mod", "does/not/exist"]).status.code(), Some(2));
    assert_eq!(engine(&["frobnicate"]).status.code(), Some(2));
    assert_eq!(engine(&["--version"]).status.code(), Some(0));
}

#[test]
fn focus_layout_reads_a_request_file_or_stdin() {
    let request = Path::new(env!("CARGO_MANIFEST_DIR")).join("../focus/tests/fixtures/lanes.request.json");
    let expected = fs::read_to_string(request.with_file_name("lanes.response.json")).unwrap().replace("\r\n", "\n");
    let out = engine(&["focus-layout", "--request", &path(&request)]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let mut response: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    response["metrics"]["durationMicros"] = 0.into();
    assert_eq!(response, serde_json::from_str::<serde_json::Value>(&expected).unwrap());

    let mut child = Command::new(env!("CARGO_BIN_EXE_hoi4-engine"))
        .arg("focus-layout")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("run hoi4-engine");
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), &fs::read(&request).unwrap()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let from_stdin: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(from_stdin["hashes"], response["hashes"]);
}

#[test]
fn focus_layout_refuses_an_invalid_request_with_two() {
    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-focus-layout");
    fs::create_dir_all(&work).unwrap();
    let bad = work.join("bad.json");
    fs::write(&bad, r#"{"schema":"hoi4-focus-layout-request/1","operation":"layout","focuses":[{"id":"a","prerequisites":[["a"]]}]}"#).unwrap();
    let out = engine(&["focus-layout", "--request", &path(&bad)]);
    assert_eq!(out.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(error["schema"], "hoi4-focus-layout/1");
    assert_eq!(error["status"], "invalid");
    assert_eq!(error["error"]["code"], "FOCUS_ENGINE_PREREQUISITE_CYCLE");
    fs::write(&bad, "not json").unwrap();
    let out = engine(&["focus-layout", "--request", &path(&bad)]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(engine(&["focus-layout", "--request", &path(&work.join("missing.json"))]).status.code(), Some(2));
}

#[test]
fn sprites_reports_json_and_honours_fail_on() {
    let game = path(&fixtures().join("sprites/game"));
    let out = engine(&["sprites", "--game", &game, "--format", "json", "--index"]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    let report: serde_json::Value = serde_json::from_str(&stdout(&out)).expect("json");
    assert_eq!(report["schema"], "hoi4-engine-sprites/1");
    assert_eq!(report["summary"]["sprites_indexed"], 31);
    assert_eq!(report["sprites"].as_array().map(Vec::len), Some(31));
    let focus = report["uses"].as_array().unwrap().iter().find(|u| u["subject"] == "focus:t_alpha").unwrap();
    assert_eq!((focus["family"].as_str(), focus["sprite"].as_str()), (Some("focus"), Some("GFX_goal_alpha")));
    // The fixture has no texture files, so every texture is missing and the run can fail on it.
    let failing = engine(&["sprites", "--game", &game, "--fail-on", "warning"]);
    assert_eq!(failing.status.code(), Some(1), "{}", stdout(&failing));
    assert!(stdout(&failing).contains("GFX-TEXTURE-MISSING"));
    let bad = engine(&["sprites", "--game", &game, "--allowlist", "does-not-exist.json"]);
    assert_eq!(bad.status.code(), Some(2));
}

#[test]
fn mod_index_and_symbol_index_read_a_request_and_refuse_with_two() {
    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-mod-index");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(work.join("mod/events")).unwrap();
    fs::write(work.join("mod/events/a.txt"), "country_event = { id = e.1 }\ncountry_event = { id = e.3 }\n").unwrap();
    let request = work.join("request.json");
    let body = serde_json::json!({
        "schema": "hoi4-mod-index-request/1",
        "roots": [{ "kind": "mod", "path": work.join("mod"), "loadOrder": 1 }],
        "patterns": ["events/**/*.txt"],
    });
    fs::write(&request, body.to_string()).unwrap();
    let out = engine(&["mod-index", "--request", &path(&request)]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let overview: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(overview["namespaces"][0]["namespace"], "e");
    assert_eq!(overview["kinds"], serde_json::json!([{ "kind": "event", "count": 2 }]));
    let out = engine(&["symbol-index", "--request", &path(&request)]);
    assert_eq!(out.status.code(), Some(0));
    let index: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(index["schema"], "hoi4-symbol-index/1");
    assert_eq!(
        index["symbols"][1],
        serde_json::json!({ "kind": "event", "id": "e.3", "path": "mod:events/a.txt", "rootKind": "mod", "loadOrder": 1, "line": 2, "endLine": 2, "overridden": false, "sourceShadowed": false })
    );
    let mut next = body.clone();
    next["mode"] = "next_id".into();
    fs::write(&request, next.to_string()).unwrap();
    let out = engine(&["mod-index", "--request", &path(&request)]);
    assert_eq!(out.status.code(), Some(2));
    let refused: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(refused["status"], "invalid");
    assert_eq!(refused["error"]["code"], "MOD_INDEX_PREFIX_REQUIRED");
}

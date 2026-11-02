//! `hoi4-engine texture` and `hoi4-engine serve` end to end.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn textures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../texture/tests/fixtures")
}

#[test]
fn texture_reports_formats_and_failures() {
    let out =
        Command::new(env!("CARGO_BIN_EXE_hoi4-engine")).args(["texture", &textures().to_string_lossy(), "--format", "json"]).output().expect("run hoi4-engine");
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{text}");
    let report: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["failed"], 0);
    assert_eq!(report["files"], 35);
    assert_eq!(report["formats"]["BC7_UNORM"]["decoded"], 1);
    assert_eq!(report["formats"]["R8G8B8A8_UNORM"]["decoded"], 1);

    let png = std::env::temp_dir().join(format!("hoi4-engine-texture-{}.png", std::process::id()));
    let out = Command::new(env!("CARGO_BIN_EXE_hoi4-engine"))
        .args(["texture", &textures().join("bc7_modes.dds").to_string_lossy(), "--output", &png.to_string_lossy()])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let written = hoi4_texture::decode_file(&png, u64::MAX).unwrap().image;
    let expected = hoi4_texture::decode_file(&textures().join("bc7_modes.dds"), u64::MAX).unwrap().image;
    assert_eq!(written, expected);
    std::fs::remove_file(png).unwrap();
}

/// Reads one response frame: the JSON line and its payload.
fn frame(reader: &mut impl BufRead) -> (serde_json::Value, Vec<u8>) {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let header: serde_json::Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line}"));
    let mut payload = vec![0; header["payload"].as_u64().unwrap_or(0) as usize];
    reader.read_exact(&mut payload).unwrap();
    (header, payload)
}

#[test]
fn serve_answers_frames_until_stdin_closes() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hoi4-engine")).arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("start serve");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let bc7 = std::fs::read(textures().join("bc7_modes.dds")).unwrap();
    let expected = hoi4_texture::decode(&bc7, "dds", u64::MAX).unwrap();

    writeln!(stdin, r#"{{"id":1,"op":"hello"}}"#).unwrap();
    let (hello, _) = frame(&mut stdout);
    assert_eq!(hello["id"], 1);
    assert_eq!(hello["result"]["protocol"], 1);

    // Two decodes and a bad one in flight together; answers carry their ids.
    for id in [2, 3] {
        writeln!(stdin, r#"{{"id":{id},"op":"texture.decode","extension":"dds","payload":{}}}"#, bc7.len()).unwrap();
        stdin.write_all(&bc7).unwrap();
    }
    writeln!(stdin, r#"{{"id":4,"op":"texture.decode","extension":"dds","payload":3}}"#).unwrap();
    stdin.write_all(b"bad").unwrap();
    writeln!(stdin, r#"{{"id":5,"op":"nope"}}"#).unwrap();
    stdin.flush().unwrap();
    let mut seen = std::collections::BTreeMap::new();
    for _ in 0..4 {
        let (header, payload) = frame(&mut stdout);
        seen.insert(header["id"].as_i64().unwrap(), (header, payload));
    }
    for id in [2, 3] {
        let (header, payload) = &seen[&id];
        assert_eq!(header["ok"], true);
        assert_eq!(header["result"]["format"], "BC7_UNORM");
        assert_eq!(payload, &expected.image.rgba);
    }
    assert_eq!(seen[&4].0["ok"], false);
    assert_eq!(seen[&4].0["error"]["code"], "invalid");
    assert_eq!(seen[&5].0["error"]["code"], "unknown_op");

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn serve_stops_on_a_malformed_frame() {
    let mut child =
        Command::new(env!("CARGO_BIN_EXE_hoi4-engine")).arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"not json\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("malformed request frame"));
}

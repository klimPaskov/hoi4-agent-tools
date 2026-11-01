//! Golden responses: every `tests/fixtures/<name>.request.json` must produce exactly
//! `<name>.response.json` (with `durationMicros` zeroed) on every platform. Regenerate after an
//! intended change with `FOCUS_LAYOUT_BLESS=1 cargo test -p hoi4-focus-layout --test golden`,
//! then review the diff.

mod common;

use std::fs;
use std::path::Path;

#[test]
fn fixtures_match_their_golden_responses() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let bless = std::env::var_os("FOCUS_LAYOUT_BLESS").is_some();
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".request.json").map(str::to_string))
        .collect();
    names.sort();
    assert!(names.len() >= 3, "fixtures missing in {}", dir.display());
    let mut failures = Vec::new();
    for name in &names {
        let request = fs::read_to_string(dir.join(format!("{name}.request.json"))).unwrap();
        let response = hoi4_focus_layout::respond(&request).unwrap_or_else(|e| panic!("{name}: {} {}", e.code, e.message));
        let actual = common::stable_json(&response);
        let path = dir.join(format!("{name}.response.json"));
        if bless {
            fs::write(&path, &actual).unwrap();
            continue;
        }
        let expected = fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        if expected != actual {
            failures.push(format!("{name}: response differs from {}\n{actual}", path.display()));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

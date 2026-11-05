//! `hoi4-engine localisation` against the synthetic game in `fixtures/game` and a small mod that
//! ships English and German.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::localisation::{Mode, Request, respond, respond_json};

const BOM: &str = "\u{feff}";

fn game() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/game")
}

fn write_mod(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("localisation").join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("descriptor.mod"), format!("name=\"{name}\"\n")).unwrap();
    for (path, text) in files {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, text.replace("{BOM}", BOM)).unwrap();
    }
    root
}

fn request(target: &Path, mode: Mode, key: Option<&str>) -> Request {
    Request {
        game: Some(game()),
        target: Some(target.to_path_buf()),
        dependencies: Vec::new(),
        include_dlc: false,
        mode,
        key: key.map(str::to_owned),
        language: None,
        limit: Some(20),
    }
}

const MOD: &[(&str, &str)] = &[
    (
        "events/t.txt",
        "add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d option = { name = t.1.a } }\ncountry_event = { id = t.2 title = t.2.t desc = t.2.d }\n",
    ),
    ("localisation/english/t_l_english.yml", "{BOM}l_english:\n t.1.t:0 \"Hello $NAME$\"\n t.1.d:0 \"D\"\n t.1.a:0 \"A\"\n t.2.t:0 \"Two\"\n"),
    ("localisation/english/u_l_english.yml", "{BOM}l_english:\n t.1.d:0 \"Again\"\n"),
    ("localisation/german/t_l_german.yml", "{BOM}l_german:\n t.1.t:0 \"Hallo\"\n t.1.d:0 \"D\"\n t.1.a:0 \"A\"\n t.de_only:0 \"Nur Deutsch\"\n"),
    // A file shipped empty to blank a vanilla file needs no header.
    ("localisation/english/blank_l_english.yml", "{BOM}"),
];

#[test]
fn key_mode_lists_every_language_and_the_languages_that_lack_it() {
    let root = write_mod("key", MOD);
    let answer = respond(&request(&root, Mode::Key, Some("t.1.t"))).unwrap();
    assert_eq!(answer.supported_languages, ["english", "german"]);
    let key = answer.key.unwrap();
    assert!(key.found);
    let languages: Vec<_> = key.definitions.iter().map(|d| (d.language.as_str(), d.text.as_str())).collect();
    assert_eq!(languages, [("english", "Hello $NAME$"), ("german", "Hallo")]);
    assert!(key.missing_languages.is_empty());
    assert_eq!(key.mentions.iter().map(|m| m.path.as_str()).collect::<Vec<_>>(), ["events/t.txt"]);

    let missing = respond(&request(&root, Mode::Key, Some("t.2.t"))).unwrap().key.unwrap();
    assert_eq!(missing.missing_languages, ["german"]);

    let unknown = respond(&request(&root, Mode::Key, Some("t.1.x"))).unwrap().key.unwrap();
    assert!(!unknown.found);
    assert!(unknown.suggestions.contains(&"t.1.t".to_owned()) || unknown.suggestions.contains(&"t.1.a".to_owned()));
}

#[test]
fn audit_reports_problems_players_see_and_leaves_translation_choices_as_information() {
    let root = write_mod("audit", MOD);
    let audit = respond(&request(&root, Mode::Audit, None)).unwrap().audit.unwrap();
    let count = |code: &str| audit.counts.get(code).copied().unwrap_or(0);
    // t.2.d is used and defined nowhere.
    assert_eq!(count("LOC_KEY_UNDEFINED"), 1);
    // t.2.t has no German text; t.de_only is German's own key and is not missing in English.
    assert_eq!(count("LOC_KEY_MISSING_LANGUAGE"), 1);
    assert_eq!(count("LOC_KEY_DUPLICATE"), 1);
    // German dropped $NAME$: information, not a warning.
    assert_eq!(count("LOC_PLACEHOLDER_MISSING"), 1);
    assert!(audit.problems.iter().any(|p| p.code == "LOC_PLACEHOLDER_MISSING" && p.severity == "info"));
    assert_eq!(count("LOC_MISSING_LANGUAGE_HEADER"), 0);
}

#[test]
fn coverage_counts_keys_per_language_against_the_main_language() {
    let root = write_mod("coverage", MOD);
    let coverage = respond(&request(&root, Mode::Coverage, None)).unwrap().coverage.unwrap();
    let german = coverage.iter().find(|c| c.language == "german").unwrap();
    assert_eq!((german.keys, german.missing, german.supported), (4, 1, true));
}

#[test]
fn json_requests_name_their_errors() {
    let (json, code) = respond_json(r#"{"mode":"key"}"#);
    assert_eq!(code, 2);
    assert!(json.contains("LOCALISATION_KEY_REQUIRED"), "{json}");
    let (json, code) = respond_json(r#"{"mode":"nope"}"#);
    assert_eq!(code, 2);
    assert!(json.contains("LOCALISATION_INVALID_REQUEST"), "{json}");
}

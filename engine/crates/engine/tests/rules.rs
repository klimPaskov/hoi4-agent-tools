//! One invalid and one valid fixture per rule, checked against the synthetic game in
//! `fixtures/game`. The invalid fixture must produce the rule's code; the valid one must not.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::{Analysis, Vocabulary, Workspace, WorkspaceOptions};

type Files = &'static [(&'static str, &'static str)];

struct Case {
    code: &'static str,
    invalid: Files,
    valid: Files,
}

const BOM: &str = "\u{feff}";

fn game() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/game")
}

fn write_mod(name: &str, files: Files) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("rules").join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let mut has_descriptor = false;
    for (path, text) in files {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, text.replace("{BOM}", BOM)).unwrap();
        has_descriptor |= *path == "descriptor.mod";
    }
    if !has_descriptor {
        fs::write(root.join("descriptor.mod"), format!("name=\"{name}\"\n")).unwrap();
    }
    root
}

fn analyze(name: &str, files: Files) -> Analysis {
    let target = write_mod(name, files);
    let options = WorkspaceOptions { game: Some(game()), include_dlc: true, dependencies: Vec::new(), target: Some(target) };
    Analysis::run(Workspace::load(&options), Vocabulary::from_game(&game()))
}

const EVENT_LOC: &str = "{BOM}l_english:\n t.1.t:0 \"T\"\n t.1.d:0 \"D\"\n t.1.a:0 \"A\"\n t.1.b:0 \"B\"\n";

macro_rules! event_files {
    ($body:expr) => {
        &[("events/t.txt", $body), ("localisation/english/t_l_english.yml", EVENT_LOC)]
    };
}

const CASES: &[Case] = &[
    Case {
        code: "REF_UNKNOWN_EFFECT",
        invalid: event_files!("add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d immediate = { not_an_effect = yes } }"),
        valid: event_files!(
            "add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d immediate = { vanilla_effect = yes IF = { limit = { always = yes } add_political_power = 1 } } }"
        ),
    },
    Case {
        code: "REF_UNKNOWN_TRIGGER",
        invalid: event_files!("add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d trigger = { not_a_trigger = yes } }"),
        valid: event_files!(
            "add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d trigger = { vanilla_trigger = yes OR = { is_ai = yes TAG = VAN } } }"
        ),
    },
    Case {
        code: "REF_MISSING_EVENT",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { country_event = missing.1 }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { country_event = { id = vanilla.1 days = 3 } }\n")],
    },
    Case {
        code: "REF_MISSING_FOCUS",
        invalid: &[("common/scripted_triggers/t.txt", "t_trigger = { has_completed_focus = VAN_missing }\n")],
        valid: &[("common/scripted_triggers/t.txt", "t_trigger = { has_completed_focus = VAN_left }\n")],
    },
    Case {
        code: "REF_MISSING_IDEA",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { add_ideas = { vanilla_idea missing_idea } }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { add_ideas = vanilla_idea }\n")],
    },
    Case {
        code: "REF_MISSING_LOCALISATION_KEY",
        invalid: &[
            ("events/t.txt", "add_namespace = t\ncountry_event = { id = t.1 title = t.1.missing desc = t.1.d }\n"),
            ("localisation/english/t_l_english.yml", EVENT_LOC),
        ],
        valid: &[
            ("events/t.txt", "add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d }\n"),
            ("localisation/english/t_l_english.yml", EVENT_LOC),
        ],
    },
    Case {
        code: "REF_MISSING_SPRITE",
        invalid: event_files!("add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d picture = GFX_missing_picture }"),
        valid: event_files!("add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d picture = GFX_vanilla_picture }"),
    },
    Case {
        code: "REF_MISSING_COUNTRY_TAG",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { ZZZ = { add_political_power = 1 } }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { VAN = { add_political_power = 1 } }\n")],
    },
    Case {
        code: "REF_MISSING_OPINION_MODIFIER",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { add_opinion_modifier = { target = VAN modifier = missing_opinion } }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { add_opinion_modifier = { target = VAN modifier = vanilla_opinion } }\n")],
    },
    Case {
        code: "REF_MISSING_DYNAMIC_MODIFIER",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { add_dynamic_modifier = { modifier = missing_dynamic } }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { add_dynamic_modifier = { modifier = vanilla_dynamic } }\n")],
    },
    Case {
        code: "REF_CASE_MISMATCH",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { country_event = Vanilla.1 }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { country_event = vanilla.1 }\n")],
    },
    Case {
        code: "LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL",
        invalid: &[(
            "common/national_focus/t.txt",
            "focus_tree = { id = t_tree focus = { id = T_a x = 0 y = 0 mutually_exclusive = { focus = T_b } } focus = { id = T_b x = 2 y = 0 } }\n",
        )],
        valid: &[(
            "common/national_focus/t.txt",
            "focus_tree = { id = t_tree focus = { id = T_a x = 0 y = 0 mutually_exclusive = { focus = T_b } } focus = { id = T_b x = 2 y = 0 mutually_exclusive = { focus = T_a } } }\n",
        )],
    },
    Case {
        code: "LINT_EVENT_NAMESPACE_COLLISION",
        invalid: &[("events/t.txt", "add_namespace = vanilla\n")],
        valid: &[("events/t.txt", "add_namespace = t_unique\n")],
    },
    Case {
        code: "LINT_INERT_MTTH",
        invalid: event_files!(
            "add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d is_triggered_only = yes mean_time_to_happen = { days = 30 } }"
        ),
        valid: event_files!("add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d mean_time_to_happen = { days = 30 } }"),
    },
    Case {
        code: "LINT_EVENT_LOC_KEY_REUSED",
        invalid: event_files!("add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d option = { name = t.1.d } }"),
        valid: event_files!(
            "add_namespace = t\ncountry_event = { id = t.1 title = t.1.t desc = t.1.d option = { name = t.1.a trigger = { is_ai = yes } } option = { name = t.1.a trigger = { is_ai = no } } option = { name = t.1.b } }"
        ),
    },
    Case {
        code: "LINT_UNKNOWN_MODIFIER",
        invalid: &[("common/ideas/t.txt", "ideas = { country = { t_idea = { modifier = { not_a_modifier = 1 } } } }\n")],
        valid: &[(
            "common/ideas/t.txt",
            "ideas = { country = { t_idea = { modifier = { communism_drift = 0.1 Political_Power_Gain = 0.1 custom_modifier_tooltip = t_tt } } } }\n",
        )],
    },
    Case {
        code: "LINT_FLAG_NEVER_SET",
        invalid: &[("common/scripted_triggers/t.txt", "t_trigger = { has_country_flag = never_set_flag }\n")],
        valid: &[(
            "common/scripted_triggers/t.txt",
            "t_trigger = { has_country_flag = vanilla_started has_country_flag = { flag = vanilla_started value > 0 } }\n",
        )],
    },
    Case {
        code: "LINT_FLAG_NEVER_CHECKED",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { set_country_flag = lonely_flag }\n")],
        valid: &[
            ("common/scripted_effects/t.txt", "t_effect = { set_country_flag = t_flag }\n"),
            ("common/scripted_triggers/t.txt", "t_trigger = { has_country_flag = t_flag }\n"),
        ],
    },
    Case {
        code: "LINT_UNKNOWN_DLC",
        invalid: &[("common/scripted_triggers/t.txt", "t_trigger = { has_dlc = \"Fixture Pak\" }\n")],
        valid: &[("common/scripted_triggers/t.txt", "t_trigger = { has_dlc = \"Fixture Pack\" }\n")],
    },
    Case {
        code: "LINT_DUPLICATE_DEFINITION",
        invalid: &[("common/scripted_effects/a.txt", "t_effect = { log = a }\n"), ("common/scripted_effects/b.txt", "t_effect = { log = b }\n")],
        valid: &[("common/scripted_effects/a.txt", "t_effect = { log = a }\n"), ("common/scripted_effects/b.txt", "t_other = { log = b }\n")],
    },
    Case {
        code: "OVERRIDE_DROPS_DEFINITION",
        invalid: &[("common/scripted_triggers/00_vanilla_triggers.txt", "t_trigger = { always = yes }\n")],
        valid: &[("common/scripted_triggers/00_vanilla_triggers.txt", "vanilla_trigger = { always = no }\nt_trigger = { always = yes }\n")],
    },
    Case {
        code: "OVERRIDE_DROPS_ON_ACTION_HOOK",
        invalid: &[("common/on_actions/00_on_actions.txt", "on_actions = { on_startup = { events = { vanilla.1 } random_events = { 100 = vanilla.2 } } }\n")],
        valid: &[(
            "common/on_actions/00_on_actions.txt",
            "on_actions = {\n\ton_startup = {\n\t\teffect = {\n\t\t\tset_country_flag = vanilla_started\n\t\t}\n\t\tevents = { vanilla.1 t.9 }\n\t\trandom_events = { 100 = vanilla.2 }\n\t}\n\ton_new_term_election = { events = { vanilla.2 } }\n}\n",
        )],
    },
    Case {
        code: "OVERRIDE_CASE_ONLY_SHADOW",
        invalid: &[("common/ideas/Vanilla.txt", "ideas = { country = { vanilla_idea = { } } }\n")],
        valid: &[("common/ideas/vanilla.txt", "ideas = { country = { vanilla_idea = { } } }\n")],
    },
    Case {
        code: "OVERRIDE_REPLACE_PATH_EMPTY",
        invalid: &[("descriptor.mod", "name=\"t\"\nreplace_path=\"common/ideas\"\n")],
        valid: &[("descriptor.mod", "name=\"t\"\nreplace_path=\"common/ideas\"\n"), ("common/ideas/t.txt", "ideas = { country = { vanilla_idea = { } } }\n")],
    },
    Case {
        code: "OVERRIDE_REPLACE_PATH_DROPS",
        invalid: &[
            ("descriptor.mod", "name=\"t\"\nreplace_path=\"common/scripted_triggers\"\n"),
            ("common/scripted_triggers/t.txt", "t_trigger = { always = yes }\n"),
        ],
        valid: &[
            ("descriptor.mod", "name=\"t\"\nreplace_path=\"common/scripted_triggers\"\n"),
            ("common/scripted_triggers/t.txt", "vanilla_trigger = { always = yes }\n"),
        ],
    },
    Case {
        code: "OVERRIDE_REPLACES_FILE",
        invalid: &[("common/scripted_effects/00_vanilla_effects.txt", "vanilla_effect = { log = mine }\n")],
        valid: &[("common/scripted_effects/t_effects.txt", "t_effect = { log = mine }\n")],
    },
    Case {
        code: "SYNTAX_UNCLOSED_BLOCK",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { log = a\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { log = a }\n")],
    },
    Case {
        code: "SYNTAX_STRAY_CLOSING_BRACE",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { log = a } }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { log = a }\n")],
    },
    Case {
        code: "SYNTAX_MISSING_VALUE",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { log = }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { log = a }\n")],
    },
    Case {
        code: "SYNTAX_STRAY_OPERATOR",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { = a }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { log = a }\n")],
    },
    Case {
        code: "SYNTAX_UNTERMINATED_STRING",
        invalid: &[("common/scripted_effects/t.txt", "t_effect = { log = \"open }\n")],
        valid: &[("common/scripted_effects/t.txt", "t_effect = { log = \"closed\" }\n")],
    },
    Case {
        code: "LOC_MISSING_BOM",
        invalid: &[("localisation/english/t_l_english.yml", "l_english:\n t_key:0 \"x\"\n")],
        valid: &[("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_key:0 \"x\"\n")],
    },
    Case {
        code: "LOC_MISSING_LANGUAGE_HEADER",
        invalid: &[("localisation/english/t_l_english.yml", "{BOM} t_key:0 \"x\"\n")],
        valid: &[("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_key:0 \"x\"\n")],
    },
    Case {
        code: "LOC_UNTERMINATED_VALUE",
        invalid: &[("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_key:0 \"x\n")],
        valid: &[("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_key:0 \"x\"\n")],
    },
];

fn codes(analysis: &Analysis) -> Vec<String> {
    analysis.findings.iter().map(|f| f.code.clone()).collect()
}

#[test]
fn every_rule_fires_on_its_invalid_fixture_and_not_on_its_valid_one() {
    let mut failures = Vec::new();
    for case in CASES {
        let invalid = analyze(&format!("{}_invalid", case.code.to_ascii_lowercase()), case.invalid);
        if !codes(&invalid).iter().any(|c| c == case.code) {
            failures.push(format!("{}: invalid fixture did not report it; got {:?}", case.code, codes(&invalid)));
        }
        let valid = analyze(&format!("{}_valid", case.code.to_ascii_lowercase()), case.valid);
        if codes(&valid).iter().any(|c| c == case.code) {
            let found: Vec<_> = valid.findings.iter().filter(|f| f.code == case.code).map(|f| f.message.clone()).collect();
            failures.push(format!("{}: valid fixture reported it: {found:?}", case.code));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_emitted_rule_has_a_case() {
    let covered: Vec<&str> = CASES.iter().map(|c| c.code).collect();
    for code in hoi4_engine::lints::LINT_CODES {
        assert!(covered.contains(code), "{code} has no fixture case");
    }
}

#[test]
fn b001_classes_are_caught_and_unknown_is_never_a_pass() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mods");
    let run = |name: &str, with_game: bool| {
        let options = WorkspaceOptions { game: with_game.then(game), include_dlc: true, dependencies: Vec::new(), target: Some(fixtures.join(name)) };
        let vocab = if with_game { Vocabulary::from_game(&game()) } else { Vocabulary::default() };
        Analysis::run(Workspace::load(&options), vocab)
    };
    let broken = run("b001", true);
    let subjects: Vec<_> = broken.findings.iter().map(|f| (f.code.as_str(), f.subject.as_deref().unwrap_or(""))).collect();
    assert!(subjects.contains(&("REF_UNKNOWN_TRIGGER", "b001_unknown_scripted_trigger")), "{subjects:?}");
    assert!(subjects.contains(&("REF_UNKNOWN_EFFECT", "b001_undefined_effect")), "{subjects:?}");
    assert_eq!(broken.verdict(), "fail");

    let fixed = run("b001_valid", true);
    assert!(fixed.findings.is_empty(), "{:?}", codes(&fixed));
    assert_eq!(fixed.verdict(), "pass");

    // Without the game nothing can be shown missing, and the result is not a pass.
    let blind = run("b001", false);
    assert!(blind.findings.iter().all(|f| !f.code.starts_with("REF_")), "{:?}", codes(&blind));
    assert_eq!(blind.verdict(), "incomplete");
    assert!(blind.coverage.effect_commands.unknown + blind.coverage.trigger_commands.unknown >= 2);
}

#[test]
fn copied_on_actions_that_drop_hooks_are_reported() {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mods/on_actions_drop");
    let options = WorkspaceOptions { game: Some(game()), include_dlc: true, dependencies: Vec::new(), target: Some(target) };
    let analysis = Analysis::run(Workspace::load(&options), Vocabulary::from_game(&game()));
    let mut dropped: Vec<_> =
        analysis.findings.iter().filter(|f| f.code == "OVERRIDE_DROPS_ON_ACTION_HOOK").map(|f| f.subject.clone().unwrap_or_default()).collect();
    dropped.sort();
    assert_eq!(dropped.len(), 3, "{dropped:?}");
    assert!(dropped.contains(&"on_startup:events:vanilla.1".to_string()));
    assert!(dropped.contains(&"on_new_term_election:events:vanilla.2".to_string()));
    assert!(dropped.iter().any(|d| d.starts_with("on_startup:effect:")));
    assert!(analysis.findings.iter().any(|f| f.code == "OVERRIDE_DROPS_DEFINITION" && f.subject.as_deref() == Some("on_action:on_new_term_election")));
}

#[test]
fn coverage_lists_every_kind_including_zeros() {
    let analysis = analyze("coverage", &[("common/scripted_effects/t.txt", "t_effect = { country_event = vanilla.1 }\n")]);
    assert_eq!(analysis.coverage.references.len(), hoi4_engine::index::Kind::ALL.len());
    assert_eq!(analysis.coverage.references["event"].resolved, 1);
    assert_eq!(analysis.coverage.references["focus"].resolved, 0);
}

#[test]
fn fixtures_round_trip_byte_for_byte() {
    for root in [game(), Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mods/b001")] {
        let report = hoi4_engine::roundtrip::round_trip(&root);
        assert!(report.passed(), "{report:?}");
        assert!(report.files > 0);
    }
}

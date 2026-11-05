//! `hoi4-engine system` against the synthetic game in `fixtures/game` and small mods.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::system::{Request, System, audit, respond, respond_json};

const BOM: &str = "\u{feff}";

fn game() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/game")
}

fn write_mod(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("system").join(name);
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

fn request(target: &Path, kind: System, id: &str, audit: bool) -> Request {
    Request {
        game: Some(game()),
        target: Some(target.to_path_buf()),
        dependencies: Vec::new(),
        include_dlc: false,
        kind,
        id: id.to_owned(),
        audit,
        limit: Some(20),
    }
}

fn codes(problems: impl IntoIterator<Item = &'static str>) -> Vec<&'static str> {
    let mut codes: Vec<&'static str> = problems.into_iter().collect();
    codes.sort();
    codes
}

#[test]
fn a_replaced_on_actions_file_drops_the_hooks_it_lacks_and_unknown_events_are_flagged() {
    let root = write_mod(
        "on_actions",
        &[(
            "common/on_actions/00_on_actions.txt",
            "on_actions = {\n\ton_startup = {\n\t\tevents = { vanilla.1 t.9 }\n\t\trandom_events = { 100 = vanilla.2 0 = 0 }\n\t}\n}\n",
        )],
    );
    let answer = respond(&request(&root, System::OnActions, "on_startup", false));
    assert!(answer.found);
    // The game's file is replaced, so only the mod's definition loads.
    assert_eq!(answer.definitions.len(), 1);
    let known: Vec<_> = answer.references.iter().map(|r| (r.value.as_str(), r.known)).collect();
    // References that point at nothing come first.
    assert_eq!(known, [("t.9", false), ("vanilla.1", true), ("vanilla.2", true)]);
    assert_eq!(codes(answer.problems.iter().map(|p| p.code)), ["SYSTEM_REFERENCE_UNKNOWN"]);

    let audit = audit(&request(&root, System::OnActions, "", true));
    assert_eq!(audit.counts.get("ON_ACTION_HOOK_DROPPED"), Some(&1));
    let dropped = audit.problems.iter().find(|p| p.code == "ON_ACTION_HOOK_DROPPED").unwrap();
    assert_eq!(dropped.id, "on_new_term_election");
}

const MIO: &[(&str, &str)] = &[
    (
        "common/military_industrial_organization/organizations/t.txt",
        "t_base = {\n\tallowed = { always = yes }\n\ttrait = { token = t_a }\n\ttrait = { token = t_b parent = { traits = { t_a } } }\n}\nt_child = {\n\tinclude = t_base\n\tallowed = { always = yes }\n\ticon = GFX_t_missing\n\torganization_modifier = { political_power_gain = 1 t_bogus = 1 }\n\tremove_trait = { t_a }\n\toverride_trait = { token = t_zz }\n\ttrait = { token = t_b }\n\ttrait = { token = t_c any_parent = { t_b t_nope } }\n\ttrait = { token = t_c }\n}\nt_orphan = {\n\tinclude = t_nobody\n\tallowed = { always = yes }\n}\n",
    ),
    ("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_base:0 \"Base\"\n t_a:0 \"A\"\n t_b:0 \"B\"\n t_child_t_c:0 \"C\"\n"),
];

#[test]
fn an_organization_checks_its_include_traits_picture_and_modifiers() {
    let root = write_mod("mio", MIO);
    let answer = respond(&request(&root, System::Mio, "t_child", false));
    assert!(answer.found);
    let traits: Vec<_> = answer.parts.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(traits, ["t_b", "t_c", "t_c"]);
    let unknown: Vec<_> = answer.references.iter().filter(|r| !r.known).map(|r| (r.target, r.value.as_str())).collect();
    assert_eq!(unknown, [("sprite", "GFX_t_missing"), ("trait", "t_zz"), ("trait", "t_nope")]);
    // Redeclaring the included t_b edits it; declaring t_c twice is the duplicate.
    assert_eq!(
        codes(answer.problems.iter().map(|p| p.code)),
        ["SYSTEM_DUPLICATE_TOKEN", "SYSTEM_PICTURE_MISSING", "SYSTEM_REFERENCE_UNKNOWN", "SYSTEM_REFERENCE_UNKNOWN", "SYSTEM_UNKNOWN_MODIFIER"]
    );
    // The trait's name falls back to `<organization>_<token>`.
    assert!(answer.texts.iter().any(|t| t.key == "t_child_t_c" && !t.texts.is_empty()));

    let audit = audit(&request(&root, System::Mio, "", true));
    assert_eq!(audit.checked, 3);
    assert!(audit.problems.iter().any(|p| p.id == "t_orphan" && p.message.contains("t_nobody")));
    // t_orphan has no name of its own, but it includes another organization, so it is not judged.
    assert!(!audit.problems.iter().any(|p| p.code == "SYSTEM_NAME_MISSING" && p.id == "t_orphan"));
}

#[test]
fn a_balance_of_power_checks_its_sides_ranges_and_decision_category() {
    let root = write_mod(
        "bop",
        &[(
            "common/bop/t.txt",
            "t_balance = {\n\tleft_side = t_left\n\tright_side = t_wrong\n\tdecision_category = t_no_category\n\trange = { id = t_mid min = -0.1 max = 0.1 modifier = { stability_factor = 0.1 } }\n\tside = { id = t_left range = { id = t_mid min = -1 max = -0.1 } }\n\tside = { id = t_right }\n}\n",
        )],
    );
    let answer = respond(&request(&root, System::BalanceOfPower, "t_balance", false));
    let warnings: Vec<_> = answer.problems.iter().filter(|p| p.severity == "warning").map(|p| p.code).collect();
    assert_eq!(codes(warnings), ["SYSTEM_DUPLICATE_TOKEN", "SYSTEM_REFERENCE_UNKNOWN"]);
    assert!(answer.problems.iter().any(|p| p.message.contains("t_wrong")));
    // The balance creates its decision category, so a category no file defines is fine.
    assert!(!answer.problems.iter().any(|p| p.message.contains("t_no_category")));
    // No language names the balance, its sides or its ranges: information only.
    assert!(answer.problems.iter().any(|p| p.code == "SYSTEM_NAME_MISSING" && p.severity == "info"));
}

#[test]
fn a_special_project_checks_its_specialization_tags_and_rewards() {
    let root = write_mod(
        "projects",
        &[
            ("common/special_projects/specialization/t.txt", "t_spec = { }\n"),
            ("common/special_projects/project_tags/tags.txt", "project_tags = { t_tag }\n"),
            (
                "common/special_projects/prototype_rewards/t.txt",
                "t_reward = {\n\toption = { token = t_one }\n}\nt_choice = {\n\toption = { token = t_x }\n\toption = { token = t_x }\n}\n",
            ),
            (
                "common/special_projects/projects/t.txt",
                "t_project = {\n\tspecialization = t_nospec\n\tproject_tags = { t_tag }\n\tgeneric_prototype_rewards = { t_reward t_lost }\n\tproject_output = { enable_subunits = { t_no_unit } }\n}\n",
            ),
            (
                "localisation/english/t_l_english.yml",
                "{BOM}l_english:\n t_project:0 \"Project\"\n t_project_desc:0 \"About\"\n t_reward:0 \"R\"\n t_choice:0 \"C\"\n",
            ),
        ],
    );
    let answer = respond(&request(&root, System::SpecialProject, "t_project", false));
    let unknown: Vec<_> = answer.references.iter().filter(|r| !r.known).map(|r| r.value.as_str()).collect();
    assert_eq!(unknown, ["t_nospec", "t_lost", "t_no_unit"]);

    let audit = audit(&request(&root, System::SpecialProject, "", true));
    // A lone option's name is never shown, so only the choice's options are judged.
    assert_eq!(audit.counts.get("SYSTEM_DUPLICATE_TOKEN"), Some(&1));
    let names: Vec<_> = audit.problems.iter().filter(|p| p.code == "SYSTEM_NAME_MISSING").map(|p| p.message.clone()).collect();
    assert!(names.iter().any(|m| m.contains("`t_x`")));
    assert!(!names.iter().any(|m| m.contains("`t_one`")));
}

#[test]
fn a_raid_needs_a_known_category_and_an_unknown_id_suggests_close_ones() {
    let root = write_mod(
        "raids",
        &[
            ("common/raids/categories/t.txt", "categories = { t_category = { intel_source = air } }\n"),
            ("common/raids/t.txt", "types = {\n\tt_strike = { category = t_category }\n\tt_lost = { category = t_nothing }\n}\n"),
            ("localisation/english/t_l_english.yml", "{BOM}l_english:\n raid_type_t_strike:0 \"Strike\"\n raid_type_t_strike_desc:0 \"About\"\n"),
        ],
    );
    let strike = respond(&request(&root, System::Raid, "t_strike", false));
    assert!(strike.problems.is_empty(), "{:?}", strike.problems.iter().map(|p| &p.message).collect::<Vec<_>>());
    let lost = respond(&request(&root, System::Raid, "t_lost", false));
    assert!(lost.problems.iter().any(|p| p.code == "SYSTEM_REFERENCE_UNKNOWN" && p.message.contains("t_nothing")));
    let missing = respond(&request(&root, System::Raid, "t_strik", false));
    assert!(!missing.found);
    assert_eq!(missing.suggestions, ["t_strike"]);

    let (_, code) = respond_json(r#"{"kind":"raid"}"#);
    assert_eq!(code, 2);
    let (text, code) = respond_json(r#"{"kind":"nonsense","id":"x"}"#);
    assert_eq!(code, 2);
    assert!(text.contains("SYSTEM_INVALID_REQUEST"));
}

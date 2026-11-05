//! `hoi4-engine ideas` against the synthetic game in `fixtures/game` and a small mod.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::ideas::{Request, Subject, audit, respond, respond_json};

const BOM: &str = "\u{feff}";

fn game() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/game")
}

fn write_mod(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("ideas").join(name);
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

fn request(target: &Path, kind: Subject, id: &str, audit: bool) -> Request {
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

const MOD: &[(&str, &str)] = &[
    (
        "common/idea_tags/00_idea.txt",
        "idea_categories = {\n\tsecret = { hidden = yes }\n\tcountry = { }\n\tpolitical_advisor = { character_slot = cultural_advisor }\n}\n",
    ),
    ("common/buildings/00_buildings.txt", "buildings = { arms_factory = { } }\n"),
    (
        "common/ideas/t.txt",
        "ideas = {\n\tcountry = {\n\t\tt_spirit = {\n\t\t\tname = t_spirit_name\n\t\t\tpicture = t_pic\n\t\t\tmodifier = {\n\t\t\t\tpolitical_power_gain = 0.1\n\t\t\t\tproduction_speed_arms_factory_factor = 0.1\n\t\t\t\tcultural_advisor_cost_factor = -0.1\n\t\t\t\tnot_a_modifier = 1\n\t\t\t\tcustom_modifier_tooltip = t_tt\n\t\t\t}\n\t\t}\n\t\tt_bare = { }\n\t\tt_unseen = { visible = { always = no } }\n\t}\n\tsecret = {\n\t\tt_hidden = { }\n\t}\n}\n",
    ),
    ("interface/t.gfx", "spriteTypes = {\n\tspriteType = { name = \"GFX_idea_t_pic\" texturefile = \"gfx/t_pic.dds\" }\n}\n"),
    ("gfx/t_pic.dds", "DDS "),
    ("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_spirit_name:0 \"Spirit\"\n t_spirit_name_desc:0 \"About it\"\n t_person:0 \"Person\"\n"),
    (
        "common/characters/t.txt",
        "characters = {\n\tt_person = {\n\t\tname = t_person\n\t\tportraits = { civilian = { large = GFX_t_missing_portrait } }\n\t\tadvisor = { slot = political_advisor idea_token = t_person_advisor traits = { no_such_trait } }\n\t}\n}\n",
    ),
];

#[test]
fn an_idea_shows_its_picture_name_and_modifiers_and_flags_unknown_ones() {
    let root = write_mod("idea", MOD);
    let answer = respond(&request(&root, Subject::Idea, "t_spirit", false));
    assert!(answer.found);
    assert_eq!(answer.category.as_deref(), Some("country"));
    let picture = answer.picture.as_ref().unwrap();
    assert_eq!((picture.sprite.as_str(), picture.defined), ("GFX_idea_t_pic", true));
    let unknown: Vec<_> = answer.modifiers.iter().filter(|m| !m.known).map(|m| m.key.as_str()).collect();
    // The building and idea-slot modifiers are built from names; only the invented one is unknown.
    assert_eq!(unknown, ["not_a_modifier"]);
    assert_eq!(answer.texts[0].key, "t_spirit_name");
    assert_eq!(answer.texts[0].texts[0].text, "Spirit");
    assert_eq!(answer.problems.iter().map(|p| p.code).collect::<Vec<_>>(), ["IDEA_UNKNOWN_MODIFIER"]);
}

#[test]
fn an_advisor_idea_names_its_character_and_an_unknown_id_suggests_close_ones() {
    let root = write_mod("advisor", MOD);
    let advisor = respond(&request(&root, Subject::Idea, "t_person_advisor", false));
    assert_eq!(advisor.advisor_of.as_deref(), Some("t_person"));
    let missing = respond(&request(&root, Subject::Idea, "t_spirt", false));
    assert!(!missing.found);
    assert!(missing.suggestions.contains(&"t_spirit".to_owned()));
}

#[test]
fn a_character_checks_traits_and_portraits_of_the_mod() {
    let root = write_mod("character", MOD);
    let answer = respond(&request(&root, Subject::Character, "t_person", false));
    assert_eq!(answer.roles.len(), 1);
    assert_eq!(answer.roles[0].role, "advisor");
    let codes: Vec<_> = answer.problems.iter().map(|p| p.code).collect();
    assert!(codes.contains(&"CHARACTER_TRAIT_UNKNOWN"), "{codes:?}");
    assert!(codes.contains(&"CHARACTER_PORTRAIT_MISSING"), "{codes:?}");
}

#[test]
fn an_audit_skips_hidden_and_never_visible_ideas() {
    let root = write_mod("audit", MOD);
    let checked = audit(&request(&root, Subject::Idea, "", true));
    assert_eq!(checked.checked, 4);
    let ids: Vec<_> = checked.problems.iter().filter(|p| p.code == "IDEA_PICTURE_MISSING").map(|p| p.id.as_str()).collect();
    // t_bare is shown without a picture; the hidden and never-visible ideas need none.
    assert_eq!(ids, ["t_bare"]);
    assert!(checked.problems.iter().any(|p| p.code == "IDEA_NAME_MISSING" && p.id == "t_bare" && p.severity == "info"));
}

#[test]
fn json_requests_name_their_errors() {
    let (json, code) = respond_json(r#"{"kind":"idea"}"#);
    assert_eq!(code, 2);
    assert!(json.contains("IDEAS_ID_REQUIRED"), "{json}");
}

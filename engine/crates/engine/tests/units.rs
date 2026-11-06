//! `hoi4-engine units` against the synthetic game in `fixtures/game` and a small mod.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::system::{Request, System, audit, respond, respond_json, respond_units_json};

fn game() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/game")
}

fn write_mod(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("units").join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("descriptor.mod"), format!("name=\"{name}\"\n")).unwrap();
    for (path, text) in files {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, text.replace("{BOM}", "\u{feff}")).unwrap();
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

const MOD: &[(&str, &str)] = &[
    (
        "common/units/t_units.txt",
        "sub_units = {\n\tt_infantry = {\n\t\tneed = { t_gun = 100 t_nothing = 1 }\n\t\tcategories = { category_t }\n\t}\n\tt_ship = { need = { t_hull = 1 } }\n}\n",
    ),
    ("common/unit_tags/t.txt", "sub_unit_categories = { category_t }\n"),
    (
        "common/units/equipment/t_equipment.txt",
        "equipments = {\n\tt_gun = { is_archetype = yes }\n\tt_gun_1 = { archetype = t_gun }\n\tt_hull = {\n\t\tis_archetype = yes\n\t\tupgrades = { t_upgrade t_lost_upgrade }\n\t\tmodule_slots = {\n\t\t\tfixed_main = { allowed_module_categories = { t_battery t_none } }\n\t\t\tcopy = fixed_main\n\t\t\twrong = fixed_later\n\t\t}\n\t\tdefault_modules = { fixed_main = t_battery_1 copy = empty wrong = t_lost_module }\n\t}\n\tt_hull_1 = { archetype = t_hull }\n}\nduplicate_archetypes = {\n\tt_hull_light = { archetype = t_hull }\n}\n",
    ),
    ("common/units/equipment/modules/t_modules.txt", "equipment_modules = {\n\tlimit = { always = yes }\n\tt_battery_1 = { category = t_battery }\n}\n"),
    ("common/units/equipment/upgrades/t_upgrades.txt", "upgrades = { t_upgrade = { max_level = 5 } }\n"),
    ("common/units/names_divisions/t_names.txt", "T_INF_01 = { name = \"Infantry\" }\n"),
    ("map/definition.csv", "0;0;0;0;land;false;unknown;0\n1;1;1;1;land;false;plains;1\n2;2;2;2;sea;false;ocean;0\n"),
    (
        "history/units/T_1936.txt",
        "division_template = {\n\tname = \"Line\"\n\tdivision_names_group = T_INF_01\n\tregiments = {\n\t\tt_infantry = { x = 0 y = 0 }\n\t\tt_infantry = { x = 0 y = 0 }\n\t\tt_infantry = { x = 5 y = 0 }\n\t}\n\tsupport = { t_infantry = { x = 1 y = 0 } }\n}\nunits = {\n\tdivision = { division_template = \"Line\" location = 1 }\n\tdivision = { division_template = \"Gone\" location = 99 }\n\tfleet = {\n\t\tname = \"Home\"\n\t\tnaval_base = 2\n\t\ttask_force = {\n\t\t\tlocation = 2\n\t\t\tship = { name = \"T Carrier\" definition = t_ship equipment = { t_hull_light_1 = { amount = 1 owner = T version_name = \"First\" } } }\n\t\t\tship = { name = \"T Two\" definition = t_ship equipment = { t_hull_1 = { amount = 1 owner = T version_name = \"Nobody\" } } }\n\t\t}\n\t}\n}\nair_wings = {\n\t1 = { t_gun_1 = { owner = T amount = 10 } }\n\t\"T Carrier\" = { t_gun_1 = { owner = T amount = 10 } }\n\t\"T Lost\" = { t_gun_1 = { owner = T amount = 10 } }\n}\n",
    ),
    (
        "history/countries/T - Test.txt",
        "capital = 1\noob = \"T_1936\"\nset_naval_oob = \"T_1936_missing\"\ncreate_equipment_variant = {\n\tname = \"First\"\n\ttype = t_hull_1\n\tmodules = { fixed_main = t_battery_1 copy = t_lost_module }\n\tupgrades = { t_upgrade = 1 t_nope = 1 }\n}\n",
    ),
    ("localisation/english/t_l_english.yml", "{BOM}l_english:\n t_infantry:0 \"Infantry\"\n t_infantry_desc:0 \"Walks\"\n t_gun:0 \"Gun\"\n"),
];

fn unknown(references: &[hoi4_engine::system::Reference]) -> Vec<(&'static str, &str)> {
    references.iter().filter(|r| !r.known).map(|r| (r.target, r.value.as_str())).collect()
}

#[test]
fn an_order_of_battle_checks_its_template_grid_names_and_places() {
    let root = write_mod("oob", MOD);
    let answer = respond(&request(&root, System::Oob, "T_1936", false));
    assert!(answer.found);
    let parts: Vec<_> = answer.parts.iter().map(|p| (p.what, p.id.as_str())).collect();
    assert_eq!(parts, [("template", "Line"), ("fleet", "Home")]);
    let mut missing = unknown(&answer.references);
    missing.sort();
    // `t_hull_light_1` is derived from the duplicated archetype, and the carrier's wings are found by its name.
    assert_eq!(missing, [("division_template", "Gone"), ("province", "99"), ("ship", "T Lost"), ("variant", "Nobody")]);
    let slots: Vec<_> = answer.problems.iter().filter(|p| p.code == "UNIT_TEMPLATE_SLOT_INVALID").map(|p| p.message.as_str()).collect();
    assert_eq!(slots.len(), 3, "{slots:?}");
    assert!(slots.iter().any(|m| m.contains("both sit at x = 0, y = 0")));
    assert!(slots.iter().any(|m| m.contains("x = 5") && m.contains("regiments")));
    assert!(slots.iter().any(|m| m.contains("x = 1") && m.contains("support")));

    let audit = audit(&request(&root, System::Oob, "", true));
    assert_eq!(audit.checked, 1);
    let missing: Vec<_> = audit.problems.iter().filter(|p| p.code == "UNIT_OOB_MISSING").map(|p| p.id.as_str()).collect();
    assert_eq!(missing, ["T_1936_missing"]);
}

#[test]
fn a_sub_unit_needs_known_equipment_and_categories() {
    let root = write_mod("sub_unit", MOD);
    let answer = respond(&request(&root, System::SubUnit, "t_infantry", false));
    assert_eq!(unknown(&answer.references), [("equipment", "t_nothing")]);
    assert!(answer.texts.iter().any(|t| t.key == "t_infantry" && !t.texts.is_empty()));
    let audit = audit(&request(&root, System::SubUnit, "", true));
    assert_eq!(audit.checked, 2);
    // t_ship has no name or description: information only.
    assert!(audit.problems.iter().any(|p| p.code == "UNIT_NAME_MISSING" && p.severity == "info" && p.id == "t_ship"));
}

#[test]
fn equipment_checks_its_slots_modules_and_upgrades() {
    let root = write_mod("equipment", MOD);
    let answer = respond(&request(&root, System::Equipment, "t_hull", false));
    let mut missing = unknown(&answer.references);
    missing.sort();
    assert_eq!(missing, [("equipment_module", "t_lost_module"), ("module_category", "t_none"), ("module_slot", "fixed_later"), ("upgrade", "t_lost_upgrade")]);
    // `limit` is the condition of the modules block, not a module.
    let modules = respond(&request(&root, System::Equipment, "limit", false));
    assert!(!modules.found);
    let module = respond(&request(&root, System::Equipment, "t_battery_1", false));
    assert_eq!(module.definitions[0].what, "module");
}

#[test]
fn a_variant_is_found_by_name_wherever_it_is_created() {
    let root = write_mod("variant", MOD);
    let answer = respond(&request(&root, System::Variant, "First", false));
    assert!(answer.found);
    assert_eq!(answer.definitions[0].place.path, "history/countries/T - Test.txt");
    let mut missing = unknown(&answer.references);
    missing.sort();
    assert_eq!(missing, [("equipment_module", "t_lost_module"), ("upgrade", "t_nope")]);
    assert!(answer.problems.iter().all(|p| p.code == "UNIT_REFERENCE_UNKNOWN"));
}

#[test]
fn each_command_takes_only_its_own_kinds() {
    let (text, code) = respond_units_json(r#"{"kind":"raid","id":"x"}"#);
    assert_eq!(code, 2);
    assert!(text.contains("UNIT_INVALID_REQUEST"), "{text}");
    let (text, code) = respond_json(r#"{"kind":"oob","id":"x"}"#);
    assert_eq!(code, 2);
    assert!(text.contains("SYSTEM_INVALID_REQUEST"), "{text}");
    let (text, code) = respond_units_json(r#"{"kind":"variant"}"#);
    assert_eq!(code, 2);
    assert!(text.contains("UNIT_ID_REQUIRED"), "{text}");
}

//! Tests of `common.block_write`: fixtures are synthetic and project-owned.

use super::descriptor::{DESCRIPTORS, kinds};
use super::*;

const BOP_BODY: &str = "initial_value = 0
left_side = t_left
right_side = t_right
decision_category = t_cat
side = {
\tid = t_left
\ticon = GFX_t_left
\trange = { id = t_left_far min = -1 max = -0.2 }
}
side = {
\tid = t_right
\ticon = GFX_t_right
\trange = { id = t_right_far min = 0.2 max = 1 }
}
range = { id = t_mid min = -0.2 max = 0.2 }";

const BOP_FILE: &str = "# synthetic\nt_first = {\n\tinitial_value = 0\n\tleft_side = a_l\n\tright_side = a_r\n\tside = {\n\t\tid = a_l\n\t\trange = { id = a_l_r min = -1 max = 0 }\n\t}\n\tside = {\n\t\tid = a_r\n\t\trange = { id = a_r_r min = 0 max = 1 }\n\t}\n}\n";

const STRATEGY_FILE: &str = "# strategies\nt_one = {\n\tallowed = { always = yes }\n\tabort_when_not_enabled = yes\n\tai_strategy = {\n\t\ttype = conquer\n\t\tid = \"AAA\"\n\t\tvalue = 100\n\t}\n}\n";

const ON_ACTION_FILE: &str = "# merged by key\non_actions = {\n\ton_daily = {\n\t\teffect = {\n\t\t\tlog = \"one\"\n\t\t}\n\t\trandom_events = {\n\t\t\t100 = t.1\n\t\t}\n\t}\n\n\ton_startup = {\n\t\teffect = {\n\t\t\tlog = \"start\"\n\t\t}\n\t}\n}\n";

fn input(kind: &str, operation: Operation, id: &str, body: Option<&str>) -> CommonWriteInput {
    CommonWriteInput { kind: kind.into(), operation, id: id.into(), body: body.map(Into::into), block_index: None, known_tokens: None, known_names: None }
}

fn plan(i: &CommonWriteInput, path: &str, file: &str) -> WriteResult<CommonWritePlan> {
    plan_common_write(file.as_bytes(), path, i, false)
}

fn code(r: WriteResult<CommonWritePlan>) -> String {
    r.err().map_or("NO_ERROR".into(), |e| e.code)
}

fn text(p: &CommonWritePlan) -> String {
    String::from_utf8(p.bytes.clone()).unwrap()
}

fn codes(p: &CommonWritePlan) -> Vec<&'static str> {
    p.findings.iter().map(|f| f.code).collect()
}

#[test]
fn every_descriptor_has_a_folder_a_noun_and_a_unique_kind() {
    assert_eq!(kinds(), vec!["bop", "ai_strategy", "ai_strategy_plan", "on_action"]);
    let mut seen = Vec::new();
    for d in DESCRIPTORS {
        assert!(d.folder.starts_with("common/") && !d.folder.ends_with('/'), "{}", d.kind);
        assert!(!d.noun.is_empty());
        assert!(!seen.contains(&d.kind));
        seen.push(d.kind);
    }
}

// ---- balance of power

#[test]
fn bop_creates_a_file_and_the_check_passes() {
    let i = input("bop", Operation::Add, "t_bop", Some(BOP_BODY));
    let made = plan_common_write(b"", "common/bop/t.txt", &i, true).unwrap();
    assert!(text(&made).starts_with("t_bop = {\n\tinitial_value = 0\n\tleft_side = t_left\n"));
    assert!(text(&made).ends_with("\trange = { id = t_mid min = -0.2 max = 0.2 }\n}\n"));
    assert!(made.findings.is_empty());
    assert_eq!(made.references.localisation, vec!["t_bop", "t_left", "t_right", "t_mid", "t_left_far", "t_right_far"]);
    assert_eq!(made.references.sprites, vec!["GFX_t_left", "GFX_t_right"]);
    assert_eq!(made.references.categories, vec!["t_cat"]);
    assert_eq!(made.edit.start, 0);
}

#[test]
fn bop_adds_replaces_and_removes_keeping_everything_else() {
    let added = plan(&input("bop", Operation::Add, "t_bop", Some(BOP_BODY)), "common/bop/t.txt", BOP_FILE).unwrap();
    assert!(text(&added).starts_with(BOP_FILE));
    assert!(text(&added).contains("}\n\nt_bop = {\n\tinitial_value = 0\n"));
    assert_eq!(added.untouched_definitions, 1);
    let removed = plan_common_write(&added.bytes, "common/bop/t.txt", &input("bop", Operation::Remove, "t_bop", None), false).unwrap();
    assert_eq!(removed.bytes, BOP_FILE.as_bytes());
    let swapped = plan(&input("bop", Operation::Replace, "t_first", Some(BOP_BODY)), "common/bop/t.txt", BOP_FILE).unwrap();
    assert!(text(&swapped).starts_with("# synthetic\nt_first = {\n\tinitial_value = 0\n\tleft_side = t_left\n"));
    assert!(text(&swapped).ends_with("}\n"));
    assert_eq!(swapped.untouched_definitions, 0);
}

#[test]
fn bop_checks_the_ranges_and_sides() {
    let go = |body: &str| code(plan(&input("bop", Operation::Add, "t_bop", Some(body)), "common/bop/t.txt", BOP_FILE));
    let with = |from: &str, to: &str| BOP_BODY.replace(from, to);
    assert_eq!(go(&with("max = -0.2 }", "max = -0.3 }")), "COMMON_WRITE_CHECK_FAILED");
    let detail = |body: &str| {
        let e = plan(&input("bop", Operation::Add, "t_bop", Some(body)), "common/bop/t.txt", BOP_FILE).err().unwrap();
        e.to_json()["errors"].as_array().unwrap().iter().map(|f| f["code"].as_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    assert_eq!(detail(&with("max = -0.2 }", "max = -0.3 }")), vec!["BOP_RANGE_GAP"]);
    assert_eq!(detail(&with("min = 0.2 max = 1", "min = 0.1 max = 1")), vec!["BOP_RANGE_OVERLAP"]);
    assert_eq!(detail(&with("min = -1 max", "min = -0.9 max")), vec!["BOP_RANGE_COVERAGE"]);
    assert_eq!(detail(&with("min = 0.2 max = 1", "min = 0.2 max = 0.9")), vec!["BOP_RANGE_COVERAGE"]);
    assert_eq!(detail(&with("min = -0.2 max = 0.2", "min = 0.2 max = 0.2")), vec!["BOP_RANGE_EMPTY", "BOP_RANGE_GAP"]);
    assert_eq!(detail(&with("id = t_right\n", "id = t_left\n")), vec!["BOP_SIDE_DUPLICATE_ID", "BOP_SIDE_UNKNOWN"]);
    assert_eq!(detail(&with("right_side = t_right", "right_side = t_left")), vec!["BOP_SIDES_IDENTICAL"]);
    assert_eq!(detail(&with("right_side = t_right", "right_side = nobody")), vec!["BOP_SIDE_UNKNOWN"]);
    assert_eq!(detail(&with("id = t_right_far", "id = t_left_far")), vec!["BOP_RANGE_DUPLICATE_ID"]);
    assert_eq!(
        detail(&with("range = { id = t_mid min = -0.2 max = 0.2 }", "range = { id = t_mid min = -0.2 }")),
        vec!["BOP_RANGE_INCOMPLETE", "BOP_RANGE_GAP"]
    );
    assert_eq!(detail("initial_value = 0"), vec!["BOP_RANGES_MISSING"]);
}

#[test]
fn bop_warns_about_an_initial_value_outside_the_scale_and_still_writes() {
    let body = BOP_BODY.replace("initial_value = 0", "initial_value = 4");
    let made = plan(&input("bop", Operation::Add, "t_bop", Some(&body)), "common/bop/t.txt", BOP_FILE).unwrap();
    assert_eq!(codes(&made), vec!["BOP_INITIAL_VALUE_RANGE"]);
}

// ---- AI strategies and plans

#[test]
fn ai_strategy_warns_without_refusing() {
    let body = "allowed = { always = yes }\nai_strategy = {\n\ttype = made_up_token\n\tid = \"AAA\"\n\tvalue = lots\n}";
    let mut i = input("ai_strategy", Operation::Add, "t_two", Some(body));
    i.known_tokens = Some(vec!["conquer".into(), "alliance".into()]);
    let made = plan(&i, "common/ai_strategy/t.txt", STRATEGY_FILE).unwrap();
    assert_eq!(codes(&made), vec!["AI_STRATEGY_TYPE_UNKNOWN", "AI_STRATEGY_VALUE_NOT_NUMBER", "AI_STRATEGY_NO_ABORT"]);
    assert!(text(&made).starts_with(STRATEGY_FILE));
    assert!(text(&made).ends_with("\tai_strategy = {\n\t\ttype = made_up_token\n\t\tid = \"AAA\"\n\t\tvalue = lots\n\t}\n}\n"));
    // Without the token list nothing is guessed.
    i.known_tokens = None;
    assert_eq!(codes(&plan(&i, "common/ai_strategy/t.txt", STRATEGY_FILE).unwrap()), vec!["AI_STRATEGY_VALUE_NOT_NUMBER", "AI_STRATEGY_NO_ABORT"]);
}

#[test]
fn ai_strategy_replaces_and_removes_one_block() {
    let body = "abort_when_not_enabled = yes\nai_strategy = { type = alliance id = \"BBB\" value = 5 }";
    let mut i = input("ai_strategy", Operation::Replace, "t_one", Some(body));
    i.known_tokens = Some(vec!["alliance".into()]);
    let swapped = plan(&i, "common/ai_strategy/t.txt", STRATEGY_FILE).unwrap();
    assert!(swapped.findings.is_empty());
    assert_eq!(text(&swapped), "# strategies\nt_one = {\n\tabort_when_not_enabled = yes\n\tai_strategy = { type = alliance id = \"BBB\" value = 5 }\n}\n");
    let gone = plan(&input("ai_strategy", Operation::Remove, "t_one", None), "common/ai_strategy/t.txt", STRATEGY_FILE).unwrap();
    assert_eq!(text(&gone), "# strategies\n");
}

#[test]
fn ai_strategy_plan_lists_its_focuses() {
    let body = "name = t_plan_name\ndesc = t_plan_desc\nai_national_focuses = {\n\tt_focus_one\n\tt_focus_two\n}";
    let made = plan_common_write(b"", "common/ai_strategy_plans/t.txt", &input("ai_strategy_plan", Operation::Add, "t_plan", Some(body)), true).unwrap();
    assert_eq!(made.references.focuses, vec!["t_focus_one", "t_focus_two"]);
    assert_eq!(made.references.localisation, vec!["t_plan_name", "t_plan_desc"]);
    let bare = plan_common_write(b"", "common/ai_strategy_plans/t.txt", &input("ai_strategy_plan", Operation::Add, "t_plan", Some("name = x")), true).unwrap();
    assert_eq!(codes(&bare), vec!["AI_PLAN_NO_FOCUSES"]);
}

// ---- on_actions

#[test]
fn on_action_creates_a_file_with_its_wrapper() {
    let body = "effect = {\n\tlog = \"hello\"\n}";
    let i = input("on_action", Operation::Add, "on_startup", Some(body));
    let mut with_names = i.clone();
    with_names.known_names = Some(vec!["on_startup".into()]);
    let made = plan_common_write(b"", "common/on_actions/t.txt", &with_names, true).unwrap();
    assert_eq!(text(&made), "on_actions = {\n\ton_startup = {\n\t\teffect = {\n\t\t\tlog = \"hello\"\n\t\t}\n\t}\n}\n");
    assert_eq!(code(plan_common_write(b"", "common/on_actions/t.txt", &i, true)), "COMMON_WRITE_NAME_UNKNOWN");
}

#[test]
fn on_action_appends_to_a_key_and_adds_a_key() {
    let body = "effect = {\n\tlog = \"two\"\n}";
    let appended = plan(&input("on_action", Operation::Add, "on_daily", Some(body)), "common/on_actions/t.txt", ON_ACTION_FILE).unwrap();
    assert_eq!(text(&appended), ON_ACTION_FILE.replace("\t\t\t100 = t.1\n\t\t}\n", "\t\t\t100 = t.1\n\t\t}\n\t\teffect = {\n\t\t\tlog = \"two\"\n\t\t}\n"));
    assert_eq!(appended.untouched_definitions, 1);
    let key = plan(&input("on_action", Operation::Add, "on_daily_TST", Some(body)), "common/on_actions/t.txt", ON_ACTION_FILE).unwrap();
    assert_eq!(text(&key), ON_ACTION_FILE.replace("\t\t}\n\t}\n}\n", "\t\t}\n\t}\n\n\ton_daily_TST = {\n\t\teffect = {\n\t\t\tlog = \"two\"\n\t\t}\n\t}\n}\n"));
}

#[test]
fn on_action_replaces_and_removes_one_child_or_the_key() {
    let mut i = input("on_action", Operation::Remove, "on_daily", None);
    i.block_index = Some(1);
    let removed = plan(&i, "common/on_actions/t.txt", ON_ACTION_FILE).unwrap();
    assert_eq!(text(&removed), ON_ACTION_FILE.replace("\t\trandom_events = {\n\t\t\t100 = t.1\n\t\t}\n", ""));
    i.operation = Operation::Replace;
    i.block_index = Some(0);
    i.body = Some("effect = {\n\tlog = \"new\"\n}".into());
    let swapped = plan(&i, "common/on_actions/t.txt", ON_ACTION_FILE).unwrap();
    assert_eq!(text(&swapped), ON_ACTION_FILE.replace("log = \"one\"", "log = \"new\""));
    let whole = plan(&input("on_action", Operation::Remove, "on_startup", None), "common/on_actions/t.txt", ON_ACTION_FILE).unwrap();
    assert_eq!(text(&whole), ON_ACTION_FILE.replace("\n\ton_startup = {\n\t\teffect = {\n\t\t\tlog = \"start\"\n\t\t}\n\t}\n", ""));
    let replaced =
        plan(&input("on_action", Operation::Replace, "on_startup", Some("effect = { log = \"x\" }")), "common/on_actions/t.txt", ON_ACTION_FILE).unwrap();
    assert!(text(&replaced).ends_with("\ton_startup = {\n\t\teffect = { log = \"x\" }\n\t}\n}\n"));
}

#[test]
fn on_action_adds_the_wrapper_to_a_file_without_one() {
    let file = "# only a comment\n";
    let made = plan(&input("on_action", Operation::Add, "on_weekly_ABC", Some("effect = { }")), "common/on_actions/t.txt", file).unwrap();
    assert_eq!(text(&made), "# only a comment\n\non_actions = {\n\ton_weekly_ABC = {\n\t\teffect = { }\n\t}\n}\n");
}

#[test]
fn on_action_names_are_documented_or_periodic_or_already_in_the_file() {
    let body = Some("effect = { }");
    let go = |id: &str, names: Option<Vec<String>>| {
        let mut i = input("on_action", Operation::Add, id, body);
        i.known_names = names;
        code(plan(&i, "common/on_actions/t.txt", ON_ACTION_FILE))
    };
    assert_eq!(go("on_made_up", None), "COMMON_WRITE_NAME_UNKNOWN");
    assert_eq!(go("on_daily_ab", None), "COMMON_WRITE_NAME_UNKNOWN");
    assert_eq!(go("on_daily_ABCD", None), "COMMON_WRITE_NAME_UNKNOWN");
    assert_eq!(go("on_monthly_T1X", None), "NO_ERROR");
    assert_eq!(go("on_made_up", Some(vec!["on_made_up".into()])), "NO_ERROR");
    assert_eq!(go("on_startup", None), "NO_ERROR");
    let e = plan(&input("on_action", Operation::Add, "on_zzz", body), "common/on_actions/t.txt", ON_ACTION_FILE).err().unwrap();
    assert_eq!(e.to_json()["known"], json!([]));
}

// ---- layout and bytes

#[test]
fn keeps_crlf_bom_and_windows_1252() {
    let crlf = BOP_FILE.replace('\n', "\r\n");
    let added = plan(&input("bop", Operation::Add, "t_bop", Some(BOP_BODY)), "common/bop/t.txt", &crlf).unwrap();
    assert!(text(&added).starts_with(&crlf));
    assert!(!text(&added).replace("\r\n", "").contains('\n'));
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend_from_slice(BOP_FILE.as_bytes());
    let with_bom = plan_common_write(&bom, "common/bop/t.txt", &input("bop", Operation::Add, "t_bop", Some(BOP_BODY)), false).unwrap();
    assert_eq!(&with_bom.bytes[..3], &[0xEF, 0xBB, 0xBF]);
    assert!(with_bom.bytes[3..].starts_with(BOP_FILE.as_bytes()));
    let mut latin = b"# caf\xE9\n".to_vec();
    latin.extend_from_slice(STRATEGY_FILE.as_bytes());
    let kept = plan_common_write(&latin, "common/ai_strategy/t.txt", &input("ai_strategy", Operation::Remove, "t_one", None), false).unwrap();
    assert_eq!(kept.bytes, b"# caf\xE9\n# strategies\n");
    let body = "abort = { always = yes }\nai_strategy = { type = conquer id = \"AAA\" value = 1 }\n# \u{4e2d}";
    assert_eq!(
        code(plan_common_write(&latin, "common/ai_strategy/t.txt", &input("ai_strategy", Operation::Add, "t_two", Some(body)), false)),
        "SOURCE_ENCODING_UNREPRESENTABLE"
    );
}

#[test]
fn keeps_comments_and_unknown_fields_outside_the_block_and_runs_twice_the_same() {
    let file = "# head\nt_a = { # trailing\n\tmystery = { x = 1 }\n}\n\n# between\nt_b = {\n\tallowed = { always = yes }\n}\n";
    let swapped = plan(&input("ai_strategy", Operation::Replace, "t_b", Some("abort = { always = yes }")), "common/ai_strategy/t.txt", file).unwrap();
    assert!(text(&swapped).starts_with("# head\nt_a = { # trailing\n\tmystery = { x = 1 }\n}\n\n# between\nt_b = {\n"));
    let again = plan_common_write(
        &swapped.bytes,
        "common/ai_strategy/t.txt",
        &input("ai_strategy", Operation::Replace, "t_b", Some("abort = { always = yes }")),
        false,
    )
    .unwrap();
    assert_eq!(again.bytes, swapped.bytes);
}

// ---- refusals

#[test]
fn refuses_what_it_cannot_place_or_check() {
    let b = Some("a = b");
    let at = "common/ai_strategy/t.txt";
    let go = |i: CommonWriteInput, path: &str, file: &str| code(plan(&i, path, file));
    assert_eq!(go(input("nope", Operation::Add, "x", b), at, STRATEGY_FILE), "COMMON_WRITE_KIND_UNKNOWN");
    assert_eq!(go(input("ai_strategy", Operation::Add, "t_one", b), at, STRATEGY_FILE), "COMMON_WRITE_DUPLICATE_ID");
    assert_eq!(go(input("ai_strategy", Operation::Replace, "t_none", b), at, STRATEGY_FILE), "COMMON_WRITE_NOT_FOUND");
    assert_eq!(go(input("ai_strategy", Operation::Remove, "t_none", None), at, STRATEGY_FILE), "COMMON_WRITE_NOT_FOUND");
    assert_eq!(go(input("ai_strategy", Operation::Add, "bad id", b), at, STRATEGY_FILE), "COMMON_WRITE_ID_INVALID");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", None), at, STRATEGY_FILE), "COMMON_WRITE_BODY_REQUIRED");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", Some("  \n")), at, STRATEGY_FILE), "COMMON_WRITE_BODY_REQUIRED");
    assert_eq!(go(input("ai_strategy", Operation::Remove, "t_one", b), at, STRATEGY_FILE), "COMMON_WRITE_BODY_UNEXPECTED");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", Some("a = {")), at, STRATEGY_FILE), "COMMON_WRITE_BODY_INVALID");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", Some("a = b }\nc = {")), at, STRATEGY_FILE), "COMMON_WRITE_BODY_INVALID");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", b), "common/ai_strategy_plans/t.txt", STRATEGY_FILE), "COMMON_WRITE_PATH_OUTSIDE_FOLDER");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", b), "common/ai_strategy/../../x.txt", STRATEGY_FILE), "COMMON_WRITE_PATH_OUTSIDE_FOLDER");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", b), "common/ai_strategy/t.yml", STRATEGY_FILE), "COMMON_WRITE_PATH_OUTSIDE_FOLDER");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", b), "common\\ai_strategy\\t.txt", STRATEGY_FILE), "COMMON_WRITE_PATH_OUTSIDE_FOLDER");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", b), at, "t_one = {"), "COMMON_WRITE_SOURCE_INVALID");
    assert_eq!(go(input("ai_strategy", Operation::Add, "x_one", b), at, "t_one = { a = b } }"), "COMMON_WRITE_SOURCE_INVALID");
    assert_eq!(code(plan_common_write(b"", at, &input("ai_strategy", Operation::Replace, "x_one", b), true)), "COMMON_WRITE_FILE_NOT_FOUND");
    let mut index = input("ai_strategy", Operation::Replace, "t_one", b);
    index.block_index = Some(0);
    assert_eq!(go(index, at, STRATEGY_FILE), "COMMON_WRITE_BLOCK_INDEX_UNEXPECTED");
}

#[test]
fn refuses_what_the_keyed_kinds_cannot_place() {
    let at = "common/on_actions/t.txt";
    let go = |i: CommonWriteInput, file: &str| code(plan(&i, at, file));
    let mut index = input("on_action", Operation::Remove, "on_daily", None);
    index.block_index = Some(5);
    assert_eq!(go(index.clone(), ON_ACTION_FILE), "COMMON_WRITE_BLOCK_INDEX_OUT_OF_RANGE");
    index.operation = Operation::Add;
    index.body = Some("effect = { }".into());
    assert_eq!(go(index.clone(), ON_ACTION_FILE), "COMMON_WRITE_BLOCK_INDEX_UNEXPECTED");
    index.operation = Operation::Replace;
    index.block_index = Some(0);
    index.body = Some("effect = { } random_events = { }".into());
    assert_eq!(go(index, ON_ACTION_FILE), "COMMON_WRITE_BODY_INVALID");
    let two = "on_actions = {\n}\non_actions = {\n}\n";
    assert_eq!(go(input("on_action", Operation::Add, "on_daily_TST", Some("effect = { }")), two), "COMMON_WRITE_LAYOUT_UNSUPPORTED");
    assert_eq!(go(input("on_action", Operation::Add, "on_daily_TST", Some("effect = { }")), "on_actions = yes\n"), "COMMON_WRITE_LAYOUT_UNSUPPORTED");
    assert_eq!(go(input("on_action", Operation::Add, "on_daily_TST", Some("effect = { }")), "on_actions = { }\n"), "COMMON_WRITE_LAYOUT_UNSUPPORTED");
    let dup = "on_actions = {\n\ton_startup = { effect = { } }\n\ton_startup = { effect = { } }\n}\n";
    assert_eq!(go(input("on_action", Operation::Add, "on_startup", Some("effect = { }")), dup), "COMMON_WRITE_DUPLICATE_ID");
    assert_eq!(go(input("on_action", Operation::Remove, "on_startup", None), dup), "COMMON_WRITE_DUPLICATE_ID");
}

#[test]
fn a_failed_check_names_every_error() {
    let e = plan(&input("bop", Operation::Add, "t_bop", Some("initial_value = 0")), "common/bop/t.txt", BOP_FILE).err().unwrap();
    let body = e.to_json();
    assert_eq!(body["code"], "COMMON_WRITE_CHECK_FAILED");
    assert_eq!(body["errors"][0]["code"], "BOP_RANGES_MISSING");
}

//! Hand-computed layouts of small trees.

mod common;

use common::{assert_invariants, focus, layout_request, positions, run};
use hoi4_focus_layout::model::Status;
use serde_json::json;

fn at(request: &serde_json::Value) -> std::collections::BTreeMap<String, (i64, i64)> {
    let response = run(request);
    assert_invariants(request, &response);
    positions(&response)
}

#[test]
fn a_chain_is_one_column() {
    let p = at(&layout_request(vec![focus("a", &[]), focus("b", &["a"]), focus("c", &["b"])]));
    assert_eq!(p["a"], (0, 0));
    assert_eq!(p["b"], (0, 1));
    assert_eq!(p["c"], (0, 2));
}

#[test]
fn two_children_sit_one_column_each_side_of_the_parent() {
    let p = at(&layout_request(vec![focus("root", &[]), focus("a", &["root"]), focus("b", &["root"])]));
    assert_eq!(p["root"], (0, 0));
    assert_eq!(p["a"], (-1, 1));
    assert_eq!(p["b"], (1, 1));
}

#[test]
fn three_children_are_centred() {
    let p = at(&layout_request(vec![focus("root", &[]), focus("a", &["root"]), focus("b", &["root"]), focus("c", &["root"])]));
    assert_eq!((p["a"], p["b"], p["c"]), ((-2, 1), (0, 1), (2, 1)));
}

#[test]
fn a_convergence_focus_is_centred_between_its_parents() {
    let p = at(&layout_request(vec![focus("root", &[]), focus("a", &["root"]), focus("b", &["root"]), json!({ "id": "c", "prerequisites": [["a"], ["b"]] })]));
    assert_eq!(p["a"], (-1, 1));
    assert_eq!(p["b"], (1, 1));
    assert_eq!(p["c"], (0, 2));
}

#[test]
fn parents_are_centred_over_their_subtrees() {
    let mut focuses = vec![focus("r", &[]), focus("a", &["r"]), focus("b", &["r"])];
    for c in ["a1", "a2", "a3"] {
        focuses.push(focus(c, &["a"]));
    }
    for c in ["b1", "b2", "b3"] {
        focuses.push(focus(c, &["b"]));
    }
    let p = at(&layout_request(focuses));
    assert_eq!([p["a1"].0, p["a2"].0, p["a3"].0, p["b1"].0, p["b2"].0, p["b3"].0], [-5, -3, -1, 1, 3, 5]);
    assert_eq!((p["a"].0, p["b"].0, p["r"].0), (-3, 3, 0));
}

#[test]
fn exclusive_partners_are_adjacent() {
    let p = at(&layout_request(vec![
        focus("root", &[]),
        json!({ "id": "a", "prerequisites": [["root"]], "mutuallyExclusive": ["c"] }),
        focus("b", &["root"]),
        json!({ "id": "c", "prerequisites": [["root"]], "mutuallyExclusive": ["a"] }),
    ]));
    assert_eq!((p["a"].0 - p["c"].0).abs(), 2, "{p:?}");
    assert_eq!(p["a"].1, p["c"].1);
}

#[test]
fn two_lanes_are_packed_with_the_lane_spacing() {
    let request = json!({
        "schema": "hoi4-focus-layout-request/1",
        "operation": "layout",
        "options": { "nodeSpacing": 2, "laneSpacing": 3 },
        "lanes": [{ "id": "right", "order": 1 }, { "id": "left", "order": 0 }],
        "focuses": [
            { "id": "l", "laneId": "left" },
            { "id": "l1", "laneId": "left", "prerequisites": [["l"]] },
            { "id": "l2", "laneId": "left", "prerequisites": [["l"]] },
            { "id": "r", "laneId": "right" },
        ],
    });
    let p = at(&request);
    // Left band 0..2, right band 2 + 3 columns after it at 7; the bounding box 0..7 is centred.
    assert_eq!(p["r"].0 - p["l2"].0, 5);
    assert_eq!((p["l1"].0, p["l"].0, p["l2"].0, p["r"].0), (-4, -3, -2, 3), "{p:?}");
    let response = run(&request);
    let r = response.source.iter().find(|s| s.id == "r").unwrap();
    assert_eq!(r.relative_to, None);
    let l1 = response.source.iter().find(|s| s.id == "l1").unwrap();
    assert_eq!((l1.relative_to.as_deref(), l1.x, l1.y), (Some("l"), -1, 1));
}

#[test]
fn lane_bounds_move_the_band() {
    let request = json!({
        "schema": "hoi4-focus-layout-request/1",
        "operation": "layout",
        "lanes": [{ "id": "a", "order": 0, "maximumX": -10 }, { "id": "b", "order": 1, "minimumX": 10, "maximumX": 20 }],
        "focuses": [
            { "id": "a0", "laneId": "a" }, { "id": "a1", "laneId": "a", "prerequisites": [["a0"]] }, { "id": "a2", "laneId": "a", "prerequisites": [["a0"]] },
            { "id": "b0", "laneId": "b" },
        ],
    });
    let response = run(&request);
    assert_invariants(&request, &response);
    let p = positions(&response);
    assert!(p["a2"].0 <= -10 && p["a1"].0 <= -10, "{p:?}");
    assert!((10..=20).contains(&p["b0"].0), "{p:?}");
    assert!(response.diagnostics.is_empty(), "{:?}", response.diagnostics);
}

#[test]
fn impossible_lane_bounds_are_reported() {
    let request = json!({
        "schema": "hoi4-focus-layout-request/1",
        "operation": "layout",
        "lanes": [{ "id": "a", "minimumX": 0, "maximumX": 1 }],
        "focuses": [{ "id": "a0", "laneId": "a" }, { "id": "a1", "laneId": "a", "prerequisites": [["a0"]] }, { "id": "a2", "laneId": "a", "prerequisites": [["a0"]] }],
    });
    let response = run(&request);
    assert_invariants(&request, &response);
    assert_eq!(response.diagnostics[0].code, "FOCUS_ENGINE_LANE_BOUNDS_UNSATISFIED");
    assert_eq!(positions(&response)["a1"].0, 0);
}

#[test]
fn a_fixed_obstacle_is_avoided() {
    let request = layout_request(vec![
        json!({ "id": "root", "position": { "mode": "fixed", "x": 0, "y": 0 } }),
        json!({ "id": "rock", "laneId": "other", "position": { "mode": "fixed", "x": 1, "y": 1 } }),
        focus("a", &["root"]),
        focus("b", &["root"]),
    ]);
    let response = run(&request);
    assert_invariants(&request, &response);
    let p = positions(&response);
    assert_eq!(p["rock"], (1, 1));
    assert_eq!(p["root"], (0, 0));
    assert_eq!((p["a"], p["b"]), ((-3, 1), (-1, 1)), "{p:?}");
    assert!(!response.nodes.iter().find(|n| n.id == "rock").unwrap().moved);
}

#[test]
fn relative_focuses_resolve_recursively_and_are_echoed() {
    let request = layout_request(vec![
        json!({ "id": "root", "position": { "mode": "fixed", "x": 4, "y": 1 } }),
        json!({ "id": "mid", "prerequisites": [["root"]], "position": { "mode": "relative", "x": 2, "y": 1, "relativeTo": "root" } }),
        json!({ "id": "low", "prerequisites": [["mid"]], "position": { "mode": "relative", "x": 0, "y": 1, "relativeTo": "mid" } }),
        focus("new", &["low"]),
    ]);
    let response = run(&request);
    assert_invariants(&request, &response);
    let p = positions(&response);
    assert_eq!((p["mid"], p["low"], p["new"]), ((6, 2), (6, 3), (6, 4)));
    let low = response.source.iter().find(|s| s.id == "low").unwrap();
    assert_eq!((low.relative_to.as_deref(), low.x, low.y), (Some("mid"), 0, 1));
}

#[test]
fn preferred_rows_push_a_focus_down() {
    let p = at(&layout_request(vec![focus("a", &[]), json!({ "id": "b", "prerequisites": [["a"]], "position": { "mode": "auto", "preferredY": 3 } })]));
    assert_eq!(p["b"], (0, 3));
}

#[test]
fn a_fixed_child_above_an_auto_parent_blocks() {
    let request = layout_request(vec![
        json!({ "id": "top", "position": { "mode": "fixed", "x": 0, "y": 2 } }),
        focus("mid", &["top"]),
        json!({ "id": "low", "prerequisites": [["mid"]], "position": { "mode": "fixed", "x": 0, "y": 3 } }),
    ]);
    let response = run(&request);
    assert_eq!(response.status, Status::Blocked);
    assert_eq!(response.diagnostics[0].code, "FOCUS_ENGINE_PARENT_NOT_ABOVE");
    assert_eq!(response.diagnostics[0].focus_ids, vec!["low", "mid"]);
    assert!(response.nodes.is_empty() && response.hashes.layout.is_none());
}

#[test]
fn invalid_requests_are_refused_with_a_code() {
    let cases = [
        (json!({ "schema": "nope", "operation": "layout", "focuses": [] }), "FOCUS_ENGINE_SCHEMA_UNSUPPORTED"),
        (layout_request(vec![focus("a", &[]), focus("a", &[])]), "FOCUS_ENGINE_DUPLICATE_FOCUS"),
        (layout_request(vec![focus("a", &["b"]), focus("b", &["a"])]), "FOCUS_ENGINE_PREREQUISITE_CYCLE"),
        (layout_request(vec![json!({ "id": "a", "position": { "mode": "relative", "x": 0, "y": 0, "relativeTo": "zz" } })]), "FOCUS_ENGINE_UNKNOWN_ANCHOR"),
        (
            layout_request(vec![
                json!({ "id": "a", "position": { "mode": "relative", "x": 0, "y": 1, "relativeTo": "b" } }),
                json!({ "id": "b", "position": { "mode": "relative", "x": 0, "y": 1, "relativeTo": "a" } }),
            ]),
            "FOCUS_ENGINE_RELATIVE_CYCLE",
        ),
        (layout_request(vec![json!({ "id": "a", "pinned": true })]), "FOCUS_ENGINE_PINNED_AUTO"),
        (json!({ "schema": "hoi4-focus-layout-request/1", "operation": "layout", "focuses": [], "extra": 1 }), "FOCUS_ENGINE_REQUEST_INVALID"),
        (
            json!({ "schema": "hoi4-focus-layout-request/1", "operation": "layout", "options": { "nodeSpacing": 0 }, "focuses": [] }),
            "FOCUS_ENGINE_OPTION_INVALID",
        ),
        (json!({ "schema": "hoi4-focus-layout-request/1", "operation": "insert", "focuses": [] }), "FOCUS_ENGINE_INSERT_INVALID"),
    ];
    for (request, code) in cases {
        let error = hoi4_focus_layout::respond(&request.to_string()).expect_err(code);
        assert_eq!(error.code, code, "{}", error.message);
    }
}

#[test]
fn unknown_prerequisites_are_warned_and_ignored() {
    let response = run(&layout_request(vec![focus("a", &["elsewhere"])]));
    assert_eq!(response.status, Status::Ok);
    assert_eq!(response.diagnostics[0].code, "FOCUS_ENGINE_PREREQUISITE_OUTSIDE_REQUEST");
    assert_eq!(positions(&response)["a"], (0, 0));
}

//! The insert operation: existing focuses keep their coordinates; the new branch finds a corridor.

mod common;

use common::{assert_invariants, positions, run};
use hoi4_focus_layout::model::{Direction, Status};
use serde_json::{Value, json};

fn fixed(id: &str, x: i64, y: i64, parents: &[&str]) -> Value {
    let mut f = json!({ "id": id, "position": { "mode": "fixed", "x": x, "y": y } });
    if !parents.is_empty() {
        f["prerequisites"] = json!(parents.iter().map(|p| vec![*p]).collect::<Vec<_>>());
    }
    f
}

fn insert_request(focuses: Vec<Value>, ids: &[&str], extra: Value) -> Value {
    let mut insert = json!({ "focusIds": ids });
    if let Value::Object(map) = extra {
        for (k, v) in map {
            insert[k] = v;
        }
    }
    json!({ "schema": "hoi4-focus-layout-request/1", "operation": "insert", "focuses": focuses, "insert": insert })
}

fn existing_tree() -> Vec<Value> {
    vec![fixed("R", 0, 0, &[]), fixed("A", -4, 1, &["R"]), fixed("B", 4, 1, &["R"]), fixed("A1", -4, 2, &["A"]), fixed("B1", 4, 2, &["B"])]
}

/// The untouched hash of a tree that only has fixed focuses: nothing moves, so it covers all.
fn untouched_of(focuses: Vec<Value>) -> String {
    let response = run(&json!({ "schema": "hoi4-focus-layout-request/1", "operation": "layout", "focuses": focuses }));
    response.hashes.untouched
}

#[test]
fn a_branch_goes_into_the_free_corridor_and_nothing_else_moves() {
    let mut focuses = existing_tree();
    focuses.push(json!({ "id": "N1", "prerequisites": [["R"]] }));
    focuses.push(json!({ "id": "N2", "prerequisites": [["N1"]] }));
    let request = insert_request(focuses, &["N1", "N2"], json!({}));
    let response = run(&request);
    assert_invariants(&request, &response);
    let p = positions(&response);
    assert_eq!((p["N1"], p["N2"]), ((0, 1), (0, 2)));
    assert_eq!(response.metrics.unwrap().orthogonal_crossings, 0);
    assert_eq!(response.hashes.untouched, untouched_of(existing_tree()));
    for id in ["R", "A", "B", "A1", "B1"] {
        assert!(!response.nodes.iter().find(|n| n.id == id).unwrap().moved);
    }
    let n1 = response.source.iter().find(|s| s.id == "N1").unwrap();
    assert_eq!((n1.relative_to.as_deref(), n1.x, n1.y), (Some("R"), 0, 1));
    let n2 = response.source.iter().find(|s| s.id == "N2").unwrap();
    assert_eq!((n2.relative_to.as_deref(), n2.x, n2.y), (Some("N1"), 0, 1));
}

#[test]
fn the_cheaper_side_wins_over_a_crossing() {
    // E's long link drops down column -2 past R's row, so the bar under R to a new child on the
    // left would cross it.
    let focuses = vec![
        fixed("E", -2, 0, &[]),
        fixed("R", 0, 1, &[]),
        fixed("A", -1, 2, &["R"]),
        fixed("B", 1, 2, &["R"]),
        fixed("F", -2, 3, &["E"]),
        json!({ "id": "N", "prerequisites": [["R"]] }),
    ];
    let request = insert_request(focuses, &["N"], json!({ "preferSide": "either" }));
    let response = run(&request);
    assert_invariants(&request, &response);
    assert_eq!(positions(&response)["N"], (3, 2));
    assert_eq!(response.metrics.unwrap().orthogonal_crossings, 0);
}

#[test]
fn prefer_side_breaks_ties() {
    let focuses = vec![fixed("R", 0, 0, &[]), fixed("C", 0, 1, &["R"]), json!({ "id": "N", "prerequisites": [["R"]] })];
    let left = run(&insert_request(focuses.clone(), &["N"], json!({ "preferSide": "left" })));
    let right = run(&insert_request(focuses.clone(), &["N"], json!({ "preferSide": "right" })));
    let either = run(&insert_request(focuses, &["N"], json!({})));
    assert_eq!(positions(&left)["N"], (-2, 1));
    assert_eq!(positions(&right)["N"], (2, 1));
    assert_eq!(positions(&either)["N"], (-2, 1));
}

fn boxed_in() -> Vec<Value> {
    let mut focuses = vec![fixed("R", -1, 0, &[])];
    for i in 0..=140 {
        let x = -140 + 2 * i;
        focuses.push(fixed(&format!("W{i:03}"), x, 1, &[]));
    }
    focuses.push(json!({ "id": "N", "prerequisites": [["R"]] }));
    focuses
}

#[test]
fn a_boxed_in_branch_asks_for_room() {
    let request = insert_request(boxed_in(), &["N"], json!({}));
    let response = run(&request);
    assert_eq!(response.status, Status::Blocked);
    assert!(response.nodes.is_empty() && response.source.is_empty());
    assert!(response.diagnostics.iter().any(|d| d.code == "FOCUS_ENGINE_NO_CORRIDOR"));
    let shift = &response.needs_room.as_ref().unwrap().shift;
    assert_eq!(shift.len(), 1);
    assert_eq!(shift[0].columns, 3);
    assert_eq!(response.hashes.untouched, untouched_of(boxed_in().into_iter().filter(|f| f["id"] != "N").collect()));
}

#[test]
fn allow_shift_applies_exactly_the_proposed_shift() {
    let proposal = run(&insert_request(boxed_in(), &["N"], json!({}))).needs_room.unwrap().shift.remove(0);
    let request = insert_request(boxed_in(), &["N"], json!({ "allowShift": true }));
    let response = run(&request);
    assert_invariants(&request, &response);
    assert_eq!(response.shifted, vec![proposal.clone()]);
    let p = positions(&response);
    let delta = if proposal.direction == Direction::Right { proposal.columns } else { -proposal.columns };
    for f in boxed_in() {
        let id = f["id"].as_str().unwrap();
        if id == "N" {
            continue;
        }
        let (x, y) = (f["position"]["x"].as_i64().unwrap(), f["position"]["y"].as_i64().unwrap());
        let expected = if proposal.focus_ids.iter().any(|m| m == id) { (x + delta, y) } else { (x, y) };
        assert_eq!(p[id], expected, "{id}");
        let node = response.nodes.iter().find(|n| n.id == id).unwrap();
        assert_eq!(node.moved, proposal.focus_ids.iter().any(|m| m == id));
    }
    // Shifted fixed focuses are written with their new coordinates.
    let moved = &proposal.focus_ids[0];
    let s = response.source.iter().find(|s| &s.id == moved).unwrap();
    assert_eq!((s.x, s.y), p[moved]);
}

#[test]
fn insert_refuses_focuses_without_coordinates() {
    let mut focuses = existing_tree();
    focuses.push(json!({ "id": "loose" }));
    focuses.push(json!({ "id": "N", "prerequisites": [["R"]] }));
    let error = hoi4_focus_layout::respond(&insert_request(focuses, &["N"], json!({})).to_string()).unwrap_err();
    assert_eq!(error.code, "FOCUS_ENGINE_INSERT_UNPLACED_FOCUS");

    let mut focuses = existing_tree();
    focuses.push(json!({ "id": "N", "prerequisites": [["R"]] }));
    focuses.push(json!({ "id": "K", "position": { "mode": "relative", "x": 0, "y": 1, "relativeTo": "N" } }));
    let error = hoi4_focus_layout::respond(&insert_request(focuses, &["N"], json!({})).to_string()).unwrap_err();
    assert_eq!(error.code, "FOCUS_ENGINE_INSERT_ANCHOR_INVALID");
}

#[test]
fn an_inserted_parent_above_its_existing_child_is_blocked() {
    let mut focuses = existing_tree();
    // N becomes a prerequisite of A1 (row 2) but is a child of B1 (row 2), so it lands on row 3.
    focuses.push(json!({ "id": "N", "prerequisites": [["B1"]] }));
    focuses[3]["prerequisites"] = json!([["A"], ["N"]]);
    let response = run(&insert_request(focuses, &["N"], json!({})));
    assert_eq!(response.status, Status::Blocked);
    assert_eq!(response.diagnostics[0].code, "FOCUS_ENGINE_PARENT_NOT_ABOVE");
}

#[test]
fn the_anchor_id_is_the_written_root() {
    let mut focuses = existing_tree();
    focuses.push(json!({ "id": "N1", "prerequisites": [["R"]] }));
    focuses.push(json!({ "id": "N2", "prerequisites": [["N1"]] }));
    let response = run(&insert_request(focuses, &["N1", "N2"], json!({ "anchorId": "N2" })));
    // N2 has no parent outside the branch, so it is written fixed and N1 hangs from it.
    let n2 = response.source.iter().find(|s| s.id == "N2").unwrap();
    assert_eq!((n2.relative_to.as_deref(), n2.x, n2.y), (None, 0, 2));
    let n1 = response.source.iter().find(|s| s.id == "N1").unwrap();
    assert_eq!((n1.relative_to.as_deref(), n1.x, n1.y), (Some("N2"), 0, -1));
}

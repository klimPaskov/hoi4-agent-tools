//! Invariants on generated trees, with a seeded xorshift generator (no extra dependencies).

mod common;

use common::{Rng, assert_invariants, layout_request, positions, random_tree, run, stable_json, with_source_positions};
use serde_json::{Value, json};

const SEEDS: u64 = 40;

fn generated(seed: u64) -> Value {
    let mut rng = Rng::new(seed);
    let size = 5 + rng.below(120) as usize;
    let lanes = 1 + rng.below(3) as usize;
    let mut request = layout_request(random_tree(&mut rng, size, lanes));
    if seed % 3 == 0 {
        request["options"] = json!({ "nodeSpacing": 3, "laneSpacing": 1 });
    }
    request
}

#[test]
fn generated_layouts_keep_every_hard_rule() {
    for seed in 1..=SEEDS {
        let request = generated(seed);
        let response = run(&request);
        assert_invariants(&request, &response);
        assert!(response.nodes.iter().all(|n| n.moved));
    }
}

#[test]
fn focus_order_does_not_change_the_response() {
    for seed in 1..=SEEDS {
        let request = generated(seed);
        let expected = stable_json(&run(&request));
        let mut shuffled = request.clone();
        let mut rng = Rng::new(seed + 1000);
        rng.shuffle(shuffled["focuses"].as_array_mut().unwrap());
        assert_eq!(stable_json(&run(&shuffled)), expected, "seed {seed}");
    }
}

#[test]
fn writing_the_source_back_keeps_every_position() {
    for seed in 1..=SEEDS {
        let request = generated(seed);
        let first = run(&request);
        let again = with_source_positions(&request, &first);
        let second = run(&again);
        assert_invariants(&again, &second);
        assert_eq!(second.hashes.layout, first.hashes.layout, "seed {seed}");
        assert_eq!(second.hashes.prerequisites, first.hashes.prerequisites);
        assert_eq!(second.hashes.exclusions, first.hashes.exclusions);
        assert!(second.nodes.iter().all(|n| !n.moved));
        // Nothing moved, so every focus is untouched and the untouched hash covers the layout.
        assert_eq!(second.metrics.unwrap().orthogonal_crossings, first.metrics.unwrap().orthogonal_crossings);
    }
}

#[test]
fn laying_out_the_last_lane_again_gives_the_same_positions() {
    for seed in 1..=SEEDS {
        let request = generated(seed);
        let first = run(&request);
        let last_lane = first.nodes.iter().map(|n| n.lane_id.clone()).max().unwrap();
        let mut again = with_source_positions(&request, &first);
        for f in again["focuses"].as_array_mut().unwrap() {
            let lane = f["laneId"].as_str().unwrap_or("default").to_string();
            if lane == last_lane {
                f["position"] = json!({ "mode": "auto" });
            }
        }
        // Keep the others' sources valid: a kept focus must not be relative to a re-placed one.
        let second = run(&again);
        assert_invariants(&again, &second);
        if first.nodes.iter().all(|n| n.lane_id == last_lane) {
            // A single lane is centred again, which reproduces the first layout exactly.
            assert_eq!(second.hashes.layout, first.hashes.layout, "seed {seed}");
        } else {
            assert_eq!(positions(&second), positions(&first), "seed {seed}");
        }
    }
}

#[test]
fn translating_the_fixed_roots_translates_the_layout() {
    for seed in 1..=SEEDS {
        let request = generated(seed);
        let first = run(&request);
        let p = positions(&first);
        let fix = |dx: i64, dy: i64| -> Value {
            let mut r = request.clone();
            for f in r["focuses"].as_array_mut().unwrap() {
                if f.get("prerequisites").is_none() {
                    let (x, y) = p[f["id"].as_str().unwrap()];
                    f["position"] = json!({ "mode": "fixed", "x": x + dx, "y": y + dy });
                }
            }
            r
        };
        let base = run(&fix(0, 0));
        let moved = run(&fix(7, 3));
        assert_invariants(&fix(7, 3), &moved);
        let a = positions(&base);
        let b = positions(&moved);
        for (id, (x, y)) in &a {
            assert_eq!(b[id], (x + 7, y + 3), "seed {seed} focus {id}");
        }
    }
}

#[test]
fn relation_hashes_ignore_declaration_order() {
    let a = run(&layout_request(vec![
        json!({ "id": "r" }),
        json!({ "id": "s" }),
        json!({ "id": "x", "prerequisites": [["s", "r"], ["r"]], "mutuallyExclusive": ["y"] }),
        json!({ "id": "y", "prerequisites": [["r"]], "mutuallyExclusive": ["x"] }),
    ]));
    let b = run(&layout_request(vec![
        json!({ "id": "y", "prerequisites": [["r"]] }),
        json!({ "id": "x", "prerequisites": [["r"], ["r", "s"]], "mutuallyExclusive": ["y"] }),
        json!({ "id": "s" }),
        json!({ "id": "r" }),
    ]));
    assert_eq!(a.hashes.prerequisites, b.hashes.prerequisites);
    assert_eq!(a.hashes.exclusions, b.hashes.exclusions);
}

#[test]
fn single_parent_forests_have_no_crossings_and_no_stems_through_plaques() {
    for seed in 1..=SEEDS {
        let mut rng = Rng::new(seed);
        let size = 30 + rng.below(200) as usize;
        let mut focuses = Vec::new();
        for i in 0..size {
            if i == 0 || rng.below(15) == 0 {
                focuses.push(json!({ "id": format!("F{i:04}") }));
                continue;
            }
            let p = i - 1 - rng.below(i.min(6) as u64) as usize;
            focuses.push(json!({ "id": format!("F{i:04}"), "prerequisites": [[format!("F{p:04}")]] }));
        }
        let request = layout_request(focuses);
        let response = run(&request);
        assert_invariants(&request, &response);
        let m = response.metrics.unwrap();
        assert_eq!((m.orthogonal_crossings, m.stems_through_plaques), (0, 0), "seed {seed}");
    }
}

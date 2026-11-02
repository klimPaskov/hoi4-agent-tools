//! The shared connector-model vector `tests/fixtures/connector-parity.json`, also checked by the
//! TypeScript model (`tests/unit/focus-connector-parity.test.ts` of hoi4-agent-tools), so both give
//! the same crossing, stem-through-plaque and merged-bar counts.

use std::fs;
use std::path::Path;

use hoi4_focus_layout::geometry::{self, Bundles, Measurement};
use serde_json::Value;

fn counts(value: &Value) -> Measurement {
    let field = |name: &str| value[name].as_u64().unwrap_or_else(|| panic!("{name} missing")) as usize;
    Measurement { crossings: field("crossings"), stems_through_plaques: field("stemsThroughPlaques"), merged_bars: field("mergedBars") }
}

#[test]
fn the_shared_vector_gives_the_hand_counted_defects() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/connector-parity.json");
    let vector: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let cases = vector["cases"].as_array().unwrap();
    assert!(cases.len() >= 5, "too few parity cases in {}", path.display());
    let mut differing_from_old = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let focuses = case["focuses"].as_array().unwrap();
        // Indices in id order, as the engine numbers focuses.
        let mut ids: Vec<&str> = focuses.iter().map(|f| f["id"].as_str().unwrap()).collect();
        ids.sort_unstable();
        let index = |id: &str| ids.binary_search(&id).unwrap_or_else(|_| panic!("{name}: unknown focus {id}"));
        let mut position = vec![None; ids.len()];
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); ids.len()];
        let mut edges = Vec::new();
        for focus in focuses {
            let child = index(focus["id"].as_str().unwrap());
            position[child] = Some((focus["x"].as_i64().unwrap(), focus["y"].as_i64().unwrap()));
            for block in focus["needs"].as_array().map_or(&[][..], Vec::as_slice) {
                let parents: Vec<&str> = match block {
                    Value::String(id) => vec![id.as_str()],
                    Value::Array(group) => group.iter().map(|id| id.as_str().unwrap()).collect(),
                    other => panic!("{name}: bad prerequisite {other}"),
                };
                for parent in parents {
                    let parent = index(parent);
                    edges.push((parent, child));
                    children[parent].push(child);
                }
            }
        }
        for list in &mut children {
            list.sort_unstable();
            list.dedup();
        }
        let connectors = geometry::connectors(&edges, &position);
        let measured = geometry::measure(&position, &connectors, &Bundles::new(&children), None);
        assert_eq!(measured, counts(&case["expected"]), "{name}");
        if counts(&case["old"]) != measured {
            differing_from_old += 1;
        }
    }
    assert!(differing_from_old >= 3, "the vector must keep cases where the earlier model counted differently");
}

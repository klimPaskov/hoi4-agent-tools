#![allow(dead_code)]

use std::collections::BTreeMap;

use hoi4_focus_layout::model::{Response, Status};
use serde_json::{Value, json};

pub fn run(request: &Value) -> Response {
    hoi4_focus_layout::respond(&request.to_string()).unwrap_or_else(|e| panic!("invalid request {}: {}", e.code, e.message))
}

pub fn positions(response: &Response) -> BTreeMap<String, (i64, i64)> {
    response.nodes.iter().map(|n| (n.id.clone(), (n.x, n.y))).collect()
}

pub fn focus(id: &str, parents: &[&str]) -> Value {
    if parents.is_empty() { json!({ "id": id }) } else { json!({ "id": id, "prerequisites": parents.iter().map(|p| vec![*p]).collect::<Vec<_>>() }) }
}

pub fn layout_request(focuses: Vec<Value>) -> Value {
    json!({ "schema": "hoi4-focus-layout-request/1", "operation": "layout", "focuses": focuses })
}

/// A tiny xorshift generator, so generated trees are the same everywhere.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }
}

/// A random forest of `size` focuses: mostly single-parent branches, some convergence focuses,
/// OR groups, exclusive siblings and a few lanes.
pub fn random_tree(rng: &mut Rng, size: usize, lanes: usize) -> Vec<Value> {
    let mut out = Vec::with_capacity(size);
    for i in 0..size {
        let id = format!("F{i:05}");
        let mut f = json!({ "id": id, "laneId": format!("lane{}", (i * lanes) / size.max(1)) });
        if i > 0 && rng.below(12) != 0 {
            let lane_start = ((i * lanes) / size.max(1)) * size / lanes.max(1);
            let lo = lane_start.min(i - 1);
            let p = lo + rng.below((i - lo) as u64) as usize;
            let mut groups = vec![vec![format!("F{p:05}")]];
            if rng.below(8) == 0 && i > 1 {
                let q = rng.below(i as u64) as usize;
                if q != p {
                    if rng.below(2) == 0 {
                        groups.push(vec![format!("F{q:05}")]);
                    } else {
                        groups[0].push(format!("F{q:05}"));
                    }
                }
            }
            f["prerequisites"] = json!(groups);
            if rng.below(10) == 0 && i + 1 < size {
                f["mutuallyExclusive"] = json!([format!("F{:05}", i + 1)]);
            }
        }
        out.push(f);
    }
    out
}

/// Every hard rule: unique cells, spacing in rows, children below every parent.
pub fn assert_invariants(request: &Value, response: &Response) {
    assert_eq!(response.status, Status::Ok, "diagnostics: {:?}", response.diagnostics);
    let spacing = request["options"]["nodeSpacing"].as_i64().unwrap_or(2);
    let pos = positions(response);
    let mut rows: BTreeMap<i64, Vec<(i64, &str)>> = BTreeMap::new();
    for (id, &(x, y)) in &pos {
        rows.entry(y).or_default().push((x, id));
    }
    for (y, row) in rows.iter_mut() {
        row.sort();
        for w in row.windows(2) {
            assert!(w[1].0 - w[0].0 >= spacing, "row {y}: {} at {} and {} at {} are closer than {spacing}", w[0].1, w[0].0, w[1].1, w[1].0);
        }
    }
    for f in request["focuses"].as_array().unwrap() {
        let id = f["id"].as_str().unwrap();
        for group in f["prerequisites"].as_array().into_iter().flatten() {
            for p in group.as_array().unwrap() {
                let p = p.as_str().unwrap();
                if let Some(pp) = pos.get(p) {
                    assert!(pp.1 < pos[id].1, "{p} at row {} is not above {id} at row {}", pp.1, pos[id].1);
                }
            }
        }
    }
}

/// The response with `durationMicros` zeroed, as pretty JSON.
pub fn stable_json(response: &Response) -> String {
    let mut r = response.clone();
    if let Some(m) = r.metrics.as_mut() {
        m.duration_micros = 0;
    }
    hoi4_focus_layout::to_json(&r)
}

/// Turns the response `source` into fixed and relative positions of the request's focuses.
pub fn with_source_positions(request: &Value, response: &Response) -> Value {
    let mut request = request.clone();
    let source: BTreeMap<&str, &hoi4_focus_layout::model::SourceOut> = response.source.iter().map(|s| (s.id.as_str(), s)).collect();
    for f in request["focuses"].as_array_mut().unwrap() {
        let s = source[f["id"].as_str().unwrap()];
        f["position"] = match &s.relative_to {
            Some(r) => json!({ "mode": "relative", "x": s.x, "y": s.y, "relativeTo": r }),
            None => json!({ "mode": "fixed", "x": s.x, "y": s.y }),
        };
    }
    request
}

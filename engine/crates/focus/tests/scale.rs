//! Size and timing checks without a benchmark framework. Run the ignored ones in release:
//! `cargo test --release -p hoi4-focus-layout --test scale -- --ignored --nocapture`.

mod common;

use std::time::Instant;

use common::{Rng, assert_invariants, layout_request, random_tree, run};
use serde_json::Value;

fn timed(size: usize, lanes: usize) -> (Value, hoi4_focus_layout::Response, u128) {
    let mut rng = Rng::new(size as u64);
    let request = layout_request(random_tree(&mut rng, size, lanes));
    let started = Instant::now();
    let response = run(&request);
    let micros = started.elapsed().as_micros();
    eprintln!(
        "{size} focuses, {lanes} lanes: {micros} us ({} columns, {} rows, {} crossings, {} stems through plaques, {} merged bars)",
        response.metrics.unwrap().columns,
        response.metrics.unwrap().rows,
        response.metrics.unwrap().orthogonal_crossings,
        response.metrics.unwrap().stems_through_plaques,
        response.metrics.unwrap().merged_bars
    );
    (request, response, micros)
}

#[test]
fn a_thousand_focuses_lay_out() {
    let (request, response, micros) = timed(1_000, 6);
    assert_invariants(&request, &response);
    // Debug builds are far slower than release; this only catches a runaway algorithm.
    assert!(micros < 60_000_000, "{micros} us");
}

#[test]
#[ignore = "release-scale: run with --release -- --ignored"]
fn ten_thousand_focuses_lay_out() {
    let (request, response, _) = timed(10_000, 20);
    assert_invariants(&request, &response);
}

#[test]
#[ignore = "release-scale: run with --release -- --ignored"]
fn a_thousand_focuses_take_well_under_a_second_in_release() {
    let (_, _, micros) = timed(1_000, 6);
    if !cfg!(debug_assertions) {
        assert!(micros < 1_000_000, "{micros} us");
    }
}

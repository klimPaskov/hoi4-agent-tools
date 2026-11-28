//! Event analyzer and the event graph (packet P6).
//!
//! Ported from `src/hoi4_agent_tools/event/`; each adapted file names its source in its header
//! and in this crate's `PROVENANCE.md`. Only this crate's packet edits files under
//! `crates/event/`.
//!
//! - [`graph`]: the event graph snapshot in its wire shape.
//! - [`source_analysis`]: one fragment of nodes, edges, state accesses and findings per source file.
//! - [`graph_build`]: merges the fragments into the semantic graph, projects helpers and derives
//!   state links and findings.
//! - [`queries`], [`summary`] and [`inspect`]: node selection, roots, trace, route explanation, state
//!   flow, findings and impact over a built graph, with their inline summaries and reports.
//! - [`algorithms`]: traces, shortest paths, strongly connected components and reachability.
//! - [`ops`]: the engine operations over a graph snapshot sent in the request body.

pub mod algorithms;
pub mod graph;
pub mod graph_build;
pub mod inspect;
pub mod native_effects;
pub mod ops;
pub mod queries;
pub mod source_analysis;
pub mod state_keys;
pub mod summary;

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    ops::register(registry);
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod graph_build_tests;

#[cfg(test)]
mod inspect_tests;

#[cfg(test)]
mod ported_tests;

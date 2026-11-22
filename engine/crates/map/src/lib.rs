//! Map model, validation, stated baseline, operations, writer and render (packets P13a, P13b, P13c).
//!
//! Ported from `src/hoi4_agent_tools/map/`; each adapted file names its source in its header and
//! in this crate's `PROVENANCE.md`. Module ownership (ADR 0091 packet plan):
//!
//! - P13a: [`model`], [`parse`], [`validate`], [`baseline`] and this file.
//! - P13b: [`ops`] and [`write`].
//! - P13c: [`render`] and [`quality`].

use hoi4_core::ops::Registry;

pub mod baseline;
pub mod model;
pub mod ops;
pub mod parse;
pub mod quality;
pub mod render;
pub mod validate;
pub mod write;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    let _ = registry;
}

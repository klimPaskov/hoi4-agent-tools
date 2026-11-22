//! Script writers: idea, character, event, decision, technology, doctrine and localisation (packet P10).
//!
//! Ported from `src/hoi4_agent_tools/ideas/, characters/, localisation/` and the `*-write` modules
//! of event, decision, technology and doctrine; each adapted file names its source in its header
//! and in this crate's `PROVENANCE.md`. A writer never touches the disk: it reads the source bytes
//! it is given and returns the edit and the bytes of the file after it. The caller turns that into
//! a `hoi4_core::plan::RewritePlan` for the one applier.

pub mod character;
pub mod decision;
pub mod doctrine;
pub mod event;
pub mod idea;
pub mod ops;
pub mod source;
pub mod tech;

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    ops::register(registry);
}

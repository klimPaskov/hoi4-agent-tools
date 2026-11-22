//! Script writers: idea, character, event, decision, technology, doctrine and localisation (packet P10).
//!
//! Skeleton crate of the parallel port (ADR 0091). It will be ported from
//! `src/hoi4_agent_tools/ideas/, characters/, localisation/, the *-write modules`; each adapted file names its source in its header and in this
//! crate's `PROVENANCE.md`. Only this crate's packet edits files under `crates/script-write/`.

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    let _ = registry;
}

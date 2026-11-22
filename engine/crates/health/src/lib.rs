//! mod_health, error_log and script_guard (packet P9).
//!
//! Skeleton crate of the parallel port (ADR 0091). It will be ported from
//! `src/hoi4_agent_tools/the mod_health, error_log and script_guard modules, core/engine-check.ts`; each adapted file names its source in its header and in this
//! crate's `PROVENANCE.md`. Only this crate's packet edits files under `crates/health/`.

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    let _ = registry;
}

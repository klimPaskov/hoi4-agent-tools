//! Content-addressed artifacts, diffs, image diff and managed outputs (packet P3).
//!
//! Skeleton crate of the parallel port (ADR 0091). It will be ported from
//! `src/hoi4_agent_tools/core/artifacts.ts, artifact-resource.ts, diff.ts, image-diff.ts, managed-outputs.ts, temporary-directories.ts, changed-summary.ts`; each adapted file names its source in its header and in this
//! crate's `PROVENANCE.md`. Only this crate's packet edits files under `crates/artifact-store/`.

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    let _ = registry;
}

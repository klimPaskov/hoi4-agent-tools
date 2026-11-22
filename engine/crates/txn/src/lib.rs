//! Atomic rewrite engine and journal: applies a `RewritePlan` with stale-source checks and
//! recovery (packet P2, ADR 0091).
//!
//! Ported from `src/hoi4_agent_tools/core/transactions.ts`, `transaction-limits.ts` and the
//! write-path rules of `workspace.ts`, commit `9b7dc80d`; each file names its sources in its
//! header and in this crate's `PROVENANCE.md`.
//!
//! [`TxnApplier`] implements [`hoi4_core::plan::PlanApplier`] for real writes:
//! - every path is checked as a portable workspace-relative path, resolved through its links
//!   and kept inside the mod root and outside generated storage;
//! - duplicates and aliases of one file are refused;
//! - under the workspace lock (shared with the TypeScript server), interrupted rewrites are
//!   restored first, then each source is checked against the hash the writer read;
//! - the before bytes are journaled, the new bytes staged beside their targets, and each target
//!   replaced by rename with a write-ahead intent per batch;
//! - the result is verified, and any failure restores every file to its before bytes without
//!   overwriting bytes the rewrite did not produce.
//!
//! Agents never see a transaction id or a separate apply step: one call writes or refuses.

mod applier;
mod fsutil;
mod journal;
pub mod limits;
mod lock;
mod ops;
pub mod paths;

#[cfg(test)]
mod tests;

pub use applier::TxnApplier;
pub use paths::Workspace;

use hoi4_core::ops::Registry;

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through:
/// `txn.apply` and `txn.recover`.
pub fn register(registry: &mut Registry) {
    ops::register(registry);
}

//! Content-addressed artifacts, diffs, image diff and managed outputs (packet P3).
//!
//! Ported from `src/hoi4_agent_tools/core/artifacts.ts`, `diff.ts`, `image-diff.ts`,
//! `managed-outputs.ts`, `temporary-directories.ts` and `changed-summary.ts` (ADR 0089, ADR 0091).
//! Each adapted file names its source in its header and in this crate's `PROVENANCE.md`.
//!
//! - [`store`]: the content-addressed artifact store, its manifests, URIs, limits and pruning.
//! - [`diff`]: unified text diffs and binary diffs, byte-equal to the TypeScript ones.
//! - [`image`]: offline PNG comparison and the transparent review baseline.
//! - [`managed`]: managed output inventories (plan and refresh), with data-driven path rules.
//! - [`changed`]: the bounded summary of a rewrite's changed files.
//! - [`temp`]: owner records and the startup sweep of scratch directories.
//! - [`ops`]: the `artifacts.*` and `diff.*` engine operations.

pub mod changed;
pub mod diff;
pub mod error;
pub mod image;
pub mod managed;
pub mod ops;
pub mod store;
pub mod temp;

pub use ops::register;

//! Core contracts of the all-Rust server (ADR 0089, step 2; ADR 0091).
//!
//! Every packet of the parallel port builds against the types here, so this crate changes only
//! through the integrator. Packets add their code in their own crates and register their engine
//! operations through [`ops::Registry`].
//!
//! - [`ops`]: the operation registry `hoi4-engine serve` dispatches through.
//! - [`diagnostics`]: the diagnostic every tool reports, in the TypeScript wire shape.
//! - [`canonical`]: canonical JSON and SHA-256, byte-equal to the TypeScript `canonicalJson`.
//! - [`files`]: a scanned source file.
//! - [`plan`]: the rewrite plan writers produce and the applier that writes it.
//! - [`testing`]: an in-memory applier for writer tests until the atomic rewrite engine lands.

pub mod canonical;
pub mod diagnostics;
pub mod files;
pub mod ops;
pub mod plan;
pub mod testing;

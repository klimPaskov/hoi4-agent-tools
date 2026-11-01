//! Shared Hearts of Iron IV engine: workspace layers and load order, a symbol index, reference
//! closure with resolved, unresolved and unknown results, lints with vocabulary generated from the
//! game's documentation, an override audit, a findings baseline and finding deltas.
//!
//! HOI4 Factory links this crate, hoi4-agent-tools calls it behind its MCP tools, and the kit and
//! Chaos Redux call the `hoi4-engine` command-line interface.

pub mod analysis;
pub mod baseline;
pub mod context;
pub mod defs;
pub mod delta;
pub mod findings;
pub mod index;
pub mod lints;
pub mod overrides;
pub mod repair;
pub mod report;
pub mod roundtrip;
pub mod vocab;
pub mod workspace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use analysis::Analysis;
pub use findings::{Finding, Severity};
pub use vocab::Vocabulary;
pub use workspace::{Workspace, WorkspaceOptions};

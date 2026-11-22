//! The rewrite plan writers produce, and the applier that writes it (ADR 0091).
//!
//! New in the parallel port; the shape follows the file changes of a TypeScript transaction
//! manifest (`src/hoi4_agent_tools/core/transactions.ts`, commit `ef3d2215`). A writer never
//! touches the disk. It returns a [`RewritePlan`]: every file it changes, the hash of the source it
//! read, and the bytes it wants. One [`PlanApplier`] (the atomic rewrite engine of `hoi4-txn`)
//! checks and writes a plan as one unit, with stale-source checks, the journal and recovery inside.
//! Nothing of that is exposed to agents: a tool call either writes the whole plan or refuses it.

use serde::{Deserialize, Serialize};

use crate::diagnostics::Diagnostic;

/// One file a plan changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Workspace-relative path with forward slashes, inside the workspace's own (writable) root.
    pub path: String,
    /// SHA-256 of the bytes the writer read, or `None` when the file must not exist yet.
    pub before_sha256: Option<String>,
    /// The new bytes, or `None` to remove the file.
    #[serde(skip)]
    pub after: Option<Vec<u8>>,
}

/// Everything one tool call wants to write, judged and written as one unit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewritePlan {
    pub workspace_id: String,
    /// The tool's operation kind, such as `focus-plan-changes`.
    pub operation_kind: String,
    pub changes: Vec<FileChange>,
    /// What the writer found; an error or blocker here stops the write.
    pub diagnostics: Vec<Diagnostic>,
}

/// A plan that was written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// The changed paths in sorted order.
    pub changed_paths: Vec<String>,
}

/// A plan that was not written. Nothing on disk changed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Refusal {
    /// A stable code in the TypeScript vocabulary, such as `TRANSACTION_STALE`.
    pub code: String,
    pub message: String,
    pub diagnostics: Vec<Diagnostic>,
}

impl Refusal {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), diagnostics: Vec::new() }
    }
}

/// Writes a plan as one unit or refuses it. Implemented by `hoi4-txn`; tests use
/// [`crate::testing::MemoryApplier`].
pub trait PlanApplier: Send + Sync {
    fn apply(&self, plan: &RewritePlan) -> Result<Applied, Refusal>;
}

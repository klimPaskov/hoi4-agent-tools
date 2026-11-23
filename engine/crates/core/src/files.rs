//! A scanned source file.
//!
//! Ported from `src/hoi4_agent_tools/core/scanner.ts` (`ScannedFile`) and
//! `src/hoi4_agent_tools/core/workspace.ts` (`RootKind`), commit `ef3d2215`. The scanner itself
//! moves with the core services (packet P1); this type is what analyzers and writers receive.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootKind {
    Mod,
    Game,
    Dlc,
    Dependency,
    Artifact,
    Cache,
    Fixture,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Real path on disk, inside a configured root. Never reported to agents.
    pub absolute_path: String,
    /// The path agents see, such as `mod:events/a.txt`.
    pub display_path: String,
    /// Path relative to its root, with forward slashes.
    pub relative_path: String,
    pub root_kind: RootKind,
    /// Position of the root in load order; a later root overrides an earlier one.
    pub load_order: u32,
    pub size: u64,
    pub modified_ms: u64,
    /// Lowercase hex SHA-256 of `bytes`.
    pub sha256: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
    /// Display path of the file that overrides this one, when one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed_by: Option<String>,
}

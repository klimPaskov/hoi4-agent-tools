//! The workspace a rewrite writes in, with its write paths and generated-storage paths checked by
//! the engine's one path resolver (`hoi4_engine::workspace_paths`, ADR 0089 step 2).
//!
//! Adapted from `src/hoi4_agent_tools/core/workspace.ts` (`containedGeneratedPath` and the use of
//! `WorkspaceResolver.resolvePath(..., 'write', ['mod'])` in `transactions.ts`), commit `9b7dc80d`.
//! Every containment rule itself lives in `workspace_paths`; this file only applies it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use hoi4_core::plan::Refusal;
use hoi4_engine::workspace_paths::{self as resolver, Access, PathError, Root};

/// The roots of one writable workspace, all canonical, and the journal binding the server gave.
#[derive(Clone, Debug)]
pub struct Workspace {
    /// The mod folder: every write lands inside it.
    pub mod_root: PathBuf,
    /// Generated storage holding the journal and the lock.
    pub cache_root: PathBuf,
    /// Generated artifact storage, never a write target.
    pub artifact_root: Option<PathBuf>,
}

pub(crate) fn io_refusal(code: &str, message: &str, error: &io::Error) -> Refusal {
    Refusal::new(code, format!("{message}: {}", error.kind()))
}

fn path_refusal(error: PathError) -> Refusal {
    match error {
        PathError::Refused(refusal) => Refusal::new(refusal.code, refusal.message),
        PathError::Io(error) => io_refusal("PATH_UNRESOLVABLE", "Path cannot be resolved", &error),
    }
}

/// The real path of `path`, through its nearest existing ancestor.
pub fn canonical_path(path: &Path) -> Result<PathBuf, Refusal> {
    resolver::canonical_path(path).map_err(path_refusal)
}

pub fn is_within(root: &Path, candidate: &Path) -> bool {
    resolver::is_within(root, candidate)
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    is_within(left, right) && is_within(right, left)
}

/// The comparison key of a path: case-folded on Windows, as the TypeScript alias check does.
pub(crate) fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) { text.to_lowercase() } else { text.into_owned() }
}

impl Workspace {
    /// Opens a workspace. The mod root must be an existing real directory; the cache root is
    /// created when missing.
    pub fn open(mod_root: &Path, cache_root: &Path, artifact_root: Option<&Path>) -> Result<Self, Refusal> {
        let unsafe_root = || Refusal::new("WORKSPACE_MOD_ROOT_UNSAFE", "Configured mod roots must be existing real directories");
        let metadata = fs::symlink_metadata(mod_root).map_err(|_| unsafe_root())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(unsafe_root());
        }
        let mod_root = canonical_path(mod_root).map_err(|_| unsafe_root())?;
        fs::create_dir_all(cache_root).map_err(|error| io_refusal("WORKSPACE_CACHE_UNAVAILABLE", "Workspace cache storage cannot be created", &error))?;
        let cache_root = canonical_path(cache_root)?;
        let artifact_root = artifact_root.map(canonical_path).transpose()?;
        Ok(Self { mod_root, cache_root, artifact_root })
    }

    /// The canonical target of a workspace-relative write path: `resolvePath(..., 'write',
    /// ['mod'])` of the TypeScript server.
    pub fn resolve_write(&self, relative_path: &str) -> Result<PathBuf, Refusal> {
        let roots = [Root { path: self.mod_root.clone(), kind: "mod".into(), load_order: 0, writable: true }];
        let reserved: Vec<PathBuf> = std::iter::once(self.cache_root.clone()).chain(self.artifact_root.clone()).collect();
        match resolver::resolve(&roots, Some(&["mod".to_string()]), &reserved, relative_path, Access::Write) {
            Ok(Some(resolved)) => Ok(resolved.path),
            Ok(None) => Err(Refusal::new("PATH_WRITE_OUTSIDE_ROOTS", "Path cannot be resolved for write access")),
            Err(error) => Err(path_refusal(error)),
        }
    }
}

/// A generated-storage descendant that no existing link moves outside `root`.
pub fn contained_generated_path(root: &Path, segments: &[&str]) -> Result<PathBuf, Refusal> {
    let mut joined = root.to_path_buf();
    for segment in segments {
        joined.push(segment);
    }
    let candidate = canonical_path(&joined)?;
    if !is_within(root, &candidate) {
        return Err(Refusal::new("PATH_GENERATED_ROOT_ESCAPE", "Generated storage path escapes its configured root"));
    }
    Ok(candidate)
}

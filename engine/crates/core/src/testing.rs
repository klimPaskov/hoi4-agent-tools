//! An in-memory [`PlanApplier`] for writer tests (ADR 0091).
//!
//! New in the parallel port; adapted from no TypeScript file. It keeps the rules a writer must
//! not rely on breaking: one change per path, a portable relative path, the source hash the writer
//! read, and all or nothing. It is not the atomic rewrite engine and never touches the disk;
//! `hoi4-txn` replaces it in real writes.

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::canonical::sha256_hex;
use crate::diagnostics::has_blocking;
use crate::plan::{Applied, PlanApplier, Refusal, RewritePlan};

/// Files of one workspace held in memory, by workspace-relative path.
#[derive(Default)]
pub struct MemoryApplier {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
}

impl MemoryApplier {
    pub fn new(files: impl IntoIterator<Item = (String, Vec<u8>)>) -> Self {
        Self { files: Mutex::new(files.into_iter().collect()) }
    }

    /// The current bytes of a file.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap_or_else(|e| e.into_inner()).get(path).cloned()
    }
}

fn relative_path_is_safe(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path.contains('\0')
        && path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

impl PlanApplier for MemoryApplier {
    fn apply(&self, plan: &RewritePlan) -> Result<Applied, Refusal> {
        if has_blocking(&plan.diagnostics) {
            return Err(Refusal {
                code: "TRANSACTION_VALIDATION_BLOCKED".into(),
                message: "The plan has blocking diagnostics".into(),
                diagnostics: plan.diagnostics.clone(),
            });
        }
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        let mut seen = std::collections::BTreeSet::new();
        for change in &plan.changes {
            if !relative_path_is_safe(&change.path) {
                return Err(Refusal::new("WORKSPACE_PATH_INVALID", format!("{} is not a safe relative path", change.path)));
            }
            if !seen.insert(change.path.as_str()) {
                return Err(Refusal::new("TRANSACTION_DUPLICATE_FILE", format!("{} is changed twice", change.path)));
            }
            let current = files.get(&change.path).map(|bytes| sha256_hex(bytes));
            if current != change.before_sha256 {
                return Err(Refusal::new("TRANSACTION_STALE", format!("{} changed since it was read", change.path)));
            }
        }
        for change in &plan.changes {
            match &change.after {
                Some(bytes) => files.insert(change.path.clone(), bytes.clone()),
                None => files.remove(&change.path),
            };
        }
        Ok(Applied { changed_paths: seen.into_iter().map(str::to_owned).collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{Category, Diagnostic, Severity};
    use crate::plan::FileChange;

    fn plan(changes: Vec<FileChange>) -> RewritePlan {
        RewritePlan { workspace_id: "w".into(), operation_kind: "test".into(), changes, diagnostics: Vec::new() }
    }

    fn change(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> FileChange {
        FileChange { path: path.into(), before_sha256: before.map(sha256_hex), after: after.map(<[u8]>::to_vec) }
    }

    #[test]
    fn writes_a_plan_whole() {
        let applier = MemoryApplier::new([("a.txt".to_string(), b"old".to_vec())]);
        let applied = applier.apply(&plan(vec![change("b/new.txt", None, Some(b"new")), change("a.txt", Some(b"old"), None)])).unwrap();
        assert_eq!(applied.changed_paths, vec!["a.txt", "b/new.txt"]);
        assert_eq!(applier.read("b/new.txt").unwrap(), b"new");
        assert!(applier.read("a.txt").is_none());
    }

    #[test]
    fn refuses_a_stale_source_and_changes_nothing() {
        let applier = MemoryApplier::new([("a.txt".to_string(), b"edited".to_vec())]);
        let refusal = applier.apply(&plan(vec![change("c.txt", None, Some(b"c")), change("a.txt", Some(b"old"), Some(b"x"))])).unwrap_err();
        assert_eq!(refusal.code, "TRANSACTION_STALE");
        assert!(applier.read("c.txt").is_none());
        assert_eq!(applier.read("a.txt").unwrap(), b"edited");
        // Creating a file that exists already is stale too.
        let refusal = applier.apply(&plan(vec![change("a.txt", None, Some(b"x"))])).unwrap_err();
        assert_eq!(refusal.code, "TRANSACTION_STALE");
    }

    #[test]
    fn refuses_unsafe_paths_duplicates_and_blocking_diagnostics() {
        let applier = MemoryApplier::default();
        for path in ["../x", "/abs", "a\\b", "c:/x", "a//b", "a/./b", ""] {
            let refusal = applier.apply(&plan(vec![change(path, None, Some(b"x"))])).unwrap_err();
            assert_eq!(refusal.code, "WORKSPACE_PATH_INVALID", "{path}");
        }
        let refusal = applier.apply(&plan(vec![change("a", None, Some(b"1")), change("a", None, Some(b"2"))])).unwrap_err();
        assert_eq!(refusal.code, "TRANSACTION_DUPLICATE_FILE");
        let mut blocked = plan(vec![change("a", None, Some(b"1"))]);
        blocked.diagnostics.push(Diagnostic::new("X", Severity::Error, Category::Validation, "bad"));
        assert_eq!(applier.apply(&blocked).unwrap_err().code, "TRANSACTION_VALIDATION_BLOCKED");
        assert!(applier.read("a").is_none());
    }
}

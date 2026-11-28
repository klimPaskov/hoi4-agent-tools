//! A bounded count of what a rewrite changed.
//!
//! Ported from `src/hoi4_agent_tools/core/changed-summary.ts` (`summarizeChangedFiles`,
//! `folderOf`), commit `9b7dc80d`.

use std::collections::BTreeMap;

use hoi4_core::canonical::compare_code_units;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileIdentity {
    pub relative_path: String,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChangedFolderSummary {
    pub folder: String,
    pub created: u64,
    pub removed: u64,
    pub modified: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFilesSummary {
    pub total: u64,
    pub created: u64,
    pub removed: u64,
    pub modified: u64,
    pub folders: Vec<ChangedFolderSummary>,
    pub omitted_folders: u64,
}

/// The folder a path is counted in: its directory, at most two levels deep (`.` for the root).
fn folder_of(relative_path: &str) -> String {
    let normalized = relative_path.replace('\\', "/");
    let mut parts: Vec<&str> = normalized.split('/').collect();
    parts.pop();
    if parts.is_empty() { ".".into() } else { parts.iter().take(2).copied().collect::<Vec<_>>().join("/") }
}

pub fn summarize_changed_files(files: &[ChangedFileIdentity], limit: usize) -> ChangedFilesSummary {
    let mut by_folder: BTreeMap<String, ChangedFolderSummary> = BTreeMap::new();
    let (mut created, mut removed, mut modified) = (0u64, 0u64, 0u64);
    for file in files {
        let folder = folder_of(&file.relative_path);
        let entry = by_folder.entry(folder.clone()).or_insert(ChangedFolderSummary { folder, created: 0, removed: 0, modified: 0 });
        if file.before_sha256.is_none() {
            created += 1;
            entry.created += 1;
        } else if file.after_sha256.is_none() {
            removed += 1;
            entry.removed += 1;
        } else {
            modified += 1;
            entry.modified += 1;
        }
    }
    let mut ranked: Vec<ChangedFolderSummary> = by_folder.into_values().collect();
    let size = |entry: &ChangedFolderSummary| entry.created + entry.removed + entry.modified;
    ranked.sort_by(|left, right| size(right).cmp(&size(left)).then_with(|| compare_code_units(&left.folder, &right.folder)));
    let omitted = ranked.len().saturating_sub(limit) as u64;
    ranked.truncate(limit);
    ChangedFilesSummary { total: files.len() as u64, created, removed, modified, folders: ranked, omitted_folders: omitted }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, before: Option<&str>, after: Option<&str>) -> ChangedFileIdentity {
        ChangedFileIdentity { relative_path: path.into(), before_sha256: before.map(Into::into), after_sha256: after.map(Into::into) }
    }

    #[test]
    fn counts_kinds_and_ranks_folders() {
        let files = [
            file("map/a.txt", None, Some("x")),
            file("map/b.txt", Some("x"), None),
            file("map/c.txt", Some("x"), Some("y")),
            file("events/e.txt", Some("x"), Some("y")),
            file("root.txt", None, Some("z")),
            file("a\\b\\c\\d.txt", None, Some("z")),
        ];
        let summary = summarize_changed_files(&files, 2);
        assert_eq!((summary.total, summary.created, summary.removed, summary.modified), (6, 3, 1, 2));
        assert_eq!(summary.folders[0].folder, "map");
        assert_eq!(summary.folders[1].folder, ".");
        assert_eq!(summary.omitted_folders, 2);
        assert_eq!(folder_of("a\\b\\c\\d.txt"), "a/b");
    }
}

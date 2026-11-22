//! Workspace-relative write paths and generated-storage paths, checked against canonical roots.
//!
//! Ported from `src/hoi4_agent_tools/core/workspace.ts` (`assertRelative`, `isPortablePathSegment`,
//! `canonicalPath`, `isWithin`, `pathsOverlap`, `containedGeneratedPath` and the write branch of
//! `WorkspaceResolver.resolvePath`), commit `9b7dc80d`. This is the applier's own copy until the
//! workspace-path module moves into `hoi4-core` (packet P1), which replaces it.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use hoi4_core::plan::Refusal;

/// The roots of one writable workspace, all canonical.
#[derive(Clone, Debug)]
pub struct Workspace {
    /// The mod folder: every write lands inside it.
    pub mod_root: PathBuf,
    /// Generated storage holding the journal and the lock.
    pub cache_root: PathBuf,
    /// Generated artifact storage, never a write target.
    pub artifact_root: Option<PathBuf>,
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
        let mod_root = fs::canonicalize(mod_root).map_err(|_| unsafe_root())?;
        fs::create_dir_all(cache_root).map_err(|error| io_refusal("WORKSPACE_CACHE_UNAVAILABLE", "Workspace cache storage cannot be created", &error))?;
        let cache_root =
            fs::canonicalize(cache_root).map_err(|error| io_refusal("WORKSPACE_CACHE_UNAVAILABLE", "Workspace cache storage cannot be resolved", &error))?;
        let artifact_root = artifact_root.map(canonical_path).transpose()?;
        Ok(Self { mod_root, cache_root, artifact_root })
    }

    /// The canonical target of a workspace-relative write path, inside the mod root and outside
    /// generated storage.
    pub fn resolve_write(&self, relative_path: &str) -> Result<PathBuf, Refusal> {
        assert_relative(relative_path)?;
        let segments = segments(relative_path);
        if segments.first().is_some_and(|segment| segment.eq_ignore_ascii_case(".hoi4-agent")) {
            return Err(Refusal::new("PATH_GENERATED_STORAGE_RESERVED", "Generated .hoi4-agent storage cannot be targeted as mod source"));
        }
        let outside = || Refusal::new("PATH_WRITE_OUTSIDE_ROOTS", "Path cannot be resolved for write access");
        let candidate = canonical_path(&join_segments(&self.mod_root, &segments))?;
        if !is_within(&self.mod_root, &candidate) || same_path(&self.mod_root, &candidate) {
            return Err(outside());
        }
        let generated = [Some(&self.cache_root), self.artifact_root.as_ref()];
        if generated.into_iter().flatten().any(|root| paths_overlap(root, &candidate)) {
            return Err(Refusal::new("PATH_GENERATED_STORAGE_RESERVED", "Artifact and cache storage cannot be targeted as mod source"));
        }
        let parent = candidate.parent().ok_or_else(outside)?;
        if !is_within(&self.mod_root, &canonical_path(parent)?) {
            return Err(outside());
        }
        Ok(candidate)
    }

    /// The fingerprint of the mod root a journal is bound to.
    pub fn root_fingerprint(&self) -> String {
        hoi4_core::canonical::sha256_hex(path_key(&self.mod_root).as_bytes())
    }
}

/// The `/`-separated segments of a relative path, without empty and `.` segments.
fn segments(relative_path: &str) -> Vec<String> {
    relative_path.replace('\\', "/").split('/').filter(|segment| !segment.is_empty() && *segment != ".").map(str::to_owned).collect()
}

fn join_segments(root: &Path, segments: &[String]) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
    }
    path
}

pub(crate) fn io_refusal(code: &str, message: &str, error: &io::Error) -> Refusal {
    Refusal::new(code, format!("{message}: {}", error.kind()))
}

fn is_windows_device(segment: &str) -> bool {
    let lower = segment.to_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    if matches!(stem, "con" | "prn" | "aux" | "nul" | "clock$" | "conin$" | "conout$") {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "com" || prefix == "lpt") && rest.len() == 1 && matches!(rest[0], '1'..='9' | '¹' | '²' | '³')
}

/// A path segment every supported file system stores as given.
pub fn is_portable_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.chars().any(|c| (c as u32) <= 0x1f || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        && !is_windows_device(segment)
        && !segment.ends_with(['.', ' '])
}

fn is_absolute_text(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with(['/', '\\']) || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes.get(2).is_none_or(|b| *b == b'/' || *b == b'\\'))
}

/// Refuses a path that is not a portable workspace-relative path.
pub fn assert_relative(relative_path: &str) -> Result<(), Refusal> {
    if relative_path.is_empty() {
        return Err(Refusal::new("PATH_EMPTY", "Workspace-relative path cannot be empty"));
    }
    if relative_path.contains('\0') {
        return Err(Refusal::new("PATH_NUL", "Path contains a NUL byte"));
    }
    if is_absolute_text(relative_path) {
        return Err(Refusal::new("PATH_ABSOLUTE_REJECTED", "Only workspace-relative paths are accepted"));
    }
    let normalized = relative_path.replace('\\', "/");
    let all: Vec<&str> = normalized.split('/').collect();
    if all.contains(&"..") {
        return Err(Refusal::new("PATH_TRAVERSAL", "Parent path segments are not allowed"));
    }
    if all.iter().any(|segment| segment.contains(':')) {
        return Err(Refusal::new("PATH_ALTERNATE_STREAM", "Colon characters and alternate data streams are not allowed"));
    }
    if all.iter().any(|segment| *segment != "." && !segment.is_empty() && !is_portable_segment(segment)) {
        return Err(Refusal::new("PATH_WINDOWS_DEVICE", "Portable paths cannot contain device names, control characters, or ambiguous characters"));
    }
    if segments(relative_path).is_empty() {
        return Err(Refusal::new("PATH_EMPTY", "Workspace-relative path cannot be empty"));
    }
    Ok(())
}

/// The real path of `path`: the longest existing prefix with every link resolved, then the rest.
pub fn canonical_path(path: &Path) -> Result<PathBuf, Refusal> {
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(name) = existing.file_name() else {
                    return Err(Refusal::new("PATH_UNRESOLVABLE", "Path has no existing ancestor"));
                };
                rest.push(name.to_owned());
                if !existing.pop() {
                    return Err(Refusal::new("PATH_UNRESOLVABLE", "Path has no existing ancestor"));
                }
            }
            Err(error) => return Err(io_refusal("PATH_UNRESOLVABLE", "Path cannot be resolved", &error)),
        }
    }
    let mut resolved = fs::canonicalize(&existing).map_err(|error| io_refusal("PATH_UNRESOLVABLE", "Path cannot be resolved", &error))?;
    for name in rest.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// The comparison key of a path: case-folded on Windows, where the file system ignores case.
pub(crate) fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) { text.to_lowercase() } else { text.into_owned() }
}

fn component_keys(path: &Path) -> Vec<String> {
    path.components()
        .filter(|component| !matches!(component, Component::CurDir))
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            if cfg!(windows) { text.to_lowercase() } else { text.into_owned() }
        })
        .collect()
}

/// Whether `candidate` is `root` or lies beneath it.
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let root = component_keys(root);
    let candidate = component_keys(candidate);
    candidate.len() >= root.len() && candidate[..root.len()] == root[..]
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    component_keys(left) == component_keys(right)
}

pub fn paths_overlap(left: &Path, right: &Path) -> bool {
    is_within(left, right) || is_within(right, left)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_that_are_not_portable_and_relative() {
        let cases = [
            ("", "PATH_EMPTY"),
            (".", "PATH_EMPTY"),
            ("a\0b", "PATH_NUL"),
            ("/etc/passwd", "PATH_ABSOLUTE_REJECTED"),
            ("\\x", "PATH_ABSOLUTE_REJECTED"),
            ("C:/x", "PATH_ABSOLUTE_REJECTED"),
            ("common/../../x", "PATH_TRAVERSAL"),
            ("a\\..\\b", "PATH_TRAVERSAL"),
            ("a.txt:stream", "PATH_ALTERNATE_STREAM"),
            ("C:x", "PATH_ALTERNATE_STREAM"),
            ("common/CON.txt", "PATH_WINDOWS_DEVICE"),
            ("lpt1", "PATH_WINDOWS_DEVICE"),
            ("com¹.txt", "PATH_WINDOWS_DEVICE"),
            ("a/b.", "PATH_WINDOWS_DEVICE"),
            ("a/b ", "PATH_WINDOWS_DEVICE"),
            ("a/b?c", "PATH_WINDOWS_DEVICE"),
            ("a/\u{1}", "PATH_WINDOWS_DEVICE"),
        ];
        for (path, code) in cases {
            assert_eq!(assert_relative(path).unwrap_err().code, code, "{path:?}");
        }
        for path in ["common/ideas/a.txt", "history/countries/AUR - Aurelia.txt", "./a/b.txt", "a\\b.txt", "console.txt", "com10.txt"] {
            assert!(assert_relative(path).is_ok(), "{path:?}");
        }
    }

    #[test]
    fn compares_paths_by_whole_components() {
        assert!(is_within(Path::new("/a/b"), Path::new("/a/b/c")));
        assert!(is_within(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_within(Path::new("/a/b"), Path::new("/a/bc")));
        assert!(paths_overlap(Path::new("/a/b/c"), Path::new("/a/b")));
    }
}

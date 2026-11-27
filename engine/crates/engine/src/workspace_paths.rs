//! Canonical-path checks for workspace-relative paths (ADR 0089, step 2, first piece).
//!
//! Ported from `src/hoi4_agent_tools/core/workspace.ts` (`assertRelative`,
//! `isPortablePathSegment`, `canonicalPath`, `isWithin`, `pathsOverlap`,
//! `WorkspaceResolver.resolvePath` and `resolvePathInRoot`), commit `e6689acd`. The refusal codes
//! and messages are the TypeScript ones, because the tools report them to agents unchanged.
//!
//! A relative path is refused before any file is touched when it is empty, holds a NUL byte, is
//! absolute, has a `..` segment, a colon (an alternate data stream or a drive) or a segment that is
//! not portable (a Windows device name, a control character, `<>:"|?*`, or a trailing dot or
//! space). An accepted path is joined to each candidate root and resolved to its real path, through
//! its nearest existing ancestor when it does not exist yet, and the answer is used only when that
//! real path stays inside the root. A symbolic link or junction that leads out of a root is
//! therefore never followed out of it.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};

/// How often [`canonical_path`] walks again after a path vanished during the walk.
const CANONICAL_PATH_ATTEMPTS: usize = 4;

/// A refusal the tools report as is: a stable code and its message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Refusal { code, message: message.into() }
    }
}

/// Why a path could not be resolved: a refusal, or a file system error.
#[derive(Debug)]
pub enum PathError {
    Refused(Refusal),
    Io(io::Error),
}

impl From<io::Error> for PathError {
    fn from(error: io::Error) -> Self {
        PathError::Io(error)
    }
}

impl From<Refusal> for PathError {
    fn from(refusal: Refusal) -> Self {
        PathError::Refused(refusal)
    }
}

const WINDOWS_DEVICES: &[&str] = &["con", "prn", "aux", "nul", "clock$", "conin$", "conout$"];

fn is_windows_device(segment: &str) -> bool {
    // The TypeScript pattern is case-insensitive under Unicode rules, so `K` (U+212A) matches `k`.
    let lower: String = segment.chars().flat_map(char::to_lowercase).collect();
    let stem = lower.split_once('.').map_or(lower.as_str(), |(stem, _)| stem);
    if WINDOWS_DEVICES.contains(&stem) {
        return true;
    }
    for prefix in ["com", "lpt"] {
        if let Some(rest) = stem.strip_prefix(prefix) {
            let mut chars = rest.chars();
            if let (Some(digit), None) = (chars.next(), chars.next())
                && (('1'..='9').contains(&digit) || matches!(digit, '¹' | '²' | '³'))
            {
                return true;
            }
        }
    }
    false
}

/// Whether a path segment is the same file on every platform the game runs on.
pub fn is_portable_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.chars().any(|c| (c as u32) <= 0x1f)
        && !segment.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        && !is_windows_device(segment)
        && !segment.ends_with(['.', ' '])
}

/// Node's `path.isAbsolute` on this platform.
fn is_absolute_spelling(value: &str) -> bool {
    if cfg!(windows) {
        let bytes = value.as_bytes();
        matches!(bytes.first(), Some(b'/' | b'\\'))
            || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
    } else {
        value.starts_with('/')
    }
}

/// Refuse a workspace-relative path that could leave its root or name something unportable.
pub fn check_relative(relative: &str) -> Result<(), Refusal> {
    if relative.is_empty() {
        return Err(Refusal::new("PATH_EMPTY", "Workspace-relative path cannot be empty"));
    }
    if relative.contains('\0') {
        return Err(Refusal::new("PATH_NUL", "Path contains a NUL byte"));
    }
    if is_absolute_spelling(relative) {
        return Err(Refusal::new("PATH_ABSOLUTE_REJECTED", "Only workspace-relative paths are accepted"));
    }
    let normalized = relative.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    if segments.contains(&"..") {
        return Err(Refusal::new("PATH_TRAVERSAL", "Parent path segments are not allowed"));
    }
    if segments.iter().any(|segment| segment.contains(':')) {
        return Err(Refusal::new("PATH_ALTERNATE_STREAM", "Colon characters and alternate data streams are not allowed"));
    }
    if segments.iter().any(|segment| *segment != "." && !segment.is_empty() && !is_portable_segment(segment)) {
        return Err(Refusal::new("PATH_WINDOWS_DEVICE", "Portable paths cannot contain device names, control characters, or ambiguous characters"));
    }
    Ok(())
}

/// The segments Node's `path.join` reads from a relative path: `\` separates only on Windows.
fn relative_segments(relative: &str) -> impl Iterator<Item = &str> {
    relative.split(|c| c == '/' || (cfg!(windows) && c == '\\')).filter(|segment| !segment.is_empty() && *segment != ".")
}

/// `root` joined with the segments of `relative`.
pub fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut joined = root.to_path_buf();
    for segment in relative_segments(relative) {
        joined.push(segment);
    }
    joined
}

/// Whether `value` exists without following a final link, as `lstat` answers.
fn exists(value: &Path) -> bool {
    fs::symlink_metadata(value).is_ok()
}

/// `fs::canonicalize` in the spelling Node's `realpath` gives: no `\\?\` prefix on Windows.
fn real_path(value: &Path) -> io::Result<PathBuf> {
    let real = fs::canonicalize(value)?;
    if cfg!(windows)
        && let Some(text) = real.to_str()
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(real)
}

/// Lexical normalization: `.` dropped and `..` applied, as Node's `path.normalize` does.
fn normalize(value: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in value.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn canonical_path_once(input: &Path) -> Result<PathBuf, PathError> {
    let absolute = if input.is_absolute() { normalize(input) } else { normalize(&std::env::current_dir()?.join(input)) };
    if exists(&absolute) {
        return Ok(normalize(&real_path(&absolute)?));
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = absolute.clone();
    while !exists(&cursor) {
        let Some(parent) = cursor.parent().map(Path::to_path_buf) else {
            return Err(Refusal::new("PATH_NO_EXISTING_ANCESTOR", format!("Path has no existing ancestor: {}", input.display())).into());
        };
        if let Some(name) = cursor.file_name() {
            suffix.push(name.to_os_string());
        }
        cursor = parent;
    }
    let mut canonical = real_path(&cursor)?;
    for name in suffix.iter().rev() {
        canonical.push(name);
    }
    Ok(normalize(&canonical))
}

/// The real path of `input`, or of its nearest existing ancestor followed by the missing segments.
/// A path can vanish between the existence check and the real-path call (another rewrite
/// releasing a lock directory); the walk then starts again. A path that keeps failing (a dangling
/// link) still fails with `NotFound`.
pub fn canonical_path(input: &Path) -> Result<PathBuf, PathError> {
    let mut attempt = 1;
    loop {
        match canonical_path_once(input) {
            Err(PathError::Io(error)) if error.kind() == io::ErrorKind::NotFound && attempt < CANONICAL_PATH_ATTEMPTS => {
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// A path's text as the comparison of Node's `path.relative` sees it: separators unified, no
/// trailing separator, and on Windows lower case, because that comparison ignores case there.
fn comparison_key(value: &Path) -> String {
    let text = value.to_string_lossy();
    let mut key = if cfg!(windows) { text.replace('/', "\\").to_lowercase() } else { text.into_owned() };
    let separator = if cfg!(windows) { '\\' } else { '/' };
    while key.len() > 1 && key.ends_with(separator) && !(cfg!(windows) && key.len() == 3 && key.as_bytes()[1] == b':') {
        key.pop();
    }
    key
}

/// Whether `candidate` is `root` or inside it.
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let (root, candidate) = (comparison_key(root), comparison_key(candidate));
    if candidate == root {
        return true;
    }
    if root.ends_with(separator) {
        return candidate.starts_with(&root);
    }
    candidate.strip_prefix(&root).is_some_and(|rest| rest.starts_with(separator))
}

/// Whether one of the two paths contains the other.
pub fn paths_overlap(left: &Path, right: &Path) -> bool {
    is_within(left, right) || is_within(right, left)
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    Write,
}

/// A source root of a resolved workspace, as the server holds it (already canonical).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub path: PathBuf,
    pub kind: String,
    pub load_order: i64,
    pub writable: bool,
}

/// A path resolved in a root: its real path and the root's position in the request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub root: usize,
}

/// The first non-empty, non-`.` segment of `relative`, in lower case.
fn first_segment(relative: &str) -> Option<String> {
    relative.replace('\\', "/").split('/').find(|segment| !segment.is_empty() && *segment != ".").map(str::to_lowercase)
}

/// `WorkspaceResolver.resolvePath`: the highest-loading root, among `roots` of `root_kinds` (all
/// when `None`) that allow `access`, in which `relative` resolves inside the root. A read needs
/// the path to exist; a write needs its existing parent inside the root. The workspace's artifact
/// and cache storage (`reserved`) are never mod source.
pub fn resolve(roots: &[Root], root_kinds: Option<&[String]>, reserved: &[PathBuf], relative: &str, access: Access) -> Result<Option<Resolved>, PathError> {
    check_relative(relative)?;
    if first_segment(relative).as_deref() == Some(".hoi4-agent") {
        return Err(Refusal::new("PATH_GENERATED_STORAGE_RESERVED", "Generated .hoi4-agent storage cannot be targeted as mod source").into());
    }
    let mut order: Vec<usize> = (0..roots.len())
        .filter(|&index| {
            let root = &roots[index];
            root_kinds.is_none_or(|kinds| kinds.contains(&root.kind)) && (access == Access::Read || root.writable)
        })
        .collect();
    // A stable sort, highest load order first, as the TypeScript `sort` is.
    order.sort_by_key(|&index| std::cmp::Reverse(roots[index].load_order));
    for index in order {
        let root = &roots[index];
        let candidate = canonical_path(&join_relative(&root.path, relative))?;
        if !is_within(&root.path, &candidate) {
            continue;
        }
        if access == Access::Read && !exists(&candidate) {
            continue;
        }
        if root.kind == "mod" && reserved.iter().any(|storage| paths_overlap(storage, &candidate)) {
            return Err(Refusal::new("PATH_GENERATED_STORAGE_RESERVED", "Artifact and cache storage cannot be targeted as mod source").into());
        }
        if access == Access::Write {
            let parent = candidate.parent().map_or_else(|| candidate.clone(), Path::to_path_buf);
            let existing_parent = canonical_path(&parent)?;
            if !is_within(&root.path, &existing_parent) {
                continue;
            }
        }
        return Ok(Some(Resolved { path: candidate, root: index }));
    }
    Ok(None)
}

/// `WorkspaceResolver.resolvePathInRoot`: `relative` in one root, where it must exist.
pub fn resolve_in_root(root: &Root, relative: &str) -> Result<Option<PathBuf>, PathError> {
    check_relative(relative)?;
    let candidate = canonical_path(&join_relative(&root.path, relative))?;
    Ok((is_within(&root.path, &candidate) && exists(&candidate)).then_some(candidate))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveRequest {
    #[serde(default)]
    id: Value,
    op: String,
    relative_path: String,
    access: Access,
    roots: Vec<Root>,
    #[serde(default)]
    root_kinds: Option<Vec<String>>,
    #[serde(default)]
    reserved: Vec<PathBuf>,
    /// Resolve in `roots[0]` only, as `resolvePathInRoot` does.
    #[serde(default)]
    in_root: bool,
    #[serde(default)]
    payload: u64,
}

fn io_error(error: &io::Error) -> Value {
    let kind = match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        _ => "EIO",
    };
    json!({ "code": "io_error", "message": format!("the path could not be resolved ({kind})"), "errno": kind })
}

fn path_text(value: &Path) -> Result<String, Value> {
    value.to_str().map(str::to_owned).ok_or_else(|| json!({ "code": "io_error", "message": "the resolved path is not valid Unicode", "errno": "EILSEQ" }))
}

/// The `paths.resolve` operation of `hoi4-engine serve`. A refusal is an answer, not an error:
/// `{"refusal":{"code","message"}}`. No root holding the path is `{"resolved":null}`.
pub fn respond(request: &Value) -> Result<Value, Value> {
    let request: ResolveRequest =
        serde_json::from_value(request.clone()).map_err(|e| json!({ "code": "invalid_request", "message": format!("invalid paths.resolve request: {e}") }))?;
    let _ = (&request.id, &request.op, request.payload);
    let outcome = if request.in_root {
        let Some(root) = request.roots.first() else {
            return Err(json!({ "code": "invalid_request", "message": "paths.resolve in_root needs one root" }));
        };
        resolve_in_root(root, &request.relative_path).map(|found| found.map(|path| Resolved { path, root: 0 }))
    } else {
        resolve(&request.roots, request.root_kinds.as_deref(), &request.reserved, &request.relative_path, request.access)
    };
    match outcome {
        Ok(Some(resolved)) => Ok(json!({ "resolved": { "path": path_text(&resolved.path)?, "root": resolved.root } })),
        Ok(None) => Ok(json!({ "resolved": null })),
        Err(PathError::Refused(refusal)) => Ok(json!({ "refusal": { "code": refusal.code, "message": refusal.message } })),
        Err(PathError::Io(error)) => Err(io_error(&error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(relative: &str) -> Option<&'static str> {
        check_relative(relative).err().map(|refusal| refusal.code)
    }

    #[test]
    fn refuses_unsafe_relative_paths_with_the_typescript_codes() {
        assert_eq!(code(""), Some("PATH_EMPTY"));
        assert_eq!(code("common/\0x.txt"), Some("PATH_NUL"));
        assert_eq!(code("/etc/passwd"), Some("PATH_ABSOLUTE_REJECTED"));
        assert_eq!(code("../outside.txt"), Some("PATH_TRAVERSAL"));
        assert_eq!(code("common/../../outside.txt"), Some("PATH_TRAVERSAL"));
        assert_eq!(code("common\\..\\outside.txt"), Some("PATH_TRAVERSAL"));
        assert_eq!(code("events/file.txt:stream"), Some("PATH_ALTERNATE_STREAM"));
        assert_eq!(code("events/CON.txt"), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("events/lpt\u{b9}"), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("events/cloc\u{212a}$"), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("events/trailing."), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("events/trailing "), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("events/a\u{1}b.txt"), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("events/a?b.txt"), Some("PATH_WINDOWS_DEVICE"));
        assert_eq!(code("./common//ideas/x.txt"), None);
        assert_eq!(code("events/console.txt"), None);
        assert_eq!(code("events/com10.txt"), None);
        if cfg!(windows) {
            assert_eq!(code("C:\\Windows\\win.ini"), Some("PATH_ABSOLUTE_REJECTED"));
            assert_eq!(code("\\server\\share"), Some("PATH_ABSOLUTE_REJECTED"));
        }
    }

    /// A fresh folder under the system temporary folder, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("hoi4-paths-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Scratch(canonical_path(&path).unwrap())
        }

        fn dir(&self, relative: &str) -> PathBuf {
            let path = join_relative(&self.0, relative);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = join_relative(&self.0, relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"x").unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A directory link from `link` to `target`: a symbolic link, or a junction on Windows when
    /// symbolic links need a privilege. `false` when neither can be made here.
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
                || std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|output| output.status.success())
        }
    }

    fn root(path: &Path, kind: &str, load_order: i64, writable: bool) -> Root {
        Root { path: path.to_path_buf(), kind: kind.to_owned(), load_order, writable }
    }

    fn refusal_code(result: Result<Option<Resolved>, PathError>) -> Option<&'static str> {
        match result {
            Err(PathError::Refused(refusal)) => Some(refusal.code),
            _ => None,
        }
    }

    #[test]
    fn resolves_in_the_highest_loading_root_that_holds_the_path() {
        let scratch = Scratch::new("load-order");
        let (game, mod_root) = (scratch.dir("game"), scratch.dir("mod"));
        scratch.file("game/common/ideas/a.txt");
        let in_mod = scratch.file("mod/common/ideas/a.txt");
        let game_only = scratch.file("game/common/ideas/b.txt");
        let roots = [root(&game, "game", 0, false), root(&mod_root, "mod", 2, true)];
        let found = resolve(&roots, None, &[], "common/ideas/a.txt", Access::Read).unwrap().unwrap();
        assert_eq!(found, Resolved { path: in_mod, root: 1 });
        let found = resolve(&roots, None, &[], "common\\ideas/./b.txt", Access::Read).unwrap();
        if cfg!(windows) {
            assert_eq!(found, Some(Resolved { path: game_only, root: 0 }));
        }
        assert_eq!(resolve(&roots, None, &[], "common/ideas/missing.txt", Access::Read).unwrap(), None);
        let kinds = ["game".to_owned()];
        let found = resolve(&roots, Some(&kinds), &[], "common/ideas/a.txt", Access::Read).unwrap().unwrap();
        assert_eq!(found.root, 0);
    }

    #[test]
    fn writes_only_to_writable_roots_and_through_the_nearest_existing_ancestor() {
        let scratch = Scratch::new("write");
        let (game, mod_root) = (scratch.dir("game"), scratch.dir("mod"));
        let roots = [root(&game, "game", 0, false), root(&mod_root, "mod", 1, true)];
        let found = resolve(&roots, None, &[], "new/deeper/file.txt", Access::Write).unwrap().unwrap();
        assert_eq!(found, Resolved { path: mod_root.join("new").join("deeper").join("file.txt"), root: 1 });
        let game_only = [root(&game, "game", 0, false)];
        assert_eq!(resolve(&game_only, None, &[], "file.txt", Access::Write).unwrap(), None);
    }

    #[test]
    fn refuses_server_storage_as_mod_source() {
        let scratch = Scratch::new("reserved");
        let mod_root = scratch.dir("mod");
        let artifacts = scratch.dir("mod/.hoi4-agent/artifacts");
        let cache = scratch.dir("mod/cache-store");
        scratch.file("mod/cache-store/entry.json");
        let roots = [root(&mod_root, "mod", 1, true)];
        for relative in [".hoi4-agent/cache/locks/write.lock/evil.txt", "./.hoi4-agent/x.txt", ".\\.hoi4-agent/x.txt", ".HOI4-AGENT/artifacts/evil.txt"] {
            for access in [Access::Read, Access::Write] {
                assert_eq!(refusal_code(resolve(&roots, None, &[], relative, access)), Some("PATH_GENERATED_STORAGE_RESERVED"), "{relative}");
            }
        }
        let reserved = [artifacts, cache];
        assert_eq!(refusal_code(resolve(&roots, None, &reserved, "cache-store/entry.json", Access::Read)), Some("PATH_GENERATED_STORAGE_RESERVED"));
        assert_eq!(refusal_code(resolve(&roots, None, &reserved, "cache-store/new.json", Access::Write)), Some("PATH_GENERATED_STORAGE_RESERVED"));
        // Reserved storage only guards the mod root; a game root is never written.
        let game_roots = [root(&mod_root, "game", 0, false)];
        assert!(resolve(&game_roots, None, &reserved, "cache-store/entry.json", Access::Read).unwrap().is_some());
    }

    #[test]
    fn never_follows_a_link_out_of_its_root() {
        let scratch = Scratch::new("escape");
        let mod_root = scratch.dir("mod");
        let outside = scratch.dir("outside");
        scratch.file("outside/secret.txt");
        if !link_dir(&outside, &mod_root.join("escape")) {
            return;
        }
        let roots = [root(&mod_root, "mod", 1, true)];
        assert_eq!(resolve(&roots, None, &[], "escape/secret.txt", Access::Read).unwrap(), None);
        assert_eq!(resolve(&roots, None, &[], "escape/new.txt", Access::Write).unwrap(), None);
        assert_eq!(resolve(&roots, None, &[], "escape/missing/new.txt", Access::Write).unwrap(), None);
        assert_eq!(resolve_in_root(&roots[0], "escape/secret.txt").unwrap(), None);
        // A link that stays inside its root resolves to its target.
        let inner = scratch.dir("mod/inner");
        scratch.file("mod/inner/kept.txt");
        if link_dir(&inner, &mod_root.join("alias")) {
            let found = resolve(&roots, None, &[], "alias/kept.txt", Access::Read).unwrap().unwrap();
            assert_eq!(found.path, inner.join("kept.txt"));
        }
    }

    #[test]
    fn refuses_unsafe_paths_before_touching_a_root() {
        let roots = [root(Path::new(if cfg!(windows) { r"Z:\no\such\root" } else { "/no/such/root" }), "mod", 1, true)];
        for (relative, expected) in [
            ("../outside/secret.txt", "PATH_TRAVERSAL"),
            ("..\\outside\\secret.txt", "PATH_TRAVERSAL"),
            ("file.txt:secret", "PATH_ALTERNATE_STREAM"),
            ("CON", "PATH_WINDOWS_DEVICE"),
            ("CONIN$", "PATH_WINDOWS_DEVICE"),
            ("CON.focus.txt", "PATH_WINDOWS_DEVICE"),
            ("COM\u{b9}.txt", "PATH_WINDOWS_DEVICE"),
            ("bad|name.txt", "PATH_WINDOWS_DEVICE"),
            ("folder/name. ", "PATH_WINDOWS_DEVICE"),
        ] {
            assert_eq!(refusal_code(resolve(&roots, None, &[], relative, Access::Write)), Some(expected), "{relative}");
        }
    }

    #[test]
    fn resolves_in_one_root_only_when_the_path_exists() {
        let scratch = Scratch::new("in-root");
        let game = scratch.dir("game");
        let file = scratch.file("game/map/definition.csv");
        let game_root = root(&game, "game", 0, false);
        assert_eq!(resolve_in_root(&game_root, "map/definition.csv").unwrap(), Some(file));
        assert_eq!(resolve_in_root(&game_root, "map/missing.csv").unwrap(), None);
        assert!(matches!(resolve_in_root(&game_root, "../x"), Err(PathError::Refused(Refusal { code: "PATH_TRAVERSAL", .. }))));
    }

    #[test]
    fn answers_the_wire_shapes() {
        let scratch = Scratch::new("wire");
        let mod_root = scratch.dir("mod");
        let file = scratch.file("mod/a.txt");
        let request = |relative: &str, extra: Value| {
            let mut value = json!({
                "id": 1, "op": "paths.resolve", "payload": 0, "relativePath": relative, "access": "read",
                "roots": [{ "path": mod_root, "kind": "mod", "loadOrder": 1, "writable": true }],
            });
            for (key, field) in extra.as_object().unwrap() {
                value[key] = field.clone();
            }
            value
        };
        assert_eq!(respond(&request("a.txt", json!({}))).unwrap(), json!({ "resolved": { "path": file.to_str().unwrap(), "root": 0 } }));
        assert_eq!(respond(&request("b.txt", json!({}))).unwrap(), json!({ "resolved": null }));
        assert_eq!(respond(&request("b.txt", json!({ "inRoot": true }))).unwrap(), json!({ "resolved": null }));
        assert_eq!(respond(&request("../a.txt", json!({}))).unwrap()["refusal"]["code"], "PATH_TRAVERSAL");
        assert_eq!(respond(&request("a.txt", json!({ "access": "delete" }))).unwrap_err()["code"], "invalid_request");
        assert_eq!(respond(&request("a.txt", json!({ "unexpected": true }))).unwrap_err()["code"], "invalid_request");
        assert_eq!(respond(&request("a.txt", json!({ "inRoot": true, "roots": [] }))).unwrap_err()["code"], "invalid_request");
    }

    #[test]
    fn containment_compares_whole_segments() {
        let root = Path::new(if cfg!(windows) { r"C:\mods\a" } else { "/mods/a" });
        let inside = Path::new(if cfg!(windows) { r"C:\mods\a\common" } else { "/mods/a/common" });
        let sibling = Path::new(if cfg!(windows) { r"C:\mods\ab" } else { "/mods/ab" });
        assert!(is_within(root, root));
        assert!(is_within(root, inside));
        assert!(!is_within(root, sibling));
        assert!(!is_within(inside, root));
        assert!(paths_overlap(inside, root));
        if cfg!(windows) {
            assert!(is_within(Path::new(r"C:\Mods\A"), inside));
            assert!(is_within(Path::new(r"C:\"), inside));
            assert!(!is_within(Path::new(r"D:\mods\a"), inside));
        }
    }
}

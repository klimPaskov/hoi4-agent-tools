//! Managed output folders: an inventory of generated files with their hashes, so a regeneration
//! never discards a hand edit and retires the outputs it no longer produces.
//!
//! Ported from `src/hoi4_agent_tools/core/managed-outputs.ts` (`planManagedOutputs`,
//! `refreshManagedOutputs`, `parseManifest`, `manifestBytes`), commit `9b7dc80d`. The TypeScript
//! predicates (`permitsPath`, `releasable`, `addable`, `alwaysScanned`) are closures; across the
//! engine boundary they are [`PathRule`] data, so a caller states the rule instead of passing code.
//! Planning stays pure: it reads hashes, never bytes of outputs, and writes nothing. The
//! transaction engine performs every replacement and deletion.

use std::collections::{BTreeMap, BTreeSet};

use hoi4_core::canonical::{canonical_json, compare_code_units};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{StoreError, StoreResult};

const MANIFEST_MAX_BYTES: usize = 2_000_000;

/// A predicate over a workspace-relative path with forward slashes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathRule {
    /// True when any rule is.
    Any(Vec<PathRule>),
    /// True when every rule is.
    All(Vec<PathRule>),
    Not(Box<PathRule>),
    /// The exact path.
    Path(String),
    /// A file in one of `dirs` (the posix dirname) whose name is in `files` or matches `pattern`.
    Dir(DirRule),
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirRule {
    pub dirs: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub pattern: Option<String>,
}

/// JavaScript's `\d`, `\w` and `\b` are ASCII and its `\s` is a fixed set of spaces, while the
/// Rust regex engine reads all of them as Unicode. The difference decides which recorded files a
/// regeneration deletes, so the shorthand classes are rewritten to their JavaScript meaning.
/// A negated shorthand inside a character class cannot be written that way and is refused.
fn javascript_pattern(pattern: &str) -> Result<String, ()> {
    const SPACE: &str = "\\t\\n\\x0B\\x0C\\r \\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}";
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut in_class = false;
    let mut chars = pattern.chars();
    while let Some(character) = chars.next() {
        match character {
            '\\' => {
                let Some(escaped) = chars.next() else { return Err(()) };
                match (escaped, in_class) {
                    ('d', false) => out.push_str("[0-9]"),
                    ('d', true) => out.push_str("0-9"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('w', false) => out.push_str("[0-9A-Za-z_]"),
                    ('w', true) => out.push_str("0-9A-Za-z_"),
                    ('W', false) => out.push_str("[^0-9A-Za-z_]"),
                    ('s', false) => {
                        out.push('[');
                        out.push_str(SPACE);
                        out.push(']');
                    }
                    ('s', true) => out.push_str(SPACE),
                    ('S', false) => {
                        out.push_str("[^");
                        out.push_str(SPACE);
                        out.push(']');
                    }
                    ('D' | 'W' | 'S', true) => return Err(()),
                    ('b', false) => out.push_str("(?-u:\\b)"),
                    ('B', false) => out.push_str("(?-u:\\B)"),
                    _ => {
                        out.push('\\');
                        out.push(escaped);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

fn compile_pattern(pattern: &str) -> StoreResult<Regex> {
    let invalid = || StoreError::new("MANAGED_OUTPUT_RULE_INVALID", "A managed-output path rule has an invalid pattern");
    Regex::new(&javascript_pattern(pattern).map_err(|()| invalid())?).map_err(|_| invalid())
}

fn posix_split(path: &str) -> (String, &str) {
    match path.rsplit_once('/') {
        Some((dir, file)) => (if dir.is_empty() { "/".into() } else { dir.to_owned() }, file),
        None => (".".into(), path),
    }
}

impl PathRule {
    /// Checks every pattern compiles, so a bad rule is refused before it is used.
    pub fn validate(&self) -> StoreResult<()> {
        match self {
            PathRule::Any(rules) | PathRule::All(rules) => rules.iter().try_for_each(PathRule::validate),
            PathRule::Not(rule) => rule.validate(),
            PathRule::Path(_) => Ok(()),
            PathRule::Dir(rule) => match &rule.pattern {
                Some(pattern) => compile_pattern(pattern).map(|_| ()),
                None => Ok(()),
            },
        }
    }

    pub fn matches(&self, path: &str) -> bool {
        match self {
            PathRule::Any(rules) => rules.iter().any(|rule| rule.matches(path)),
            PathRule::All(rules) => rules.iter().all(|rule| rule.matches(path)),
            PathRule::Not(rule) => !rule.matches(path),
            PathRule::Path(exact) => exact == path,
            PathRule::Dir(rule) => {
                let (dir, file) = posix_split(path);
                rule.dirs.contains(&dir)
                    && (rule.files.iter().any(|name| name == file)
                        || rule.pattern.as_ref().is_some_and(|pattern| compile_pattern(pattern).is_ok_and(|regex| regex.is_match(file))))
            }
        }
    }
}

/// A scanned file as planning needs it: where it is and the hash of its bytes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub relative_path: String,
    pub root_kind: String,
    pub sha256: String,
}

/// One file change of the request: its path, the hash of its new bytes (`None` deletes it) and the
/// operations that wrote it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedChange {
    pub relative_path: String,
    pub sha256: Option<String>,
    #[serde(default)]
    pub operation_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedDeletion {
    pub relative_path: String,
    pub operation_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedOutputPlan {
    /// Deletions of retired outputs.
    pub deletions: Vec<PlannedDeletion>,
    /// The new inventory text (canonical JSON and a newline), to be written at the manifest path.
    pub manifest: String,
    pub written: Vec<String>,
    pub retired: Vec<String>,
    pub released: Vec<String>,
    pub ignored: Vec<String>,
}

#[derive(Clone, Debug)]
struct Entry {
    relative_path: String,
    sha256: String,
}

fn key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn invalid(message: &str) -> StoreError {
    StoreError::new("MANAGED_OUTPUT_MANIFEST_INVALID", message)
}

/// Parses a recorded inventory. An oversized or malformed one, a path that could leave the
/// workspace, or a duplicate makes the whole inventory untrustworthy.
fn parse_manifest(text: &str) -> StoreResult<Vec<Entry>> {
    if text.len() > MANIFEST_MAX_BYTES {
        return Err(invalid("Generated-output inventory exceeds its byte limit"));
    }
    let bad = || invalid("Generated-output inventory is invalid");
    let value: Value = serde_json::from_str(text).map_err(|_| bad())?;
    let object = value.as_object().ok_or_else(bad)?;
    if object.len() != 2 || object.get("version") != Some(&json!(1)) {
        return Err(bad());
    }
    let files = object.get("files").and_then(Value::as_array).filter(|files| files.len() <= 5000).ok_or_else(bad)?;
    let mut entries = Vec::with_capacity(files.len());
    for file in files {
        let item = file.as_object().filter(|item| item.len() == 2).ok_or_else(bad)?;
        let relative_path = item.get("relativePath").and_then(Value::as_str).filter(|path| !path.is_empty() && path.chars().count() <= 512).ok_or_else(bad)?;
        let sha256 = item
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .ok_or_else(bad)?;
        entries.push(Entry { relative_path: relative_path.to_owned(), sha256: sha256.to_owned() });
    }
    let mut seen = BTreeSet::new();
    for entry in &entries {
        let path = &entry.relative_path;
        let drive = path.len() >= 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.as_bytes()[1] == b':';
        if path.contains('\\') || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") || drive || !seen.insert(path.to_lowercase()) {
            return Err(invalid("Generated-output inventory contains an unsupported or duplicate path"));
        }
    }
    Ok(entries)
}

fn manifest_text(entries: &[Entry]) -> String {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|left, right| compare_code_units(&left.relative_path, &right.relative_path));
    let files: Vec<Value> = sorted.iter().map(|entry| json!({ "relativePath": entry.relative_path, "sha256": entry.sha256 })).collect();
    format!("{}\n", canonical_json(&json!({ "version": 1, "files": files })))
}

fn sorted(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut paths: Vec<String> = paths.into_iter().collect();
    paths.sort_by(|left, right| compare_code_units(left, right));
    paths
}

pub struct PlanInput<'a> {
    pub manifest_path: &'a str,
    /// Scanned files; only the ones of root kind `mod` count.
    pub sources: &'a [SourceFile],
    /// The text of the recorded inventory, when the workspace has one.
    pub manifest_text: Option<&'a str>,
    pub proposed: &'a [ProposedChange],
    pub operation_id: &'a str,
    pub permits: &'a PathRule,
    pub releasable: Option<&'a PathRule>,
}

/// Plans the managed-output reconciliation and reports what it writes, retires and releases.
pub fn plan_managed_outputs(input: &PlanInput<'_>) -> StoreResult<ManagedOutputPlan> {
    let sources: BTreeMap<String, &SourceFile> =
        input.sources.iter().filter(|file| file.root_kind == "mod").map(|file| (key(&file.relative_path), file)).collect();
    let previous = match input.manifest_text {
        Some(text) if sources.contains_key(&input.manifest_path.to_lowercase()) => parse_manifest(text)?,
        _ => Vec::new(),
    };
    let outputs: Vec<&ProposedChange> =
        input.proposed.iter().filter(|change| change.sha256.is_some() && input.permits.matches(&change.relative_path)).collect();
    let next: BTreeSet<String> = outputs.iter().map(|change| change.relative_path.to_lowercase()).collect();
    let mut released = BTreeSet::new();
    let mut ignored = BTreeSet::new();
    for file in &previous {
        let file_key = file.relative_path.to_lowercase();
        // A safe path this inventory does not manage is left alone: not compared, not deleted.
        if !input.permits.matches(&file.relative_path) {
            ignored.insert(file.relative_path.clone());
            continue;
        }
        let Some(current) = sources.get(&file_key) else { continue };
        if current.sha256 == file.sha256 {
            continue;
        }
        if !next.contains(&file_key) && input.releasable.is_some_and(|rule| rule.matches(&file.relative_path)) {
            released.insert(file_key);
            continue;
        }
        return Err(StoreError::with_details(
            "MANAGED_OUTPUT_EDITED",
            "A generated file has been edited; regeneration would discard those changes",
            json!({ "relativePath": file.relative_path }),
        ));
    }
    let ignored_keys: BTreeSet<String> = ignored.iter().map(|path| path.to_lowercase()).collect();
    let deletions: Vec<PlannedDeletion> = previous
        .iter()
        .filter(|file| {
            let file_key = file.relative_path.to_lowercase();
            !next.contains(&file_key) && !released.contains(&file_key) && !ignored_keys.contains(&file_key) && sources.contains_key(&file_key)
        })
        .map(|file| PlannedDeletion { relative_path: file.relative_path.clone(), operation_ids: vec![input.operation_id.to_owned()] })
        .collect();
    let entries: Vec<Entry> =
        outputs.iter().map(|change| Entry { relative_path: change.relative_path.clone(), sha256: change.sha256.clone().unwrap_or_default() }).collect();
    Ok(ManagedOutputPlan {
        manifest: manifest_text(&entries),
        written: sorted(outputs.iter().map(|change| change.relative_path.clone())),
        retired: sorted(deletions.iter().map(|deletion| deletion.relative_path.clone())),
        released: sorted(previous.iter().filter(|file| released.contains(&file.relative_path.to_lowercase())).map(|file| file.relative_path.clone())),
        ignored: sorted(ignored),
        deletions,
    })
}

pub struct RefreshInput<'a> {
    pub manifest_path: &'a str,
    pub sources: &'a [SourceFile],
    /// Each source's recorded-inventory text, when the inventory is in the scan.
    pub manifest_text: Option<&'a str>,
    /// Every change of the request, after its last operation.
    pub proposed: &'a [ProposedChange],
    /// Whether the request writes the inventory itself: its text, or `None` when it does not, and
    /// `deleted` when it deletes it.
    pub manifest_written: Option<&'a str>,
    pub manifest_deleted: bool,
    pub adopt_all: bool,
    pub addable: Option<&'a PathRule>,
    pub adopt_unrecorded: bool,
    pub always_scanned: Option<&'a PathRule>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedOutputRefresh {
    /// The new inventory text, or `None` when no recorded hash changes.
    pub content: Option<String>,
    pub refreshed: Vec<String>,
    pub dropped: Vec<String>,
    pub kept_edited: Vec<String>,
    pub unchanged: Vec<String>,
    pub unscanned: Vec<String>,
    pub added: Vec<String>,
    pub operation_ids: Vec<String>,
}

/// Brings the recorded hashes of an inventory up to date with the bytes a request leaves behind.
/// Returns `None` when the workspace has no inventory or this request deletes it.
pub fn refresh_managed_outputs(input: &RefreshInput<'_>) -> StoreResult<Option<ManagedOutputRefresh>> {
    let proposed: BTreeMap<String, &ProposedChange> = input.proposed.iter().map(|change| (key(&change.relative_path), change)).collect();
    let sources: BTreeMap<String, &SourceFile> =
        input.sources.iter().filter(|file| file.root_kind == "mod").map(|file| (key(&file.relative_path), file)).collect();
    let manifest_key = key(input.manifest_path);
    if input.manifest_deleted {
        return Ok(None);
    }
    let written_here = input.manifest_written.is_some();
    let Some(text) = input.manifest_written.or(if sources.contains_key(&manifest_key) { input.manifest_text } else { None }) else { return Ok(None) };
    let (mut refreshed, mut dropped, mut kept_edited, mut unchanged, mut unscanned) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut operation_ids: BTreeSet<String> = BTreeSet::new();
    let mut next: Vec<Entry> = Vec::new();
    for entry in parse_manifest(text)? {
        let change = proposed.get(&key(&entry.relative_path));
        let source = sources.get(&key(&entry.relative_path));
        let current: Option<String>;
        if let Some(change) = change {
            let trusted = written_here || input.adopt_all || source.is_none() || source.is_some_and(|source| source.sha256 == entry.sha256);
            if !trusted {
                kept_edited.push(entry.relative_path.clone());
                next.push(entry);
                continue;
            }
            current = change.sha256.clone();
            operation_ids.extend(change.operation_ids.iter().cloned());
        } else if input.adopt_all {
            // A file the scan did not read is not a file that is gone: keep its entry.
            if source.is_none() && input.always_scanned.is_some_and(|rule| rule.matches(&entry.relative_path)) {
                dropped.push(entry.relative_path.clone());
                continue;
            }
            let Some(source) = source else {
                unscanned.push(entry.relative_path.clone());
                next.push(entry);
                continue;
            };
            current = Some(source.sha256.clone());
        } else {
            next.push(entry);
            continue;
        }
        let Some(sha256) = current else {
            dropped.push(entry.relative_path.clone());
            continue;
        };
        if sha256 == entry.sha256 {
            unchanged.push(entry.relative_path.clone());
        } else {
            refreshed.push(entry.relative_path.clone());
        }
        next.push(Entry { relative_path: entry.relative_path, sha256 });
    }
    // Files the request creates at managed paths, and on request the ones already on disk.
    let mut added = Vec::new();
    let mut recorded: BTreeSet<String> = next.iter().map(|entry| key(&entry.relative_path)).collect();
    recorded.extend(dropped.iter().map(|path| key(path)));
    if let Some(addable) = input.addable {
        struct Candidate {
            relative_path: String,
            sha256: String,
            ids: Vec<String>,
        }
        let mut candidates: BTreeMap<String, Candidate> = BTreeMap::new();
        if input.adopt_unrecorded {
            for (name, file) in &sources {
                candidates
                    .insert(name.clone(), Candidate { relative_path: file.relative_path.replace('\\', "/"), sha256: file.sha256.clone(), ids: Vec::new() });
            }
        }
        for (name, change) in &proposed {
            let Some(sha256) = &change.sha256 else {
                candidates.remove(name);
                continue;
            };
            // A change to an existing unrecorded file is not a creation unless adoption was asked for.
            if !sources.contains_key(name) || input.adopt_unrecorded {
                candidates.insert(
                    name.clone(),
                    Candidate { relative_path: change.relative_path.replace('\\', "/"), sha256: sha256.clone(), ids: change.operation_ids.clone() },
                );
            }
        }
        let mut ordered: Vec<(&String, &Candidate)> = candidates.iter().collect();
        ordered.sort_by(|left, right| compare_code_units(left.0, right.0));
        for (name, candidate) in ordered {
            if *name == manifest_key || recorded.contains(name) || !addable.matches(&candidate.relative_path) {
                continue;
            }
            next.push(Entry { relative_path: candidate.relative_path.clone(), sha256: candidate.sha256.clone() });
            added.push(candidate.relative_path.clone());
            operation_ids.extend(candidate.ids.iter().cloned());
        }
    }
    let changed = !refreshed.is_empty() || !dropped.is_empty() || !added.is_empty();
    Ok(Some(ManagedOutputRefresh {
        content: changed.then(|| manifest_text(&next)),
        added: sorted(added),
        refreshed: sorted(refreshed),
        dropped: sorted(dropped),
        kept_edited: sorted(kept_edited),
        unchanged: sorted(unchanged),
        unscanned: sorted(unscanned),
        operation_ids: sorted(operation_ids),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = ".hoi4-agent-world.json";

    fn hash(byte: char) -> String {
        byte.to_string().repeat(64)
    }

    fn permits() -> PathRule {
        PathRule::Any(vec![
            PathRule::Dir(DirRule { dirs: vec!["map".into()], files: vec!["definition.csv".into()], pattern: None }),
            PathRule::Dir(DirRule { dirs: vec!["history/states".into()], files: vec![], pattern: Some(r"^\d+.*\.txt$".into()) }),
            PathRule::Path("common/bookmarks/world.txt".into()),
        ])
    }

    fn source(path: &str, byte: char) -> SourceFile {
        SourceFile { relative_path: path.into(), root_kind: "mod".into(), sha256: hash(byte) }
    }

    fn change(path: &str, byte: Option<char>) -> ProposedChange {
        ProposedChange { relative_path: path.into(), sha256: byte.map(hash), operation_ids: vec!["op".into()] }
    }

    fn manifest(entries: &[(&str, char)]) -> String {
        let entries: Vec<Entry> = entries.iter().map(|(path, byte)| Entry { relative_path: (*path).into(), sha256: hash(*byte) }).collect();
        manifest_text(&entries)
    }

    fn plan(sources: &[SourceFile], text: Option<&str>, proposed: &[ProposedChange], releasable: Option<&PathRule>) -> StoreResult<ManagedOutputPlan> {
        let rule = permits();
        plan_managed_outputs(&PlanInput { manifest_path: MANIFEST, sources, manifest_text: text, proposed, operation_id: "op", permits: &rule, releasable })
    }

    #[test]
    fn writes_the_inventory_and_retires_outputs_no_longer_produced() {
        let text = manifest(&[("map/definition.csv", 'a'), ("history/states/1-A.txt", 'b')]);
        let sources = [source(MANIFEST, 'f'), source("map/definition.csv", 'a'), source("history/states/1-A.txt", 'b')];
        let result = plan(&sources, Some(&text), &[change("map/definition.csv", Some('c'))], None).unwrap();
        assert_eq!(result.retired, vec!["history/states/1-A.txt"]);
        assert_eq!(result.written, vec!["map/definition.csv"]);
        assert_eq!(result.manifest, manifest(&[("map/definition.csv", 'c')]));
    }

    #[test]
    fn refuses_to_overwrite_a_hand_edit_and_can_release_one() {
        let text = manifest(&[("map/definition.csv", 'a')]);
        let sources = [source(MANIFEST, 'f'), source("map/definition.csv", 'e')];
        let error = plan(&sources, Some(&text), &[change("map/definition.csv", Some('c'))], None).unwrap_err();
        assert_eq!((error.code, error.details), ("MANAGED_OUTPUT_EDITED", Some(json!({ "relativePath": "map/definition.csv" }))));
        let release = PathRule::Path("map/definition.csv".into());
        let result = plan(&sources, Some(&text), &[], Some(&release)).unwrap();
        assert_eq!(result.released, vec!["map/definition.csv"]);
        assert!(result.retired.is_empty());
    }

    #[test]
    fn leaves_unmanaged_recorded_paths_alone() {
        let text = manifest(&[("other/tool.txt", 'a')]);
        let sources = [source(MANIFEST, 'f'), source("other/tool.txt", 'e')];
        let result = plan(&sources, Some(&text), &[], None).unwrap();
        assert_eq!(result.ignored, vec!["other/tool.txt"]);
        assert!(result.deletions.is_empty());
        assert!(!result.manifest.contains("other/tool.txt"));
    }

    #[test]
    fn refuses_untrustworthy_inventories() {
        let sources = [source(MANIFEST, 'f')];
        for bad in [
            "{".to_string(),
            r#"{"version":2,"files":[]}"#.to_string(),
            r#"{"version":1,"files":[],"extra":1}"#.to_string(),
            format!(r#"{{"version":1,"files":[{{"relativePath":"../x","sha256":"{}"}}]}}"#, hash('a')),
            format!(r#"{{"version":1,"files":[{{"relativePath":"a\\b","sha256":"{}"}}]}}"#, hash('a')),
            format!(r#"{{"version":1,"files":[{{"relativePath":"C:x","sha256":"{}"}}]}}"#, hash('a')),
            format!(r#"{{"version":1,"files":[{{"relativePath":"a","sha256":"{}"}},{{"relativePath":"A","sha256":"{}"}}]}}"#, hash('a'), hash('a')),
            format!(r#"{{"version":1,"files":[{{"relativePath":"a","sha256":"{}","x":1}}]}}"#, hash('a')),
            r#"{"version":1,"files":[{"relativePath":"a","sha256":"ABC"}]}"#.to_string(),
            " ".repeat(2_000_001),
        ] {
            assert_eq!(plan(&sources, Some(&bad), &[], None).unwrap_err().code, "MANAGED_OUTPUT_MANIFEST_INVALID", "{}", &bad[..bad.len().min(60)]);
        }
    }

    fn refresh<'a>(
        sources: &'a [SourceFile],
        text: Option<&'a str>,
        proposed: &'a [ProposedChange],
        tune: impl FnOnce(&mut RefreshInput<'a>),
    ) -> Option<ManagedOutputRefresh> {
        let mut input = RefreshInput {
            manifest_path: MANIFEST,
            sources,
            manifest_text: text,
            proposed,
            manifest_written: None,
            manifest_deleted: false,
            adopt_all: false,
            addable: None,
            adopt_unrecorded: false,
            always_scanned: None,
        };
        tune(&mut input);
        refresh_managed_outputs(&input).unwrap()
    }

    #[test]
    fn refresh_keeps_a_hand_edit_protected_and_adopts_on_request() {
        let text = manifest(&[("map/definition.csv", 'a'), ("history/states/1-A.txt", 'b')]);
        let sources = [source(MANIFEST, 'f'), source("map/definition.csv", 'e'), source("history/states/1-A.txt", 'b')];
        let proposed = [change("map/definition.csv", Some('c')), change("history/states/1-A.txt", Some('d'))];
        let result = refresh(&sources, Some(&text), &proposed, |_| {}).unwrap();
        assert_eq!(
            (result.kept_edited.as_slice(), result.refreshed.as_slice()),
            (&["map/definition.csv".to_string()][..], &["history/states/1-A.txt".to_string()][..])
        );
        let adopted = refresh(&sources, Some(&text), &proposed, |input| input.adopt_all = true).unwrap();
        assert_eq!(adopted.refreshed.len(), 2);
        assert!(adopted.kept_edited.is_empty());
    }

    #[test]
    fn refresh_drops_gone_files_only_where_every_scan_reads_them() {
        let text = manifest(&[("map/definition.csv", 'a'), ("history/states/1-A.txt", 'b')]);
        let sources = [source(MANIFEST, 'f')];
        let scanned = PathRule::Dir(DirRule { dirs: vec!["history/states".into()], files: vec![], pattern: Some(r"\.txt$".into()) });
        let result = refresh(&sources, Some(&text), &[], |input| {
            input.adopt_all = true;
            input.always_scanned = Some(&scanned);
        })
        .unwrap();
        assert_eq!(result.dropped, vec!["history/states/1-A.txt"]);
        assert_eq!(result.unscanned, vec!["map/definition.csv"]);
        assert!(result.content.is_some_and(|content| content.contains("map/definition.csv") && !content.contains("1-A.txt")));
    }

    #[test]
    fn refresh_adds_created_files_at_managed_paths_and_skips_when_deleted_or_absent() {
        let text = manifest(&[]);
        let sources = [source(MANIFEST, 'f'), source("map/definition.csv", 'e')];
        let proposed = [change("history/states/2-B.txt", Some('c')), change("map/definition.csv", Some('d'))];
        let rule = permits();
        let result = refresh(&sources, Some(&text), &proposed, |input| input.addable = Some(&rule)).unwrap();
        assert_eq!(result.added, vec!["history/states/2-B.txt"]);
        assert!(refresh(&sources, Some(&text), &proposed, |input| input.manifest_deleted = true).is_none());
        assert!(refresh(&[], None, &proposed, |_| {}).is_none());
    }

    #[test]
    fn path_rules_match_like_the_typescript_predicates() {
        let rule = PathRule::All(vec![permits(), PathRule::Not(Box::new(PathRule::Path("map/definition.csv".into())))]);
        assert!(!rule.matches("map/definition.csv"));
        assert!(rule.matches("history/states/12-X.txt"));
        assert!(!rule.matches("history/states/x.txt"));
        assert!(PathRule::Dir(DirRule { dirs: vec![".".into()], files: vec!["a.txt".into()], pattern: None }).matches("a.txt"));
        assert!(PathRule::Dir(DirRule { dirs: vec![], files: vec![], pattern: Some("(".into()) }).validate().is_err());
    }

    fn dir_rule(pattern: &str) -> PathRule {
        PathRule::Dir(DirRule { dirs: vec!["gfx".into()], files: vec![], pattern: Some(pattern.into()) })
    }

    /// JavaScript's `\d`, `\w` and `\b` are ASCII; the Rust defaults are Unicode and would match
    /// files the TypeScript rule leaves alone, which are then deleted as outputs.
    #[test]
    fn shorthand_classes_match_the_javascript_meaning() {
        let digits = dir_rule(r"^\d+\.png$");
        assert!(digits.matches("gfx/123.png"));
        assert!(!digits.matches("gfx/\u{663}\u{664}.png"), "Arabic-Indic digits are not \\d in JavaScript");
        let word = dir_rule(r"^\w+$");
        assert!(word.matches("gfx/abc_9"));
        assert!(!word.matches("gfx/caf\u{e9}"), "\\w is ASCII");
        let boundary = dir_rule(r"\bmap\b");
        assert!(boundary.matches("gfx/a map.txt"));
        assert!(boundary.matches("gfx/\u{e9}map.txt"), "an accented letter is not a word character for \\b");
        let space = dir_rule(r"^a\sb$");
        assert!(space.matches("gfx/a b") && space.matches("gfx/a\u{a0}b") && space.matches("gfx/a\u{feff}b"));
        assert!(!space.matches("gfx/a\u{85}b"), "U+0085 is not JavaScript whitespace");
        let not_digit = dir_rule(r"^\D+$");
        assert!(not_digit.matches("gfx/abc") && !not_digit.matches("gfx/a1"));
        let in_class = dir_rule(r"^[\w.-]+$");
        assert!(in_class.matches("gfx/a-b.c_d") && !in_class.matches("gfx/\u{e9}"));
    }

    #[test]
    fn a_negated_shorthand_inside_a_class_is_refused() {
        assert_eq!(dir_rule(r"[\W]").validate().unwrap_err().code, "MANAGED_OUTPUT_RULE_INVALID");
        assert_eq!(dir_rule(r"[\S]").validate().unwrap_err().code, "MANAGED_OUTPUT_RULE_INVALID");
        assert_eq!(dir_rule(r"(").validate().unwrap_err().code, "MANAGED_OUTPUT_RULE_INVALID");
        assert_eq!(dir_rule(r"abc\").validate().unwrap_err().code, "MANAGED_OUTPUT_RULE_INVALID");
        assert!(dir_rule(r"^[a-z]\d$").validate().is_ok());
    }
}

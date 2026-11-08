//! Which files the shared symbol index reads: the TypeScript scanner's selection.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/scanner.ts` (`WorkspaceScanner.scan`,
//! `hiddenByReplacePath`) and `file-glob.ts` (`iterateFiles`), at commit `5c75b21`.
//!
//! The caller passes the roots it resolved (kind, path, load order, label and `replace_path`
//! folders) and the glob patterns. Each root is enumerated with the patterns, case-sensitively,
//! without following symbolic links (or Windows junctions) and without entering a folder or matching
//! a file whose name starts with a dot through a wildcard, as `glob` does with `dot: false`.
//! `.hoi4-agent` folders are never read. A file under a `replace_path` of a later mod or dependency
//! root is left out, and the replaced folder covers its subfolders, as the TypeScript scanner did
//! (ADR 0074 notes that the game itself does not unload subfolders). Files at the same path in
//! several roots are all kept; every one but the highest load order is `shadowed`.
//!
//! Supported pattern syntax: literal segments, `*`, `?`, a `**` segment and `{a,b}` alternatives
//! (nested up to eight levels, at most 128 expansions). Character classes, extended globs, numeric
//! ranges and escapes are refused with `SCAN_PATTERN_UNSUPPORTED`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Where a root sits in the workspace, as the TypeScript resolver names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RootKind {
    Game,
    Dlc,
    Dependency,
    Mod,
    Fixture,
}

impl RootKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RootKind::Game => "game",
            RootKind::Dlc => "dlc",
            RootKind::Dependency => "dependency",
            RootKind::Mod => "mod",
            RootKind::Fixture => "fixture",
        }
    }

    /// `isWorkspaceOwnedSource`.
    pub fn is_workspace_owned(self) -> bool {
        matches!(self, RootKind::Mod | RootKind::Fixture)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Root {
    pub kind: RootKind,
    pub path: PathBuf,
    pub load_order: i64,
    /// The installed folder name of a DLC layer.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub replace_paths: Vec<String>,
}

impl Root {
    /// `rootLabel`: the prefix of a file's display path.
    pub fn label(&self) -> String {
        match (self.kind, &self.label) {
            (RootKind::Dlc, Some(label)) => label.clone(),
            (RootKind::Dependency, _) => format!("dependency-{}", self.load_order),
            (kind, _) => kind.as_str().to_string(),
        }
    }
}

/// The scan ceilings of the server's configuration.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Limits {
    pub max_files: u64,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        // DEFAULT_SCAN_MAX_FILES, DEFAULT_SCAN_MAX_BYTES and DEFAULT_SCAN_MAX_FILE_BYTES.
        Limits { max_files: 100_000, max_bytes: 268_435_456, max_file_bytes: 67_108_864 }
    }
}

/// One file the scan selected.
#[derive(Clone, Debug)]
pub struct ScannedFile {
    pub root: usize,
    pub kind: RootKind,
    pub load_order: i64,
    /// Relative to the root, with forward slashes and the case found on disk.
    pub relative: String,
    /// `<root label>:<relative>`, the path symbols and diagnostics name.
    pub display: String,
    pub absolute: PathBuf,
    pub size: u64,
    /// The file of a higher load order at the same path (compared without case), if any.
    pub shadowed_by: Option<usize>,
}

/// A refused scan: the TypeScript error code and a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanError {
    pub code: &'static str,
    pub message: String,
}

fn error(code: &'static str, message: impl Into<String>) -> ScanError {
    ScanError { code, message: message.into() }
}

/// `compareCodeUnits`: order by UTF-16 code units, as JavaScript compares strings.
pub fn compare_code_units(left: &str, right: &str) -> Ordering {
    if left.is_ascii() && right.is_ascii() {
        return left.cmp(right);
    }
    left.encode_utf16().cmp(right.encode_utf16())
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Piece {
    Text(String),
    Star,
    Question,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Segment {
    Literal(String),
    Wild(Vec<Piece>),
    Globstar,
}

impl Segment {
    fn matches(&self, name: &str) -> bool {
        match self {
            Segment::Literal(text) => text == name,
            Segment::Globstar => !name.starts_with('.'),
            Segment::Wild(pieces) => {
                let explicit_dot = matches!(pieces.first(), Some(Piece::Text(t)) if t.starts_with('.'));
                if name.starts_with('.') && !explicit_dot {
                    return false;
                }
                let chars: Vec<char> = name.chars().collect();
                wild_match(pieces, &chars)
            }
        }
    }
}

fn wild_match(pieces: &[Piece], name: &[char]) -> bool {
    match pieces.split_first() {
        None => name.is_empty(),
        Some((Piece::Text(text), rest)) => {
            let text: Vec<char> = text.chars().collect();
            name.starts_with(&text) && wild_match(rest, &name[text.len()..])
        }
        Some((Piece::Question, rest)) => !name.is_empty() && wild_match(rest, &name[1..]),
        Some((Piece::Star, rest)) => (0..=name.len()).any(|skip| wild_match(rest, &name[skip..])),
    }
}

/// Expands `{a,b}` alternatives, innermost groups included.
fn expand_braces(pattern: &str, out: &mut Vec<String>, budget: &mut usize) -> Result<(), ScanError> {
    let bytes = pattern.as_bytes();
    let Some(open) = bytes.iter().position(|&b| b == b'{') else {
        if *budget == 0 {
            return Err(error("SCAN_PATTERN_LIMIT", "Source glob expansion exceeds its limit"));
        }
        *budget -= 1;
        out.push(pattern.to_string());
        return Ok(());
    };
    let mut depth = 0usize;
    let mut close = None;
    let mut commas = Vec::new();
    for (i, &b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            b',' if depth == 1 => commas.push(i),
            _ => {}
        }
    }
    let Some(close) = close else {
        return Err(error("SCAN_PATTERN_UNSUPPORTED", "Source glob pattern has an unclosed brace"));
    };
    let mut bounds = vec![open];
    bounds.extend(commas);
    bounds.push(close);
    if bounds.len() == 2 {
        return Err(error("SCAN_PATTERN_UNSUPPORTED", "Source glob braces need at least two alternatives"));
    }
    for pair in bounds.windows(2) {
        let choice = &pattern[pair[0] + 1..pair[1]];
        expand_braces(&format!("{}{}{}", &pattern[..open], choice, &pattern[close + 1..]), out, budget)?;
    }
    Ok(())
}

/// One compiled pattern: its segments.
#[derive(Clone, Debug)]
struct Pattern {
    segments: Vec<Segment>,
}

fn compile_segment(text: &str) -> Segment {
    if text == "**" {
        return Segment::Globstar;
    }
    if !text.contains(['*', '?']) {
        return Segment::Literal(text.to_string());
    }
    let mut pieces = Vec::new();
    let mut literal = String::new();
    for c in text.chars() {
        match c {
            '*' | '?' => {
                if !literal.is_empty() {
                    pieces.push(Piece::Text(std::mem::take(&mut literal)));
                }
                let piece = if c == '*' { Piece::Star } else { Piece::Question };
                if !(piece == Piece::Star && pieces.last() == Some(&Piece::Star)) {
                    pieces.push(piece);
                }
            }
            _ => literal.push(c),
        }
    }
    if !literal.is_empty() {
        pieces.push(Piece::Text(literal));
    }
    Segment::Wild(pieces)
}

/// The patterns, validated as `validatePatterns` does and expanded.
pub struct Patterns {
    patterns: Vec<Pattern>,
}

impl Patterns {
    pub fn compile(raw: &[String]) -> Result<Patterns, ScanError> {
        if raw.len() > 8192 {
            return Err(error("SCAN_PATTERN_LIMIT", "Too many source glob patterns"));
        }
        let mut patterns = Vec::new();
        for pattern in raw {
            if pattern.len() > 4096 {
                return Err(error("SCAN_PATTERN_LIMIT", "Source glob pattern exceeds its byte limit"));
            }
            let drive = pattern.len() >= 2 && pattern.as_bytes()[0].is_ascii_alphabetic() && pattern.as_bytes()[1] == b':';
            if pattern.starts_with('/') || drive || pattern.split('/').any(|s| s == "..") || pattern.contains('\0') {
                return Err(error("SCAN_PATTERN_ESCAPE", "Source glob patterns must stay relative to the authorized root"));
            }
            if pattern.contains(['[', ']', '\\']) || ["!(", "+(", "@(", "*(", "?("].iter().any(|ext| pattern.contains(ext)) || pattern.contains("..") {
                return Err(error("SCAN_PATTERN_UNSUPPORTED", format!("The engine does not support the glob syntax of {pattern}")));
            }
            let mut expanded = Vec::new();
            let mut budget = 128usize;
            expand_braces(pattern, &mut expanded, &mut budget)?;
            for one in expanded {
                let segments: Vec<Segment> = one.split('/').filter(|s| !s.is_empty() && *s != ".").map(compile_segment).collect();
                if !segments.is_empty() {
                    patterns.push(Pattern { segments });
                }
            }
        }
        Ok(Patterns { patterns })
    }

    /// States `(pattern, segment)` with every `**` that can match nothing skipped.
    fn closure(&self, states: &mut Vec<(usize, usize)>) {
        let mut i = 0;
        while i < states.len() {
            let (p, s) = states[i];
            if self.patterns[p].segments.get(s) == Some(&Segment::Globstar) && !states.contains(&(p, s + 1)) {
                states.push((p, s + 1));
            }
            i += 1;
        }
    }

    fn step(&self, states: &[(usize, usize)], name: &str) -> Vec<(usize, usize)> {
        let mut next = Vec::new();
        for &(p, s) in states {
            let Some(segment) = self.patterns[p].segments.get(s) else { continue };
            let target = match segment {
                Segment::Globstar => (p, s),
                _ => (p, s + 1),
            };
            if segment.matches(name) && !next.contains(&target) {
                next.push(target);
            }
        }
        self.closure(&mut next);
        next
    }

    fn start(&self) -> Vec<(usize, usize)> {
        let mut states: Vec<(usize, usize)> = (0..self.patterns.len()).map(|p| (p, 0)).collect();
        self.closure(&mut states);
        states
    }

    fn accepts(&self, states: &[(usize, usize)]) -> bool {
        states.iter().any(|&(p, s)| s == self.patterns[p].segments.len())
    }

    /// Relative paths of the regular files under `root` that a pattern matches, sorted.
    pub fn enumerate(&self, root: &Path) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        if !self.patterns.is_empty() {
            self.walk(root, "", &self.start(), &mut out);
        }
        out.sort_by(|a, b| compare_code_units(&a.0, &b.0));
        out
    }

    fn walk(&self, dir: &Path, prefix: &str, states: &[(usize, usize)], out: &mut Vec<(String, u64)>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            let next = self.step(states, &name);
            if next.is_empty() {
                continue;
            }
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if file_type.is_dir() {
                if name != ".hoi4-agent" {
                    self.walk(&entry.path(), &relative, &next, out);
                }
            } else if file_type.is_file() && self.accepts(&next) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push((relative, size));
            }
        }
    }
}

/// `hiddenByReplacePath`: a later mod or dependency root replaces the folder, subfolders included.
fn hidden_by_replace_path(roots: &[Root], root: &Root, relative: &str) -> bool {
    if root.kind == RootKind::Mod {
        return false;
    }
    roots.iter().filter(|owner| matches!(owner.kind, RootKind::Mod | RootKind::Dependency) && owner.load_order > root.load_order).any(|owner| {
        owner.replace_paths.iter().any(|replace| {
            let normalized = replace.replace('\\', "/");
            let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
            let normalized = normalized.strip_suffix('/').unwrap_or(normalized);
            relative == normalized || relative.strip_prefix(normalized).is_some_and(|rest| rest.starts_with('/'))
        })
    })
}

/// `WorkspaceScanner.scan`: the files every root contributes, in load order and then path order,
/// with each file at a path some later root also has marked as shadowed.
pub fn scan(roots: &[Root], patterns: &Patterns, limits: Limits) -> Result<Vec<ScannedFile>, ScanError> {
    let mut order: Vec<usize> = (0..roots.len()).collect();
    order.sort_by(|&a, &b| {
        roots[a].load_order.cmp(&roots[b].load_order).then_with(|| compare_code_units(&roots[a].path.to_string_lossy(), &roots[b].path.to_string_lossy()))
    });
    let mut files = Vec::new();
    let mut enumerated = 0u64;
    let mut total_bytes = 0u64;
    for index in order {
        let root = &roots[index];
        let matches = patterns.enumerate(&root.path);
        enumerated += matches.len() as u64;
        if enumerated > limits.max_files {
            return Err(error("SCAN_FILE_LIMIT", format!("Scan exceeds the configured file limit of {}", limits.max_files)));
        }
        let label = root.label();
        for (relative, size) in matches {
            if hidden_by_replace_path(roots, root, &relative) {
                continue;
            }
            if size > limits.max_file_bytes || size > limits.max_bytes.saturating_sub(total_bytes) {
                return Err(error("SCAN_BYTE_LIMIT", format!("Scan exceeds the configured byte limit at {label}:{relative}")));
            }
            total_bytes += size;
            files.push(ScannedFile {
                root: index,
                kind: root.kind,
                load_order: root.load_order,
                display: format!("{label}:{relative}"),
                absolute: root.path.join(&relative),
                relative,
                size,
                shadowed_by: None,
            });
        }
    }
    files.sort_by(|a, b| a.load_order.cmp(&b.load_order).then_with(|| compare_code_units(&a.relative, &b.relative)));
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, file) in files.iter().enumerate() {
        groups.entry(file.relative.to_lowercase()).or_default().push(index);
    }
    for group in groups.values_mut() {
        if group.len() < 2 {
            continue;
        }
        group.sort_by(|&a, &b| files[b].load_order.cmp(&files[a].load_order).then_with(|| compare_code_units(&files[a].display, &files[b].display)));
        let active = group[0];
        for &shadowed in &group[1..] {
            files[shadowed].shadowed_by = Some(active);
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patterns(raw: &[&str]) -> Patterns {
        Patterns::compile(&raw.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    fn matches(p: &Patterns, path: &str) -> bool {
        let mut states = p.start();
        for name in path.split('/') {
            states = p.step(&states, name);
            if states.is_empty() {
                return false;
            }
        }
        p.accepts(&states)
    }

    #[test]
    fn globstar_braces_and_dots() {
        let p = patterns(&["common/ideas/**/*.txt", "localisation/english/**/*.{yml,yaml}", "map/**/strategicregions/**/*.txt", "common/combat_tactics.txt"]);
        assert!(matches(&p, "common/ideas/a.txt"));
        assert!(matches(&p, "common/ideas/x/y/a.txt"));
        assert!(!matches(&p, "common/ideas/a.TXT"));
        assert!(!matches(&p, "Common/ideas/a.txt"));
        assert!(!matches(&p, "common/ideas/.hidden.txt"));
        assert!(!matches(&p, "common/ideas/.git/a.txt"));
        assert!(matches(&p, "localisation/english/a_l_english.yml"));
        assert!(matches(&p, "localisation/english/sub/a.yaml"));
        assert!(matches(&p, "map/strategicregions/1.txt"));
        assert!(matches(&p, "map/x/strategicregions/1.txt"));
        assert!(matches(&p, "common/combat_tactics.txt"));
        assert!(!matches(&p, "common/combat_tactics/x.txt"));
    }

    #[test]
    fn unsafe_and_unsupported_patterns_are_refused() {
        for (raw, code) in [
            ("../x/*.txt", "SCAN_PATTERN_ESCAPE"),
            ("/abs/*.txt", "SCAN_PATTERN_ESCAPE"),
            ("C:/x", "SCAN_PATTERN_ESCAPE"),
            ("a/[ab].txt", "SCAN_PATTERN_UNSUPPORTED"),
            ("a/{1..3}.txt", "SCAN_PATTERN_UNSUPPORTED"),
        ] {
            let error = Patterns::compile(&[raw.to_string()]).err().unwrap();
            assert_eq!(error.code, code, "{raw}");
        }
    }

    #[test]
    fn replace_paths_cover_subfolders_of_earlier_roots_only() {
        let root = |kind, load_order, replace: &[&str]| Root {
            kind,
            path: PathBuf::new(),
            load_order,
            label: None,
            replace_paths: replace.iter().map(|s| s.to_string()).collect(),
        };
        let roots = [root(RootKind::Game, 0, &[]), root(RootKind::Mod, 10, &["common/ideas/"])];
        assert!(hidden_by_replace_path(&roots, &roots[0], "common/ideas/a.txt"));
        assert!(hidden_by_replace_path(&roots, &roots[0], "common/ideas/sub/a.txt"));
        assert!(!hidden_by_replace_path(&roots, &roots[0], "common/ideas_extra/a.txt"));
        assert!(!hidden_by_replace_path(&roots, &roots[1], "common/ideas/a.txt"));
    }

    #[test]
    fn code_unit_order_puts_astral_characters_before_private_use() {
        assert_eq!(compare_code_units("\u{1F600}", "\u{E000}"), Ordering::Less);
        assert_eq!(compare_code_units("a", "b"), Ordering::Less);
    }
}

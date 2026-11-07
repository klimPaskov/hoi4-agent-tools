//! `hoi4-engine mod-index` for the MCP tool `hoi4.mod_index`, and `hoi4-engine symbol-index`,
//! which prints the shared symbol index itself.
//!
//! The MCP server resolves the workspace and passes its roots, the glob patterns of its shared
//! scan and its scan ceilings. `overview` counts the definitions that are not overridden by kind,
//! the scanned files by folder (`common/<folder>` for files deeper in `common`, else the top
//! folder) and the event namespaces (`<namespace>.<1 to 9 digits>`). `next_id` counts the numbered
//! identifiers `<prefix><1 to 9 digits>` of one kind in every record, overridden ones included, so
//! a new identifier never collides with a game or dependency definition.
//!
//! The overview and `next_id` rules are ported from this repository's
//! `src/hoi4_agent_tools/reference/mod-index.ts` (`modIndex`, `namespaces`) at commit `5c75b21`; sorting
//! and the folder and namespace caps stay in that file, which now shapes this command's answer.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::symbol_index::{BuildError, Limits, Patterns, Root, SkippedSource, SymbolIndex, SymbolKind};

pub const REQUEST_SCHEMA: &str = "hoi4-mod-index-request/1";
pub const RESPONSE_SCHEMA: &str = "hoi4-mod-index/1";
pub const SYMBOLS_RESPONSE_SCHEMA: &str = "hoi4-symbol-index/1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Overview,
    NextId,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub schema: String,
    pub roots: Vec<Root>,
    pub patterns: Vec<String>,
    #[serde(default)]
    pub limits: Limits,
    /// `mod-index` only.
    #[serde(default = "overview")]
    pub mode: Mode,
    /// `next_id`: the kind whose numbered identifiers are counted.
    #[serde(default)]
    pub kind: Option<String>,
    /// `next_id`: the identifiers' prefix, such as `my_events.`.
    #[serde(default)]
    pub prefix: Option<String>,
}

fn overview() -> Mode {
    Mode::Overview
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct KindCount {
    pub kind: SymbolKind,
    pub count: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FolderTotal {
    pub folder: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Namespace {
    pub namespace: String,
    /// Distinct event numbers.
    pub events: usize,
    pub lowest: u32,
    pub highest: u32,
    /// Distinct files that define them.
    pub files: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NextId {
    /// Distinct numbers in use.
    pub used: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highest: Option<u32>,
    /// The lowest unused number below the highest one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_gap: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub schema: &'static str,
    pub status: &'static str,
    pub complete: bool,
    pub skipped_source_count: usize,
    pub skipped_sources: Vec<SkippedSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindCount>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<FolderTotal>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespaces: Option<Vec<Namespace>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<NextId>,
}

/// One record of `hoi4-engine symbol-index`.
#[derive(Debug, Serialize)]
pub struct SymbolRecord<'a> {
    pub kind: SymbolKind,
    pub id: &'a str,
    pub path: &'a str,
    #[serde(rename = "rootKind")]
    pub root_kind: &'static str,
    #[serde(rename = "loadOrder")]
    pub load_order: i64,
    pub line: u32,
    pub overridden: bool,
    #[serde(rename = "sourceShadowed")]
    pub source_shadowed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolsResponse<'a> {
    pub schema: &'static str,
    pub status: &'static str,
    pub complete: bool,
    pub files: usize,
    pub skipped_source_count: usize,
    pub skipped_sources: &'a [SkippedSource],
    pub symbols: Vec<SymbolRecord<'a>>,
}

/// A refused request, with the code the MCP tool reports.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

impl From<BuildError> for Refusal {
    fn from(error: BuildError) -> Self {
        Refusal { code: error.code, message: error.message }
    }
}

/// `<1 to 9 ASCII digits>`, as a number.
fn numbered(suffix: &str) -> Option<u32> {
    (!suffix.is_empty() && suffix.len() <= 9 && suffix.bytes().all(|b| b.is_ascii_digit())).then(|| suffix.parse().ok()).flatten()
}

/// `/^(.+)\.(\d{1,9})$/`: the namespace and number of an event id.
fn event_number(id: &str) -> Option<(&str, u32)> {
    let (namespace, number) = id.rsplit_once('.')?;
    if namespace.is_empty() || namespace.contains(crate::symbol_index::reader::is_js_line_terminator) {
        return None;
    }
    Some((namespace, numbered(number)?))
}

/// The scanned files by folder.
pub fn folders(index: &SymbolIndex) -> Vec<FolderTotal> {
    let mut totals: BTreeMap<String, (usize, u64)> = BTreeMap::new();
    for file in &index.files {
        let parts: Vec<&str> = file.relative.split('/').collect();
        let folder = if parts.len() > 2 && parts[0] == "common" { parts[..2].join("/") } else { parts[0].to_string() };
        let entry = totals.entry(folder).or_default();
        entry.0 += 1;
        entry.1 += file.size;
    }
    totals.into_iter().map(|(folder, (files, bytes))| FolderTotal { folder, files, bytes }).collect()
}

/// Definitions that are not overridden, by kind.
pub fn kinds(index: &SymbolIndex) -> Vec<KindCount> {
    let mut counts: BTreeMap<SymbolKind, usize> = BTreeMap::new();
    for symbol in index.symbols.iter().filter(|s| !s.overridden) {
        *counts.entry(symbol.kind).or_default() += 1;
    }
    counts.into_iter().map(|(kind, count)| KindCount { kind, count }).collect()
}

/// Event namespaces of the events that are not overridden.
pub fn namespaces(index: &SymbolIndex) -> Vec<Namespace> {
    let mut by_namespace: HashMap<&str, (BTreeSet<u32>, BTreeSet<u32>)> = HashMap::new();
    for symbol in index.symbols.iter().filter(|s| !s.overridden && s.kind == SymbolKind::Event) {
        if let Some((namespace, number)) = event_number(&symbol.id) {
            let entry = by_namespace.entry(namespace).or_default();
            entry.0.insert(number);
            entry.1.insert(symbol.file);
        }
    }
    let mut out: Vec<Namespace> = by_namespace
        .into_iter()
        .map(|(namespace, (numbers, files))| Namespace {
            namespace: namespace.to_string(),
            events: numbers.len(),
            lowest: numbers.first().copied().unwrap_or(0),
            highest: numbers.last().copied().unwrap_or(0),
            files: files.len(),
        })
        .collect();
    out.sort_by(|a, b| a.namespace.cmp(&b.namespace));
    out
}

/// Numbered identifiers of `kind` after `prefix` in every record.
pub fn next_id(index: &SymbolIndex, kind: SymbolKind, prefix: &str) -> NextId {
    let used: BTreeSet<u32> = index.symbols.iter().filter(|s| s.kind == kind).filter_map(|s| s.id.strip_prefix(prefix)).filter_map(numbered).collect();
    let highest = used.last().copied();
    let first_gap = highest.and_then(|highest| (1..highest).find(|n| !used.contains(n)));
    NextId { used: used.len(), highest, first_gap }
}

fn parse(text: &str) -> Result<(Request, Patterns), Refusal> {
    let request: Request = serde_json::from_str(text).map_err(|e| refuse("MOD_INDEX_INVALID_REQUEST", e.to_string()))?;
    if request.schema != REQUEST_SCHEMA {
        return Err(refuse("MOD_INDEX_INVALID_REQUEST", format!("schema must be {REQUEST_SCHEMA}")));
    }
    for root in &request.roots {
        if !root.path.is_absolute() {
            return Err(refuse("MOD_INDEX_INVALID_REQUEST", format!("root {} is not an absolute path", root.path.display())));
        }
    }
    let patterns = Patterns::compile(&request.patterns).map_err(|e| refuse(e.code, e.message))?;
    Ok((request, patterns))
}

pub fn respond(request: Request, patterns: &Patterns) -> Result<Response, Refusal> {
    let kind = match request.mode {
        Mode::Overview => None,
        Mode::NextId => {
            let name = request.kind.as_deref().unwrap_or("event");
            let kind = SymbolKind::parse(name).ok_or_else(|| refuse("MOD_INDEX_INVALID_REQUEST", format!("unknown symbol kind {name}")))?;
            let prefix =
                request.prefix.clone().filter(|p| !p.is_empty()).ok_or_else(|| refuse("MOD_INDEX_PREFIX_REQUIRED", "next_id needs prefix or namespace"))?;
            Some((kind, prefix))
        }
    };
    let index = SymbolIndex::build(request.roots, patterns, request.limits)?;
    let mut response = Response {
        schema: RESPONSE_SCHEMA,
        status: "ok",
        complete: index.complete,
        skipped_source_count: index.skipped_source_count,
        skipped_sources: index.skipped_sources.clone(),
        files: None,
        kinds: None,
        folders: None,
        namespaces: None,
        next: None,
    };
    match kind {
        None => {
            response.files = Some(index.files.len());
            response.kinds = Some(kinds(&index));
            response.folders = Some(folders(&index));
            response.namespaces = Some(namespaces(&index));
        }
        Some((kind, prefix)) => response.next = Some(next_id(&index, kind, &prefix)),
    }
    Ok(response)
}

fn invalid(refusal: &Refusal, schema: &str) -> String {
    serde_json::json!({ "schema": schema, "status": "invalid", "error": { "code": refusal.code, "message": refusal.message } }).to_string()
}

/// `hoi4-engine mod-index`: the JSON response and the exit code (0, or 2 for a refused request).
pub fn respond_json(text: &str) -> (String, u8) {
    let result = parse(text).and_then(|(request, patterns)| respond(request, &patterns));
    match result {
        Ok(response) => match serde_json::to_string(&response) {
            Ok(json) => (json, 0),
            Err(e) => (invalid(&refuse("MOD_INDEX_INTERNAL", e.to_string()), RESPONSE_SCHEMA), 2),
        },
        Err(refusal) => (invalid(&refusal, RESPONSE_SCHEMA), 2),
    }
}

/// `hoi4-engine symbol-index`: every record of the shared symbol index.
pub fn respond_symbols_json(text: &str) -> (String, u8) {
    let built = parse(text).and_then(|(request, patterns)| SymbolIndex::build(request.roots, &patterns, request.limits).map_err(Refusal::from));
    let index = match built {
        Ok(index) => index,
        Err(refusal) => return (invalid(&refusal, SYMBOLS_RESPONSE_SCHEMA), 2),
    };
    let symbols = index
        .symbols
        .iter()
        .map(|s| {
            let file = &index.files[s.file as usize];
            SymbolRecord {
                kind: s.kind,
                id: &s.id,
                path: &file.display,
                root_kind: file.kind.as_str(),
                load_order: file.load_order,
                line: s.line,
                overridden: s.overridden,
                source_shadowed: s.source_shadowed,
            }
        })
        .collect();
    let response = SymbolsResponse {
        schema: SYMBOLS_RESPONSE_SCHEMA,
        status: "ok",
        complete: index.complete,
        files: index.files.len(),
        skipped_source_count: index.skipped_source_count,
        skipped_sources: &index.skipped_sources,
        symbols,
    };
    match serde_json::to_string(&response) {
        Ok(json) => (json, 0),
        Err(e) => (invalid(&refuse("MOD_INDEX_INTERNAL", e.to_string()), SYMBOLS_RESPONSE_SCHEMA), 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_numbers_follow_the_typescript_pattern() {
        assert_eq!(event_number("a.b.12"), Some(("a.b", 12)));
        assert_eq!(event_number("ns.007"), Some(("ns", 7)));
        assert_eq!(event_number("ns.1234567890"), None);
        assert_eq!(event_number(".1"), None);
        assert_eq!(event_number("ns.1a"), None);
    }
}

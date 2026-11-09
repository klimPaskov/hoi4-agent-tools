//! `hoi4-engine source-lookup` for the MCP tool `hoi4.source_lookup` (ADR 0082): the definitions of
//! one symbol, the revision of the scan they come from, and the near-miss names a missed lookup
//! suggests.
//!
//! The MCP server resolves the workspace and passes its roots, the glob patterns of its scan and its
//! ceilings, as it does for `mod-index` (ADR 0080). The engine builds the shared symbol index and
//! answers from it. The server reads the chosen definitions' files itself for the lines and the
//! nested navigation, so the engine never returns source text.
//!
//! Ported from this repository's `src/hoi4_agent_tools/reference/source-lookup.ts` (the definition
//! match and its order), `reference/suggestions.ts` (`editDistance`, `nearestNames`) and
//! `core/engine.ts` (the scan `revision`) at commit `70b6f81`. The server finishes the near-miss
//! ordering with the same locale comparison the TypeScript route used, so the engine returns every
//! candidate of the nearest distances and the server picks the five.

use std::collections::HashSet;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::symbol_index::{BuildError, Limits, Patterns, Root, SymbolIndex, SymbolKind};

pub const REQUEST_SCHEMA: &str = "hoi4-source-lookup-request/1";
pub const RESPONSE_SCHEMA: &str = "hoi4-source-lookup/1";

/// `MAX_DISTANCE` of `suggestions.ts`.
const MAX_DISTANCE: usize = 3;
/// `options.budget` of `nearestNames`: distance computations per lookup.
const SUGGESTION_BUDGET: usize = 20_000;
/// The suggestions a lookup shows.
const SUGGESTION_LIMIT: usize = 5;
/// Candidates returned at most, whatever their distances.
const CANDIDATE_CEILING: usize = 2_000;
/// `target.length > 128` of `nearestNames`.
const TARGET_LIMIT: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub schema: String,
    pub roots: Vec<Root>,
    pub patterns: Vec<String>,
    #[serde(default)]
    pub limits: Limits,
    pub symbol: String,
    /// Only definitions of this kind.
    #[serde(default)]
    pub kind: Option<String>,
    /// Definitions returned at most (the total is always counted).
    #[serde(default = "one")]
    pub max_definitions: usize,
}

fn one() -> usize {
    1
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition<'a> {
    pub kind: SymbolKind,
    pub id: &'a str,
    pub path: &'a str,
    pub root_kind: &'static str,
    pub load_order: i64,
    pub overridden: bool,
    pub source_shadowed: bool,
    /// 0 for a record that has no line (the map tables).
    pub start_line: u32,
    pub end_line: u32,
    /// The file the server reads the definition's lines from.
    pub absolute_path: String,
    /// SHA-256 of that file as scanned, so the server refuses a file that changed since.
    pub sha256: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub distance: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response<'a> {
    pub schema: &'static str,
    pub status: &'static str,
    /// `ScanSnapshot.revision` of the scanned files.
    pub revision: String,
    pub complete: bool,
    pub skipped_source_count: usize,
    /// Every definition of the symbol, overridden ones included.
    pub definition_count: usize,
    /// Distinct kinds among them.
    pub kind_count: usize,
    pub definitions: Vec<Definition<'a>>,
    /// When nothing defines the symbol: indexed ids within three edits, nearest distances first.
    pub suggestion_candidates: Vec<Candidate>,
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

/// `editDistance`: Levenshtein distance over UTF-16 code units, `MAX_DISTANCE + 1` once every
/// cell of a row exceeds three edits.
pub fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, &left) in a.iter().enumerate() {
        let mut next = Vec::with_capacity(b.len() + 1);
        next.push(i + 1);
        for (j, &right) in b.iter().enumerate() {
            let value = (next[j] + 1).min(row[j + 1] + 1).min(row[j] + usize::from(left != right));
            next.push(value);
        }
        if next.iter().copied().min().unwrap_or(0) > MAX_DISTANCE {
            return MAX_DISTANCE + 1;
        }
        row = next;
    }
    row[b.len()]
}

/// The candidates of `nearestNames` before its final ordering: ids within three edits, found in
/// the index's order under the same budget, then cut to the nearest distances that give at least
/// five names (every name of the last distance stays, so the server's tie-break sees them all).
pub fn near_candidates<'a>(target: &str, ids: impl Iterator<Item = &'a str>) -> Vec<Candidate> {
    let target_units: Vec<u16> = target.encode_utf16().collect();
    if target_units.len() > TARGET_LIMIT {
        return Vec::new();
    }
    let mut budget = SUGGESTION_BUDGET;
    let mut scored: Vec<Candidate> = Vec::new();
    for candidate in ids {
        let units: Vec<u16> = candidate.encode_utf16().collect();
        if candidate == target || units.len().abs_diff(target_units.len()) > MAX_DISTANCE {
            continue;
        }
        if budget == 0 {
            break;
        }
        budget -= 1;
        let distance = edit_distance(&target_units, &units);
        if distance <= MAX_DISTANCE {
            scored.push(Candidate { id: candidate.to_string(), distance });
        }
    }
    scored.sort_by_key(|c| c.distance);
    let mut cut = scored.len();
    if scored.len() > SUGGESTION_LIMIT {
        let last = scored[SUGGESTION_LIMIT - 1].distance;
        cut = scored.iter().take_while(|c| c.distance <= last).count();
    }
    scored.truncate(cut.min(CANDIDATE_CEILING));
    scored
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 15)] as char);
    }
    out
}

/// `path.join(root, relative)` as Node spells it on this platform.
fn node_path(file: &crate::symbol_index::ScannedFile) -> String {
    let joined = file.absolute.to_string_lossy().into_owned();
    if cfg!(windows) { joined.replace('/', "\\") } else { joined }
}

/// `ScanSnapshot.revision`: SHA-256 of the canonical JSON of every scanned file's identity and
/// content hash, in scan order (`hashCanonical` over `absolutePath`, `displayPath`, `relativePath`,
/// `rootKind`, `loadOrder`, `shadowedBy` and `sha256`, keys sorted).
pub fn revision(index: &SymbolIndex) -> Result<(String, Vec<String>), BuildError> {
    let hashes: Vec<Result<String, BuildError>> = index
        .files
        .par_iter()
        .map(|file| {
            let bytes =
                std::fs::read(&file.absolute).map_err(|e| BuildError { code: "SCAN_READ_FAILED", message: format!("cannot read {}: {e}", file.display) })?;
            Ok(hex(&Sha256::digest(&bytes)))
        })
        .collect();
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_default();
    let hashes = hashes.into_iter().collect::<Result<Vec<String>, BuildError>>()?;
    let mut json = String::from("[");
    for (i, (file, hash)) in index.files.iter().zip(&hashes).enumerate() {
        if i > 0 {
            json.push(',');
        }
        let shadowed = match file.shadowed_by {
            Some(active) => quote(&index.files[active].display),
            None => "null".to_string(),
        };
        json.push_str(&format!(
            "{{\"absolutePath\":{},\"displayPath\":{},\"loadOrder\":{},\"relativePath\":{},\"rootKind\":{},\"sha256\":{},\"shadowedBy\":{}}}",
            quote(&node_path(file)),
            quote(&file.display),
            file.load_order,
            quote(&file.relative),
            quote(file.kind.as_str()),
            quote(hash),
            shadowed,
        ));
    }
    json.push(']');
    Ok((hex(&Sha256::digest(json.as_bytes())), hashes))
}

fn parse(text: &str) -> Result<(Request, Patterns), Refusal> {
    let request: Request = serde_json::from_str(text).map_err(|e| refuse("SOURCE_LOOKUP_INVALID_REQUEST", e.to_string()))?;
    if request.schema != REQUEST_SCHEMA {
        return Err(refuse("SOURCE_LOOKUP_INVALID_REQUEST", format!("schema must be {REQUEST_SCHEMA}")));
    }
    for root in &request.roots {
        if !root.path.is_absolute() {
            return Err(refuse("SOURCE_LOOKUP_INVALID_REQUEST", format!("root {} is not an absolute path", root.path.display())));
        }
    }
    let patterns = Patterns::compile(&request.patterns).map_err(|e| refuse(e.code, e.message))?;
    Ok((request, patterns))
}

/// The records of the map tables carry no lines in the TypeScript index (no `location`), so the
/// answer names none either.
fn has_lines(kind: SymbolKind) -> bool {
    !matches!(kind, SymbolKind::Province | SymbolKind::ProvinceColor | SymbolKind::Adjacency | SymbolKind::SupplyNode | SymbolKind::Railway)
}

/// The answer over a built index.
pub fn answer<'a>(index: &'a SymbolIndex, request: &Request, kind: Option<SymbolKind>) -> Result<Response<'a>, Refusal> {
    let mut matched: Vec<&crate::symbol_index::Symbol> = index.symbols.iter().filter(|s| s.id == request.symbol && kind.is_none_or(|k| s.kind == k)).collect();
    // Active definitions first, then the highest load order; equal ones keep the index's order.
    matched.sort_by(|a, b| {
        let (left, right) = (&index.files[a.file as usize], &index.files[b.file as usize]);
        a.overridden.cmp(&b.overridden).then_with(|| right.load_order.cmp(&left.load_order))
    });
    let kinds: HashSet<SymbolKind> = matched.iter().map(|s| s.kind).collect();
    let (revision, hashes) = revision(index)?;
    let definitions = matched
        .iter()
        .take(request.max_definitions.max(1))
        .map(|s| {
            let file = &index.files[s.file as usize];
            Definition {
                kind: s.kind,
                id: &s.id,
                path: &file.display,
                root_kind: file.kind.as_str(),
                load_order: file.load_order,
                overridden: s.overridden,
                source_shadowed: s.source_shadowed,
                start_line: if has_lines(s.kind) { s.line } else { 0 },
                end_line: if has_lines(s.kind) { s.end_line } else { 0 },
                absolute_path: node_path(file),
                sha256: hashes[s.file as usize].clone(),
            }
        })
        .collect();
    let suggestion_candidates = if matched.is_empty() {
        let mut seen: HashSet<&str> = HashSet::new();
        let ids = index.symbols.iter().filter(|s| kind.is_none_or(|k| s.kind == k)).map(|s| s.id.as_str()).filter(|id| seen.insert(id));
        near_candidates(&request.symbol, ids)
    } else {
        Vec::new()
    };
    Ok(Response {
        schema: RESPONSE_SCHEMA,
        status: "ok",
        revision,
        complete: index.complete,
        skipped_source_count: index.skipped_source_count,
        definition_count: matched.len(),
        kind_count: kinds.len(),
        definitions,
        suggestion_candidates,
    })
}

fn invalid(refusal: &Refusal) -> String {
    serde_json::json!({ "schema": RESPONSE_SCHEMA, "status": "invalid", "error": { "code": refusal.code, "message": refusal.message } }).to_string()
}

/// `hoi4-engine source-lookup`: the JSON response and the exit code (0, or 2 for a refused request).
pub fn respond_json(text: &str) -> (String, u8) {
    let result = parse(text).and_then(|(request, patterns)| {
        let kind = match request.kind.as_deref() {
            None => None,
            Some(name) => Some(SymbolKind::parse(name).ok_or_else(|| refuse("SOURCE_LOOKUP_INVALID_REQUEST", format!("unknown symbol kind {name}")))?),
        };
        let index = SymbolIndex::build(request.roots.clone(), &patterns, request.limits)?;
        answer(&index, &request, kind).and_then(|response| serde_json::to_string(&response).map_err(|e| refuse("SOURCE_LOOKUP_INTERNAL", e.to_string())))
    });
    match result {
        Ok(json) => (json, 0),
        Err(refusal) => (invalid(&refusal), 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn edit_distance_follows_the_typescript_cutoff() {
        assert_eq!(edit_distance(&units("kitten"), &units("sitten")), 1);
        assert_eq!(edit_distance(&units("abc"), &units("abc")), 0);
        assert_eq!(edit_distance(&units("abcdef"), &units("uvwxyz")), MAX_DISTANCE + 1);
        assert_eq!(edit_distance(&units(""), &units("abc")), 3);
    }

    #[test]
    fn candidates_skip_the_target_and_far_lengths() {
        let ids = ["alpha_1", "alpha_2", "alpha_12", "beta", "alpha_1"];
        let found = near_candidates("alpha_1", ids.iter().copied());
        let names: Vec<&str> = found.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(names, ["alpha_2", "alpha_12"]);
        assert!(found.iter().all(|c| c.distance == 1));
    }

    #[test]
    fn candidates_keep_every_name_of_the_last_distance() {
        let ids: Vec<String> = (0..10).map(|n| format!("name_{n}x")).collect();
        let found = near_candidates("name_zz", ids.iter().map(String::as_str));
        assert_eq!(found.len(), 10);
        let long = "x".repeat(129);
        assert!(near_candidates(&long, ids.iter().map(String::as_str)).is_empty());
    }

    #[test]
    fn a_request_names_its_refusal() {
        let (json, code) = respond_json("{\"schema\":\"hoi4-source-lookup-request/1\",\"roots\":[],\"patterns\":[],\"symbol\":\"x\",\"kind\":\"nope\"}");
        assert_eq!(code, 2);
        assert!(json.contains("SOURCE_LOOKUP_INVALID_REQUEST"));
        let (json, code) = respond_json("not json");
        assert_eq!(code, 2);
        assert!(json.contains("SOURCE_LOOKUP_INVALID_REQUEST"));
    }
}

//! `hoi4-engine closure` for the closure option of the MCP tool `hoi4.script_validate` (ADR 0083):
//! whether every definition the mod's own sources point at is there.
//!
//! The command builds the shared symbol index over the same roots and patterns as `source-lookup`,
//! keeps every reference the mod's own, unshadowed sources record (the definition walk's and the
//! semantic scan's), and counts them per target kind:
//!
//! - **resolved**: an active definition of that kind and id exists (a localisation key in any
//!   language counts), or the reference is a write of a variable, flag or event target, or a read of
//!   one that some scanned source writes;
//! - **unresolved**: no definition exists, and no skipped source could define that kind;
//! - **unknown**: the target cannot be named statically (`event_target:` chains, `$VAR$` arguments,
//!   unidentifiable state keys), a skipped source could define the kind, or a read of a variable,
//!   flag or event target has no writer in the scanned sources (a writer in a file the scan does not
//!   read cannot be ruled out).
//!
//! The verdict is `incomplete` whenever anything is unknown or the index or the semantic scan is
//! partial, `unresolved` when only unresolved references remain, and `closed` otherwise.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/index.ts` (`unresolvedReferences`, the
//! `INDEX_UNRESOLVED_REFERENCE` and `INDEX_UNRESOLVED_REFERENCE_PARTIAL` diagnostics of `finalize`)
//! at commit `20fdb4a`; the per-kind counts, the state-key rule and the verdict are new.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::source_lookup::{Refusal, revision};
use crate::symbol_index::{Limits, Patterns, References, Root, SymbolIndex, SymbolKind, compare_code_units, semantic};

pub const REQUEST_SCHEMA: &str = "hoi4-closure-request/1";
pub const RESPONSE_SCHEMA: &str = "hoi4-closure/1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub schema: String,
    pub roots: Vec<Root>,
    pub patterns: Vec<String>,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq, Clone, Copy)]
pub struct Counts {
    pub resolved: usize,
    pub unresolved: usize,
    pub unknown: usize,
}

#[derive(Debug, Serialize)]
pub struct KindCounts {
    pub kind: SymbolKind,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub schema: &'static str,
    pub status: &'static str,
    /// `ScanSnapshot.revision` of the scanned files.
    pub revision: String,
    pub complete: bool,
    pub skipped_source_count: usize,
    /// False when the semantic scan skipped a source or reached a ceiling.
    pub semantic_complete: bool,
    /// `closed`, `unresolved` or `incomplete`.
    pub verdict: &'static str,
    /// Mod-owned, unshadowed sources the references come from.
    pub sources: usize,
    pub totals: Counts,
    /// Kinds with at least one reference, by name.
    pub kinds: Vec<KindCounts>,
}

fn refuse(message: impl Into<String>) -> Refusal {
    Refusal { code: "CLOSURE_INVALID_REQUEST", message: message.into() }
}

fn parse(text: &str) -> Result<(Request, Patterns), Refusal> {
    let request: Request = serde_json::from_str(text).map_err(|e| refuse(e.to_string()))?;
    if request.schema != REQUEST_SCHEMA {
        return Err(refuse(format!("schema must be {REQUEST_SCHEMA}")));
    }
    for root in &request.roots {
        if !root.path.is_absolute() {
            return Err(refuse(format!("root {} is not an absolute path", root.path.display())));
        }
    }
    let patterns = Patterns::compile(&request.patterns).map_err(|e| Refusal { code: e.code, message: e.message })?;
    Ok((request, patterns))
}

fn is_state_kind(kind: SymbolKind) -> bool {
    matches!(kind, SymbolKind::Variable | SymbolKind::Flag | SymbolKind::EventTarget)
}

/// The closure of an index.
pub fn answer(index: &SymbolIndex) -> Result<Response, Refusal> {
    let scan = semantic::scan(index, References::OwnFiles)?;
    let defined: HashSet<(SymbolKind, &str)> = index.symbols.iter().filter(|s| s.active).map(|s| (s.kind, s.id.as_str())).collect();
    // Localisation ids are `language:key`; a reference names the key.
    let localised: HashSet<&str> =
        index.symbols.iter().filter(|s| s.active && s.kind == SymbolKind::Localisation).filter_map(|s| s.id.split_once(':').map(|(_, key)| key)).collect();
    let mut kinds: BTreeMap<SymbolKind, Counts> = BTreeMap::new();
    let mut seen: HashSet<(u32, u32, SymbolKind, String, String)> = HashSet::new();
    let mut sources: HashSet<u32> = HashSet::new();
    for (file, reference) in index.references.iter().chain(scan.references.iter()) {
        if !seen.insert((*file, reference.offset, reference.to_kind, reference.to.clone(), reference.kind.to_string())) {
            continue;
        }
        sources.insert(*file);
        let counts = kinds.entry(reference.to_kind).or_default();
        let kind = reference.to_kind;
        if is_state_kind(kind) {
            // A write defines its key; a read resolves when some scanned source writes it.
            if reference.kind.ends_with("_write") || scan.writes.contains(&(kind, reference.to.clone())) {
                counts.resolved += 1;
            } else {
                counts.unknown += 1;
            }
            continue;
        }
        let exists =
            if kind == SymbolKind::Localisation { localised.contains(reference.to.as_str()) } else { defined.contains(&(kind, reference.to.as_str())) };
        if exists {
            counts.resolved += 1;
        } else if index.skipped_possible_kinds.contains(&kind) {
            counts.unknown += 1;
        } else {
            counts.unresolved += 1;
        }
    }
    for kind in &scan.unresolved_kinds {
        kinds.entry(*kind).or_default().unknown += 1;
    }
    let mut totals = Counts::default();
    for counts in kinds.values() {
        totals.resolved += counts.resolved;
        totals.unresolved += counts.unresolved;
        totals.unknown += counts.unknown;
    }
    let verdict = if totals.unknown > 0 || !index.complete || !scan.complete {
        "incomplete"
    } else if totals.unresolved > 0 {
        "unresolved"
    } else {
        "closed"
    };
    let (revision, _) = revision(index)?;
    let mut kinds: Vec<KindCounts> = kinds.into_iter().map(|(kind, counts)| KindCounts { kind, counts }).collect();
    kinds.sort_by(|a, b| compare_code_units(a.kind.as_str(), b.kind.as_str()));
    Ok(Response {
        schema: RESPONSE_SCHEMA,
        status: "ok",
        revision,
        complete: index.complete,
        skipped_source_count: index.skipped_source_count,
        semantic_complete: scan.complete,
        verdict,
        sources: sources.len(),
        totals,
        kinds,
    })
}

fn invalid(refusal: &Refusal) -> String {
    serde_json::json!({ "schema": RESPONSE_SCHEMA, "status": "invalid", "error": { "code": refusal.code, "message": refusal.message } }).to_string()
}

/// `hoi4-engine closure`: the JSON response and the exit code (0, or 2 for a refused request).
pub fn respond_json(text: &str) -> (String, u8) {
    let result = parse(text).and_then(|(request, patterns)| {
        let index = SymbolIndex::build_for(request.roots.clone(), &patterns, request.limits, References::OwnFiles)?;
        answer(&index).and_then(|response| serde_json::to_string(&response).map_err(|e| Refusal { code: "CLOSURE_INTERNAL", message: e.to_string() }))
    });
    match result {
        Ok(json) => (json, 0),
        Err(refusal) => (invalid(&refusal), 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_names_its_refusal() {
        let (json, code) = respond_json("not json");
        assert_eq!(code, 2);
        assert!(json.contains("CLOSURE_INVALID_REQUEST"));
        let (json, code) = respond_json("{\"schema\":\"other/1\",\"roots\":[],\"patterns\":[]}");
        assert_eq!(code, 2);
        assert!(json.contains("schema must be"));
    }
}

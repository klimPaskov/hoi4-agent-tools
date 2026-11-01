//! Hash-guarded span repair plans.
//!
//! Provenance: adapted from Hagane Studio, `internal/hoi4/clausewitz/crossref.go`
//! (`PlanCrossRefRepair`, `ApplyCrossRefRepair`) at hagane-works/hagane-studio
//! 1e831623ed162e1a64763c242c55b249376ba20c, GPL-3.0-only. The copyright holder gave the
//! maintainer written permission to use the project in any way, including under this
//! repository's Apache-2.0 licence (maintainer decision D-05). Kept: a plan records the source
//! hash and the exact text it replaces, applying refuses when either changed, and deleting an
//! assignment under boolean logic is refused because it can change what the trigger means.
//! Changed: spans are byte offsets on the lossless parser instead of rune offsets, and plans are
//! data for a caller (HOI4 Factory proposals); the command-line interface never applies them.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use hoi4_syntax::{Block, Document};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    ReplaceTarget,
    DeleteAssignment,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairPlan {
    pub action: Action,
    pub applicable: bool,
    pub start: u32,
    pub end: u32,
    pub before: String,
    pub after: String,
    pub source_sha256: String,
    pub reason: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn span_text(source: &[u8], start: u32, end: u32) -> Result<String, String> {
    if start > end || end as usize > source.len() {
        return Err("span lies outside the source".into());
    }
    std::str::from_utf8(&source[start as usize..end as usize]).map(str::to_string).map_err(|_| "span is not valid UTF-8".into())
}

/// Plans replacing the reference at `start..end`, which must read `target`, with `replacement`.
pub fn plan_replace(source: &[u8], start: u32, end: u32, target: &str, replacement: &str) -> Result<RepairPlan, String> {
    if replacement.is_empty() {
        return Err("replacement must not be empty".into());
    }
    let before = span_text(source, start, end)?;
    if before != target {
        return Err(format!("span reads `{before}`, not `{target}`"));
    }
    Ok(RepairPlan {
        action: Action::ReplaceTarget,
        applicable: true,
        start,
        end,
        before,
        after: replacement.to_string(),
        source_sha256: sha256_hex(source),
        reason: format!("replace `{target}` with `{replacement}`"),
    })
}

/// Keys whose children combine as boolean logic. Deleting one child changes the result.
const BOOLEAN_KEYS: &[&str] = &["NOT", "OR", "AND", "not", "or", "and", "count_triggers", "any_of", "all_of"];

/// The byte range of the innermost entry starting at `offset` (its key), and the boolean keys
/// above it, outermost first.
pub fn locate_assignment(doc: &Document, offset: u32) -> Option<(u32, u32, Vec<String>)> {
    fn walk(doc: &Document, block: &Block, offset: u32, ancestry: &mut Vec<String>) -> Option<(u32, u32, Vec<String>)> {
        for entry in block.entries() {
            let range = doc.byte_range(&entry.tokens);
            if offset < range.start || offset >= range.end {
                continue;
            }
            if doc.token(entry.key).start == offset {
                return Some((range.start, range.end, ancestry.clone()));
            }
            if let Some(inner) = entry.value.as_block() {
                let key = doc.key(entry).into_owned();
                let pushed = BOOLEAN_KEYS.contains(&key.as_str());
                if pushed {
                    ancestry.push(key);
                }
                let found = walk(doc, inner, offset, ancestry);
                if pushed {
                    ancestry.pop();
                }
                return found;
            }
        }
        None
    }
    walk(doc, &doc.root, offset, &mut Vec::new())
}

/// Plans deleting the assignment whose key starts at `key_offset`.
pub fn plan_delete(doc: &Document, key_offset: u32) -> Result<RepairPlan, String> {
    let (start, end, ancestry) = locate_assignment(doc, key_offset).ok_or("no assignment starts at that offset")?;
    let before = span_text(&doc.bytes, start, end)?;
    let source_sha256 = sha256_hex(&doc.bytes);
    if !ancestry.is_empty() {
        return Ok(RepairPlan {
            action: Action::DeleteAssignment,
            applicable: false,
            start,
            end,
            after: before.clone(),
            before,
            source_sha256,
            reason: format!("automatic deletion refused because boolean ancestry may change semantics: {}", ancestry.join(" > ")),
        });
    }
    Ok(RepairPlan {
        action: Action::DeleteAssignment,
        applicable: true,
        start,
        end,
        before,
        after: String::new(),
        source_sha256,
        reason: "delete the assignment".into(),
    })
}

pub fn apply(source: &[u8], plan: &RepairPlan) -> Result<Vec<u8>, String> {
    if !plan.applicable {
        return Err(format!("repair plan is not applicable: {}", plan.reason));
    }
    if sha256_hex(source) != plan.source_sha256 {
        return Err("repair source changed after the plan was created".into());
    }
    if span_text(source, plan.start, plan.end)? != plan.before {
        return Err("repair span content changed after planning".into());
    }
    let mut out = Vec::with_capacity(source.len() + plan.after.len());
    out.extend_from_slice(&source[..plan.start as usize]);
    out.extend_from_slice(plan.after.as_bytes());
    out.extend_from_slice(&source[plan.end as usize..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "option = {\n\tcountry_event = my_evnt.1\n\tlimit = { NOT = { has_flg = yes } }\n\tremove_me = yes\n}\n";

    #[test]
    fn replaces_a_reference_and_refuses_stale_sources() {
        let start = SRC.find("my_evnt.1").unwrap() as u32;
        let end = start + "my_evnt.1".len() as u32;
        let plan = plan_replace(SRC.as_bytes(), start, end, "my_evnt.1", "my_event.1").unwrap();
        let fixed = apply(SRC.as_bytes(), &plan).unwrap();
        assert_eq!(String::from_utf8(fixed).unwrap(), SRC.replace("my_evnt.1", "my_event.1"));

        let edited = SRC.replace("remove_me", "remove_it");
        assert!(apply(edited.as_bytes(), &plan).unwrap_err().contains("changed after the plan"));
        assert!(plan_replace(SRC.as_bytes(), start, end, "other", "x").is_err());
    }

    #[test]
    fn deletion_under_boolean_logic_is_refused() {
        let doc = Document::parse(SRC.as_bytes().to_vec());
        let inside_not = SRC.find("has_flg").unwrap() as u32;
        let plan = plan_delete(&doc, inside_not).unwrap();
        assert!(!plan.applicable);
        assert!(plan.reason.contains("NOT"));
        assert!(apply(SRC.as_bytes(), &plan).is_err());

        let plain = SRC.find("remove_me").unwrap() as u32;
        let plan = plan_delete(&doc, plain).unwrap();
        assert!(plan.applicable);
        assert_eq!(plan.before, "remove_me = yes");
        let out = String::from_utf8(apply(SRC.as_bytes(), &plan).unwrap()).unwrap();
        assert!(!out.contains("remove_me"));
    }
}

//! The stated map baseline of ADR 0090 (issue 272): the fingerprint of a map's untouched source,
//! and the footprint of a write, which decides whether a pre-existing finding belongs to anything
//! the write touches.
//!
//! Ported from `src/hoi4_agent_tools/map/baseline.ts` (`MAP_BASELINE_DIAGNOSTIC_LIMIT`,
//! `mapBaselineFingerprint`, `mapWriteFootprint`), commit `9b7dc80d`. The map writer (packet
//! P13b) applies the footprint; this module computes it.

use std::collections::{HashMap, HashSet};

use hoi4_core::canonical::{compare_code_units, hash_canonical};
use hoi4_core::diagnostics::Diagnostic;
use serde_json::{Value, json};

use crate::model::MapIndex;
use crate::parse::records::ProvinceDefinition;

/// The validation detail ceiling of a write with a stated baseline: the comparison needs every
/// finding.
pub const MAP_BASELINE_DIAGNOSTIC_LIMIT: usize = 50_000;

/// Whether a stated fingerprint has the shape of one (a lowercase hex SHA-256).
pub fn is_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One scanned source of the fingerprint.
pub struct FingerprintSource<'a> {
    pub display_path: &'a str,
    pub load_order: u32,
    pub sha256: &'a str,
}

/// `mapBaselineFingerprint`: the tool version and the hash of every scanned map source. Equal
/// fingerprints mean equal findings of a full validation, however many a result lists.
pub fn fingerprint(sources: &[FingerprintSource], tool_version: &str) -> String {
    let mut sorted: Vec<&FingerprintSource> = sources.iter().collect();
    sorted.sort_by(|a, b| a.load_order.cmp(&b.load_order).then_with(|| compare_code_units(a.display_path, b.display_path)));
    let sources: Vec<Value> = sorted.iter().map(|s| json!({ "displayPath": s.display_path, "loadOrder": s.load_order, "sha256": s.sha256 })).collect();
    hash_canonical(&json!({ "schema": "hoi4.map-baseline.v1", "toolVersion": tool_version, "sources": sources }))
}

/// The fingerprint of an index's scanned files.
pub fn index_fingerprint(index: &MapIndex, tool_version: &str) -> String {
    let sources: Vec<FingerprintSource> = index.files.iter().map(|f| FingerprintSource { display_path: &f.display_path, load_order: f.load_order, sha256: &f.sha256 }).collect();
    fingerprint(&sources, tool_version)
}

/// Keys of diagnostic details that name provinces by id.
const PROVINCE_DETAIL_KEYS: [&str; 4] = ["province", "provinceId", "provinceIds", "provinces"];

fn same_definition(left: &ProvinceDefinition, right: &ProvinceDefinition) -> bool {
    left.color == right.color && left.kind == right.kind && left.coastal == right.coastal && left.terrain == right.terrain && left.continent == right.continent
}

fn province_ids_in(value: &Value, into: &mut Vec<i64>) {
    match value {
        Value::Number(number) => {
            if let Some(id) = number.as_i64() {
                into.push(id);
            } else if let Some(f) = number.as_f64()
                && f.fract() == 0.0
            {
                into.push(f as i64);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| province_ids_in(item, into)),
        _ => {}
    }
}

/// The objects a map write changes (`MapWriteFootprint`).
pub struct Footprint<'n> {
    /// Workspace-relative paths the write changes, normalized as diagnostic paths are.
    pub changed_paths: HashSet<String>,
    /// Provinces whose definition row or pixels the write changes, added or removed included.
    pub touched_provinces: HashSet<i64>,
    /// Every province counts as touched (the bitmap changed size or could not be compared).
    pub all_provinces: bool,
    definition_rows: HashMap<String, HashMap<usize, i64>>,
    normalize: Box<dyn Fn(&str) -> Option<String> + 'n>,
}

impl Footprint<'_> {
    fn province_touched(&self, id: i64) -> bool {
        self.all_provinces || self.touched_provinces.contains(&id)
    }

    /// Whether a finding belongs to anything the write touches. `paths` are the workspace paths
    /// its details name.
    pub fn touches(&self, diagnostic: &Diagnostic, paths: &HashSet<String>) -> bool {
        let locations: Vec<_> = diagnostic.location.iter().chain(diagnostic.related.iter().flatten()).collect();
        let mut named = Vec::new();
        for (key, value) in diagnostic.details.iter().flatten() {
            if PROVINCE_DETAIL_KEYS.contains(&key.as_str()) {
                province_ids_in(value, &mut named);
            }
        }
        if locations.is_empty() && named.is_empty() {
            return true;
        }
        if named.iter().any(|&id| self.province_touched(id)) {
            return true;
        }
        let mut located = HashSet::new();
        for location in locations {
            let Some(path) = (self.normalize)(&location.path) else {
                // A location that is no workspace path cannot be matched against the write.
                if !self.changed_paths.is_empty() {
                    return true;
                }
                continue;
            };
            located.insert(path.clone());
            if !self.changed_paths.contains(&path) {
                continue;
            }
            let province = self.definition_rows.get(&path).and_then(|rows| rows.get(&(location.start.line as usize)));
            match province {
                Some(&id) if !self.province_touched(id) => {}
                _ => return true,
            }
        }
        // Paths named only in the details (not as a location) are whole files.
        paths.iter().any(|p| !located.contains(p) && self.changed_paths.contains(p))
    }
}

/// `mapWriteFootprint`: the footprint of a write that turns `before` into `after` by changing
/// `changed_paths`.
pub fn footprint<'n>(before: &MapIndex, after: &MapIndex, changed_paths: HashSet<String>, normalize: impl Fn(&str) -> Option<String> + 'n) -> Footprint<'n> {
    let mut touched = HashSet::new();
    for &id in &after.definition_ids_in_order {
        let (Some(definition), previous) = (after.definition(id), before.definition(id)) else { continue };
        if previous.is_none_or(|p| !same_definition(p, definition)) {
            touched.insert(id);
        }
    }
    for &id in &before.definition_ids_in_order {
        if after.definition(id).is_none() {
            touched.insert(id);
        }
    }
    let file_of = |index: &MapIndex| index.province_bitmap_file.map(|f| (index.file(f).sha256.clone(), index.file(f).display_path.clone()));
    let mut all = false;
    if file_of(before) != file_of(after) {
        match (&before.raster, &after.raster) {
            (Some(left), Some(right)) if left.width() == right.width() && left.height() == right.height() => {
                for (&was, &is) in left.inner.province_ids.iter().zip(&right.inner.province_ids) {
                    if was == is {
                        continue;
                    }
                    if was >= 0 {
                        touched.insert(i64::from(was));
                    }
                    if is >= 0 {
                        touched.insert(i64::from(is));
                    }
                }
            }
            _ => all = true,
        }
    }
    let mut definition_rows: HashMap<String, HashMap<usize, i64>> = HashMap::new();
    for definition in &after.definitions_across_roots {
        let Some(path) = normalize(&after.documents[definition.document].path) else { continue };
        definition_rows.entry(path).or_default().insert(definition.line, definition.id);
    }
    Footprint { changed_paths, touched_provinces: touched, all_provinces: all, definition_rows, normalize: Box::new(normalize) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_ignore_source_order_and_follow_every_hash() {
        let a = [FingerprintSource { display_path: "mod:b", load_order: 1, sha256: "1" }, FingerprintSource { display_path: "mod:a", load_order: 1, sha256: "2" }];
        let b = [FingerprintSource { display_path: "mod:a", load_order: 1, sha256: "2" }, FingerprintSource { display_path: "mod:b", load_order: 1, sha256: "1" }];
        assert_eq!(fingerprint(&a, "4.20.0"), fingerprint(&b, "4.20.0"));
        assert!(is_fingerprint(&fingerprint(&a, "4.20.0")));
        let c = [FingerprintSource { display_path: "mod:a", load_order: 1, sha256: "3" }, FingerprintSource { display_path: "mod:b", load_order: 1, sha256: "1" }];
        assert_ne!(fingerprint(&a, "4.20.0"), fingerprint(&c, "4.20.0"));
        assert_ne!(fingerprint(&a, "4.20.0"), fingerprint(&a, "4.21.0"));
        assert!(!is_fingerprint("ABC"));
    }
}

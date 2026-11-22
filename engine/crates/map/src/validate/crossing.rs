//! Crossing, wall, railway and unit-position checks.
//!
//! Ported from `src/hoi4_agent_tools/map/gameplay/crossing-validation.ts` (`validateCrossings`,
//! `checkRules`, `checkRows`, `checkRailways`, `checkUnitPositions`, `parseAdjacencyRules`,
//! `pixelsOf`) and `gameplay/facts.ts` (`closestApproach`, `wrapDelta`), commit `9b7dc80d`.

use std::collections::HashSet;

use hoi4_core::diagnostics::{Severity, SourceLocation, SourcePosition};
use serde_json::json;

use super::Findings;
use crate::model::{MapIndex, as_id, normalized_path};
use crate::parse::records::n;
use crate::parse::source::{self, SourceEntry, assignments, first_scalar};

/// Widest land-to-land crossing the validator accepts as a strait (the base game's is 30).
pub const STRAIT_VALIDATOR_LIMIT_PX: f64 = 48.0;
/// Total adjacency rows above which a map is reported as unusually dense with barriers.
pub const ADJACENCY_ROW_LIMIT: usize = 2_000;
const ANALYSED_ROWS: usize = 400;

/// One `adjacency_rule` (`AdjacencyRuleRecord`).
#[derive(Clone, Debug, PartialEq)]
pub struct AdjacencyRule {
    pub name: String,
    pub required: Vec<i64>,
    pub icon: Option<i64>,
}

fn digits(value: &str) -> Option<i64> {
    (!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())).then(|| value.parse::<f64>().map_or(0, |v| v as i64))
}

/// `parseAdjacencyRules`: the rules and the names defined more than once.
pub fn parse_adjacency_rules(bytes: &[u8], path: &str) -> (Vec<AdjacencyRule>, Vec<String>) {
    let document = source::parse(bytes, path);
    let mut rules = Vec::new();
    let mut seen = HashSet::new();
    let mut duplicates = Vec::new();
    for entry in assignments(&document.root, Some("adjacency_rule")) {
        let Some(block) = entry.value.as_block() else { continue };
        let name = first_scalar(block, "name").map_or_else(String::new, |s| s.value.clone());
        let mut required = Vec::new();
        if let Some(list) = assignments(block, Some("required_provinces")).next().and_then(|a| a.value.as_block()) {
            for item in &list.entries {
                if let SourceEntry::Scalar(s) = item
                    && let Some(id) = digits(&s.value)
                {
                    required.push(id);
                }
            }
        }
        let icon = first_scalar(block, "icon").and_then(|s| digits(&s.value));
        if !name.is_empty() {
            if seen.contains(&name) {
                duplicates.push(name.clone());
            }
            seen.insert(name.clone());
        }
        rules.push(AdjacencyRule { name, required, icon });
    }
    (rules, duplicates)
}

fn bounded<T: Clone>(items: &[T], limit: usize) -> Vec<T> {
    items.iter().take(limit).cloned().collect()
}

fn rules_file(index: &MapIndex) -> Option<usize> {
    let name = index.selector("adjacency_rules", "adjacency_rules.txt").unwrap_or_else(|_| "adjacency_rules.txt".into());
    index.roots.map.iter().find_map(|root| index.active_file(&normalized_path(&format!("{root}/{name}"))))
}

fn check_rules(index: &MapIndex, out: &mut Findings) {
    let Some(file) = rules_file(index) else { return };
    let file = index.file(file);
    let (rules, duplicates) = parse_adjacency_rules(&file.bytes, &file.display_path);
    let origin = SourcePosition { line: 1, column: 1, offset: 0 };
    let location = || Some(SourceLocation { path: file.display_path.clone(), start: origin, end: origin, symbol: None });
    for name in bounded(&duplicates, 8) {
        out.map("MAP_ADJACENCY_RULE_DUPLICATE", Severity::Error, format!("Adjacency rule {name} is defined more than once"), location(), Some(json!({ "rule": name })));
    }
    let defined: HashSet<&str> = rules.iter().map(|r| r.name.as_str()).collect();
    for rule in &rules {
        let mut problems = Vec::new();
        if rule.name.is_empty() {
            problems.push("has no name".to_string());
        }
        if rule.required.len() < 2 {
            problems.push("lists fewer than two required_provinces".to_string());
        }
        let unknown: Vec<i64> = rule.required.iter().copied().filter(|&id| index.definition(id).is_none()).collect();
        if !unknown.is_empty() {
            let list: Vec<String> = bounded(&unknown, 8).iter().map(i64::to_string).collect();
            problems.push(format!("names unknown province(s) {}", list.join(", ")));
        }
        if let Some(icon) = rule.icon
            && index.definition(icon).is_none()
        {
            problems.push(format!("has an icon on unknown province {icon}"));
        }
        if !problems.is_empty() {
            let name = if rule.name.is_empty() { "(unnamed)" } else { &rule.name };
            out.map(
                "MAP_ADJACENCY_RULE_INVALID",
                Severity::Error,
                format!("Adjacency rule {name} {}", problems.join(" and ")),
                location(),
                Some(json!({ "rule": rule.name, "problems": problems })),
            );
        }
    }
    let mut used = HashSet::new();
    for row in &index.adjacencies {
        if row.rule.is_empty() {
            continue;
        }
        used.insert(row.rule.as_str());
        if !defined.contains(row.rule.as_str()) {
            out.map(
                "MAP_ADJACENCY_RULE_MISSING",
                Severity::Error,
                format!("Adjacency {}-{} uses rule {}, which adjacency_rules.txt does not define", n(row.from), n(row.to), row.rule),
                location(),
                Some(json!({ "rule": row.rule, "from": crate::parse::text::json_number(row.from), "to": crate::parse::text::json_number(row.to) })),
            );
        }
    }
    let unused: Vec<String> = rules.iter().filter(|r| !r.name.is_empty() && !used.contains(r.name.as_str())).map(|r| r.name.clone()).collect();
    if !unused.is_empty() {
        out.map(
            "MAP_ADJACENCY_RULE_UNUSED",
            Severity::Info,
            format!("{} adjacency rule(s) are defined but no adjacency row uses them", unused.len()),
            location(),
            Some(json!({ "rules": bounded(&unused, 8) })),
        );
    }
}

/// `pixelsOf`: a province's pixel offsets, sampled to about 4,000.
fn pixels_of(index: &MapIndex, id: i64) -> Vec<usize> {
    let Some(raster) = &index.raster else { return Vec::new() };
    let Some(geometry) = raster.geometry(id) else { return Vec::new() };
    let stride = ((geometry.count as f64 / 4_000.0).sqrt().ceil() as u32).max(1);
    let width = raster.width() as usize;
    let mut out = Vec::new();
    for y in geometry.min_y..=geometry.max_y {
        for x in geometry.min_x..=geometry.max_x {
            let offset = y as usize * width + x as usize;
            if (x + y) % stride == 0 && i64::from(raster.id_at(offset)) == id {
                out.push(offset);
            }
        }
    }
    out
}

fn wrap_delta(a: f64, b: f64, width: f64) -> f64 {
    let delta = a - b;
    let half = width / 2.0;
    if delta > half {
        delta - width
    } else if delta < -half {
        delta + width
    } else {
        delta
    }
}

/// `closestApproach`: the shortest sampled distance between two pixel sets, wrapping sideways.
pub fn closest_approach(left: &[usize], right: &[usize], width: usize, limit: usize) -> Option<f64> {
    if left.is_empty() || right.is_empty() {
        return None;
    }
    let step_l = left.len().div_ceil(limit).max(1);
    let step_r = right.len().div_ceil(limit).max(1);
    let mut best = f64::INFINITY;
    for &l in left.iter().step_by(step_l) {
        let (lx, ly) = ((l % width) as f64, (l / width) as f64);
        for &r in right.iter().step_by(step_r) {
            let dx = wrap_delta(lx, (r % width) as f64, width as f64);
            let dy = ly - (r / width) as f64;
            best = best.min(dx * dx + dy * dy);
        }
    }
    Some(best.sqrt())
}

/// `Math.round`: halves round up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn check_rows(index: &MapIndex, out: &mut Findings) {
    let Some(raster) = &index.raster else { return };
    let seam_only: HashSet<(i64, i64)> = raster.inner.seam_only_pairs.iter().copied().collect();
    let pair = |row: &crate::parse::records::AdjacencyRecord| format!("{}-{}", n(row.from), n(row.to));
    let mut across_seam = Vec::new();
    for row in &index.adjacencies {
        if row.from < 0.0 || row.to < 0.0 {
            continue;
        }
        if let (Some(low), Some(high)) = (as_id(row.from.min(row.to)), as_id(row.from.max(row.to)))
            && seam_only.contains(&(low, high))
        {
            across_seam.push(pair(row));
        }
    }
    let impassable: Vec<_> = index.adjacencies.iter().filter(|r| r.kind == "impassable").collect();
    let (mut isolated, mut non_land) = (Vec::new(), Vec::new());
    for row in &impassable {
        let (Some(from), Some(to)) = (index.definition_f(row.from), index.definition_f(row.to)) else { continue };
        if !raster.adjacent(from.id, to.id) {
            isolated.push(pair(row));
        }
        if from.kind != "land" || to.kind != "land" {
            non_land.push(pair(row));
        }
    }
    if !across_seam.is_empty() {
        out.map(
            "MAP_ADJACENCY_ACROSS_SEAM",
            Severity::Error,
            format!(
                "{} adjacency row(s) join provinces that touch only across the wrapping seam; the game draws each as a line across the whole map. Close the seam with impassable land instead",
                across_seam.len()
            ),
            None,
            Some(json!({ "rows": bounded(&across_seam, 8), "count": across_seam.len() })),
        );
    }
    if !isolated.is_empty() {
        let severity = if isolated.len() >= 3 && isolated.len() as f64 > impassable.len() as f64 * 0.05 { Severity::Warning } else { Severity::Info };
        out.map(
            "MAP_IMPASSABLE_NOT_ADJACENT",
            severity,
            format!("{} impassable row(s) join provinces that do not touch, so they block nothing", isolated.len()),
            None,
            Some(json!({ "rows": bounded(&isolated, 8), "count": isolated.len() })),
        );
    }
    if !non_land.is_empty() {
        out.map(
            "MAP_IMPASSABLE_NOT_LAND",
            Severity::Warning,
            format!("{} impassable row(s) join a province that is not land; walls separate land provinces", non_land.len()),
            None,
            Some(json!({ "rows": bounded(&non_land, 8), "count": non_land.len() })),
        );
    }
    if index.adjacencies.len() > ADJACENCY_ROW_LIMIT {
        out.map(
            "MAP_ADJACENCY_ROW_LIMIT",
            Severity::Warning,
            format!(
                "adjacencies.csv has {} rows; the base game has 244. Large walls slow the load and the AI; consider fewer or larger provinces along the wall",
                index.adjacencies.len()
            ),
            None,
            Some(json!({ "rows": index.adjacencies.len(), "limit": ADJACENCY_ROW_LIMIT })),
        );
    }
    let mut wide = Vec::new();
    let mut analysed = 0;
    for row in &index.adjacencies {
        if row.kind != "sea" || analysed >= ANALYSED_ROWS {
            continue;
        }
        let (Some(from), Some(to)) = (index.definition_f(row.from), index.definition_f(row.to)) else { continue };
        if from.kind != "land" || to.kind != "land" || raster.adjacent(from.id, to.id) {
            continue;
        }
        analysed += 1;
        let gap = closest_approach(&pixels_of(index, from.id), &pixels_of(index, to.id), raster.width() as usize, 200);
        if let Some(gap) = gap
            && gap > STRAIT_VALIDATOR_LIMIT_PX
        {
            wide.push(format!("{} ({} px)", pair(row), n(js_round(gap))));
        }
    }
    if !wide.is_empty() {
        out.map(
            "MAP_STRAIT_NOT_NARROW",
            Severity::Warning,
            format!(
                "{} land crossing(s) span more than {} pixels between their provinces (the base game's widest is 30): {}",
                wide.len(),
                n(STRAIT_VALIDATOR_LIMIT_PX),
                bounded(&wide, 4).join(", ")
            ),
            None,
            Some(json!({ "crossings": bounded(&wide, 8), "count": wide.len(), "limitPx": 48 })),
        );
    }
}

fn check_railways(index: &MapIndex, out: &mut Findings) {
    if index.railways.is_empty() {
        return;
    }
    let mut blocked = HashSet::new();
    for row in index.adjacencies.iter().filter(|r| r.kind == "impassable") {
        blocked.insert((n(row.from), n(row.to)));
        blocked.insert((n(row.to), n(row.from)));
    }
    if blocked.is_empty() {
        return;
    }
    let mut crossing = Vec::new();
    for railway in &index.railways {
        for step in railway.provinces.windows(2) {
            if blocked.contains(&(step[0].to_string(), step[1].to_string())) {
                crossing.push(format!("{}-{}", step[0], step[1]));
            }
        }
    }
    if !crossing.is_empty() {
        out.map(
            "MAP_RAILWAY_CROSSES_IMPASSABLE",
            Severity::Warning,
            format!("{} railway step(s) run between provinces separated by an impassable row; a railway cannot cross a wall except at a gate", crossing.len()),
            None,
            Some(json!({ "steps": bounded(&crossing, 8), "count": crossing.len() })),
        );
    }
}

fn check_unit_positions(index: &MapIndex, out: &mut Findings) {
    let Some(raster) = &index.raster else { return };
    if index.unit_positions.is_empty() {
        return;
    }
    let covered: HashSet<i64> = index.unit_positions.iter().filter_map(|p| as_id(p.province_id)).collect();
    let missing: Vec<i64> = index
        .definitions
        .iter()
        .filter(|d| d.id > 0 && raster.geometry(d.id).is_some() && d.kind != "lake" && !covered.contains(&d.id))
        .map(|d| d.id)
        .collect();
    if !missing.is_empty() {
        let many = missing.len() as f64 > (index.definitions.len() as f64 * 0.01).max(3.0);
        out.map(
            "MAP_UNIT_POSITION_MISSING",
            if many { Severity::Warning } else { Severity::Info },
            format!("{} province(s) have no unit-stack positions, so units there have no place to stand", missing.len()),
            None,
            Some(json!({ "provinces": bounded(&missing, 12), "count": missing.len() })),
        );
    }
}

/// `validateCrossings`.
pub fn validate_crossings(index: &MapIndex, out: &mut Findings) {
    check_rules(index, out);
    check_rows(index, out);
    check_railways(index, out);
    check_unit_positions(index, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rules_and_duplicates() {
        let (rules, duplicates) = parse_adjacency_rules(b"adjacency_rule = { name = A required_provinces = { 1 2 x } icon = 3 }\nadjacency_rule = { name = A }", "mod:map/adjacency_rules.txt");
        assert_eq!(rules[0], AdjacencyRule { name: "A".into(), required: vec![1, 2], icon: Some(3) });
        assert_eq!(duplicates, ["A"]);
    }

    #[test]
    fn measures_the_closest_approach_across_the_seam() {
        // Width 10: x = 0 and x = 9 are one pixel apart across the seam.
        assert_eq!(closest_approach(&[0], &[9], 10, 200), Some(1.0));
        assert_eq!(closest_approach(&[0], &[23], 10, 200), Some((9.0f64 + 4.0).sqrt()));
        assert_eq!(closest_approach(&[], &[1], 10, 200), None);
    }
}

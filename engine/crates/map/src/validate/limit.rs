//! The ceiling on map findings: at most `limit` are kept, errors and blockers first, and the rest
//! are counted in one `MAP_DIAGNOSTICS_TRUNCATED` marker that blocks when it hides an error.
//!
//! Ported from `src/hoi4_agent_tools/map/diagnostic-limit.ts` (`MAP_DIAGNOSTIC_LIMIT`,
//! `addMapDiagnostic`, `addActiveMapDiagnostic`, `addBoundedDiagnostic`), commit `9b7dc80d`.

use hoi4_core::diagnostics::{Category, Diagnostic, Severity};
use serde_json::{Map, Value, json};

pub const MAP_DIAGNOSTIC_LIMIT: usize = 2_000;
pub const TRUNCATED: &str = "MAP_DIAGNOSTICS_TRUNCATED";
const HARD_MESSAGE: &str = "Map diagnostic detail exceeded the result ceiling and omitted an error or blocker";
const SOFT_MESSAGE: &str = "Map diagnostic detail exceeded the result ceiling; deterministic samples and omission counts were retained";

fn is_hard(diagnostic: &Diagnostic) -> bool {
    diagnostic.severity.blocks()
}

fn is_workspace_path(path: &str) -> bool {
    path.starts_with("mod:") || path.starts_with("fixture:")
}

/// A finding located only in inherited (game or dependency) files.
fn is_baseline_only(diagnostic: &Diagnostic) -> bool {
    match &diagnostic.location {
        None => false,
        Some(location) if is_workspace_path(&location.path) => false,
        Some(_) => !diagnostic.related.iter().flatten().any(|l| is_workspace_path(&l.path)),
    }
}

fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Info => "info",
        Severity::Warning => "warning",
        Severity::Error => "error",
        Severity::Blocker => "blocker",
    }
}

fn bump(map: &mut Map<String, Value>, key: &str) {
    let count = map.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
    map.insert(key.to_string(), json!(count));
}

fn add_omitted(marker: &mut Diagnostic, omitted: &Diagnostic) {
    let details = marker.details.get_or_insert_with(Map::new);
    let count = details.get("omitted").and_then(Value::as_u64).unwrap_or(0) + 1;
    details.insert("omitted".into(), json!(count));
    for (field, key) in [("omittedBySeverity", severity_name(omitted.severity)), ("omittedByCode", omitted.code.as_str())] {
        let mut map = match details.remove(field) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        bump(&mut map, key);
        details.insert(field.into(), Value::Object(map));
    }
}

fn truncation_marker(omitted: &[Diagnostic], limit: usize) -> Diagnostic {
    let hard = omitted.iter().any(is_hard);
    let mut marker =
        Diagnostic::new(TRUNCATED, if hard { Severity::Blocker } else { Severity::Info }, Category::Map, if hard { HARD_MESSAGE } else { SOFT_MESSAGE });
    let mut details = Map::new();
    details.insert("limit".into(), json!(limit));
    details.insert("retained".into(), json!(limit - 1));
    details.insert("omitted".into(), json!(0));
    details.insert("omittedBySeverity".into(), json!({}));
    details.insert("omittedByCode".into(), json!({}));
    marker.details = Some(details);
    for diagnostic in omitted {
        add_omitted(&mut marker, diagnostic);
    }
    marker
}

fn add_bounded(diagnostics: &mut Vec<Diagnostic>, diagnostic: Diagnostic, include_baseline: bool, limit: usize) {
    if !include_baseline && is_baseline_only(&diagnostic) {
        return;
    }
    if diagnostics.last().is_some_and(|d| d.code == TRUNCATED) {
        let marker_index = diagnostics.len() - 1;
        if is_hard(&diagnostic) {
            if let Some(replace) = diagnostics[..marker_index].iter().rposition(|d| !is_hard(d)) {
                let replaced = std::mem::replace(&mut diagnostics[replace], diagnostic);
                add_omitted(&mut diagnostics[marker_index], &replaced);
                return;
            }
            let marker = &mut diagnostics[marker_index];
            marker.severity = Severity::Blocker;
            marker.message = HARD_MESSAGE.into();
        }
        add_omitted(&mut diagnostics[marker_index], &diagnostic);
        return;
    }
    if diagnostics.len() < limit {
        diagnostics.push(diagnostic);
        return;
    }
    let mut candidates = std::mem::take(diagnostics);
    candidates.push(diagnostic);
    let keep = limit - 1;
    let hard_count = candidates.iter().filter(|d| is_hard(d)).count();
    // Errors and blockers first, each group in arrival order.
    let mut retained_flags = vec![false; candidates.len()];
    let mut hard_taken = 0;
    for (i, d) in candidates.iter().enumerate() {
        if is_hard(d) && hard_taken < keep {
            retained_flags[i] = true;
            hard_taken += 1;
        }
    }
    if hard_count < keep {
        let mut soft_taken = 0;
        for (i, d) in candidates.iter().enumerate() {
            if !is_hard(d) && soft_taken < keep - hard_count {
                retained_flags[i] = true;
                soft_taken += 1;
            }
        }
    }
    let mut hard = Vec::new();
    let mut soft = Vec::new();
    let mut omitted = Vec::new();
    for (d, kept) in candidates.into_iter().zip(retained_flags) {
        match (kept, is_hard(&d)) {
            (true, true) => hard.push(d),
            (true, false) => soft.push(d),
            (false, _) => omitted.push(d),
        }
    }
    hard.extend(soft);
    hard.push(truncation_marker(&omitted, limit));
    *diagnostics = hard;
}

/// `addMapDiagnostic`: skips findings only in inherited files.
pub fn add_map_diagnostic(diagnostics: &mut Vec<Diagnostic>, diagnostic: Diagnostic, limit: Option<usize>) {
    add_bounded(diagnostics, diagnostic, false, limit.unwrap_or(MAP_DIAGNOSTIC_LIMIT));
}

/// `addActiveMapDiagnostic`: keeps findings in whichever source wins, inherited files included.
pub fn add_active_map_diagnostic(diagnostics: &mut Vec<Diagnostic>, diagnostic: Diagnostic, limit: Option<usize>) {
    add_bounded(diagnostics, diagnostic, true, limit.unwrap_or(MAP_DIAGNOSTIC_LIMIT));
}

#[cfg(test)]
mod tests {
    use super::*;
    use hoi4_core::diagnostics::{SourceLocation, SourcePosition};

    fn finding(code: &str, severity: Severity, path: Option<&str>) -> Diagnostic {
        let mut d = Diagnostic::new(code, severity, Category::Map, "m");
        let p = SourcePosition { line: 1, column: 1, offset: 0 };
        d.location = path.map(|path| SourceLocation { path: path.into(), start: p, end: p, symbol: None });
        d
    }

    #[test]
    fn drops_inherited_findings_unless_active() {
        let mut list = Vec::new();
        add_map_diagnostic(&mut list, finding("A", Severity::Error, Some("game:map/x")), None);
        add_map_diagnostic(&mut list, finding("B", Severity::Error, Some("mod:map/x")), None);
        add_map_diagnostic(&mut list, finding("C", Severity::Error, None), None);
        add_active_map_diagnostic(&mut list, finding("D", Severity::Error, Some("game:map/x")), None);
        let codes: Vec<_> = list.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["B", "C", "D"]);
    }

    #[test]
    fn keeps_errors_first_and_counts_the_rest_in_a_marker() {
        let mut list = Vec::new();
        for i in 0..3 {
            add_map_diagnostic(&mut list, finding(&format!("W{i}"), Severity::Warning, None), Some(4));
        }
        add_map_diagnostic(&mut list, finding("E0", Severity::Error, None), Some(4));
        add_map_diagnostic(&mut list, finding("E1", Severity::Error, None), Some(4));
        let codes: Vec<_> = list.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["E0", "E1", "W0", TRUNCATED]);
        let marker = list.last().unwrap();
        assert_eq!(marker.severity, Severity::Info);
        assert_eq!(marker.details.as_ref().unwrap()["omitted"], 2);
        // A later error replaces the last retained warning and the marker counts the warning.
        add_map_diagnostic(&mut list, finding("E2", Severity::Error, None), Some(4));
        let codes: Vec<_> = list.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["E0", "E1", "E2", TRUNCATED]);
        assert_eq!(list[3].details.as_ref().unwrap()["omittedByCode"]["W0"], 1);
        // With no warning left to replace, the marker turns into a blocker.
        add_map_diagnostic(&mut list, finding("E3", Severity::Error, None), Some(4));
        assert_eq!(list[3].severity, Severity::Blocker);
        assert_eq!(list[3].details.as_ref().unwrap()["omittedBySeverity"]["error"], 1);
    }
}

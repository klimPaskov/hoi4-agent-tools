//! The diagnostic every tool reports, in the wire shape of the TypeScript server.
//!
//! Ported from `src/hoi4_agent_tools/core/diagnostics.ts` (`DiagnosticSeverity`,
//! `DiagnosticCategory`, `SourcePosition`, `SourceLocation`, `Diagnostic`, `sortDiagnostics`,
//! `hasBlockingDiagnostics`), commit `ef3d2215`. Field names, severities, categories and the sort
//! order are the TypeScript ones, because agents read them unchanged. A new category is a public
//! schema change and goes through the integrator.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::canonical::compare_code_units;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
    Blocker,
}

impl Severity {
    /// Sort rank: blockers first, then errors, warnings and information.
    fn rank(self) -> u8 {
        match self {
            Severity::Blocker => 0,
            Severity::Error => 1,
            Severity::Warning => 2,
            Severity::Info => 3,
        }
    }

    /// Whether a finding of this severity stops a write.
    pub fn blocks(self) -> bool {
        matches!(self, Severity::Error | Severity::Blocker)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Syntax,
    Reference,
    Layout,
    Design,
    Rendering,
    Security,
    Validation,
    Map,
    Configuration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourcePosition {
    pub line: u32,
    pub column: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub path: String,
    pub start: SourcePosition,
    pub end: SourcePosition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub category: Category,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related: Option<Vec<SourceLocation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

impl Diagnostic {
    pub fn new(code: impl Into<String>, severity: Severity, category: Category, message: impl Into<String>) -> Self {
        Self { code: code.into(), severity, category, message: message.into(), location: None, related: None, operation_id: None, details: None }
    }
}

fn compare(left: &Diagnostic, right: &Diagnostic) -> Ordering {
    let path = |d: &Diagnostic| d.location.as_ref().map_or(String::new(), |l| l.path.clone());
    let offset = |d: &Diagnostic| d.location.as_ref().map_or(0, |l| l.start.offset);
    left.severity
        .rank()
        .cmp(&right.severity.rank())
        .then_with(|| compare_code_units(&path(left), &path(right)))
        .then_with(|| offset(left).cmp(&offset(right)))
        .then_with(|| compare_code_units(&left.code, &right.code))
}

/// Sorts as `sortDiagnostics` does: severity, path, start offset, then code. The sort is stable.
pub fn sort_diagnostics(diagnostics: &mut [Diagnostic]) {
    diagnostics.sort_by(compare);
}

/// Whether any diagnostic is an error or a blocker.
pub fn has_blocking(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|d| d.severity.blocks())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(path: &str, offset: u32) -> SourceLocation {
        let position = SourcePosition { line: 1, column: 1, offset };
        SourceLocation { path: path.into(), start: position, end: position, symbol: None }
    }

    #[test]
    fn serializes_in_the_typescript_wire_shape() {
        let mut diagnostic = Diagnostic::new("X_CODE", Severity::Blocker, Category::Security, "refused");
        diagnostic.operation_id = Some("op-1".into());
        diagnostic.location = Some(at("events/a.txt", 4));
        let text = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(
            text,
            json!({
                "code": "X_CODE",
                "severity": "blocker",
                "category": "security",
                "message": "refused",
                "operationId": "op-1",
                "location": { "path": "events/a.txt", "start": { "line": 1, "column": 1, "offset": 4 }, "end": { "line": 1, "column": 1, "offset": 4 } }
            })
        );
        let back: Diagnostic = serde_json::from_value(text).unwrap();
        assert_eq!(back, diagnostic);
    }

    #[test]
    fn refuses_an_unknown_severity_or_category() {
        let bad = json!({ "code": "C", "severity": "fatal", "category": "map", "message": "m" });
        assert!(serde_json::from_value::<Diagnostic>(bad).is_err());
        let bad = json!({ "code": "C", "severity": "info", "category": "gameplay", "message": "m" });
        assert!(serde_json::from_value::<Diagnostic>(bad).is_err());
    }

    #[test]
    fn sorts_by_severity_path_offset_and_code() {
        let make = |code: &str, severity, path: Option<(&str, u32)>| {
            let mut d = Diagnostic::new(code, severity, Category::Validation, "m");
            d.location = path.map(|(p, o)| at(p, o));
            d
        };
        let mut list = vec![
            make("B", Severity::Info, None),
            make("A", Severity::Error, Some(("b.txt", 1))),
            make("C", Severity::Error, Some(("a.txt", 9))),
            make("A", Severity::Error, Some(("a.txt", 9))),
            make("Z", Severity::Blocker, Some(("z.txt", 0))),
        ];
        sort_diagnostics(&mut list);
        let order: Vec<_> = list.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(order, vec!["Z", "A", "C", "A", "B"]);
        assert_eq!(list[1].location.as_ref().unwrap().path, "a.txt");
        assert!(has_blocking(&list));
        assert!(!has_blocking(&list[4..]));
    }
}

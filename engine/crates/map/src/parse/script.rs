//! Clausewitz script and localisation through the engine's TypeScript-compatible reader
//! (`hoi4_engine::symbol_index::reader`, ADR 0085), with the TypeScript locations of its nodes.
//!
//! Nothing here parses: the reader decodes, lexes and parses with the TypeScript semantics and
//! findings, and `Positions` maps its byte offsets to TypeScript positions (UTF-16 offsets). This
//! module only turns both into the `hoi4-core` diagnostic and location types the map reports.
//! Adapted from no TypeScript file beyond the `nodeLocation` helper of
//! `src/hoi4_agent_tools/core/source/parser.ts`, commit `9b7dc80d`.

use hoi4_core::diagnostics::{Category, Diagnostic, Severity, SourceLocation, SourcePosition};
use hoi4_engine::symbol_index::reader::{self, Assignment, Block, Document};
use hoi4_engine::symbol_index::records::Positions;
use serde_json::{Map, Value};

/// A parsed script with its text and positions.
pub struct Script<'a> {
    pub path: &'a str,
    pub document: Document<'a>,
    pub positions: Positions<'a>,
}

/// Parses `bytes` as `parseClausewitz` does and hands the result to `f`.
pub fn with_script<R>(bytes: &[u8], path: &str, f: impl FnOnce(&Script) -> R) -> R {
    let (text, lossy) = reader::decode(bytes);
    let loss = if lossy { reader::windows_1252_loss(bytes) } else { None };
    let document = reader::parse_clausewitz_detailed(&text, bytes.len(), loss.as_ref());
    let positions = Positions::new(&text);
    f(&Script { path, document, positions })
}

/// A reader diagnostic as a `hoi4-core` diagnostic.
pub fn convert(positions: &Positions, path: &str, diagnostic: &reader::SourceDiagnostic) -> Diagnostic {
    let value = positions.diagnostic(path, diagnostic);
    serde_json::from_value(value).unwrap_or_else(|_| Diagnostic::new(diagnostic.code, Severity::Error, Category::Syntax, diagnostic.message.clone()))
}

fn position(p: [u32; 3]) -> SourcePosition {
    SourcePosition { line: p[0], column: p[1], offset: p[2] }
}

impl Script<'_> {
    /// The parser's findings, as the TypeScript document's `diagnostics`.
    pub fn diagnostics(&self) -> Vec<Diagnostic> {
        self.document.diagnostics.retained().iter().map(|d| convert(&self.positions, self.path, d)).collect()
    }

    pub fn root(&self) -> &Block<'_> {
        &self.document.root
    }

    /// The tokens the TypeScript lexer keeps, trivia included (`document.tokens.length`).
    pub fn token_count(&self) -> usize {
        self.document.token_count
    }

    /// `nodeLocation` of a byte range.
    pub fn location(&self, start: u32, end: u32, symbol: Option<&str>) -> SourceLocation {
        SourceLocation {
            path: self.path.to_string(),
            start: position(self.positions.position(start)),
            end: position(self.positions.position(end)),
            symbol: symbol.map(str::to_string),
        }
    }

    /// `nodeLocation` of an assignment.
    pub fn assignment_location(&self, assignment: &Assignment, symbol: Option<&str>) -> SourceLocation {
        self.location(assignment.key.start, assignment.end(), symbol)
    }

    /// `stateLocation` / `regionLocation`: the key token's line and columns, the assignment's
    /// offsets, and the id as the symbol.
    pub fn record_location(&self, assignment: &Assignment, id: i64) -> SourceLocation {
        let key_start = self.positions.position(assignment.key.start);
        let key_end = self.positions.position(assignment.key.end);
        let start = self.positions.unit(assignment.key.start);
        let end = self.positions.unit(assignment.end());
        SourceLocation {
            path: self.path.to_string(),
            start: SourcePosition { line: key_start[0], column: key_start[1], offset: start },
            end: SourcePosition { line: key_start[0], column: key_start[1] + (key_end[2] - key_start[2]), offset: end },
            symbol: Some(id.to_string()),
        }
    }
}

/// `assignments(block, key)`.
pub fn assignments<'b, 'a>(block: &'b Block<'a>, key: &'b str) -> impl Iterator<Item = &'b Assignment<'a>> {
    block.assignments().filter(move |a| a.key.value == key)
}

/// `scalarList`: the bare scalars of an optional block.
pub fn scalar_list<'b>(block: Option<&'b Block<'_>>) -> Vec<&'b str> {
    block.map_or_else(Vec::new, |b| b.scalars().map(|s| s.value.as_ref()).collect())
}

/// The keys of a localisation file (`language:key`) and its findings, as `parseLocalisation`
/// gives them.
pub fn localisation(bytes: &[u8], path: &str) -> (Vec<String>, Vec<Diagnostic>) {
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let (text, _) = reader::decode(bytes);
    let parsed = reader::parse_localisation_detailed(&text, bytes.len(), bom);
    let positions = Positions::new(&text);
    let keys = parsed.entries.iter().map(|e| format!("{}:{}", e.language, e.key)).collect();
    let diagnostics = parsed.diagnostics.retained().iter().map(|d| convert(&positions, path, d)).collect();
    (keys, diagnostics)
}

/// A diagnostic with an optional location and details.
pub fn diagnostic(
    code: &str,
    severity: Severity,
    category: Category,
    message: impl Into<String>,
    location: Option<SourceLocation>,
    details: Option<Value>,
) -> Diagnostic {
    let mut d = Diagnostic::new(code, severity, category, message);
    d.location = location;
    d.details = details.map(self::details);
    d
}

/// A JSON object from a `json!` literal, for diagnostic details.
pub fn details(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_nodes_in_utf16_code_units() {
        with_script("a = \"😀\"\r\nstate = { id = 5 }".as_bytes(), "mod:x.txt", |script| {
            let state = assignments(script.root(), "state").next().unwrap();
            let location = script.record_location(state, 5);
            assert_eq!((location.start.line, location.start.column, location.start.offset), (2, 1, 10));
            assert_eq!((location.end.column, location.end.offset), (6, 28));
            assert_eq!(location.symbol.as_deref(), Some("5"));
            assert!(script.diagnostics().is_empty());
        });
    }

    #[test]
    fn reports_the_typescript_parser_codes() {
        with_script(b"a = {", "mod:x.txt", |script| {
            let codes: Vec<_> = script.diagnostics().into_iter().map(|d| (d.code, d.category)).collect();
            assert_eq!(codes, [("SOURCE_UNCLOSED_BLOCK".to_string(), Category::Syntax)]);
        });
    }

    #[test]
    fn reads_localisation_keys() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"l_english:\n STATE_1:0 \"One\"\n bad line\n");
        let (keys, diagnostics) = localisation(&bytes, "mod:localisation/x_l_english.yml");
        assert_eq!(keys, ["l_english:STATE_1"]);
        assert_eq!(diagnostics[0].code, "LOCALISATION_MALFORMED_LINE");
    }
}

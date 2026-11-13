//! The per-file work of the TypeScript `SymbolIndex` (`indexFile` and what it calls), for the
//! files the server names (step 5 of maintainer decision M-8, ADR 0085).
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/index.ts` (`indexFile`, `walkBlock`,
//! `tableLines`, `whitespaceFields`, `indexDefinitions`, `indexAdjacencies`, `indexNetwork`) and
//! `core/source/lexer.ts` (`createSourceLineIndex`, `positionAt`) at commit `fc88d04`.
//!
//! For each file the answer holds its definitions with their TypeScript location and `metadata`,
//! its references, the diagnostics `indexFile` adds for it, the ceiling diagnostics that make the
//! index skip it, and whether a table or nesting ceiling made the index incomplete. Which file is
//! a selected `definition.csv`, which files the workspace owns and which are shadowed is decided
//! by the server and passed in, so the server keeps the index's bookkeeping across files (load
//! order, the record and diagnostic ceilings, the skipped-source list, active definitions,
//! collisions and unresolved references) while the parsing and walking happen here.

use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::reader::{At, SourceDiagnostic, decode, parse_clausewitz_detailed, parse_localisation_detailed, windows_1252_loss};
use super::walk::{self, Collect};
use super::{INDEX_TABLE_FIELD_LIMIT, INDEX_TABLE_RECORD_LIMIT, SymbolKind, digits, split_bounded, table_lines};

pub const REQUEST_SCHEMA: &str = "hoi4-index-files-request/1";
pub const RESPONSE_SCHEMA: &str = "hoi4-index-files/1";

/// One file the server indexes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRequest {
    /// The file on disk. Exactly one of `path` and `payload` is given.
    #[serde(default)]
    pub path: Option<String>,
    /// Where the file's bytes sit in the frame's payload (`[offset, length]`), for a file that
    /// exists only in the server's memory.
    #[serde(default)]
    pub payload: Option<(usize, usize)>,
    /// SHA-256 of the bytes the server read; a file on disk that no longer has it is refused.
    #[serde(default)]
    pub sha256: Option<String>,
    pub display_path: String,
    pub relative_path: String,
    /// A `definition.csv` the index selected (`selectedDefinitionFiles`).
    #[serde(default)]
    pub definition_file: bool,
    /// The workspace owns it (`isWorkspaceOwnedSource`): its parser diagnostics are reported.
    #[serde(default)]
    pub owned: bool,
    /// A higher layer replaces it (`shadowedBy`): its diagnostics and references are dropped.
    #[serde(default)]
    pub shadowed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub files: Vec<FileRequest>,
}

/// `createSourceLineIndex` and `positionAt` over UTF-16 offsets, reached from byte offsets.
struct Positions<'t> {
    text: &'t str,
    /// UTF-16 offset of every byte offset, for text that is not ASCII.
    utf16: Option<Vec<u32>>,
    /// UTF-16 offset of each line's start.
    line_starts: Vec<u32>,
    /// UTF-16 length of the text.
    length: u32,
}

impl<'t> Positions<'t> {
    fn new(text: &'t str) -> Self {
        let utf16 = (!text.is_ascii()).then(|| {
            let mut map = Vec::with_capacity(text.len() + 1);
            let mut unit = 0u32;
            for c in text.chars() {
                for _ in 0..c.len_utf8() {
                    map.push(unit);
                }
                unit += c.len_utf16() as u32;
            }
            map.push(unit);
            map
        });
        let bytes = text.as_bytes();
        let mut line_starts = vec![0u32];
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\r' => {
                    if bytes.get(i + 1) == Some(&b'\n') {
                        i += 1;
                    }
                    line_starts.push((i + 1) as u32);
                }
                b'\n' => line_starts.push((i + 1) as u32),
                _ => {}
            }
            i += 1;
        }
        let mut positions = Positions { text, utf16, line_starts, length: 0 };
        positions.length = positions.unit(text.len() as u32);
        for start in &mut positions.line_starts {
            *start = match &positions.utf16 {
                Some(map) => map[*start as usize],
                None => *start,
            };
        }
        positions
    }

    fn unit(&self, byte: u32) -> u32 {
        match &self.utf16 {
            Some(map) => map[(byte as usize).min(map.len() - 1)],
            None => byte.min(self.text.len() as u32),
        }
    }

    /// The UTF-16 code unit at a UTF-16 offset, as far as `positionAt` looks at it (an ASCII
    /// line break or something else).
    fn is_unit(&self, offset: u32, wanted: u8) -> bool {
        if offset >= self.length {
            return false;
        }
        let byte = match &self.utf16 {
            Some(map) => match map.binary_search(&offset) {
                Ok(found) => {
                    // The first byte of the character that starts at this unit.
                    let mut first = found;
                    while first > 0 && map[first - 1] == offset {
                        first -= 1;
                    }
                    first
                }
                Err(_) => return false,
            },
            None => offset as usize,
        };
        self.text.as_bytes().get(byte) == Some(&wanted)
    }

    /// `positionAt(lineIndex, offset)` for a UTF-16 offset.
    fn position(&self, offset: u32) -> Value {
        let bounded = offset.min(self.length);
        let line = self.line_starts.partition_point(|&start| start <= bounded).max(1) - 1;
        if bounded < self.length && bounded > 0 && self.is_unit(bounded, b'\n') && self.is_unit(bounded - 1, b'\r') {
            return json!({ "line": line + 2, "column": 1, "offset": offset });
        }
        json!({ "line": line + 1, "column": bounded - self.line_starts[line] + 1, "offset": offset })
    }

    /// `locationFor` (and `nodeLocation` with a symbol) of a span in bytes.
    fn location(&self, path: &str, start: u32, end: u32, symbol: Option<&str>) -> Value {
        self.location_units(path, self.unit(start), self.unit(end), symbol)
    }

    fn location_units(&self, path: &str, start: u32, end: u32, symbol: Option<&str>) -> Value {
        let mut location = json!({ "path": path, "start": self.position(start), "end": self.position(end) });
        if let Some(symbol) = symbol {
            location["symbol"] = Value::from(symbol);
        }
        location
    }

    /// A source diagnostic as the TypeScript `Diagnostic` object.
    fn diagnostic(&self, path: &str, diagnostic: &SourceDiagnostic) -> Value {
        let mut out = Map::new();
        out.insert("code".into(), diagnostic.code.into());
        out.insert("severity".into(), diagnostic.severity.into());
        out.insert("category".into(), "syntax".into());
        out.insert("message".into(), diagnostic.message.clone().into());
        if let Some(at) = diagnostic.at {
            let location = match at {
                At::Bytes(start, end) => self.location(path, start, end, None),
                At::Utf16(start, end) => self.location_units(path, start, end, None),
                At::Fixed(line, column, offset) => {
                    let position = json!({ "line": line, "column": column, "offset": offset });
                    json!({ "path": path, "start": position, "end": position })
                }
                At::FixedAtByte(line, column, byte) => {
                    let position = json!({ "line": line, "column": column, "offset": self.unit(byte) });
                    json!({ "path": path, "start": position, "end": position })
                }
            };
            out.insert("location".into(), location);
        }
        if let Some(details) = &diagnostic.details {
            out.insert("details".into(), details.clone());
        }
        Value::Object(out)
    }
}

/// What indexing one file gives the server.
#[derive(Default)]
struct FileAnswer {
    /// `[kind, id, location or null, metadata]`.
    symbols: Vec<Value>,
    /// `[kind, from, toKind, to, location]`.
    references: Vec<Value>,
    diagnostics: Vec<Value>,
    /// The ceiling diagnostics that make the index skip the file.
    skip: Option<Vec<Value>>,
    /// A table or nesting ceiling made the index incomplete.
    incomplete: bool,
}

impl FileAnswer {
    fn into_json(self) -> Value {
        json!({
            "symbols": self.symbols,
            "references": self.references,
            "diagnostics": self.diagnostics,
            "skip": self.skip,
            "incomplete": self.incomplete,
        })
    }
}

fn index_diagnostic(code: &str, message: &str, details: Value) -> Value {
    json!({ "code": code, "severity": "blocker", "category": "reference", "message": message, "details": details })
}

fn table_answer(file: &FileRequest, bytes: &[u8], kind: TableKind) -> FileAnswer {
    let mut answer = FileAnswer::default();
    if bytes.len() > super::reader::SOURCE_MAX_BYTES {
        answer.skip = Some(vec![index_diagnostic(
            "INDEX_TABLE_FILE_LIMIT",
            "Shared-index map table exceeds the fixed parsing-byte limit",
            json!({ "path": file.display_path, "limit": super::reader::SOURCE_MAX_BYTES }),
        )]);
        return answer;
    }
    let text = String::from_utf8_lossy(bytes);
    let symbols = &mut answer.symbols;
    let diagnostics = &mut answer.diagnostics;
    let mut incomplete = false;
    let finished = table_lines(&text, |row, line| match kind {
        TableKind::Definitions => {
            let parts = split_bounded(row, ';', 8);
            if parts.len() >= 4 && digits(parts[0]) {
                let color = format!("{},{},{}", parts[1], parts[2], parts[3]);
                let mut metadata = Map::new();
                metadata.insert("color".into(), color.clone().into());
                for (key, at) in [("type", 4), ("coastal", 5), ("terrain", 6), ("continent", 7)] {
                    if let Some(part) = parts.get(at) {
                        metadata.insert(key.into(), (*part).into());
                    }
                }
                metadata.insert("line".into(), line.into());
                symbols.push(json!([SymbolKind::Province.as_str(), parts[0], null, metadata]));
                symbols.push(json!([SymbolKind::ProvinceColor.as_str(), color, null, { "provinceId": parts[0], "line": line }]));
            }
        }
        TableKind::Adjacencies => {
            if line != 1 {
                let parts = split_bounded(row, ';', 4);
                if parts.len() >= 3 && digits(parts[0]) && digits(parts[1]) {
                    let mut metadata = Map::new();
                    metadata.insert("from".into(), parts[0].into());
                    metadata.insert("to".into(), parts[1].into());
                    metadata.insert("type".into(), parts[2].into());
                    if let Some(through) = parts.get(3) {
                        metadata.insert("through".into(), (*through).into());
                    }
                    metadata.insert("line".into(), line.into());
                    symbols.push(json!([SymbolKind::Adjacency.as_str(), format!("{}:{}:{}:{line}", parts[0], parts[1], parts[2]), null, metadata]));
                }
            }
        }
        TableKind::Network(kind) => {
            let mut values: Vec<&str> = Vec::new();
            for field in row.split(super::reader::is_js_space).filter(|f| !f.is_empty()) {
                if values.len() >= INDEX_TABLE_FIELD_LIMIT {
                    incomplete = true;
                    diagnostics.push(index_diagnostic(
                        "INDEX_TABLE_FIELD_LIMIT",
                        "Shared-index map-table row exceeds the fixed field limit",
                        json!({ "path": file.display_path, "line": line, "limit": INDEX_TABLE_FIELD_LIMIT }),
                    ));
                    return;
                }
                values.push(field);
            }
            if values.len() >= 2 && values.iter().all(|v| digits(v)) {
                symbols.push(json!([kind.as_str(), format!("{line}:{}", values.join(":")), null, { "values": values, "line": line }]));
            }
        }
    });
    if !finished {
        incomplete = true;
        answer.diagnostics.push(index_diagnostic(
            "INDEX_TABLE_RECORD_LIMIT",
            "Shared-index map table exceeds the fixed record limit",
            json!({ "path": file.display_path, "limit": INDEX_TABLE_RECORD_LIMIT }),
        ));
    }
    answer.incomplete = incomplete;
    answer
}

#[derive(Clone, Copy)]
enum TableKind {
    Definitions,
    Adjacencies,
    Network(SymbolKind),
}

/// `indexFile` for one file's bytes.
fn index_one(file: &FileRequest, bytes: &[u8]) -> FileAnswer {
    let lower = file.relative_path.to_lowercase();
    let display = file.display_path.as_str();
    if lower.ends_with(".yml") {
        let mut answer = FileAnswer::default();
        let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let (text, _) = decode(bytes);
        let parsed = parse_localisation_detailed(&text, bytes.len(), bom);
        let positions = Positions::new(&text);
        let limits = parsed.diagnostics.retained_limits();
        if !limits.is_empty() {
            answer.skip = Some(limits.iter().map(|d| positions.diagnostic(display, d)).collect());
            return answer;
        }
        if file.owned && !file.shadowed {
            answer.diagnostics = parsed.diagnostics.retained().iter().map(|d| positions.diagnostic(display, d)).collect();
        }
        answer.symbols = parsed
            .entries
            .into_iter()
            .map(|entry| {
                let location = positions.location(display, entry.start, entry.end, None);
                json!([
                    SymbolKind::Localisation.as_str(),
                    format!("{}:{}", entry.language, entry.key),
                    location,
                    { "language": entry.language, "key": entry.key, "value": entry.value }
                ])
            })
            .collect();
        return answer;
    }
    let table = if file.definition_file {
        Some(TableKind::Definitions)
    } else if lower.ends_with("adjacencies.csv") {
        Some(TableKind::Adjacencies)
    } else if lower.ends_with("supply_nodes.txt") {
        Some(TableKind::Network(SymbolKind::SupplyNode))
    } else if lower.ends_with("railways.txt") {
        Some(TableKind::Network(SymbolKind::Railway))
    } else {
        None
    };
    if let Some(table) = table {
        return table_answer(file, bytes, table);
    }
    if !(lower.ends_with(".txt") || lower.ends_with(".gui") || lower.ends_with(".gfx")) || !bytes.contains(&b'=') {
        return FileAnswer::default();
    }
    let mut answer = FileAnswer::default();
    let (text, lossy) = decode(bytes);
    let loss = if lossy { windows_1252_loss(bytes) } else { None };
    let document = parse_clausewitz_detailed(&text, bytes.len(), loss.as_ref());
    let positions = Positions::new(&text);
    let limits = document.diagnostics.retained_limits();
    if !limits.is_empty() {
        answer.skip = Some(limits.iter().map(|d| positions.diagnostic(display, d)).collect());
        return answer;
    }
    if file.owned {
        answer.diagnostics = document.diagnostics.retained().iter().map(|d| positions.diagnostic(display, d)).collect();
    }
    let path = file.relative_path.replace('\\', "/").to_lowercase();
    let walked = walk::walk_rich(&document.root, &path, Collect::All);
    if let Some((start, end)) = walked.nesting_block {
        answer.incomplete = true;
        let already = document.diagnostics.retained().iter().any(|d| d.code == "SOURCE_NESTING_LIMIT" || d.code == "SOURCE_DIAGNOSTICS_TRUNCATED");
        if !already {
            answer.diagnostics.push(json!({
                "code": "SOURCE_INDEX_NESTING_LIMIT",
                "severity": "blocker",
                "category": "syntax",
                "message": format!("Source index traversal exceeds the supported nesting limit of {}", super::reader::SOURCE_MAX_NESTING),
                "location": positions.location(display, start, end, None),
                "details": { "limit": super::reader::SOURCE_MAX_NESTING },
            }));
        }
    }
    answer.symbols = walked
        .symbols
        .iter()
        .zip(&walked.rich)
        .map(|((kind, id, _, _), rich)| json!([kind.as_str(), id, positions.location(display, rich.start, rich.end, Some(id)), rich.metadata]))
        .collect();
    if file.shadowed {
        answer.diagnostics.clear();
    } else {
        answer.references = walked
            .references
            .iter()
            .map(|r| json!([r.kind, r.from, r.to_kind.as_str(), r.to, positions.location(display, r.offset, r.end, Some(&r.from))]))
            .collect();
    }
    answer
}

/// Why a request could not be answered.
#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Index the files of a request. `payload` holds the bytes of the files given by `payload`.
pub fn index_files(request: &Request, payload: &[u8]) -> Result<Value, Refusal> {
    if request.schema != REQUEST_SCHEMA {
        return Err(Refusal { code: "invalid_request", message: format!("schema must be {REQUEST_SCHEMA}") });
    }
    let answers: Result<Vec<Value>, Refusal> = request
        .files
        .par_iter()
        .map(|file| {
            let owned_bytes;
            let bytes: &[u8] = match (&file.path, file.payload) {
                (Some(path), None) => {
                    owned_bytes =
                        std::fs::read(path).map_err(|e| Refusal { code: "SCAN_READ_FAILED", message: format!("cannot read {}: {e}", file.display_path) })?;
                    if let Some(expected) = &file.sha256
                        && hex(&Sha256::digest(&owned_bytes)) != *expected
                    {
                        return Err(Refusal { code: "SOURCE_REVISION_STALE", message: format!("{} changed after the scan read it", file.display_path) });
                    }
                    &owned_bytes
                }
                (None, Some((offset, length))) => payload
                    .get(offset..offset.saturating_add(length))
                    .ok_or_else(|| Refusal { code: "invalid_request", message: format!("{} names bytes past the end of the payload", file.display_path) })?,
                _ => {
                    return Err(Refusal { code: "invalid_request", message: format!("{} needs exactly one of path and payload", file.display_path) });
                }
            };
            Ok(index_one(file, bytes).into_json())
        })
        .collect();
    Ok(json!({ "schema": RESPONSE_SCHEMA, "files": answers? }))
}

/// Answer one framed request (`hoi4-engine index-files` and the `index.files` op of `serve`).
pub fn respond(request: &Value, payload: &[u8]) -> Result<Value, Value> {
    let mut request = request.clone();
    if let Some(fields) = request.as_object_mut() {
        for framing in ["id", "op", "payload"] {
            fields.remove(framing);
        }
    }
    let request: Request =
        serde_json::from_value(request).map_err(|e| json!({ "code": "invalid_request", "message": format!("invalid index-files request: {e}") }))?;
    index_files(&request, payload).map_err(|refusal| json!({ "code": refusal.code, "message": refusal.message }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(relative: &str) -> FileRequest {
        FileRequest {
            path: None,
            payload: None,
            sha256: None,
            display_path: format!("mod:{relative}"),
            relative_path: relative.into(),
            definition_file: false,
            owned: true,
            shadowed: false,
        }
    }

    #[test]
    fn positions_count_utf16_units_and_crlf_as_one_break() {
        let positions = Positions::new("a\r\nü𝄞=x\nz");
        // The byte after the CR LF is line 2; `𝄞` is two UTF-16 units.
        assert_eq!(positions.position(3), json!({ "line": 2, "column": 1, "offset": 3 }));
        // Bytes: a, CR, LF, ü (2), 𝄞 (4), then `=` at byte 9, which is unit 6.
        assert_eq!(positions.unit(9), 6);
        // An offset on the LF of a CR LF reports the next line, as `positionAt` does.
        assert_eq!(positions.position(2), json!({ "line": 2, "column": 1, "offset": 2 }));
        assert_eq!(positions.position(9), json!({ "line": 3, "column": 1, "offset": 9 }));
    }

    #[test]
    fn a_script_file_gives_located_symbols_metadata_and_references() {
        let text = "focus_tree = {\n\tid = t\n\tfocus = {\n\t\tid = f\n\t\tx = 3\n\t\tprerequisite = { focus = g }\n\t}\n}\n";
        let answer = index_one(&file("common/national_focus/t.txt"), text.as_bytes()).into_json();
        let symbols = answer["symbols"].as_array().unwrap();
        assert_eq!(symbols[0][0], "focus_tree");
        assert_eq!(symbols[0][2]["start"], json!({ "line": 1, "column": 1, "offset": 0 }));
        assert_eq!(symbols[0][2]["symbol"], "t");
        assert_eq!(symbols[1][3], json!({ "x": 3 }));
        let references = answer["references"].as_array().unwrap();
        assert_eq!(references[0][0], "focus_prerequisite");
        assert_eq!(references[0][2], "focus");
        assert_eq!(references[0][3], "g");
        assert_eq!(references[0][4]["symbol"], "f");
    }

    #[test]
    fn owned_parser_diagnostics_are_reported_and_shadowed_files_drop_them() {
        let text = "a = { b = 1\n";
        let answer = index_one(&file("common/ideas/a.txt"), text.as_bytes()).into_json();
        assert_eq!(answer["diagnostics"][0]["code"], "SOURCE_UNCLOSED_BLOCK");
        assert_eq!(answer["diagnostics"][0]["location"]["start"]["offset"], 4);
        let mut shadowed = file("common/ideas/a.txt");
        shadowed.shadowed = true;
        assert_eq!(index_one(&shadowed, text.as_bytes()).into_json()["diagnostics"], json!([]));
        let mut game = file("common/ideas/a.txt");
        game.owned = false;
        assert_eq!(index_one(&game, text.as_bytes()).into_json()["diagnostics"], json!([]));
    }

    #[test]
    fn localisation_values_and_tables_carry_their_metadata() {
        let text = "\u{feff}l_english:\n k:0 \"a \\\"b\\\"\\n\"\n";
        let answer = index_one(&file("localisation/english/a_l_english.yml"), text.as_bytes()).into_json();
        assert_eq!(answer["symbols"][0][1], "l_english:k");
        assert_eq!(answer["symbols"][0][3], json!({ "language": "l_english", "key": "k", "value": "a \"b\"\n" }));
        assert!(answer["symbols"][0][2].get("symbol").is_none());
        let mut definitions = file("map/definition.csv");
        definitions.definition_file = true;
        let table = index_one(&definitions, b"1;10;20;30;land;false;plains;1\n").into_json();
        assert_eq!(
            table["symbols"][0][3],
            json!({ "color": "10,20,30", "type": "land", "coastal": "false", "terrain": "plains", "continent": "1", "line": 1 })
        );
        assert_eq!(table["symbols"][1], json!(["province_color", "10,20,30", null, { "provinceId": "1", "line": 1 }]));
    }
}

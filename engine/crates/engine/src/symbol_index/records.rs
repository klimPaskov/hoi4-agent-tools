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
use serde::{Deserialize, Serialize};
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

/// A TypeScript `SourceLocation` without its path and symbol: start line, column and UTF-16
/// offset, then end line, column and offset. The server adds the path and the symbol.
pub type Loc = [u32; 6];

/// `createSourceLineIndex` and `positionAt`: positions in UTF-16 code units, reached from byte
/// offsets through a table of line starts.
struct Positions<'t> {
    text: &'t str,
    ascii: bool,
    /// Byte offset and UTF-16 offset of each line's start.
    starts: Vec<(u32, u32)>,
    /// UTF-16 length of the text.
    units: u32,
}

impl<'t> Positions<'t> {
    fn new(text: &'t str) -> Self {
        let ascii = text.is_ascii();
        let bytes = text.as_bytes();
        let mut starts = vec![(0u32, 0u32)];
        let mut unit = 0u32;
        let mut i = 0usize;
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'\r' {
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                    unit += 1;
                }
                i += 1;
                unit += 1;
                starts.push((i as u32, unit));
            } else if b == b'\n' {
                i += 1;
                unit += 1;
                starts.push((i as u32, unit));
            } else if b < 0x80 || ascii {
                i += 1;
                unit += 1;
            } else {
                let c = text[i..].chars().next().unwrap_or(' ');
                i += c.len_utf8();
                unit += c.len_utf16() as u32;
            }
        }
        Positions { text, ascii, starts, units: unit }
    }

    fn line_of_byte(&self, byte: u32) -> usize {
        self.starts.partition_point(|&(start, _)| start <= byte).max(1) - 1
    }

    /// UTF-16 offset of a byte offset (a character boundary).
    fn unit(&self, byte: u32) -> u32 {
        let byte = byte.min(self.text.len() as u32);
        let line = self.line_of_byte(byte);
        let (start_byte, start_unit) = self.starts[line];
        start_unit + self.units_between(start_byte, byte)
    }

    fn units_between(&self, from: u32, to: u32) -> u32 {
        if self.ascii {
            return to - from;
        }
        let slice = &self.text.as_bytes()[from as usize..to as usize];
        if slice.is_ascii() {
            return to - from;
        }
        self.text[from as usize..to as usize].encode_utf16().count() as u32
    }

    /// `positionAt` of a byte offset: line, column and UTF-16 offset.
    fn position(&self, byte: u32) -> [u32; 3] {
        let bytes = self.text.as_bytes();
        let byte = byte.min(bytes.len() as u32);
        let line = self.line_of_byte(byte);
        let (start_byte, start_unit) = self.starts[line];
        let column = self.units_between(start_byte, byte);
        let unit = start_unit + column;
        let at = byte as usize;
        if at < bytes.len() && at > 0 && bytes[at] == b'\n' && bytes[at - 1] == b'\r' {
            return [line as u32 + 2, 1, unit];
        }
        [line as u32 + 1, column + 1, unit]
    }

    /// `positionAt` of a UTF-16 offset.
    fn position_of_unit(&self, unit: u32) -> [u32; 3] {
        let bounded = unit.min(self.units);
        let line = self.starts.partition_point(|&(_, start)| start <= bounded).max(1) - 1;
        let (start_byte, start_unit) = self.starts[line];
        // The byte this unit starts, if it starts a character, for the CR LF rule.
        let mut byte = start_byte as usize;
        let mut at = start_unit;
        for c in self.text[start_byte as usize..].chars() {
            if at >= bounded {
                break;
            }
            at += c.len_utf16() as u32;
            byte += c.len_utf8();
        }
        let bytes = self.text.as_bytes();
        if at == bounded && byte < bytes.len() && byte > 0 && bytes[byte] == b'\n' && bytes[byte - 1] == b'\r' {
            return [line as u32 + 2, 1, unit];
        }
        [line as u32 + 1, bounded - start_unit + 1, unit]
    }

    fn loc(&self, start: u32, end: u32) -> Loc {
        let [a, b, c] = self.position(start);
        let [d, e, f] = self.position(end);
        [a, b, c, d, e, f]
    }

    /// A full TypeScript `SourceLocation`, for diagnostics.
    fn location(path: &str, start: [u32; 3], end: [u32; 3], symbol: Option<&str>) -> Value {
        let position = |p: [u32; 3]| json!({ "line": p[0], "column": p[1], "offset": p[2] });
        let mut location = json!({ "path": path, "start": position(start), "end": position(end) });
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
                At::Bytes(start, end) => Self::location(path, self.position(start), self.position(end), None),
                At::Utf16(start, end) => Self::location(path, self.position_of_unit(start), self.position_of_unit(end), None),
                At::Fixed(line, column, offset) => Self::location(path, [line, column, offset], [line, column, offset], None),
                At::FixedAtByte(line, column, byte) => {
                    let offset = self.unit(byte);
                    Self::location(path, [line, column, offset], [line, column, offset], None)
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

/// `[kind, id, location or null, metadata]`.
type SymbolOut = (&'static str, String, Option<Loc>, Map<String, Value>);
/// `[kind, from, toKind, to, location]`.
type ReferenceOut = (std::borrow::Cow<'static, str>, String, &'static str, String, Loc);

/// What indexing one file gives the server.
#[derive(Default, Serialize)]
struct FileAnswer {
    symbols: Vec<SymbolOut>,
    references: Vec<ReferenceOut>,
    diagnostics: Vec<Value>,
    /// The ceiling diagnostics that make the index skip the file.
    skip: Option<Vec<Value>>,
    /// A table or nesting ceiling made the index incomplete.
    incomplete: bool,
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
                symbols.push((SymbolKind::Province.as_str(), parts[0].to_string(), None, metadata));
                let mut colour = Map::new();
                colour.insert("provinceId".into(), parts[0].into());
                colour.insert("line".into(), line.into());
                symbols.push((SymbolKind::ProvinceColor.as_str(), color, None, colour));
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
                    symbols.push((SymbolKind::Adjacency.as_str(), format!("{}:{}:{}:{line}", parts[0], parts[1], parts[2]), None, metadata));
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
                let mut metadata = Map::new();
                metadata.insert("values".into(), values.iter().map(|v| Value::from(*v)).collect());
                metadata.insert("line".into(), line.into());
                symbols.push((kind.as_str(), format!("{line}:{}", values.join(":")), None, metadata));
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
                let location = positions.loc(entry.start, entry.end);
                let id = format!("{}:{}", entry.language, entry.key);
                let mut metadata = Map::new();
                metadata.insert("language".into(), entry.language.into());
                metadata.insert("key".into(), entry.key.into());
                metadata.insert("value".into(), entry.value.into());
                (SymbolKind::Localisation.as_str(), id, Some(location), metadata)
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
                "location": Positions::location(display, positions.position(start), positions.position(end), None),
                "details": { "limit": super::reader::SOURCE_MAX_NESTING },
            }));
        }
    }
    answer.symbols = walked
        .symbols
        .into_iter()
        .zip(walked.rich)
        .map(|((kind, id, _, _), rich)| (kind.as_str(), id, Some(positions.loc(rich.start, rich.end)), rich.metadata))
        .collect();
    if file.shadowed {
        answer.diagnostics.clear();
    } else {
        answer.references = walked.references.into_iter().map(|r| (r.kind, r.from, r.to_kind.as_str(), r.to, positions.loc(r.offset, r.end))).collect();
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

/// Index the files of a request and answer `hoi4-index-files/1` as JSON bytes. `payload` holds
/// the bytes of the files given by `payload`.
pub fn index_files(request: &Request, payload: &[u8]) -> Result<Vec<u8>, Refusal> {
    if request.schema != REQUEST_SCHEMA {
        return Err(Refusal { code: "invalid_request", message: format!("schema must be {REQUEST_SCHEMA}") });
    }
    let answers: Result<Vec<Vec<u8>>, Refusal> = request
        .files
        .par_iter()
        .map(|file| {
            let owned_bytes;
            let bytes: &[u8] = match (&file.path, file.payload) {
                (Some(path), None) => {
                    // A file that is gone or no longer holds the bytes the server read (an edit
                    // since, or a proposed rewrite of it) is answered with `retry`: the server
                    // sends those files' bytes in a second request.
                    let Ok(read) = std::fs::read(path) else { return Ok(br#"{"retry":true}"#.to_vec()) };
                    if file.sha256.as_ref().is_some_and(|expected| hex(&Sha256::digest(&read)) != *expected) {
                        return Ok(br#"{"retry":true}"#.to_vec());
                    }
                    owned_bytes = read;
                    &owned_bytes
                }
                (None, Some((offset, length))) => payload
                    .get(offset..offset.saturating_add(length))
                    .ok_or_else(|| Refusal { code: "invalid_request", message: format!("{} names bytes past the end of the payload", file.display_path) })?,
                _ => {
                    return Err(Refusal { code: "invalid_request", message: format!("{} needs exactly one of path and payload", file.display_path) });
                }
            };
            serde_json::to_vec(&index_one(file, bytes)).map_err(|e| Refusal { code: "internal", message: e.to_string() })
        })
        .collect();
    let answers = answers?;
    let mut out = Vec::with_capacity(answers.iter().map(Vec::len).sum::<usize>() + answers.len() + 64);
    out.extend_from_slice(format!(r#"{{"schema":"{RESPONSE_SCHEMA}","files":["#).as_bytes());
    for (i, answer) in answers.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(answer);
    }
    out.extend_from_slice(b"]}");
    Ok(out)
}

/// Answer one framed request (`hoi4-engine index-files` and the `index.files` op of `serve`) with
/// the JSON bytes of `hoi4-index-files/1`.
pub fn respond(request: &Value, payload: &[u8]) -> Result<Vec<u8>, Value> {
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

    fn answer(file: &FileRequest, text: &[u8]) -> Value {
        serde_json::to_value(index_one(file, text)).unwrap()
    }

    #[test]
    fn positions_count_utf16_units_and_crlf_as_one_break() {
        let positions = Positions::new("a\r\nü𝄞=x\nz");
        // Bytes: a, CR, LF, ü (2), 𝄞 (4), then `=` at byte 9, which is unit 6.
        assert_eq!(positions.position(3), [2, 1, 3]);
        assert_eq!(positions.unit(9), 6);
        assert_eq!(positions.position(9), [2, 4, 6]);
        // An offset on the LF of a CR LF reports the next line, as `positionAt` does.
        assert_eq!(positions.position(2), [2, 1, 2]);
        assert_eq!(positions.position(12), [3, 1, 9]);
        assert_eq!(positions.position_of_unit(6), [2, 4, 6]);
        assert_eq!(positions.position_of_unit(2), [2, 1, 2]);
    }

    #[test]
    fn a_script_file_gives_located_symbols_metadata_and_references() {
        let text = "focus_tree = {\n\tid = t\n\tfocus = {\n\t\tid = f\n\t\tx = 3\n\t\tprerequisite = { focus = g }\n\t}\n}\n";
        let answer = answer(&file("common/national_focus/t.txt"), text.as_bytes());
        assert_eq!(answer["symbols"][0][0], "focus_tree");
        assert_eq!(answer["symbols"][0][2], json!([1, 1, 0, 8, 2, text.len() - 1]));
        assert_eq!(answer["symbols"][1][3], json!({ "x": 3 }));
        let reference = &answer["references"][0];
        assert_eq!(
            (reference[0].as_str(), reference[1].as_str(), reference[2].as_str(), reference[3].as_str()),
            (Some("focus_prerequisite"), Some("f"), Some("focus"), Some("g"))
        );
    }

    #[test]
    fn owned_parser_diagnostics_are_reported_and_shadowed_files_drop_them() {
        let text = "a = { b = 1\n";
        let found = answer(&file("common/ideas/a.txt"), text.as_bytes());
        assert_eq!(found["diagnostics"][0]["code"], "SOURCE_UNCLOSED_BLOCK");
        assert_eq!(found["diagnostics"][0]["location"]["start"]["offset"], 4);
        let mut shadowed = file("common/ideas/a.txt");
        shadowed.shadowed = true;
        assert_eq!(answer(&shadowed, text.as_bytes())["diagnostics"], json!([]));
        let mut game = file("common/ideas/a.txt");
        game.owned = false;
        assert_eq!(answer(&game, text.as_bytes())["diagnostics"], json!([]));
    }

    #[test]
    fn localisation_values_and_tables_carry_their_metadata() {
        let text = "\u{feff}l_english:\n k:0 \"a \\\"b\\\"\\n\"\n";
        let found = answer(&file("localisation/english/a_l_english.yml"), text.as_bytes());
        assert_eq!(found["symbols"][0][1], "l_english:k");
        assert_eq!(found["symbols"][0][3], json!({ "language": "l_english", "key": "k", "value": "a \"b\"\n" }));
        let mut definitions = file("map/definition.csv");
        definitions.definition_file = true;
        let table = answer(&definitions, b"1;10;20;30;land;false;plains;1\n");
        assert_eq!(
            table["symbols"][0][3],
            json!({ "color": "10,20,30", "type": "land", "coastal": "false", "terrain": "plains", "continent": "1", "line": 1 })
        );
        assert_eq!(table["symbols"][1], json!(["province_color", "10,20,30", null, { "provinceId": "1", "line": 1 }]));
    }

    #[test]
    fn a_request_answers_every_file_in_order_and_retries_changed_ones() {
        let directory = std::env::temp_dir().join(format!("hoi4-index-files-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let on_disk = directory.join("a.txt");
        std::fs::write(&on_disk, "ideas = { x = { a = { } } }\n").unwrap();
        let mut disk = file("common/ideas/a.txt");
        disk.path = Some(on_disk.to_string_lossy().into_owned());
        let mut changed = disk.clone();
        changed.sha256 = Some("0".repeat(64));
        let mut inline = file("common/ideas/b.txt");
        inline.payload = Some((0, 5));
        let request = Request { schema: REQUEST_SCHEMA.into(), files: vec![disk, changed, inline] };
        let out: Value = serde_json::from_slice(&index_files(&request, b"b = 1").unwrap()).unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(out["schema"], RESPONSE_SCHEMA);
        assert_eq!(out["files"][0]["symbols"][0][1], "a");
        assert_eq!(out["files"][1], json!({ "retry": true }));
        assert_eq!(out["files"][2]["symbols"], json!([]));
    }
}

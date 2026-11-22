//! Shared source helpers of the script writers.
//!
//! Ported from `src/hoi4_agent_tools/core/block-edit.ts` (`lineIndent`, `indentedBody`),
//! `core/source/rewrite.ts` (`applyReplacements`), `core/source/encoding.ts` (`encodeSource`,
//! `assertSourceEncodingPreserved`) and `core/source/parser.ts` (`assignments`,
//! `assertRewriteSafe`), commit `ef3d2215`. The TypeScript code works on decoded text with
//! UTF-16 offsets; this port works on the file's bytes with byte offsets. The edits are the same
//! because every structural byte is ASCII and inserted text is encoded into the file's own
//! encoding.

use std::ops::Range;

use hoi4_syntax::{Block, Document, Encoding, Entry, Item, Value};
use serde_json::{Map, Value as Json, json};

/// The parsing ceiling of the TypeScript parser (`SOURCE_MAX_BYTES`).
pub const SOURCE_MAX_BYTES: usize = 33_554_432;
/// Diagnostics the TypeScript parser keeps per file (`SOURCE_DIAGNOSTIC_LIMIT`).
const SOURCE_DIAGNOSTIC_LIMIT: usize = 100;

/// A refusal of a writer, in the TypeScript `ServiceError` shape: a stable code, a message and
/// details that reach the caller unchanged.
#[derive(Clone, Debug, PartialEq)]
pub struct WriteError {
    pub code: String,
    pub message: String,
    pub details: Map<String, Json>,
}

pub type WriteResult<T> = Result<T, WriteError>;

pub fn fail<T>(code: &str, message: impl Into<String>, details: Json) -> WriteResult<T> {
    Err(WriteError::new(code, message, details))
}

impl WriteError {
    pub fn new(code: &str, message: impl Into<String>, details: Json) -> Self {
        let details = match details {
            Json::Object(map) => map,
            _ => Map::new(),
        };
        Self { code: code.into(), message: message.into(), details }
    }

    /// The error body of an engine operation: code and message, then the details flattened.
    pub fn to_json(&self) -> Json {
        let mut body = Map::new();
        body.insert("code".into(), json!(self.code));
        body.insert("message".into(), json!(self.message));
        for (key, value) in &self.details {
            if key != "code" && key != "message" {
                body.insert(key.clone(), value.clone());
            }
        }
        Json::Object(body)
    }
}

/// One replacement of a byte range, as the TypeScript `SourceReplacement`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replacement {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub description: String,
}

impl Replacement {
    pub fn to_json(&self) -> Json {
        json!({ "start": self.start, "end": self.end, "text": self.text, "description": self.description })
    }
}

/// A parsed source file the writers read.
pub struct Source {
    pub document: Document,
    pub path: String,
}

/// The codes of a document's diagnostics, in order, kept to the TypeScript per-file limit.
pub fn diagnostic_codes(source: &Source) -> Json {
    let mut codes: Vec<&str> = Vec::new();
    if source.document.bytes.len() > SOURCE_MAX_BYTES {
        codes.push("SOURCE_FILE_SIZE_LIMIT");
    }
    codes.extend(source.document.diagnostics.iter().map(|d| d.code));
    if codes.len() > SOURCE_DIAGNOSTIC_LIMIT {
        codes.truncate(SOURCE_DIAGNOSTIC_LIMIT);
        codes[SOURCE_DIAGNOSTIC_LIMIT - 1] = "SOURCE_DIAGNOSTICS_TRUNCATED";
    }
    json!(codes)
}

impl Source {
    pub fn parse(bytes: &[u8], path: &str) -> Self {
        Self { document: Document::parse(bytes.to_vec()), path: path.to_string() }
    }

    /// `hasBlockingDiagnostics`: every diagnostic of the Rust parser is an error or a blocker.
    pub fn has_blocking(&self) -> bool {
        !self.document.diagnostics.is_empty() || self.document.bytes.len() > SOURCE_MAX_BYTES
    }

    pub fn bytes(&self) -> &[u8] {
        &self.document.bytes
    }

    /// The first newline style of the file, `\n` when it has none (`detectNewline`).
    pub fn newline(&self) -> &'static str {
        let bytes = self.bytes();
        let crlf = bytes.windows(2).position(|w| w == b"\r\n");
        let lf = bytes.iter().position(|&b| b == b'\n');
        let cr = bytes.iter().position(|&b| b == b'\r');
        if let Some(c) = crlf
            && lf.is_none_or(|l| c <= l)
        {
            return "\r\n";
        }
        if lf.is_some() {
            "\n"
        } else if cr.is_some() {
            "\r"
        } else {
            "\n"
        }
    }

    pub fn encoding_name(&self) -> &'static str {
        match self.document.encoding {
            Encoding::Utf8 => "utf8",
            Encoding::Utf8Bom => "utf8-bom",
            Encoding::Windows1252 => "windows-1252",
        }
    }

    /// The text of a byte range, decoded.
    pub fn slice(&self, range: Range<usize>) -> String {
        hoi4_syntax::encoding::decode(&self.bytes()[range], self.document.encoding).into_owned()
    }

    pub fn key(&self, entry: &Entry) -> String {
        self.document.key(entry).into_owned()
    }

    /// The byte range of an entry: its key to the end of its value.
    pub fn entry_range(&self, entry: &Entry) -> Range<usize> {
        let start = self.document.token(entry.key).start as usize;
        let end = match &entry.value {
            Value::Missing => entry.op.map_or(self.document.token(entry.key).end, |op| self.document.token(op).end),
            Value::Scalar(token) => self.document.token(*token).end,
            Value::Block(block) | Value::Tagged { block, .. } => self.block_end(block),
        };
        start..end as usize
    }

    /// The end of a block: after its closing brace, or the end of the file when it has none.
    pub fn block_end(&self, block: &Block) -> u32 {
        match block.close {
            Some(close) => self.document.token(close).end,
            None => self.bytes().len() as u32,
        }
    }

    pub fn line_of(&self, offset: usize) -> u32 {
        self.document.position(offset as u32).0
    }

    pub fn line_of_key(&self, entry: &Entry) -> u32 {
        self.line_of(self.document.token(entry.key).start as usize)
    }

    /// The byte range of a block's closing brace.
    pub fn close_range(&self, block: &Block) -> Option<Range<usize>> {
        block.close.map(|close| self.document.token(close).range())
    }
}

/// `assignments(block, key)`: entries whose key is `key`, or every entry.
pub fn assignments<'a>(source: &Source, block: &'a Block, key: Option<&str>) -> Vec<&'a Entry> {
    block.items.iter().filter_map(Item::as_entry).filter(|entry| key.is_none_or(|wanted| source.key(entry) == wanted)).collect()
}

/// The block value of an entry, when it has one.
pub fn block_of(entry: &Entry) -> Option<&Block> {
    match &entry.value {
        Value::Block(block) => Some(block),
        _ => None,
    }
}

/// The whitespace that starts the line `offset` is on (`lineIndent`).
pub fn line_indent(bytes: &[u8], offset: usize) -> String {
    let start = line_start(bytes, offset);
    let prefix = &bytes[start..offset];
    let take = prefix.iter().take_while(|&&b| b == b' ' || b == b'\t').count();
    String::from_utf8_lossy(&prefix[..take]).into_owned()
}

/// The start of the line `offset` is on (`lastIndexOf('\n', offset - 1) + 1`).
pub fn line_start(bytes: &[u8], offset: usize) -> usize {
    bytes[..offset].iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1)
}

/// True when every byte is a space or a tab.
pub fn blank(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| b == b' ' || b == b'\t')
}

/// The body re-indented to `inner`, without its common leading indentation and blank edges
/// (`indentedBody`).
pub fn indented_body(body: &str, inner: &str, newline: &str) -> String {
    let mut lines: Vec<String> = split_lines(body).into_iter().map(|line| line.trim_end_matches([' ', '\t']).to_string()).collect();
    while lines.first().is_some_and(String::is_empty) {
        lines.remove(0);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let common = lines
        .iter()
        .filter(|line| !line.is_empty())
        .map(|line| line.bytes().take_while(|&b| b == b' ' || b == b'\t').count())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| if line.is_empty() { String::new() } else { format!("{inner}{}", &line[common..]) })
        .collect::<Vec<_>>()
        .join(newline)
}

/// Splits on `\r\n`, `\r` and `\n`.
pub fn split_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                out.push(&text[start..i]);
                i += if bytes.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
                start = i;
            }
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[start..]);
    out
}

/// Windows-1252 bytes the encoding leaves undefined; rewriting them would change them.
const UNDEFINED_1252: [u8; 5] = [0x81, 0x8D, 0x8F, 0x90, 0x9D];

/// `assertRewriteSafe` and `assertSourceEncodingPreserved`: refuses a source a rewrite cannot
/// reproduce byte for byte.
pub fn assert_rewrite_safe(source: &Source) -> WriteResult<()> {
    if source.has_blocking() {
        return fail(
            "SOURCE_UNSAFE_REWRITE",
            "Source contains syntax errors and cannot be rewritten safely",
            json!({ "path": source.path, "diagnosticCodes": diagnostic_codes(source) }),
        );
    }
    if source.document.encoding == Encoding::Windows1252 {
        let bad: Vec<(usize, u8)> = source.bytes().iter().copied().enumerate().filter(|(_, b)| UNDEFINED_1252.contains(b)).collect();
        if let Some((first, _)) = bad.first() {
            let mut values: Vec<u8> = bad.iter().map(|(_, b)| *b).collect();
            values.sort_unstable();
            values.dedup();
            let names: Vec<String> = values.iter().map(|v| format!("0x{v:X}")).collect();
            return fail(
                "SOURCE_ENCODING_NOT_ROUND_TRIPPABLE",
                format!(
                    "Source is not valid UTF-8 and contains {} byte(s) ({}) that Windows-1252 cannot represent; editing it would silently rewrite them. Convert the file to UTF-8 or replace those bytes, then retry",
                    bad.len(),
                    names.join(", ")
                ),
                json!({ "path": source.path, "encoding": source.encoding_name(), "byteCount": bad.len(), "byteValues": names, "firstByteOffset": first }),
            );
        }
    }
    Ok(())
}

/// `encodeSource`: the text in the file's own encoding. Windows-1252 refuses characters it cannot
/// hold.
pub fn encode_text(text: &str, encoding: Encoding) -> WriteResult<Vec<u8>> {
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => Ok(text.as_bytes().to_vec()),
        Encoding::Windows1252 => {
            let mut out = Vec::with_capacity(text.len());
            for ch in text.chars() {
                let code = ch as u32;
                let byte = if code < 0x80 || (0xA0..=0xFF).contains(&code) {
                    Some(code as u8)
                } else {
                    (0x80u8..=0x9F).find(|b| ch != '\u{FFFD}' && hoi4_syntax::encoding::decode(&[*b], Encoding::Windows1252).chars().next() == Some(ch))
                };
                match byte {
                    Some(byte) => out.push(byte),
                    None => {
                        return fail(
                            "SOURCE_ENCODING_UNREPRESENTABLE",
                            "The edit introduces characters that cannot be represented in the source encoding",
                            json!({ "encoding": "windows-1252" }),
                        );
                    }
                }
            }
            Ok(out)
        }
    }
}

/// `applyReplacements`: the file with the replacements made, in its own encoding.
pub fn apply_replacements(source: &Source, replacements: &[Replacement]) -> WriteResult<Vec<u8>> {
    let bytes = source.bytes();
    if replacements.is_empty() {
        return Ok(bytes.to_vec());
    }
    assert_rewrite_safe(source)?;
    let mut ordered: Vec<&Replacement> = replacements.iter().collect();
    ordered.sort_by_key(|r| (r.start, r.end));
    let mut cursor = 0usize;
    let mut out = Vec::with_capacity(bytes.len());
    for replacement in ordered {
        if replacement.start < cursor || replacement.end < replacement.start || replacement.end > bytes.len() {
            return fail("SOURCE_REPLACEMENT_OVERLAP", "Replacement ranges overlap or are invalid", json!({ "replacement": replacement.to_json() }));
        }
        out.extend_from_slice(&bytes[cursor..replacement.start]);
        out.extend_from_slice(&encode_text(&replacement.text, source.document.encoding)?);
        cursor = replacement.end;
    }
    out.extend_from_slice(&bytes[cursor..]);
    Ok(out)
}

/// The probe every writer runs on a body: `id = {\nbody\n}` must parse cleanly into exactly one
/// entry named `id` (`assertBodyIsOneBlock`). `Err` carries the probe's diagnostic codes.
pub fn probe_one_block(id: &str, body: &str) -> Result<Document, Vec<&'static str>> {
    let probe = Document::parse(format!("{id} = {{\n{body}\n}}\n").into_bytes());
    let codes: Vec<&'static str> = probe.diagnostics.iter().map(|d| d.code).collect();
    let single = matches!(probe.root.items.as_slice(), [Item::Entry(entry)] if probe.key(entry) == id);
    if !codes.is_empty() || !single {
        return Err(codes);
    }
    Ok(probe)
}

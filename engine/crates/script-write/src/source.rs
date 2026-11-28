//! Shared source helpers of the script writers.
//!
//! Ported from `src/hoi4_agent_tools/core/block-edit.ts` (`lineIndent`, `indentedBody`),
//! `core/source/rewrite.ts` (`applyReplacements`), `core/source/encoding.ts` (`decodeSource`,
//! `encodeSource`, `assertSourceEncodingPreserved`) and `core/source/parser.ts` (`assignments`,
//! `assertRewriteSafe`), commit `ef3d2215`.
//!
//! Reading is the engine's TypeScript-semantics reader (`hoi4_engine::symbol_index::reader`), so
//! the diagnostics, their codes and the recovery of odd layouts are the TypeScript parser's. Like
//! the TypeScript code, a writer edits the decoded text: the offsets of an edit are byte offsets of
//! that text, and the result is encoded back into the file's own encoding.

use std::borrow::Cow;
use std::ops::Range;

use hoi4_engine::symbol_index::reader::{self, EncodingLoss};
use serde_json::{Map, Value as Json, json};

pub use hoi4_engine::symbol_index::reader::{Assignment as Entry, Block, Entry as Item, Value};

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

/// One replacement of a byte range of the decoded text, as the TypeScript `SourceReplacement`.
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

/// The three encodings of `decodeSource`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Windows1252,
}

/// A file's bytes decoded as `decodeSource` does, with what it takes to encode text back.
pub struct Decoded {
    pub text: String,
    pub encoding: Encoding,
    pub loss: Option<EncodingLoss>,
    pub byte_len: usize,
}

impl Decoded {
    pub fn new(bytes: &[u8]) -> Self {
        let (text, _) = reader::decode(bytes);
        let encoding = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            Encoding::Utf8Bom
        } else if std::str::from_utf8(bytes).is_ok() {
            Encoding::Utf8
        } else {
            Encoding::Windows1252
        };
        let loss = if encoding == Encoding::Windows1252 { reader::windows_1252_loss(bytes) } else { None };
        Self { text: text.into_owned(), encoding, loss, byte_len: bytes.len() }
    }

    pub fn encoding_name(&self) -> &'static str {
        match self.encoding {
            Encoding::Utf8 => "utf8",
            Encoding::Utf8Bom => "utf8-bom",
            Encoding::Windows1252 => "windows-1252",
        }
    }

    /// `encodeSource`: the text in the file's own encoding. Windows-1252 refuses characters it
    /// cannot hold.
    pub fn encode(&self, text: &str) -> WriteResult<Vec<u8>> {
        match self.encoding {
            Encoding::Utf8 => Ok(text.as_bytes().to_vec()),
            Encoding::Utf8Bom => {
                let mut out = vec![0xEF, 0xBB, 0xBF];
                out.extend_from_slice(text.as_bytes());
                Ok(out)
            }
            Encoding::Windows1252 => encode_windows_1252(text),
        }
    }
}

fn encode_windows_1252(text: &str) -> WriteResult<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        let byte = if code < 0x80 || (0xA0..=0xFF).contains(&code) {
            Some(code as u8)
        } else {
            (0x80u8..=0x9F).find(|b| ch != '\u{FFFD}' && hoi4_syntax::encoding::decode(&[*b], hoi4_syntax::Encoding::Windows1252).starts_with(ch))
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

/// A parsed source file the writers read.
pub struct Source<'a> {
    pub decoded: &'a Decoded,
    pub path: String,
    pub document: reader::Document<'a>,
}

impl<'a> Source<'a> {
    pub fn new(decoded: &'a Decoded, path: &str) -> Self {
        let document = reader::parse_clausewitz_detailed(&decoded.text, decoded.byte_len, decoded.loss.as_ref());
        Self { decoded, path: path.to_string(), document }
    }

    /// `hasBlockingDiagnostics`: an error or a blocker among the retained diagnostics.
    pub fn has_blocking(&self) -> bool {
        self.document.diagnostics.retained().iter().any(|d| d.severity == "error" || d.severity == "blocker")
    }

    /// The codes of every retained diagnostic, in order (`diagnostics.map(({ code }) => code)`).
    pub fn diagnostic_codes(&self) -> Json {
        json!(self.document.diagnostics.retained().iter().map(|d| d.code).collect::<Vec<_>>())
    }

    /// The decoded text.
    pub fn text(&self) -> &'a str {
        &self.decoded.text
    }

    /// The decoded text as bytes; every offset of the reader indexes it.
    pub fn bytes(&self) -> &'a [u8] {
        self.decoded.text.as_bytes()
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

    /// The byte range of an entry: its key to the end of its value.
    pub fn entry_range(&self, entry: &Entry<'_>) -> Range<usize> {
        entry.key.start as usize..entry.end() as usize
    }

    /// The 1-based line of a byte offset.
    pub fn line_of(&self, offset: usize) -> u32 {
        1 + self.bytes()[..offset.min(self.bytes().len())].iter().filter(|&&b| b == b'\n').count() as u32
    }

    pub fn line_of_key(&self, entry: &Entry<'_>) -> u32 {
        entry.key.line
    }

    /// The byte range of a block's closing brace. A block that is not closed has none; such a
    /// source carries `SOURCE_UNCLOSED_BLOCK` and a writer refuses it before it asks.
    pub fn close_range(&self, block: &Block<'_>) -> Option<Range<usize>> {
        let end = block.end as usize;
        (end > 0 && block.end_line != 0 && self.bytes().get(end - 1) == Some(&b'}')).then(|| end - 1..end)
    }

    /// The start of an item of a block.
    pub fn item_start(item: &Item<'_>) -> usize {
        match item {
            Item::Scalar(s) => s.start as usize,
            Item::Assignment(a) => a.key.start as usize,
            Item::Block(b) => b.start as usize,
        }
    }
}

/// The key of an entry.
pub fn key_of(entry: &Entry<'_>) -> String {
    entry.key.value.to_string()
}

/// `assignments(block, key)`: entries whose key is `key`, or every entry.
pub fn assignments<'b, 'a>(block: &'b Block<'a>, key: Option<&str>) -> Vec<&'b Entry<'a>> {
    block.assignments().filter(|entry| key.is_none_or(|wanted| entry.key.value == wanted)).collect()
}

/// The block value of an entry, when it has one.
pub fn block_of<'b, 'a>(entry: &'b Entry<'a>) -> Option<&'b Block<'a>> {
    match &entry.value {
        Value::Block(block) => Some(block),
        Value::Scalar(_) => None,
    }
}

/// The scalar value of an entry, when it has one.
pub fn scalar_of<'b>(entry: &'b Entry<'_>) -> Option<Cow<'b, str>> {
    match &entry.value {
        Value::Scalar(scalar) => Some(Cow::Borrowed(scalar.value.as_ref())),
        Value::Block(_) => None,
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
    let common = lines.iter().filter(|line| !line.is_empty()).map(|line| line.bytes().take_while(|&b| b == b' ' || b == b'\t').count()).min().unwrap_or(0);
    lines.iter().map(|line| if line.is_empty() { String::new() } else { format!("{inner}{}", &line[common..]) }).collect::<Vec<_>>().join(newline)
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

/// `assertRewriteSafe` and `assertSourceEncodingPreserved`: refuses a source a rewrite cannot
/// reproduce byte for byte.
pub fn assert_rewrite_safe(source: &Source<'_>) -> WriteResult<()> {
    if source.has_blocking() {
        return fail(
            "SOURCE_UNSAFE_REWRITE",
            "Source contains syntax errors and cannot be rewritten safely",
            json!({ "path": source.path, "diagnosticCodes": source.diagnostic_codes() }),
        );
    }
    if let Some(loss) = &source.decoded.loss {
        let mut values = loss.values.clone();
        values.sort_unstable();
        let names: Vec<String> = values.iter().map(|v| format!("0x{v:X}")).collect();
        return fail(
            "SOURCE_ENCODING_NOT_ROUND_TRIPPABLE",
            format!(
                "Source is not valid UTF-8 and contains {} byte(s) ({}) that Windows-1252 cannot represent; editing it would silently rewrite them. Convert the file to UTF-8 or replace those bytes, then retry",
                loss.count,
                names.join(", ")
            ),
            json!({ "path": source.path, "encoding": source.decoded.encoding_name(), "byteCount": loss.count, "byteValues": names, "firstByteOffset": loss.first_offset }),
        );
    }
    Ok(())
}

/// `applyReplacements` on the decoded text: the edited text and the file after the edit, in its own
/// encoding.
pub fn apply_replacements(source: &Source<'_>, replacements: &[Replacement]) -> WriteResult<(String, Vec<u8>)> {
    let text = source.text();
    if replacements.is_empty() {
        return Ok((text.to_string(), source.decoded.encode(text)?));
    }
    assert_rewrite_safe(source)?;
    let mut ordered: Vec<&Replacement> = replacements.iter().collect();
    ordered.sort_by_key(|r| (r.start, r.end));
    let mut cursor = 0usize;
    let mut out = String::with_capacity(text.len());
    for replacement in ordered {
        if replacement.start < cursor
            || replacement.end < replacement.start
            || replacement.end > text.len()
            || !text.is_char_boundary(replacement.start)
            || !text.is_char_boundary(replacement.end)
        {
            return fail("SOURCE_REPLACEMENT_OVERLAP", "Replacement ranges overlap or are invalid", json!({ "replacement": replacement.to_json() }));
        }
        out.push_str(&text[cursor..replacement.start]);
        out.push_str(&replacement.text);
        cursor = replacement.end;
    }
    out.push_str(&text[cursor..]);
    let bytes = source.decoded.encode(&out)?;
    Ok((out, bytes))
}

/// The probe every writer runs on a body: `id = {\nbody\n}` must parse cleanly into exactly one
/// entry named `id` (`assertBodyIsOneBlock`). `Err` carries the probe's diagnostic codes. `inspect`
/// sees the probe's block when it parsed.
pub fn probe_one_block<T>(id: &str, body: &str, inspect: impl FnOnce(&Block<'_>) -> T) -> Result<T, Vec<&'static str>> {
    let text = format!("{id} = {{\n{body}\n}}\n");
    let document = reader::parse_clausewitz_detailed(&text, text.len(), None);
    let codes: Vec<&'static str> = document.diagnostics.retained().iter().map(|d| d.code).collect();
    let blocking = document.diagnostics.retained().iter().any(|d| d.severity == "error" || d.severity == "blocker");
    let only = match document.root.entries.as_slice() {
        [Item::Assignment(entry)] if entry.key.value == id => Some(entry),
        _ => None,
    };
    match only {
        Some(entry) if !blocking => match &entry.value {
            Value::Block(block) => Ok(inspect(block)),
            Value::Scalar(_) => Err(codes),
        },
        _ => Err(codes),
    }
}

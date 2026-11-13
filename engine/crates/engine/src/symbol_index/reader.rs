//! The TypeScript core's source reader, for the shared symbol index.
//!
//! Ported from this repository's `src/hoi4_agent_tools/core/source/encoding.ts` (`decodeSource`),
//! `lexer.ts` (`lexClausewitz`, `createSourceLineIndex`), `parser.ts` (`parseClausewitz`),
//! `limits.ts` and `localisation.ts` (`parseLocalisation`), at commit `5c75b21`.
//!
//! The symbol index must count exactly what the TypeScript index counted, so this reader keeps the
//! TypeScript reader's rules instead of `hoi4-syntax`'s: any operator (`=`, `<`, `>`, `?=` and the
//! unsupported `!=`, `<=`, `>=`, `==`) makes an assignment, `key { ... }` is a scalar followed by a
//! bare block, `color = rgb { ... }` is an assignment of `rgb` followed by a bare block, and an
//! operator or `}` where a value belongs is taken as the value. A file whose diagnostics reach the
//! TypeScript per-file ceiling (101 or more), or that hits a size, line, token, entry or nesting
//! ceiling, is reported as `partial`; the index skips it, as the TypeScript index did. Only the
//! diagnostics' count and whether a ceiling was hit are kept, not their text.

use std::borrow::Cow;

pub const SOURCE_DIAGNOSTIC_LIMIT: usize = 100;
pub const SOURCE_MAX_NESTING: usize = 256;
pub const SOURCE_MAX_BYTES: usize = 33_554_432;
pub const SOURCE_TOKEN_LIMIT: usize = 4_000_000;
pub const SOURCE_ENTRY_LIMIT: usize = 1_000_000;
pub const SOURCE_LINE_LIMIT: usize = 2_000_000;

/// The ceiling codes of `SOURCE_PARTIAL_LIMIT_CODES` in `limits.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Limit {
    FileSize,
    Line,
    Token,
    Entry,
    Nesting,
    DiagnosticsTruncated,
}

impl Limit {
    pub fn code(self) -> &'static str {
        match self {
            Limit::FileSize => "SOURCE_FILE_SIZE_LIMIT",
            Limit::Line => "SOURCE_LINE_LIMIT",
            Limit::Token => "SOURCE_TOKEN_LIMIT",
            Limit::Entry => "SOURCE_ENTRY_LIMIT",
            Limit::Nesting => "SOURCE_NESTING_LIMIT",
            Limit::DiagnosticsTruncated => "SOURCE_DIAGNOSTICS_TRUNCATED",
        }
    }
}

/// Where a source diagnostic points: a span of the decoded text in bytes or in UTF-16 code units
/// (the TypeScript offsets), or a fixed position the TypeScript reader writes as it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum At {
    Bytes(u32, u32),
    Utf16(u32, u32),
    /// Line, column and UTF-16 offset, the same for start and end.
    Fixed(u32, u32, u32),
    /// Line and column with the UTF-16 offset of a byte position.
    FixedAtByte(u32, u32, u32),
}

/// One diagnostic of the TypeScript source reader, kept when [`Diagnostics::detailed`] asks.
#[derive(Clone, Debug)]
pub struct SourceDiagnostic {
    pub code: &'static str,
    pub severity: &'static str,
    pub message: String,
    pub at: Option<At>,
    pub details: Option<serde_json::Value>,
}

impl SourceDiagnostic {
    pub fn syntax(code: &'static str, severity: &'static str, message: impl Into<String>, at: At) -> Self {
        SourceDiagnostic { code, severity, message: message.into(), at: Some(at), details: None }
    }

    fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

/// `SourceDiagnosticCollector`: counts diagnostics and remembers the ceilings that make a source
/// partial. The 101st diagnostic replaces the 100th with `SOURCE_DIAGNOSTICS_TRUNCATED`.
///
/// A detailed collector also keeps each diagnostic as the TypeScript collector does, and then
/// takes its ceilings from the retained list, as `sourcePartialLimitDiagnostics` does.
#[derive(Default, Debug)]
pub struct Diagnostics {
    count: usize,
    truncated: bool,
    limits: Vec<Limit>,
    detail: Option<Vec<SourceDiagnostic>>,
}

impl Diagnostics {
    /// A collector that keeps every retained diagnostic.
    pub fn detailed() -> Self {
        Diagnostics { detail: Some(Vec::new()), ..Diagnostics::default() }
    }

    fn add_with(&mut self, limit: Option<Limit>, make: impl FnOnce() -> Option<SourceDiagnostic>) {
        if self.truncated {
            return;
        }
        if self.count < SOURCE_DIAGNOSTIC_LIMIT {
            self.count += 1;
            if let Some(limit) = limit {
                self.limits.push(limit);
            }
            if let Some(detail) = &mut self.detail
                && let Some(diagnostic) = make()
            {
                detail.push(diagnostic);
            }
            return;
        }
        // The last retained diagnostic is replaced; a ceiling it held is still a ceiling, and the
        // truncation marker is one too.
        self.truncated = true;
        self.limits.push(Limit::DiagnosticsTruncated);
        if let Some(detail) = &mut self.detail
            && let Some(last) = detail.last_mut()
        {
            *last = SourceDiagnostic {
                code: "SOURCE_DIAGNOSTICS_TRUNCATED",
                severity: "blocker",
                message: format!("Source diagnostics exceeded the per-file limit of {SOURCE_DIAGNOSTIC_LIMIT}; remaining diagnostics were omitted"),
                at: last.at,
                details: Some(serde_json::json!({ "limit": SOURCE_DIAGNOSTIC_LIMIT, "retained": SOURCE_DIAGNOSTIC_LIMIT - 1 })),
            };
        }
    }

    fn note_with(&mut self, make: impl FnOnce() -> SourceDiagnostic) {
        self.add_with(None, || Some(make()));
    }

    fn limit_with(&mut self, limit: Limit, make: impl FnOnce() -> SourceDiagnostic) {
        self.add_with(Some(limit), || Some(make()));
    }

    /// The retained diagnostics of a detailed collector, in the order they were reported.
    pub fn retained(&self) -> &[SourceDiagnostic] {
        self.detail.as_deref().unwrap_or(&[])
    }

    /// The retained diagnostics whose code is a ceiling (`sourcePartialLimitDiagnostics`), for a
    /// detailed collector.
    pub fn retained_limits(&self) -> Vec<&SourceDiagnostic> {
        const CODES: [&str; 6] = [
            "SOURCE_FILE_SIZE_LIMIT",
            "SOURCE_LINE_LIMIT",
            "SOURCE_TOKEN_LIMIT",
            "SOURCE_ENTRY_LIMIT",
            "SOURCE_NESTING_LIMIT",
            "SOURCE_DIAGNOSTICS_TRUNCATED",
        ];
        self.retained().iter().filter(|d| CODES.contains(&d.code)).collect()
    }

    /// The ceiling codes that make the source partial, sorted and without repeats.
    pub fn partial_limits(&self) -> Vec<Limit> {
        let mut limits = self.limits.clone();
        limits.sort();
        limits.dedup();
        limits
    }

    pub fn is_partial(&self) -> bool {
        !self.limits.is_empty()
    }
}

/// Windows-1252 bytes 0x80 to 0x9F; the five undefined ones decode to U+FFFD, as in iconv-lite.
const WINDOWS_1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}',
    '\u{FFFD}', '\u{017D}', '\u{FFFD}', '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}',
    '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

/// `decodeSource`: UTF-8 with a byte order mark (removed, decoded leniently), valid UTF-8, else
/// Windows-1252. `lossy` is true when a Windows-1252 file holds one of its five undefined bytes.
pub fn decode(bytes: &[u8]) -> (Cow<'_, str>, bool) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest), false);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (Cow::Borrowed(text), false);
    }
    let mut lossy = false;
    let text: String = bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => {
                let c = WINDOWS_1252_HIGH[usize::from(b - 0x80)];
                lossy |= c == '\u{FFFD}';
                c
            }
            _ => char::from(b),
        })
        .collect();
    (Cow::Owned(text), lossy)
}

/// The `\s` class of JavaScript regular expressions.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// Characters JavaScript's `.` does not match.
pub fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Line breaks as `createSourceLineIndex` counts them: `\r\n`, `\r` and `\n`.
/// The byte offset just past the break that reaches the line ceiling (`lineLimitExceededAt`), if
/// one does.
fn line_limit_at(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut breaks = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                breaks += 1;
            }
            b'\n' => breaks += 1,
            _ => {}
        }
        if breaks >= SOURCE_LINE_LIMIT {
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

/// Bytes of a Windows-1252 file that decode to U+FFFD (`findWindows1252Loss`): their count, the
/// first one's offset and their distinct values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodingLoss {
    pub count: usize,
    pub first_offset: usize,
    pub values: Vec<u8>,
}

pub fn windows_1252_loss(bytes: &[u8]) -> Option<EncodingLoss> {
    let mut loss: Option<EncodingLoss> = None;
    for (offset, &byte) in bytes.iter().enumerate() {
        if !matches!(byte, 0x81 | 0x8D | 0x8F | 0x90 | 0x9D) {
            continue;
        }
        let entry = loss.get_or_insert_with(|| EncodingLoss { count: 0, first_offset: offset, values: Vec::new() });
        entry.count += 1;
        if !entry.values.contains(&byte) {
            entry.values.push(byte);
        }
    }
    if let Some(entry) = &mut loss {
        entry.values.sort_unstable();
    }
    loss
}

fn line_limit_diagnostic(kind: &str, text: &str, at: usize) -> SourceDiagnostic {
    let line = SOURCE_LINE_LIMIT as u32 + 1;
    SourceDiagnostic::syntax(
        "SOURCE_LINE_LIMIT",
        "blocker",
        format!("{kind} line count exceeds the supported limit of {SOURCE_LINE_LIMIT}"),
        At::FixedAtByte(line, 1, at.min(text.len()) as u32),
    )
    .with_details(serde_json::json!({ "limit": SOURCE_LINE_LIMIT }))
}

fn file_size_diagnostic(kind: &str) -> SourceDiagnostic {
    SourceDiagnostic::syntax(
        "SOURCE_FILE_SIZE_LIMIT",
        "blocker",
        format!("{kind} exceeds the supported {SOURCE_MAX_BYTES}-byte parsing limit"),
        At::Fixed(1, 1, 0),
    )
    .with_details(serde_json::json!({ "limit": SOURCE_MAX_BYTES }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    String,
    Atom,
    Operator,
    LeftBrace,
    RightBrace,
    Invalid,
}

#[derive(Clone, Copy, Debug)]
struct Token {
    kind: TokenKind,
    start: u32,
    end: u32,
    line: u32,
}

/// A scalar: its value (quotes and the `\"` and `\\` escapes removed) and its 1-based line.
#[derive(Clone, Debug)]
pub struct Scalar<'a> {
    pub value: Cow<'a, str>,
    pub line: u32,
    /// Byte offset of the token in the decoded text: the TypeScript node's `start`, which tells two
    /// nodes of one line apart.
    pub start: u32,
    /// Byte offset just past the token.
    pub end: u32,
    pub quoted: bool,
}

#[derive(Debug, Default)]
pub struct Block<'a> {
    pub entries: Vec<Entry<'a>>,
    /// Byte offset and 1-based line of the opening brace (of the file's start for the root).
    pub start: u32,
    pub start_line: u32,
    /// 1-based line of the closing brace; of the last token when the block is never closed; 0 for a
    /// block cut off by the nesting ceiling.
    pub end_line: u32,
    /// Byte offset just past the closing brace, or the text's end when there is none (the
    /// TypeScript node's `end`).
    pub end: u32,
}

impl Assignment<'_> {
    /// The TypeScript assignment node's `end`: its value's.
    pub fn end(&self) -> u32 {
        match &self.value {
            Value::Scalar(s) => s.end,
            Value::Block(b) => b.end,
        }
    }
}

#[derive(Debug)]
pub enum Entry<'a> {
    Scalar(Scalar<'a>),
    Assignment(Assignment<'a>),
    Block(Block<'a>),
}

#[derive(Debug)]
pub struct Assignment<'a> {
    pub key: Scalar<'a>,
    pub value: Value<'a>,
}

#[derive(Debug)]
pub enum Value<'a> {
    Scalar(Scalar<'a>),
    Block(Block<'a>),
}

impl<'a> Block<'a> {
    /// `assignments(block)`.
    pub fn assignments(&self) -> impl Iterator<Item = &Assignment<'a>> {
        self.entries.iter().filter_map(|e| match e {
            Entry::Assignment(a) => Some(a),
            _ => None,
        })
    }

    /// `firstScalar(block, key)`: the first assignment of `key`, when its value is a scalar.
    pub fn first_scalar(&self, key: &str) -> Option<&Scalar<'a>> {
        match &self.assignments().find(|a| a.key.value == key)?.value {
            Value::Scalar(s) => Some(s),
            Value::Block(_) => None,
        }
    }

    /// The first scalar-valued assignment whose key, in lower case, is one of `keys`.
    pub fn first_scalar_insensitive(&self, keys: &[&str]) -> Option<&Scalar<'a>> {
        self.assignments().find_map(|a| match &a.value {
            Value::Scalar(s) if keys.contains(&a.key.value.to_lowercase().as_str()) => Some(s),
            _ => None,
        })
    }

    /// `childBlocks(block, key)`.
    pub fn child_blocks<'b>(&'b self, key: &'b str) -> impl Iterator<Item = &'b Block<'a>> {
        self.assignments().filter(move |a| a.key.value == key).filter_map(|a| match &a.value {
            Value::Block(b) => Some(b),
            Value::Scalar(_) => None,
        })
    }

    /// The bare scalars of a list block.
    pub fn scalars(&self) -> impl Iterator<Item = &Scalar<'a>> {
        self.entries.iter().filter_map(|e| match e {
            Entry::Scalar(s) => Some(s),
            _ => None,
        })
    }
}

/// A parsed Clausewitz source.
pub struct Document<'a> {
    pub root: Block<'a>,
    pub diagnostics: Diagnostics,
}

fn starts_operator(bytes: &[u8], i: usize) -> bool {
    match bytes.get(i) {
        Some(b'=' | b'<' | b'>' | b'!') => true,
        Some(b'?') => bytes.get(i + 1) == Some(&b'='),
        _ => false,
    }
}

/// The character at byte offset `i` of `text`.
fn char_at(text: &str, i: usize) -> char {
    text[i..].chars().next().unwrap_or(' ')
}

/// `lexClausewitz`, keeping only significant tokens but counting trivia toward the token ceiling.
/// It walks bytes: every character with a meaning to the lexer is ASCII, and other characters are
/// decoded only to test them for white space.
fn lex(text: &str, diagnostics: &mut Diagnostics) -> Vec<Token> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut count = 0usize;
    let mut i = 0usize;
    let mut line = 1u32;
    let is_space_at = |i: usize| -> bool {
        let b = bytes[i];
        if b < 0x80 { b == b' ' || (9..=13).contains(&b) } else { is_js_space(char_at(text, i)) }
    };
    // `advance` of the TypeScript lexer: CR LF is one step and one line.
    let advance = |i: &mut usize, line: &mut u32| {
        let b = bytes[*i];
        if b == b'\r' {
            *i += 1;
            if bytes.get(*i) == Some(&b'\n') {
                *i += 1;
            }
            *line += 1;
        } else if b == b'\n' {
            *i += 1;
            *line += 1;
        } else if b < 0x80 {
            *i += 1;
        } else {
            *i += char_at(text, *i).len_utf8();
        }
    };
    while i < len {
        if count >= SOURCE_TOKEN_LIMIT {
            let width = if bytes[i] < 0x80 { 1 } else { char_at(text, i).len_utf8() };
            diagnostics.limit_with(Limit::Token, || {
                SourceDiagnostic::syntax(
                    "SOURCE_TOKEN_LIMIT",
                    "blocker",
                    format!("Source token count exceeds the supported limit of {SOURCE_TOKEN_LIMIT}"),
                    At::Bytes(i as u32, (i + width) as u32),
                )
                .with_details(serde_json::json!({ "limit": SOURCE_TOKEN_LIMIT }))
            });
            break;
        }
        count += 1;
        let start = i;
        let start_line = line;
        let current = bytes[i];
        if is_space_at(i) {
            while i < len && is_space_at(i) {
                advance(&mut i, &mut line);
            }
            continue;
        }
        if current == b'#' {
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                advance(&mut i, &mut line);
            }
            continue;
        }
        let token = |kind: TokenKind, end: usize| Token { kind, start: start as u32, end: end as u32, line: start_line };
        if current == b'{' || current == b'}' {
            advance(&mut i, &mut line);
            tokens.push(token(if current == b'{' { TokenKind::LeftBrace } else { TokenKind::RightBrace }, i));
            continue;
        }
        if current == b'"' {
            advance(&mut i, &mut line);
            let mut terminated = false;
            while i < len {
                if bytes[i] == b'\\' {
                    let escape_start = i as u32;
                    advance(&mut i, &mut line);
                    if i < len {
                        let escaped = bytes[i];
                        advance(&mut i, &mut line);
                        if escaped != b'\\' && escaped != b'"' {
                            let end = i as u32;
                            diagnostics.note_with(|| {
                                SourceDiagnostic::syntax(
                                    "SOURCE_UNSUPPORTED_ESCAPE",
                                    "error",
                                    "Clausewitz strings support only \\\\ and \\\" escapes",
                                    At::Bytes(escape_start, end),
                                )
                            });
                        }
                    }
                    continue;
                }
                if bytes[i] == b'"' {
                    advance(&mut i, &mut line);
                    terminated = true;
                    break;
                }
                advance(&mut i, &mut line);
            }
            tokens.push(token(if terminated { TokenKind::String } else { TokenKind::Invalid }, i));
            let span = At::Bytes(start as u32, i as u32);
            if !terminated {
                diagnostics.note_with(|| SourceDiagnostic::syntax("SOURCE_UNTERMINATED_STRING", "error", "Unterminated quoted string", span));
            }
            if terminated {
                let raw = &text[start..i];
                if raw.contains(['\r', '\n']) {
                    diagnostics.note_with(|| {
                        SourceDiagnostic::syntax("SOURCE_STRING_NEWLINE", "error", "Clausewitz quoted strings cannot contain a literal newline", span)
                    });
                }
                let inner = &raw[1..raw.len() - 1];
                if inner.len() > 255 && inner.encode_utf16().count() > 255 {
                    diagnostics.note_with(|| {
                        SourceDiagnostic::syntax(
                            "SOURCE_STRING_TOO_LONG",
                            "warning",
                            "Clausewitz quoted strings longer than 255 characters are not portable",
                            span,
                        )
                    });
                }
            }
            continue;
        }
        if starts_operator(bytes, i) {
            advance(&mut i, &mut line);
            if bytes.get(i) == Some(&b'=') {
                advance(&mut i, &mut line);
            }
            tokens.push(token(TokenKind::Operator, i));
            let operator = &text[start..i];
            if !matches!(operator, "=" | "<" | ">" | "?=") {
                diagnostics.note_with(|| {
                    SourceDiagnostic::syntax(
                        "SOURCE_UNSUPPORTED_OPERATOR",
                        "error",
                        format!("Unsupported Clausewitz operator {operator}"),
                        At::Bytes(start as u32, i as u32),
                    )
                });
            }
            continue;
        }
        while i < len {
            let b = bytes[i];
            if is_space_at(i) || b == b'#' || b == b'{' || b == b'}' || b == b'"' || starts_operator(bytes, i) {
                break;
            }
            advance(&mut i, &mut line);
        }
        if i == start {
            advance(&mut i, &mut line);
            tokens.push(token(TokenKind::Invalid, i));
            let character = &text[start..i];
            diagnostics.note_with(|| {
                SourceDiagnostic::syntax(
                    "SOURCE_INVALID_CHARACTER",
                    "error",
                    format!("Invalid character {}", js_string(character)),
                    At::Bytes(start as u32, i as u32),
                )
            });
        } else {
            tokens.push(token(TokenKind::Atom, i));
        }
    }
    tokens
}

/// `scalarValue`: a quoted string loses its quotes and the `\"` and `\\` escapes.
fn scalar_value<'a>(text: &'a str, token: &Token) -> Cow<'a, str> {
    let raw = &text[token.start as usize..token.end as usize];
    if token.kind != TokenKind::String {
        return Cow::Borrowed(raw);
    }
    let inner = &raw[1..raw.len() - 1];
    if !inner.contains('\\') {
        return Cow::Borrowed(inner);
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && (next == '"' || next == '\\')
        {
            out.push(next);
            chars.next();
            continue;
        }
        out.push(c);
    }
    Cow::Owned(out)
}

struct Parser<'t, 'a> {
    tokens: &'t [Token],
    text: &'a str,
    index: usize,
    diagnostics: &'t mut Diagnostics,
}

impl<'a> Parser<'_, 'a> {
    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.index).copied();
        if token.is_some() {
            self.index += 1;
        }
        token
    }

    fn peek(&self) -> Option<Token> {
        self.tokens.get(self.index).copied()
    }

    fn scalar(&self, token: &Token) -> Scalar<'a> {
        Scalar { value: scalar_value(self.text, token), line: token.line, start: token.start, end: token.end, quoted: token.kind == TokenKind::String }
    }

    fn token_text(&self, token: &Token) -> &'a str {
        &self.text[token.start as usize..token.end as usize]
    }

    /// `at` is the opening brace's offset and line; a brace is one byte.
    fn block(&mut self, open: bool, depth: usize, at: (u32, u32)) -> Block<'a> {
        if open && depth > SOURCE_MAX_NESTING {
            return self.over_limit_block(at);
        }
        let mut entries = Vec::new();
        let mut closed = None;
        let mut end_line = 0;
        while let Some(token) = self.peek() {
            if token.kind == TokenKind::RightBrace {
                self.index += 1;
                if !open {
                    self.diagnostics.note_with(|| {
                        SourceDiagnostic::syntax("SOURCE_UNEXPECTED_RIGHT_BRACE", "error", "Unexpected closing brace", At::Bytes(token.start, token.end))
                    });
                    continue;
                }
                closed = Some(token.end);
                end_line = token.line;
                break;
            }
            if let Some(entry) = self.entry(depth) {
                entries.push(entry);
            }
        }
        if open && closed.is_none() {
            self.diagnostics.note_with(|| unclosed(at.0));
            end_line = self.tokens.last().map_or(0, |token| token.line);
        }
        Block { entries, start: at.0, start_line: at.1, end_line, end: closed.unwrap_or(self.text.len() as u32) }
    }

    fn over_limit_block(&mut self, at: (u32, u32)) -> Block<'a> {
        self.diagnostics.limit_with(Limit::Nesting, || {
            SourceDiagnostic::syntax(
                "SOURCE_NESTING_LIMIT",
                "blocker",
                format!("Clausewitz block nesting exceeds the supported limit of {SOURCE_MAX_NESTING}"),
                At::Bytes(at.0, at.0 + 1),
            )
            .with_details(serde_json::json!({ "limit": SOURCE_MAX_NESTING }))
        });
        let mut nesting = 1usize;
        let mut closed = None;
        while let Some(token) = self.next() {
            match token.kind {
                TokenKind::LeftBrace => nesting += 1,
                TokenKind::RightBrace => {
                    nesting -= 1;
                    if nesting == 0 {
                        closed = Some(token.end);
                        break;
                    }
                }
                _ => {}
            }
        }
        if closed.is_none() {
            self.diagnostics.note_with(|| unclosed(at.0));
        }
        Block { start: at.0, start_line: at.1, end: closed.unwrap_or(self.text.len() as u32), ..Block::default() }
    }

    fn entry(&mut self, depth: usize) -> Option<Entry<'a>> {
        let token = self.next()?;
        if token.kind == TokenKind::LeftBrace {
            return Some(Entry::Block(self.block(true, depth + 1, (token.start, token.line))));
        }
        if !matches!(token.kind, TokenKind::Atom | TokenKind::String | TokenKind::Invalid) {
            let text = self.token_text(&token);
            self.diagnostics.note_with(|| {
                SourceDiagnostic::syntax("SOURCE_UNEXPECTED_TOKEN", "error", format!("Unexpected token {}", js_string(text)), At::Bytes(token.start, token.end))
            });
            return None;
        }
        let key = self.scalar(&token);
        let Some(operator) = self.peek().filter(|t| t.kind == TokenKind::Operator) else {
            return Some(Entry::Scalar(key));
        };
        self.index += 1;
        let Some(value_token) = self.next() else {
            let name = key.value.clone();
            self.diagnostics.note_with(|| {
                SourceDiagnostic::syntax("SOURCE_MISSING_VALUE", "error", format!("Assignment {name} is missing a value"), At::Bytes(operator.start, operator.end))
            });
            return Some(Entry::Scalar(key));
        };
        let value = match value_token.kind {
            TokenKind::LeftBrace => Value::Block(self.block(true, depth + 1, (value_token.start, value_token.line))),
            TokenKind::Atom | TokenKind::String | TokenKind::Invalid => Value::Scalar(self.scalar(&value_token)),
            TokenKind::Operator | TokenKind::RightBrace => {
                let text = self.token_text(&value_token);
                self.diagnostics.note_with(|| {
                    SourceDiagnostic::syntax(
                        "SOURCE_INVALID_VALUE",
                        "error",
                        format!("Invalid assignment value {}", js_string(text)),
                        At::Bytes(value_token.start, value_token.end),
                    )
                });
                Value::Scalar(Scalar { value: Cow::Borrowed(text), line: value_token.line, start: value_token.start, end: value_token.end, quoted: false })
            }
        };
        Some(Entry::Assignment(Assignment { key, value }))
    }
}

fn unclosed(open: u32) -> SourceDiagnostic {
    SourceDiagnostic::syntax("SOURCE_UNCLOSED_BLOCK", "error", "Block is missing a closing brace", At::Bytes(open, open + 1))
}

/// `JSON.stringify` of a string.
fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `parseClausewitz` over already decoded text. `byte_len` is the size of the file's bytes and
/// `lossy` comes from [`decode`].
pub fn parse_clausewitz(text: &str, byte_len: usize, lossy: bool) -> Document<'_> {
    let loss = lossy.then(|| EncodingLoss { count: 0, first_offset: 0, values: Vec::new() });
    parse_with(text, byte_len, Diagnostics::default(), loss.as_ref())
}

/// `parseClausewitz` keeping every retained diagnostic with its message and place. `loss` is
/// [`windows_1252_loss`] of a file read as Windows-1252.
pub fn parse_clausewitz_detailed<'a>(text: &'a str, byte_len: usize, loss: Option<&EncodingLoss>) -> Document<'a> {
    parse_with(text, byte_len, Diagnostics::detailed(), loss)
}

fn parse_with<'a>(text: &'a str, byte_len: usize, mut diagnostics: Diagnostics, loss: Option<&EncodingLoss>) -> Document<'a> {
    let root_at_end = || Block { end: text.len() as u32, start_line: 1, ..Block::default() };
    if byte_len > SOURCE_MAX_BYTES {
        diagnostics.limit_with(Limit::FileSize, || file_size_diagnostic("Clausewitz source"));
        return Document { root: root_at_end(), diagnostics };
    }
    if let Some(at) = line_limit_at(text) {
        diagnostics.limit_with(Limit::Line, || line_limit_diagnostic("Clausewitz source", text, at));
        return Document { root: root_at_end(), diagnostics };
    }
    if let Some(loss) = loss {
        diagnostics.note_with(|| {
            let first = loss.first_offset as u32;
            SourceDiagnostic::syntax(
                "SOURCE_ENCODING_NOT_ROUND_TRIPPABLE",
                "warning",
                "Source is not valid UTF-8 and contains bytes that Windows-1252 cannot represent; it can be read but any rewrite is refused",
                At::Utf16(first, first + 1),
            )
            .with_details(serde_json::json!({
                "byteCount": loss.count,
                "byteValues": loss.values.iter().map(|value| format!("0x{value:X}")).collect::<Vec<_>>(),
            }))
        });
    }
    let tokens = lex(text, &mut diagnostics);
    let mut parser = Parser { tokens: &tokens, text, index: 0, diagnostics: &mut diagnostics };
    let root = parser.block(false, 0, (0, 1));
    Document { root, diagnostics }
}

/// One `key:0 "value"` line of a localisation file: its language, key and 1-based line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalisationEntry {
    pub language: String,
    pub key: String,
    pub line: u32,
    /// The value as `decodeLocalisationValue` gives it.
    pub value: String,
    /// Byte offsets of the line in the decoded text, without its line break.
    pub start: u32,
    pub end: u32,
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && is_js_space(chars[i]) {
        i += 1;
    }
    i
}

/// `\s*(?:#.*)?$` from `i` to the end of the line.
fn rest_is_trailer(chars: &[char], i: usize) -> bool {
    let i = skip_space(chars, i);
    i == chars.len() || (chars[i] == '#' && !chars[i + 1..].iter().any(|&c| is_js_line_terminator(c)))
}

/// `^\s*(l_[a-z_]+):\s*(?:#.*)?$`
fn language_line(chars: &[char]) -> Option<String> {
    let start = skip_space(chars, 0);
    if chars.get(start) != Some(&'l') || chars.get(start + 1) != Some(&'_') {
        return None;
    }
    let mut i = start + 2;
    while i < chars.len() && (chars[i].is_ascii_lowercase() || chars[i] == '_') {
        i += 1;
    }
    if i == start + 2 || chars.get(i) != Some(&':') {
        return None;
    }
    rest_is_trailer(chars, i + 1).then(|| chars[start..i].iter().collect())
}

/// `entryPattern` of `localisation.ts`, then `innerQuotePattern` when it does not match, returning
/// the key: `^\s*([A-Za-z0-9_.-]+):(?:(\d+)\s+|\s*)"((?:\\.|[^"\\])*)"\s*(?:#.*)?$`, else the same
/// prefix with `"(.*)"\s*$` (a value with quotes inside it runs to the last quote of the line).
/// The value is returned as `decodeLocalisationValue` gives it.
fn entry_line_value(chars: &[char]) -> Option<(String, String)> {
    let start = skip_space(chars, 0);
    let mut i = start;
    while i < chars.len() && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '.' | '-')) {
        i += 1;
    }
    if i == start || chars.get(i) != Some(&':') {
        return None;
    }
    let key: String = chars[start..i].iter().collect();
    let after_colon = i + 1;
    // The value: from an opening quote to the first quote no backslash escapes, then a trailer.
    // Each returns the index of the closing quote.
    let value_from = |open: usize| -> Option<usize> {
        if chars.get(open) != Some(&'"') {
            return None;
        }
        let mut j = open + 1;
        while j < chars.len() {
            match chars[j] {
                '"' => return rest_is_trailer(chars, j + 1).then_some(j),
                '\\' => {
                    if j + 1 >= chars.len() || is_js_line_terminator(chars[j + 1]) {
                        return None;
                    }
                    j += 2;
                }
                _ => j += 1,
            }
        }
        None
    };
    // `"(.*)"\s*$`: the last quote of the line closes the value, and `.` stops at a line terminator.
    let inner_quotes_from = |open: usize| -> Option<usize> {
        if chars.get(open) != Some(&'"') {
            return None;
        }
        let mut end = chars.len();
        while end > open + 1 && is_js_space(chars[end - 1]) {
            end -= 1;
        }
        (end > open + 1 && chars[end - 1] == '"' && !chars[open + 1..end - 1].iter().any(|&c| is_js_line_terminator(c))).then_some(end - 1)
    };
    // `(\d+)\s+` first, then `\s*`.
    let mut j = after_colon;
    while j < chars.len() && chars[j].is_ascii_digit() {
        j += 1;
    }
    let versioned = (j > after_colon).then(|| skip_space(chars, j)).filter(|&spaces| spaces > j);
    let starts: Vec<usize> = versioned.into_iter().chain(std::iter::once(skip_space(chars, after_colon))).collect();
    let (open, close) = starts
        .iter()
        .find_map(|&open| value_from(open).map(|close| (open, close)))
        .or_else(|| starts.iter().find_map(|&open| inner_quotes_from(open).map(|close| (open, close))))?;
    Some((key, decode_localisation_value(&chars[open + 1..close])))
}

/// `decodeLocalisationValue`: `\n` becomes a line break, `\"` and `\\` lose their backslash, and
/// any other escape is kept as written.
fn decode_localisation_value(value: &[char]) -> String {
    let mut result = String::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        let c = value[i];
        if c != '\\' || i + 1 >= value.len() {
            result.push(c);
            i += 1;
            continue;
        }
        match value[i + 1] {
            'n' => result.push('\n'),
            escaped @ ('"' | '\\') => result.push(escaped),
            escaped => {
                result.push('\\');
                result.push(escaped);
            }
        }
        i += 2;
    }
    result
}

/// A parsed localisation file: its entries and diagnostics.
pub struct Localisation {
    pub entries: Vec<LocalisationEntry>,
    pub diagnostics: Diagnostics,
}

/// `parseLocalisation` over already decoded text. `bom` is true when the file starts with a UTF-8
/// byte order mark.
pub fn parse_localisation(text: &str, byte_len: usize, bom: bool) -> Localisation {
    parse_localisation_with(text, byte_len, bom, Diagnostics::default())
}

/// `parseLocalisation` keeping every retained diagnostic with its message and place.
pub fn parse_localisation_detailed(text: &str, byte_len: usize, bom: bool) -> Localisation {
    parse_localisation_with(text, byte_len, bom, Diagnostics::detailed())
}

fn parse_localisation_with(text: &str, byte_len: usize, bom: bool, mut diagnostics: Diagnostics) -> Localisation {
    let mut entries = Vec::new();
    if byte_len > SOURCE_MAX_BYTES {
        diagnostics.limit_with(Limit::FileSize, || file_size_diagnostic("Localisation source"));
        return Localisation { entries, diagnostics };
    }
    if let Some(at) = line_limit_at(text) {
        diagnostics.limit_with(Limit::Line, || line_limit_diagnostic("Localisation source", text, at));
        return Localisation { entries, diagnostics };
    }
    if !bom {
        let first = text.chars().next().map_or(0, char::len_utf8) as u32;
        diagnostics.note_with(|| {
            SourceDiagnostic::syntax("LOCALISATION_BOM_MISSING", "error", "HOI4 localisation files require UTF-8 with BOM encoding", At::Bytes(0, first))
        });
    }
    let mut language = String::new();
    let mut line_number = 1u32;
    let mut chars: Vec<char> = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let line_start = (text.len() - rest.len()) as u32;
        let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
        let line = &rest[..end];
        let span = At::Bytes(line_start, line_start + end as u32);
        let mut next = end;
        if rest[next..].starts_with('\r') {
            next += 1;
        }
        if rest[next..].starts_with('\n') {
            next += 1;
        }
        chars.clear();
        chars.extend(line.chars());
        if let Some(found) = language_line(&chars) {
            language = found;
        } else if !rest_is_trailer(&chars, 0) {
            match entry_line_value(&chars) {
                None => diagnostics.note_with(|| SourceDiagnostic::syntax("LOCALISATION_MALFORMED_LINE", "error", "Malformed localisation line", span)),
                Some(_) if language.is_empty() => diagnostics.note_with(|| {
                    SourceDiagnostic::syntax("LOCALISATION_LANGUAGE_MISSING", "error", "Localisation entry appears before a language declaration", span)
                }),
                Some((key, value)) => {
                    if entries.len() >= SOURCE_ENTRY_LIMIT {
                        diagnostics.limit_with(Limit::Entry, || {
                            SourceDiagnostic::syntax(
                                "SOURCE_ENTRY_LIMIT",
                                "blocker",
                                format!("Localisation entries exceed the supported limit of {SOURCE_ENTRY_LIMIT}"),
                                span,
                            )
                            .with_details(serde_json::json!({ "limit": SOURCE_ENTRY_LIMIT }))
                        });
                        break;
                    }
                    entries.push(LocalisationEntry {
                        language: language.clone(),
                        key,
                        line: line_number,
                        value,
                        start: line_start,
                        end: line_start + end as u32,
                    });
                }
            }
        }
        rest = &rest[next..];
        line_number += 1;
    }
    Localisation { entries, diagnostics }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Document<'_> {
        parse_clausewitz(text, text.len(), false)
    }

    fn keys<'a>(block: &'a Block<'_>) -> Vec<&'a str> {
        block
            .entries
            .iter()
            .map(|e| match e {
                Entry::Scalar(s) => &*s.value,
                Entry::Assignment(a) => &*a.key.value,
                Entry::Block(_) => "{}",
            })
            .collect()
    }

    #[test]
    fn every_operator_makes_an_assignment_and_brace_forms_split() {
        let doc = parse("a = 1\nb < 2\nc != 3\nd { e = 1 }\nf = rgb { 1 2 3 }\n");
        assert_eq!(keys(&doc.root), ["a", "b", "c", "d", "{}", "f", "{}"]);
        assert_eq!(doc.root.assignments().count(), 4);
        // `!=` is unsupported: one diagnostic.
        assert_eq!(doc.diagnostics.count, 1);
        assert!(!doc.diagnostics.is_partial());
    }

    #[test]
    fn an_operator_or_closing_brace_is_taken_as_the_value() {
        let doc = parse("a = { b = }\nc = d\n");
        // `b = }` consumes the brace, so `c = d` is inside `a`, and `a` is left open.
        let Some(Entry::Assignment(a)) = doc.root.entries.first() else { panic!() };
        let Value::Block(inner) = &a.value else { panic!() };
        assert_eq!(keys(inner), ["b", "c"]);
        assert_eq!(doc.diagnostics.count, 2);
    }

    #[test]
    fn strings_unescape_and_lines_count_crlf_once() {
        let doc = parse("a = \"x\\\"y\\\\z\"\r\nb = c\rd = e\n");
        let values: Vec<(String, u32)> = doc.root.assignments().map(|a| (a.key.value.to_string(), a.key.line)).collect();
        assert_eq!(values, [("a".into(), 1), ("b".into(), 2), ("d".into(), 3)]);
        let Value::Scalar(s) = &doc.root.assignments().next().unwrap().value else { panic!() };
        assert_eq!(s.value, "x\"y\\z");
    }

    #[test]
    fn unicode_spaces_separate_atoms() {
        let doc = parse("a\u{a0}=\u{feff}b");
        let a = doc.root.assignments().next().unwrap();
        assert_eq!(a.key.value, "a");
        assert!(matches!(&a.value, Value::Scalar(s) if s.value == "b"));
    }

    #[test]
    fn the_101st_diagnostic_makes_the_source_partial() {
        let hundred = "}\n".repeat(100);
        assert!(!parse(&hundred).diagnostics.is_partial());
        let more = format!("{hundred}}}\n");
        assert_eq!(parse(&more).diagnostics.partial_limits(), [Limit::DiagnosticsTruncated]);
    }

    #[test]
    fn deep_nesting_is_a_ceiling() {
        let deep = format!("{}{}", "a = {".repeat(257), "}".repeat(257));
        assert_eq!(parse(&deep).diagnostics.partial_limits(), [Limit::Nesting]);
        let fine = format!("{}{}", "a = {".repeat(256), "}".repeat(256));
        assert!(!parse(&fine).diagnostics.is_partial());
    }

    #[test]
    fn long_and_multiline_strings_are_noted() {
        let long = format!("a = \"{}\"", "x".repeat(256));
        assert_eq!(parse(&long).diagnostics.count, 1);
        assert_eq!(parse("a = \"x\ny\"").diagnostics.count, 1);
        assert_eq!(parse("a = \"x\\ny\"").diagnostics.count, 1);
        assert_eq!(parse("a = \"open").diagnostics.count, 1);
    }

    #[test]
    fn windows_1252_decodes_and_flags_undefined_bytes() {
        let (text, lossy) = decode(&[b'a', 0x80, 0xE9]);
        assert_eq!(text, "a\u{20AC}\u{e9}");
        assert!(!lossy);
        assert!(decode(&[0x81, 0xFF]).1);
        let (text, _) = decode(&[0xEF, 0xBB, 0xBF, b'x']);
        assert_eq!(text, "x");
    }

    #[test]
    fn localisation_lines_follow_the_typescript_patterns() {
        let text = "l_english:\n k1:0 \"One\"\n k2: \"Two\" # note\n bad line\n k3:0 \"say \"hi\"\"\n k4:0\"x\"\n\r k5 :0 \"x\"\n k6:12 \"esc \\\" ok\"\n k7:0 \"open\n k8:0 \"\"\n";
        let parsed = parse_localisation(text, text.len(), true);
        let keys: Vec<(&str, u32)> = parsed.entries.iter().map(|e| (e.key.as_str(), e.line)).collect();
        // k3 has quotes inside its value, which the game reads up to the last quote of the line.
        assert_eq!(keys, [("k1", 2), ("k2", 3), ("k3", 5), ("k6", 9), ("k8", 11)]);
        // bad line, k4 (version without a space), k5 (space before the colon), k7 (never closed).
        assert_eq!(parsed.diagnostics.count, 4);
        let orphan = parse_localisation(" k:0 \"x\"\n", 9, false);
        assert!(orphan.entries.is_empty());
        assert_eq!(orphan.diagnostics.count, 2);
    }
}

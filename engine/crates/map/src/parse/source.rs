//! Decoding, lexing and parsing of Clausewitz script with the semantics of the TypeScript server.
//!
//! Ported from `src/hoi4_agent_tools/core/source/encoding.ts` (`decodeSource`),
//! `core/source/lexer.ts` (`createSourceLineIndex`, `positionAt`, `locationFor`, `lexClausewitz`),
//! `core/source/parser.ts` (`parseClausewitz`, `assignments`, `childBlocks`, `firstScalar`,
//! `nodeLocation`) and `core/source/limits.ts` (`SourceDiagnosticCollector`), commit `9b7dc80d`.
//!
//! The map findings include this parser's diagnostics, so the codes, messages, recovery and
//! positions are the TypeScript ones, not those of `hoi4-syntax`. Text is held as UTF-16 code
//! units because the TypeScript offsets and columns count code units.

use hoi4_core::diagnostics::{Category, Diagnostic, Severity, SourceLocation, SourcePosition};
use serde_json::{Map, Value, json};

pub const SOURCE_DIAGNOSTIC_LIMIT: usize = 100;
pub const SOURCE_MAX_NESTING: usize = 256;
pub const SOURCE_MAX_BYTES: usize = 33_554_432;
pub const SOURCE_TOKEN_LIMIT: usize = 4_000_000;
pub const SOURCE_ENTRY_LIMIT: usize = 1_000_000;
pub const SOURCE_LINE_LIMIT: usize = 2_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Windows1252,
}

/// Bytes of a Windows-1252 file that decoding cannot reproduce (`SourceEncodingLoss`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodingLoss {
    pub count: usize,
    pub first_offset: usize,
    pub byte_values: Vec<u8>,
}

/// `DecodedSource`: the text as UTF-16 code units.
#[derive(Clone, Debug)]
pub struct Decoded {
    pub encoding: Encoding,
    pub text: Vec<u16>,
    pub loss: Option<EncodingLoss>,
}

/// Windows-1252 code points of bytes 0x80 to 0x9F; 0xFFFD where the code page leaves a byte
/// undefined (iconv-lite decodes those to U+FFFD).
const CP1252_HIGH: [u16; 32] = [
    0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD, 0xFFFD,
    0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
];

fn cp1252(byte: u8) -> u16 {
    if (0x80..0xA0).contains(&byte) { CP1252_HIGH[(byte - 0x80) as usize] } else { u16::from(byte) }
}

/// `decodeSource`.
pub fn decode(bytes: &[u8]) -> Decoded {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // Node decodes invalid UTF-8 after a BOM with replacement characters.
        let text = String::from_utf8_lossy(&bytes[3..]).encode_utf16().collect();
        return Decoded { encoding: Encoding::Utf8Bom, text, loss: None };
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Decoded { encoding: Encoding::Utf8, text: text.encode_utf16().collect(), loss: None };
    }
    let text = bytes.iter().map(|&b| cp1252(b)).collect();
    let mut loss = EncodingLoss { count: 0, first_offset: 0, byte_values: Vec::new() };
    for (offset, &b) in bytes.iter().enumerate() {
        if cp1252(b) != 0xFFFD {
            continue;
        }
        if loss.count == 0 {
            loss.first_offset = offset;
        }
        loss.count += 1;
        if !loss.byte_values.contains(&b) {
            loss.byte_values.push(b);
        }
    }
    loss.byte_values.sort_unstable();
    Decoded { encoding: Encoding::Windows1252, text, loss: (loss.count > 0).then_some(loss) }
}

/// The characters of the JavaScript `\s` class.
pub fn is_js_space(unit: u16) -> bool {
    matches!(unit, 9..=13 | 32 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// `String.prototype.trim` on code units.
pub fn js_trim(text: &[u16]) -> &[u16] {
    let start = text.iter().position(|&u| !is_js_space(u)).unwrap_or(text.len());
    let end = text.iter().rposition(|&u| !is_js_space(u)).map_or(start, |i| i + 1);
    &text[start..end]
}

pub fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub fn string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `SourceLineIndex`.
#[derive(Clone, Debug)]
pub struct LineIndex {
    pub line_starts: Vec<usize>,
    pub line_limit_exceeded_at: Option<usize>,
}

/// `createSourceLineIndex`.
pub fn line_index(text: &[u16]) -> LineIndex {
    let mut line_starts = vec![0];
    let mut index = 0;
    while index < text.len() {
        let unit = text[index];
        if unit == u16::from(b'\r') || unit == u16::from(b'\n') {
            if unit == u16::from(b'\r') && text.get(index + 1) == Some(&u16::from(b'\n')) {
                index += 1;
            }
            if line_starts.len() >= SOURCE_LINE_LIMIT {
                return LineIndex { line_starts, line_limit_exceeded_at: Some(index + 1) };
            }
            line_starts.push(index + 1);
        }
        index += 1;
    }
    LineIndex { line_starts, line_limit_exceeded_at: None }
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// `positionAt`.
pub fn position_at(text: &[u16], index: &LineIndex, offset: usize) -> SourcePosition {
    let bounded = offset.min(text.len());
    let low = index.line_starts.partition_point(|&start| start <= bounded);
    let line_offset = low.saturating_sub(1);
    if bounded < text.len() && text[bounded] == u16::from(b'\n') && bounded > 0 && text[bounded - 1] == u16::from(b'\r') {
        return SourcePosition { line: to_u32(line_offset + 2), column: 1, offset: to_u32(offset) };
    }
    let column = bounded - index.line_starts[line_offset] + 1 + offset.saturating_sub(text.len());
    SourcePosition { line: to_u32(line_offset + 1), column: to_u32(column), offset: to_u32(offset) }
}

/// `locationFor`.
pub fn location_for(path: &str, text: &[u16], index: &LineIndex, start: usize, end: usize) -> SourceLocation {
    SourceLocation { path: path.to_string(), start: position_at(text, index, start), end: position_at(text, index, end), symbol: None }
}

/// A diagnostic with optional location and details.
pub fn diagnostic(code: &str, severity: Severity, category: Category, message: impl Into<String>, location: Option<SourceLocation>, details: Option<Value>) -> Diagnostic {
    let mut d = Diagnostic::new(code, severity, category, message);
    d.location = location;
    d.details = details.and_then(|v| match v {
        Value::Object(map) => Some(map),
        _ => None,
    });
    d
}

/// `SourceDiagnosticCollector`.
#[derive(Default)]
pub struct Collector {
    pub diagnostics: Vec<Diagnostic>,
    truncated: bool,
}

impl Collector {
    pub fn add(&mut self, factory: impl FnOnce() -> Diagnostic) {
        if self.truncated {
            return;
        }
        if self.diagnostics.len() < SOURCE_DIAGNOSTIC_LIMIT {
            self.diagnostics.push(factory());
            return;
        }
        let first_omitted_location = self.diagnostics[SOURCE_DIAGNOSTIC_LIMIT - 1].location.clone();
        self.diagnostics[SOURCE_DIAGNOSTIC_LIMIT - 1] = diagnostic(
            "SOURCE_DIAGNOSTICS_TRUNCATED",
            Severity::Blocker,
            Category::Syntax,
            format!("Source diagnostics exceeded the per-file limit of {SOURCE_DIAGNOSTIC_LIMIT}; remaining diagnostics were omitted"),
            first_omitted_location,
            Some(json!({ "limit": SOURCE_DIAGNOSTIC_LIMIT, "retained": SOURCE_DIAGNOSTIC_LIMIT - 1 })),
        );
        self.truncated = true;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Whitespace,
    Comment,
    String,
    Atom,
    Operator,
    LeftBrace,
    RightBrace,
    Invalid,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
    pub line: u32,
    pub column: u32,
}

impl Token {
    fn trivia(&self) -> bool {
        matches!(self.kind, TokenKind::Whitespace | TokenKind::Comment)
    }
}

fn starts_operator(text: &[u16], index: usize) -> bool {
    match text.get(index).copied() {
        Some(u) if u == u16::from(b'=') || u == u16::from(b'<') || u == u16::from(b'>') || u == u16::from(b'!') => true,
        Some(u) if u == u16::from(b'?') => text.get(index + 1) == Some(&u16::from(b'=')),
        _ => false,
    }
}

/// Serializes a JavaScript string the way `JSON.stringify` does.
pub fn js_json_string(units: &[u16]) -> String {
    serde_json::to_string(&string(units)).unwrap_or_default()
}

/// `lexClausewitz`.
pub fn lex(text: &[u16], path: &str, lines: &LineIndex, diagnostics: &mut Collector) -> Vec<Token> {
    let mut tokens = Vec::new();
    if let Some(at) = lines.line_limit_exceeded_at {
        let position = SourcePosition { line: to_u32(SOURCE_LINE_LIMIT + 1), column: 1, offset: to_u32(at) };
        diagnostics.add(|| {
            diagnostic(
                "SOURCE_LINE_LIMIT",
                Severity::Blocker,
                Category::Syntax,
                format!("Source line count exceeds the supported limit of {SOURCE_LINE_LIMIT}"),
                Some(SourceLocation { path: path.into(), start: position, end: position, symbol: None }),
                Some(json!({ "limit": SOURCE_LINE_LIMIT })),
            )
        });
        return tokens;
    }
    let mut index = 0usize;
    let mut line = 1u32;
    let mut column = 1u32;
    let cr = u16::from(b'\r');
    let lf = u16::from(b'\n');
    let advance = |index: &mut usize, line: &mut u32, column: &mut u32| -> u16 {
        let current = text[*index];
        *index += 1;
        if current == cr {
            if text.get(*index) == Some(&lf) {
                *index += 1;
            }
            *line += 1;
            *column = 1;
        } else if current == lf {
            *line += 1;
            *column = 1;
        } else {
            *column += 1;
        }
        current
    };
    let loc = |start: usize, end: usize| Some(location_for(path, text, lines, start, end));
    while index < text.len() {
        if tokens.len() >= SOURCE_TOKEN_LIMIT {
            let at = index;
            diagnostics.add(|| {
                diagnostic(
                    "SOURCE_TOKEN_LIMIT",
                    Severity::Blocker,
                    Category::Syntax,
                    format!("Source token count exceeds the supported limit of {SOURCE_TOKEN_LIMIT}"),
                    loc(at, text.len().min(at + 1)),
                    Some(json!({ "limit": SOURCE_TOKEN_LIMIT })),
                )
            });
            break;
        }
        let start = index;
        let (start_line, start_column) = (line, column);
        let current = text[index];
        let push = |tokens: &mut Vec<Token>, kind: TokenKind, end: usize| tokens.push(Token { kind, start, end, line: start_line, column: start_column });
        if is_js_space(current) {
            while index < text.len() && is_js_space(text[index]) {
                advance(&mut index, &mut line, &mut column);
            }
            push(&mut tokens, TokenKind::Whitespace, index);
            continue;
        }
        if current == u16::from(b'#') {
            while index < text.len() && text[index] != lf && text[index] != cr {
                advance(&mut index, &mut line, &mut column);
            }
            push(&mut tokens, TokenKind::Comment, index);
            continue;
        }
        if current == u16::from(b'{') || current == u16::from(b'}') {
            advance(&mut index, &mut line, &mut column);
            push(&mut tokens, if current == u16::from(b'{') { TokenKind::LeftBrace } else { TokenKind::RightBrace }, index);
            continue;
        }
        if current == u16::from(b'"') {
            advance(&mut index, &mut line, &mut column);
            let mut terminated = false;
            while index < text.len() {
                if text[index] == u16::from(b'\\') {
                    let escape_start = index;
                    advance(&mut index, &mut line, &mut column);
                    if index < text.len() {
                        let escaped = advance(&mut index, &mut line, &mut column);
                        if escaped != u16::from(b'\\') && escaped != u16::from(b'"') {
                            let end = index;
                            diagnostics.add(|| {
                                diagnostic(
                                    "SOURCE_UNSUPPORTED_ESCAPE",
                                    Severity::Error,
                                    Category::Syntax,
                                    "Clausewitz strings support only \\\\ and \\\" escapes",
                                    loc(escape_start, end),
                                    None,
                                )
                            });
                        }
                    }
                    continue;
                }
                if text[index] == u16::from(b'"') {
                    advance(&mut index, &mut line, &mut column);
                    terminated = true;
                    break;
                }
                advance(&mut index, &mut line, &mut column);
            }
            push(&mut tokens, if terminated { TokenKind::String } else { TokenKind::Invalid }, index);
            let end = index;
            if !terminated {
                diagnostics.add(|| diagnostic("SOURCE_UNTERMINATED_STRING", Severity::Error, Category::Syntax, "Unterminated quoted string", loc(start, end), None));
            }
            if terminated && text[start..end].iter().any(|&u| u == cr || u == lf) {
                diagnostics.add(|| {
                    diagnostic("SOURCE_STRING_NEWLINE", Severity::Error, Category::Syntax, "Clausewitz quoted strings cannot contain a literal newline", loc(start, end), None)
                });
            }
            if terminated && end - start - 2 > 255 {
                diagnostics.add(|| {
                    diagnostic(
                        "SOURCE_STRING_TOO_LONG",
                        Severity::Warning,
                        Category::Syntax,
                        "Quoted string longer than 255 characters. Vanilla has none, but no game limit is recorded: check it in game before shortening it",
                        loc(start, end),
                        None,
                    )
                });
            }
            continue;
        }
        if starts_operator(text, index) {
            advance(&mut index, &mut line, &mut column);
            if text.get(index) == Some(&u16::from(b'=')) {
                advance(&mut index, &mut line, &mut column);
            }
            push(&mut tokens, TokenKind::Operator, index);
            let operator = string(&text[start..index]);
            if !["=", "<", ">", "?="].contains(&operator.as_str()) {
                let end = index;
                diagnostics.add(|| diagnostic("SOURCE_UNSUPPORTED_OPERATOR", Severity::Error, Category::Syntax, format!("Unsupported Clausewitz operator {operator}"), loc(start, end), None));
            }
            continue;
        }
        while index < text.len() {
            let c = text[index];
            if is_js_space(c) || c == u16::from(b'#') || c == u16::from(b'{') || c == u16::from(b'}') || c == u16::from(b'"') || starts_operator(text, index) {
                break;
            }
            advance(&mut index, &mut line, &mut column);
        }
        if index == start {
            advance(&mut index, &mut line, &mut column);
            push(&mut tokens, TokenKind::Invalid, index);
            let end = index;
            diagnostics.add(|| diagnostic("SOURCE_INVALID_CHARACTER", Severity::Error, Category::Syntax, format!("Invalid character {}", js_json_string(&[current])), loc(start, end), None));
        } else {
            push(&mut tokens, TokenKind::Atom, index);
        }
    }
    tokens
}

#[derive(Clone, Debug)]
pub struct Scalar {
    /// Token index.
    pub token: usize,
    pub value: String,
    pub quoted: bool,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug)]
pub enum SourceValue {
    Scalar(Scalar),
    Block(Block),
}

#[derive(Clone, Debug)]
pub struct Assignment {
    pub key: Scalar,
    pub operator: usize,
    pub value: SourceValue,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug)]
pub enum SourceEntry {
    Scalar(Scalar),
    Assignment(Assignment),
    Block(Block),
}

#[derive(Clone, Debug, Default)]
pub struct Block {
    pub open: Option<usize>,
    pub close: Option<usize>,
    pub entries: Vec<SourceEntry>,
    pub start: usize,
    pub end: usize,
}

impl SourceValue {
    pub fn as_block(&self) -> Option<&Block> {
        match self {
            SourceValue::Block(block) => Some(block),
            SourceValue::Scalar(_) => None,
        }
    }

    pub fn as_scalar(&self) -> Option<&Scalar> {
        match self {
            SourceValue::Scalar(scalar) => Some(scalar),
            SourceValue::Block(_) => None,
        }
    }

    pub fn end(&self) -> usize {
        match self {
            SourceValue::Scalar(s) => s.end,
            SourceValue::Block(b) => b.end,
        }
    }
}

/// `SourceDocument`.
#[derive(Clone, Debug)]
pub struct Document {
    pub path: String,
    pub decoded: Decoded,
    pub tokens: Vec<Token>,
    pub lines: LineIndex,
    pub root: Block,
    pub diagnostics: Vec<Diagnostic>,
}

impl Document {
    pub fn text(&self) -> &[u16] {
        &self.decoded.text
    }

    pub fn token_text(&self, token: usize) -> String {
        let t = &self.tokens[token];
        string(&self.decoded.text[t.start..t.end])
    }

    /// `nodeLocation`.
    pub fn location(&self, start: usize, end: usize, symbol: Option<&str>) -> SourceLocation {
        let mut location = location_for(&self.path, &self.decoded.text, &self.lines, start, end);
        location.symbol = symbol.map(str::to_string);
        location
    }
}

fn scalar_value(text: &[u16], token: &Token) -> String {
    let raw = &text[token.start..token.end];
    if token.kind != TokenKind::String {
        return string(raw);
    }
    let inner = &raw[1..raw.len() - 1];
    let mut out = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] == u16::from(b'\\') && i + 1 < inner.len() && (inner[i + 1] == u16::from(b'"') || inner[i + 1] == u16::from(b'\\')) {
            out.push(inner[i + 1]);
            i += 2;
        } else {
            out.push(inner[i]);
            i += 1;
        }
    }
    string(&out)
}

struct Parser<'a> {
    index: usize,
    tokens: &'a [Token],
    text: &'a [u16],
    path: &'a str,
    lines: &'a LineIndex,
    diagnostics: &'a mut Collector,
}

impl Parser<'_> {
    fn next_significant(&mut self) -> Option<usize> {
        while self.index < self.tokens.len() && self.tokens[self.index].trivia() {
            self.index += 1;
        }
        (self.index < self.tokens.len()).then_some(self.index)
    }

    fn consume_significant(&mut self) -> Option<usize> {
        let token = self.next_significant()?;
        self.index += 1;
        Some(token)
    }

    fn location(&self, token: usize) -> Option<SourceLocation> {
        let t = &self.tokens[token];
        Some(location_for(self.path, self.text, self.lines, t.start, t.end))
    }

    fn token_json(&self, token: usize) -> String {
        let t = &self.tokens[token];
        js_json_string(&self.text[t.start..t.end])
    }

    fn parse_root(&mut self) -> Block {
        let mut root = self.parse_block(None, 0);
        root.start = 0;
        root.end = self.text.len();
        root
    }

    fn parse_block(&mut self, open: Option<usize>, depth: usize) -> Block {
        if let Some(open) = open
            && depth > SOURCE_MAX_NESTING
        {
            return self.parse_over_limit_block(open);
        }
        let mut entries = Vec::new();
        let mut close = None;
        while let Some(token) = self.next_significant() {
            if self.tokens[token].kind == TokenKind::RightBrace {
                self.index += 1;
                close = Some(token);
                if open.is_none() {
                    let location = self.location(token);
                    self.diagnostics.add(|| diagnostic("SOURCE_UNEXPECTED_RIGHT_BRACE", Severity::Error, Category::Syntax, "Unexpected closing brace", location, None));
                    continue;
                }
                break;
            }
            if let Some(entry) = self.parse_entry(depth) {
                entries.push(entry);
            }
        }
        if let Some(open) = open
            && close.is_none()
        {
            let location = self.location(open);
            self.diagnostics.add(|| diagnostic("SOURCE_UNCLOSED_BLOCK", Severity::Error, Category::Syntax, "Block is missing a closing brace", location, None));
        }
        Block {
            open,
            close,
            entries,
            start: open.map_or(0, |t| self.tokens[t].start),
            end: close.map_or(self.text.len(), |t| self.tokens[t].end),
        }
    }

    fn parse_over_limit_block(&mut self, open: usize) -> Block {
        let location = self.location(open);
        self.diagnostics.add(|| {
            diagnostic(
                "SOURCE_NESTING_LIMIT",
                Severity::Blocker,
                Category::Syntax,
                format!("Clausewitz block nesting exceeds the supported limit of {SOURCE_MAX_NESTING}"),
                location.clone(),
                Some(json!({ "limit": SOURCE_MAX_NESTING })),
            )
        });
        let mut nesting = 1;
        let mut close = None;
        while let Some(token) = self.consume_significant() {
            match self.tokens[token].kind {
                TokenKind::LeftBrace => nesting += 1,
                TokenKind::RightBrace => {
                    nesting -= 1;
                    if nesting == 0 {
                        close = Some(token);
                        break;
                    }
                }
                _ => {}
            }
        }
        if close.is_none() {
            self.diagnostics.add(|| diagnostic("SOURCE_UNCLOSED_BLOCK", Severity::Error, Category::Syntax, "Block is missing a closing brace", location, None));
        }
        Block { open: Some(open), close, entries: Vec::new(), start: self.tokens[open].start, end: close.map_or(self.text.len(), |t| self.tokens[t].end) }
    }

    fn scalar(&self, token: usize) -> Scalar {
        let t = &self.tokens[token];
        Scalar { token, value: scalar_value(self.text, t), quoted: t.kind == TokenKind::String, start: t.start, end: t.end }
    }

    fn parse_entry(&mut self, depth: usize) -> Option<SourceEntry> {
        let token = self.consume_significant()?;
        let kind = self.tokens[token].kind;
        if kind == TokenKind::LeftBrace {
            return Some(SourceEntry::Block(self.parse_block(Some(token), depth + 1)));
        }
        if !matches!(kind, TokenKind::Atom | TokenKind::String | TokenKind::Invalid) {
            let (message, location) = (format!("Unexpected token {}", self.token_json(token)), self.location(token));
            self.diagnostics.add(|| diagnostic("SOURCE_UNEXPECTED_TOKEN", Severity::Error, Category::Syntax, message, location, None));
            return None;
        }
        let scalar = self.scalar(token);
        let operator = self.next_significant();
        let Some(operator) = operator.filter(|&o| self.tokens[o].kind == TokenKind::Operator) else {
            return Some(SourceEntry::Scalar(scalar));
        };
        self.index += 1;
        let Some(value_token) = self.consume_significant() else {
            let (message, location) = (format!("Assignment {} is missing a value", scalar.value), self.location(operator));
            self.diagnostics.add(|| diagnostic("SOURCE_MISSING_VALUE", Severity::Error, Category::Syntax, message, location, None));
            return Some(SourceEntry::Scalar(scalar));
        };
        let value = match self.tokens[value_token].kind {
            TokenKind::LeftBrace => SourceValue::Block(self.parse_block(Some(value_token), depth + 1)),
            TokenKind::Atom | TokenKind::String | TokenKind::Invalid => SourceValue::Scalar(self.scalar(value_token)),
            _ => {
                let (message, location) = (format!("Invalid assignment value {}", self.token_json(value_token)), self.location(value_token));
                self.diagnostics.add(|| diagnostic("SOURCE_INVALID_VALUE", Severity::Error, Category::Syntax, message, location, None));
                let t = &self.tokens[value_token];
                SourceValue::Scalar(Scalar { token: value_token, value: string(&self.text[t.start..t.end]), quoted: false, start: t.start, end: t.end })
            }
        };
        let (start, end) = (scalar.start, value.end());
        Some(SourceEntry::Assignment(Assignment { key: scalar, operator, value, start, end }))
    }
}

/// `parseClausewitz`.
pub fn parse(bytes: &[u8], path: &str) -> Document {
    let decoded = decode(bytes);
    let mut diagnostics = Collector::default();
    let empty_root = |len: usize| Block { start: 0, end: len, ..Block::default() };
    if bytes.len() > SOURCE_MAX_BYTES {
        let lines = LineIndex { line_starts: vec![0], line_limit_exceeded_at: None };
        let origin = SourcePosition { line: 1, column: 1, offset: 0 };
        diagnostics.add(|| {
            diagnostic(
                "SOURCE_FILE_SIZE_LIMIT",
                Severity::Blocker,
                Category::Syntax,
                format!("Clausewitz source exceeds the supported {SOURCE_MAX_BYTES}-byte parsing limit"),
                Some(SourceLocation { path: path.into(), start: origin, end: origin, symbol: None }),
                Some(json!({ "limit": SOURCE_MAX_BYTES })),
            )
        });
        let root = empty_root(decoded.text.len());
        return Document { path: path.into(), decoded, tokens: Vec::new(), lines, root, diagnostics: diagnostics.diagnostics };
    }
    let lines = line_index(&decoded.text);
    if let Some(at) = lines.line_limit_exceeded_at {
        let position = SourcePosition { line: to_u32(SOURCE_LINE_LIMIT + 1), column: 1, offset: to_u32(at) };
        diagnostics.add(|| {
            diagnostic(
                "SOURCE_LINE_LIMIT",
                Severity::Blocker,
                Category::Syntax,
                format!("Clausewitz source line count exceeds the supported limit of {SOURCE_LINE_LIMIT}"),
                Some(SourceLocation { path: path.into(), start: position, end: position, symbol: None }),
                Some(json!({ "limit": SOURCE_LINE_LIMIT })),
            )
        });
        let root = empty_root(decoded.text.len());
        return Document { path: path.into(), decoded, tokens: Vec::new(), lines, root, diagnostics: diagnostics.diagnostics };
    }
    if let Some(loss) = &decoded.loss {
        let location = Some(location_for(path, &decoded.text, &lines, loss.first_offset, loss.first_offset + 1));
        let values: Vec<String> = loss.byte_values.iter().map(|b| format!("0x{b:X}")).collect();
        diagnostics.add(|| {
            diagnostic(
                "SOURCE_ENCODING_NOT_ROUND_TRIPPABLE",
                Severity::Warning,
                Category::Syntax,
                "Source is not valid UTF-8 and contains bytes that Windows-1252 cannot represent; it can be read but any rewrite is refused",
                location,
                Some(json!({ "byteCount": loss.count, "byteValues": values })),
            )
        });
    }
    let tokens = lex(&decoded.text, path, &lines, &mut diagnostics);
    let root = Parser { index: 0, tokens: &tokens, text: &decoded.text, path, lines: &lines, diagnostics: &mut diagnostics }.parse_root();
    Document { path: path.into(), decoded, tokens, lines, root, diagnostics: diagnostics.diagnostics }
}

/// `assignments(block, key)`.
pub fn assignments<'a>(block: &'a Block, key: Option<&'a str>) -> impl Iterator<Item = &'a Assignment> + 'a {
    block.entries.iter().filter_map(move |entry| match entry {
        SourceEntry::Assignment(a) if key.is_none_or(|k| a.key.value == k) => Some(a),
        _ => None,
    })
}

/// `childBlocks(block, key)`.
pub fn child_blocks<'a>(block: &'a Block, key: &'a str) -> impl Iterator<Item = &'a Block> + 'a {
    assignments(block, Some(key)).filter_map(|a| a.value.as_block())
}

/// `firstScalar(block, key)`: the first assignment of `key`, when its value is a scalar.
pub fn first_scalar<'a>(block: &'a Block, key: &str) -> Option<&'a Scalar> {
    block.entries.iter().find_map(|entry| match entry {
        SourceEntry::Assignment(a) if a.key.value == key => Some(a),
        _ => None,
    })?.value.as_scalar()
}

/// The scalar entries of a block (`scalarList`).
pub fn scalar_list(block: Option<&Block>) -> Vec<&str> {
    block.map_or_else(Vec::new, |b| {
        b.entries
            .iter()
            .filter_map(|e| match e {
                SourceEntry::Scalar(s) => Some(s.value.as_str()),
                _ => None,
            })
            .collect()
    })
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

    fn codes(doc: &Document) -> Vec<&str> {
        doc.diagnostics.iter().map(|d| d.code.as_str()).collect()
    }

    #[test]
    fn parses_assignments_blocks_and_lists() {
        let doc = parse(b"state = { id = 5 provinces = { 1 2 \"3\" } }\n", "mod:a.txt");
        assert!(doc.diagnostics.is_empty());
        let state = assignments(&doc.root, Some("state")).next().unwrap();
        let block = state.value.as_block().unwrap();
        assert_eq!(first_scalar(block, "id").unwrap().value, "5");
        let provinces = child_blocks(block, "provinces").next().unwrap();
        assert_eq!(scalar_list(Some(provinces)), ["1", "2", "3"]);
        let location = doc.location(state.start, state.end, Some("5"));
        assert_eq!((location.start.line, location.start.column, location.end.offset), (1, 1, 43));
    }

    #[test]
    fn reports_the_typescript_codes() {
        assert_eq!(codes(&parse(b"}", "p")), ["SOURCE_UNEXPECTED_RIGHT_BRACE"]);
        assert_eq!(codes(&parse(b"a = {", "p")), ["SOURCE_UNCLOSED_BLOCK"]);
        assert_eq!(codes(&parse(b"a =", "p")), ["SOURCE_MISSING_VALUE"]);
        assert_eq!(codes(&parse(b"a = =", "p")), ["SOURCE_INVALID_VALUE"]);
        assert_eq!(codes(&parse(b"= a", "p")), ["SOURCE_UNEXPECTED_TOKEN"]);
        assert_eq!(codes(&parse(b"a != b", "p")), ["SOURCE_UNSUPPORTED_OPERATOR"]);
        assert_eq!(codes(&parse(b"a = \"b", "p")), ["SOURCE_UNTERMINATED_STRING"]);
        assert_eq!(codes(&parse(b"a = \"b\\n\"", "p")), ["SOURCE_UNSUPPORTED_ESCAPE"]);
        assert_eq!(codes(&parse(b"a = \"b\nc\"", "p")), ["SOURCE_STRING_NEWLINE"]);
        let deep = format!("{}{}", "a = { ".repeat(300), "} ".repeat(300));
        assert_eq!(codes(&parse(deep.as_bytes(), "p")), ["SOURCE_NESTING_LIMIT"]);
        assert_eq!(codes(&parse(&[b'a', b'=', 0x81], "p")), ["SOURCE_ENCODING_NOT_ROUND_TRIPPABLE"]);
    }

    #[test]
    fn caps_diagnostics_per_file() {
        let doc = parse("}".repeat(150).as_bytes(), "p");
        assert_eq!(doc.diagnostics.len(), SOURCE_DIAGNOSTIC_LIMIT);
        assert_eq!(doc.diagnostics.last().unwrap().code, "SOURCE_DIAGNOSTICS_TRUNCATED");
    }

    #[test]
    fn counts_positions_in_utf16_code_units() {
        let doc = parse("a = \"😀\"\r\nb = c".as_bytes(), "p");
        let b = assignments(&doc.root, Some("b")).next().unwrap();
        let location = doc.location(b.start, b.end, None);
        assert_eq!((location.start.line, location.start.column, location.start.offset), (2, 1, 10));
    }

    #[test]
    fn decodes_windows_1252() {
        let decoded = decode(&[0x80, b'a', 0x9D]);
        assert_eq!(decoded.encoding, Encoding::Windows1252);
        assert_eq!(decoded.text, [0x20AC, u16::from(b'a'), 0xFFFD]);
        assert_eq!(decoded.loss.unwrap().byte_values, [0x9D]);
    }
}

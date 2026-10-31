//! Lossless syntax tree over the lexer's tokens.
//!
//! Nodes refer to token indices, and every node covers a contiguous token range nested inside its
//! parent's range. Trivia (whitespace, comments, byte order marks) stay in the token list between
//! nodes. [`Document::write_tree`] walks the tree and reproduces the input byte for byte, and
//! [`Document::verify_structure`] checks that every non-trivia token is owned by exactly one node.

use std::borrow::Cow;
use std::ops::Range;

use serde::Serialize;

use crate::encoding::{self, Encoding};
use crate::lexer::{self, Operator, Token, TokenKind};

/// Blocks nested deeper than this are kept as opaque token runs. The game's own files stay far
/// below it; the limit protects the parser's stack.
pub const MAX_NESTING: usize = 256;

#[derive(Clone, Debug)]
pub struct Block {
    /// Token index of `{`; `None` for the file root.
    pub open: Option<u32>,
    /// Token index of `}`; `None` for the root and for a block left open at the end of the file.
    pub close: Option<u32>,
    pub items: Vec<Item>,
    pub tokens: Range<u32>,
    /// True when the block exceeded [`MAX_NESTING`]; its tokens are not parsed into items.
    pub opaque: bool,
}

#[derive(Clone, Debug)]
pub enum Item {
    Entry(Entry),
    /// A bare value inside a list, such as `{ 1 2 3 }` or `{ GER ITA }`.
    Value(Value),
    /// A token that cannot start an item here: a `}` at file level, or an operator without a key.
    Stray(u32),
}

#[derive(Clone, Debug)]
pub struct Entry {
    /// Token index of the key (a word or a quoted string).
    pub key: u32,
    /// Token index of the operator; `None` for the rare `key { ... }` form.
    pub op: Option<u32>,
    pub value: Value,
    pub tokens: Range<u32>,
}

#[derive(Clone, Debug)]
pub enum Value {
    Scalar(u32),
    Block(Block),
    /// A tagged block such as `rgb { 255 0 0 }` or `hsv { 0.5 0.5 0.5 }`.
    Tagged {
        tag: u32,
        block: Block,
    },
    /// An operator with nothing after it.
    Missing,
}

#[derive(Clone, Debug, Serialize)]
pub struct SyntaxDiagnostic {
    pub code: &'static str,
    pub message: String,
    /// Byte range the diagnostic points at.
    pub start: u32,
    pub end: u32,
}

pub struct Document {
    pub bytes: Vec<u8>,
    pub encoding: Encoding,
    pub tokens: Vec<Token>,
    pub root: Block,
    pub diagnostics: Vec<SyntaxDiagnostic>,
    line_starts: Vec<u32>,
}

impl Item {
    pub fn tokens(&self) -> Range<u32> {
        match self {
            Item::Entry(e) => e.tokens.clone(),
            Item::Value(v) => v.tokens().unwrap_or(0..0),
            Item::Stray(t) => *t..*t + 1,
        }
    }

    pub fn as_entry(&self) -> Option<&Entry> {
        match self {
            Item::Entry(e) => Some(e),
            _ => None,
        }
    }
}

impl Value {
    pub fn tokens(&self) -> Option<Range<u32>> {
        match self {
            Value::Scalar(t) => Some(*t..*t + 1),
            Value::Block(b) => Some(b.tokens.clone()),
            Value::Tagged { tag, block } => Some(*tag..block.tokens.end),
            Value::Missing => None,
        }
    }

    pub fn as_block(&self) -> Option<&Block> {
        match self {
            Value::Block(b) => Some(b),
            Value::Tagged { block, .. } => Some(block),
            _ => None,
        }
    }

    pub fn as_scalar(&self) -> Option<u32> {
        match self {
            Value::Scalar(t) => Some(*t),
            _ => None,
        }
    }
}

impl Block {
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.items.iter().filter_map(Item::as_entry)
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    tokens: &'a [Token],
    pos: usize,
    diagnostics: Vec<SyntaxDiagnostic>,
}

impl Parser<'_> {
    fn skip_trivia(&mut self) {
        while self.pos < self.tokens.len() && self.tokens[self.pos].is_trivia() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<TokenKind> {
        self.tokens.get(self.pos).map(|t| t.kind)
    }

    fn diag(&mut self, code: &'static str, message: impl Into<String>, token: usize) {
        let t = self.tokens[token];
        self.diagnostics.push(SyntaxDiagnostic { code, message: message.into(), start: t.start, end: t.end });
    }

    fn check_scalar(&mut self, index: usize) {
        let t = self.tokens[index];
        if t.kind == TokenKind::Quoted && !lexer::quoted_is_terminated(self.bytes, &t) {
            self.diag("SYNTAX_UNTERMINATED_STRING", "quoted string has no closing quote", index);
        }
    }

    /// Parses items until the matching `}` (when `open` is set) or the end of the file.
    fn parse_block(&mut self, open: Option<usize>, depth: usize) -> Block {
        let start = open.unwrap_or(0) as u32;
        if open.is_some() && depth > MAX_NESTING {
            return self.skip_opaque(open.unwrap_or(0));
        }
        let mut items = Vec::new();
        loop {
            self.skip_trivia();
            let Some(kind) = self.peek() else {
                if let Some(o) = open {
                    self.diag("SYNTAX_UNCLOSED_BLOCK", "block is not closed before the end of the file", o);
                }
                return Block { open: open.map(|o| o as u32), close: None, items, tokens: start..self.tokens.len() as u32, opaque: false };
            };
            let here = self.pos;
            match kind {
                TokenKind::RBrace => {
                    self.pos += 1;
                    if open.is_some() {
                        return Block { open: open.map(|o| o as u32), close: Some(here as u32), items, tokens: start..self.pos as u32, opaque: false };
                    }
                    self.diag("SYNTAX_STRAY_CLOSING_BRACE", "closing brace has no matching opening brace", here);
                    items.push(Item::Stray(here as u32));
                }
                TokenKind::LBrace => {
                    self.pos += 1;
                    let block = self.parse_block(Some(here), depth + 1);
                    items.push(Item::Value(Value::Block(block)));
                }
                TokenKind::Operator => {
                    self.pos += 1;
                    self.diag("SYNTAX_STRAY_OPERATOR", "operator has no key before it", here);
                    items.push(Item::Stray(here as u32));
                }
                TokenKind::Word | TokenKind::Quoted => {
                    self.pos += 1;
                    self.check_scalar(here);
                    let after_key = self.pos;
                    self.skip_trivia();
                    match self.peek() {
                        Some(TokenKind::Operator) => {
                            let op = self.pos;
                            self.pos += 1;
                            let value = self.parse_value(op, depth);
                            let end = value.tokens().map_or(op as u32 + 1, |r| r.end);
                            items.push(Item::Entry(Entry { key: here as u32, op: Some(op as u32), value, tokens: here as u32..end }));
                        }
                        Some(TokenKind::LBrace) if kind == TokenKind::Word => {
                            let brace = self.pos;
                            self.pos += 1;
                            let block = self.parse_block(Some(brace), depth + 1);
                            let end = block.tokens.end;
                            items.push(Item::Entry(Entry { key: here as u32, op: None, value: Value::Block(block), tokens: here as u32..end }));
                        }
                        _ => {
                            self.pos = after_key;
                            items.push(Item::Value(Value::Scalar(here as u32)));
                        }
                    }
                }
                TokenKind::Whitespace | TokenKind::Comment | TokenKind::Bom => unreachable!("trivia skipped"),
            }
        }
    }

    fn parse_value(&mut self, op: usize, depth: usize) -> Value {
        let resume = self.pos;
        self.skip_trivia();
        match self.peek() {
            Some(TokenKind::LBrace) => {
                let brace = self.pos;
                self.pos += 1;
                Value::Block(self.parse_block(Some(brace), depth + 1))
            }
            Some(TokenKind::Word | TokenKind::Quoted) => {
                let t = self.pos;
                self.pos += 1;
                self.check_scalar(t);
                let tag = &self.bytes[self.tokens[t].range()];
                if self.tokens[t].kind == TokenKind::Word && is_color_tag(tag) {
                    let after = self.pos;
                    self.skip_trivia();
                    if self.peek() == Some(TokenKind::LBrace) {
                        let brace = self.pos;
                        self.pos += 1;
                        let block = self.parse_block(Some(brace), depth + 1);
                        return Value::Tagged { tag: t as u32, block };
                    }
                    self.pos = after;
                }
                Value::Scalar(t as u32)
            }
            _ => {
                self.pos = resume;
                self.diag("SYNTAX_MISSING_VALUE", "operator has no value after it", op);
                Value::Missing
            }
        }
    }

    fn skip_opaque(&mut self, open: usize) -> Block {
        self.diag("SYNTAX_NESTING_TOO_DEEP", format!("blocks nest deeper than {MAX_NESTING} levels"), open);
        let mut depth = 1usize;
        while let Some(kind) = self.peek() {
            self.pos += 1;
            match kind {
                TokenKind::LBrace => depth += 1,
                TokenKind::RBrace => {
                    depth -= 1;
                    if depth == 0 {
                        return Block {
                            open: Some(open as u32),
                            close: Some(self.pos as u32 - 1),
                            items: Vec::new(),
                            tokens: open as u32..self.pos as u32,
                            opaque: true,
                        };
                    }
                }
                _ => {}
            }
        }
        Block { open: Some(open as u32), close: None, items: Vec::new(), tokens: open as u32..self.pos as u32, opaque: true }
    }
}

/// 1-based line and 1-based byte column of `offset`, given the line start offsets.
pub fn position_in(line_starts: &[u32], offset: u32) -> (u32, u32) {
    let line = match line_starts.binary_search(&offset) {
        Ok(i) => i,
        Err(i) => i.saturating_sub(1),
    };
    let start = line_starts.get(line).copied().unwrap_or(0);
    (line as u32 + 1, offset.saturating_sub(start) + 1)
}

/// Line start offsets of any byte buffer.
pub fn line_starts(bytes: &[u8]) -> Vec<u32> {
    let mut starts = vec![0u32];
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            starts.push(i as u32 + 1);
        }
    }
    starts
}

fn is_color_tag(text: &[u8]) -> bool {
    text.eq_ignore_ascii_case(b"rgb") || text.eq_ignore_ascii_case(b"hsv") || text.eq_ignore_ascii_case(b"hsv360")
}

impl Document {
    pub fn parse(bytes: Vec<u8>) -> Self {
        let encoding = encoding::detect(&bytes);
        let tokens = lexer::lex(&bytes);
        let mut parser = Parser { bytes: &bytes, tokens: &tokens, pos: 0, diagnostics: Vec::new() };
        let root = parser.parse_block(None, 0);
        let diagnostics = parser.diagnostics;
        let mut line_starts = vec![0u32];
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                line_starts.push(i as u32 + 1);
            }
        }
        Document { bytes, encoding, tokens, root, diagnostics, line_starts }
    }

    pub fn token(&self, index: u32) -> Token {
        self.tokens[index as usize]
    }

    pub fn token_bytes(&self, index: u32) -> &[u8] {
        &self.bytes[self.tokens[index as usize].range()]
    }

    /// The text of a word or quoted token, without quotes, decoded for comparison and display.
    pub fn text(&self, index: u32) -> Cow<'_, str> {
        let token = self.tokens[index as usize];
        let mut raw = &self.bytes[token.range()];
        if token.kind == TokenKind::Quoted {
            raw = &raw[1..];
            if raw.last() == Some(&b'"') && lexer::quoted_is_terminated(&self.bytes, &token) {
                raw = &raw[..raw.len() - 1];
            }
        }
        encoding::decode(raw, self.encoding)
    }

    pub fn is_quoted(&self, index: u32) -> bool {
        self.tokens[index as usize].kind == TokenKind::Quoted
    }

    pub fn operator(&self, entry: &Entry) -> Option<Operator> {
        entry.op.and_then(|op| Operator::parse(self.token_bytes(op)))
    }

    pub fn key(&self, entry: &Entry) -> Cow<'_, str> {
        self.text(entry.key)
    }

    /// Byte range covered by a token range.
    pub fn byte_range(&self, tokens: &Range<u32>) -> Range<u32> {
        if tokens.start >= tokens.end {
            let at = self.tokens.get(tokens.start as usize).map_or(self.bytes.len() as u32, |t| t.start);
            return at..at;
        }
        self.tokens[tokens.start as usize].start..self.tokens[tokens.end as usize - 1].end
    }

    /// 1-based line and 1-based byte column of a byte offset.
    pub fn position(&self, offset: u32) -> (u32, u32) {
        position_in(&self.line_starts, offset)
    }

    /// Byte offsets where each line starts, for callers that keep positions after the tree is gone.
    pub fn line_starts(&self) -> &[u32] {
        &self.line_starts
    }

    /// Reproduces the source by walking the tree. Equal to `bytes` for every input.
    pub fn write_tree(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes.len());
        self.write_range(&self.root, &mut out);
        out
    }

    fn write_tokens(&self, range: Range<u32>, out: &mut Vec<u8>) {
        for i in range {
            out.extend_from_slice(self.token_bytes(i));
        }
    }

    fn write_range(&self, block: &Block, out: &mut Vec<u8>) {
        let mut cursor = block.tokens.start;
        for item in &block.items {
            let range = item.tokens();
            if range.is_empty() {
                continue;
            }
            self.write_tokens(cursor..range.start, out);
            match item {
                Item::Entry(entry) => {
                    if let Some(inner) = entry.value.as_block() {
                        self.write_tokens(entry.tokens.start..inner.tokens.start, out);
                        self.write_range(inner, out);
                    } else {
                        self.write_tokens(range.clone(), out);
                    }
                }
                Item::Value(value) => match value.as_block() {
                    Some(inner) => {
                        self.write_tokens(range.start..inner.tokens.start, out);
                        self.write_range(inner, out);
                    }
                    None => self.write_tokens(range.clone(), out),
                },
                Item::Stray(_) => self.write_tokens(range.clone(), out),
            }
            cursor = range.end;
        }
        self.write_tokens(cursor..block.tokens.end, out);
    }

    /// Checks that nodes nest inside their parents in order, and that every token between nodes is
    /// trivia or the enclosing block's own brace.
    pub fn verify_structure(&self) -> Result<(), String> {
        let mut pos = 0usize;
        for t in &self.tokens {
            if t.start as usize != pos {
                return Err(format!("token gap at byte {pos}"));
            }
            pos = t.end as usize;
        }
        if pos != self.bytes.len() {
            return Err("tokens do not cover the input".into());
        }
        if self.root.tokens != (0..self.tokens.len() as u32) {
            return Err("root does not cover every token".into());
        }
        self.verify_block(&self.root)
    }

    fn verify_block(&self, block: &Block) -> Result<(), String> {
        if block.opaque {
            return Ok(());
        }
        let mut cursor = block.tokens.start;
        if let Some(open) = block.open {
            if open != block.tokens.start {
                return Err(format!("block at token {open} does not start with its brace"));
            }
            cursor += 1;
        }
        let limit = block.close.unwrap_or(block.tokens.end);
        if let Some(close) = block.close
            && close + 1 != block.tokens.end
        {
            return Err(format!("block closing brace {close} is not its last token"));
        }
        for item in &block.items {
            let range = item.tokens();
            if range.is_empty() {
                continue;
            }
            if range.start < cursor || range.end > limit {
                return Err(format!("item {range:?} escapes its block {:?}", block.tokens));
            }
            self.verify_gap(cursor..range.start)?;
            match item {
                Item::Entry(entry) => {
                    if entry.key != range.start {
                        return Err("entry does not start at its key".into());
                    }
                    if let Some(inner) = entry.value.as_block() {
                        self.verify_block(inner)?;
                    }
                }
                Item::Value(value) => {
                    if let Some(inner) = value.as_block() {
                        self.verify_block(inner)?;
                    }
                }
                Item::Stray(_) => {}
            }
            cursor = range.end;
        }
        self.verify_gap(cursor..limit)
    }

    fn verify_gap(&self, range: Range<u32>) -> Result<(), String> {
        for i in range {
            let t = self.tokens[i as usize];
            if !t.is_trivia() {
                return Err(format!("token {i} ({:?}) at byte {} has no owning node", t.kind, t.start));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &str) -> Document {
        let doc = Document::parse(src.as_bytes().to_vec());
        assert_eq!(doc.write_tree(), src.as_bytes(), "tree round trip");
        doc.verify_structure().expect("structure");
        doc
    }

    fn codes(doc: &Document) -> Vec<&'static str> {
        doc.diagnostics.iter().map(|d| d.code).collect()
    }

    #[test]
    fn parses_entries_lists_and_comments() {
        let doc = parse("# header\nfocus = {\n\tid = X # trailing\n\tprerequisite = { focus = A focus = B }\n\tx = 3\n}\nlist = { 1 2 3 }\n");
        assert!(doc.diagnostics.is_empty());
        let entries: Vec<_> = doc.root.entries().collect();
        assert_eq!(doc.key(entries[0]), "focus");
        let focus = entries[0].value.as_block().unwrap();
        let keys: Vec<_> = focus.entries().map(|e| doc.key(e).into_owned()).collect();
        assert_eq!(keys, ["id", "prerequisite", "x"]);
        let list = entries[1].value.as_block().unwrap();
        assert_eq!(list.items.len(), 3);
        assert!(matches!(list.items[0], Item::Value(Value::Scalar(_))));
    }

    #[test]
    fn keeps_operators_quotes_and_colours() {
        let doc = parse("a >= 5 b != c name = \"Big \\\"Q\\\"\" color = rgb { 1 2 3 } d ?= e");
        let entries: Vec<_> = doc.root.entries().collect();
        assert_eq!(doc.operator(entries[0]), Some(Operator::Ge));
        assert_eq!(doc.operator(entries[1]), Some(Operator::NotEq));
        assert_eq!(doc.text(entries[2].value.as_scalar().unwrap()), "Big \\\"Q\\\"");
        assert!(matches!(entries[3].value, Value::Tagged { .. }));
        assert_eq!(doc.operator(entries[4]), Some(Operator::QuestionEq));
    }

    #[test]
    fn recovers_from_stray_and_unclosed_braces() {
        let doc = parse("a = { b = c }}\nd = e");
        assert_eq!(codes(&doc), ["SYNTAX_STRAY_CLOSING_BRACE"]);
        assert_eq!(doc.root.entries().count(), 2);

        let doc = parse("a = { b = { c = d }\n");
        assert_eq!(codes(&doc), ["SYNTAX_UNCLOSED_BLOCK"]);
    }

    #[test]
    fn reports_missing_values_and_stray_operators() {
        let doc = parse("a = \n}");
        assert_eq!(codes(&doc), ["SYNTAX_MISSING_VALUE", "SYNTAX_STRAY_CLOSING_BRACE"]);
        let doc = parse("= b");
        assert_eq!(codes(&doc), ["SYNTAX_STRAY_OPERATOR"]);
        let doc = parse("a = \"open\nb = c");
        assert_eq!(codes(&doc), ["SYNTAX_UNTERMINATED_STRING"]);
    }

    #[test]
    fn keeps_deep_nesting_lossless() {
        let depth = MAX_NESTING + 10;
        let src = format!("{}{}", "a = { ".repeat(depth), "} ".repeat(depth));
        let doc = parse(&src);
        assert_eq!(codes(&doc), ["SYNTAX_NESTING_TOO_DEEP"]);
    }

    #[test]
    fn positions_are_one_based() {
        let doc = parse("a = b\r\n  c = d");
        let c = doc.root.entries().nth(1).unwrap();
        let start = doc.token(c.key).start;
        assert_eq!(doc.position(start), (2, 3));
    }

    #[test]
    fn preserves_windows_1252_and_bom_bytes() {
        let src = b"name = \"Gro\xDF\"\r\n".to_vec();
        let doc = Document::parse(src.clone());
        assert_eq!(doc.write_tree(), src);
        assert_eq!(doc.encoding, Encoding::Windows1252);
        let entry = doc.root.entries().next().unwrap();
        assert_eq!(doc.text(entry.value.as_scalar().unwrap()), "Gro\u{df}");

        let src = "\u{feff}name = \"Gro\u{df}\"\n".as_bytes().to_vec();
        let doc = Document::parse(src.clone());
        assert_eq!(doc.write_tree(), src);
        assert_eq!(doc.encoding, Encoding::Utf8Bom);
        assert_eq!(doc.tokens[0].kind, TokenKind::Bom);
    }
}

//! Positions in UTF-16 code units, reached from byte offsets.
//!
//! Adapted from `engine/crates/engine/src/symbol_index/records.rs` (`Positions`), which ports
//! `createSourceLineIndex` and `positionAt` of `src/hoi4_agent_tools/core/source/lexer.ts`, commit
//! `fc88d04`. Copied because that type is private to the engine crate; the diagnostic conversion
//! is the same one `index_files` uses.

use hoi4_engine::symbol_index::reader::{At, SourceDiagnostic};
use serde_json::{Map, Value, json};

pub struct Positions<'t> {
    text: &'t str,
    ascii: bool,
    starts: Vec<(u32, u32)>,
    units: u32,
}

impl<'t> Positions<'t> {
    pub fn new(text: &'t str) -> Self {
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
    pub fn unit(&self, byte: u32) -> u32 {
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
    pub fn position(&self, byte: u32) -> [u32; 3] {
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

    fn position_of_unit(&self, unit: u32) -> [u32; 3] {
        let bounded = unit.min(self.units);
        let line = self.starts.partition_point(|&(_, start)| start <= bounded).max(1) - 1;
        let (start_byte, start_unit) = self.starts[line];
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

    pub fn location(path: &str, start: [u32; 3], end: [u32; 3], symbol: Option<&str>) -> Value {
        let position = |p: [u32; 3]| json!({ "line": p[0], "column": p[1], "offset": p[2] });
        let mut location = json!({ "path": path, "start": position(start), "end": position(end) });
        if let Some(symbol) = symbol {
            location["symbol"] = Value::from(symbol);
        }
        location
    }

    /// `nodeLocation`: the location of a byte range, with an optional symbol.
    pub fn node_location(&self, path: &str, start: u32, end: u32, symbol: Option<&str>) -> Value {
        Self::location(path, self.position(start), self.position(end), symbol)
    }

    /// A source diagnostic as the TypeScript `Diagnostic` object.
    pub fn diagnostic(&self, path: &str, diagnostic: &SourceDiagnostic) -> Value {
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

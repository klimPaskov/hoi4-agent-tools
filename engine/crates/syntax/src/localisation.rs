//! Localisation files (`localisation/**/*.yml`). The game reads them line by line, not as YAML:
//! a `l_<language>:` header, then ` key:0 "text"` lines. Every byte belongs to exactly one line, so
//! [`LocFile::write`] reproduces the input.

use std::ops::Range;

use serde::Serialize;

use crate::ast::SyntaxDiagnostic;
use crate::encoding::UTF8_BOM;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Blank,
    Comment,
    Header,
    Entry,
    Invalid,
}

#[derive(Clone, Debug)]
pub struct LocLine {
    /// Byte range of the line including its line ending.
    pub range: Range<u32>,
    pub kind: LineKind,
}

#[derive(Clone, Debug, Serialize)]
pub struct LocEntry {
    pub key: String,
    pub key_range: Range<u32>,
    pub version: Option<u32>,
    /// Byte range of the text between the quotes.
    pub value_range: Range<u32>,
    pub line: u32,
}

pub struct LocFile {
    pub bytes: Vec<u8>,
    pub has_bom: bool,
    pub language: Option<String>,
    pub lines: Vec<LocLine>,
    pub entries: Vec<LocEntry>,
    pub diagnostics: Vec<SyntaxDiagnostic>,
}

fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'\'')
}

impl LocFile {
    pub fn parse(bytes: Vec<u8>) -> Self {
        let has_bom = bytes.starts_with(UTF8_BOM);
        let mut file = LocFile { bytes, has_bom, language: None, lines: Vec::new(), entries: Vec::new(), diagnostics: Vec::new() };
        let len = file.bytes.len();
        let mut start = 0usize;
        let mut headers = 0usize;
        let mut line_no = 0u32;
        while start < len {
            line_no += 1;
            let mut end = start;
            while end < len && file.bytes[end] != b'\n' {
                end += 1;
            }
            let next = if end < len { end + 1 } else { end };
            let mut content_end = end;
            if content_end > start && file.bytes[content_end - 1] == b'\r' {
                content_end -= 1;
            }
            let mut s = start;
            if line_no == 1 && has_bom {
                s += UTF8_BOM.len();
            }
            let kind = file.classify(s, content_end, line_no, &mut headers);
            file.lines.push(LocLine { range: start as u32..next as u32, kind });
            start = next;
        }
        if !has_bom {
            file.diag("LOC_MISSING_BOM", "localisation file does not start with a UTF-8 byte order mark", 0..0);
        }
        if headers == 0 {
            file.diag("LOC_MISSING_LANGUAGE_HEADER", "localisation file has no l_<language>: header", 0..0);
        }
        file
    }

    fn diag(&mut self, code: &'static str, message: &str, range: Range<usize>) {
        self.diagnostics.push(SyntaxDiagnostic { code, message: message.into(), start: range.start as u32, end: range.end as u32 });
    }

    fn classify(&mut self, start: usize, end: usize, line_no: u32, headers: &mut usize) -> LineKind {
        let bytes = &self.bytes;
        let mut i = start;
        while i < end && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        if i == end {
            return LineKind::Blank;
        }
        if bytes[i] == b'#' {
            return LineKind::Comment;
        }
        let key_start = i;
        while i < end && is_key_byte(bytes[i]) {
            i += 1;
        }
        let key_end = i;
        if key_end == key_start || i >= end || bytes[i] != b':' {
            self.diag("LOC_INVALID_LINE", "line is neither a header, a comment nor a key: \"text\" entry", start..end);
            return LineKind::Invalid;
        }
        i += 1;
        let version_start = i;
        while i < end && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let version = std::str::from_utf8(&bytes[version_start..i]).ok().and_then(|v| v.parse().ok());
        let mut j = i;
        while j < end && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        let key = String::from_utf8_lossy(&bytes[key_start..key_end]).into_owned();
        if key.starts_with("l_") && version.is_none() && (j == end || bytes[j] == b'#') {
            *headers += 1;
            if *headers > 1 {
                self.diag("LOC_MULTIPLE_LANGUAGE_HEADERS", "localisation file has more than one language header", key_start..key_end);
            } else {
                if !self.entries.is_empty() {
                    self.diag("LOC_CONTENT_BEFORE_HEADER", "entries appear before the language header", key_start..key_end);
                }
                self.language = Some(key[2..].to_string());
            }
            return LineKind::Header;
        }
        if j >= end || bytes[j] != b'"' {
            self.diag("LOC_MISSING_OPEN_QUOTE", "localisation value does not start with a double quote", key_start..end);
            return LineKind::Invalid;
        }
        // The game takes the text up to the last double quote on the line.
        let open = j;
        let close = bytes[open + 1..end].iter().rposition(|&b| b == b'"').map(|p| open + 1 + p);
        let Some(close) = close else {
            self.diag("LOC_UNTERMINATED_VALUE", "localisation value has no closing double quote", key_start..end);
            return LineKind::Invalid;
        };
        if *headers == 0 {
            self.diag("LOC_CONTENT_BEFORE_HEADER", "entries appear before the language header", key_start..key_end);
        }
        self.entries.push(LocEntry { key, key_range: key_start as u32..key_end as u32, version, value_range: open as u32 + 1..close as u32, line: line_no });
        LineKind::Entry
    }

    pub fn write(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes.len());
        for line in &self.lines {
            out.extend_from_slice(&self.bytes[line.range.start as usize..line.range.end as usize]);
        }
        out
    }

    pub fn value(&self, entry: &LocEntry) -> String {
        String::from_utf8_lossy(&self.bytes[entry.value_range.start as usize..entry.value_range.end as usize]).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &[u8]) -> LocFile {
        let file = LocFile::parse(src.to_vec());
        assert_eq!(file.write(), src);
        file
    }

    fn codes(file: &LocFile) -> Vec<&'static str> {
        file.diagnostics.iter().map(|d| d.code).collect()
    }

    #[test]
    fn reads_header_and_entries() {
        let file = parse("\u{feff}l_english:\n # note\n key:0 \"Text with \"inner\" quotes\"\n other: \"x\" # tail\r\n".as_bytes());
        assert!(file.diagnostics.is_empty(), "{:?}", file.diagnostics);
        assert_eq!(file.language.as_deref(), Some("english"));
        assert_eq!(file.entries.len(), 2);
        assert_eq!(file.entries[0].key, "key");
        assert_eq!(file.entries[0].version, Some(0));
        assert_eq!(file.value(&file.entries[0]), "Text with \"inner\" quotes");
        assert_eq!(file.entries[1].line, 4);
    }

    #[test]
    fn reports_structure_problems() {
        assert_eq!(codes(&parse(b"l_english:\n a: \"b\"\n")), ["LOC_MISSING_BOM"]);
        assert_eq!(codes(&parse("\u{feff} a: \"b\"\n".as_bytes())), ["LOC_CONTENT_BEFORE_HEADER", "LOC_MISSING_LANGUAGE_HEADER"]);
        assert_eq!(codes(&parse("\u{feff}l_english:\nl_german:\n".as_bytes())), ["LOC_MULTIPLE_LANGUAGE_HEADERS"]);
        assert_eq!(codes(&parse("\u{feff}l_english:\n a: b\n".as_bytes())), ["LOC_MISSING_OPEN_QUOTE"]);
        assert_eq!(codes(&parse("\u{feff}l_english:\n a: \"b\n".as_bytes())), ["LOC_UNTERMINATED_VALUE"]);
        assert_eq!(codes(&parse("\u{feff}l_english:\n just words\n".as_bytes())), ["LOC_INVALID_LINE"]);
    }
}

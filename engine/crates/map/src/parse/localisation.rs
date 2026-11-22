//! Localisation files, as far as the map needs them: entry keys by language, and the parser's
//! diagnostics.
//!
//! Ported from `src/hoi4_agent_tools/core/source/localisation.ts` (`parseLocalisation`,
//! `decodeLocalisationValue`), commit `9b7dc80d`. The regular expressions are matched by hand
//! with the same results; positions count UTF-16 code units.

use hoi4_core::diagnostics::{Category, Diagnostic, Severity, SourceLocation, SourcePosition};
use serde_json::json;

use super::source::{self, Collector, Encoding, SOURCE_ENTRY_LIMIT, SOURCE_LINE_LIMIT, SOURCE_MAX_BYTES, diagnostic, is_js_space, location_for, string};

#[derive(Clone, Debug, PartialEq)]
pub struct LocalisationEntry {
    pub key: String,
    pub version: Option<u64>,
    pub value: String,
    pub language: String,
    pub start: usize,
    pub end: usize,
    pub line: usize,
}

#[derive(Clone, Debug)]
pub struct LocalisationDocument {
    pub path: String,
    pub entries: Vec<LocalisationEntry>,
    pub diagnostics: Vec<Diagnostic>,
}

const QUOTE: u16 = b'"' as u16;
const BACKSLASH: u16 = b'\\' as u16;

/// `.` of a JavaScript regular expression: anything but a line terminator.
fn dot(unit: u16) -> bool {
    !matches!(unit, 0x0A | 0x0D | 0x2028 | 0x2029)
}

fn skip_space(line: &[u16], mut i: usize) -> usize {
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    i
}

/// `\s*(?:#.*)?$` from `i`.
fn rest_is_comment(line: &[u16], i: usize) -> bool {
    let i = skip_space(line, i);
    i == line.len() || (line[i] == u16::from(b'#') && line[i + 1..].iter().all(|&u| dot(u)))
}

/// `^\s*(l_[a-z_]+):\s*(?:#.*)?$`.
fn language(line: &[u16]) -> Option<String> {
    let start = skip_space(line, 0);
    let rest = &line[start..];
    if rest.len() < 3 || rest[0] != u16::from(b'l') || rest[1] != u16::from(b'_') {
        return None;
    }
    let mut end = 2;
    while end < rest.len() && (rest[end] == u16::from(b'_') || (u16::from(b'a')..=u16::from(b'z')).contains(&rest[end])) {
        end += 1;
    }
    if end == 2 || rest.get(end) != Some(&u16::from(b':')) || !rest_is_comment(rest, end + 1) {
        return None;
    }
    Some(string(&rest[..end]))
}

/// The key and version prefix shared by both entry patterns: `^\s*([A-Za-z0-9_.-]+):(?:(\d+)\s+|\s*)"`.
/// Returns the key, the version and the index after the opening quote.
fn entry_prefix(line: &[u16]) -> Option<(String, Option<u64>, usize)> {
    let start = skip_space(line, 0);
    let key_char = |u: u16| u < 128 && (u as u8 as char).is_ascii_alphanumeric() || u == u16::from(b'_') || u == u16::from(b'.') || u == u16::from(b'-');
    let mut i = start;
    while i < line.len() && key_char(line[i]) {
        i += 1;
    }
    if i == start || line.get(i) != Some(&u16::from(b':')) {
        return None;
    }
    let key = string(&line[start..i]);
    i += 1;
    let digits_end = {
        let mut j = i;
        while j < line.len() && (u16::from(b'0')..=u16::from(b'9')).contains(&line[j]) {
            j += 1;
        }
        j
    };
    if digits_end > i {
        let after = skip_space(line, digits_end);
        if after > digits_end && line.get(after) == Some(&QUOTE) {
            let version = string(&line[i..digits_end]).parse::<f64>().ok().map(|v| v as u64);
            return Some((key, version, after + 1));
        }
        return None;
    }
    let after = skip_space(line, i);
    (line.get(after) == Some(&QUOTE)).then_some((key, None, after + 1))
}

/// `entryPattern`, then `innerQuotePattern`: the key, the version and the raw value.
fn entry(line: &[u16]) -> Option<(String, Option<u64>, Vec<u16>)> {
    let (key, version, body) = entry_prefix(line)?;
    // `"((?:\\.|[^"\\])*)"\s*(?:#.*)?$`
    let mut i = body;
    let mut closed = None;
    while i < line.len() {
        match line[i] {
            QUOTE => {
                closed = Some(i);
                break;
            }
            BACKSLASH => {
                if i + 1 < line.len() && dot(line[i + 1]) {
                    i += 2;
                } else {
                    break;
                }
            }
            _ => i += 1,
        }
    }
    if let Some(close) = closed
        && rest_is_comment(line, close + 1)
    {
        return Some((key, version, line[body..close].to_vec()));
    }
    // `"(.*)"\s*$`: up to the last quote that only whitespace follows.
    let close = line.iter().rposition(|&u| u == QUOTE)?;
    if close < body || skip_space(line, close + 1) != line.len() || !line[body..close].iter().all(|&u| dot(u)) {
        return None;
    }
    Some((key, version, line[body..close].to_vec()))
}

/// `decodeLocalisationValue`.
fn decode_value(value: &[u16]) -> String {
    let mut out = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        if value[i] != BACKSLASH || i + 1 >= value.len() {
            out.push(value[i]);
            i += 1;
            continue;
        }
        let escaped = value[i + 1];
        if escaped == u16::from(b'n') {
            out.push(u16::from(b'\n'));
        } else if escaped == QUOTE || escaped == BACKSLASH {
            out.push(escaped);
        } else {
            out.extend([BACKSLASH, escaped]);
        }
        i += 2;
    }
    string(&out)
}

/// `parseLocalisation`.
pub fn parse_localisation(bytes: &[u8], path: &str) -> LocalisationDocument {
    let decoded = source::decode(bytes);
    let text = &decoded.text;
    let mut collector = Collector::default();
    let mut entries = Vec::new();
    if bytes.len() > SOURCE_MAX_BYTES {
        let origin = SourcePosition { line: 1, column: 1, offset: 0 };
        collector.add(|| {
            diagnostic(
                "SOURCE_FILE_SIZE_LIMIT",
                Severity::Blocker,
                Category::Syntax,
                format!("Localisation source exceeds the supported {SOURCE_MAX_BYTES}-byte parsing limit"),
                Some(SourceLocation { path: path.into(), start: origin, end: origin, symbol: None }),
                Some(json!({ "limit": SOURCE_MAX_BYTES })),
            )
        });
        return LocalisationDocument { path: path.into(), entries, diagnostics: collector.diagnostics };
    }
    let lines = source::line_index(text);
    if let Some(at) = lines.line_limit_exceeded_at {
        let position = SourcePosition { line: (SOURCE_LINE_LIMIT + 1) as u32, column: 1, offset: at as u32 };
        collector.add(|| {
            diagnostic(
                "SOURCE_LINE_LIMIT",
                Severity::Blocker,
                Category::Syntax,
                format!("Localisation source line count exceeds the supported limit of {SOURCE_LINE_LIMIT}"),
                Some(SourceLocation { path: path.into(), start: position, end: position, symbol: None }),
                Some(json!({ "limit": SOURCE_LINE_LIMIT })),
            )
        });
        return LocalisationDocument { path: path.into(), entries, diagnostics: collector.diagnostics };
    }
    let loc = |start: usize, end: usize| Some(location_for(path, text, &lines, start, end));
    if decoded.encoding != Encoding::Utf8Bom {
        collector.add(|| diagnostic("LOCALISATION_BOM_MISSING", Severity::Error, Category::Syntax, "HOI4 localisation files require UTF-8 with BOM encoding", loc(0, text.len().min(1)), None));
    }
    let (cr, lf) = (u16::from(b'\r'), u16::from(b'\n'));
    let mut current_language = String::new();
    let mut offset = 0;
    let mut line_number = 1;
    while offset < text.len() {
        let mut line_end = offset;
        while line_end < text.len() && text[line_end] != cr && text[line_end] != lf {
            line_end += 1;
        }
        let mut next = line_end;
        if text.get(next) == Some(&cr) {
            next += 1;
        }
        if text.get(next) == Some(&lf) {
            next += 1;
        } else if text.get(line_end) == Some(&lf) {
            next = line_end + 1;
        }
        let line = &text[offset..line_end];
        if let Some(language) = language(line) {
            current_language = language;
        } else if !rest_is_comment(line, 0) {
            match entry(line) {
                None => collector.add(|| diagnostic("LOCALISATION_MALFORMED_LINE", Severity::Error, Category::Syntax, "Malformed localisation line", loc(offset, line_end), None)),
                Some(_) if current_language.is_empty() => collector.add(|| {
                    diagnostic("LOCALISATION_LANGUAGE_MISSING", Severity::Error, Category::Syntax, "Localisation entry appears before a language declaration", loc(offset, line_end), None)
                }),
                Some((key, version, value)) => {
                    if entries.len() >= SOURCE_ENTRY_LIMIT {
                        collector.add(|| {
                            diagnostic(
                                "SOURCE_ENTRY_LIMIT",
                                Severity::Blocker,
                                Category::Syntax,
                                format!("Localisation entries exceed the supported limit of {SOURCE_ENTRY_LIMIT}"),
                                loc(offset, line_end),
                                Some(json!({ "limit": SOURCE_ENTRY_LIMIT })),
                            )
                        });
                        break;
                    }
                    entries.push(LocalisationEntry { key, version, value: decode_value(&value), language: current_language.clone(), start: offset, end: line_end, line: line_number });
                }
            }
        }
        offset = next;
        line_number += 1;
    }
    LocalisationDocument { path: path.into(), entries, diagnostics: collector.diagnostics }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> LocalisationDocument {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(text.as_bytes());
        parse_localisation(&bytes, "mod:localisation/x_l_english.yml")
    }

    #[test]
    fn reads_entries_versions_and_inner_quotes() {
        let doc = parse("l_english:\n STATE_1:0 \"Name\" # c\n STATE_2: \"He said \"hi\" now\"\n k:1 \"a\\nb\"\n");
        assert!(doc.diagnostics.is_empty(), "{:?}", doc.diagnostics);
        let keys: Vec<_> = doc.entries.iter().map(|e| (e.key.as_str(), e.version, e.value.as_str(), e.line)).collect();
        assert_eq!(keys, [("STATE_1", Some(0), "Name", 2), ("STATE_2", None, "He said \"hi\" now", 3), ("k", Some(1), "a\nb", 4)]);
        assert_eq!(doc.entries[0].language, "l_english");
    }

    #[test]
    fn reports_malformed_lines_a_missing_language_and_a_missing_bom() {
        let doc = parse(" k: \"a\"\nl_english:\n k:0\"a\"\n");
        let codes: Vec<_> = doc.diagnostics.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["LOCALISATION_LANGUAGE_MISSING", "LOCALISATION_MALFORMED_LINE"]);
        let doc = parse_localisation(b"l_english:\n", "mod:x.yml");
        assert_eq!(doc.diagnostics[0].code, "LOCALISATION_BOM_MISSING");
    }
}

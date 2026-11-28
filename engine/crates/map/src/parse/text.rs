//! Line-based map tables (`definition.csv`, `adjacencies.csv`, `buildings.txt` and the rest), and
//! the number and date readers the map model shares.
//!
//! Ported from `src/hoi4_agent_tools/map/model.ts` (`parseTextDocument`, `lineLocation`,
//! `splitDelimitedRow`, `whitespaceRow`, `parseInteger`, `parseNumber`, `parseMapDate`), commit
//! `9b7dc80d`.

use hoi4_core::diagnostics::{SourceLocation, SourcePosition};

use crate::model::MapError;

pub const MAP_TEXT_MAX_BYTES: usize = 16_777_216;
pub const MAP_TEXT_MAX_RECORDS: usize = 500_000;
pub const MAP_TEXT_FIELD_LIMIT: usize = 10_000;

/// `TextLine`: a line's code-unit range without and with its line break.
#[derive(Clone, Debug)]
pub struct TextLine {
    pub index: usize,
    pub start: usize,
    pub end: usize,
    pub full_end: usize,
}

/// `TextFileDocument`.
#[derive(Clone, Debug)]
pub struct TextDocument {
    pub path: String,
    /// The decoded text as UTF-16 code units, the unit of the TypeScript offsets.
    pub text: Vec<u16>,
    pub lines: Vec<TextLine>,
}

impl TextDocument {
    pub fn line_text(&self, line: &TextLine) -> &[u16] {
        &self.text[line.start..line.end]
    }

    /// `lineLocation` of the model: the line's text, columns from one.
    pub fn line_location(&self, line: &TextLine) -> SourceLocation {
        let number = u32::try_from(line.index + 1).unwrap_or(u32::MAX);
        SourceLocation {
            path: self.path.clone(),
            start: SourcePosition { line: number, column: 1, offset: line.start as u32 },
            end: SourcePosition { line: number, column: (line.end - line.start + 1) as u32, offset: line.end as u32 },
            symbol: None,
        }
    }

    /// `lineLocation` of the validation: the one-based line, when it exists.
    pub fn one_based_location(&self, one_based: usize) -> Option<SourceLocation> {
        self.lines.get(one_based.checked_sub(1)?).map(|line| self.line_location(line))
    }

    /// `requiredLineLocation`.
    pub fn required_location(&self, one_based: usize) -> SourceLocation {
        self.one_based_location(one_based).unwrap_or_else(|| {
            let position = SourcePosition { line: one_based as u32, column: 1, offset: 0 };
            SourceLocation { path: self.path.clone(), start: position, end: position, symbol: None }
        })
    }
}

/// `parseTextDocument`.
pub fn parse_text_document(bytes: &[u8], display_path: &str, relative_path: &str) -> Result<TextDocument, MapError> {
    if bytes.len() > MAP_TEXT_MAX_BYTES {
        return Err(MapError::new(
            "MAP_TEXT_FILE_LIMIT",
            format!("Map text table {relative_path} exceeds the supported 16 MiB parsing limit ({} bytes)", bytes.len()),
            serde_json::json!({ "relativePath": relative_path, "bytes": bytes.len(), "maximumBytes": MAP_TEXT_MAX_BYTES }),
        ));
    }
    let (decoded, _) = hoi4_engine::symbol_index::reader::decode(bytes);
    let text: Vec<u16> = decoded.encode_utf16().collect();
    let (cr, lf) = (u16::from(b'\r'), u16::from(b'\n'));
    let mut lines = Vec::new();
    let mut start = 0;
    loop {
        // `/.*(?:\r\n|\n|\r|$)/gu`: `.` stops at any line terminator, including U+2028 and U+2029.
        let mut end = start;
        while end < text.len() && !matches!(text[end], 0x0A | 0x0D | 0x2028 | 0x2029) {
            end += 1;
        }
        if end < text.len() && text[end] != cr && text[end] != lf {
            // U+2028 or U+2029: no match can end here, so the next match starts after it.
            start = end + 1;
            continue;
        }
        let full_end = if end < text.len() && text[end] == cr && text.get(end + 1) == Some(&lf) {
            end + 2
        } else if end < text.len() {
            end + 1
        } else {
            end
        };
        if full_end == start {
            // The empty match at the end of the text.
            break;
        }
        if lines.len() >= MAP_TEXT_MAX_RECORDS {
            return Err(MapError::new(
                "MAP_TEXT_RECORD_LIMIT",
                format!("Map text table {relative_path} exceeds the supported record limit"),
                serde_json::json!({ "relativePath": relative_path, "records": lines.len() + 1, "maximumRecords": MAP_TEXT_MAX_RECORDS }),
            ));
        }
        lines.push(TextLine { index: lines.len(), start, end, full_end });
        start = full_end;
    }
    Ok(TextDocument { path: display_path.to_string(), text, lines })
}

/// The characters of the JavaScript `\s` class, on a UTF-16 code unit.
pub fn is_js_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(hoi4_engine::symbol_index::reader::is_js_space)
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

/// `splitDelimitedRow`: at most `maximum` trimmed fields, the last holding the rest.
pub fn split_delimited(value: &[u16], maximum: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0;
    while parts.len() + 1 < maximum {
        let Some(next) = value[start..].iter().position(|&u| u == u16::from(b';')) else {
            break;
        };
        parts.push(string(js_trim(&value[start..start + next])));
        start += next + 1;
    }
    parts.push(string(js_trim(&value[start..])));
    parts
}

/// `whitespaceRow` without its diagnostic: `None` when the row exceeds the field limit.
pub fn whitespace_fields(text: &[u16]) -> Option<Vec<String>> {
    let comment = text.iter().position(|&u| u == u16::from(b'#'));
    let value = js_trim(&text[..comment.unwrap_or(text.len())]);
    let mut fields = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if is_js_space(value[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < value.len() && !is_js_space(value[i]) {
            i += 1;
        }
        if fields.len() >= MAP_TEXT_FIELD_LIMIT {
            return None;
        }
        fields.push(string(&value[start..i]));
    }
    Some(fields)
}

fn js_trim_str(value: &str) -> String {
    string(js_trim(&utf16(value)))
}

/// `parseInteger`: an optionally signed decimal integer within the safe-integer range.
pub fn parse_integer(value: Option<&str>) -> Option<i64> {
    let trimmed = js_trim_str(value?);
    let digits = trimmed.strip_prefix('-').unwrap_or(&trimmed);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed: f64 = trimmed.parse().ok()?;
    const SAFE: f64 = 9_007_199_254_740_991.0;
    (parsed.abs() <= SAFE).then_some(parsed as i64)
}

/// `parseNumber`: `-?(?:\d+(?:\.\d*)?|\.\d+)` after trimming, finite.
pub fn parse_number(value: Option<&str>) -> Option<f64> {
    let trimmed = js_trim_str(value?);
    let negative = trimmed.starts_with('-');
    let body = trimmed.strip_prefix('-').unwrap_or(&trimmed);
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let (whole, fraction) = body.split_once('.').map_or((body, None), |(w, f)| (w, Some(f)));
    let valid = if whole.is_empty() { fraction.is_some_and(|f| !f.is_empty() && digits(f)) } else { digits(whole) && fraction.is_none_or(digits) };
    if !valid {
        return None;
    }
    let sign = if negative { "-" } else { "" };
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = fraction.filter(|f| !f.is_empty()).unwrap_or("0");
    let parsed: f64 = format!("{sign}{whole}.{fraction}").parse().ok()?;
    parsed.is_finite().then_some(parsed)
}

/// `parseMapDate`: `year.month.day[.hour]` as a sortable ordinal.
pub fn parse_map_date(value: &str) -> Option<i64> {
    let parts: Vec<&str> = value.split('.').collect();
    if !(3..=4).contains(&parts.len()) {
        return None;
    }
    let widths = [4, 2, 2, 2];
    let mut numbers = [0i64; 4];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > widths[i] || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        numbers[i] = part.parse().ok()?;
    }
    let [year, month, day, hour] = numbers;
    if year < 1 || !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..=23).contains(&hour) {
        return None;
    }
    Some(year * 1_000_000 + month * 10_000 + day * 100 + hour)
}

/// A number as JavaScript prints it in a template string.
pub fn js_number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 { format!("{}", value as i64) } else { format!("{value}") }
}

/// A number as `JSON.stringify` writes it: integral values without a fraction.
pub fn json_number(value: f64) -> serde_json::Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serde_json::Value::from(value as i64)
    } else {
        serde_json::Value::from(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_like_the_typescript_regular_expression() {
        let doc = parse_text_document(b"a\r\nb\nc\rd", "mod:x", "x").unwrap();
        let texts: Vec<String> = doc.lines.iter().map(|l| string(doc.line_text(l))).collect();
        assert_eq!(texts, ["a", "b", "c", "d"]);
        assert_eq!((doc.lines[1].start, doc.lines[1].full_end), (3, 5));
        let trailing = parse_text_document(b"a\n", "mod:x", "x").unwrap();
        assert_eq!(trailing.lines.len(), 1);
        assert_eq!(parse_text_document(b"", "mod:x", "x").unwrap().lines.len(), 0);
    }

    #[test]
    fn reads_numbers_and_dates_like_the_typescript() {
        assert_eq!(parse_integer(Some(" -12 ")), Some(-12));
        assert_eq!(parse_integer(Some("1.5")), None);
        assert_eq!(parse_integer(Some("99999999999999999")), None);
        assert_eq!(parse_number(Some(".5")), Some(0.5));
        assert_eq!(parse_number(Some("-1.")), Some(-1.0));
        assert_eq!(parse_number(Some(".")), None);
        assert_eq!(parse_number(Some("1e3")), None);
        assert_eq!(parse_map_date("1936.1.1"), Some(1_936_010_100));
        assert_eq!(parse_map_date("1936.13.1"), None);
        assert_eq!(parse_map_date("1936.1.1.12"), Some(1_936_010_112));
        assert_eq!(split_delimited(&utf16("1; 2 ;3;4"), 3), ["1", "2", "3;4"]);
        assert_eq!(whitespace_fields(&utf16(" 1  2 # x")), Some(vec!["1".to_string(), "2".to_string()]));
        assert_eq!(js_number(3.0), "3");
        assert_eq!(js_number(1.25), "1.25");
    }
}

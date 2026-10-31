//! Source encodings the game reads: UTF-8 with or without a byte order mark, and Windows-1252.
//!
//! The parser never decodes the whole file. It works on bytes, so a round trip is byte-identical
//! whatever the encoding. Decoding happens only when a name or text value is read.

use std::borrow::Cow;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Windows1252,
}

pub const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Detects the encoding the way the game treats it: a leading BOM means UTF-8, valid UTF-8 means
/// UTF-8, anything else is read as Windows-1252.
pub fn detect(bytes: &[u8]) -> Encoding {
    if bytes.starts_with(UTF8_BOM) {
        Encoding::Utf8Bom
    } else if std::str::from_utf8(bytes).is_ok() {
        Encoding::Utf8
    } else {
        Encoding::Windows1252
    }
}

/// Windows-1252 code points for bytes 0x80 to 0x9F. Undefined bytes map to U+FFFD.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}',
    '\u{FFFD}', '\u{017D}', '\u{FFFD}', '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}',
    '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

/// Decodes a slice of the source for display or comparison.
pub fn decode(bytes: &[u8], encoding: Encoding) -> Cow<'_, str> {
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => String::from_utf8_lossy(bytes),
        Encoding::Windows1252 => {
            if bytes.is_ascii() {
                // ASCII is identical in both encodings.
                Cow::Borrowed(std::str::from_utf8(bytes).unwrap_or_default())
            } else {
                Cow::Owned(
                    bytes
                        .iter()
                        .map(|&b| match b {
                            0x80..=0x9F => CP1252_HIGH[usize::from(b - 0x80)],
                            _ => char::from(b),
                        })
                        .collect(),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_each_encoding() {
        assert_eq!(detect(b"\xEF\xBB\xBFa = b"), Encoding::Utf8Bom);
        assert_eq!(detect("a = \"Gro\u{df}\"".as_bytes()), Encoding::Utf8);
        assert_eq!(detect(b"a = \"Gro\xDF\""), Encoding::Windows1252);
    }

    #[test]
    fn decodes_windows_1252_high_bytes() {
        assert_eq!(decode(b"\x80 \x9F \xE9", Encoding::Windows1252), "\u{20AC} \u{178} \u{e9}");
        assert_eq!(decode(b"\x81", Encoding::Windows1252), "\u{FFFD}");
    }
}

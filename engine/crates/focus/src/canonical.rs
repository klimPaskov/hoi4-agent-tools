//! Canonical JSON (keys sorted by UTF-16 code units, no whitespace) and SHA-256, so hashes match
//! the TypeScript tools' `compareCodeUnits` ordering on every platform.

use std::cmp::Ordering;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Orders strings by UTF-16 code units, like JavaScript's default string comparison.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.as_bytes().cmp(b.as_bytes());
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| cmp_utf16(a, b));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                write(&map[key.as_str()], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

pub fn hash_value(value: &Value) -> String {
    sha256_hex(&canonical_json(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_order_differs_from_utf8_for_astral_characters() {
        // U+FF5E (one code unit 0xFF5E) sorts after U+1F600 (surrogates 0xD83D 0xDE00) in UTF-16,
        // but before it in UTF-8 byte order.
        assert_eq!(cmp_utf16("\u{1F600}", "\u{FF5E}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF5E}"), Ordering::Greater);
    }

    #[test]
    fn canonical_json_sorts_keys_and_drops_whitespace() {
        let v: Value = serde_json::from_str(r#"{ "b": [1, {"z": 1, "a": "x"}], "a": null }"#).unwrap();
        assert_eq!(canonical_json(&v), r#"{"a":null,"b":[1,{"a":"x","z":1}]}"#);
        assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}

//! Canonical JSON and SHA-256, byte-equal to the TypeScript server.
//!
//! Ported from `src/hoi4_agent_tools/core/canonical.ts` (`compareCodeUnits`, `canonicalize`,
//! `canonicalJson`, `sha256Bytes`, `hashCanonical`), commit `ef3d2215`. Content addresses,
//! fingerprints and revisions are hashes of canonical JSON, so the bytes must match the
//! TypeScript ones exactly while both servers run side by side.
//!
//! The TypeScript copy is a plain object, so its keys come out in JavaScript property order:
//! array-index keys (`"0"` to `"4294967294"` in canonical decimal form) first in numeric order,
//! then every other key in UTF-16 code-unit order. Numbers are written as `JSON.stringify` writes
//! them, with `-0` written as `0`. Non-finite numbers cannot occur in a `serde_json::Value`.

use std::cmp::Ordering;

use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

/// Locale-independent total order over UTF-16 code units, as JavaScript `<` orders strings.
pub fn compare_code_units(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// The value of a JavaScript array-index key, if `key` is one.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    (value < u64::from(u32::MAX)).then_some(value as u32)
}

fn compare_keys(left: &str, right: &str) -> Ordering {
    match (array_index(left), array_index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => compare_code_units(left, right),
    }
}

/// A number as JavaScript `String(number)` writes it.
fn write_number(number: &Number, out: &mut String) {
    if let Some(value) = number.as_i64() {
        out.push_str(&value.to_string());
        return;
    }
    if let Some(value) = number.as_u64() {
        out.push_str(&value.to_string());
        return;
    }
    let value = number.as_f64().unwrap_or(0.0);
    if value == 0.0 {
        out.push('0');
        return;
    }
    // Shortest round-trip digits and the decimal exponent, then the ECMAScript Number::toString
    // layout: plain digits for exponents from -7 to 20, exponent notation outside.
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    if value < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        // serde_json escapes strings exactly as JSON.stringify does for well-formed strings.
        Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(members) => {
            let mut keys: Vec<&String> = members.keys().collect();
            keys.sort_by(|left, right| compare_keys(left, right));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_value(&members[key.as_str()], out);
            }
            out.push('}');
        }
    }
}

/// The canonical JSON text of a value.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// Lowercase hex SHA-256 of bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// SHA-256 of the canonical JSON of a value.
pub fn hash_canonical(value: &Value) -> String {
    sha256_hex(canonical_json(value).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn orders_keys_as_a_javascript_object_does() {
        let value = json!({ "b": 1, "10": 2, "a": 3, "2": 4, "01": 5, "4294967295": 6, "": 7 });
        // Expected text taken from Node: canonicalJson of the same object.
        assert_eq!(canonical_json(&value), r#"{"2":4,"10":2,"":7,"01":5,"4294967295":6,"a":3,"b":1}"#);
    }

    #[test]
    fn orders_strings_by_utf16_code_units() {
        // U+FF61 sorts after U+1F600 in UTF-8 bytes but before it in UTF-16 code units.
        assert_eq!(compare_code_units("\u{ff61}", "\u{1f600}"), Ordering::Greater);
        let value = json!({ "\u{1f600}": 1, "\u{ff61}": 2 });
        assert_eq!(canonical_json(&value), "{\"\u{1f600}\":1,\"\u{ff61}\":2}");
    }

    #[test]
    fn writes_numbers_as_json_stringify() {
        let cases = [
            (json!(0), "0"),
            (json!(-0.0), "0"),
            (json!(1.5), "1.5"),
            (json!(100.0), "100"),
            (json!(0.000001), "0.000001"),
            (json!(0.0000001), "1e-7"),
            (json!(1e21), "1e+21"),
            (json!(1.25e21), "1.25e+21"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(-2.5e-8), "-2.5e-8"),
            (json!(0.1), "0.1"),
            (json!(u64::MAX), "18446744073709551615"),
        ];
        for (value, expected) in cases {
            assert_eq!(canonical_json(&value), expected, "{value:?}");
        }
    }

    #[test]
    fn escapes_strings_and_nests() {
        let value = json!({ "s": "a\"b\\c\n\u{1}", "list": [null, true, { "z": 1, "y": [] }] });
        assert_eq!(canonical_json(&value), r#"{"list":[null,true,{"y":[],"z":1}],"s":"a\"b\\c\n\u0001"}"#);
    }

    #[test]
    fn hashes_canonical_text() {
        // sha256("{}") as Node computes it.
        assert_eq!(hash_canonical(&json!({})), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    }
}

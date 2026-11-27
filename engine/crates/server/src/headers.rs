//! Strict parsing of the HTTP header fields the transport makes security decisions on.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/http.ts` (`SINGLETON_SECURITY_HEADERS`,
//! `splitHttpHeader`, `decodeHttpParameterValue`, `parseMediaType`, `acceptsExactMediaTypes`,
//! `rejectAmbiguousSecurityHeaders`, `requireMcpJsonContentType`,
//! `requireIdentityContentEncoding`), commit 9b7dc80d.

use std::collections::{BTreeMap, BTreeSet};

/// Header names that may appear once at most; `host` must appear exactly once.
pub const SINGLETON_SECURITY_HEADERS: [&str; 11] = [
    "authorization",
    "content-encoding",
    "content-type",
    "host",
    "last-event-id",
    "mcp-method",
    "mcp-name",
    "mcp-protocol-version",
    "mcp-session-id",
    "origin",
    "x-forwarded-for",
];

fn is_token(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
}

fn is_qvalue(value: &str) -> bool {
    let (head, tail) = match value.split_once('.') {
        Some((head, tail)) => (head, Some(tail)),
        None => (value, None),
    };
    match (head, tail) {
        ("0", None) | ("1", None) => true,
        ("0", Some(tail)) => tail.len() <= 3 && tail.bytes().all(|byte| byte.is_ascii_digit()),
        ("1", Some(tail)) => tail.len() <= 3 && tail.bytes().all(|byte| byte == b'0'),
        _ => false,
    }
}

/// Splits a field value at unquoted separators. `None` for control bytes, an empty element, an
/// unterminated quote or a trailing escape.
pub fn split_http_header(value: &str, separator: char) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in value.char_indices() {
        if matches!(character, '\n' | '\r' | '\0') {
            return None;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            continue;
        }
        if !quoted && character == separator {
            let part = js_trim(&value[start..index]);
            if part.is_empty() {
                return None;
            }
            parts.push(part.to_owned());
            start = index + 1;
        }
    }
    if quoted || escaped {
        return None;
    }
    let last = js_trim(&value[start..]);
    if last.is_empty() {
        return None;
    }
    parts.push(last.to_owned());
    Some(parts)
}

/// `String.prototype.trim` for the characters a header value can hold.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn decode_parameter_value(raw: &str) -> Option<String> {
    if is_token(raw) {
        return Some(raw.to_owned());
    }
    let inner = raw.strip_prefix('"')?.strip_suffix('"')?;
    if raw.len() < 2 {
        return None;
    }
    let forbidden = |c: char| (c < '\u{20}' && c != '\t') || c == '\u{7f}';
    let mut value = String::new();
    let mut escaped = false;
    for character in inner.chars() {
        if escaped {
            if forbidden(character) {
                return None;
            }
            value.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' || forbidden(character) {
            return None;
        }
        value.push(character);
    }
    (!escaped).then_some(value)
}

/// A media type with its parameters, names lower-cased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaType {
    pub media_type: String,
    pub parameters: BTreeMap<String, String>,
    pub quoted_parameters: BTreeSet<String>,
}

/// Parses `type/subtype; name=value`. Duplicate or malformed parameters are refused.
pub fn parse_media_type(value: &str) -> Option<MediaType> {
    let segments = split_http_header(value, ';')?;
    let (raw_media_type, raw_parameters) = segments.split_first()?;
    let media_type = js_trim(raw_media_type);
    let (kind, subtype) = media_type.split_once('/')?;
    if kind.is_empty() || subtype.contains('/') || !is_token(kind) || !is_token(subtype) {
        return None;
    }
    let mut parameters = BTreeMap::new();
    let mut quoted_parameters = BTreeSet::new();
    for raw_parameter in raw_parameters {
        let equals = raw_parameter.find('=')?;
        if equals < 1 {
            return None;
        }
        let (raw_name, raw_value) = (&raw_parameter[..equals], &raw_parameter[equals + 1..]);
        if raw_name != js_trim(raw_name) || raw_value != js_trim(raw_value) {
            return None;
        }
        let name = raw_name.to_ascii_lowercase();
        let parameter_value = decode_parameter_value(raw_value)?;
        if !is_token(&name) || parameters.contains_key(&name) {
            return None;
        }
        if raw_value.starts_with('"') {
            quoted_parameters.insert(name.clone());
        }
        parameters.insert(name, parameter_value);
    }
    Some(MediaType { media_type: format!("{}/{}", kind.to_ascii_lowercase(), subtype.to_ascii_lowercase()), parameters, quoted_parameters })
}

/// True when `Accept` names each required type exactly, with a positive quality and no other
/// parameters. Wildcards do not count.
pub fn accepts_exact_media_types(value: Option<&str>, required: &[&str]) -> bool {
    let Some(entries) = value.and_then(|value| split_http_header(value, ',')) else { return false };
    let mut accepted = BTreeSet::new();
    for entry in entries {
        let Some(parsed) = parse_media_type(&entry) else { return false };
        let quality = parsed.parameters.get("q").map_or("1", String::as_str);
        if parsed.quoted_parameters.contains("q") || !is_qvalue(quality) {
            return false;
        }
        let has_representation_parameters = parsed.parameters.keys().any(|name| name != "q");
        if !has_representation_parameters && quality.parse::<f64>().is_ok_and(|q| q > 0.0) {
            accepted.insert(parsed.media_type);
        }
    }
    required.iter().all(|media_type| accepted.contains(*media_type))
}

/// UTF-8 `application/json`, with any well-formed parameters.
pub fn is_mcp_json_content_type(value: Option<&str>) -> bool {
    let Some(parsed) = value.and_then(parse_media_type) else { return false };
    parsed.media_type == "application/json" && parsed.parameters.get("charset").is_none_or(|charset| charset.eq_ignore_ascii_case("utf-8"))
}

/// No `Content-Encoding`, or exactly `identity`.
pub fn is_identity_content_encoding(value: Option<&str>) -> bool {
    value.is_none_or(|encoding| js_trim(encoding).eq_ignore_ascii_case("identity"))
}

/// True when a security-sensitive header repeats or `Host` is not present exactly once.
pub fn has_ambiguous_security_headers<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for name in names {
        let name = name.to_ascii_lowercase();
        if SINGLETON_SECURITY_HEADERS.contains(&name.as_str()) || name.starts_with("mcp-param-") {
            *counts.entry(name).or_default() += 1;
        }
    }
    counts.get("host").copied().unwrap_or(0) != 1 || counts.values().any(|count| *count > 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOTH: [&str; 2] = ["application/json", "text/event-stream"];

    #[test]
    fn accept_needs_each_exact_type_with_positive_quality() {
        assert!(accepts_exact_media_types(Some("application/json, text/event-stream"), &BOTH));
        assert!(accepts_exact_media_types(Some("Application/JSON;q=0.5, text/event-stream;q=1.000"), &BOTH));
        assert!(!accepts_exact_media_types(None, &BOTH));
        assert!(!accepts_exact_media_types(Some("*/*"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json;q=0, text/event-stream"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json;q=\"1\", text/event-stream"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json;q=1.5, text/event-stream"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json;charset=utf-8, text/event-stream"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json,, text/event-stream"), &BOTH));
        assert!(!accepts_exact_media_types(Some("application/json, text/event-stream\r\n"), &BOTH));
    }

    #[test]
    fn content_type_must_be_utf8_json_without_tricks() {
        assert!(is_mcp_json_content_type(Some("application/json")));
        assert!(is_mcp_json_content_type(Some("application/json; charset=UTF-8")));
        assert!(is_mcp_json_content_type(Some("application/json;charset=\"utf-8\"")));
        assert!(!is_mcp_json_content_type(None));
        assert!(!is_mcp_json_content_type(Some("application/json; charset=latin1")));
        assert!(!is_mcp_json_content_type(Some("application/vnd.api+json")));
        assert!(!is_mcp_json_content_type(Some("text/plain; x=\"application/json\"")));
        assert!(!is_mcp_json_content_type(Some("application/json; charset=utf-8; charset=utf-8")));
        assert!(!is_mcp_json_content_type(Some("application/json; charset =utf-8")));
        assert!(!is_mcp_json_content_type(Some("application/json; charset=\"utf-8")));
        assert!(!is_mcp_json_content_type(Some("application/json/x")));
    }

    #[test]
    fn content_encoding_must_be_identity() {
        assert!(is_identity_content_encoding(None));
        assert!(is_identity_content_encoding(Some(" Identity ")));
        assert!(!is_identity_content_encoding(Some("gzip")));
        assert!(!is_identity_content_encoding(Some("identity, gzip")));
    }

    #[test]
    fn duplicate_security_headers_and_missing_host_are_ambiguous() {
        assert!(!has_ambiguous_security_headers(["Host", "Accept", "Accept"]));
        assert!(has_ambiguous_security_headers(["Accept"]));
        assert!(has_ambiguous_security_headers(["Host", "host"]));
        assert!(has_ambiguous_security_headers(["Host", "Authorization", "authorization"]));
        assert!(has_ambiguous_security_headers(["Host", "Mcp-Param-X", "mcp-param-x"]));
        assert!(has_ambiguous_security_headers(["Host", "Origin", "Origin"]));
    }
}

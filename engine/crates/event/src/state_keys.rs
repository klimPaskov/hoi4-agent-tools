//! Identity of one stored event state value and the writes a read can observe.
//!
//! Adapted from `src/hoi4_agent_tools/event/state-keys.ts` at the port branch.

use serde_json::Value;

const SCOPE_KINDS: [&str; 8] = ["country", "state", "province", "unit_leader", "operative", "character", "global", "unknown"];

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn storage(value: &Value) -> Option<&str> {
    value.get("metadata").and_then(|m| m.get("storage")).and_then(Value::as_str)
}

/// Identity of one stored value: variables and arrays live per scope, saved scopes per storage.
pub fn state_key(value: &Value) -> String {
    let kind = field(value, "kind");
    let scope = if kind == "variable" || kind == "array" { format!(":{}", field(value, "scope")) } else { String::new() };
    let storage = if kind == "saved_scope" {
        match storage(value) {
            Some(known @ ("global" | "local")) => format!(":{known}"),
            _ => ":unknown".to_string(),
        }
    } else {
        String::new()
    };
    format!("{kind}:{}{scope}{storage}", field(value, "name"))
}

/// Keys of every write that a read of this value can observe.
pub fn compatible_producer_keys(value: &Value) -> Vec<String> {
    let kind = field(value, "kind");
    let name = field(value, "name");
    if kind == "event_target" {
        return vec![state_key(value), format!("global_event_target:{name}")];
    }
    if kind == "variable" || kind == "array" {
        let scope = field(value, "scope");
        let scopes: Vec<&str> = if scope == "unknown" { SCOPE_KINDS.to_vec() } else { vec![scope, "unknown"] };
        let mut keys: Vec<String> = scopes.iter().map(|scope| format!("{kind}:{name}:{scope}")).collect();
        if let Some(at) = name.find('^')
            && at > 0
        {
            let element = unscoped_name(&name[..at]);
            keys.extend(SCOPE_KINDS.iter().map(|scope| format!("array:{element}:{scope}")));
        }
        let bare = unscoped_name(name);
        if bare != name {
            keys.extend(SCOPE_KINDS.iter().map(|scope| format!("{kind}:{bare}:{scope}")));
        }
        let mut seen = std::collections::HashSet::new();
        keys.retain(|key| seen.insert(key.clone()));
        return keys;
    }
    if kind != "saved_scope" || matches!(storage(value), Some("global" | "local")) {
        return vec![state_key(value)];
    }
    vec![format!("saved_scope:{name}:global"), format!("saved_scope:{name}:local"), format!("saved_scope:{name}:unknown")]
}

/// The length of one scope prefix of `text`: `GER.`, `ROOT.`, `var:target.` or `event_target:x.`.
fn prefix_length(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    for word in ["ROOT.", "FROM.", "PREV.", "THIS.", "OWNER.", "CONTROLLER.", "CAPITAL."] {
        if text.starts_with(word) {
            return Some(word.len());
        }
    }
    if bytes.len() >= 4 && bytes[0].is_ascii_uppercase() && bytes[1..3].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) && bytes[3] == b'.' {
        return Some(4);
    }
    for head in ["var:", "event_target:"] {
        if let Some(rest) = text.strip_prefix(head) {
            let word = rest.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
            if word > 0 && rest.as_bytes().get(word) == Some(&b'.') {
                return Some(head.len() + word + 1);
            }
        }
    }
    None
}

/// `GER.value`, `ROOT.FROM.value` or `var:target.value` without its scope prefix.
fn unscoped_name(name: &str) -> &str {
    let mut at = 0;
    let mut last = 0;
    while let Some(length) = prefix_length(&name[at..]) {
        last = at;
        at += length;
    }
    if at == 0 {
        return name;
    }
    if at == name.len() { &name[last..] } else { &name[at..] }
}

pub fn has_unknown_saved_scope_storage(value: &Value) -> bool {
    field(value, "kind") == "saved_scope" && !matches!(storage(value), Some("global" | "local"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn variables_are_keyed_per_scope_and_read_across_unknown_scopes() {
        let read = json!({ "kind": "variable", "name": "GER.value", "scope": "country", "metadata": {} });
        let keys = compatible_producer_keys(&read);
        assert!(keys.contains(&"variable:GER.value:country".to_string()));
        assert!(keys.contains(&"variable:value:state".to_string()));
        let element = json!({ "kind": "variable", "name": "entries^num", "scope": "country", "metadata": {} });
        assert!(compatible_producer_keys(&element).contains(&"array:entries:global".to_string()));
    }

    #[test]
    fn scope_prefixes_strip_one_or_more_segments() {
        assert_eq!(unscoped_name("ROOT.FROM.value"), "value");
        assert_eq!(unscoped_name("var:target.value"), "value");
        assert_eq!(unscoped_name("plain"), "plain");
        assert_eq!(unscoped_name("GER."), "GER.");
    }

    #[test]
    fn saved_scopes_without_storage_read_every_storage() {
        let read = json!({ "kind": "saved_scope", "name": "x", "metadata": {} });
        assert_eq!(compatible_producer_keys(&read).len(), 3);
        assert!(has_unknown_saved_scope_storage(&read));
        let local = json!({ "kind": "saved_scope", "name": "x", "metadata": { "storage": "local" } });
        assert_eq!(compatible_producer_keys(&local), ["saved_scope:x:local"]);
    }
}

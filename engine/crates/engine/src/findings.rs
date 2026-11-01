//! Findings: what every check reports, with a fingerprint that survives line moves.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    /// Path relative to the layer root, with forward slashes.
    pub path: String,
    /// Name of the layer that owns the file.
    pub layer: String,
    pub line: u32,
    pub column: u32,
    /// Byte range in the file.
    pub start: u32,
    pub end: u32,
    /// The symbol, key or name the finding is about.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subject: Option<String>,
    /// The enclosing definition, such as `event:my.1` or `focus:GER_rearm`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub suggestion: Option<String>,
    /// Stable identity: code, path, context, subject and the ordinal among identical tuples.
    /// Line numbers are not part of it, so moving code does not make a baselined finding new.
    #[serde(default)]
    pub fingerprint: String,
}

impl Finding {
    pub fn new(code: &str, severity: Severity, message: impl Into<String>) -> Finding {
        Finding {
            code: code.into(),
            severity,
            message: message.into(),
            path: String::new(),
            layer: String::new(),
            line: 0,
            column: 0,
            start: 0,
            end: 0,
            subject: None,
            context: None,
            suggestion: None,
            fingerprint: String::new(),
        }
    }
}

/// Sorts findings deterministically and assigns fingerprints.
pub fn finalize(findings: &mut Vec<Finding>) {
    findings.sort_by(|a, b| (&a.path, a.start, &a.code, &a.subject).cmp(&(&b.path, b.start, &b.code, &b.subject)));
    findings.dedup_by(|a, b| a.path == b.path && a.start == b.start && a.code == b.code && a.subject == b.subject);
    let mut seen: HashMap<(String, String, Option<String>, Option<String>), usize> = HashMap::new();
    for f in findings.iter_mut() {
        let key = (f.code.clone(), f.path.to_ascii_lowercase(), f.context.clone(), f.subject.clone());
        let ordinal = seen.entry(key).or_default();
        let mut hasher = Sha256::new();
        for part in [f.code.as_str(), &f.path.to_ascii_lowercase(), f.context.as_deref().unwrap_or(""), f.subject.as_deref().unwrap_or("")] {
            hasher.update(part.as_bytes());
            hasher.update([0]);
        }
        hasher.update(ordinal.to_string().as_bytes());
        *ordinal += 1;
        f.fingerprint = hasher.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect();
    }
}

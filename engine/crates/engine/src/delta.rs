//! Finding delta: what an edit did to the findings.
//!
//! Provenance: adapted from Hagane Studio, `internal/hoi4/savediagnostics/diagnostics.go`
//! (hagane-works/hagane-studio at 1e831623ed162e1a64763c242c55b249376ba20c, GPL-3.0-only). The
//! copyright holder gave the maintainer written permission to use the project in any way,
//! including under this repository's Apache-2.0 licence (maintainer decision D-05). Kept: the
//! change classes and matching by a stable key. Changed: the key is the engine's fingerprint, and
//! "improved" and "worsened" compare severity because engine findings carry one subject each
//! instead of Hagane's affected-entity sets.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::findings::Finding;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    Introduced,
    Worsened,
    Changed,
    Improved,
    Unchanged,
    Resolved,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeltaEntry {
    pub change: Change,
    #[serde(flatten)]
    pub finding: Finding,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DeltaSummary {
    pub introduced: usize,
    pub worsened: usize,
    pub changed: usize,
    pub improved: usize,
    pub unchanged: usize,
    pub resolved: usize,
}

fn same_payload(a: &Finding, b: &Finding) -> bool {
    a.code == b.code && a.message == b.message && a.suggestion == b.suggestion && a.subject == b.subject && a.context == b.context
}

/// Compares two finding sets by fingerprint. Current findings come first in their own order,
/// followed by resolved ones.
pub fn compare(before: &[Finding], after: &[Finding]) -> Vec<DeltaEntry> {
    let mut previous: BTreeMap<&str, &Finding> = before.iter().map(|f| (f.fingerprint.as_str(), f)).collect();
    let mut out = Vec::with_capacity(after.len());
    for f in after {
        let change = match previous.remove(f.fingerprint.as_str()) {
            None => Change::Introduced,
            Some(prior) if f.severity > prior.severity => Change::Worsened,
            Some(prior) if f.severity < prior.severity => Change::Improved,
            Some(prior) if !same_payload(prior, f) => Change::Changed,
            Some(_) => Change::Unchanged,
        };
        out.push(DeltaEntry { change, finding: f.clone() });
    }
    for f in previous.into_values() {
        out.push(DeltaEntry { change: Change::Resolved, finding: f.clone() });
    }
    out
}

pub fn summarize(entries: &[DeltaEntry]) -> DeltaSummary {
    let mut s = DeltaSummary::default();
    for e in entries {
        match e.change {
            Change::Introduced => s.introduced += 1,
            Change::Worsened => s.worsened += 1,
            Change::Changed => s.changed += 1,
            Change::Improved => s.improved += 1,
            Change::Unchanged => s.unchanged += 1,
            Change::Resolved => s.resolved += 1,
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::findings::Severity;

    fn f(fingerprint: &str, severity: Severity, message: &str) -> Finding {
        let mut f = Finding::new("X", severity, message);
        f.fingerprint = fingerprint.into();
        f
    }

    #[test]
    fn classifies_every_change() {
        let before = vec![
            f("a", Severity::Error, "m"),
            f("b", Severity::Warning, "m"),
            f("c", Severity::Error, "m"),
            f("d", Severity::Error, "m"),
            f("e", Severity::Info, "m"),
        ];
        let after = vec![
            f("a", Severity::Error, "m"),
            f("b", Severity::Error, "m"),
            f("c", Severity::Warning, "m"),
            f("d", Severity::Error, "other"),
            f("n", Severity::Error, "m"),
        ];
        let delta = compare(&before, &after);
        let changes: Vec<_> = delta.iter().map(|d| (d.finding.fingerprint.as_str(), d.change)).collect();
        assert_eq!(
            changes,
            [
                ("a", Change::Unchanged),
                ("b", Change::Worsened),
                ("c", Change::Improved),
                ("d", Change::Changed),
                ("n", Change::Introduced),
                ("e", Change::Resolved),
            ]
        );
        let s = summarize(&delta);
        assert_eq!((s.introduced, s.worsened, s.changed, s.improved, s.unchanged, s.resolved), (1, 1, 1, 1, 1, 1));
    }
}

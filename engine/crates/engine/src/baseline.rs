//! Findings baseline (proposal P4): existing findings are recorded once, later checks fail only on
//! findings that are not in the baseline, and the baseline only shrinks.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::findings::{Finding, Severity};

pub const SCHEMA: &str = "hoi4-engine-baseline/1";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaselineEntry {
    pub fingerprint: String,
    pub code: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Baseline {
    pub schema: String,
    pub findings: Vec<BaselineEntry>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Comparison {
    /// Entries in the baseline file.
    pub baseline_count: usize,
    /// Current findings that the baseline covers.
    pub baselined: usize,
    /// Current findings the baseline does not cover. Only these can fail a check.
    pub new: usize,
    /// Baseline entries with no current finding. `baseline update` removes them.
    pub fixed: usize,
    pub new_by_code: BTreeMap<String, usize>,
    pub fixed_entries: Vec<BaselineEntry>,
}

impl Baseline {
    pub fn from_findings(findings: &[Finding]) -> Baseline {
        let mut entries: Vec<BaselineEntry> = findings
            .iter()
            .filter(|f| f.severity >= Severity::Warning)
            .map(|f| BaselineEntry { fingerprint: f.fingerprint.clone(), code: f.code.clone(), path: f.path.clone(), subject: f.subject.clone() })
            .collect();
        entries.sort_by(|a, b| (&a.path, &a.code, &a.fingerprint).cmp(&(&b.path, &b.code, &b.fingerprint)));
        entries.dedup_by(|a, b| a.fingerprint == b.fingerprint);
        Baseline { schema: SCHEMA.into(), findings: entries }
    }

    pub fn parse(text: &str) -> Result<Baseline, String> {
        let baseline: Baseline = serde_json::from_str(text).map_err(|e| format!("baseline is not valid JSON: {e}"))?;
        if baseline.schema != SCHEMA {
            return Err(format!("baseline schema `{}` is not `{SCHEMA}`", baseline.schema));
        }
        Ok(baseline)
    }

    pub fn to_json(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }

    pub fn fingerprints(&self) -> BTreeSet<&str> {
        self.findings.iter().map(|e| e.fingerprint.as_str()).collect()
    }

    pub fn compare(&self, findings: &[Finding]) -> Comparison {
        let known = self.fingerprints();
        let current: BTreeSet<&str> = findings.iter().map(|f| f.fingerprint.as_str()).collect();
        let mut c = Comparison { baseline_count: self.findings.len(), ..Comparison::default() };
        for f in findings.iter().filter(|f| f.severity >= Severity::Warning) {
            if known.contains(f.fingerprint.as_str()) {
                c.baselined += 1;
            } else {
                c.new += 1;
                *c.new_by_code.entry(f.code.clone()).or_default() += 1;
            }
        }
        c.fixed_entries = self.findings.iter().filter(|e| !current.contains(e.fingerprint.as_str())).cloned().collect();
        c.fixed = c.fixed_entries.len();
        c
    }

    /// Removes entries that no longer match a finding. Never adds entries.
    pub fn shrink(&self, findings: &[Finding]) -> Baseline {
        let current: BTreeSet<&str> = findings.iter().map(|f| f.fingerprint.as_str()).collect();
        Baseline { schema: SCHEMA.into(), findings: self.findings.iter().filter(|e| current.contains(e.fingerprint.as_str())).cloned().collect() }
    }

    pub fn contains(&self, finding: &Finding) -> bool {
        self.findings.iter().any(|e| e.fingerprint == finding.fingerprint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::findings::finalize;

    fn finding(code: &str, path: &str, subject: &str, start: u32) -> Finding {
        let mut f = Finding::new(code, Severity::Error, "m");
        f.path = path.into();
        f.subject = Some(subject.into());
        f.start = start;
        f
    }

    #[test]
    fn only_new_findings_count_and_the_baseline_shrinks() {
        let mut before = vec![finding("A", "x.txt", "one", 10), finding("A", "x.txt", "two", 20), finding("B", "y.txt", "three", 5)];
        finalize(&mut before);
        let baseline = Baseline::from_findings(&before);
        assert_eq!(baseline.findings.len(), 3);

        // `one` is fixed, `two` moved to another line, `four` is new.
        let mut after = vec![finding("A", "x.txt", "two", 99), finding("B", "y.txt", "three", 5), finding("A", "x.txt", "four", 30)];
        finalize(&mut after);
        let c = baseline.compare(&after);
        assert_eq!((c.baseline_count, c.baselined, c.new, c.fixed), (3, 2, 1, 1));
        assert_eq!(c.new_by_code.get("A"), Some(&1));

        let shrunk = baseline.shrink(&after);
        assert_eq!(shrunk.findings.len(), 2, "fixed entries leave, new findings are not added");
        let again = shrunk.compare(&after);
        assert_eq!((again.baselined, again.new, again.fixed), (2, 1, 0));
    }

    #[test]
    fn rejects_other_schemas() {
        assert!(Baseline::parse("{\"schema\":\"other\",\"findings\":[]}").is_err());
        assert!(Baseline::parse("not json").is_err());
        let b = Baseline::parse(&Baseline::from_findings(&[]).to_json()).unwrap();
        assert!(b.findings.is_empty());
    }
}

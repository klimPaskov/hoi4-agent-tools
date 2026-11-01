//! The JSON report of a check, shared by the command-line interface and library callers.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::analysis::{Analysis, Coverage, Stats};
use crate::baseline::{Baseline, Comparison};
use crate::findings::{Finding, Severity};
use crate::overrides::OverrideEntry;
use crate::repair::RepairPlan;
use crate::workspace::Layer;

pub const SCHEMA: &str = "hoi4-engine-report/1";

#[derive(Serialize)]
pub struct ReportFinding<'a> {
    #[serde(flatten)]
    pub finding: &'a Finding,
    /// `new` or `baselined`. Without a baseline every finding is new.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair: Option<RepairPlan>,
}

#[derive(Serialize, Default)]
pub struct Summary {
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
    pub by_code: BTreeMap<String, usize>,
}

#[derive(Serialize)]
pub struct Inputs<'a> {
    pub layers: &'a [Layer],
    pub game_version: Option<&'a str>,
    pub documentation: &'a [crate::vocab::SourceDoc],
    pub known_dlc_names: usize,
}

#[derive(Serialize)]
pub struct Report<'a> {
    pub schema: &'static str,
    pub engine_version: &'static str,
    /// `fail` when a new finding reaches the failure severity, `incomplete` when anything could
    /// not be checked (unknown references, unmodelled folders, no game), `pass` otherwise.
    pub verdict: &'static str,
    pub inputs: Inputs<'a>,
    pub summary: Summary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<Comparison>,
    pub coverage: &'a Coverage,
    pub stats: &'a Stats,
    pub overrides: &'a [OverrideEntry],
    pub findings: Vec<ReportFinding<'a>>,
}

pub fn build<'a>(analysis: &'a Analysis, baseline: Option<&Baseline>, fail_on: Severity, repairs: &dyn Fn(&Finding) -> Option<RepairPlan>) -> Report<'a> {
    let mut summary = Summary::default();
    for f in &analysis.findings {
        match f.severity {
            Severity::Error => summary.errors += 1,
            Severity::Warning => summary.warnings += 1,
            Severity::Info => summary.infos += 1,
        }
        *summary.by_code.entry(f.code.clone()).or_default() += 1;
    }
    let findings: Vec<ReportFinding> = analysis
        .findings
        .iter()
        .map(|f| ReportFinding { finding: f, status: if baseline.is_some_and(|b| b.contains(f)) { "baselined" } else { "new" }, repair: repairs(f) })
        .collect();
    let failing = findings.iter().any(|f| f.status == "new" && f.finding.severity >= fail_on);
    let verdict = if failing {
        "fail"
    } else if analysis.verdict() == "pass" {
        "pass"
    } else {
        "incomplete"
    };
    Report {
        schema: SCHEMA,
        engine_version: crate::VERSION,
        verdict,
        inputs: Inputs {
            layers: &analysis.workspace.layers,
            game_version: analysis.vocab.game_version.as_deref(),
            documentation: &analysis.vocab.sources,
            known_dlc_names: analysis.dlc_names.len(),
        },
        summary,
        baseline: baseline.map(|b| b.compare(&analysis.findings)),
        coverage: &analysis.coverage,
        stats: &analysis.stats,
        overrides: &analysis.overrides,
        findings,
    }
}

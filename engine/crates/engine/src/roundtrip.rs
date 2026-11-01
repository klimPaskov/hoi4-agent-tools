//! Byte-identical round trip of every source file under a root: parse, rebuild from the tree,
//! compare with the input, and check that every token belongs to exactly one node.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use hoi4_syntax::{Document, Grammar, LocFile, grammar_for};
use rayon::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::workspace::{CONTENT_FOLDERS, walk_sources};

#[derive(Debug, Default, Serialize)]
pub struct RoundTripReport {
    pub root: String,
    pub files: usize,
    pub script_files: usize,
    pub localisation_files: usize,
    pub bytes: u64,
    pub identical: usize,
    /// Files whose rebuilt bytes differ from the input. Must be empty.
    pub mismatches: Vec<String>,
    /// Files whose tree fails the ownership check. Must be empty.
    pub structure_errors: Vec<String>,
    pub unreadable: Vec<String>,
    /// Files that parse with syntax diagnostics; they still round-trip.
    pub files_with_diagnostics: usize,
    pub diagnostics_by_code: BTreeMap<String, usize>,
    /// Up to 20 example diagnostics as `path:line:column code`.
    pub diagnostic_examples: Vec<String>,
    /// SHA-256 over every file's relative path and content hash, in path order.
    pub input_sha256: String,
    pub elapsed_ms: u128,
}

struct FileResult {
    relative: String,
    bytes: u64,
    grammar: Grammar,
    identical: bool,
    structure_error: Option<String>,
    unreadable: bool,
    diagnostics: Vec<String>,
    codes: Vec<&'static str>,
    sha256: [u8; 32],
}

pub fn round_trip(root: &Path) -> RoundTripReport {
    let started = Instant::now();
    let mut files = walk_sources(root, Some(CONTENT_FOLDERS));
    let descriptor = root.join("descriptor.mod");
    if descriptor.is_file() {
        files.push(("descriptor.mod".into(), descriptor));
    }
    let results: Vec<FileResult> = files
        .par_iter()
        .filter_map(|(relative, absolute)| {
            let grammar = grammar_for(relative)?;
            let Ok(bytes) = fs::read(absolute) else {
                return Some(FileResult {
                    relative: relative.clone(),
                    bytes: 0,
                    grammar,
                    identical: false,
                    structure_error: None,
                    unreadable: true,
                    diagnostics: Vec::new(),
                    codes: Vec::new(),
                    sha256: [0; 32],
                });
            };
            let sha256: [u8; 32] = Sha256::digest(&bytes).into();
            let len = bytes.len() as u64;
            let (identical, structure_error, diagnostics, codes) = match grammar {
                Grammar::Script => {
                    let doc = Document::parse(bytes.clone());
                    let identical = doc.write_tree() == bytes;
                    let structure_error = doc.verify_structure().err();
                    let diagnostics = doc
                        .diagnostics
                        .iter()
                        .map(|d| {
                            let (line, column) = doc.position(d.start);
                            format!("{relative}:{line}:{column} {}", d.code)
                        })
                        .collect();
                    let codes = doc.diagnostics.iter().map(|d| d.code).collect();
                    (identical, structure_error, diagnostics, codes)
                }
                Grammar::Localisation => {
                    let file = LocFile::parse(bytes.clone());
                    let identical = file.write() == bytes;
                    let diagnostics = file.diagnostics.iter().map(|d| format!("{relative} {}", d.code)).collect();
                    let codes = file.diagnostics.iter().map(|d| d.code).collect();
                    (identical, None, diagnostics, codes)
                }
            };
            Some(FileResult { relative: relative.clone(), bytes: len, grammar, identical, structure_error, unreadable: false, diagnostics, codes, sha256 })
        })
        .collect();

    let mut report = RoundTripReport { root: root.display().to_string(), ..RoundTripReport::default() };
    let mut digest = Sha256::new();
    for r in &results {
        report.files += 1;
        report.bytes += r.bytes;
        match r.grammar {
            Grammar::Script => report.script_files += 1,
            Grammar::Localisation => report.localisation_files += 1,
        }
        if r.unreadable {
            report.unreadable.push(r.relative.clone());
            continue;
        }
        digest.update(r.relative.as_bytes());
        digest.update([0]);
        digest.update(r.sha256);
        if r.identical {
            report.identical += 1;
        } else {
            report.mismatches.push(r.relative.clone());
        }
        if let Some(err) = &r.structure_error {
            report.structure_errors.push(format!("{}: {err}", r.relative));
        }
        if !r.codes.is_empty() {
            report.files_with_diagnostics += 1;
        }
        for code in &r.codes {
            *report.diagnostics_by_code.entry((*code).to_string()).or_default() += 1;
        }
        for d in &r.diagnostics {
            if report.diagnostic_examples.len() < 20 {
                report.diagnostic_examples.push(d.clone());
            }
        }
    }
    report.input_sha256 = digest.finalize().iter().map(|b| format!("{b:02x}")).collect();
    report.elapsed_ms = started.elapsed().as_millis();
    report
}

impl RoundTripReport {
    pub fn passed(&self) -> bool {
        self.mismatches.is_empty() && self.structure_errors.is_empty() && self.unreadable.is_empty() && self.identical == self.files
    }
}

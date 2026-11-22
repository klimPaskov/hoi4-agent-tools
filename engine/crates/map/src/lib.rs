//! Map model, validation, stated baseline, operations, writer and render (packets P13a, P13b, P13c).
//!
//! Ported from `src/hoi4_agent_tools/map/`; each adapted file names its source in its header and
//! in this crate's `PROVENANCE.md`. Module ownership (ADR 0091 packet plan):
//!
//! - P13a: [`model`], [`parse`], [`validate`], [`baseline`] and this file.
//! - P13b: [`ops`] and [`write`].
//! - P13c: [`render`] and [`quality`].
//!
//! Engine operations (P13a):
//!
//! - `map.index`: the map index of the files in the request, as counts and records.
//! - `map.validate`: the full validation of those files, with the stated-baseline fingerprint.
//!
//! Both take the scanned files from the caller: `files` lists each file's display path, relative
//! path, root kind, load order, size, SHA-256 and `length`, and the payload holds their bytes in
//! that order. The engine reads nothing from disk, so the caller's scan and its root checks stay
//! the only way a file reaches the map.

use hoi4_core::files::{RootKind, ScannedFile};
use hoi4_core::ops::{OpContext, OpResponse, Registry};
use serde::Deserialize;
use serde_json::{Value, json};

pub mod baseline;
pub mod model;
pub mod ops;
pub mod parse;
pub mod quality;
pub mod render;
pub mod validate;
pub mod write;

use model::{MapError, MapIndex, SourceRoots};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    display_path: String,
    relative_path: String,
    root_kind: RootKind,
    load_order: u32,
    #[serde(default)]
    size: Option<u64>,
    sha256: String,
    length: usize,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BaselineRequest {
    #[serde(default)]
    state_ids: Vec<i64>,
    /// Bytes of the baseline's province bitmap, after the files in the payload.
    #[serde(default)]
    province_bitmap_length: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OptionsRequest {
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    expected_changed_bounds: Option<validate::Bounds>,
    #[serde(default)]
    baseline: Option<BaselineRequest>,
    #[serde(default)]
    include_baseline_diagnostics: bool,
    #[serde(default)]
    diagnostic_limit: Option<usize>,
    #[serde(default)]
    edge_mode: Option<validate::EdgeMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapRequest {
    files: Vec<FileEntry>,
    #[serde(default)]
    source_roots: Option<SourceRoots>,
    #[serde(default)]
    tool_version: Option<String>,
    #[serde(default)]
    options: Option<OptionsRequest>,
    /// `crossings`: only the crossing checks, every finding as reported (`validateCrossings`).
    #[serde(default)]
    only: Option<String>,
}

fn invalid(message: impl Into<String>) -> MapError {
    MapError::plain("MAP_ENGINE_REQUEST_INVALID", message)
}

/// The files of a request, with their bytes cut from the payload; returns the unread rest.
fn files_of(request: &MapRequest, payload: &[u8]) -> Result<(Vec<ScannedFile>, usize), MapError> {
    let mut files = Vec::with_capacity(request.files.len());
    let mut at = 0usize;
    for entry in &request.files {
        let end = at
            .checked_add(entry.length)
            .filter(|&end| end <= payload.len())
            .ok_or_else(|| invalid(format!("the payload ends inside {}", entry.display_path)))?;
        files.push(ScannedFile {
            absolute_path: String::new(),
            display_path: entry.display_path.clone(),
            relative_path: entry.relative_path.clone(),
            root_kind: entry.root_kind,
            load_order: entry.load_order,
            size: entry.size.unwrap_or(entry.length as u64),
            modified_ms: 0,
            sha256: entry.sha256.clone(),
            bytes: payload[at..end].to_vec(),
            shadowed_by: None,
        });
        at = end;
    }
    Ok((files, at))
}

fn parse_request(request: &Value) -> Result<MapRequest, MapError> {
    let mut request = request.clone();
    if let Some(fields) = request.as_object_mut() {
        for framing in ["id", "op", "payload"] {
            fields.remove(framing);
        }
    }
    serde_json::from_value(request).map_err(|e| invalid(format!("invalid map request: {e}")))
}

/// `map.index`.
pub fn index_op(request: &Value, payload: &[u8]) -> Result<Value, MapError> {
    let request = parse_request(request)?;
    let (files, _) = files_of(&request, payload)?;
    let index = MapIndex::build(files, request.source_roots.unwrap_or_default())?;
    let mut summary = index.summary();
    if let Some(version) = &request.tool_version {
        summary["baselineFingerprint"] = json!(baseline::index_fingerprint(&index, version));
    }
    Ok(summary)
}

/// `map.validate`.
pub fn validate_op(request: &Value, payload: &[u8]) -> Result<Value, MapError> {
    let request = parse_request(request)?;
    let (files, used) = files_of(&request, payload)?;
    let options_request = request.options.unwrap_or_default();
    let baseline = match options_request.baseline {
        None => None,
        Some(b) => {
            let province_bitmap = match b.province_bitmap_length {
                None => None,
                Some(length) => {
                    let bytes = used
                        .checked_add(length)
                        .filter(|&end| end <= payload.len())
                        .map(|end| &payload[used..end])
                        .ok_or_else(|| invalid("the payload ends inside the baseline bitmap"))?;
                    parse::bmp::BmpImage::decode(bytes).ok()
                }
            };
            Some(validate::Baseline { state_ids: b.state_ids.into_iter().collect(), province_bitmap })
        }
    };
    let options = validate::Options {
        operation_id: options_request.operation_id,
        expected_changed_bounds: options_request.expected_changed_bounds,
        baseline,
        include_baseline_diagnostics: options_request.include_baseline_diagnostics,
        diagnostic_limit: options_request.diagnostic_limit,
        edge_mode: options_request.edge_mode,
    };
    let index = MapIndex::build(files, request.source_roots.unwrap_or_default())?;
    match request.only.as_deref() {
        None => {}
        Some("crossings") => return Ok(json!({ "diagnostics": validate::crossing_findings(&index) })),
        Some(other) => return Err(invalid(format!("unknown map validation part {other}"))),
    }
    let result = validate::validate(&index, &options);
    let mut answer = json!({ "passed": result.passed, "diagnostics": result.diagnostics, "checks": result.checks });
    if let Some(version) = &request.tool_version {
        answer["baselineFingerprint"] = json!(baseline::index_fingerprint(&index, version));
    }
    Ok(answer)
}

fn respond(result: Result<Value, MapError>) -> OpResponse {
    match result {
        Ok(value) => OpResponse::ok(value),
        Err(error) => OpResponse { result: Err(error.to_json()), payload: Vec::new() },
    }
}

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    registry.add_fn("map.index", |_: &OpContext, request, payload| respond(index_op(request, payload)));
    registry.add_fn("map.validate", |_: &OpContext, request, payload| respond(validate_op(request, payload)));
}

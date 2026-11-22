//! Technology and doctrine analyzers (packet P5).
//!
//! Ported from `src/hoi4_agent_tools/technology/` (the read side); each adapted file names its
//! source in its header and in this crate's `PROVENANCE.md`.
//!
//! Operations (ADR 0091):
//!
//! * `tech.analyze` reads the technology sources of a scan and keeps their fragments in the
//!   engine; it answers a session id and the sprite and localisation names the graph will ask for.
//! * `tech.graph` assembles the graph of a session from the caller's lookups and keeps it by
//!   revision for the queries.
//! * `tech.query` answers one read-only query of a kept graph.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use hoi4_core::files::ScannedFile;
use hoi4_core::ops::{OpResponse, Registry};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

pub mod graph;
pub mod pos;
pub mod queries;
pub mod source_analysis;

use queries::Refusal;

const KEPT_SESSIONS: usize = 2;
const KEPT_GRAPHS: usize = 2;

struct Session {
    id: String,
    files: Vec<ScannedFile>,
    fragments: Arc<Vec<Value>>,
}

#[derive(Default)]
struct Kept {
    sessions: Vec<Session>,
    graphs: Vec<(String, Arc<Value>)>,
    counter: u64,
}

fn kept() -> &'static Mutex<Kept> {
    static KEPT: Mutex<Kept> = Mutex::new(Kept { sessions: Vec::new(), graphs: Vec::new(), counter: 0 });
    &KEPT
}

fn strip_framing(request: &Value) -> Value {
    let mut fields = request.clone();
    if let Some(map) = fields.as_object_mut() {
        for framing in ["id", "op", "payload"] {
            map.remove(framing);
        }
    }
    fields
}

fn parse<T: for<'de> Deserialize<'de>>(op: &str, request: &Value) -> Result<T, OpResponse> {
    serde_json::from_value(strip_framing(request)).map_err(|e| OpResponse::error("invalid_request", format!("invalid {op} request: {e}")))
}

fn refusal(refusal: Refusal) -> OpResponse {
    let mut error = json!({ "code": refusal.code, "message": refusal.message });
    if !refusal.details.is_null() {
        error["details"] = refusal.details;
    }
    OpResponse { result: Err(error), payload: Vec::new() }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnalyzeRequest {
    files: Vec<ScannedFile>,
    #[serde(default)]
    helper_ids: Vec<String>,
}

/// `tech.analyze`: the fragment of each technology source file, kept under a session id.
fn analyze(request: &Value) -> OpResponse {
    let request: AnalyzeRequest = match parse("tech.analyze", request) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let context = source_analysis::Context { helper_ids: request.helper_ids.into_iter().collect::<HashSet<_>>() };
    let selected = source_analysis::source_files(&request.files);
    let fragments: Result<Vec<Value>, String> = selected
        .par_iter()
        .map(|file| match std::fs::read(&file.absolute_path) {
            Ok(bytes) if hoi4_core::canonical::sha256_hex(&bytes) == file.sha256 => Ok(source_analysis::analyze_source(file, &bytes, &context)),
            Ok(_) => Err(format!("{} changed since it was scanned", file.display_path)),
            Err(e) => Err(format!("cannot read {}: {e}", file.display_path)),
        })
        .collect();
    let fragments = match fragments {
        Ok(f) => f,
        Err(message) => return OpResponse::error("invalid_request", message),
    };
    let mut sprites: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for fragment in &fragments {
        for t in fragment["technologies"].as_array().into_iter().flatten() {
            sprites.extend(t["iconSprite"].as_str().map(str::to_string));
            if let Some(id) = t["id"].as_str() {
                names.push(id.to_string());
                names.push(format!("{id}_desc"));
            }
        }
        for d in fragment["doctrineDefinitions"].as_array().into_iter().flatten() {
            sprites.extend(d["iconSprite"].as_str().map(str::to_string));
        }
        for f in fragment["folders"].as_array().into_iter().flatten() {
            if let Some(id) = f["id"].as_str() {
                names.push(id.to_string());
                names.push(format!("{id}_desc"));
            }
        }
    }
    for list in [&mut sprites, &mut names] {
        list.sort_by(|a, b| hoi4_core::canonical::compare_code_units(a, b));
        list.dedup();
    }
    let mut guard = kept().lock().unwrap_or_else(|e| e.into_inner());
    guard.counter += 1;
    let id = format!("tech-session-{}", guard.counter);
    guard.sessions.push(Session { id: id.clone(), files: request.files, fragments: Arc::new(fragments) });
    while guard.sessions.len() > KEPT_SESSIONS {
        guard.sessions.remove(0);
    }
    OpResponse::ok(json!({ "session": id, "wants": { "sprites": sprites, "localisation": names } }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScanInput {
    workspace_id: String,
    workspace_identity: String,
    revision: String,
    complete: bool,
    skipped_source_count: u64,
    #[serde(default)]
    skipped_sources: Value,
    #[serde(default)]
    diagnostics: Vec<Value>,
    #[serde(default)]
    asset_files: Vec<ScannedFile>,
    #[serde(default)]
    analysis_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LookupInput {
    /// Sprite name to its defining file and texture.
    #[serde(default)]
    sprites: HashMap<String, (String, Option<String>)>,
    #[serde(default)]
    skipped_sprite_source: bool,
    #[serde(default)]
    localisation: HashMap<String, String>,
    #[serde(default)]
    skipped_localisation_source: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphRequest {
    session: String,
    scan: ScanInput,
    lookups: LookupInput,
}

/// `tech.graph`: the graph snapshot of an analysed scan.
fn graph_op(request: &Value) -> OpResponse {
    let request: GraphRequest = match parse("tech.graph", request) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let (files, fragments) = {
        let guard = kept().lock().unwrap_or_else(|e| e.into_inner());
        match guard.sessions.iter().find(|s| s.id == request.session) {
            Some(s) => (s.files.clone(), s.fragments.clone()),
            None => return OpResponse::error("TECH_SESSION_EXPIRED", "The technology analysis session is no longer held by the engine"),
        }
    };
    let scan = graph::Scan {
        workspace_id: request.scan.workspace_id,
        workspace_identity: request.scan.workspace_identity,
        revision: request.scan.revision,
        complete: request.scan.complete,
        skipped_source_count: request.scan.skipped_source_count,
        skipped_sources: if request.scan.skipped_sources.is_null() { json!([]) } else { request.scan.skipped_sources },
        diagnostics: request.scan.diagnostics,
        files,
        asset_files: request.scan.asset_files,
        analysis_mode: request.scan.analysis_mode,
    };
    let lookups = graph::Lookups {
        sprites: request.lookups.sprites,
        skipped_sprite_source: request.lookups.skipped_sprite_source,
        localisation: request.lookups.localisation,
        skipped_localisation_source: request.lookups.skipped_localisation_source,
    };
    match graph::build_graph(&fragments, &scan, &lookups) {
        Ok(graph) => {
            let revision = graph["revision"].as_str().unwrap_or("").to_string();
            keep_graph(revision, graph.clone());
            OpResponse::ok(json!({ "graph": graph }))
        }
        Err(r) => refusal(r),
    }
}

fn keep_graph(revision: String, graph: Value) {
    let mut guard = kept().lock().unwrap_or_else(|e| e.into_inner());
    guard.graphs.retain(|(r, _)| *r != revision);
    guard.graphs.push((revision, Arc::new(graph)));
    while guard.graphs.len() > KEPT_GRAPHS {
        guard.graphs.remove(0);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryRequest {
    revision: String,
    mode: String,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    technology_id: Option<String>,
    #[serde(default)]
    category_id: Option<String>,
    #[serde(default)]
    target_kind: Option<String>,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    max_depth: Option<i64>,
    #[serde(default)]
    max_nodes: Option<i64>,
    #[serde(default)]
    include_sub_technologies: bool,
    #[serde(default)]
    classifications: Option<Vec<String>>,
    #[serde(default)]
    codes: Option<Vec<String>>,
    #[serde(default)]
    impact: Option<ImpactRequest>,
    #[serde(default)]
    full_graph_record_limit: Option<usize>,
    /// The graph itself arrives in the payload, because the engine no longer holds it.
    #[serde(default)]
    graph_in_payload: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImpactRequest {
    kind: String,
    id: String,
    operation: String,
    #[serde(default)]
    replacement_id: Option<String>,
}

/// `tech.query`: one read-only query of a kept graph; `explain` also answers its inline summary.
fn query(request: &Value, payload: &[u8]) -> OpResponse {
    let request: QueryRequest = match parse("tech.query", request) {
        Ok(r) => r,
        Err(e) => return e,
    };
    if request.graph_in_payload {
        match serde_json::from_slice::<Value>(payload) {
            Ok(graph) if graph["revision"].as_str() == Some(request.revision.as_str()) => keep_graph(request.revision.clone(), graph),
            _ => return OpResponse::error("invalid_request", "the payload is not the technology graph of the requested revision"),
        }
    }
    let graph = {
        let guard = kept().lock().unwrap_or_else(|e| e.into_inner());
        guard.graphs.iter().find(|(r, _)| *r == request.revision).map(|(_, g)| g.clone())
    };
    let Some(graph) = graph else {
        return OpResponse::error("TECH_GRAPH_EXPIRED", "The technology graph is no longer held by the engine");
    };
    let graph: &Value = &graph;
    let answer: Result<Value, Refusal> = match request.mode.as_str() {
        "scan" => Ok(queries::scan_report(graph, request.full_graph_record_limit)),
        "folders" => queries::discover_folders(graph, request.folder_id.as_deref()),
        "trace" => match request.technology_id.as_deref() {
            Some(id) => queries::trace(
                graph,
                &queries::TraceInput {
                    technology_id: id,
                    direction: request.direction.as_deref().unwrap_or("both"),
                    max_depth: request.max_depth.unwrap_or(32),
                    max_nodes: request.max_nodes.unwrap_or(2_000),
                    include_sub_technologies: request.include_sub_technologies,
                },
            ),
            None => return OpResponse::error("invalid_request", "mode trace requires technologyId"),
        },
        "explain" => match request.technology_id.as_deref() {
            Some(id) => match queries::explain(graph, id) {
                Ok(report) => {
                    let summary = queries::explain_summary(&report);
                    return OpResponse::ok(json!({ "report": report, "summary": summary }));
                }
                Err(r) => Err(r),
            },
            None => return OpResponse::error("invalid_request", "mode explain requires technologyId"),
        },
        "unlocks" => queries::inspect_unlocks(graph, request.technology_id.as_deref(), request.target_kind.as_deref(), request.target_id.as_deref()),
        "bonus_coverage" => queries::bonus_coverage(graph, request.category_id.as_deref(), request.technology_id.as_deref()),
        "lint" => Ok(queries::lint(
            graph,
            &queries::LintFilter {
                classifications: request.classifications.as_deref(),
                codes: request.codes.as_deref(),
                folder_id: request.folder_id.as_deref(),
                technology_id: request.technology_id.as_deref(),
            },
        )),
        "impact" => match &request.impact {
            Some(i) => queries::impact(graph, &queries::ImpactInput { kind: &i.kind, id: &i.id, operation: &i.operation, replacement_id: i.replacement_id.as_deref() }),
            None => return OpResponse::error("invalid_request", "mode impact requires impact"),
        },
        other => return OpResponse::error("invalid_request", format!("unknown technology query mode {other}")),
    };
    match answer {
        Ok(report) => OpResponse::ok(json!({ "report": report })),
        Err(r) => refusal(r),
    }
}

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    registry.add_fn("tech.analyze", |_, request, _| analyze(request));
    registry.add_fn("tech.graph", |_, request, _| graph_op(request));
    registry.add_fn("tech.query", |_, request, payload| query(request, payload));
}

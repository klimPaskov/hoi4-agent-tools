//! Engine operations over an event graph snapshot sent in the request body.
//!
//! New in the port; the TypeScript service still scans and builds the graph (this slice), and
//! these operations answer the graph questions it used to compute in `algorithms.ts`.
//!
//! - `event.trace`: `{ graph, startNodeIds, boundary }` → the trace.
//! - `event.path`: `{ graph, from, to, options }` → `{ path }` with `null` when none exists.
//! - `event.components`: `{ graph, expandHelpers?, selectedNodeIds? }` → the components.
//! - `event.reachable`: `{ graph, startNodeIds, direction, expandHelpers? }` → node ids.

use hoi4_core::ops::{OpResponse, Registry};
use serde::Deserialize;
use std::borrow::Cow;
use std::time::Instant;

use hoi4_core::canonical::sha256_hex;
use rayon::prelude::*;
use serde_json::{Map, Value, json};

use crate::algorithms::{self, Boundary, Direction, PathOptions};
use crate::graph::Graph;
use crate::graph_build;
use crate::inspect;
use crate::source_analysis;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceRequest {
    graph: Graph,
    start_node_ids: Vec<String>,
    boundary: Boundary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathRequest {
    graph: Graph,
    from: Vec<String>,
    to: Vec<String>,
    options: PathOptionsWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathOptionsWire {
    expand_helpers: bool,
    max_depth: u64,
    max_nodes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentsRequest {
    graph: Graph,
    #[serde(default)]
    expand_helpers: bool,
    #[serde(default)]
    selected_node_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReachableRequest {
    graph: Graph,
    start_node_ids: Vec<String>,
    direction: Direction,
    #[serde(default)]
    expand_helpers: bool,
}

fn parse<T: for<'de> Deserialize<'de>>(request: &Value) -> Result<T, OpResponse> {
    T::deserialize(request).map_err(|error| OpResponse::error("invalid_request", error.to_string()))
}

fn blocked(error: algorithms::WorkBlocked) -> OpResponse {
    OpResponse::error("EVENT_ANALYSIS_WORK_BLOCKED", format!("Event-chain analysis exceeds the fixed work ceiling ({} spent in {})", error.spent, error.label))
}

pub fn register(registry: &mut Registry) {
    register_fragments(registry);
    register_graph(registry);
    register_inspect(registry);
    registry.add_fn("event.trace", |_, request, _| match parse::<TraceRequest>(request) {
        Ok(r) => match serde_json::to_value(algorithms::trace(&r.graph, &r.start_node_ids, &r.boundary)) {
            Ok(value) => OpResponse::ok(value),
            Err(error) => OpResponse::error("internal", error.to_string()),
        },
        Err(error) => error,
    });
    registry.add_fn("event.path", |_, request, _| match parse::<PathRequest>(request) {
        Ok(r) => {
            let options = PathOptions { expand_helpers: r.options.expand_helpers, max_depth: r.options.max_depth, max_nodes: r.options.max_nodes };
            let path = algorithms::shortest_path(&r.graph, &r.from, &r.to, options);
            match serde_json::to_value(path) {
                Ok(value) => OpResponse::ok(json!({ "path": value })),
                Err(error) => OpResponse::error("internal", error.to_string()),
            }
        }
        Err(error) => error,
    });
    registry.add_fn("event.components", |_, request, _| match parse::<ComponentsRequest>(request) {
        Ok(r) => {
            let selected = r.selected_node_ids.map(|ids| ids.into_iter().collect());
            match algorithms::components(&r.graph, r.expand_helpers, selected.as_ref()) {
                Ok(list) => match serde_json::to_value(list) {
                    Ok(value) => OpResponse::ok(json!({ "components": value })),
                    Err(error) => OpResponse::error("internal", error.to_string()),
                },
                Err(error) => blocked(error),
            }
        }
        Err(error) => error,
    });
    registry.add_fn("event.reachable", |_, request, _| match parse::<ReachableRequest>(request) {
        Ok(r) => OpResponse::ok(json!({ "nodeIds": algorithms::reachable(&r.graph, &r.start_node_ids, r.direction, r.expand_helpers) })),
        Err(error) => error,
    });
}

/// One file of an `event.fragments` request. The engine reads the file itself from `path` (an
/// absolute path the caller has checked against its roots) and refuses it when its size or SHA-256
/// differ from the scan. Without a `path`, the bytes sit at `payload` (`[offset, length]`) of the
/// frame's raw payload.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FragmentFile {
    relative_path: String,
    display_path: String,
    sha256: String,
    cache_key: String,
    #[serde(default)]
    payload: Option<(usize, usize)>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// `EventSourceAnalysisContext` on the wire: sets as arrays, maps as objects.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ContextWire {
    #[serde(default)]
    known_event_ids: Option<Vec<String>>,
    #[serde(default)]
    known_event_types: std::collections::HashMap<String, String>,
    #[serde(default)]
    known_helper_ids: Option<Vec<String>>,
    #[serde(default)]
    known_decision_ids: Option<Vec<String>>,
    #[serde(default)]
    active_event_paths: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    retained_event_paths: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(default)]
    active_helper_paths: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    active_decision_paths: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    inventory_complete: Option<bool>,
    #[serde(default)]
    documented_effect_keys: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FragmentsRequest {
    files: Vec<FragmentFile>,
    #[serde(default)]
    context: ContextWire,
}

fn set(list: Option<Vec<String>>) -> Option<std::collections::HashSet<String>> {
    list.map(|items| items.into_iter().collect())
}

impl From<ContextWire> for source_analysis::Context {
    fn from(wire: ContextWire) -> Self {
        source_analysis::Context {
            known_event_ids: set(wire.known_event_ids),
            known_event_types: wire.known_event_types,
            known_helper_ids: set(wire.known_helper_ids),
            known_decision_ids: set(wire.known_decision_ids),
            active_event_paths: wire.active_event_paths,
            retained_event_paths: wire.retained_event_paths.map(|map| map.into_iter().map(|(id, paths)| (id, paths.into_iter().collect())).collect()),
            active_helper_paths: wire.active_helper_paths,
            active_decision_paths: wire.active_decision_paths,
            inventory_complete: wire.inventory_complete,
            documented_effect_keys: set(wire.documented_effect_keys),
        }
    }
}

/// A result too large for the response header: the JSON goes in the payload and the header names it,
/// with the wall time of each phase in milliseconds.
fn payload_response(name: &str, value: &Value, count: usize, timings: Value) -> OpResponse {
    payload_response_within(name, value, count, timings, MAX_RESPONSE_BYTES)
}

/// The largest response payload the TypeScript client accepts (`RESIDENT_ENGINE_MAX_PAYLOAD_BYTES`).
/// A larger answer is refused, since the client would stop the engine instead.
const MAX_RESPONSE_BYTES: usize = 512 * 1024 * 1024;

fn payload_response_within(name: &str, value: &Value, count: usize, timings: Value, limit: usize) -> OpResponse {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() > limit => OpResponse::error(
            "EVENT_RESULT_TOO_LARGE",
            format!("The {name} answer is {} bytes, over the {limit} byte response limit; narrow the selection", bytes.len()),
        ),
        Ok(bytes) => OpResponse::ok_with_payload(json!({ "payload": name, "count": count, "timingsMs": timings }), bytes),
        Err(error) => OpResponse::error("internal", error.to_string()),
    }
}

#[cfg(test)]
pub(crate) fn payload_response_for_test(value: &Value, limit: usize) -> OpResponse {
    payload_response_within("test", value, 1, json!({}), limit)
}

fn file_bytes<'a>(file: &FragmentFile, payload: &'a [u8]) -> Result<Cow<'a, [u8]>, OpResponse> {
    if let Some(path) = &file.path {
        let bytes = std::fs::read(path).map_err(|error| OpResponse::error("EVENT_SOURCE_UNREADABLE", format!("cannot read {}: {error}", file.display_path)))?;
        let stale = file.size.is_some_and(|size| size != bytes.len() as u64) || sha256_hex(&bytes) != file.sha256;
        if stale {
            return Err(OpResponse::error("EVENT_SOURCE_STALE", format!("{} changed since it was scanned", file.display_path)));
        }
        return Ok(Cow::Owned(bytes));
    }
    let Some((offset, length)) = file.payload else {
        return Err(OpResponse::error("invalid_request", format!("{} names neither a path nor payload bytes", file.display_path)));
    };
    payload
        .get(offset..offset.saturating_add(length))
        .map(Cow::Borrowed)
        .ok_or_else(|| OpResponse::error("invalid_request", format!("{} names bytes past the end of the payload", file.display_path)))
}

/// One fragment per file, in order. The files are analyzed in parallel, each against its own work
/// budget, and the total must stay under the same fixed ceiling as one shared budget. Each file's
/// bytes are dropped as soon as it is analyzed.
fn analyze_files(files: &[FragmentFile], context: &source_analysis::Context, payload: &[u8]) -> Result<Vec<Value>, OpResponse> {
    let analyzed: Vec<Result<(Value, u64), OpResponse>> = files
        .par_iter()
        .map(|file| {
            let bytes = file_bytes(file, payload)?;
            let source =
                source_analysis::SourceFile { relative_path: &file.relative_path, display_path: &file.display_path, sha256: &file.sha256, bytes: &bytes };
            let mut budget = source_analysis::Budget::default();
            let fragment = source_analysis::analyze_event_source(&source, context, &file.cache_key, &mut budget).map_err(blocked)?;
            Ok((fragment, budget.spent()))
        })
        .collect();
    let mut fragments = Vec::with_capacity(analyzed.len());
    let mut spent = 0u64;
    for result in analyzed {
        let (fragment, used) = result?;
        spent += used;
        fragments.push(fragment);
    }
    if spent > algorithms::WORK_LIMIT {
        return Err(blocked(algorithms::WorkBlocked { label: "source_fragment", spent }));
    }
    Ok(fragments)
}

/// `event.fragments`: `{ files, context }` -> one `EventSourceFragment` per file, in order, as a JSON
/// array in the response payload.
pub fn register_fragments(registry: &mut Registry) {
    registry.add_fn("event.fragments", |_, request, payload| {
        let request = match parse::<FragmentsRequest>(request) {
            Ok(request) => request,
            Err(error) => return error,
        };
        let context: source_analysis::Context = request.context.into();
        let started = Instant::now();
        match analyze_files(&request.files, &context, payload) {
            Ok(fragments) => {
                let analysis = started.elapsed().as_millis() as u64;
                let count = fragments.len();
                payload_response("fragments", &Value::Array(fragments), count, json!({ "analysis": analysis }))
            }
            Err(error) => error,
        }
    });
}

/// `event.graph` request: the fragments of the active files and the scan facts the graph needs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphFile {
    display_path: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphRequest {
    /// The fragments, when the caller has them. Otherwise `analyze` names the files to analyze here,
    /// which keeps the fragments out of the pipe.
    #[serde(default)]
    fragments: Vec<Value>,
    #[serde(default)]
    analyze: Option<FragmentsRequest>,
    files: Vec<GraphFile>,
    workspace_id: String,
    #[serde(default)]
    workspace_identity: Option<String>,
    revision: String,
    complete: bool,
    #[serde(default)]
    skipped_source_count: u64,
    #[serde(default)]
    skipped_sources: Vec<Value>,
    #[serde(default)]
    diagnostics: Vec<Value>,
    #[serde(default = "yes")]
    project_helpers: bool,
    #[serde(default)]
    analysis_mode: Option<String>,
}

fn yes() -> bool {
    true
}

/// `event.graph`: `GraphRequest` -> the `EventGraphSnapshot` as JSON in the response payload.
pub fn register_graph(registry: &mut Registry) {
    registry.add_fn("event.graph", |_, request, payload| {
        let request = match parse::<GraphRequest>(request) {
            Ok(request) => request,
            Err(error) => return error,
        };
        let mut timings = Map::new();
        let fragments = match request.analyze {
            Some(analyze) => {
                let started = Instant::now();
                let context: source_analysis::Context = analyze.context.into();
                match analyze_files(&analyze.files, &context, payload) {
                    Ok(fragments) => {
                        timings.insert("analysis".into(), json!(started.elapsed().as_millis() as u64));
                        fragments
                    }
                    Err(error) => return error,
                }
            }
            None => request.fragments,
        };
        let input = graph_build::Input {
            fragments,
            files: request.files.into_iter().map(|file| (file.display_path, file.sha256)).collect(),
            workspace_id: request.workspace_id,
            workspace_identity: request.workspace_identity,
            revision: request.revision,
            complete: request.complete,
            skipped_source_count: request.skipped_source_count,
            skipped_sources: request.skipped_sources,
            diagnostics: request.diagnostics,
            project_helpers: request.project_helpers,
            focused: request.analysis_mode.as_deref() == Some("focused"),
        };
        match graph_build::build_owned(input) {
            Ok(built) => {
                for (phase, milliseconds) in &built.timings {
                    timings.insert((*phase).into(), json!(milliseconds));
                }
                let graph = built.graph;
                let started = Instant::now();
                let mut response = payload_response("graph", &graph, 1, Value::Object(timings.clone()));
                // Freeing the value tree takes seconds on a large graph; do it off the response path.
                std::thread::spawn(move || drop(graph));
                timings.insert("serialize".into(), json!(started.elapsed().as_millis() as u64));
                if let Ok(header) = response.result.as_mut() {
                    header["timingsMs"] = Value::Object(timings);
                }
                response
            }
            Err(graph_build::BuildError::Work(error)) => blocked(error),
            Err(graph_build::BuildError::Limit { code, label, count, maximum }) => {
                OpResponse::error(code, format!("Event-chain {label} exceeds the fixed result ceiling ({count} over {maximum})"))
            }
            Err(graph_build::BuildError::Input(message)) => OpResponse::error("DEPENDENCY_WALK_INPUT_INVALID", message),
        }
    });
}

/// `event.inspect` request: the built graph sits at `graphPayload` (`[offset, length]`) of the
/// frame's raw payload as JSON, and `params` are the mode and its filters.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectRequest {
    graph_payload: (usize, usize),
    params: inspect::Request,
}

fn refusal_response(refusal: inspect::Refusal) -> OpResponse {
    OpResponse { result: Err(json!({ "code": refusal.code, "message": refusal.message, "details": refusal.details })), payload: Vec::new() }
}

/// `event.inspect`: the report and the inline summary of one query mode over a built graph, as JSON
/// in the response payload. `helper_expansion` is not answered here.
pub fn register_inspect(registry: &mut Registry) {
    registry.add_fn("event.inspect", |_, request, payload| {
        let request = match parse::<InspectRequest>(request) {
            Ok(request) => request,
            Err(error) => return error,
        };
        let (offset, length) = request.graph_payload;
        let Some(bytes) = payload.get(offset..offset.saturating_add(length)) else {
            return OpResponse::error("invalid_request", "the graph payload ends past the end of the frame");
        };
        let graph: Value = match serde_json::from_slice(bytes) {
            Ok(graph) => graph,
            Err(error) => return OpResponse::error("invalid_request", format!("the graph is not JSON: {error}")),
        };
        let started = Instant::now();
        match inspect::inspect(&graph, &request.params) {
            Ok(inspection) => {
                let answered = started.elapsed().as_millis() as u64;
                let body = json!({ "report": inspection.report, "summary": inspection.summary });
                payload_response("inspection", &body, 1, json!({ "inspect": answered }))
            }
            Err(refusal) => refusal_response(refusal),
        }
    });
}

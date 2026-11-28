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
use serde_json::{Value, json};

use crate::algorithms::{self, Boundary, Direction, PathOptions};
use crate::graph::Graph;
use crate::graph_build;
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

/// One file of an `event.fragments` request; its bytes sit at `payload` (`[offset, length]`) of
/// the frame's raw payload.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FragmentFile {
    relative_path: String,
    display_path: String,
    sha256: String,
    cache_key: String,
    payload: (usize, usize),
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

/// A result too large for the response header: the JSON goes in the payload and the header names it.
fn payload_response(name: &str, value: &Value, count: usize) -> OpResponse {
    match serde_json::to_vec(value) {
        Ok(bytes) => OpResponse::ok_with_payload(json!({ "payload": name, "count": count }), bytes),
        Err(error) => OpResponse::error("internal", error.to_string()),
    }
}

/// `event.fragments`: `{ files, context }` plus the files' bytes as the payload → `{ fragments }`,
/// one `EventSourceFragment` per file, in order, as a JSON array in the response payload. The files share
/// one work budget.
pub fn register_fragments(registry: &mut Registry) {
    registry.add_fn("event.fragments", |_, request, payload| {
        let request = match parse::<FragmentsRequest>(request) {
            Ok(request) => request,
            Err(error) => return error,
        };
        let context: source_analysis::Context = request.context.into();
        let mut budget = source_analysis::Budget::default();
        let mut fragments = Vec::with_capacity(request.files.len());
        for file in &request.files {
            let (offset, length) = file.payload;
            let Some(bytes) = payload.get(offset..offset.saturating_add(length)) else {
                return OpResponse::error("invalid_request", format!("{} names bytes past the end of the payload", file.display_path));
            };
            let source = source_analysis::SourceFile { relative_path: &file.relative_path, display_path: &file.display_path, sha256: &file.sha256, bytes };
            match source_analysis::analyze_event_source(&source, &context, &file.cache_key, &mut budget) {
                Ok(fragment) => fragments.push(fragment),
                Err(error) => return blocked(error),
            }
        }
        payload_response("fragments", &json!(fragments), fragments.len())
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
    fragments: Vec<Value>,
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

/// `event.graph`: `GraphRequest` → the `EventGraphSnapshot` as JSON in the response payload.
pub fn register_graph(registry: &mut Registry) {
    registry.add_fn("event.graph", |_, request, _| {
        let request = match parse::<GraphRequest>(request) {
            Ok(request) => request,
            Err(error) => return error,
        };
        let input = graph_build::Input {
            fragments: request.fragments,
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
        match graph_build::build_graph(&input) {
            Ok(graph) => payload_response("graph", &graph, 1),
            Err(graph_build::BuildError::Work(error)) => blocked(error),
            Err(graph_build::BuildError::Limit { code, label, count, maximum }) => {
                OpResponse::error(code, format!("Event-chain {label} exceeds the fixed result ceiling ({count} over {maximum})"))
            }
            Err(graph_build::BuildError::Input(message)) => OpResponse::error("DEPENDENCY_WALK_INPUT_INVALID", message),
        }
    });
}

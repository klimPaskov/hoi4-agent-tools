//! `event.inspect`: the report and the inline summary of one query mode over an event graph.
//!
//! Adapted from `src/hoi4_agent_tools/event/service.ts` (`EventChainViewer.inspect`, the mode
//! switch, `eventScanReport`, `boundedEvidence`, `boundedUnresolved`, `selectorNotFound`) and
//! `reference/suggestions.ts` (`nearestNames`) at the port branch. The caller keeps the scan, the
//! graph cache and the stored artifacts. `helper_expansion` stays in TypeScript.

use std::collections::HashSet;

use hoi4_core::canonical::{compare_code_units as cmp, sha256_hex};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::algorithms::{Boundary, Direction};
use crate::graph_build::{list, text, text_opt};
use crate::queries::{self, ImpactSubject, PathBoundary, Query, Selector, StateSubject, counts_by};
use crate::summary;

const SCAN_FULL_GRAPH_RECORD_LIMIT: usize = 100_000;
const SCAN_SUMMARY_SAMPLE_LIMIT: usize = 100;
const FOCUSED_EVIDENCE_LIMIT: usize = 2_000;

/// A refused inspection: a stable code, a message and the details a caller shows.
#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into(), details: Value::Null }
}

#[derive(Debug, Deserialize)]
pub struct Subject {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub mode: String,
    #[serde(default)]
    pub selector: Option<Selector>,
    #[serde(default)]
    pub from: Option<Selector>,
    #[serde(default)]
    pub to: Option<Selector>,
    #[serde(default)]
    pub direction: Option<Direction>,
    #[serde(default)]
    pub max_depth: Option<u64>,
    #[serde(default)]
    pub max_nodes: Option<usize>,
    #[serde(default)]
    pub max_edges: Option<usize>,
    #[serde(default)]
    pub expand_helpers: Option<bool>,
    #[serde(default)]
    pub state_subject: Option<Subject>,
    #[serde(default)]
    pub impact_subject: Option<ImpactSubject>,
}

pub struct Inspection {
    pub report: Value,
    pub summary: Option<Value>,
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

const MAX_DISTANCE: usize = 3;

fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

/// Levenshtein distance cut off above three edits.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, left) in a.iter().enumerate() {
        let mut next = vec![i + 1];
        for (j, right) in b.iter().enumerate() {
            let value = (next[j] + 1).min(row[j + 1] + 1).min(row[j] + usize::from(left != right));
            next.push(value);
        }
        if next.iter().min().copied().unwrap_or(0) > MAX_DISTANCE {
            return MAX_DISTANCE + 1;
        }
        row = next;
    }
    row[b.len()]
}

/// A stand-in for `localeCompare(_, 'en')` on identifiers: letters without case first, then case
/// (lower before upper), then code units. The ICU collation orders punctuation and digits ahead
/// of letters as code units mostly do, so this agrees on plain identifiers.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// `nearestNames`: the closest candidates within three edits, nearest first.
fn nearest_names(target: &str, candidates: impl IntoIterator<Item = String>) -> Vec<String> {
    let target_units = units(target);
    if target_units.len() > 128 {
        return Vec::new();
    }
    let mut budget: i64 = 20_000;
    let mut scored: Vec<(usize, String)> = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        let candidate_units = units(&candidate);
        if candidate == target || candidate_units.len().abs_diff(target_units.len()) > MAX_DISTANCE {
            continue;
        }
        budget -= 1;
        if budget < 0 {
            break;
        }
        let distance = edit_distance(&target_units, &candidate_units);
        if distance <= MAX_DISTANCE {
            scored.push((distance, candidate));
        }
    }
    scored.sort_by(|(left_distance, left), (right_distance, right)| left_distance.cmp(right_distance).then_with(|| locale_compare(left, right)));
    scored.into_iter().take(5).map(|(_, candidate)| candidate).collect()
}

fn slice_units(value: &str, limit: usize) -> String {
    let mut used = 0usize;
    for (index, c) in value.char_indices() {
        used += c.len_utf16();
        if used > limit {
            return value[..index].to_string();
        }
    }
    value.to_string()
}

fn hint(suggestions: &[String]) -> String {
    if suggestions.is_empty() { String::new() } else { format!("; did you mean {}?", suggestions.join(", ")) }
}

/// `selectorNotFound`.
fn selector_not_found(query: &Query<'_>, selector: &Selector) -> Refusal {
    let names = |key: &'static str| query.nodes().iter().filter_map(move |node| text_opt(node, key).map(str::to_string));
    match selector {
        Selector::Event { event_id } => {
            let suggestions = nearest_names(event_id, names("eventId"));
            let shown = slice_units(event_id, 256);
            Refusal {
                code: "EVENT_NOT_FOUND",
                message: format!("No scanned file defines or fires event {shown}{}", hint(&suggestions)),
                details: json!({ "eventId": shown, "suggestions": suggestions }),
            }
        }
        Selector::Namespace { namespace } => {
            let suggestions = nearest_names(namespace, names("namespace"));
            let shown = slice_units(namespace, 256);
            Refusal {
                code: "EVENT_NAMESPACE_NOT_FOUND",
                message: format!("No scanned event belongs to the namespace {shown}{}", hint(&suggestions)),
                details: json!({ "namespace": shown, "suggestions": suggestions }),
            }
        }
        Selector::Node { node_id } => {
            let shown = slice_units(node_id, 256);
            Refusal { code: "EVENT_NODE_NOT_FOUND", message: format!("No node {shown} is in the event graph"), details: json!({ "nodeId": shown }) }
        }
        other => {
            let kind = match other {
                Selector::File { .. } => "file",
                Selector::Source { .. } => "source",
                _ => "manifest",
            };
            Refusal {
                code: "EVENT_SOURCE_NOT_FOUND",
                message: "No event, option or entry point of the event graph is in the selected source".into(),
                details: json!({ "selector": kind }),
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Bounded evidence
// ---------------------------------------------------------------------------------------------

struct Bounded {
    values: Vec<Value>,
    inventory: Option<Value>,
}

fn bounded_evidence(values: Vec<Value>, limit: usize) -> Bounded {
    if values.len() <= limit {
        return Bounded { values, inventory: None };
    }
    let count = values.len();
    Bounded { values: values.into_iter().take(limit).collect(), inventory: Some(json!({ "count": count, "retainedCount": limit, "truncated": true })) }
}

fn bounded_unresolved(query: &Query<'_>, selected: Option<&HashSet<String>>) -> Bounded {
    let relevant: Vec<Value> = query
        .unresolved()
        .iter()
        .filter(|item| selected.is_none_or(|ids| ids.contains(text(item, "id")) || text_opt(item, "ownerId").is_some_and(|owner| ids.contains(owner))))
        .cloned()
        .collect();
    bounded_evidence(relevant, FOCUSED_EVIDENCE_LIMIT)
}

fn with_inventory(report: &mut Map<String, Value>, key: &str, bounded: &Bounded) {
    if let Some(inventory) = &bounded.inventory {
        report.insert(key.into(), inventory.clone());
    }
}

// ---------------------------------------------------------------------------------------------
// Scan report
// ---------------------------------------------------------------------------------------------

/// `boundedSourceHashEvidence`: a bounded sample of the source hashes and a digest of all of them.
pub fn bounded_source_hash_evidence(source_hashes: &Value) -> (Value, Value) {
    let mut entries: Vec<(&String, &str)> =
        source_hashes.as_object().map(|map| map.iter().map(|(path, hash)| (path, hash.as_str().unwrap_or(""))).collect()).unwrap_or_default();
    entries.sort_by(|(a, _), (b, _)| cmp(a, b));
    let mut digest_input: Vec<u8> = b"source-hash-inventory.v1\0".to_vec();
    let mut retained = Map::new();
    let mut retained_bytes = 2usize;
    let mut retained_count = 0usize;
    for (path, hash) in &entries {
        digest_input.extend_from_slice(path.len().to_string().as_bytes());
        digest_input.push(b':');
        digest_input.extend_from_slice(path.as_bytes());
        digest_input.push(b':');
        digest_input.extend_from_slice(hash.as_bytes());
        digest_input.push(b'\n');
        let entry_bytes = serde_json::to_string(path).map_or(0, |s| s.len()) + serde_json::to_string(hash).map_or(0, |s| s.len()) + 2;
        if retained_count < 256 && retained_bytes + entry_bytes <= 131_072 {
            retained.insert((*path).clone(), json!(hash));
            retained_bytes += entry_bytes;
            retained_count += 1;
        }
    }
    let inventory = json!({
        "schemaVersion": 1,
        "algorithm": "sha256-length-prefixed-path-digest-v1",
        "count": entries.len(),
        "digest": sha256_hex(&digest_input),
        "retainedCount": retained_count,
        "truncated": retained_count != entries.len(),
    });
    (Value::Object(retained), inventory)
}

fn sample(values: &[Value]) -> Vec<&Value> {
    values.iter().take(SCAN_SUMMARY_SAMPLE_LIMIT).collect()
}

/// `eventScanReport`.
pub fn event_scan_report(graph: &Value, limit: usize) -> Value {
    let lists = ["nodes", "edges", "stateAccesses", "stateLinks", "issues", "diagnostics", "unresolved"];
    let record_count: usize = lists.iter().map(|key| list(graph, key).len()).sum();
    if record_count <= limit {
        return json!({ "graph": graph });
    }
    let (_, inventory) = bounded_source_hash_evidence(graph.get("sourceHashes").unwrap_or(&Value::Null));
    let group = |key: &str, field: &str| counts_by(list(graph, key).iter(), |item| text(item, field).to_string());
    json!({
        "graphSummary": {
            "schemaVersion": graph.get("schemaVersion").cloned().unwrap_or(Value::Null),
            "parserVersion": graph.get("parserVersion").cloned().unwrap_or(Value::Null),
            "analysisMode": text_opt(graph, "analysisMode").unwrap_or("full"),
            "workspaceId": graph.get("workspaceId").cloned().unwrap_or(Value::Null),
            "workspaceIdentity": graph.get("workspaceIdentity").cloned().unwrap_or(Value::Null),
            "revision": graph.get("revision").cloned().unwrap_or(Value::Null),
            "complete": graph.get("complete").cloned().unwrap_or(Value::Null),
            "statistics": graph.get("statistics").cloned().unwrap_or(Value::Null),
            "filesScanned": list(graph, "filesScanned").len(),
            "skippedSourceCount": graph.get("skippedSourceCount").cloned().unwrap_or(Value::Null),
            "sourceHashInventory": inventory,
            "recordCounts": {
                "nodes": list(graph, "nodes").len(),
                "edges": list(graph, "edges").len(),
                "stateAccesses": list(graph, "stateAccesses").len(),
                "stateLinks": list(graph, "stateLinks").len(),
                "issues": list(graph, "issues").len(),
                "diagnostics": list(graph, "diagnostics").len(),
                "unresolved": list(graph, "unresolved").len(),
            },
            "nodeKinds": group("nodes", "kind"),
            "edgeReasons": group("edges", "reason"),
            "issueCodes": group("issues", "code"),
            "issueSeverities": group("issues", "severity"),
            "diagnosticCodes": group("diagnostics", "code"),
            "diagnosticSeverities": group("diagnostics", "severity"),
            "unresolvedKinds": group("unresolved", "kind"),
        },
        "issueSamples": sample(list(graph, "issues")),
        "diagnosticSamples": sample(list(graph, "diagnostics")),
        "unresolvedSamples": sample(list(graph, "unresolved")),
        "artifactProjection": {
            "mode": "large-scan-summary",
            "fullGraphRecordCount": record_count,
            "fullGraphRecordLimit": limit,
            "detailQueries": ["roots", "trace", "explain_path", "state_flow", "impact"],
        },
    })
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

fn base(graph: &Value) -> Map<String, Value> {
    let mut report = Map::new();
    report.insert("graphRevision".into(), graph.get("revision").cloned().unwrap_or(Value::Null));
    report.insert("sourceHashes".into(), graph.get("sourceHashes").cloned().unwrap_or(Value::Null));
    report
}

fn failed(error: crate::algorithms::WorkBlocked) -> Refusal {
    refuse("EVENT_ANALYSIS_WORK_BLOCKED", format!("Event-chain analysis exceeds the fixed work ceiling ({} spent in {})", error.spent, error.label))
}

/// `EventChainViewer.inspect` after the scan: the checks, the mode's query, its report and summary.
pub fn inspect(graph: &Value, request: &Request) -> Result<Inspection, Refusal> {
    inspect_with_limit(graph, request, SCAN_FULL_GRAPH_RECORD_LIMIT)
}

pub fn inspect_with_limit(graph: &Value, request: &Request, scan_limit: usize) -> Result<Inspection, Refusal> {
    let query = Query::new(graph).map_err(|error| refuse("invalid_request", format!("the graph is malformed: {error}")))?;
    let max_depth = request.max_depth.unwrap_or(8);
    let max_nodes = request.max_nodes.unwrap_or(500);
    let max_edges = request.max_edges.unwrap_or(2_000);
    let mode = request.mode.as_str();
    // A selector or state subject that matches nothing is not-found, never an empty answer.
    if let Some(selector) = &request.selector
        && mode != "impact"
        && queries::select_event_nodes(&query, selector).is_empty()
    {
        return Err(selector_not_found(&query, selector));
    }
    if mode == "state_flow"
        && let Some(subject) = &request.state_subject
        && !query.accesses().iter().any(|access| text(access, "kind") == subject.kind && text(access, "name") == subject.name)
    {
        let suggestions = nearest_names(
            &subject.name,
            query.accesses().iter().filter(|access| text(access, "kind") == subject.kind).map(|access| text(access, "name").to_string()),
        );
        let shown = slice_units(&subject.name, 256);
        return Err(Refusal {
            code: "EVENT_STATE_NOT_FOUND",
            message: format!("No scanned file sets, checks or clears the {} {shown}{}", subject.kind.replace('_', " "), hint(&suggestions)),
            details: json!({ "kind": subject.kind, "name": shown, "suggestions": suggestions }),
        });
    }
    let selector = request.selector.as_ref();
    match mode {
        "scan" => {
            let issues: Vec<&Value> = match selector {
                None => query.issues().iter().collect(),
                Some(_) => queries::lint_event_graph(&query, selector),
            };
            Ok(Inspection { report: event_scan_report(graph, scan_limit), summary: Some(summary::summarize_event_issues(&issues)) })
        }
        "roots" => {
            let unresolved = bounded_unresolved(&query, None);
            let roots = queries::discover_event_roots(&query, selector).map_err(failed)?;
            let mut report = base(graph);
            report.insert("roots".into(), roots.to_json());
            report.insert("unresolved".into(), Value::Array(unresolved.values.clone()));
            with_inventory(&mut report, "unresolvedInventory", &unresolved);
            Ok(Inspection { report: Value::Object(report), summary: Some(summary::summarize_event_roots(&roots)) })
        }
        "trace" => {
            let Some(selector) = selector else { return Err(refuse("EVENT_SELECTOR_REQUIRED", "Trace requires a selector")) };
            let boundary = Boundary {
                max_depth,
                max_nodes,
                max_edges,
                direction: request.direction.unwrap_or(Direction::Both),
                expand_helpers: request.expand_helpers.unwrap_or(false),
            };
            let trace = queries::trace_selected_events(&query, selector, &boundary);
            let ids: HashSet<String> = list(&trace, "nodes").iter().map(|node| text(node, "id").to_string()).collect();
            let unresolved = bounded_unresolved(&query, Some(&ids));
            let mut summary = summary::summarize_event_issues(&queries::lint_event_graph(&query, Some(selector)));
            if let Some(map) = summary.as_object_mut() {
                map.insert("trace".into(), summary::summarize_event_trace(&trace));
            }
            let mut report = base(graph);
            report.insert("trace".into(), trace);
            report.insert("unresolved".into(), Value::Array(unresolved.values.clone()));
            with_inventory(&mut report, "unresolvedInventory", &unresolved);
            Ok(Inspection { report: Value::Object(report), summary: Some(summary) })
        }
        "explain_path" => {
            let (Some(from), Some(to)) = (&request.from, &request.to) else {
                return Err(refuse("EVENT_PATH_SELECTORS_REQUIRED", "Path explanation requires from and to selectors"));
            };
            let explanation =
                queries::explain_event_path(&query, from, to, &PathBoundary { max_depth, max_nodes, expand_helpers: request.expand_helpers.unwrap_or(true) });
            let summary = summary::summarize_event_path(&explanation);
            let mut report = base(graph);
            report.insert("explanation".into(), explanation);
            Ok(Inspection { report: Value::Object(report), summary: Some(summary) })
        }
        "state_flow" => state_flow(graph, &query, request),
        "lint" => {
            let selected = queries::lint_event_graph(&query, selector);
            let summary = summary::summarize_event_issues(&selected);
            let issues = bounded_evidence(selected.into_iter().cloned().collect(), FOCUSED_EVIDENCE_LIMIT);
            let unresolved = bounded_unresolved(&query, None);
            let mut report = base(graph);
            report.insert("issues".into(), Value::Array(issues.values.clone()));
            report.insert("complete".into(), graph.get("complete").cloned().unwrap_or(Value::Null));
            report.insert("unresolved".into(), Value::Array(unresolved.values.clone()));
            with_inventory(&mut report, "issueInventory", &issues);
            with_inventory(&mut report, "unresolvedInventory", &unresolved);
            Ok(Inspection { report: Value::Object(report), summary: Some(summary) })
        }
        "impact" => {
            let Some(subject) = &request.impact_subject else {
                return Err(refuse("EVENT_IMPACT_SUBJECT_REQUIRED", "Impact analysis requires a subject"));
            };
            let unresolved = bounded_unresolved(&query, None);
            let impact = queries::analyze_event_impact(&query, subject).map_err(failed)?;
            let summary = summary::summarize_event_impact(&impact);
            let mut report = base(graph);
            report.insert("impact".into(), impact);
            report.insert("unresolved".into(), Value::Array(unresolved.values.clone()));
            with_inventory(&mut report, "unresolvedInventory", &unresolved);
            Ok(Inspection { report: Value::Object(report), summary: Some(summary) })
        }
        other => Err(refuse("invalid_request", format!("the mode {other} is not answered by the engine"))),
    }
}

fn state_flow(graph: &Value, query: &Query<'_>, request: &Request) -> Result<Inspection, Refusal> {
    let selector = request.selector.as_ref();
    let subject = request.state_subject.as_ref();
    let unresolved = bounded_unresolved(query, None);
    let is_state_code = |code: &str| ["STATE", "FLAG", "VARIABLE", "ARRAY", "TARGET", "SCOPE", "WRITER"].iter().any(|part| code.contains(part));
    let state_issues: Vec<&Value> = queries::lint_event_graph(query, selector)
        .into_iter()
        .filter(|issue| {
            let code = text(issue, "code");
            if !is_state_code(code) {
                return false;
            }
            let Some(subject) = subject else { return true };
            let details = issue.get("details");
            match details.and_then(|d| text_opt(d, "name")) {
                Some(name) => name == subject.name && details.and_then(|d| text_opt(d, "stateKind")).is_none_or(|kind| kind == subject.kind),
                None => code.ends_with("_LIMIT"),
            }
        })
        .collect();
    let flow = queries::inspect_event_state_flow(query, selector, subject.map(|s| StateSubject { kind: s.kind.clone(), name: s.name.clone() }).as_ref());
    let where_of = |name: &str| -> Vec<String> {
        list(&flow, name)
            .iter()
            .take(8)
            .map(|access| {
                let location = access.get("location");
                let line = location.and_then(|l| l.get("start")).and_then(|s| s.get("line")).and_then(Value::as_i64).unwrap_or(0);
                format!("{}:{line}", location.map_or("", |l| text(l, "path")))
            })
            .collect()
    };
    let mut summary = summary::summarize_event_issues(&state_issues);
    if let (Some(subject), Some(map)) = (subject, summary.as_object_mut()) {
        map.insert(
            "flow".into(),
            json!({
                "subject": format!("{}:{}", subject.kind, subject.name),
                "producers": list(&flow, "producers").len(),
                "consumers": list(&flow, "consumers").len(),
                "clears": list(&flow, "clears").len(),
                "links": list(&flow, "links").len(),
                "unproducedReads": list(&flow, "unproducedReads").len(),
                "producedAt": where_of("producers"),
                "readAt": where_of("consumers"),
            }),
        );
    }
    let issues = bounded_evidence(state_issues.into_iter().cloned().collect(), FOCUSED_EVIDENCE_LIMIT);
    let mut report = base(graph);
    report.insert("flow".into(), flow);
    report.insert("issues".into(), Value::Array(issues.values.clone()));
    report.insert("unresolved".into(), Value::Array(unresolved.values.clone()));
    with_inventory(&mut report, "issueInventory", &issues);
    with_inventory(&mut report, "unresolvedInventory", &unresolved);
    Ok(Inspection { report: Value::Object(report), summary: Some(summary) })
}

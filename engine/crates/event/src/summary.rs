//! Inline summaries of the event queries: counts and the most severe findings, small enough to
//! return before an agent opens the report.
//!
//! Adapted from `src/hoi4_agent_tools/event/summary.ts` at the port branch.

use std::collections::BTreeSet;

use hoi4_core::canonical::compare_code_units as cmp;
use serde_json::{Map, Value, json};

use crate::graph_build::{list, text, text_opt};
use crate::queries::{Roots, counts_by};

const INLINE_FINDINGS: usize = 10;
const INLINE_CODES: usize = 10;
const INLINE_EVENT_IDS: usize = 20;
const INLINE_TRACE_NAMES: usize = 20;
const INLINE_MESSAGE_LENGTH: usize = 300;

fn classification_order(value: &str) -> u8 {
    match value {
        "confirmed_error" => 0,
        "probable_defect" => 1,
        "design_warning" => 2,
        _ => 3,
    }
}

fn confidence_order(value: &str) -> u8 {
    match value {
        "confirmed" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

/// The `^([a-z]+):` prefix of a display path, or `unknown`.
fn path_layer(path: Option<&str>) -> String {
    let Some(path) = path else { return "unknown".into() };
    match path.find(':') {
        Some(at) if at > 0 && path[..at].bytes().all(|b| b.is_ascii_lowercase()) => path[..at].to_string(),
        _ => "unknown".into(),
    }
}

fn issue_layer(issue: &Value) -> String {
    path_layer(issue.get("location").and_then(|l| text_opt(l, "path")))
}

fn start_line(issue: &Value) -> i64 {
    issue.get("location").and_then(|l| l.get("start")).and_then(|s| s.get("line")).and_then(Value::as_i64).unwrap_or(0)
}

/// The mod's own files first, then most severe: classification, confidence, source order.
fn issue_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    let rank = |issue: &Value| u8::from(issue_layer(issue) != "mod");
    rank(left)
        .cmp(&rank(right))
        .then_with(|| classification_order(text(left, "classification")).cmp(&classification_order(text(right, "classification"))))
        .then_with(|| confidence_order(text(left, "confidence")).cmp(&confidence_order(text(right, "confidence"))))
        .then_with(|| cmp(left.get("location").map_or("", |l| text(l, "path")), right.get("location").map_or("", |l| text(l, "path"))))
        .then_with(|| start_line(left).cmp(&start_line(right)))
        .then_with(|| cmp(text(left, "code"), text(right, "code")))
        .then_with(|| cmp(text(left, "message"), text(right, "message")))
}

/// `text.slice(0, units)` in UTF-16 code units, dropping a split surrogate pair.
fn slice_units(value: &str, units: usize) -> &str {
    let mut used = 0usize;
    for (index, c) in value.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &value[..index];
        }
    }
    value
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `summarizeEventIssues`.
pub fn summarize_event_issues(issues: &[&Value]) -> Value {
    let by_code = counts_by(issues.iter(), |issue| text(issue, "code").to_string());
    let mut top: Vec<(&String, u64)> = by_code.iter().map(|(code, count)| (code, count.as_u64().unwrap_or(0))).collect();
    top.sort_by(|(left_code, left), (right_code, right)| right.cmp(left).then_with(|| cmp(left_code, right_code)));
    let top_codes: Map<String, Value> = top.into_iter().take(INLINE_CODES).map(|(code, count)| (code.clone(), json!(count))).collect();
    let mut ordered: Vec<&Value> = issues.to_vec();
    ordered.sort_by(|a, b| issue_order(a, b));
    let findings: Vec<Value> = ordered
        .into_iter()
        .take(INLINE_FINDINGS)
        .map(|issue| {
            let message = text(issue, "message");
            let mut finding = Map::new();
            finding.insert("code".into(), json!(text(issue, "code")));
            finding.insert("classification".into(), json!(text(issue, "classification")));
            finding.insert("confidence".into(), json!(text(issue, "confidence")));
            finding.insert(
                "message".into(),
                json!(if utf16_len(message) > INLINE_MESSAGE_LENGTH {
                    format!("{}\u{2026}", slice_units(message, INLINE_MESSAGE_LENGTH - 1))
                } else {
                    message.to_string()
                }),
            );
            if let Some(location) = issue.get("location").filter(|l| !l.is_null()) {
                finding.insert("path".into(), json!(text(location, "path")));
                finding.insert("line".into(), location.get("start").and_then(|s| s.get("line")).cloned().unwrap_or(Value::Null));
            }
            if let Some(name) = issue.get("details").and_then(|d| text_opt(d, "name")) {
                finding.insert("subject".into(), json!(name));
            }
            Value::Object(finding)
        })
        .collect();
    json!({
        "issues": issues.len(),
        "byClassification": counts_by(issues.iter(), |issue| text(issue, "classification").to_string()),
        "byLayer": counts_by(issues.iter(), |issue| issue_layer(issue)),
        "topCodes": top_codes,
        "findings": findings,
    })
}

fn sorted_set(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut list: Vec<String> = values.into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    list.sort_by(|a, b| cmp(a, b));
    list
}

/// `summarizeEventTrace`: the trace as the `algorithms::Trace` serialization.
pub fn summarize_event_trace(trace: &Value) -> Value {
    let mut events: Vec<String> =
        list(trace, "nodes").iter().filter(|node| text(node, "kind") == "event").filter_map(|node| text_opt(node, "eventId").map(str::to_string)).collect();
    events.sort_by(|a, b| cmp(a, b));
    let entries = sorted_set(list(trace, "nodes").iter().filter(|node| text(node, "kind") == "entry").map(|node| text(node, "label").to_string()));
    let helpers = sorted_set(
        list(trace, "edges").iter().flat_map(|edge| list(edge, "helperStack").iter().filter_map(|name| name.as_str().map(str::to_string)).collect::<Vec<_>>()),
    );
    json!({
        "nodes": list(trace, "nodes").len(),
        "edges": list(trace, "edges").len(),
        "events": events.len(),
        "eventIds": events.iter().take(INLINE_EVENT_IDS).collect::<Vec<_>>(),
        "entryPoints": entries.iter().take(INLINE_TRACE_NAMES).collect::<Vec<_>>(),
        "helpers": helpers.iter().take(INLINE_TRACE_NAMES).collect::<Vec<_>>(),
        "boundaryNodes": list(trace, "boundaryNodeIds").len(),
        "truncated": trace.get("truncated").cloned().unwrap_or(Value::Null),
    })
}

/// `summarizeEventRoots`.
pub fn summarize_event_roots(roots: &Roots<'_>) -> Value {
    let node_layer = |node: &Value| path_layer(text_opt(node, "sourcePath"));
    let ids = |nodes: &[&Value]| -> Vec<String> {
        let mut sorted: Vec<&Value> = nodes.to_vec();
        sorted.sort_by(|left, right| {
            u8::from(node_layer(left) != "mod")
                .cmp(&u8::from(node_layer(right) != "mod"))
                .then_with(|| cmp(text_opt(left, "eventId").unwrap_or(""), text_opt(right, "eventId").unwrap_or("")))
        });
        sorted.into_iter().filter_map(|node| text_opt(node, "eventId").map(str::to_string)).take(INLINE_EVENT_IDS).collect()
    };
    json!({
        "entryPoints": roots.entry_points.len(),
        "entryKinds": counts_by(roots.entry_points.iter(), |node| node.get("metadata").and_then(|m| text_opt(m, "entryKind")).unwrap_or("unknown").to_string()),
        "automaticEvents": roots.automatic_events.len(),
        "callerlessTriggeredEvents": roots.callerless_triggered_events.len(),
        "callerlessTriggeredByLayer": counts_by(roots.callerless_triggered_events.iter(), |node| node_layer(node)),
        "callerlessTriggeredEventIds": ids(&roots.callerless_triggered_events),
        "cycles": roots.components.iter().filter(|component| component.cyclic).count(),
    })
}

/// `summarizeEventPath`.
pub fn summarize_event_path(path: &Value) -> Value {
    let event_ids: Vec<&str> = list(path, "steps")
        .iter()
        .filter_map(|step| step.get("node"))
        .filter(|node| text(node, "kind") == "event")
        .filter_map(|node| text_opt(node, "eventId"))
        .take(INLINE_EVENT_IDS)
        .collect();
    let mut summary = Map::new();
    summary.insert("found".into(), path.get("found").cloned().unwrap_or(Value::Null));
    summary.insert("steps".into(), json!(list(path, "steps").len()));
    summary.insert("eventIds".into(), json!(event_ids));
    for key in ["failureReason", "failureMessage"] {
        if let Some(value) = path.get(key).filter(|v| !v.is_null()) {
            summary.insert(key.into(), value.clone());
        }
    }
    summary.insert("unresolvedAssumptions".into(), json!(list(path, "unresolvedAssumptions").len()));
    Value::Object(summary)
}

/// `summarizeEventImpact`.
pub fn summarize_event_impact(impact: &Value) -> Value {
    let downstream = list(impact, "downstreamNodeIds");
    json!({
        "direct": list(impact, "directNodeIds").len(),
        "upstream": list(impact, "upstreamNodeIds").len(),
        "downstream": downstream.len(),
        "stateAccesses": list(impact, "stateAccessIds").len(),
        "affectedRoots": list(impact, "affectedRootIds").len(),
        "affectedTerminals": list(impact, "affectedTerminalIds").len(),
        "wouldDisconnect": list(impact, "wouldDisconnectNodeIds").len(),
        "wouldDisconnectTerminals": list(impact, "wouldDisconnectTerminalIds").len(),
        "unresolved": list(impact, "unresolvedNodeIds").len(),
        "sampleDownstream": downstream.iter().take(INLINE_EVENT_IDS).collect::<Vec<_>>(),
    })
}

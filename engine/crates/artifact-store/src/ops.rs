//! The engine operations of this crate: `artifacts.*` and `diff.*`.
//!
//! New in the port. Each operation answers one framed request of the resident engine protocol:
//! the JSON header carries the fields below, a raw payload carries bytes (artifact content, PNGs).
//! Errors keep the TypeScript `ServiceError` code, so a caller sees what it saw before.

use hoi4_core::ops::{OpContext, OpResponse, Registry};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::changed::{ChangedFileIdentity, summarize_changed_files};
use crate::diff::{TextDiffOptions, binary_diff, unified_text_diff};
use crate::error::{StoreError, StoreResult};
use crate::image::{RenderBudget, compare_png_images, create_transparent_png};
use crate::managed::{PathRule, PlanInput, ProposedChange, RefreshInput, SourceFile, plan_managed_outputs, refresh_managed_outputs};
use crate::store::{ArtifactStore, ArtifactWrite, Created, StoreLimits, StoreWorkspace, bounded_source_hash_evidence};
use crate::temp::{SweepOptions, process_alive, sweep_temporary_directories};

fn invalid(message: impl Into<String>) -> OpResponse {
    OpResponse::error("invalid_request", message)
}

fn parse<T: for<'de> Deserialize<'de>>(request: &Value, field: &str) -> Result<T, OpResponse> {
    let value = request.get(field).ok_or_else(|| invalid(format!("the request needs {field}")))?;
    serde_json::from_value(value.clone()).map_err(|error| invalid(format!("{field} is malformed: {error}")))
}

fn optional<T: for<'de> Deserialize<'de>>(request: &Value, field: &str) -> Result<Option<T>, OpResponse> {
    match request.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone()).map(Some).map_err(|error| invalid(format!("{field} is malformed: {error}"))),
    }
}

fn answer(outcome: Result<Value, StoreError>) -> OpResponse {
    match outcome {
        Ok(value) => OpResponse::ok(value),
        Err(error) => error.into_response(),
    }
}

fn store_of(request: &Value) -> Result<ArtifactStore, OpResponse> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Limits {
        max_bytes: Option<u64>,
        max_entries: Option<u64>,
        max_single_bytes: Option<u64>,
    }
    let limits: Option<Limits> = optional(request, "limits")?;
    let retention_epoch: Option<u64> = optional(request, "retentionEpoch")?;
    let defaults = StoreLimits::default();
    let mut store = ArtifactStore::new(match limits {
        None => defaults,
        Some(limits) => StoreLimits {
            max_bytes: limits.max_bytes.unwrap_or(defaults.max_bytes),
            max_entries: limits.max_entries.unwrap_or(defaults.max_entries),
            max_single_bytes: limits.max_single_bytes.unwrap_or(defaults.max_single_bytes),
        },
    });
    store.retention_epoch = retention_epoch;
    Ok(store)
}

/// The caller's retained URIs: `None` when it keeps pins it has not supplied yet.
fn retention_of(request: &Value) -> Result<Option<Vec<String>>, OpResponse> {
    let retained: Option<Vec<String>> = optional(request, "retainedUris")?;
    let pending = request.get("retentionPending").and_then(Value::as_bool).unwrap_or(false);
    Ok(match (retained, pending) {
        (Some(list), _) => Some(list),
        (None, true) => None,
        (None, false) => Some(Vec::new()),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWrite {
    name: String,
    mime_type: String,
    length: usize,
    provenance: Value,
    description: Option<String>,
}

fn writes_of(request: &Value, payload: &[u8]) -> Result<Vec<ArtifactWrite>, OpResponse> {
    let wire: Vec<WireWrite> = parse(request, "writes")?;
    let mut offset = 0usize;
    let mut writes = Vec::with_capacity(wire.len());
    for item in wire {
        let end = offset.checked_add(item.length).filter(|end| *end <= payload.len()).ok_or_else(|| invalid("the payload is shorter than the writes say"))?;
        writes.push(ArtifactWrite {
            name: item.name,
            mime_type: item.mime_type,
            content: payload[offset..end].to_vec(),
            provenance: item.provenance,
            description: item.description,
        });
        offset = end;
    }
    if offset != payload.len() {
        return Err(invalid("the payload is longer than the writes say"));
    }
    Ok(writes)
}

fn put(request: &Value, payload: &[u8], chunked: bool) -> OpResponse {
    let run = || -> Result<StoreResult<Value>, OpResponse> {
        let store = store_of(request)?;
        let workspace: StoreWorkspace = parse(request, "workspace")?;
        let writes = writes_of(request, payload)?;
        let retained = retention_of(request)?;
        Ok(if chunked {
            store
                .put_chunked(&workspace, &writes, retained.as_deref())
                .map(|(logical, physical, created)| json!({ "artifacts": logical, "physical": physical, "created": created }))
        } else {
            store
                .put_batch(&workspace, &writes, retained.as_deref())
                .map(|(artifacts, created)| json!({ "artifacts": artifacts, "physical": artifacts, "created": created }))
        })
    };
    match run() {
        Ok(outcome) => answer(outcome),
        Err(response) => response,
    }
}

fn range_of(request: &Value) -> Result<Option<(u64, u64)>, OpResponse> {
    #[derive(Deserialize)]
    struct Range {
        offset: u64,
        length: u64,
    }
    Ok(optional::<Range>(request, "range")?.map(|range| (range.offset, range.length)))
}

fn read_op(request: &Value, logical: bool) -> OpResponse {
    let run = || -> Result<StoreResult<crate::store::ReadResult>, OpResponse> {
        let store = store_of(request)?;
        let workspace: StoreWorkspace = parse(request, "workspace")?;
        let uri: String = parse(request, "uri")?;
        if logical {
            let mime_type: String = parse(request, "mimeType")?;
            let max_bytes: u64 = parse(request, "maxBytes")?;
            let max_chunks: usize = parse(request, "maxChunks")?;
            Ok(store.read_logical(&workspace, &uri, &mime_type, max_bytes, max_chunks))
        } else {
            Ok(store.read(&workspace, &uri, range_of(request)?))
        }
    };
    match run() {
        Ok(Ok(read)) => OpResponse::ok_with_payload(json!({ "mimeType": read.mime_type, "name": read.name, "totalSize": read.total_size }), read.bytes),
        Ok(Err(error)) => error.into_response(),
        Err(response) => response,
    }
}

fn with_store(request: &Value, action: impl FnOnce(&ArtifactStore, &StoreWorkspace) -> StoreResult<Value>) -> OpResponse {
    let store = match store_of(request) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let workspace: StoreWorkspace = match parse(request, "workspace") {
        Ok(workspace) => workspace,
        Err(response) => return response,
    };
    answer(action(&store, &workspace))
}

fn split_payload<'a>(request: &Value, payload: &'a [u8], field: &str) -> Result<(&'a [u8], &'a [u8]), OpResponse> {
    let first: usize = parse(request, field)?;
    if first > payload.len() {
        return Err(invalid(format!("{field} is longer than the payload")));
    }
    Ok(payload.split_at(first))
}

fn utf8(request: &Value, field: &str) -> Result<String, OpResponse> {
    parse(request, field)
}

fn text_of<'a>(bytes: &'a [u8], field: &str) -> Result<&'a str, OpResponse> {
    std::str::from_utf8(bytes).map_err(|_| invalid(format!("{field} is not valid UTF-8")))
}

/// Both texts travel in the payload (`oldLength` bytes of the old one, then the new one) and the
/// diff comes back as the payload, so a large file never meets the header size limit.
fn diff_text(request: &Value, payload: &[u8]) -> OpResponse {
    let run = || -> Result<OpResponse, OpResponse> {
        let (old, new) = split_payload(request, payload, "oldLength")?;
        let (old, new) = (text_of(old, "old")?, text_of(new, "new")?);
        let (old_name, new_name) = (utf8(request, "oldName")?, utf8(request, "newName")?);
        let options = TextDiffOptions { max_matrix_cells: optional(request, "maxMatrixCells")?, context: optional(request, "context")? };
        crate::diff::check_options(&options).map_err(StoreError::into_response)?;
        let diff = unified_text_diff(old, new, &old_name, &new_name, &options);
        Ok(OpResponse::ok_with_payload(json!({ "length": diff.len() }), diff.into_bytes()))
    };
    run().unwrap_or_else(|response| response)
}

type ManagedSources = (Vec<SourceFile>, Option<String>, Vec<ProposedChange>);

fn managed_sources(request: &Value) -> Result<ManagedSources, OpResponse> {
    Ok((parse(request, "sources")?, optional(request, "manifestText")?, parse(request, "proposed")?))
}

fn rule_of(request: &Value, field: &str) -> Result<Option<PathRule>, OpResponse> {
    let rule: Option<PathRule> = optional(request, field)?;
    if let Some(rule) = &rule {
        rule.validate().map_err(StoreError::into_response)?;
    }
    Ok(rule)
}

fn managed_plan(request: &Value) -> OpResponse {
    let run = || -> Result<StoreResult<Value>, OpResponse> {
        let (sources, text, proposed) = managed_sources(request)?;
        let manifest_path: String = parse(request, "manifestPath")?;
        let operation_id: String = parse(request, "operationId")?;
        let permits = rule_of(request, "permits")?.ok_or_else(|| invalid("the request needs permits"))?;
        let releasable = rule_of(request, "releasable")?;
        Ok(plan_managed_outputs(&PlanInput {
            manifest_path: &manifest_path,
            sources: &sources,
            manifest_text: text.as_deref(),
            proposed: &proposed,
            operation_id: &operation_id,
            permits: &permits,
            releasable: releasable.as_ref(),
        })
        .map(|plan| json!(plan)))
    };
    match run() {
        Ok(outcome) => answer(outcome),
        Err(response) => response,
    }
}

fn managed_refresh(request: &Value) -> OpResponse {
    let run = || -> Result<StoreResult<Value>, OpResponse> {
        let (sources, text, proposed) = managed_sources(request)?;
        let manifest_path: String = parse(request, "manifestPath")?;
        let manifest_written: Option<String> = optional(request, "manifestWritten")?;
        let addable = rule_of(request, "addable")?;
        let always_scanned = rule_of(request, "alwaysScanned")?;
        let input = RefreshInput {
            manifest_path: &manifest_path,
            sources: &sources,
            manifest_text: text.as_deref(),
            proposed: &proposed,
            manifest_written: manifest_written.as_deref(),
            manifest_deleted: optional(request, "manifestDeleted")?.unwrap_or(false),
            adopt_all: optional(request, "adoptAll")?.unwrap_or(false),
            addable: addable.as_ref(),
            adopt_unrecorded: optional(request, "adoptUnrecorded")?.unwrap_or(false),
            always_scanned: always_scanned.as_ref(),
        };
        Ok(refresh_managed_outputs(&input).map(|refresh| json!({ "refresh": refresh })))
    };
    match run() {
        Ok(outcome) => answer(outcome),
        Err(response) => response,
    }
}

fn sweep(request: &Value) -> OpResponse {
    let run = || -> Result<StoreResult<Value>, OpResponse> {
        let parent: String = parse(request, "parent")?;
        let options = SweepOptions {
            reference_snapshots_only: optional(request, "referenceSnapshotsOnly")?.unwrap_or(false),
            owned_fixtures_only: optional(request, "ownedFixturesOnly")?.unwrap_or(false),
            now_ms: optional(request, "now")?,
            stale_ms: optional(request, "staleMs")?,
            max_bytes: optional(request, "maxBytes")?,
            protected_roots: optional(request, "protectedRoots")?.unwrap_or_default(),
            current_uid: optional(request, "currentUid")?,
        };
        Ok(sweep_temporary_directories(std::path::Path::new(&parent), &options, &process_alive)
            .map(|outcome| json!({ "removed": outcome.removed, "retainedBytes": outcome.retained_bytes })))
    };
    match run() {
        Ok(outcome) => answer(outcome),
        Err(response) => response,
    }
}

fn budget_of(request: &Value) -> Result<RenderBudget, OpResponse> {
    Ok(RenderBudget { reserved_pixels: optional(request, "reservedPixels")?.unwrap_or(0) })
}

/// Adds this crate's engine operations to the registry `hoi4-engine serve` dispatches through.
pub fn register(registry: &mut Registry) {
    registry.add_fn("artifacts.put", |_: &OpContext, request, payload| put(request, payload, false));
    registry.add_fn("artifacts.put_chunked", |_: &OpContext, request, payload| put(request, payload, true));
    registry.add_fn("artifacts.release", |_: &OpContext, request, _| {
        let created: Created = match parse(request, "created") {
            Ok(created) => created,
            Err(response) => return response,
        };
        with_store(request, |store, workspace| store.release(workspace, &created).map(|()| json!({})))
    });
    registry.add_fn("artifacts.commit", |_: &OpContext, request, _| {
        let created: Created = match parse(request, "created") {
            Ok(created) => created,
            Err(response) => return response,
        };
        with_store(request, |store, workspace| store.commit(workspace, &created).map(|()| json!({})))
    });
    registry.add_fn("artifacts.read", |_: &OpContext, request, _| read_op(request, false));
    registry.add_fn("artifacts.read_logical", |_: &OpContext, request, _| read_op(request, true));
    registry.add_fn("artifacts.describe", |_: &OpContext, request, _| {
        let uri: String = match parse(request, "uri") {
            Ok(uri) => uri,
            Err(response) => return response,
        };
        with_store(request, |store, workspace| store.describe(workspace, &uri).map(|artifact| json!(artifact)))
    });
    registry.add_fn("artifacts.available", |_: &OpContext, request, _| {
        let uris: Vec<String> = match parse(request, "uris") {
            Ok(uris) => uris,
            Err(response) => return response,
        };
        with_store(request, |store, workspace| store.available(workspace, &uris).map(|available| json!({ "available": available })))
    });
    registry.add_fn("artifacts.list", |_: &OpContext, request, _| {
        with_store(request, |store, workspace| store.list(workspace).map(|artifacts| json!({ "artifacts": artifacts })))
    });
    registry.add_fn("artifacts.list_page", |_: &OpContext, request, _| {
        let limit: usize = match parse(request, "limit") {
            Ok(limit) => limit,
            Err(response) => return response,
        };
        let after: Option<String> = match optional(request, "afterUri") {
            Ok(after) => after,
            Err(response) => return response,
        };
        with_store(request, |store, workspace| store.list_page(workspace, limit, after.as_deref()).map(|page| json!(page)))
    });
    registry.add_fn("artifacts.source_hash_evidence", |_: &OpContext, request, _| {
        let hashes: std::collections::BTreeMap<String, String> = match parse(request, "sourceHashes") {
            Ok(hashes) => hashes,
            Err(response) => return response,
        };
        OpResponse::ok(bounded_source_hash_evidence(&hashes))
    });
    registry.add_fn("artifacts.changed_summary", |_: &OpContext, request, _| {
        let run = || -> Result<Value, OpResponse> {
            let files: Vec<ChangedFileIdentity> = parse(request, "files")?;
            let limit: Option<usize> = optional(request, "limit")?;
            Ok(json!(summarize_changed_files(&files, limit.unwrap_or(40))))
        };
        run().map_or_else(|response| response, OpResponse::ok)
    });
    registry.add_fn("artifacts.managed_plan", |_: &OpContext, request, _| managed_plan(request));
    registry.add_fn("artifacts.managed_refresh", |_: &OpContext, request, _| managed_refresh(request));
    registry.add_fn("artifacts.sweep_temporary", |_: &OpContext, request, _| sweep(request));
    registry.add_fn("diff.text", |_: &OpContext, request, payload| diff_text(request, payload));
    registry.add_fn("diff.binary", |_: &OpContext, request, payload| match split_payload(request, payload, "oldLength") {
        Ok((old, new)) => OpResponse::ok(json!(binary_diff(old, new))),
        Err(response) => response,
    });
    registry.add_fn("diff.image", |_: &OpContext, request, payload| {
        let run = || -> Result<OpResponse, OpResponse> {
            let (left, right) = split_payload(request, payload, "leftLength")?;
            let threshold: f64 = optional(request, "threshold")?.unwrap_or(8.0);
            let mut budget = budget_of(request)?;
            Ok(match compare_png_images(left, right, threshold, &mut budget) {
                Ok(comparison) => {
                    let mut result = json!(comparison);
                    result["reservedPixels"] = json!(budget.reserved_pixels);
                    OpResponse::ok_with_payload(result, comparison.png)
                }
                Err(error) => error.into_response(),
            })
        };
        run().unwrap_or_else(|response| response)
    });
    registry.add_fn("diff.transparent_png", |_: &OpContext, request, _| {
        let run = || -> Result<OpResponse, OpResponse> {
            let (width, height): (u64, u64) = (parse(request, "width")?, parse(request, "height")?);
            let label: String = parse(request, "label")?;
            let mut budget = budget_of(request)?;
            Ok(match create_transparent_png(width, height, &label, &mut budget) {
                Ok(png) => OpResponse::ok_with_payload(json!({ "reservedPixels": budget.reserved_pixels }), png),
                Err(error) => error.into_response(),
            })
        };
        run().unwrap_or_else(|response| response)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Registry {
        let mut registry = Registry::new();
        register(&mut registry);
        registry
    }

    fn call(registry: &Registry, name: &str, request: Value, payload: &[u8]) -> OpResponse {
        registry.dispatch(name, &OpContext::default(), &request, payload).expect("operation is registered")
    }

    #[test]
    fn registers_every_operation_once() {
        let registry = registry();
        assert_eq!(registry.check(), Ok(()));
        for name in [
            "artifacts.put",
            "artifacts.commit",
            "artifacts.read",
            "artifacts.list_page",
            "artifacts.managed_plan",
            "artifacts.changed_summary",
            "diff.text",
            "diff.binary",
            "diff.image",
        ] {
            assert!(registry.contains(name), "{name}");
        }
    }

    #[test]
    fn diff_text_and_binary_answer_over_the_wire() {
        let registry = registry();
        let text = call(&registry, "diff.text", json!({ "oldLength": 2, "oldName": "a/x", "newName": "b/x", "context": 3 }), b"a\nb\n");
        assert_eq!(text.payload, b"--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n+b\n-a");
        assert_eq!(text.result.unwrap()["length"], 37);
        let binary = call(&registry, "diff.binary", json!({ "oldLength": 2 }), &[1, 2, 1, 9]);
        assert_eq!(binary.result.unwrap(), json!({ "oldSize": 2, "newSize": 2, "changedBytes": 1, "firstChangedOffset": 1, "lastChangedOffset": 1 }));
        let bad = call(&registry, "diff.text", json!({ "oldName": "a", "newName": "b" }), &[]);
        assert_eq!(bad.result.unwrap_err()["code"], "invalid_request");
        let not_utf8 = call(&registry, "diff.text", json!({ "oldLength": 1, "oldName": "a", "newName": "b" }), &[0xff, b'x']);
        assert_eq!(not_utf8.result.unwrap_err()["code"], "invalid_request");
        // A diff far past the header size limit still comes back, in the payload.
        let big_old: String = (0..60_000).map(|n| format!("line number {n}\n")).collect();
        let big_new = big_old.replace("line number 30000\n", "changed\n");
        let mut payload = big_old.clone().into_bytes();
        payload.extend_from_slice(big_new.as_bytes());
        let big = call(&registry, "diff.text", json!({ "oldLength": big_old.len(), "oldName": "a", "newName": "b" }), &payload);
        assert!(big.payload.len() > 1_048_576);
        assert!(big.result.unwrap()["length"].as_u64().unwrap() > 1_048_576);
    }

    #[test]
    fn store_round_trip_and_errors_keep_their_codes() {
        let registry = registry();
        let dir = tempfile::tempdir().unwrap();
        let workspace =
            json!({ "id": "w", "artifactRoot": dir.path().to_string_lossy(), "workspaceIdentity": "a".repeat(64), "ownerIdentity": "b".repeat(64) });
        let provenance = json!({ "kind": "k", "toolVersion": "1", "schemaVersion": "1", "sourceHashes": {} });
        let put = call(
            &registry,
            "artifacts.put",
            json!({ "workspace": workspace, "writes": [{ "name": "a.txt", "mimeType": "text/plain", "length": 3, "provenance": provenance }] }),
            b"abc",
        );
        let result = put.result.unwrap();
        let uri = result["artifacts"][0]["uri"].as_str().unwrap().to_owned();
        let read = call(&registry, "artifacts.read", json!({ "workspace": workspace, "uri": uri, "range": { "offset": 1, "length": 5 } }), &[]);
        assert_eq!(read.payload, b"bc");
        assert_eq!(read.result.unwrap()["totalSize"], 3);
        let missing = call(&registry, "artifacts.read", json!({ "workspace": workspace, "uri": uri.replace('a', "b") }), &[]);
        assert!(missing.result.unwrap_err()["code"].as_str().unwrap().starts_with("ARTIFACT_"));
        let short = call(
            &registry,
            "artifacts.put",
            json!({ "workspace": workspace, "writes": [{ "name": "a.txt", "mimeType": "text/plain", "length": 9, "provenance": provenance }] }),
            b"abc",
        );
        assert_eq!(short.result.unwrap_err()["code"], "invalid_request");
        let created = result["created"].clone();
        let released = call(&registry, "artifacts.release", json!({ "workspace": workspace, "created": created }), &[]);
        assert!(released.result.is_ok());
    }

    #[test]
    fn retention_is_requested_only_when_eviction_is_needed() {
        let registry = registry();
        let dir = tempfile::tempdir().unwrap();
        let workspace =
            json!({ "id": "w", "artifactRoot": dir.path().to_string_lossy(), "workspaceIdentity": "a".repeat(64), "ownerIdentity": "b".repeat(64) });
        let provenance = json!({ "kind": "k", "toolVersion": "1", "schemaVersion": "1", "sourceHashes": {} });
        let limits = json!({ "maxEntries": 1, "maxBytes": 100000, "maxSingleBytes": 1000 });
        let one = |name: &str, extra: Value| {
            let mut request = json!({ "workspace": workspace, "limits": limits, "retentionPending": true, "writes": [{ "name": name, "mimeType": "text/plain", "length": 1, "provenance": provenance }] });
            request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            call(&registry, "artifacts.put", request, b"x")
        };
        let first = one("a", json!({})).result.unwrap();
        // The caller commits the first put, so it no longer holds its artifact against eviction.
        assert!(call(&registry, "artifacts.commit", json!({ "workspace": workspace, "created": first["created"].clone() }), &[]).result.is_ok());
        let needed = one("b", json!({})).result.unwrap_err();
        assert_eq!(needed["code"], "ARTIFACT_RETENTION_REQUIRED");
        assert!(one("b", json!({ "retainedUris": [] })).result.is_ok());
    }

    #[test]
    fn managed_plan_and_changed_summary_over_the_wire() {
        let registry = registry();
        let plan = call(
            &registry,
            "artifacts.managed_plan",
            json!({
                "manifestPath": ".world.json", "operationId": "op", "sources": [], "proposed": [{ "relativePath": "map/a.txt", "sha256": "c".repeat(64), "operationIds": ["op"] }],
                "permits": { "any": [{ "dir": { "dirs": ["map"], "files": ["a.txt"] } }] },
            }),
            &[],
        );
        let result = plan.result.unwrap();
        assert_eq!(result["written"], json!(["map/a.txt"]));
        let bad = call(
            &registry,
            "artifacts.managed_plan",
            json!({ "manifestPath": "m", "operationId": "o", "sources": [], "proposed": [], "permits": { "dir": { "dirs": [], "pattern": "(" } } }),
            &[],
        );
        assert_eq!(bad.result.unwrap_err()["code"], "MANAGED_OUTPUT_RULE_INVALID");
        let summary =
            call(&registry, "artifacts.changed_summary", json!({ "files": [{ "relativePath": "a/b.txt", "beforeSha256": null, "afterSha256": "x" }] }), &[]);
        assert_eq!(summary.result.unwrap()["created"], 1);
    }
}

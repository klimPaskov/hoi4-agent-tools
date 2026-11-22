//! The engine operations `txn.apply` and `txn.recover`.
//!
//! New in the parallel port (ADR 0091); they carry the one-call rewrite of
//! `src/hoi4_agent_tools/core/transactions.ts` (`plan` then `apply`, and `recover`) to the engine,
//! commit `9b7dc80d`.
//!
//! `txn.apply` request: `{ workspaceId, modRoot, cacheRoot, artifactRoot?, lockWaitMs?,
//! operationKind, diagnostics?, changes: [{ path, beforeSha256, afterSize }] }`, with the new
//! bytes of every change whose `afterSize` is not null concatenated in the payload, in order.
//! Answer: `{ changedPaths }`, or an error `{ code, message, diagnostics }`.
//!
//! `txn.recover` request: `{ workspaceId, modRoot, cacheRoot, artifactRoot?, lockWaitMs? }`.
//! Answer: `{ recovered }`, the number of interrupted rewrites restored.

use std::path::Path;
use std::time::Duration;

use hoi4_core::diagnostics::Diagnostic;
use hoi4_core::ops::{OpContext, OpResponse, Registry};
use hoi4_core::plan::{FileChange, PlanApplier, Refusal, RewritePlan};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::applier::TxnApplier;
use crate::paths::Workspace;

/// The longest lock wait a request may ask for.
const MAX_LOCK_WAIT_MS: u64 = 600_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRequest {
    workspace_id: String,
    mod_root: String,
    cache_root: String,
    #[serde(default)]
    artifact_root: Option<String>,
    #[serde(default)]
    lock_wait_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeRequest {
    path: String,
    before_sha256: Option<String>,
    after_size: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyRequest {
    operation_kind: String,
    changes: Vec<ChangeRequest>,
    #[serde(default)]
    diagnostics: Vec<Diagnostic>,
}

fn refused(refusal: Refusal) -> OpResponse {
    OpResponse { result: Err(json!({ "code": refusal.code, "message": refusal.message, "diagnostics": refusal.diagnostics })), payload: Vec::new() }
}

fn applier(request: &Value) -> Result<TxnApplier, OpResponse> {
    let workspace: WorkspaceRequest =
        serde_json::from_value(request.clone()).map_err(|error| OpResponse::error("invalid_request", format!("txn: bad workspace fields: {error}")))?;
    let wait = workspace.lock_wait_ms.unwrap_or(0);
    if wait > MAX_LOCK_WAIT_MS {
        return Err(OpResponse::error("invalid_request", format!("txn: lockWaitMs is above {MAX_LOCK_WAIT_MS}")));
    }
    let opened = Workspace::open(Path::new(&workspace.mod_root), Path::new(&workspace.cache_root), workspace.artifact_root.as_deref().map(Path::new))
        .map_err(refused)?;
    Ok(TxnApplier::new(workspace.workspace_id, opened).with_lock_wait(Duration::from_millis(wait)))
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Splits the payload into the plan's new bytes.
fn plan_from(request: &Value, payload: &[u8]) -> Result<RewritePlan, OpResponse> {
    let apply: ApplyRequest = serde_json::from_value(request.clone()).map_err(|error| OpResponse::error("invalid_request", format!("txn.apply: {error}")))?;
    let workspace_id = request["workspaceId"].as_str().unwrap_or_default().to_owned();
    let mut offset = 0_usize;
    let mut changes = Vec::with_capacity(apply.changes.len());
    for change in apply.changes {
        if change.before_sha256.as_deref().is_some_and(|hash| !is_sha256(hash)) {
            return Err(OpResponse::error("invalid_request", "txn.apply: beforeSha256 is not a lowercase SHA-256"));
        }
        let after = match change.after_size {
            Some(size) => {
                let end = usize::try_from(size).ok().and_then(|size| offset.checked_add(size)).filter(|end| *end <= payload.len());
                let Some(end) = end else {
                    return Err(OpResponse::error("invalid_request", "txn.apply: the payload is shorter than the changes' afterSize"));
                };
                let bytes = payload[offset..end].to_vec();
                offset = end;
                Some(bytes)
            }
            None => None,
        };
        changes.push(FileChange { path: change.path, before_sha256: change.before_sha256, after });
    }
    if offset != payload.len() {
        return Err(OpResponse::error("invalid_request", "txn.apply: the payload is longer than the changes' afterSize"));
    }
    Ok(RewritePlan { workspace_id, operation_kind: apply.operation_kind, changes, diagnostics: apply.diagnostics })
}

fn apply(request: &Value, payload: &[u8]) -> OpResponse {
    let plan = match plan_from(request, payload) {
        Ok(plan) => plan,
        Err(response) => return response,
    };
    let applier = match applier(request) {
        Ok(applier) => applier,
        Err(response) => return response,
    };
    match applier.apply(&plan) {
        Ok(applied) => OpResponse::ok(json!({ "changedPaths": applied.changed_paths })),
        Err(refusal) => refused(refusal),
    }
}

fn recover(request: &Value) -> OpResponse {
    let applier = match applier(request) {
        Ok(applier) => applier,
        Err(response) => return response,
    };
    match applier.recover() {
        Ok(recovered) => OpResponse::ok(json!({ "recovered": recovered })),
        Err(refusal) => refused(refusal),
    }
}

pub fn register(registry: &mut Registry) {
    registry.add_fn("txn.apply", |_: &OpContext, request, payload| apply(request, payload));
    registry.add_fn("txn.recover", |_: &OpContext, request, _| recover(request));
}

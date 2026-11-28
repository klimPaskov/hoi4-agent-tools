//! The engine operations `txn.apply` and `txn.recover`.
//!
//! New in the parallel port (ADR 0091); they carry the one-call rewrite of
//! `src/hoi4_agent_tools/core/transactions.ts` (`plan` then `apply`, and `recover`) to the engine,
//! commit `9b7dc80d`.
//!
//! Both take the workspace as the TypeScript server resolved it: `{ workspaceId,
//! workspaceIdentity, rootFingerprint, principal?, modRoot, cacheRoot, artifactRoot?,
//! serverStateRoot, journalKey, lockWaitMs? }`. `journalKey` is the server's journal key in hex;
//! it is never logged or echoed.
//!
//! `txn.apply` adds `{ operationKind, diagnostics?, changes: [{ path, beforeSha256, afterSize }] }`,
//! with the new bytes of every change whose `afterSize` is not null concatenated in the payload,
//! in order. Answer: `{ changedPaths }`, or an error `{ code, message, diagnostics? }` (a refused
//! rollback adds `retainedBackupCount` and `retainedBackups`, as the TypeScript details).
//!
//! `txn.recover` answers `{ recovered }`, the number of interrupted rewrites restored.

use std::path::Path;
use std::time::Duration;

use hoi4_core::diagnostics::Diagnostic;
use hoi4_core::ops::{OpContext, OpResponse, Registry};
use hoi4_core::plan::{FileChange, PlanApplier, Refusal, RewritePlan};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::applier::TxnApplier;
use crate::journal::Binding;
use crate::paths::Workspace;
use crate::state::{ServerState, is_sha256};

/// The longest lock wait a request may ask for.
const MAX_LOCK_WAIT_MS: u64 = 600_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRequest {
    workspace_id: String,
    workspace_identity: String,
    root_fingerprint: String,
    #[serde(default)]
    principal: Option<String>,
    server_state_root: String,
    journal_key: String,
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

/// The error of a refused call: `{ code, message, ... }`. The keys after the message become the
/// TypeScript `ServiceError` details. A refused rollback names the backups it left in the
/// workspace; the engine carries them as one diagnostic (`RETAINED_BACKUPS_CODE`), which is
/// mapped back here to the manager's own details, `retainedBackupCount` and `retainedBackups`,
/// so the refusal has the same fields as `withRetainedBackups` in `transactions.ts`. Other
/// diagnostics stay under `diagnostics`, and only when there are any.
fn refused(mut refusal: Refusal) -> OpResponse {
    let mut error = serde_json::Map::new();
    error.insert("code".into(), json!(refusal.code));
    error.insert("message".into(), json!(refusal.message));
    if let Some(at) = refusal.diagnostics.iter().position(|diagnostic| diagnostic.code == crate::RETAINED_BACKUPS_CODE) {
        let retained = refusal.diagnostics.remove(at);
        for (key, value) in retained.details.into_iter().flatten() {
            error.insert(key, value);
        }
    }
    if !refusal.diagnostics.is_empty() {
        error.insert("diagnostics".into(), json!(refusal.diagnostics));
    }
    OpResponse { result: Err(Value::Object(error)), payload: Vec::new() }
}

fn applier(request: &Value) -> Result<TxnApplier, OpResponse> {
    // The key is a field of the request, so a parse error names no values.
    let workspace: WorkspaceRequest =
        serde_json::from_value(request.clone()).map_err(|_| OpResponse::error("invalid_request", "txn: the workspace fields are missing or malformed"))?;
    if !is_sha256(&workspace.workspace_identity) || !is_sha256(&workspace.root_fingerprint) {
        return Err(OpResponse::error("invalid_request", "txn: workspaceIdentity and rootFingerprint must be lowercase SHA-256"));
    }
    let state = ServerState::open(Path::new(&workspace.server_state_root), &workspace.journal_key).map_err(refused)?;
    let wait = workspace.lock_wait_ms.unwrap_or(0);
    if wait > MAX_LOCK_WAIT_MS {
        return Err(OpResponse::error("invalid_request", format!("txn: lockWaitMs is above {MAX_LOCK_WAIT_MS}")));
    }
    let opened = Workspace::open(Path::new(&workspace.mod_root), Path::new(&workspace.cache_root), workspace.artifact_root.as_deref().map(Path::new))
        .map_err(refused)?;
    let binding = Binding {
        workspace_id: workspace.workspace_id,
        workspace_identity: workspace.workspace_identity,
        root_fingerprint: workspace.root_fingerprint,
        principal: workspace.principal,
    };
    Ok(TxnApplier::new(opened, binding, state).with_lock_wait(Duration::from_millis(wait)))
}

/// Splits the payload into the plan's new bytes.
fn plan_from(request: &Value, payload: &[u8]) -> Result<RewritePlan, OpResponse> {
    let apply: ApplyRequest =
        serde_json::from_value(request.clone()).map_err(|_| OpResponse::error("invalid_request", "txn.apply: the plan fields are missing or malformed"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use hoi4_core::diagnostics::{Category, Severity};

    fn retained(paths: &[&str]) -> Diagnostic {
        let mut diagnostic = Diagnostic::new(crate::RETAINED_BACKUPS_CODE, Severity::Info, Category::Validation, "backups stay");
        let mut details = serde_json::Map::new();
        details.insert("retainedBackupCount".into(), json!(paths.len()));
        details.insert("retainedBackups".into(), json!(paths));
        diagnostic.details = Some(details);
        diagnostic
    }

    /// A refused rollback's retained backups are the same top-level fields the TypeScript manager
    /// puts in the refusal's details, and the diagnostic itself is not repeated.
    #[test]
    fn a_refused_rollback_carries_the_typescript_details() {
        let mut refusal = Refusal::new("TRANSACTION_ROLLBACK_STALE", "stale");
        refusal.diagnostics.push(retained(&["common/two.txt"]));
        let Err(error) = refused(refusal).result else { panic!("an error answer") };
        assert_eq!(error, json!({ "code": "TRANSACTION_ROLLBACK_STALE", "message": "stale", "retainedBackupCount": 1, "retainedBackups": ["common/two.txt"] }));
    }

    #[test]
    fn other_diagnostics_stay_and_an_empty_list_is_left_out() {
        let note = Diagnostic::new("NOTE", Severity::Info, Category::Validation, "note");
        let mut refusal = Refusal::new("TRANSACTION_VALIDATION_BLOCKED", "blocked");
        refusal.diagnostics = vec![note.clone(), retained(&["a.txt"])];
        let Err(error) = refused(refusal).result else { panic!("an error answer") };
        assert_eq!(error["diagnostics"], json!([note]));
        assert_eq!(error["retainedBackupCount"], json!(1));
        let Err(plain) = refused(Refusal::new("TRANSACTION_STALE", "stale")).result else { panic!("an error answer") };
        assert_eq!(plain, json!({ "code": "TRANSACTION_STALE", "message": "stale" }));
    }
}

//! The atomic rewrite engine: writes a [`RewritePlan`] whole or refuses it.
//!
//! Ported from `src/hoi4_agent_tools/core/transactions.ts` (`TransactionManager.plan`,
//! `commitPlannedJournal`, `pruneExpiredJournals`, `apply`, `recover`, `recoverTransaction`,
//! `assertRecoveryPrincipal`, `restoreInterruptedTransaction`, `restoreBeforeState`, `safeFailure`,
//! `TransactionHooks`), commit `9b7dc80d`. The TypeScript manager plans and applies in two calls
//! bound by a plan hash; the engine plans and applies in one call under one hold of the workspace
//! lock, writing the same journal, so a tool call writes the whole plan or refuses it and nothing
//! about the journal reaches agents.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use hoi4_core::canonical::{canonical_json, compare_code_units, hash_canonical, sha256_hex};
use hoi4_core::diagnostics::has_blocking;
use hoi4_core::plan::{Applied, PlanApplier, Refusal, RewritePlan};
use rayon::prelude::*;
use serde_json::{Value, json};

use crate::fsutil::{durable_write, exists, file_identity, hash_regular, iso_time, now_ms, random_id, read_regular, with_suffix};
use crate::journal::{
    Binding, Failure, FileRecord, HeadMode, JOURNAL_FOLDER, JOURNAL_VERSION, Journal, Manifest, PendingFile, PlanPayload, RollbackStatus, State, infer_media_type,
};
use crate::limits::{JOURNAL_TTL_SECONDS, MAX_DIAGNOSTICS, MAX_FILES, MAX_JOURNAL_BYTES, MAX_JOURNALS, batch_size};
use crate::lock::WorkspaceLock;
use crate::paths::{Workspace, canonical_path, io_refusal, path_key, same_path};
use crate::state::ServerState;

/// Points where tests stop or disturb a rewrite, as the TypeScript `TransactionHooks` do.
pub(crate) trait Hooks: Send + Sync {
    fn after_stage(&self, _relative_path: &str) -> Result<(), Refusal> {
        Ok(())
    }
    fn after_batch_intent(&self, _relative_paths: &[String]) -> Result<(), Refusal> {
        Ok(())
    }
    fn after_replace(&self, _relative_path: &str, _index: usize) -> Result<(), Refusal> {
        Ok(())
    }
    fn before_post_validation(&self) -> Result<(), Refusal> {
        Ok(())
    }
}

/// The rules a negative test proves by dropping them (tests only).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum Rule {
    StaleSource,
    ReplaceRecheck,
    Duplicate,
    PathContainment,
    JournalContainment,
    JournalAuthentication,
    RollbackGuard,
    Recovery,
    Limits,
    WriteVerification,
}

/// The variable that makes the engine abort right after replacing the file at this index: the
/// crash the cross-recovery tests of the TypeScript server need from a real engine process.
pub const TEST_ABORT_VARIABLE: &str = "HOI4_TXN_TEST_ABORT_AFTER_REPLACE";

/// One file of a plan, resolved and read.
struct Work {
    relative_path: String,
    target: PathBuf,
    before: Option<Vec<u8>>,
    before_sha256: Option<String>,
    after: Option<Vec<u8>>,
    after_sha256: Option<String>,
}

fn invalid_manifest() -> Refusal {
    Refusal::new("TRANSACTION_MANIFEST_INVALID", "Transaction manifest is invalid")
}

/// The applier of one writable workspace.
pub struct TxnApplier {
    workspace: Workspace,
    binding: Binding,
    state: ServerState,
    lock_wait: Duration,
    ttl_seconds: u64,
    max_journal_bytes: u64,
    max_journals: usize,
    hooks: Option<Arc<dyn Hooks>>,
    #[cfg(test)]
    dropped: BTreeSet<Rule>,
}

impl TxnApplier {
    pub fn new(workspace: Workspace, binding: Binding, state: ServerState) -> Self {
        Self {
            workspace,
            binding,
            state,
            lock_wait: Duration::ZERO,
            ttl_seconds: JOURNAL_TTL_SECONDS,
            max_journal_bytes: MAX_JOURNAL_BYTES,
            max_journals: MAX_JOURNALS,
            hooks: None,
            #[cfg(test)]
            dropped: BTreeSet::new(),
        }
    }

    /// How long to wait for another rewrite's workspace lock before refusing with
    /// `TRANSACTION_LOCKED`; refused at once by default.
    pub fn with_lock_wait(mut self, wait: Duration) -> Self {
        self.lock_wait = wait;
        self
    }

    /// The journal budget: total bytes and the number of journals kept at once.
    pub fn with_journal_budget(mut self, bytes: u64, journals: usize) -> Self {
        self.max_journal_bytes = bytes;
        self.max_journals = journals;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_hooks(mut self, hooks: Arc<dyn Hooks>) -> Self {
        self.hooks = Some(hooks);
        self
    }

    #[cfg(test)]
    pub(crate) fn dropping(mut self, rule: Rule) -> Self {
        self.dropped.insert(rule);
        self
    }

    fn enforces(&self, rule: Rule) -> bool {
        #[cfg(test)]
        {
            !self.dropped.contains(&rule)
        }
        #[cfg(not(test))]
        {
            let _ = rule;
            true
        }
    }

    fn hook(&self, call: impl FnOnce(&dyn Hooks) -> Result<(), Refusal>) -> Result<(), Refusal> {
        match &self.hooks {
            Some(hooks) => call(hooks.as_ref()),
            None => Ok(()),
        }
    }

    fn journal(&self) -> Result<Journal<'_>, Refusal> {
        if self.enforces(Rule::JournalContainment) {
            Journal::open(&self.workspace.cache_root, &self.state, &self.binding)
        } else {
            // Trusts wherever the journal folder points.
            let directory = self.workspace.cache_root.join(JOURNAL_FOLDER);
            let directory = canonical_path(&directory).unwrap_or(directory);
            Ok(Journal { directory, state: &self.state, binding: &self.binding })
        }
    }

    fn load(&self, journal: &Journal<'_>, id: &str, head: HeadMode, root_required: bool) -> Result<Manifest, Refusal> {
        match journal.load(id, head, root_required) {
            Err(refusal) if refusal.code == "TRANSACTION_MANIFEST_AUTHENTICATION_FAILED" && !self.enforces(Rule::JournalAuthentication) => {
                let path = journal.transaction_directory(id)?.join("manifest.json");
                serde_json::from_slice(&fs::read(path).map_err(|_| refusal.clone())?).map_err(|_| refusal)
            }
            other => other,
        }
    }

    fn resolve(&self, relative_path: &str) -> Result<PathBuf, Refusal> {
        if self.enforces(Rule::PathContainment) { self.workspace.resolve_write(relative_path) } else { Ok(self.workspace.mod_root.join(relative_path)) }
    }

    /// Restores every interrupted rewrite of the workspace. Returns how many were restored.
    pub fn recover(&self) -> Result<usize, Refusal> {
        let _lock = WorkspaceLock::acquire(&self.workspace.cache_root, &random_id("txn"), self.lock_wait)?;
        self.recover_locked()
    }

    fn check_limits(&self, plan: &RewritePlan) -> Result<(), Refusal> {
        if !self.enforces(Rule::Limits) {
            return Ok(());
        }
        let mut exceeded = Vec::new();
        if plan.changes.len() > MAX_FILES {
            exceeded.push(format!("{} files (limit {MAX_FILES})", plan.changes.len()));
        }
        if plan.diagnostics.len() > MAX_DIAGNOSTICS {
            exceeded.push(format!("{} diagnostics (limit {MAX_DIAGNOSTICS})", plan.diagnostics.len()));
        }
        if exceeded.is_empty() {
            return Ok(());
        }
        Err(Refusal::new(
            "TRANSACTION_STRUCTURE_LIMIT",
            format!(
                "Transaction input exceeds the supported review structure limits: {}. Combine operations into fewer entries, or split the change into transactions under the limits",
                exceeded.join(", ")
            ),
        ))
    }

    /// Resolves every change, in code-unit order of its path, refusing duplicates and aliases.
    fn resolve_all(&self, plan: &RewritePlan) -> Result<Vec<(usize, PathBuf)>, Refusal> {
        let mut order: Vec<usize> = (0..plan.changes.len()).collect();
        order.sort_by(|left, right| compare_code_units(&plan.changes[*left].path, &plan.changes[*right].path));
        // Every path check joins before the first refusal is reported.
        let resolved: Vec<Result<PathBuf, Refusal>> = order.par_iter().map(|index| self.resolve(&plan.changes[*index].path)).collect();
        let mut seen = BTreeSet::new();
        let mut targets: BTreeMap<String, &str> = BTreeMap::new();
        let mut out = Vec::with_capacity(order.len());
        for (index, target) in order.into_iter().zip(resolved) {
            let path = plan.changes[index].path.as_str();
            if !seen.insert(path) && self.enforces(Rule::Duplicate) {
                return Err(Refusal::new("TRANSACTION_DUPLICATE_FILE", format!("Transaction changes a file more than once: {path}")));
            }
            let target = target?;
            if let Some(alias) = targets.insert(path_key(&target), path)
                && self.enforces(Rule::Duplicate)
            {
                return Err(Refusal::new("TRANSACTION_DUPLICATE_FILE", format!("Transaction path aliases target the same file: {alias} and {path}")));
            }
            out.push((index, target));
        }
        Ok(out)
    }

    fn assert_recovery_principal(&self, manifest: &Manifest) -> Result<(), Refusal> {
        if let Some(principal) = &self.binding.principal
            && manifest.principal.as_ref() != Some(principal)
        {
            return Err(Refusal::new("TRANSACTION_PRINCIPAL_MISMATCH", "Transaction recovery belongs to another principal"));
        }
        Ok(())
    }

    /// `recover`: restores interrupted journals, reconciles a pending head, and removes finished
    /// reclaims and orphan heads. The lock is held.
    fn recover_locked(&self) -> Result<usize, Refusal> {
        if !self.enforces(Rule::Recovery) {
            return Ok(0);
        }
        let journal = self.journal()?;
        if !journal.exists() {
            journal.remove_orphan_heads(&[])?;
            return Ok(0);
        }
        journal.remove_reclamation_directories()?;
        let ids = journal.transaction_ids()?;
        journal.remove_orphan_heads(&ids)?;
        let mut recovered = 0;
        for id in &ids {
            // A journal folder without a manifest is a plan that never committed: nothing was
            // applied from it, and pruning removes it once it expires.
            if !journal.has_manifest(id)? {
                continue;
            }
            let manifest = self.load(&journal, id, HeadMode::None, false)?;
            self.assert_recovery_principal(&manifest)?;
            let interrupted = manifest.state.interrupted();
            if manifest.root_fingerprint != self.binding.root_fingerprint {
                // A finished journal from earlier roots needs no recovery; an interrupted one
                // cannot be replayed against changed roots.
                if interrupted {
                    return Err(Refusal::new("TRANSACTION_ROOT_CHANGED", "Workspace root configuration changed after planning"));
                }
                continue;
            }
            if !interrupted {
                match self.load(&journal, id, HeadMode::Verify, true) {
                    Ok(_) => continue,
                    Err(refusal) if refusal.code == "TRANSACTION_HEAD_RECONCILIATION_REQUIRED" => {}
                    Err(refusal) => return Err(refusal),
                }
            }
            let mut manifest = self.load(&journal, id, HeadMode::Reconcile, true)?;
            self.assert_recovery_principal(&manifest)?;
            if manifest.state.interrupted() {
                self.restore_interrupted(&journal, &mut manifest)?;
                recovered += 1;
            }
        }
        Ok(recovered)
    }

    fn restore_interrupted(&self, journal: &Journal<'_>, manifest: &mut Manifest) -> Result<(), Refusal> {
        match self.restore_before_state(journal, manifest) {
            Ok(()) => {
                manifest.state = State::RolledBack;
                manifest.failure = Some(Failure { code: "TRANSACTION_RECOVERED".into(), message: "Incomplete transaction was rolled back during recovery".into() });
                journal.write_manifest(manifest)
            }
            Err(refusal) => {
                manifest.rollback_status = RollbackStatus::Failed;
                manifest.state = State::Failed;
                manifest.failure = Some(Failure { code: refusal.code.clone(), message: "Interrupted transaction could not be recovered safely".into() });
                journal.write_manifest(manifest)?;
                Err(refusal)
            }
        }
    }

    /// `restoreBeforeState`: puts every file of an interrupted or failed rewrite back to its
    /// before bytes. Every rollback source is proven intact before any file changes, and bytes the
    /// rewrite did not produce are never overwritten.
    fn restore_before_state(&self, journal: &Journal<'_>, manifest: &mut Manifest) -> Result<(), Refusal> {
        enum Mode {
            Keep,
            Delete,
            Backup,
            Blob(Vec<u8>),
        }
        let stale = |message: &str| Refusal::new("TRANSACTION_ROLLBACK_STALE", message);
        let applied: BTreeSet<&str> = manifest.applied_files.iter().map(String::as_str).collect();
        let pending: BTreeMap<&str, &PendingFile> = manifest.pending_files.iter().flatten().map(|file| (file.relative_path.as_str(), file)).collect();
        let mut restorations: Vec<(String, PathBuf, PathBuf, PathBuf, Mode)> = Vec::with_capacity(manifest.files.len());
        for file in &manifest.files {
            let target = self.resolve(&file.relative_path)?;
            let backup = with_suffix(&target, &format!(".hoi4-agent-{}.backup", manifest.transaction_id));
            let staged = with_suffix(&target, &format!(".hoi4-agent-{}.stage", manifest.transaction_id));
            let current_hash = hash_regular(&target)?;
            let backup_exists = exists(&backup);
            let intent = pending.get(file.relative_path.as_str()).copied();
            let current_identity = if intent.is_some() { file_identity(&target)? } else { None };
            let staged_identity = if intent.is_some() { file_identity(&staged)? } else { None };
            let mut backup_valid = false;
            if backup_exists {
                if file.before_sha256.is_none() {
                    return Err(stale("Rollback encountered unexpected backup state"));
                }
                if hash_regular(&backup)? != file.before_sha256 {
                    return Err(Refusal::new("TRANSACTION_BLOB_INTEGRITY_FAILED", "Rollback backup failed integrity validation"));
                }
                backup_valid = true;
                if let Some(intent) = intent
                    && file_identity(&backup)? != intent.before_identity
                {
                    return Err(stale("Rollback backup identity differs from its authenticated intent"));
                }
            }
            // A file this rewrite never replaced keeps whatever it holds now, including an edit
            // made while the rewrite ran; it does not block restoring the others.
            let untouched = match intent {
                None => !applied.contains(file.relative_path.as_str()) && !backup_exists,
                Some(intent) => {
                    let stage_intact = intent.staged_identity.is_some() && staged_identity == intent.staged_identity;
                    !applied.contains(file.relative_path.as_str())
                        && !backup_exists
                        && (file.after_sha256.is_none() || stage_intact)
                        && !(intent.staged_identity.is_some() && current_identity == intent.staged_identity)
                }
            };
            if current_hash == file.before_sha256 || untouched {
                restorations.push((file.relative_path.clone(), target, backup, staged, Mode::Keep));
                continue;
            }
            let matches_after = current_hash == file.after_sha256
                && match intent {
                    None => true,
                    Some(_) if file.after_sha256.is_none() => backup_valid,
                    Some(intent) => staged_identity.is_none() && current_identity == intent.staged_identity,
                };
            let missing_after_backup = current_hash.is_none() && file.after_sha256.is_some() && backup_valid;
            // Only a durable rolling-back journal proves rollback had started; its verified before
            // bytes are then the one safe source for a target that is gone.
            let missing_during_blob_rollback = manifest.state == State::RollingBack && current_hash.is_none() && file.before_sha256.is_some() && !backup_valid;
            if !matches_after && !missing_after_backup && !missing_during_blob_rollback && self.enforces(Rule::RollbackGuard) {
                return Err(stale("Rollback refused to overwrite source bytes not produced by this transaction"));
            }
            let mode = if file.before_sha256.is_none() {
                Mode::Delete
            } else if backup_valid {
                Mode::Backup
            } else {
                Mode::Blob(journal.read_before_blob(manifest, file)?)
            };
            restorations.push((file.relative_path.clone(), target, backup, staged, mode));
        }
        manifest.state = State::RollingBack;
        journal.write_manifest(manifest)?;
        let failed = |error: std::io::Error| io_refusal("TRANSACTION_ROLLBACK_FAILED", "Automatic rollback could not safely complete", &error);
        let remove_if_present = |path: &Path| if exists(path) { fs::remove_file(path).map_err(failed) } else { Ok(()) };
        for (_, target, backup, staged, mode) in restorations.iter().rev() {
            match mode {
                // Renaming over the target is the atomic replacement; the verified backup stays
                // until the rename lands.
                Mode::Backup => fs::rename(backup, target).map_err(failed)?,
                // A durable same-folder write renamed over the target: no moment without bytes.
                Mode::Blob(bytes) => {
                    durable_write(target, bytes).map_err(failed)?;
                    remove_if_present(backup)?;
                }
                Mode::Delete => {
                    remove_if_present(target)?;
                    remove_if_present(backup)?;
                }
                Mode::Keep => remove_if_present(backup)?,
            }
            remove_if_present(staged)?;
        }
        let changed: BTreeSet<&str> = restorations.iter().filter(|(.., mode)| !matches!(mode, Mode::Keep)).map(|(path, ..)| path.as_str()).collect();
        for file in manifest.files.iter().filter(|file| changed.contains(file.relative_path.as_str())) {
            let target = self.resolve(&file.relative_path)?;
            if hash_regular(&target)? != file.before_sha256 {
                return Err(Refusal::new("TRANSACTION_STALE", format!("{} does not match the before hash", file.relative_path)));
            }
        }
        manifest.rollback_status = RollbackStatus::Applied;
        if manifest.pending_files.is_some() {
            manifest.pending_files = Some(Vec::new());
        }
        Ok(())
    }

    /// `pruneExpiredJournals`: removes expired planned and rolled-back journals, journals of
    /// earlier roots once they expire, headless planned or rolled-back ones, and with `reclaim`
    /// every applied journal.
    fn prune(&self, journal: &Journal<'_>, reclaim: bool) -> Result<(), Refusal> {
        let now = iso_time(now_ms());
        journal.remove_reclamation_directories()?;
        let ids = journal.transaction_ids()?;
        journal.remove_orphan_heads(&ids)?;
        for id in &ids {
            let directory = journal.transaction_directory(id)?;
            let remove_folder = || fs::remove_dir_all(&directory).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "An expired journal cannot be removed", &error));
            if !journal.has_manifest(id)? {
                let age = fs::metadata(&directory).and_then(|metadata| metadata.modified()).ok().and_then(|modified| modified.elapsed().ok());
                if age.is_some_and(|age| age.as_millis() > u128::from(self.ttl_seconds) * 1000) {
                    journal.remove(id)?;
                }
                continue;
            }
            if let Ok(recorded) = self.load(journal, id, HeadMode::None, false)
                && recorded.root_fingerprint != self.binding.root_fingerprint
            {
                // Journals from earlier roots can no longer be applied or rolled back here.
                if matches!(recorded.state, State::Planned | State::Applied | State::RolledBack | State::Failed) && recorded.expires_at <= now {
                    remove_folder()?;
                }
                continue;
            }
            let manifest = match self.load(journal, id, HeadMode::Reconcile, true) {
                Ok(manifest) => manifest,
                Err(refusal) => {
                    if refusal.code == "TRANSACTION_HEAD_MISSING"
                        && let Ok(orphan) = self.load(journal, id, HeadMode::None, true)
                        && matches!(orphan.state, State::Planned | State::RolledBack)
                    {
                        remove_folder()?;
                    }
                    // Malformed or unauthenticated journals remain visible to quota accounting.
                    continue;
                }
            };
            if reclaim && manifest.state == State::Applied {
                journal.reclaim(id)?;
            } else if manifest.expires_at <= now && matches!(manifest.state, State::Planned | State::RolledBack) {
                journal.remove(id)?;
            }
        }
        Ok(())
    }

    /// `commitPlannedJournal`: checks the journal budget, then writes the blobs, the planned
    /// manifest and its first protected head. The lock is held.
    fn commit_planned(&self, journal: &Journal<'_>, manifest: &mut Manifest, blobs: &BTreeMap<String, &[u8]>) -> Result<(), Refusal> {
        journal.create()?;
        self.prune(journal, false)?;
        let mut usage = journal.usage()?;
        let blob_bytes: u64 = blobs.values().map(|bytes| bytes.len() as u64).sum();
        // The first revision's text, sized before it is written: both hashes have a fixed length.
        let mut sized = manifest.clone();
        sized.revision = 1;
        sized.integrity_hash = "0".repeat(64);
        sized.authentication_tag = "0".repeat(64);
        let manifest_bytes = serde_json::to_value(&sized).map_err(|_| invalid_manifest())?;
        let prospective = blob_bytes.saturating_add(canonical_json(&manifest_bytes).len() as u64 + 1);
        let replacement: u64 = manifest.files.iter().map(|file| file.before_size.unwrap_or(0) + file.after_size.unwrap_or(0)).sum();
        let work = prospective.saturating_add(replacement);
        let limits = self.enforces(Rule::Limits);
        let reached = |usage: (usize, u64)| usage.0 >= self.max_journals || prospective > self.max_journal_bytes || usage.1 > self.max_journal_bytes - prospective;
        if limits && work <= self.max_journal_bytes && reached(usage) {
            self.prune(journal, true)?;
            usage = journal.usage()?;
        }
        if limits && (reached(usage) || work > self.max_journal_bytes) {
            return Err(Refusal::new(
                "TRANSACTION_JOURNAL_LIMIT",
                format!(
                    "Transaction journal retention limit has been reached: the rewrite needs {work} bytes of work and {prospective} journal bytes, {} journals of {} bytes are kept, and the limits are {} journals and {} bytes",
                    usage.0, usage.1, self.max_journals, self.max_journal_bytes
                ),
            ));
        }
        let directory = journal.transaction_directory(&manifest.transaction_id)?;
        let written = (|| {
            fs::create_dir_all(&directory).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal folder cannot be created", &error))?;
            let results: Vec<Result<(), Refusal>> = blobs.par_iter().map(|(_, bytes)| journal.write_blob(&manifest.transaction_id, bytes)).collect();
            results.into_iter().collect::<Result<Vec<()>, _>>()?;
            journal.write_manifest(manifest)
        })();
        if let Err(refusal) = written {
            let _ = journal.state.remove_head(&journal.binding.workspace_identity, &manifest.transaction_id);
            let _ = fs::remove_dir_all(&directory);
            return Err(refusal);
        }
        Ok(())
    }

    /// The planned manifest of a plan, in the TypeScript shape.
    fn planned_manifest(&self, transaction_id: &str, plan: &RewritePlan, work: &[Work]) -> Result<Manifest, Refusal> {
        let files = work
            .iter()
            .map(|item| FileRecord {
                relative_path: item.relative_path.clone(),
                operation_ids: Vec::new(),
                before_sha256: item.before_sha256.clone(),
                after_sha256: item.after_sha256.clone(),
                before_size: item.before.as_ref().map(|bytes| bytes.len() as u64),
                after_size: item.after.as_ref().map(|bytes| bytes.len() as u64),
                before_blob: item.before_sha256.as_ref().map(|hash| format!("blobs/{hash}")),
                after_blob: item.after_sha256.as_ref().map(|hash| format!("blobs/{hash}")),
                media_type: infer_media_type(&item.relative_path).into(),
                diff_artifact: None,
            })
            .collect();
        let diagnostics = plan.diagnostics.iter().map(serde_json::to_value).collect::<Result<Vec<Value>, _>>().map_err(|_| invalid_manifest())?;
        let now = now_ms();
        let empty_payload = PlanPayload {
            version: JOURNAL_VERSION,
            workspace_id: String::new(),
            principal: None,
            root_fingerprint: String::new(),
            operation_kind: String::new(),
            operations: Vec::new(),
            read_dependencies: Vec::new(),
            files: Vec::new(),
            diagnostics: Vec::new(),
            validation: Value::Null,
            artifacts: Vec::new(),
        };
        let mut manifest = Manifest {
            version: JOURNAL_VERSION,
            revision: 0,
            transaction_id: transaction_id.into(),
            workspace_id: self.binding.workspace_id.clone(),
            principal: self.binding.principal.clone(),
            root_fingerprint: self.binding.root_fingerprint.clone(),
            created_at: iso_time(now),
            expires_at: iso_time(now + self.ttl_seconds * 1000),
            state: State::Planned,
            plan_payload: empty_payload,
            plan_hash: String::new(),
            integrity_hash: String::new(),
            authentication_tag: String::new(),
            operation_kind: plan.operation_kind.clone(),
            operations: Vec::new(),
            read_dependencies: Vec::new(),
            files,
            diagnostics,
            // The writer's in-memory checks are its diagnostics; this check records the one the
            // engine makes before planning.
            validation: json!({
                "passed": true,
                "checks": [{ "id": "engine.source-hashes", "passed": true, "message": "Every source matched the hash its writer read" }],
            }),
            artifacts: Vec::new(),
            execution_artifacts: Some(Vec::new()),
            applied_files: Vec::new(),
            pending_files: None,
            rollback_status: RollbackStatus::Available,
            failure: None,
        };
        manifest.plan_payload = manifest.current_plan_payload();
        manifest.plan_hash = hash_canonical(&serde_json::to_value(&manifest.plan_payload).map_err(|_| invalid_manifest())?);
        Ok(manifest)
    }

    /// Journals, stages, replaces and verifies the changed files. The lock is held.
    fn write_locked(&self, transaction_id: &str, plan: &RewritePlan, work: Vec<Work>) -> Result<Applied, Refusal> {
        let journal = self.journal()?;
        let mut blobs: BTreeMap<String, &[u8]> = BTreeMap::new();
        for item in &work {
            for (hash, bytes) in [(&item.before_sha256, &item.before), (&item.after_sha256, &item.after)] {
                if let (Some(hash), Some(bytes)) = (hash, bytes) {
                    blobs.insert(hash.clone(), bytes);
                }
            }
        }
        let mut manifest = self.planned_manifest(transaction_id, plan, &work)?;
        self.commit_planned(&journal, &mut manifest, &blobs)?;

        manifest.state = State::Applying;
        journal.write_manifest(&mut manifest)?;
        match self.replace_all(&journal, &mut manifest, &work) {
            Ok(()) => {
                for item in &work {
                    let backup = with_suffix(&item.target, &format!(".hoi4-agent-{transaction_id}.backup"));
                    if exists(&backup) {
                        fs::remove_file(&backup).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "A replaced source backup cannot be removed", &error))?;
                    }
                }
                manifest.state = State::Applied;
                journal.write_manifest(&mut manifest)?;
                // The applied journal of a one-call rewrite is never read again.
                journal.reclaim(transaction_id)?;
                let mut changed_paths: Vec<String> = work.into_iter().map(|item| item.relative_path).collect();
                changed_paths.sort_by(|left, right| compare_code_units(left, right));
                Ok(Applied { changed_paths })
            }
            Err(error) => {
                manifest.failure = Some(Failure { code: error.code.clone(), message: "Transaction apply failed".into() });
                let rollback = self.restore_before_state(&journal, &mut manifest);
                if let Err(rollback) = &rollback {
                    manifest.rollback_status = RollbackStatus::Failed;
                    manifest.failure = Some(Failure { code: rollback.code.clone(), message: "Automatic rollback could not safely complete".into() });
                }
                manifest.state = if manifest.rollback_status == RollbackStatus::Applied { State::RolledBack } else { State::Failed };
                journal.write_manifest(&mut manifest)?;
                Err(match rollback {
                    Ok(()) => error,
                    Err(rollback) => rollback,
                })
            }
        }
    }

    fn replace_all(&self, journal: &Journal<'_>, manifest: &mut Manifest, work: &[Work]) -> Result<(), Refusal> {
        let stale = |message: &str| Refusal::new("TRANSACTION_STALE", message);
        let transaction_id = manifest.transaction_id.clone();
        let abort_after: Option<usize> = std::env::var(TEST_ABORT_VARIABLE).ok().and_then(|value| value.parse().ok());
        // Stage every new file beside its target. All staging joins before any failure is
        // handled, so no writer outlives the rollback.
        let staged: Vec<Result<Option<PathBuf>, Refusal>> = work
            .par_iter()
            .map(|item| {
                let Some(after) = &item.after else { return Ok(None) };
                let stage = with_suffix(&item.target, &format!(".hoi4-agent-{transaction_id}.stage"));
                durable_write(&stage, after).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Rewrite output cannot be staged", &error))?;
                if hash_regular(&stage)? != item.after_sha256 {
                    return Err(Refusal::new("TRANSACTION_WRITE_MISMATCH", format!("{} was staged with other bytes", item.relative_path)));
                }
                Ok(Some(stage))
            })
            .collect();
        let staged: Vec<Option<PathBuf>> = staged.into_iter().collect::<Result<_, _>>()?;
        for item in work {
            self.hook(|hooks| hooks.after_stage(&item.relative_path))?;
        }

        let size = batch_size(work.len());
        for batch in (0..work.len()).collect::<Vec<_>>().chunks(size) {
            // The write-ahead intent: which file each path and stage hold before replacement.
            let mut pending = Vec::with_capacity(batch.len());
            for &index in batch {
                let item = &work[index];
                let backup = with_suffix(&item.target, &format!(".hoi4-agent-{transaction_id}.backup"));
                if exists(&backup) {
                    return Err(stale("Unexpected backup exists before replacement"));
                }
                let before_identity = file_identity(&item.target)?;
                let staged_identity = match &staged[index] {
                    Some(stage) => file_identity(stage)?,
                    None => None,
                };
                if before_identity.is_none() != item.before_sha256.is_none() || staged_identity.is_none() != item.after_sha256.is_none() {
                    return Err(stale("Source or stage presence changed before replacement"));
                }
                pending.push(PendingFile { relative_path: item.relative_path.clone(), before_identity, staged_identity });
            }
            manifest.pending_files = Some(pending);
            journal.write_manifest(manifest)?;
            let paths: Vec<String> = batch.iter().map(|index| work[*index].relative_path.clone()).collect();
            self.hook(|hooks| hooks.after_batch_intent(&paths))?;
            for (position, &index) in batch.iter().enumerate() {
                let item = &work[index];
                let intent = manifest.pending_files.as_ref().map(|pending| pending[position].clone());
                let backup = with_suffix(&item.target, &format!(".hoi4-agent-{transaction_id}.backup"));
                if !same_path(&self.resolve(&item.relative_path)?, &item.target) {
                    return Err(stale("Canonical source path changed before replacement"));
                }
                let actual = hash_regular(&item.target)?;
                let recheck = self.enforces(Rule::ReplaceRecheck);
                if actual != item.before_sha256 && recheck {
                    return Err(stale("Source changed while transaction output was being staged"));
                }
                let staged_identity = match &staged[index] {
                    Some(stage) => file_identity(stage)?,
                    None => None,
                };
                if recheck
                    && let Some(intent) = &intent
                    && (file_identity(&item.target)? != intent.before_identity || staged_identity != intent.staged_identity)
                {
                    return Err(stale("Source or stage identity changed before replacement"));
                }
                if actual.is_some() {
                    fs::rename(&item.target, &backup).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "A source cannot be moved aside", &error))?;
                    // An edit between the hash check and the rename would otherwise be lost with
                    // the backup after a successful apply.
                    if hash_regular(&backup)? != item.before_sha256 && recheck {
                        fs::rename(&backup, &item.target).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "A source cannot be put back", &error))?;
                        return Err(stale("Source changed while transaction output was being staged"));
                    }
                }
                if let Some(stage) = &staged[index] {
                    if exists(&item.target) {
                        return Err(stale("Source target was recreated during atomic replacement"));
                    }
                    fs::rename(stage, &item.target).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Rewrite output cannot replace its source", &error))?;
                }
                manifest.applied_files.push(item.relative_path.clone());
                if abort_after == Some(index) {
                    std::process::abort();
                }
                self.hook(|hooks| hooks.after_replace(&item.relative_path, index))?;
            }
            manifest.pending_files = Some(Vec::new());
            journal.write_manifest(manifest)?;
        }

        self.hook(|hooks| hooks.before_post_validation())?;
        if self.enforces(Rule::WriteVerification) {
            let verified: Vec<Result<(), Refusal>> = work
                .par_iter()
                .map(|item| {
                    if hash_regular(&item.target)? == item.after_sha256 {
                        Ok(())
                    } else {
                        Err(Refusal::new("TRANSACTION_WRITE_MISMATCH", format!("{} does not match the after hash", item.relative_path)))
                    }
                })
                .collect();
            verified.into_iter().collect::<Result<Vec<()>, _>>()?;
        }
        Ok(())
    }
}

impl PlanApplier for TxnApplier {
    fn apply(&self, plan: &RewritePlan) -> Result<Applied, Refusal> {
        if has_blocking(&plan.diagnostics) {
            return Err(Refusal { code: "TRANSACTION_VALIDATION_BLOCKED".into(), message: "Dry-run validation did not pass".into(), diagnostics: plan.diagnostics.clone() });
        }
        if plan.workspace_id != self.binding.workspace_id {
            return Err(Refusal::new("TRANSACTION_WORKSPACE_MISMATCH", "Transaction belongs to another workspace"));
        }
        self.check_limits(plan)?;
        let resolved = self.resolve_all(plan)?;
        let transaction_id = random_id("txn");
        let _lock = WorkspaceLock::acquire(&self.workspace.cache_root, &transaction_id, self.lock_wait)?;
        self.recover_locked().map_err(|refusal| {
            Refusal::new(
                "TRANSACTION_RECOVERY_REQUIRED",
                format!("Rewrites of this workspace wait until its interrupted rewrite journal can be recovered: {}", refusal.message),
            )
        })?;
        // The stale-source check runs under the lock, against the bytes as they are now. Every
        // check joins before the first refusal is reported, and no replacement starts before.
        let read: Vec<Result<Option<Work>, Refusal>> = resolved
            .into_par_iter()
            .map(|(index, target)| {
                let change = &plan.changes[index];
                let before = read_regular(&target)?;
                let before_sha256 = before.as_deref().map(sha256_hex);
                if before_sha256 != change.before_sha256 && self.enforces(Rule::StaleSource) {
                    return Err(Refusal::new("TRANSACTION_STALE", format!("{} changed since it was read", change.path)));
                }
                if before == change.after {
                    return Ok(None);
                }
                let after_sha256 = change.after.as_deref().map(sha256_hex);
                Ok(Some(Work { relative_path: change.path.clone(), target, before, before_sha256, after: change.after.clone(), after_sha256 }))
            })
            .collect();
        let mut work = Vec::new();
        for item in read {
            if let Some(item) = item? {
                work.push(item);
            }
        }
        if work.is_empty() {
            return Ok(Applied { changed_paths: Vec::new() });
        }
        self.write_locked(&transaction_id, plan, work)
    }
}

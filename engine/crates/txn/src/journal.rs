//! The rewrite journal in the TypeScript manifest format, authenticated with the server key.
//!
//! Ported from `src/hoi4_agent_tools/core/transactions.ts` (`TransactionManifest`,
//! `TransactionPlanPayload`, `TransactionFileChange`, `TransactionPendingFile`, `inferMediaType`,
//! `manifestPlanPayload`, `immutablePlanPayload`, `manifestIntegrityPayload`,
//! `manifestAuthenticationPayload`, `authenticateManifest`, `writeManifest`, `load`,
//! `verifyManifestText`, `readVerifiedBlob`, `journalUsage`, `directoryBytes`,
//! `transactionDirectory`, `reclaimAutonomousAppliedJournal`, `removeReclamationDirectories`) and
//! `src/hoi4_agent_tools/schemas/transaction.ts` (`transactionManifestSchema`), commit `9b7dc80d`.
//!
//! Journals live in `<cache>/transactions/<txn id>/` with `manifest.json` and `blobs/<sha256>`,
//! as the TypeScript server keeps them, and each revision is recorded as a protected head in
//! server state. Either side recovers a journal the other wrote. Transaction ids name journal
//! folders only and never reach agents.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_core::canonical::{canonical_json, hash_canonical, sha256_hex};
use hoi4_core::plan::Refusal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil::{FileIdentity, durable_write, sync_directory};
use crate::limits::{
    MAX_ARTIFACTS, MAX_BATCH_FILES, MAX_DIAGNOSTICS, MAX_FILES, MAX_MANIFEST_BYTES, MAX_OPERATIONS, MAX_READ_DEPENDENCIES, MAX_VALIDATION_CHECKS,
};
use crate::paths::{contained_generated_path, io_refusal};
use crate::state::{HeadInput, ServerState, is_sha256};

pub const JOURNAL_FOLDER: &str = "transactions";
/// `TRANSACTION_VERSION` of `src/hoi4_agent_tools/version.ts`; version 1 journals are read too.
pub const JOURNAL_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Planned,
    Applying,
    Applied,
    RollingBack,
    RolledBack,
    Failed,
}

impl State {
    /// A rewrite that stopped between its first change and its end: recovery restores it.
    pub fn interrupted(self) -> bool {
        matches!(self, Self::Applying | Self::RollingBack)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackStatus {
    Available,
    Applied,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRecord {
    pub relative_path: String,
    pub operation_ids: Vec<String>,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
    pub before_size: Option<u64>,
    pub after_size: Option<u64>,
    pub before_blob: Option<String>,
    pub after_blob: Option<String>,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_artifact: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingFile {
    pub relative_path: String,
    pub before_identity: Option<FileIdentity>,
    pub staged_identity: Option<FileIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanPayload {
    pub version: u32,
    pub workspace_id: String,
    pub principal: Option<String>,
    pub root_fingerprint: String,
    pub operation_kind: String,
    pub operations: Vec<Value>,
    pub read_dependencies: Vec<Value>,
    pub files: Vec<FileRecord>,
    pub diagnostics: Vec<Value>,
    pub validation: Value,
    pub artifacts: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub revision: u64,
    pub transaction_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal: Option<String>,
    pub root_fingerprint: String,
    pub created_at: String,
    pub expires_at: String,
    pub state: State,
    pub plan_payload: PlanPayload,
    pub plan_hash: String,
    pub integrity_hash: String,
    pub authentication_tag: String,
    pub operation_kind: String,
    pub operations: Vec<Value>,
    pub read_dependencies: Vec<Value>,
    pub files: Vec<FileRecord>,
    pub diagnostics: Vec<Value>,
    pub validation: Value,
    pub artifacts: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_artifacts: Option<Vec<Value>>,
    pub applied_files: Vec<String>,
    /// The authenticated write-ahead intent of the batch in progress; absent on version 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_files: Option<Vec<PendingFile>>,
    pub rollback_status: RollbackStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
}

/// What the server binds a journal to: the workspace and its roots, and the planning principal.
#[derive(Clone, Debug)]
pub struct Binding {
    pub workspace_id: String,
    /// `ResolvedWorkspace.workspaceIdentity`: where the protected heads of this workspace live.
    pub workspace_identity: String,
    /// `transactionRootFingerprint(workspace)`: the roots a journal may be replayed against.
    pub root_fingerprint: String,
    pub principal: Option<String>,
}

/// `inferMediaType` of the TypeScript manager.
pub fn infer_media_type(relative_path: &str) -> &'static str {
    let name = relative_path.rsplit('/').next().unwrap_or(relative_path);
    let extension = name.rfind('.').filter(|index| *index > 0).map(|index| name[index..].to_lowercase()).unwrap_or_default();
    match extension.as_str() {
        ".bmp" => "image/bmp",
        ".png" => "image/png",
        ".svg" => "image/svg+xml",
        ".json" => "application/json",
        ".txt" | ".gui" | ".gfx" | ".yml" | ".csv" | ".md" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn invalid() -> Refusal {
    Refusal::new("TRANSACTION_MANIFEST_INVALID", "Transaction manifest is invalid")
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, Refusal> {
    serde_json::to_value(value).map_err(|_| invalid())
}

fn without(mut value: Value, keys: &[&str]) -> Value {
    if let Value::Object(map) = &mut value {
        for key in keys {
            map.remove(*key);
        }
    }
    value
}

impl Manifest {
    /// `manifestPlanPayload`: the plan as the manifest holds it now.
    pub fn current_plan_payload(&self) -> PlanPayload {
        PlanPayload {
            version: self.version,
            workspace_id: self.workspace_id.clone(),
            principal: self.principal.clone(),
            root_fingerprint: self.root_fingerprint.clone(),
            operation_kind: self.operation_kind.clone(),
            operations: self.operations.clone(),
            read_dependencies: self.read_dependencies.clone(),
            files: self.files.iter().map(|file| FileRecord { diff_artifact: None, ..file.clone() }).collect(),
            diagnostics: self.diagnostics.clone(),
            validation: self.validation.clone(),
            artifacts: self.artifacts.clone(),
        }
    }

    fn integrity(&self) -> Result<String, Refusal> {
        Ok(hash_canonical(&without(to_value(self)?, &["integrityHash", "authenticationTag"])))
    }

    fn authentication_text(&self) -> Result<String, Refusal> {
        Ok(canonical_json(&without(to_value(self)?, &["authenticationTag"])))
    }
}

pub fn valid_transaction_id(id: &str) -> bool {
    id.len() == 40 && id.starts_with("txn_") && id[4..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

fn valid_iso_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    // `YYYY-MM-DDTHH:MM:SS`, an optional `.` and digits, then `Z`: what `z.iso.datetime()` accepts.
    // `get` is false inside a multi-byte character, where a slice would panic on hostile text.
    let Some((head, rest)) = text.get(..19).zip(text.get(19..)) else { return false };
    bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && head.bytes().enumerate().all(|(index, b)| [4, 7, 10, 13, 16].contains(&index) || b.is_ascii_digit())
        && (rest == "Z"
            || rest
                .strip_prefix('.')
                .and_then(|fraction| fraction.strip_suffix('Z'))
                .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())))
}

fn valid_relative(path: &str) -> bool {
    hoi4_engine::workspace_paths::check_relative(path).is_ok()
}

/// The shape checks of `transactionManifestSchema` that serde does not make.
fn schema_check(manifest: &Manifest) -> bool {
    let file_ok = |file: &FileRecord| {
        valid_relative(&file.relative_path)
            && [&file.before_sha256, &file.after_sha256].iter().all(|hash| hash.as_deref().is_none_or(is_sha256))
            && [&file.before_blob, &file.after_blob].iter().all(|blob| blob.as_deref().is_none_or(valid_relative))
            && !file.media_type.is_empty()
            && file.media_type.len() <= 255
    };
    let payload = &manifest.plan_payload;
    let utf16 = |text: &str| text.encode_utf16().count();
    let identifier = |text: &str| (1..=256).contains(&utf16(text));
    let summary = |text: &str| utf16(text) <= 4_096;
    let operations_ok = |operations: &[Value]| {
        operations.len() <= MAX_OPERATIONS
            && operations.iter().all(|operation| {
                let text = |key: &str| operation.get(key).and_then(Value::as_str);
                text("id").is_some_and(identifier) && text("kind").is_some_and(identifier) && text("summary").is_some_and(summary)
            })
    };
    let validation_ok = |validation: &Value| {
        validation.get("checks").and_then(Value::as_array).is_some_and(|checks| {
            checks.len() <= MAX_VALIDATION_CHECKS
                && checks.iter().all(|check| {
                    check.get("id").and_then(Value::as_str).is_some_and(identifier) && check.get("message").and_then(Value::as_str).is_some_and(summary)
                })
        })
    };
    let principal_ok = |principal: &Option<String>| principal.as_deref().is_none_or(|text| utf16(text) <= 1_024);
    let operation_ids_ok = |file: &FileRecord| file.operation_ids.len() <= MAX_OPERATIONS && file.operation_ids.iter().all(|id| identifier(id));
    (manifest.version == 1 || manifest.version == JOURNAL_VERSION)
        && (payload.version == 1 || payload.version == JOURNAL_VERSION)
        && manifest.revision >= 1
        && valid_transaction_id(&manifest.transaction_id)
        && [&manifest.root_fingerprint, &payload.root_fingerprint, &manifest.plan_hash, &manifest.integrity_hash, &manifest.authentication_tag]
            .iter()
            .all(|hash| is_sha256(hash))
        && valid_iso_time(&manifest.created_at)
        && valid_iso_time(&manifest.expires_at)
        && manifest.files.len() <= MAX_FILES
        && payload.files.len() <= MAX_FILES
        && manifest.diagnostics.len() <= MAX_DIAGNOSTICS
        && manifest.applied_files.len() <= MAX_FILES
        && manifest.applied_files.iter().all(|path| valid_relative(path))
        && manifest.files.iter().all(file_ok)
        && payload.files.iter().all(file_ok)
        && manifest.files.iter().all(operation_ids_ok)
        && payload.files.iter().all(operation_ids_ok)
        && payload.diagnostics.len() <= MAX_DIAGNOSTICS
        && principal_ok(&manifest.principal)
        && principal_ok(&payload.principal)
        && identifier(&manifest.operation_kind)
        && identifier(&payload.operation_kind)
        && operations_ok(&manifest.operations)
        && operations_ok(&payload.operations)
        && manifest.read_dependencies.len() <= MAX_READ_DEPENDENCIES
        && payload.read_dependencies.len() <= MAX_READ_DEPENDENCIES
        && manifest.artifacts.len() <= MAX_ARTIFACTS
        && payload.artifacts.len() <= MAX_ARTIFACTS
        && manifest.execution_artifacts.as_ref().is_none_or(|artifacts| artifacts.len() <= MAX_ARTIFACTS)
        && validation_ok(&manifest.validation)
        && validation_ok(&payload.validation)
        && manifest.failure.as_ref().is_none_or(|failure| identifier(&failure.code) && summary(&failure.message))
        && manifest
            .pending_files
            .as_ref()
            .is_none_or(|pending| pending.len() <= MAX_BATCH_FILES && pending.iter().all(|file| valid_relative(&file.relative_path)))
}

/// How a load checks the manifest's protected head.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeadMode {
    Verify,
    Reconcile,
    None,
}

/// The journal storage of one workspace.
pub struct Journal<'a> {
    pub(crate) directory: PathBuf,
    pub(crate) state: &'a ServerState,
    pub(crate) binding: &'a Binding,
}

impl<'a> Journal<'a> {
    /// The journal folder under the cache root, refused when a link moves it outside.
    pub fn open(cache_root: &Path, state: &'a ServerState, binding: &'a Binding) -> Result<Self, Refusal> {
        let directory = contained_generated_path(cache_root, &[JOURNAL_FOLDER])?;
        Ok(Self { directory, state, binding })
    }

    pub fn create(&self) -> Result<(), Refusal> {
        fs::create_dir_all(&self.directory).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be created", &error))
    }

    pub fn exists(&self) -> bool {
        self.directory.is_dir()
    }

    /// The folder of one journal, checked to stay inside journal storage.
    pub fn transaction_directory(&self, transaction_id: &str) -> Result<PathBuf, Refusal> {
        if !valid_transaction_id(transaction_id) {
            return Err(Refusal::new("TRANSACTION_ID_INVALID", "Invalid transaction ID"));
        }
        contained_generated_path(&self.directory, &[transaction_id])
    }

    /// Journal folders by id, in name order. A link among them is refused.
    pub fn transaction_ids(&self) -> Result<Vec<String>, Refusal> {
        let mut ids = Vec::new();
        for entry in self.listing()? {
            let (name, file_type) = entry;
            if !valid_transaction_id(&name) {
                continue;
            }
            if file_type.is_symlink() {
                return Err(Refusal::new("TRANSACTION_JOURNAL_UNSAFE", "Transaction journal contains a symbolic link or junction"));
            }
            if file_type.is_dir() {
                ids.push(name);
            }
        }
        ids.sort();
        Ok(ids)
    }

    fn listing(&self) -> Result<Vec<(String, fs::FileType)>, Refusal> {
        let listing = match fs::read_dir(&self.directory) {
            Ok(listing) => listing,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error)),
        };
        let mut entries = Vec::new();
        for entry in listing {
            let entry = entry.map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
            let file_type = entry.file_type().map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
            entries.push((entry.file_name().to_string_lossy().into_owned(), file_type));
        }
        Ok(entries)
    }

    /// Finishes reclaims a crash interrupted: `.reclaiming-<id>` folders are removed.
    pub fn remove_reclamation_directories(&self) -> Result<(), Refusal> {
        for (name, file_type) in self.listing()? {
            if !name.strip_prefix(".reclaiming-").is_some_and(valid_transaction_id) {
                continue;
            }
            if file_type.is_symlink() || !file_type.is_dir() {
                return Err(Refusal::new("TRANSACTION_JOURNAL_UNSAFE", "Transaction journal reclamation contains an unsafe entry"));
            }
            let path = contained_generated_path(&self.directory, &[&name])?;
            fs::remove_dir_all(path).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "A reclaimed journal cannot be removed", &error))?;
        }
        Ok(())
    }

    /// Removes protected heads whose journal folder is gone.
    pub fn remove_orphan_heads(&self, journal_ids: &[String]) -> Result<(), Refusal> {
        for id in self.state.head_transaction_ids(&self.binding.workspace_identity)? {
            if !journal_ids.contains(&id) {
                self.state.remove_head(&self.binding.workspace_identity, &id)?;
            }
        }
        Ok(())
    }

    /// The count and bytes of the journals kept now.
    pub fn usage(&self) -> Result<(usize, u64), Refusal> {
        let mut count = 0;
        let mut bytes = 0_u64;
        for id in self.transaction_ids()? {
            count += 1;
            bytes = bytes.saturating_add(directory_bytes(&contained_generated_path(&self.directory, &[&id])?)?);
        }
        Ok((count, bytes))
    }

    /// Writes a blob and checks what landed on disk.
    pub fn write_blob(&self, transaction_id: &str, bytes: &[u8]) -> Result<(), Refusal> {
        let hash = sha256_hex(bytes);
        let directory = self.transaction_directory(transaction_id)?;
        let blobs = contained_generated_path(&directory, &["blobs"])?;
        fs::create_dir_all(&blobs).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Rollback data cannot be written", &error))?;
        let path = contained_generated_path(&blobs, &[&hash])?;
        durable_write(&path, bytes).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Rollback data cannot be written", &error))
    }

    /// `readVerifiedBlob`: a journal file's before bytes, checked against their size and hash.
    pub fn read_before_blob(&self, manifest: &Manifest, file: &FileRecord) -> Result<Vec<u8>, Refusal> {
        let (Some(hash), Some(size), Some(blob)) = (&file.before_sha256, file.before_size, &file.before_blob) else {
            return Err(Refusal::new("TRANSACTION_BLOB_REFERENCE_INVALID", format!("{} has an incomplete before blob reference", file.relative_path)));
        };
        if *blob != format!("blobs/{hash}") {
            return Err(Refusal::new("TRANSACTION_BLOB_REFERENCE_INVALID", format!("{} has an invalid before blob path", file.relative_path)));
        }
        let missing = || Refusal::new("TRANSACTION_BLOB_INTEGRITY_FAILED", format!("{} before rollback data is missing", file.relative_path));
        let directory = self.transaction_directory(&manifest.transaction_id).map_err(|_| missing())?;
        let path = contained_generated_path(&directory, &["blobs", hash]).map_err(|_| missing())?;
        let bytes = fs::read(path).map_err(|_| missing())?;
        if bytes.len() as u64 != size || sha256_hex(&bytes) != *hash {
            return Err(Refusal::new("TRANSACTION_BLOB_INTEGRITY_FAILED", format!("{} before rollback data failed integrity validation", file.relative_path)));
        }
        Ok(bytes)
    }

    fn head_input<'m>(&self, manifest: &'m Manifest, manifest_hash: &'m str) -> HeadInput<'m>
    where
        'a: 'm,
    {
        HeadInput {
            workspace_identity: &self.binding.workspace_identity,
            transaction_id: &manifest.transaction_id,
            revision: manifest.revision,
            authentication_tag: &manifest.authentication_tag,
            manifest_hash,
        }
    }

    /// Writes the manifest as its next revision and records it as the protected head.
    /// Sets the integrity hash and authentication tag of a manifest and returns its canonical
    /// text, without writing anything.
    pub fn seal(&self, manifest: &mut Manifest) -> Result<String, Refusal> {
        manifest.integrity_hash = manifest.integrity()?;
        manifest.authentication_tag = self.state.authenticate_canonical(&manifest.authentication_text()?)?;
        Ok(canonical_json(&to_value(&*manifest)?))
    }

    pub fn write_manifest(&self, manifest: &mut Manifest) -> Result<(), Refusal> {
        let mut candidate = manifest.clone();
        candidate.revision += 1;
        let canonical = self.seal(&mut candidate)?;
        let text = format!("{canonical}\n");
        if text.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(Refusal::new("TRANSACTION_MANIFEST_LIMIT", "Transaction manifest exceeds its fixed byte limit"));
        }
        let directory = self.transaction_directory(&candidate.transaction_id)?;
        let path = contained_generated_path(&directory, &["manifest.json"])?;
        durable_write(&path, text.as_bytes()).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Transaction manifest cannot be written", &error))?;
        sync_directory(&directory);
        let manifest_hash = sha256_hex(canonical.as_bytes());
        let input = self.head_input(&candidate, &manifest_hash);
        if candidate.revision == 1 {
            self.state.record_initial_head(&input)?
        } else {
            self.state.record_successor(&input)?
        }
        *manifest = candidate;
        Ok(())
    }

    /// Whether a journal folder holds a manifest; one without never changed a source file.
    pub fn has_manifest(&self, transaction_id: &str) -> Result<bool, Refusal> {
        Ok(contained_generated_path(&self.transaction_directory(transaction_id)?, &["manifest.json"])?.exists())
    }

    /// `load`: reads a manifest and checks its size, shape, authentication tag, identity, roots,
    /// integrity and plan hash, then its protected head.
    pub fn load(&self, transaction_id: &str, head_mode: HeadMode, root_binding_required: bool) -> Result<Manifest, Refusal> {
        let not_found = || Refusal::new("TRANSACTION_NOT_FOUND", "Transaction was not found");
        let directory = self.transaction_directory(transaction_id)?;
        let path = contained_generated_path(&directory, &["manifest.json"])?;
        let metadata = fs::metadata(&path).map_err(|_| not_found())?;
        if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
            return Err(Refusal::new("TRANSACTION_MANIFEST_LIMIT", "Transaction manifest exceeds its fixed byte limit"));
        }
        let bytes = fs::read(&path).map_err(|_| not_found())?;
        let after = fs::metadata(&path).map_err(|_| not_found())?;
        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
            return Err(Refusal::new("TRANSACTION_MANIFEST_CHANGED", "Transaction manifest changed while it was being verified"));
        }
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if !schema_check(&manifest) {
            return Err(invalid());
        }
        if !self.state.verify_canonical(&manifest.authentication_text()?, &manifest.authentication_tag) {
            return Err(Refusal::new("TRANSACTION_MANIFEST_AUTHENTICATION_FAILED", format!("Transaction manifest authentication failed: {transaction_id}")));
        }
        let mut pending_paths = std::collections::BTreeSet::new();
        for pending in manifest.pending_files.iter().flatten() {
            let file = manifest.files.iter().find(|file| file.relative_path == pending.relative_path);
            let matches = file.is_some_and(|file| {
                pending.before_identity.is_none() == file.before_sha256.is_none() && pending.staged_identity.is_none() == file.after_sha256.is_none()
            });
            if !pending_paths.insert(pending.relative_path.as_str()) || !matches {
                return Err(Refusal::new("TRANSACTION_MANIFEST_INVALID", "Pending replacement intent does not match the authenticated file plan"));
            }
        }
        if manifest.transaction_id != transaction_id || manifest.workspace_id != self.binding.workspace_id {
            return Err(Refusal::new("TRANSACTION_WORKSPACE_MISMATCH", "Transaction manifest identity does not match its workspace or journal directory"));
        }
        if root_binding_required && manifest.root_fingerprint != self.binding.root_fingerprint {
            return Err(Refusal::new("TRANSACTION_ROOT_CHANGED", "Workspace root configuration changed after planning"));
        }
        if manifest.integrity()? != manifest.integrity_hash {
            return Err(Refusal::new("TRANSACTION_MANIFEST_INTEGRITY_FAILED", format!("Transaction manifest integrity failed: {transaction_id}")));
        }
        if hash_canonical(&to_value(&manifest.plan_payload)?) != manifest.plan_hash {
            return Err(Refusal::new(
                "TRANSACTION_PLAN_INTEGRITY_FAILED",
                format!("Transaction plan hash no longer matches its persisted payload: {transaction_id}"),
            ));
        }
        let current = to_value(&manifest.current_plan_payload())?;
        let immutable = |value: Value| hash_canonical(&without(value, &["diagnostics", "validation"]));
        if immutable(current.clone()) != immutable(to_value(&manifest.plan_payload)?) {
            return Err(Refusal::new(
                "TRANSACTION_PLAN_INTEGRITY_FAILED",
                format!("Transaction manifest no longer matches its hash-bound plan: {transaction_id}"),
            ));
        }
        if manifest.state == State::Planned && hash_canonical(&current) != manifest.plan_hash {
            return Err(Refusal::new(
                "TRANSACTION_PLAN_INTEGRITY_FAILED",
                format!("Planned transaction content no longer matches its plan hash: {transaction_id}"),
            ));
        }
        if head_mode != HeadMode::None {
            let manifest_hash = hash_canonical(&to_value(&manifest)?);
            self.state.verify_head(&self.head_input(&manifest, &manifest_hash), head_mode == HeadMode::Reconcile)?;
        }
        Ok(manifest)
    }

    /// Removes a journal folder and its protected head; the head goes first, so a crash or a
    /// later replay of the folder fails closed.
    pub fn remove(&self, transaction_id: &str) -> Result<(), Refusal> {
        self.state.remove_head(&self.binding.workspace_identity, transaction_id)?;
        let directory = self.transaction_directory(transaction_id)?;
        fs::remove_dir_all(directory).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "A journal cannot be removed", &error))
    }

    /// `reclaimAutonomousAppliedJournal`: renamed aside first (the durable reclaim marker), then
    /// its head removed, then the folder.
    pub fn reclaim(&self, transaction_id: &str) -> Result<(), Refusal> {
        let directory = self.transaction_directory(transaction_id)?;
        let reclaiming = contained_generated_path(&self.directory, &[&format!(".reclaiming-{transaction_id}")])?;
        fs::rename(&directory, &reclaiming).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Finished journal cannot be reclaimed", &error))?;
        self.state.remove_head(&self.binding.workspace_identity, transaction_id)?;
        fs::remove_dir_all(&reclaiming).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Finished journal cannot be reclaimed", &error))
    }
}

fn directory_bytes(directory: &Path) -> Result<u64, Refusal> {
    let mut bytes = 0_u64;
    let listing = fs::read_dir(directory).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
    for entry in listing {
        let entry = entry.map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
        if metadata.file_type().is_symlink() {
            return Err(Refusal::new("TRANSACTION_JOURNAL_UNSAFE", "Transaction journal contains a symbolic link or junction"));
        }
        bytes = bytes.saturating_add(if metadata.is_dir() { directory_bytes(&entry.path())? } else { metadata.len() });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `z.iso.datetime()`: seconds, an optional fraction, `Z`; never a panic on hostile text.
    #[test]
    fn checks_iso_times_like_the_typescript_schema() {
        for good in ["2026-11-27T12:00:00Z", "2026-11-27T12:00:00.1Z", "2026-11-18T11:06:40.123Z"] {
            assert!(valid_iso_time(good), "{good}");
        }
        for bad in [
            "",
            "2026-11-27T12:00:00",
            "2026-11-27T12:00:00.Z",
            "2026-11-27T12:00:00.1xZ",
            "2026-11-27T12:00:00+01:00",
            "2026-11-27 12:00:00Z",
            "0000-00-00T00:00:0\u{e9}Z",
            "2026-11-27T12:00:00.00\u{e9}Z",
            "\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}Z",
        ] {
            assert!(!valid_iso_time(bad), "{bad}");
        }
    }

    #[test]
    fn infers_media_types_like_the_typescript_manager() {
        assert_eq!(infer_media_type("common/a.TXT"), "text/plain");
        assert_eq!(infer_media_type("gfx/a.dds"), "application/octet-stream");
        assert_eq!(infer_media_type("gfx/a.png"), "image/png");
        assert_eq!(infer_media_type("a.json"), "application/json");
        assert_eq!(infer_media_type(".txt"), "application/octet-stream");
        assert_eq!(infer_media_type("localisation/x_l_english.yml"), "text/plain");
    }
}

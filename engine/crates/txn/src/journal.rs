//! The rewrite journal: a manifest per rewrite, with the rollback bytes it needs.
//!
//! Ported from `src/hoi4_agent_tools/core/transactions.ts` (`TransactionManifest`,
//! `TransactionFileChange`, `TransactionPendingFile`, `writeManifest`, `load`,
//! `verifyManifestText`, `readVerifiedBlob`, `journalUsage`, `transactionDirectory`), commit
//! `9b7dc80d`. The engine keeps its journals in `<cache>/engine-transactions`, apart from the
//! TypeScript journals, and binds each manifest with a SHA-256 integrity hash over its canonical
//! JSON (the engine holds no server key for the TypeScript authentication tag). Transaction ids
//! name journal folders only and never reach agents.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_core::canonical::{canonical_json, hash_canonical, sha256_hex};
use hoi4_core::plan::Refusal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil::{FileIdentity, durable_write, sync_directory};
use crate::limits::MAX_MANIFEST_BYTES;
use crate::paths::{contained_generated_path, io_refusal};

pub const JOURNAL_FOLDER: &str = "engine-transactions";
pub const JOURNAL_FORMAT: &str = "hoi4-engine-rewrite-journal";
pub const JOURNAL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalFile {
    pub relative_path: String,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
    pub before_size: Option<u64>,
    pub after_size: Option<u64>,
    /// `blobs/<sha256>` holding the before bytes, for rollback when no backup is left.
    pub before_blob: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub revision: u64,
    pub transaction_id: String,
    pub workspace_id: String,
    pub root_fingerprint: String,
    pub operation_kind: String,
    pub created_at: String,
    pub state: State,
    pub files: Vec<JournalFile>,
    pub applied_files: Vec<String>,
    /// The write-ahead intent of the replacement batch in progress.
    pub pending_files: Vec<PendingFile>,
    pub rollback_status: RollbackStatus,
    pub failure: Option<Failure>,
    pub integrity_hash: String,
}

fn invalid() -> Refusal {
    Refusal::new("TRANSACTION_MANIFEST_INVALID", "Transaction manifest is invalid")
}

fn integrity_hash(manifest: &Manifest) -> Result<String, Refusal> {
    let mut value = serde_json::to_value(manifest).map_err(|_| invalid())?;
    if let Value::Object(map) = &mut value {
        map.remove("integrityHash");
    }
    Ok(hash_canonical(&value))
}

pub fn valid_transaction_id(id: &str) -> bool {
    id.len() == 40 && id.starts_with("txn_") && id[4..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// The journal storage of one workspace.
pub struct Journal {
    pub(crate) directory: PathBuf,
}

impl Journal {
    /// The journal folder under the cache root, refused when a link moves it outside.
    pub fn open(cache_root: &Path) -> Result<Self, Refusal> {
        let directory = contained_generated_path(cache_root, &[JOURNAL_FOLDER])?;
        Ok(Self { directory })
    }

    pub fn create(&self) -> Result<(), Refusal> {
        fs::create_dir_all(&self.directory).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be created", &error))
    }

    /// The folder of one journal, checked to stay inside journal storage.
    pub fn transaction_directory(&self, transaction_id: &str) -> Result<PathBuf, Refusal> {
        if !valid_transaction_id(transaction_id) {
            return Err(Refusal::new("TRANSACTION_ID_INVALID", "Invalid transaction ID"));
        }
        let directory = contained_generated_path(&self.directory, &[transaction_id])?;
        if fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(Refusal::new("TRANSACTION_JOURNAL_UNSAFE", "Transaction journal contains a symbolic link or junction"));
        }
        Ok(directory)
    }

    /// Journal folders, in name order. A link among them is refused.
    pub fn entries(&self) -> Result<Vec<(String, PathBuf)>, Refusal> {
        let listing = match fs::read_dir(&self.directory) {
            Ok(listing) => listing,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error)),
        };
        let mut entries = Vec::new();
        for entry in listing {
            let entry = entry.map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Journal storage cannot be read", &error))?;
            let reclaiming = name.strip_prefix(".reclaiming-").is_some_and(valid_transaction_id);
            if !valid_transaction_id(&name) && !reclaiming {
                continue;
            }
            if file_type.is_symlink() {
                return Err(Refusal::new("TRANSACTION_JOURNAL_UNSAFE", "Transaction journal contains a symbolic link or junction"));
            }
            if file_type.is_dir() {
                entries.push((name, entry.path()));
            }
        }
        entries.sort();
        Ok(entries)
    }

    /// The count and bytes of the journals kept now.
    pub fn usage(&self) -> Result<(usize, u64), Refusal> {
        let mut count = 0;
        let mut bytes = 0_u64;
        for (name, path) in self.entries()? {
            if valid_transaction_id(&name) {
                count += 1;
                bytes = bytes.saturating_add(directory_bytes(&path)?);
            }
        }
        Ok((count, bytes))
    }

    /// Writes a blob of rollback bytes and checks what landed on disk.
    pub fn write_blob(&self, transaction_id: &str, bytes: &[u8]) -> Result<String, Refusal> {
        let hash = sha256_hex(bytes);
        let reference = format!("blobs/{hash}");
        let directory = self.transaction_directory(transaction_id)?;
        let path = contained_generated_path(&directory, &["blobs", &hash])?;
        if !path.exists() {
            durable_write(&path, bytes).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Rollback data cannot be written", &error))?;
        }
        Ok(reference)
    }

    /// The before bytes of a journal file, verified against their size and hash.
    pub fn read_before_blob(&self, manifest: &Manifest, file: &JournalFile) -> Result<Vec<u8>, Refusal> {
        let (Some(hash), Some(size), Some(blob)) = (&file.before_sha256, file.before_size, &file.before_blob) else {
            return Err(Refusal::new("TRANSACTION_BLOB_REFERENCE_INVALID", format!("{} has an incomplete before blob reference", file.relative_path)));
        };
        if *blob != format!("blobs/{hash}") {
            return Err(Refusal::new("TRANSACTION_BLOB_REFERENCE_INVALID", format!("{} has an invalid before blob path", file.relative_path)));
        }
        let missing = || Refusal::new("TRANSACTION_BLOB_INTEGRITY_FAILED", format!("{} before rollback data is missing", file.relative_path));
        let directory = self.transaction_directory(&manifest.transaction_id)?;
        let path = contained_generated_path(&directory, &["blobs", hash]).map_err(|_| missing())?;
        let bytes = fs::read(path).map_err(|_| missing())?;
        if bytes.len() as u64 != size || sha256_hex(&bytes) != *hash {
            return Err(Refusal::new(
                "TRANSACTION_BLOB_INTEGRITY_FAILED",
                format!("{} before rollback data failed integrity validation", file.relative_path),
            ));
        }
        Ok(bytes)
    }

    /// Writes the manifest as its next revision.
    pub fn write_manifest(&self, manifest: &mut Manifest) -> Result<(), Refusal> {
        manifest.revision += 1;
        manifest.integrity_hash = integrity_hash(manifest)?;
        let value = serde_json::to_value(&*manifest).map_err(|_| invalid())?;
        let text = canonical_json(&value);
        if text.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(Refusal::new("TRANSACTION_MANIFEST_LIMIT", "Transaction manifest exceeds its fixed byte limit"));
        }
        let directory = self.transaction_directory(&manifest.transaction_id)?;
        let path = contained_generated_path(&directory, &["manifest.json"])?;
        durable_write(&path, text.as_bytes()).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Transaction manifest cannot be written", &error))?;
        sync_directory(&directory);
        Ok(())
    }

    /// Whether a journal folder holds a manifest; one without never changed a source file.
    pub fn has_manifest(&self, transaction_id: &str) -> Result<bool, Refusal> {
        Ok(contained_generated_path(&self.transaction_directory(transaction_id)?, &["manifest.json"])?.exists())
    }

    /// Reads a manifest and checks its size, shape, format, folder and integrity hash.
    pub fn load(&self, transaction_id: &str) -> Result<Manifest, Refusal> {
        let directory = self.transaction_directory(transaction_id)?;
        let path = contained_generated_path(&directory, &["manifest.json"])?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| Refusal::new("TRANSACTION_NOT_FOUND", "Transaction was not found"))?;
        if !metadata.is_file() {
            return Err(Refusal::new("TRANSACTION_JOURNAL_UNSAFE", "Transaction manifest is not a regular file"));
        }
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(Refusal::new("TRANSACTION_MANIFEST_LIMIT", "Transaction manifest exceeds its fixed byte limit"));
        }
        let bytes = fs::read(&path).map_err(|_| Refusal::new("TRANSACTION_NOT_FOUND", "Transaction was not found"))?;
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if manifest.format != JOURNAL_FORMAT || manifest.version != JOURNAL_VERSION || manifest.transaction_id != transaction_id {
            return Err(invalid());
        }
        if integrity_hash(&manifest)? != manifest.integrity_hash {
            return Err(Refusal::new("TRANSACTION_MANIFEST_INVALID", "Transaction manifest failed integrity validation"));
        }
        Ok(manifest)
    }

    /// Removes a finished journal: renamed aside first, so a crash leaves a folder recovery
    /// recognizes and finishes removing.
    pub fn reclaim(&self, transaction_id: &str) -> Result<(), Refusal> {
        let directory = self.transaction_directory(transaction_id)?;
        let reclaiming = contained_generated_path(&self.directory, &[&format!(".reclaiming-{transaction_id}")])?;
        fs::rename(&directory, &reclaiming).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Finished journal cannot be reclaimed", &error))?;
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

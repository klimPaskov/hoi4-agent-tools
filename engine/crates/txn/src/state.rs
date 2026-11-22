//! Journal authentication and the protected journal heads kept in server state.
//!
//! Ported from `src/hoi4_agent_tools/core/server-state.ts` (`authenticateJournal`,
//! `authenticateCanonicalJournal`, `verifyJournal`, `recordInitialJournalHead`,
//! `recordJournalSuccessor`, `verifyJournalHead`, `verifyOrReconcileJournalHead`,
//! `removeJournalHead`, `listJournalHeadTransactionIds`, `createJournalHead`, `assertHeadInput`,
//! `headMatches`, `journalHeadDirectory`, `latestJournalHead`, `readJournalHead`,
//! `assertNoLinkComponents`, `atomicCreate`), commit `9b7dc80d`. The key is the server's
//! `journal-hmac.key`, passed in by the TypeScript caller; it is never logged or echoed. The heads
//! are the same files the TypeScript server writes, so either side recovers the other's journals.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use hoi4_core::canonical::canonical_json;
use hoi4_core::plan::Refusal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::fsutil::random_id;
use crate::journal::valid_transaction_id;
use crate::limits::MAX_MANIFEST_BYTES;

const KEY_BYTES: usize = 32;
const HEAD_MAX_BYTES: u64 = 4_096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn hmac_sha256(key: &[u8; KEY_BYTES], message: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    block[..KEY_BYTES].copy_from_slice(key);
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0_u8, |acc, (l, r)| acc | (l ^ r)) == 0
}

fn state_error(code: &str, message: &str) -> Refusal {
    Refusal::new(code, message)
}

/// Refuses a path with a symbolic link or junction among its existing components.
pub fn assert_no_link_components(path: &Path) -> Result<(), Refusal> {
    let mut cursor = PathBuf::new();
    for component in path.components() {
        cursor.push(component.as_os_str());
        if !matches!(component, Component::Normal(_)) {
            continue;
        }
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(state_error("SERVER_STATE_UNSAFE", "Server state root contains a symbolic link or junction"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(state_error("SERVER_STATE_UNSAFE", "Server state root cannot be inspected")),
        }
    }
    Ok(())
}

/// Creates `path` with `bytes` only when it does not exist: written to a private temporary, then
/// hard-linked into place. `false` when the path existed already.
fn atomic_create(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let temporary = directory.join(format!(".{}.tmp", random_id("state")));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// One protected journal revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalHead {
    version: u32,
    workspace_identity: String,
    transaction_id: String,
    revision: u64,
    manifest_hash: String,
    authentication_tag: String,
    head_tag: String,
}

/// What a head records about one manifest revision.
#[derive(Clone, Debug)]
pub struct HeadInput<'a> {
    pub workspace_identity: &'a str,
    pub transaction_id: &'a str,
    pub revision: u64,
    pub authentication_tag: &'a str,
    pub manifest_hash: &'a str,
}

struct Latest {
    head: JournalHead,
    path: PathBuf,
    older: Vec<PathBuf>,
}

/// The operator-owned server state: the journal key and the protected heads.
pub struct ServerState {
    root: PathBuf,
    key: [u8; KEY_BYTES],
}

impl fmt::Debug for ServerState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerState").field("root", &self.root).field("key", &"<redacted>").finish()
    }
}

impl ServerState {
    /// Opens server state at its canonical root with the journal key in lowercase hex.
    pub fn open(root: &Path, key_hex: &str) -> Result<Self, Refusal> {
        let invalid_key = || state_error("SERVER_STATE_KEY_INVALID", "Server journal authentication key is invalid");
        if key_hex.len() != KEY_BYTES * 2 || !key_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid_key());
        }
        let mut key = [0_u8; KEY_BYTES];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&key_hex[index * 2..index * 2 + 2], 16).map_err(|_| invalid_key())?;
        }
        if !root.is_absolute() {
            return Err(state_error("SERVER_STATE_ROOT_INVALID", "Server state root must be absolute"));
        }
        assert_no_link_components(root)?;
        let metadata = fs::symlink_metadata(root).map_err(|_| state_error("SERVER_STATE_ROOT_INVALID", "Server state root must be a real directory"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(state_error("SERVER_STATE_ROOT_INVALID", "Server state root must be a real directory"));
        }
        Ok(Self { root: root.to_path_buf(), key })
    }

    /// The tag of a canonical JSON text.
    pub fn authenticate_canonical(&self, canonical: &str) -> Result<String, Refusal> {
        if canonical.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(state_error("TRANSACTION_MANIFEST_LIMIT", "Transaction manifest exceeds its fixed byte limit"));
        }
        Ok(hex(&hmac_sha256(&self.key, canonical.as_bytes())))
    }

    pub fn verify_canonical(&self, canonical: &str, tag: &str) -> bool {
        if !is_sha256(tag) {
            return false;
        }
        match self.authenticate_canonical(canonical) {
            Ok(expected) => constant_time_equal(expected.as_bytes(), tag.as_bytes()),
            Err(_) => false,
        }
    }

    fn head_directory(&self, workspace_identity: &str, transaction_id: &str) -> Result<PathBuf, Refusal> {
        if !is_sha256(workspace_identity) || !valid_transaction_id(transaction_id) {
            return Err(state_error("TRANSACTION_HEAD_INVALID", "Transaction journal head identity is invalid"));
        }
        Ok(self.root.join("transaction-heads").join(&workspace_identity[..2]).join(workspace_identity).join(transaction_id))
    }

    fn assert_head_input(input: &HeadInput<'_>) -> Result<(), Refusal> {
        if !is_sha256(input.workspace_identity)
            || !valid_transaction_id(input.transaction_id)
            || input.revision < 1
            || input.revision > MAX_SAFE_INTEGER
            || !is_sha256(input.authentication_tag)
            || !is_sha256(input.manifest_hash)
        {
            return Err(state_error("TRANSACTION_HEAD_INVALID", "Transaction journal head identity is invalid"));
        }
        Ok(())
    }

    fn matches(head: &JournalHead, input: &HeadInput<'_>) -> bool {
        head.revision == input.revision && head.authentication_tag == input.authentication_tag && head.manifest_hash == input.manifest_hash
    }

    fn head_payload(head: &JournalHead) -> String {
        canonical_json(&json!({
            "version": head.version,
            "workspaceIdentity": head.workspace_identity,
            "transactionId": head.transaction_id,
            "revision": head.revision,
            "manifestHash": head.manifest_hash,
            "authenticationTag": head.authentication_tag,
        }))
    }

    fn read_head(&self, path: &Path, input: &HeadInput<'_>) -> Result<JournalHead, Refusal> {
        let invalid = || state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid");
        let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > HEAD_MAX_BYTES {
            return Err(invalid());
        }
        let head: JournalHead = serde_json::from_slice(&fs::read(path).map_err(|_| invalid())?).map_err(|_| invalid())?;
        if head.version != 1
            || head.revision < 1
            || head.revision > MAX_SAFE_INTEGER
            || !is_sha256(&head.workspace_identity)
            || !valid_transaction_id(&head.transaction_id)
            || !is_sha256(&head.manifest_hash)
            || !is_sha256(&head.authentication_tag)
            || head.workspace_identity != input.workspace_identity
            || head.transaction_id != input.transaction_id
            || !self.verify_canonical(&Self::head_payload(&head), &head.head_tag)
        {
            return Err(invalid());
        }
        Ok(head)
    }

    fn latest(&self, directory: &Path, input: &HeadInput<'_>) -> Result<Option<Latest>, Refusal> {
        assert_no_link_components(directory)?;
        let listing = match fs::read_dir(directory) {
            Ok(listing) => listing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid")),
        };
        let mut heads: Vec<(u64, PathBuf)> = Vec::new();
        for entry in listing {
            let entry = entry.map_err(|_| state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().map_err(|_| state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid"))?;
            let temporary = name.strip_prefix(".state_").and_then(|rest| rest.strip_suffix(".tmp")).is_some_and(|id| id.len() == 36);
            if temporary && file_type.is_file() {
                continue;
            }
            let numbered = name.len() == 21 && name.ends_with(".json") && name[..16].bytes().all(|b| b.is_ascii_digit());
            if file_type.is_symlink() || !file_type.is_file() || !numbered {
                return Err(state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state contains an invalid entry"));
            }
            let revision: u64 = name[..16].parse().unwrap_or(0);
            if revision < 1 || revision > MAX_SAFE_INTEGER {
                return Err(state_error("TRANSACTION_HEAD_INVALID", "Protected transaction revision is invalid"));
            }
            heads.push((revision, entry.path()));
        }
        let Some(position) = heads.iter().enumerate().max_by_key(|(_, (revision, _))| *revision).map(|(position, _)| position) else {
            return Ok(None);
        };
        let (_, path) = heads.swap_remove(position);
        let head = self.read_head(&path, input)?;
        Ok(Some(Latest { head, path, older: heads.into_iter().map(|(_, path)| path).collect() }))
    }

    fn create_head(&self, directory: &Path, input: &HeadInput<'_>) -> Result<PathBuf, Refusal> {
        let mut head = JournalHead {
            version: 1,
            workspace_identity: input.workspace_identity.into(),
            transaction_id: input.transaction_id.into(),
            revision: input.revision,
            manifest_hash: input.manifest_hash.into(),
            authentication_tag: input.authentication_tag.into(),
            head_tag: String::new(),
        };
        head.head_tag = self.authenticate_canonical(&Self::head_payload(&head))?;
        let target = directory.join(format!("{:016}.json", input.revision));
        let value = serde_json::to_value(&head).map_err(|_| state_error("TRANSACTION_HEAD_WRITE_FAILED", "Protected transaction journal state could not be recorded"))?;
        let bytes = format!("{}\n", canonical_json(&value));
        let created = atomic_create(&target, bytes.as_bytes())
            .map_err(|_| state_error("TRANSACTION_HEAD_WRITE_FAILED", "Protected transaction journal state could not be recorded"))?;
        if !created {
            let raced = self.read_head(&target, input)?;
            if raced != head {
                return Err(state_error("TRANSACTION_MANIFEST_REPLAY", "Transaction journal conflicts with a concurrent protected revision"));
            }
        }
        Ok(target)
    }

    fn remove_older(paths: &[PathBuf]) {
        for path in paths {
            let _ = fs::remove_file(path);
        }
    }

    pub fn record_initial_head(&self, input: &HeadInput<'_>) -> Result<(), Refusal> {
        Self::assert_head_input(input)?;
        if input.revision != 1 {
            return Err(state_error("TRANSACTION_HEAD_INVALID", "Initial transaction revision must be one"));
        }
        let directory = self.head_directory(input.workspace_identity, input.transaction_id)?;
        assert_no_link_components(&directory)?;
        fs::create_dir_all(&directory).map_err(|_| state_error("TRANSACTION_HEAD_WRITE_FAILED", "Protected transaction journal state could not be recorded"))?;
        assert_no_link_components(&directory)?;
        if let Some(latest) = self.latest(&directory, input)? {
            if Self::matches(&latest.head, input) {
                Self::remove_older(&latest.older);
                return Ok(());
            }
            return Err(state_error("TRANSACTION_MANIFEST_REPLAY", "Initial transaction journal conflicts with protected server state"));
        }
        self.create_head(&directory, input)?;
        Ok(())
    }

    pub fn record_successor(&self, input: &HeadInput<'_>) -> Result<(), Refusal> {
        Self::assert_head_input(input)?;
        let directory = self.head_directory(input.workspace_identity, input.transaction_id)?;
        let Some(latest) = self.latest(&directory, input)? else {
            return Err(state_error("TRANSACTION_HEAD_MISSING", "Transaction journal has no protected server-state head"));
        };
        if input.revision == latest.head.revision && Self::matches(&latest.head, input) {
            Self::remove_older(&latest.older);
            return Ok(());
        }
        if input.revision != latest.head.revision + 1 {
            return Err(state_error("TRANSACTION_MANIFEST_REPLAY", "Transaction journal revision is not the protected successor"));
        }
        let target = self.create_head(&directory, input)?;
        let mut older = latest.older;
        older.push(latest.path);
        older.retain(|path| *path != target);
        Self::remove_older(&older);
        Ok(())
    }

    /// Checks that a manifest revision is the protected head. With `reconcile`, an authenticated
    /// immediate successor (a crash between the manifest and the head write) becomes the head.
    pub fn verify_head(&self, input: &HeadInput<'_>, reconcile: bool) -> Result<(), Refusal> {
        Self::assert_head_input(input)?;
        let directory = self.head_directory(input.workspace_identity, input.transaction_id)?;
        let Some(latest) = self.latest(&directory, input)? else {
            return Err(state_error("TRANSACTION_HEAD_MISSING", "Transaction journal has no protected server-state head"));
        };
        if Self::matches(&latest.head, input) {
            return Ok(());
        }
        if input.revision == latest.head.revision + 1 {
            if !reconcile {
                return Err(state_error(
                    "TRANSACTION_HEAD_RECONCILIATION_REQUIRED",
                    "Transaction journal has an authenticated successor pending write-path recovery",
                ));
            }
            let target = self.create_head(&directory, input)?;
            let mut older = latest.older;
            older.push(latest.path);
            older.retain(|path| *path != target);
            Self::remove_older(&older);
            return Ok(());
        }
        Err(state_error("TRANSACTION_MANIFEST_REPLAY", "Transaction journal conflicts with protected server state"))
    }

    pub fn remove_head(&self, workspace_identity: &str, transaction_id: &str) -> Result<(), Refusal> {
        let directory = self.head_directory(workspace_identity, transaction_id)?;
        assert_no_link_components(&directory)?;
        match fs::remove_dir_all(&directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(state_error("TRANSACTION_HEAD_WRITE_FAILED", "Protected transaction journal state could not be removed")),
        }
    }

    pub fn head_transaction_ids(&self, workspace_identity: &str) -> Result<Vec<String>, Refusal> {
        if !is_sha256(workspace_identity) {
            return Err(state_error("TRANSACTION_HEAD_INVALID", "Workspace head identity is invalid"));
        }
        let directory = self.root.join("transaction-heads").join(&workspace_identity[..2]).join(workspace_identity);
        assert_no_link_components(&directory)?;
        let listing = match fs::read_dir(&directory) {
            Ok(listing) => listing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid")),
        };
        let mut ids = Vec::new();
        for entry in listing {
            let entry = entry.map_err(|_| state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().map_err(|_| state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid"))?;
            if file_type.is_symlink() || !file_type.is_dir() || !valid_transaction_id(&name) {
                return Err(state_error("TRANSACTION_HEAD_INVALID", "Protected transaction state is invalid"));
            }
            ids.push(name);
        }
        ids.sort();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 test case 2 has a short key; this checks the construction with a 32-byte key
    /// against a value computed with Node's `createHmac('sha256', key)`.
    #[test]
    fn computes_hmac_sha256_like_node() {
        let key = [0x0b_u8; 32];
        assert_eq!(hex(&hmac_sha256(&key, b"Hi There")), "198a607eb44bfbc69903a0f1cf2bbdc5ba0aa3f3d9ae3c1c7a3b1696a0b68cf7");
    }

    #[test]
    fn refuses_missing_short_and_malformed_keys() {
        let root = std::env::temp_dir();
        for key in ["", "00", &"0".repeat(63), &"g".repeat(64), &"0".repeat(66)] {
            assert_eq!(ServerState::open(&root, key).unwrap_err().code, "SERVER_STATE_KEY_INVALID");
        }
        let state = ServerState::open(&root, &"ab".repeat(32)).unwrap();
        assert!(!format!("{state:?}").contains("abab"));
    }
}

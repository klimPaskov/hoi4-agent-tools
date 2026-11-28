//! The content-addressed artifact store.
//!
//! Ported from `src/hoi4_agent_tools/core/artifacts.ts` (`ArtifactStore`, `preflightArtifactBatch`,
//! `artifactUsage`, `readArtifactManifest`, `publishExclusiveFile`, `readArtifactRangeOnce`,
//! `pruneForAdmission`, `withAtomicWrites`, `withAtomicChunkedWrites`, `readLogical`,
//! `boundedSourceHashEvidence`), commit `9b7dc80d`. Layout, names, manifests, hashes, URIs and
//! error codes are the TypeScript ones, so both servers read each other's stores.
//!
//! Differences from the TypeScript store, all in how a call is made rather than what it stores:
//! the commit callback of `withAtomicWrites` becomes a returned [`Created`] list that the caller
//! hands back to [`ArtifactStore::release`] when its own commit fails; the retention callback
//! becomes a list of retained URIs passed in; the cross-process publication lock is an OS file
//! lock on `.artifact-publish.lock` in the storage root; calls are not cancellable.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use hoi4_core::canonical::{canonical_json, compare_code_units, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::{StoreError, StoreResult};

const READ_BUFFER_BYTES: usize = 1_048_576;
pub const PAGE_MAX_ENTRIES: usize = 100;
const MANIFEST_MAX_BYTES: u64 = 1_048_576;
const LOGICAL_BATCH_MAX_BYTES: u64 = 536_870_912;
const DEBRIS_MINIMUM_AGE_MS: f64 = 15.0 * 60.0 * 1000.0;
const INTERRUPTED_MANIFEST_MINIMUM_AGE_MS: f64 = 1000.0;
const TEMPORARY_PREFIX: &str = ".artifact-tmp-";
const MANIFEST_SUFFIX: &str = ".manifest.json";
const LOCK_FILE: &str = ".artifact-publish.lock";
pub const CHUNKED_INDEX_MIME_TYPE: &str = "application/json";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The workspace identity the store checks every manifest against.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreWorkspace {
    pub id: String,
    pub artifact_root: String,
    pub workspace_identity: String,
    pub owner_identity: String,
}

#[derive(Clone, Copy, Debug)]
pub struct StoreLimits {
    pub max_bytes: u64,
    pub max_entries: u64,
    pub max_single_bytes: u64,
}

impl Default for StoreLimits {
    fn default() -> Self {
        Self { max_bytes: 536_870_912, max_entries: 5_000, max_single_bytes: 134_217_728 }
    }
}

/// One artifact to store. `provenance` is validated against the TypeScript schema.
#[derive(Clone, Debug)]
pub struct ArtifactWrite {
    pub name: String,
    pub mime_type: String,
    pub content: Vec<u8>,
    pub provenance: Value,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLink {
    pub uri: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredArtifact {
    #[serde(flatten)]
    pub link: ArtifactLink,
    pub provenance_hash: String,
    pub path: String,
    pub provenance: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub artifacts: Vec<ArtifactLink>,
    pub total: u64,
    pub revision: String,
    pub after_found: bool,
    pub has_more: bool,
}

/// What a batch created, so a failed caller commit can take back exactly these files.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Created {
    pub targets: Vec<String>,
    pub manifests: Vec<String>,
    /// The claim this batch holds until its caller commits or releases it (see `Claim`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<String>,
}

#[derive(Clone, Debug)]
struct Manifest {
    workspace_identity: String,
    owner_identity: String,
    name: String,
    mime_type: String,
    size: u64,
    sha256: String,
    provenance_hash: String,
    provenance: Value,
    description: Option<String>,
}

impl Manifest {
    fn to_value(&self) -> Value {
        let mut value = json!({
            "version": 2,
            "workspaceIdentity": self.workspace_identity,
            "ownerIdentity": self.owner_identity,
            "name": self.name,
            "mimeType": self.mime_type,
            "size": self.size,
            "sha256": self.sha256,
            "provenanceHash": self.provenance_hash,
            "provenance": self.provenance,
        });
        if let Some(description) = &self.description {
            value["description"] = json!(description);
        }
        value
    }

    fn bytes(&self) -> String {
        format!("{}\n", canonical_json(&self.to_value()))
    }
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `isPortablePathSegment` of `workspace.ts`.
pub fn is_portable_path_segment(segment: &str) -> bool {
    if segment.is_empty() || segment.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return false;
    }
    if segment.chars().any(|c| "<>:\"|?*".contains(c)) {
        return false;
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return false;
    }
    let stem = segment.split('.').next().unwrap_or("").to_lowercase();
    let device = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul" | "clock$" | "conin$" | "conout$")
        || ["com", "lpt"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|rest| {
                let mut chars = rest.chars();
                matches!((chars.next(), chars.next()), (Some('1'..='9' | '¹' | '²' | '³'), None))
            })
        });
    !device
}

pub fn is_valid_artifact_name(name: &str) -> bool {
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    first_ok
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && is_portable_path_segment(name)
        && !name.to_lowercase().ends_with(MANIFEST_SUFFIX)
}

/// Validates provenance as the zod schema `artifactProvenanceSchema` does (strict object).
pub fn provenance_valid(provenance: &Value) -> bool {
    let Some(object) = provenance.as_object() else { return false };
    for (key, value) in object {
        let ok = match key.as_str() {
            "kind" | "toolVersion" | "schemaVersion" => value.is_string(),
            "sourceHashes" => value.as_object().is_some_and(|hashes| hashes.values().all(|hash| hash.as_str().is_some_and(is_sha256))),
            "renderProfile" | "metadata" => value.is_object(),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    ["kind", "toolVersion", "schemaVersion", "sourceHashes"].iter().all(|key| object.contains_key(*key))
}

fn parse_manifest(text: &str) -> Option<Manifest> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    const KEYS: [&str; 10] =
        ["version", "workspaceIdentity", "ownerIdentity", "name", "mimeType", "size", "sha256", "provenanceHash", "provenance", "description"];
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) || object.get("version") != Some(&json!(2)) {
        return None;
    }
    let text_of = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    let hash_of = |key: &str| text_of(key).filter(|text| is_sha256(text));
    let size = object.get("size").and_then(Value::as_u64).filter(|size| *size <= MAX_SAFE_INTEGER)?;
    let provenance = object.get("provenance").filter(|provenance| provenance_valid(provenance))?.clone();
    let description = match object.get("description") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return None,
    };
    Some(Manifest {
        workspace_identity: hash_of("workspaceIdentity")?,
        owner_identity: hash_of("ownerIdentity")?,
        name: text_of("name")?,
        mime_type: text_of("mimeType")?,
        size,
        sha256: hash_of("sha256")?,
        provenance_hash: hash_of("provenanceHash")?,
        provenance,
        description,
    })
}

fn provenance_hash_for(manifest: &Manifest) -> String {
    sha256_hex(
        canonical_json(&json!({
            "version": 2,
            "workspaceIdentity": manifest.workspace_identity,
            "ownerIdentity": manifest.owner_identity,
            "name": manifest.name,
            "mimeType": manifest.mime_type,
            "size": manifest.size,
            "sha256": manifest.sha256,
            "provenance": manifest.provenance,
            "description": manifest.description,
        }))
        .as_bytes(),
    )
}

fn assert_address_integrity(manifest: &Manifest, sha256: &str, provenance_hash: &str, name: &str) -> StoreResult<()> {
    if manifest.sha256 != sha256 || manifest.provenance_hash != provenance_hash || manifest.name != name || provenance_hash_for(manifest) != provenance_hash {
        return Err(StoreError::new("ARTIFACT_MANIFEST_INTEGRITY_FAILED", "Artifact provenance manifest does not match its immutable address"));
    }
    Ok(())
}

fn belongs_to(manifest: &Manifest, workspace: &StoreWorkspace) -> bool {
    manifest.workspace_identity == workspace.workspace_identity && manifest.owner_identity == workspace.owner_identity
}

fn recoverable(error: &StoreError) -> bool {
    matches!(error.code, "ARTIFACT_NOT_FOUND" | "ARTIFACT_MANIFEST_INVALID" | "ARTIFACT_MANIFEST_LIMIT" | "ARTIFACT_MANIFEST_INTEGRITY_FAILED")
}

/// JavaScript `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn artifact_uri(workspace_id: &str, sha256: &str, provenance_hash: &str, name: &str) -> String {
    format!("hoi4-agent://workspace/{}/artifact/{sha256}/{provenance_hash}/{}", encode_uri_component(workspace_id), encode_uri_component(name))
}

struct ParsedUri {
    sha256: String,
    provenance_hash: String,
    name: String,
}

fn parse_uri(workspace: &StoreWorkspace, uri: &str) -> StoreResult<ParsedUri> {
    let invalid = || StoreError::new("ARTIFACT_URI_INVALID", "Invalid artifact URI");
    let rest = uri.strip_prefix("hoi4-agent://workspace/").ok_or_else(invalid)?;
    if rest.contains('?') || rest.contains('#') {
        return Err(invalid());
    }
    let mut segments = Vec::new();
    for segment in rest.split('/').filter(|segment| !segment.is_empty()) {
        segments.push(decode_uri_component(segment).ok_or_else(|| StoreError::new("ARTIFACT_URI_INVALID", "Invalid artifact URI encoding"))?);
    }
    if segments.len() != 5 || segments[0] != workspace.id || segments[1] != "artifact" {
        return Err(StoreError::new("ARTIFACT_WORKSPACE_MISMATCH", "Artifact URI does not belong to this workspace"));
    }
    let (sha256, provenance_hash, name) = (segments[2].clone(), segments[3].clone(), segments[4].clone());
    if !is_sha256(&sha256) || !is_sha256(&provenance_hash) || !is_valid_artifact_name(&name) {
        return Err(StoreError::new("ARTIFACT_URI_INVALID", "Invalid artifact URI components"));
    }
    if artifact_uri(&workspace.id, &sha256, &provenance_hash, &name) != uri {
        return Err(StoreError::new("ARTIFACT_URI_INVALID", "Artifact URI is not canonical"));
    }
    Ok(ParsedUri { sha256, provenance_hash, name })
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

/// `containedGeneratedPath`: a descendant of the storage root with every existing component
/// resolved, refused when it leaves the root through a link.
pub fn contained_path(root: &str, segments: &[&str]) -> StoreResult<PathBuf> {
    let escape = || StoreError::new("PATH_GENERATED_ROOT_ESCAPE", "Generated storage path escapes its configured root");
    fs::create_dir_all(root).map_err(|_| escape())?;
    let canonical_root = strip_verbatim(fs::canonicalize(root).map_err(|_| escape())?);
    let mut candidate = canonical_root.clone();
    for segment in segments {
        for part in segment.replace('\\', "/").split('/') {
            match part {
                "" | "." => {}
                ".." => return Err(escape()),
                part => candidate.push(part),
            }
        }
    }
    // Resolve the deepest existing ancestor, so a link anywhere on the way is followed and checked.
    let mut existing = candidate.clone();
    let mut tail = Vec::new();
    while !existing.exists() && fs::symlink_metadata(&existing).is_err() {
        match existing.file_name() {
            Some(name) => tail.push(name.to_owned()),
            None => return Err(escape()),
        }
        if !existing.pop() {
            return Err(escape());
        }
    }
    let mut resolved = strip_verbatim(fs::canonicalize(&existing).map_err(|_| escape())?);
    for part in tail.into_iter().rev() {
        resolved.push(part);
    }
    if !resolved.starts_with(&canonical_root) {
        return Err(escape());
    }
    Ok(resolved)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn modified_ms(metadata: &fs::Metadata) -> f64 {
    metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn sort_key_of_manifest(file_name: &str) -> String {
    if let Some(stem) = file_name.strip_suffix(MANIFEST_SUFFIX)
        && let Some((name, hash)) = stem.rsplit_once('.')
        && is_sha256(hash)
    {
        return format!("{hash}/{}", encode_uri_component(name));
    }
    file_name.to_owned()
}

fn read_manifest(path: &Path) -> StoreResult<Manifest> {
    let unavailable = || StoreError::new("ARTIFACT_NOT_FOUND", "Artifact provenance manifest is unavailable");
    let invalid = || StoreError::new("ARTIFACT_MANIFEST_INVALID", "Artifact provenance manifest is invalid");
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid());
    }
    if metadata.len() > MANIFEST_MAX_BYTES {
        return Err(StoreError::new("ARTIFACT_MANIFEST_LIMIT", "Artifact provenance manifest exceeds its fixed byte limit"));
    }
    let bytes = fs::read(path).map_err(|_| unavailable())?;
    let text = String::from_utf8_lossy(&bytes);
    parse_manifest(&text).ok_or_else(invalid)
}

fn refresh_manifest(path: &Path) -> StoreResult<()> {
    let file = OpenOptions::new().write(true).open(path).map_err(|_| StoreError::new("ARTIFACT_NOT_FOUND", "Artifact provenance manifest is unavailable"))?;
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err(StoreError::new("ARTIFACT_MANIFEST_INVALID", "Artifact provenance manifest is invalid"));
    }
    file.set_modified(SystemTime::now()).map_err(|_| StoreError::new("ARTIFACT_NOT_FOUND", "Artifact provenance manifest is unavailable"))
}

fn unlink_quiet(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `bytes` beside `target` and links it into place; false when `target` already exists.
fn publish_exclusive(target: &Path, bytes: &[u8]) -> StoreResult<bool> {
    let nonce = sha256_hex(format!("{}:{}:{}", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed), now_ms()).as_bytes());
    let temporary = target.with_file_name(format!("{TEMPORARY_PREFIX}{}-{}", std::process::id(), &nonce[..32]));
    let failed = |_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact content could not be written");
    let outcome = (|| -> StoreResult<bool> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(failed)?;
        file.write_all(bytes).map_err(failed)?;
        file.sync_all().map_err(failed)?;
        drop(file);
        match fs::hard_link(&temporary, target) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(_) => Err(StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact content could not be written")),
        }
    })();
    let _ = unlink_quiet(&temporary);
    outcome
}

struct RangeRead {
    bytes: Vec<u8>,
    total_size: u64,
}

/// What was verified: the content hash and the identity of the file it was verified on.
type VerifiedEntry = (String, hoi4_os::FileIdentity);

fn verified_cache() -> &'static Mutex<HashMap<String, VerifiedEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, VerifiedEntry>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The cache is keyed by workspace and owner identity as well as the path, like the TypeScript one.
fn verification_scope(workspace: &StoreWorkspace) -> String {
    format!("{}\0{}", workspace.workspace_identity, workspace.owner_identity)
}

fn verification_key(scope: &str, path: &Path) -> String {
    format!("{scope}\0{}", path_text(path))
}

fn forget_verified(path: &Path) {
    let suffix = format!("\0{}", path_text(path));
    if let Ok(mut cache) = verified_cache().lock() {
        cache.retain(|key, _| !key.ends_with(&suffix));
    }
}

/// Reads a byte range after proving the whole file still hashes to its address. A file already
/// verified with the same device, node, size, modification time and change time is not hashed
/// again; a replacement or an in-place rewrite changes at least one of them.
fn read_verified_range(scope: &str, path: &Path, sha256: &str, range: Option<(u64, u64)>) -> StoreResult<RangeRead> {
    if let Some((_, length)) = range
        && length < 1
    {
        return Err(StoreError::new("ARTIFACT_RANGE_INVALID", "Artifact byte range is invalid"));
    }
    let mut file = File::open(path).map_err(|_| StoreError::new("ARTIFACT_NOT_FOUND", "Artifact content is unavailable"))?;
    let read_failed = |_| StoreError::new("ARTIFACT_READ_FAILED", "Artifact content could not be read");
    let identity = hoi4_os::file_identity(&file).map_err(read_failed)?;
    let total = identity.size;
    let offset = range.map_or(0, |(offset, _)| offset.min(total));
    let requested = range.map_or(total - offset, |(_, length)| length.min(READ_BUFFER_BYTES as u64));
    let selected_length = requested.min(total - offset);
    let cache_key = verification_key(scope, path);
    let verified = verified_cache().lock().ok().and_then(|cache| cache.get(&cache_key).cloned()) == Some((sha256.to_owned(), identity));
    let mut selected = vec![0u8; selected_length as usize];
    if verified {
        file.seek(SeekFrom::Start(offset)).map_err(read_failed)?;
        file.read_exact(&mut selected).map_err(|_| StoreError::new("ARTIFACT_READ_INCOMPLETE", "Artifact content changed while reading"))?;
    } else {
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; READ_BUFFER_BYTES.min(total.max(1) as usize)];
        let mut position = 0u64;
        while position < total {
            let want = (buffer.len() as u64).min(total - position) as usize;
            let read = file.read(&mut buffer[..want]).map_err(read_failed)?;
            if read == 0 {
                return Err(StoreError::new("ARTIFACT_READ_INCOMPLETE", "Artifact content changed while reading"));
            }
            hasher.update(&buffer[..read]);
            let (start, end) = (position.max(offset), (position + read as u64).min(offset + selected_length));
            if start < end {
                selected[(start - offset) as usize..(end - offset) as usize].copy_from_slice(&buffer[(start - position) as usize..(end - position) as usize]);
            }
            position += read as u64;
        }
        let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if digest != sha256 {
            return Err(StoreError::new("ARTIFACT_INTEGRITY_FAILED", "Artifact hash does not match its URI"));
        }
    }
    if hoi4_os::file_identity(&file).map_err(read_failed)? != identity {
        return Err(StoreError::new("ARTIFACT_READ_INCOMPLETE", "Artifact content changed while reading"));
    }
    if let Ok(mut cache) = verified_cache().lock() {
        cache.insert(cache_key, (sha256.to_owned(), identity));
    }
    Ok(RangeRead { bytes: selected, total_size: total })
}

fn storage_unreadable() -> StoreError {
    StoreError::new("ARTIFACT_STORAGE_UNSAFE", "Artifact storage could not be read")
}

/// The entries of a folder; `None` when it is gone. Any other failure is an error, so a folder that
/// cannot be read can never make storage look smaller than it is.
fn read_dir_checked(directory: &Path) -> StoreResult<Option<Vec<fs::DirEntry>>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage_unreadable()),
    };
    let mut result = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => result.push(entry),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage_unreadable()),
        }
    }
    Ok(Some(result))
}

/// Metadata without following links; `None` when the entry vanished meanwhile.
fn metadata_checked(path: &Path) -> StoreResult<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(storage_unreadable()),
    }
}

/// The claim file next to the publication lock. Every engine process that shares an artifact root
/// reads and writes it only while holding that lock, so one process's rollback or eviction sees
/// the claims of all the others.
const CLAIMS_FILE: &str = ".artifact-claims.json";
const CLAIMS_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// A claim nobody settled for this long is dropped, so a caller that crashed between `put` and
/// `commit` leaves no orphan behind; no commit takes that long.
pub const CLAIM_LIFETIME_MS: u64 = 600_000;

/// A batch's hold on the files it created or reused. The engine cannot see the caller's commit
/// (it happens in the caller between `put` and `release`), so a claim lasts until the caller says
/// `commit` or `release`, or until it expires. While it lives, eviction leaves its files alone, and a
/// file that another batch reused meanwhile is never taken back by this batch's release.
/// Paths are relative to the artifact root, with forward slashes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRecord {
    created: BTreeSet<String>,
    used: BTreeSet<String>,
    shared: BTreeSet<String>,
    expires_at_ms: u64,
}

/// The persistent claims of one artifact root and the commit epoch. The epoch counts commits: a
/// caller that keeps durable pins reads them between two calls (the engine asks for them only when
/// it must evict), a commit in between may have pinned an artifact its list lacks, so a list made
/// at an older epoch is refused.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimState {
    #[serde(default)]
    epoch: u64,
    #[serde(default)]
    claims: BTreeMap<String, ClaimRecord>,
}

fn wall_clock_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn claim_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn claim_absolute(root: &Path, relative: &str) -> PathBuf {
    relative.split('/').filter(|part| !part.is_empty()).fold(root.to_owned(), |path, part| path.join(part))
}

impl ClaimState {
    /// Reads the claims under the publication lock and drops the expired ones. A missing file is an
    /// empty state; an unreadable or tampered one is too, with the epoch set to the clock so that
    /// every list of pins made before is refused.
    fn load(root: &Path, now_ms: u64) -> StoreResult<Self> {
        let path = root.join(CLAIMS_FILE);
        let mut state = match metadata_checked(&path)? {
            None => Self::default(),
            Some(metadata) if metadata.is_file() && metadata.len() <= CLAIMS_MAX_BYTES => {
                match fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok()) {
                    Some(state) => state,
                    None => Self { epoch: now_ms, claims: BTreeMap::new() },
                }
            }
            Some(_) => Self { epoch: now_ms, claims: BTreeMap::new() },
        };
        state.claims.retain(|_, claim| claim.expires_at_ms > now_ms);
        Ok(state)
    }

    /// Replaces the file atomically; callers hold the publication lock.
    fn save(&self, root: &Path) -> StoreResult<()> {
        let failed = |_: &dyn std::fmt::Debug| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact claims could not be written");
        let bytes = serde_json::to_vec(self).map_err(|error| failed(&error))?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(|_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact claims could not be written"))?;
        let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let temporary = root.join(format!("{TEMPORARY_PREFIX}claims-{nonce}"));
        fs::write(&temporary, bytes).map_err(|error| failed(&error))?;
        fs::rename(&temporary, root.join(CLAIMS_FILE)).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            failed(&error)
        })
    }

    /// Everything a live claim holds, as the absolute paths eviction compares against.
    fn protected(&self, root: &Path) -> BTreeSet<PathBuf> {
        self.claims.values().flat_map(|claim| claim.used.iter()).map(|relative| claim_absolute(root, relative)).collect()
    }

    /// Records a new claim and marks what other live claims created and this batch reuses.
    fn register(&mut self, root: &Path, created: &Created, used: BTreeSet<String>, now_ms: u64) -> StoreResult<String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact claims could not be written"))?;
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        for claim in self.claims.values_mut() {
            for path in &used {
                if claim.created.contains(path) {
                    claim.shared.insert(path.clone());
                }
            }
        }
        let relative = |paths: &[String]| paths.iter().map(|path| claim_relative(root, Path::new(path))).collect::<BTreeSet<String>>();
        let record = ClaimRecord {
            created: relative(&created.targets).into_iter().chain(relative(&created.manifests)).collect(),
            used,
            shared: BTreeSet::new(),
            expires_at_ms: now_ms.saturating_add(CLAIM_LIFETIME_MS),
        };
        self.claims.insert(token.clone(), record);
        Ok(token)
    }

    /// Ends a claim and returns the paths another batch reused while it lived.
    fn settle(&mut self, batch: Option<&str>) -> BTreeSet<String> {
        batch.and_then(|batch| self.claims.remove(batch)).map(|claim| claim.shared).unwrap_or_default()
    }
}

/// Measures artifact storage; with `cleanup`, also removes aged temporary files and empty folders.
fn artifact_usage(root: &str, cleanup: bool) -> StoreResult<(u64, u64)> {
    let canonical_root = contained_path(root, &[])?;
    let (mut bytes, mut entries) = (0u64, 0u64);
    fn walk(directory: &Path, root: &Path, cleanup: bool, bytes: &mut u64, entries: &mut u64) -> StoreResult<()> {
        let Some(children) = read_dir_checked(directory)? else { return Ok(()) };
        for child in children {
            let name = child.file_name().to_string_lossy().into_owned();
            let path = child.path();
            let Some(metadata) = metadata_checked(&path)? else { continue };
            if metadata.file_type().is_symlink() {
                return Err(StoreError::new("ARTIFACT_STORAGE_UNSAFE", "Artifact storage contains a symbolic link or junction"));
            }
            if metadata.is_file() && name.starts_with(TEMPORARY_PREFIX) {
                if cleanup && now_ms() - modified_ms(&metadata) >= DEBRIS_MINIMUM_AGE_MS {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            if metadata.is_dir() {
                walk(&path, root, cleanup, bytes, entries)?;
            } else if metadata.is_file() {
                *bytes = bytes.checked_add(metadata.len()).ok_or_else(|| StoreError::new("ARTIFACT_STORAGE_LIMIT", "Artifact storage size is unsafe"))?;
                if name.ends_with(MANIFEST_SUFFIX) {
                    *entries += 1;
                }
            }
        }
        if cleanup && directory != root {
            let _ = fs::remove_dir(directory);
        }
        Ok(())
    }
    walk(&canonical_root, &canonical_root, cleanup, &mut bytes, &mut entries)?;
    Ok((bytes, entries))
}

fn chunk_artifact_name(original_sha256: &str, index: usize) -> String {
    format!("chunk-{original_sha256}-{index:06}.part")
}

fn chunk_index_artifact_name(original_name: &str, original_sha256: &str) -> String {
    let suffix = format!(".{}.chunks.json", &original_sha256[..16]);
    let keep = 128usize.saturating_sub(suffix.len()).max(1);
    // JavaScript slices UTF-16 code units; artifact names are ASCII, so characters are equal.
    let prefix: String = original_name.chars().take(keep).collect();
    format!("{prefix}{suffix}")
}

fn chunked_provenance(provenance: &Value, role: &str, original: &Value, details: Value) -> Value {
    let mut result = provenance.clone();
    let kind = provenance.get("kind").and_then(Value::as_str).unwrap_or("");
    result["kind"] = json!(format!("{kind}-{role}"));
    let mut metadata = provenance.get("metadata").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut chunked = Map::new();
    chunked.insert("role".into(), json!(role));
    chunked.insert("originalName".into(), original["name"].clone());
    chunked.insert("originalMimeType".into(), original["mimeType"].clone());
    chunked.insert("originalSize".into(), original["size"].clone());
    chunked.insert("originalSha256".into(), original["sha256"].clone());
    if let Some(details) = details.as_object() {
        chunked.extend(details.clone());
    }
    metadata.insert("chunkedArtifact".into(), Value::Object(chunked));
    result["metadata"] = Value::Object(metadata);
    result
}

fn chunk_membership(manifest: &Manifest) -> Option<(String, String)> {
    let chunked = manifest.provenance.get("metadata")?.get("chunkedArtifact")?;
    let group = chunked.get("originalSha256")?.as_str()?;
    let role = chunked.get("role")?.as_str()?;
    matches!(role, "chunk" | "index").then(|| (group.to_owned(), role.to_owned()))
}

/// A deterministic commitment to every source path/hash pair, with a bounded retained subset.
pub fn bounded_source_hash_evidence(source_hashes: &BTreeMap<String, String>) -> Value {
    let mut entries: Vec<(&String, &String)> = source_hashes.iter().collect();
    entries.sort_by(|left, right| compare_code_units(left.0, right.0));
    let mut digest = Sha256::new();
    digest.update(b"source-hash-inventory.v1\0");
    let mut retained = Map::new();
    let (mut retained_bytes, mut retained_count) = (2usize, 0usize);
    for (path, hash) in &entries {
        digest.update(path.len().to_string().as_bytes());
        digest.update(b":");
        digest.update(path.as_bytes());
        digest.update(b":");
        digest.update(hash.as_bytes());
        digest.update(b"\n");
        let entry_bytes = serde_json::to_string(path).map_or(0, |text| text.len()) + serde_json::to_string(hash).map_or(0, |text| text.len()) + 2;
        if retained_count < 256 && retained_bytes + entry_bytes <= 131_072 {
            retained.insert((*path).clone(), json!(hash));
            retained_bytes += entry_bytes;
            retained_count += 1;
        }
    }
    let hex: String = digest.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    json!({
        "sourceHashes": retained,
        "inventory": {
            "schemaVersion": 1,
            "algorithm": "sha256-length-prefixed-path-digest-v1",
            "count": entries.len(),
            "digest": hex,
            "retainedCount": retained_count,
            "truncated": retained_count != entries.len(),
        },
    })
}

#[derive(Clone, Debug)]
pub struct ReadResult {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub name: String,
    pub total_size: u64,
}

#[derive(Default)]
pub struct ArtifactStore {
    pub limits: StoreLimits,
    /// The commit epoch the caller read its pins at; see `ClaimState`.
    pub retention_epoch: Option<u64>,
    /// A fixed clock for the claim lifetime (tests); the system clock when `None`.
    pub now_ms: Option<u64>,
}

struct Prepared {
    artifact: StoredArtifact,
    bytes: Vec<u8>,
    directory: PathBuf,
    target: PathBuf,
    manifest_path: PathBuf,
    manifest_bytes: String,
}

struct PublishLock {
    file: File,
}

impl PublishLock {
    fn take(root: &str) -> StoreResult<Self> {
        let path = contained_path(root, &[LOCK_FILE])?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .map_err(|_| StoreError::new("ARTIFACT_STORAGE_UNSAFE", "Artifact publication lock is unavailable"))?;
        file.lock().map_err(|_| StoreError::new("ARTIFACT_STORAGE_UNSAFE", "Artifact publication lock is unavailable"))?;
        Ok(Self { file })
    }
}

impl Drop for PublishLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

impl ArtifactStore {
    pub fn new(limits: StoreLimits) -> Self {
        Self { limits, retention_epoch: None, now_ms: None }
    }

    fn enumerable_manifest(&self, workspace: &StoreWorkspace, directory: &Path, entry_name: &str) -> StoreResult<Option<Manifest>> {
        match read_manifest(&directory.join(entry_name)) {
            Ok(manifest) => {
                if entry_name != format!("{}.{}{MANIFEST_SUFFIX}", manifest.name, manifest.provenance_hash) {
                    return Ok(None);
                }
                let directory_name = directory.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                match assert_address_integrity(&manifest, &directory_name, &manifest.provenance_hash.clone(), &manifest.name.clone()) {
                    Ok(()) => Ok(belongs_to(&manifest, workspace).then_some(manifest)),
                    Err(error) if recoverable(&error) => Ok(None),
                    Err(error) => Err(error),
                }
            }
            Err(error) if recoverable(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn link_of(&self, workspace: &StoreWorkspace, manifest: &Manifest) -> ArtifactLink {
        ArtifactLink {
            uri: artifact_uri(&workspace.id, &manifest.sha256, &manifest.provenance_hash, &manifest.name),
            name: manifest.name.clone(),
            mime_type: manifest.mime_type.clone(),
            size: manifest.size,
            sha256: manifest.sha256.clone(),
            description: manifest.description.clone(),
        }
    }

    fn check_budget(&self, workspace: &StoreWorkspace) -> StoreResult<()> {
        let (bytes, entries) = artifact_usage(&workspace.artifact_root, false)?;
        if bytes > self.limits.max_bytes || entries > self.limits.max_entries {
            return Err(StoreError::new("ARTIFACT_STORAGE_LIMIT", "Artifact storage exceeds the configured retention budget"));
        }
        Ok(())
    }

    /// Every artifact of the workspace, sorted by URI.
    pub fn list(&self, workspace: &StoreWorkspace) -> StoreResult<Vec<ArtifactLink>> {
        self.check_budget(workspace)?;
        let root = contained_path(&workspace.artifact_root, &[])?;
        let mut results = Vec::new();
        fn walk(store: &ArtifactStore, workspace: &StoreWorkspace, directory: &Path, results: &mut Vec<ArtifactLink>) -> StoreResult<()> {
            let Some(children) = read_dir_checked(directory)? else { return Ok(()) };
            let mut entries: Vec<(String, PathBuf, fs::FileType)> = children
                .into_iter()
                .filter_map(|child| child.file_type().ok().map(|kind| (child.file_name().to_string_lossy().into_owned(), child.path(), kind)))
                .collect();
            entries.sort_by(|left, right| compare_code_units(&left.0, &right.0));
            for (name, path, kind) in entries {
                if kind.is_dir() {
                    let relative = path.strip_prefix(directory).unwrap_or(&path).to_owned();
                    let contained = contained_path(&path_text(&strip_verbatim(directory.to_owned())), &[&path_text(&relative)])?;
                    walk(store, workspace, &contained, results)?;
                } else if kind.is_file()
                    && name.ends_with(MANIFEST_SUFFIX)
                    && let Some(manifest) = store.enumerable_manifest(workspace, directory, &name)?
                {
                    results.push(store.link_of(workspace, &manifest));
                }
            }
            Ok(())
        }
        walk(self, workspace, &root, &mut results)?;
        results.sort_by(|left, right| compare_code_units(&left.uri, &right.uri));
        Ok(results)
    }

    pub fn list_page(&self, workspace: &StoreWorkspace, limit: usize, after_uri: Option<&str>) -> StoreResult<ArtifactPage> {
        if !(1..=PAGE_MAX_ENTRIES).contains(&limit) {
            return Err(StoreError::new("ARTIFACT_PAGE_INVALID", format!("Artifact page limit must be between 1 and {PAGE_MAX_ENTRIES}")));
        }
        self.check_budget(workspace)?;
        let root = contained_path(&workspace.artifact_root, &[])?;
        let mut page = ArtifactPage { artifacts: Vec::new(), total: 0, revision: String::new(), after_found: after_uri.is_none(), has_more: false };
        let mut revision = Sha256::new();
        fn walk(
            store: &ArtifactStore,
            workspace: &StoreWorkspace,
            directory: &Path,
            limit: usize,
            after: Option<&str>,
            page: &mut ArtifactPage,
            revision: &mut Sha256,
        ) -> StoreResult<()> {
            let Some(children) = read_dir_checked(directory)? else { return Ok(()) };
            let entries: Vec<(String, PathBuf, fs::FileType)> = children
                .into_iter()
                .filter_map(|child| child.file_type().ok().map(|kind| (child.file_name().to_string_lossy().into_owned(), child.path(), kind)))
                .collect();
            let mut directories: Vec<_> = entries.iter().filter(|entry| entry.2.is_dir()).collect();
            directories.sort_by(|left, right| compare_code_units(&left.0, &right.0));
            for (_, path, _) in directories {
                let contained = contained_path(
                    &path_text(&strip_verbatim(directory.to_owned())),
                    &[&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()],
                )?;
                walk(store, workspace, &contained, limit, after, page, revision)?;
            }
            let mut manifests: Vec<_> = entries.iter().filter(|entry| entry.2.is_file() && entry.0.ends_with(MANIFEST_SUFFIX)).collect();
            manifests.sort_by(|left, right| compare_code_units(&sort_key_of_manifest(&left.0), &sort_key_of_manifest(&right.0)));
            for (name, _, _) in manifests {
                let Some(manifest) = store.enumerable_manifest(workspace, directory, name)? else { continue };
                let link = store.link_of(workspace, &manifest);
                revision.update(format!("{}:{}", link.uri.len(), link.uri).as_bytes());
                page.total += 1;
                if !page.after_found {
                    if Some(link.uri.as_str()) == after {
                        page.after_found = true;
                    }
                    continue;
                }
                if page.artifacts.len() < limit {
                    page.artifacts.push(link);
                } else {
                    page.has_more = true;
                }
            }
            Ok(())
        }
        walk(self, workspace, &root, limit, after_uri, &mut page, &mut revision)?;
        page.revision = revision.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(page)
    }

    pub fn describe(&self, workspace: &StoreWorkspace, uri: &str) -> StoreResult<StoredArtifact> {
        let parsed = parse_uri(workspace, uri)?;
        let manifest_name = format!("{}.{}{MANIFEST_SUFFIX}", parsed.name, parsed.provenance_hash);
        let target = contained_path(&workspace.artifact_root, &[&parsed.sha256[..2], &parsed.sha256, &manifest_name])?;
        let manifest = read_manifest(&target)?;
        assert_address_integrity(&manifest, &parsed.sha256, &parsed.provenance_hash, &parsed.name)?;
        if !belongs_to(&manifest, workspace) {
            return Err(StoreError::new("ARTIFACT_NOT_FOUND", "Artifact provenance manifest is unavailable"));
        }
        let path = contained_path(&workspace.artifact_root, &[&parsed.sha256[..2], &parsed.sha256, &parsed.name])?;
        Ok(StoredArtifact {
            link: ArtifactLink {
                uri: uri.to_owned(),
                name: manifest.name.clone(),
                mime_type: manifest.mime_type.clone(),
                size: manifest.size,
                sha256: manifest.sha256.clone(),
                description: manifest.description.clone(),
            },
            provenance_hash: manifest.provenance_hash.clone(),
            path: path_text(&path),
            provenance: manifest.provenance,
        })
    }

    /// True when every URI describes an artifact that is still stored.
    pub fn available(&self, workspace: &StoreWorkspace, uris: &[String]) -> StoreResult<bool> {
        for uri in uris {
            match self.describe(workspace, uri) {
                Ok(_) => {}
                Err(error) if recoverable(&error) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }

    pub fn read(&self, workspace: &StoreWorkspace, uri: &str, range: Option<(u64, u64)>) -> StoreResult<ReadResult> {
        let parsed = parse_uri(workspace, uri)?;
        let target = contained_path(&workspace.artifact_root, &[&parsed.sha256[..2], &parsed.sha256, &parsed.name])?;
        let manifest_name = format!("{}.{}{MANIFEST_SUFFIX}", parsed.name, parsed.provenance_hash);
        let manifest_path = contained_path(&workspace.artifact_root, &[&parsed.sha256[..2], &parsed.sha256, &manifest_name])?;
        let manifest = read_manifest(&manifest_path)?;
        assert_address_integrity(&manifest, &parsed.sha256, &parsed.provenance_hash, &parsed.name)?;
        if !belongs_to(&manifest, workspace) {
            return Err(StoreError::new("ARTIFACT_NOT_FOUND", "Artifact provenance manifest is unavailable"));
        }
        let read = read_verified_range(&verification_scope(workspace), &target, &parsed.sha256, range)?;
        refresh_manifest(&manifest_path)?;
        Ok(ReadResult { bytes: read.bytes, mime_type: manifest.mime_type, name: parsed.name, total_size: read.total_size })
    }

    /// Reads one stored object or an authenticated chunk index as exact logical bytes.
    pub fn read_logical(&self, workspace: &StoreWorkspace, uri: &str, mime_type: &str, max_bytes: u64, max_chunks: usize) -> StoreResult<ReadResult> {
        let initial = self.read(workspace, uri, None)?;
        if initial.mime_type != mime_type {
            return Err(StoreError::new("ARTIFACT_LOGICAL_TYPE_MISMATCH", format!("Logical artifact must use {mime_type}")));
        }
        let too_big = || StoreError::new("ARTIFACT_LOGICAL_LIMIT", "Logical artifact exceeds its fixed byte ceiling");
        let parsed: Option<Value> = serde_json::from_slice(&initial.bytes).ok();
        let index = match parsed {
            Some(Value::Object(object)) if object.get("type") == Some(&json!("hoi4-agent.chunked-artifact")) => object,
            _ => {
                if initial.total_size > max_bytes {
                    return Err(too_big());
                }
                return Ok(initial);
            }
        };
        let malformed = || StoreError::new("ARTIFACT_LOGICAL_INVALID", "Chunked logical artifact index is malformed or exceeds its fixed limits");
        let original = index.get("original").and_then(Value::as_object).ok_or_else(malformed)?;
        let chunks = index.get("chunks").and_then(Value::as_array).ok_or_else(malformed)?;
        let size = original.get("size").and_then(Value::as_u64).ok_or_else(malformed)?;
        let original_sha = original.get("sha256").and_then(Value::as_str).filter(|hash| is_sha256(hash)).ok_or_else(malformed)?;
        if index.get("schemaVersion") != Some(&json!(1))
            || chunks.is_empty()
            || chunks.len() > max_chunks
            || original.get("mimeType").and_then(Value::as_str) != Some(mime_type)
            || size > max_bytes
        {
            return Err(malformed());
        }
        let entry_bad = || StoreError::new("ARTIFACT_LOGICAL_INVALID", "Chunked logical artifact entry is malformed");
        let mut bytes = Vec::with_capacity(size as usize);
        let mut seen = BTreeSet::new();
        let mut offset = 0u64;
        for (position, candidate) in chunks.iter().enumerate() {
            let length = candidate.get("length").and_then(Value::as_u64).unwrap_or(0);
            let chunk_uri = candidate.get("uri").and_then(Value::as_str).ok_or_else(entry_bad)?;
            let chunk_sha = candidate.get("sha256").and_then(Value::as_str).filter(|hash| is_sha256(hash)).ok_or_else(entry_bad)?;
            if candidate.get("index").and_then(Value::as_u64) != Some(position as u64)
                || candidate.get("offset").and_then(Value::as_u64) != Some(offset)
                || length == 0
                || candidate.get("size").and_then(Value::as_u64) != Some(length)
                || candidate.get("mimeType") != Some(&json!("application/octet-stream"))
                || !seen.insert(chunk_uri.to_owned())
                || offset + length > size
            {
                return Err(entry_bad());
            }
            let chunk = self.read(workspace, chunk_uri, None)?;
            if chunk.mime_type != "application/octet-stream"
                || chunk.total_size != length
                || chunk.bytes.len() as u64 != length
                || sha256_hex(&chunk.bytes) != chunk_sha
            {
                return Err(StoreError::new("ARTIFACT_LOGICAL_INVALID", "Chunked logical artifact content does not match its authenticated index"));
            }
            offset += length;
            bytes.extend_from_slice(&chunk.bytes);
        }
        if offset != size || bytes.len() as u64 != size || sha256_hex(&bytes) != original_sha {
            return Err(StoreError::new("ARTIFACT_LOGICAL_INVALID", "Chunked logical artifact does not reconstruct its declared content"));
        }
        Ok(ReadResult {
            bytes,
            mime_type: mime_type.to_owned(),
            name: original.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            total_size: size,
        })
    }

    fn preflight(&self, writes: &[ArtifactWrite], chunked: bool) -> StoreResult<(Vec<u64>, u64)> {
        let StoreLimits { max_bytes, max_entries, max_single_bytes } = self.limits;
        if max_bytes < 1 || max_entries < 1 || max_single_bytes < 1 || max_single_bytes > max_bytes {
            return Err(StoreError::new("ARTIFACT_STORAGE_LIMIT", "Configured artifact limits are invalid"));
        }
        let (mut lengths, mut total, mut projected) = (Vec::new(), 0u64, 0u64);
        for write in writes {
            if !is_valid_artifact_name(&write.name) {
                return Err(StoreError::new("ARTIFACT_NAME_INVALID", format!("Invalid artifact name: {}", write.name)));
            }
            if !provenance_valid(&write.provenance) {
                return Err(StoreError::new("ARTIFACT_PROVENANCE_INVALID", "Artifact provenance must contain only valid SHA-256 source hashes"));
            }
            let length = write.content.len() as u64;
            if !chunked && length > max_single_bytes {
                return Err(StoreError::with_details(
                    "ARTIFACT_SINGLE_LIMIT",
                    "Artifact exceeds the configured per-artifact byte limit",
                    json!({ "name": write.name, "mimeType": write.mime_type, "size": length, "maximumBytes": max_single_bytes }),
                ));
            }
            lengths.push(length);
            total += length;
            projected += if chunked && length > max_single_bytes { length.div_ceil(max_single_bytes) + 1 } else { 1 };
        }
        let ceiling = max_bytes.min(LOGICAL_BATCH_MAX_BYTES);
        if total > ceiling {
            let fixed = LOGICAL_BATCH_MAX_BYTES <= max_bytes;
            let mut largest: Vec<(&str, u64)> = writes.iter().zip(&lengths).map(|(write, size)| (write.name.as_str(), *size)).collect();
            largest.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| compare_code_units(left.0, right.0)));
            largest.truncate(3);
            let mib = |bytes: u64| format!("{:.1} MiB", bytes as f64 / 1_048_576.0);
            let listing = largest.iter().map(|(name, size)| format!("{name} {}", mib(*size))).collect::<Vec<_>>().join(", ");
            let lead = if fixed {
                "Logical artifact batch exceeds the fixed in-memory preparation ceiling"
            } else {
                "Logical artifact batch exceeds the configured aggregate artifact-byte limit"
            };
            return Err(StoreError::with_details(
                if fixed { "ARTIFACT_LOGICAL_BATCH_LIMIT" } else { "ARTIFACT_STORAGE_LIMIT" },
                format!("{lead} ({} in {} artifacts, limit {}; largest: {listing})", mib(total), writes.len(), mib(ceiling)),
                json!({ "size": total, "maximumBytes": ceiling, "artifacts": writes.len(), "largest": largest.iter().map(|(name, size)| json!({ "name": name, "size": size })).collect::<Vec<_>>() }),
            ));
        }
        if projected > max_entries {
            return Err(StoreError::with_details(
                "ARTIFACT_STORAGE_LIMIT",
                "Artifact batch exceeds the configured artifact-entry limit",
                json!({ "projectedEntries": projected, "maximumEntries": max_entries }),
            ));
        }
        Ok((lengths, projected))
    }

    fn planned(&self, workspace: &StoreWorkspace, write: &ArtifactWrite, sha256: &str) -> Manifest {
        let mut manifest = Manifest {
            workspace_identity: workspace.workspace_identity.clone(),
            owner_identity: workspace.owner_identity.clone(),
            name: write.name.clone(),
            mime_type: write.mime_type.clone(),
            size: write.content.len() as u64,
            sha256: sha256.to_owned(),
            provenance_hash: String::new(),
            provenance: write.provenance.clone(),
            description: write.description.clone(),
        };
        manifest.provenance_hash = provenance_hash_for(&manifest);
        manifest
    }

    /// Stores logical artifacts; content over the single-object limit becomes numbered chunks plus
    /// an index. The returned list is in the caller's order (the index stands for a chunked write),
    /// with every physical artifact beside it.
    pub fn put_chunked(
        &self,
        workspace: &StoreWorkspace,
        writes: &[ArtifactWrite],
        retained: Option<&[String]>,
    ) -> StoreResult<(Vec<StoredArtifact>, Vec<StoredArtifact>, Created)> {
        let (_, projected) = self.preflight(writes, true)?;
        let max_single = self.limits.max_single_bytes as usize;
        let mut physical: Vec<ArtifactWrite> = Vec::new();
        let mut logical = Vec::new();
        for write in writes {
            if write.content.len() <= max_single {
                logical.push(physical.len());
                physical.push(write.clone());
                continue;
            }
            let original_sha = sha256_hex(&write.content);
            let original = json!({ "name": write.name, "mimeType": write.mime_type, "size": write.content.len(), "sha256": original_sha });
            let chunk_count = write.content.len().div_ceil(max_single);
            let mut chunks = Vec::new();
            for index in 0..chunk_count {
                let offset = index * max_single;
                let content = write.content[offset..(offset + max_single).min(write.content.len())].to_vec();
                let name = chunk_artifact_name(&original_sha, index);
                let provenance = chunked_provenance(
                    &write.provenance,
                    "chunk",
                    &original,
                    json!({ "chunkIndex": index, "chunkCount": chunk_count, "offset": offset, "length": content.len() }),
                );
                let chunk_write = ArtifactWrite {
                    name,
                    mime_type: "application/octet-stream".into(),
                    provenance,
                    description: Some(format!("Byte-exact chunk {} of {chunk_count} for {}", index + 1, write.name)),
                    content,
                };
                let chunk_sha = sha256_hex(&chunk_write.content);
                let manifest = self.planned(workspace, &chunk_write, &chunk_sha);
                chunks.push(json!({
                    "index": index, "offset": offset, "length": chunk_write.content.len(),
                    "uri": artifact_uri(&workspace.id, &chunk_sha, &manifest.provenance_hash, &chunk_write.name),
                    "name": chunk_write.name, "mimeType": "application/octet-stream", "size": chunk_write.content.len(), "sha256": chunk_sha,
                }));
                physical.push(chunk_write);
            }
            let mut original_with_description = original.clone();
            if let Some(description) = &write.description {
                original_with_description["description"] = json!(description);
            }
            let index_document = json!({ "schemaVersion": 1, "type": "hoi4-agent.chunked-artifact", "original": original_with_description, "chunks": chunks });
            let index_content = format!("{}\n", canonical_json(&index_document)).into_bytes();
            if index_content.len() as u64 > self.limits.max_single_bytes || index_content.len() as u64 > MANIFEST_MAX_BYTES {
                return Err(StoreError::with_details(
                    "ARTIFACT_CHUNK_INDEX_LIMIT",
                    "Chunked artifact index exceeds its fixed single-resource byte limit",
                    json!({ "name": write.name, "size": index_content.len(), "maximumBytes": self.limits.max_single_bytes.min(MANIFEST_MAX_BYTES) }),
                ));
            }
            logical.push(physical.len());
            physical.push(ArtifactWrite {
                name: chunk_index_artifact_name(&write.name, &original_sha),
                mime_type: CHUNKED_INDEX_MIME_TYPE.into(),
                content: index_content,
                provenance: chunked_provenance(&write.provenance, "index", &original, json!({ "chunkCount": chunk_count, "indexSchemaVersion": 1 })),
                description: Some(match &write.description {
                    None => format!("Byte-exact chunk index for {}", write.name),
                    Some(description) => format!("{description} (byte-exact chunk index)"),
                }),
            });
        }
        if physical.len() as u64 != projected {
            return Err(StoreError::new("ARTIFACT_STORAGE_LIMIT", "Artifact batch entry projection did not match prepared output"));
        }
        let (stored, created) = self.put_batch(workspace, &physical, retained)?;
        Ok((logical.iter().map(|index| stored[*index].clone()).collect(), stored, created))
    }

    /// Persists a batch of immutable artifacts as one failure boundary: files this batch created are
    /// removed when a write fails, and pre-existing files are never removed.
    pub fn put_batch(&self, workspace: &StoreWorkspace, writes: &[ArtifactWrite], retained: Option<&[String]>) -> StoreResult<(Vec<StoredArtifact>, Created)> {
        let (lengths, _) = self.preflight(writes, false)?;
        let mut prepared: Vec<Prepared> = Vec::new();
        for (write, expected) in writes.iter().zip(&lengths) {
            if write.content.len() as u64 != *expected {
                return Err(StoreError::with_details(
                    "ARTIFACT_CONTENT_CHANGED",
                    "Artifact content length changed after batch admission",
                    json!({ "name": write.name }),
                ));
            }
            let sha256 = sha256_hex(&write.content);
            let manifest = self.planned(workspace, write, &sha256);
            let manifest_bytes = manifest.bytes();
            if manifest_bytes.len() as u64 > self.limits.max_single_bytes || manifest_bytes.len() as u64 > MANIFEST_MAX_BYTES {
                return Err(StoreError::new("ARTIFACT_MANIFEST_LIMIT", "Artifact provenance exceeds its fixed manifest byte limit"));
            }
            let prefix = &sha256[..2];
            let directory = contained_path(&workspace.artifact_root, &[prefix, &sha256])?;
            let target = contained_path(&workspace.artifact_root, &[prefix, &sha256, &write.name])?;
            let manifest_path =
                contained_path(&workspace.artifact_root, &[prefix, &sha256, &format!("{}.{}{MANIFEST_SUFFIX}", write.name, manifest.provenance_hash)])?;
            let artifact = StoredArtifact {
                link: ArtifactLink {
                    uri: artifact_uri(&workspace.id, &sha256, &manifest.provenance_hash, &write.name),
                    name: write.name.clone(),
                    mime_type: write.mime_type.clone(),
                    size: write.content.len() as u64,
                    sha256: sha256.clone(),
                    description: write.description.clone(),
                },
                provenance_hash: manifest.provenance_hash.clone(),
                path: path_text(&target),
                provenance: write.provenance.clone(),
            };
            prepared.push(Prepared { artifact, bytes: write.content.clone(), directory, target, manifest_path, manifest_bytes });
        }

        let _lock = PublishLock::take(&workspace.artifact_root)?;
        let root = contained_path(&workspace.artifact_root, &[])?;
        let now = self.now_ms.unwrap_or_else(wall_clock_ms);
        let mut claims = ClaimState::load(&root, now)?;
        let mut targets: Vec<(&Prepared, bool)> = Vec::new();
        let mut manifests: Vec<(&Prepared, bool)> = Vec::new();
        for item in &prepared {
            if let Some((seen, _)) = targets.iter().find(|(seen, _)| seen.target == item.target) {
                if seen.bytes != item.bytes {
                    return Err(StoreError::new("ARTIFACT_HASH_COLLISION", "Artifact batch maps different bytes to the same content path"));
                }
            } else {
                let exists = item.target.exists();
                if exists && read_verified_range(&verification_scope(workspace), &item.target, &item.artifact.link.sha256, Some((0, 1))).is_err() {
                    return Err(StoreError::new("ARTIFACT_HASH_COLLISION", "Artifact path contains different bytes"));
                }
                targets.push((item, exists));
            }
            if let Some((seen, _)) = manifests.iter().find(|(seen, _)| seen.manifest_path == item.manifest_path) {
                if seen.manifest_bytes != item.manifest_bytes {
                    return Err(StoreError::new(
                        "ARTIFACT_MANIFEST_INTEGRITY_FAILED",
                        "Artifact batch maps different provenance to the same immutable manifest",
                    ));
                }
            } else {
                manifests.push((item, existing_manifest_matches(&item.manifest_path, &item.manifest_bytes)?));
            }
        }
        let additional_bytes: u64 = targets.iter().filter(|(_, exists)| !exists).map(|(item, _)| item.bytes.len() as u64).sum::<u64>()
            + manifests.iter().filter(|(_, exists)| !exists).map(|(item, _)| item.manifest_bytes.len() as u64).sum::<u64>();
        let additional_entries = manifests.iter().filter(|(_, exists)| !exists).count() as u64;
        let usage = artifact_usage(&workspace.artifact_root, true)?;
        let mut protected_manifests: BTreeSet<PathBuf> = manifests.iter().map(|(item, _)| item.manifest_path.clone()).collect();
        let mut protected_targets: BTreeSet<PathBuf> = targets.iter().map(|(item, _)| item.target.clone()).collect();
        for claimed in claims.protected(&root) {
            protected_manifests.insert(claimed.clone());
            protected_targets.insert(claimed);
        }
        self.prune_for_admission(
            workspace,
            usage,
            additional_bytes,
            additional_entries,
            &mut protected_manifests,
            &mut protected_targets,
            retained,
            claims.epoch,
        )?;

        let mut created = Created::default();
        let outcome = (|| -> StoreResult<()> {
            for (item, exists) in &targets {
                if *exists {
                    continue;
                }
                fs::create_dir_all(&item.directory).map_err(|_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact content could not be written"))?;
                if publish_exclusive(&item.target, &item.bytes)? {
                    created.targets.push(path_text(&item.target));
                } else if read_verified_range(&verification_scope(workspace), &item.target, &item.artifact.link.sha256, Some((0, 1))).is_err() {
                    return Err(StoreError::new("ARTIFACT_HASH_COLLISION", "Artifact path contains different bytes"));
                }
            }
            for (item, exists) in &manifests {
                if *exists {
                    continue;
                }
                fs::create_dir_all(&item.directory).map_err(|_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact content could not be written"))?;
                if publish_exclusive(&item.manifest_path, item.manifest_bytes.as_bytes())? {
                    created.manifests.push(path_text(&item.manifest_path));
                } else if !existing_manifest_matches(&item.manifest_path, &item.manifest_bytes)? {
                    return Err(StoreError::new("ARTIFACT_MANIFEST_INVALID", "Concurrent artifact provenance manifest publication did not complete"));
                }
            }
            for (item, _) in &manifests {
                refresh_manifest(&item.manifest_path)?;
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            self.remove_created(&created)?;
            return Err(error);
        }
        let used: BTreeSet<String> =
            prepared.iter().flat_map(|item| [claim_relative(&root, &item.target), claim_relative(&root, &item.manifest_path)]).collect();
        let registered = claims.register(&root, &created, used, now).and_then(|token| claims.save(&root).map(|()| token));
        match registered {
            Ok(token) => created.batch = Some(token),
            Err(error) => {
                self.remove_created(&created)?;
                return Err(error);
            }
        }
        Ok((prepared.into_iter().map(|item| item.artifact).collect(), created))
    }

    /// Takes back the files a batch created, when the caller's own commit failed. Content with
    /// another manifest is kept, nothing the batch did not create is touched, and a file that
    /// another batch reused after this one created it stays, because that batch may have committed.
    pub fn release(&self, workspace: &StoreWorkspace, created: &Created) -> StoreResult<()> {
        let _lock = PublishLock::take(&workspace.artifact_root)?;
        let root = contained_path(&workspace.artifact_root, &[])?;
        for path in created.manifests.iter().chain(&created.targets) {
            contained_path(&workspace.artifact_root, &[&relative_to_root(workspace, path)?])?;
        }
        let mut claims = ClaimState::load(&root, self.now_ms.unwrap_or_else(wall_clock_ms))?;
        let shared = claims.settle(created.batch.as_deref());
        let kept = |path: &&String| !shared.contains(&claim_relative(&root, Path::new(path.as_str())));
        let own = Created {
            targets: created.targets.iter().filter(kept).cloned().collect(),
            manifests: created.manifests.iter().filter(kept).cloned().collect(),
            batch: None,
        };
        let removed = self.remove_created(&own);
        claims.save(&root)?;
        removed
    }

    /// The caller's commit succeeded: the batch's files are the caller's now and may be evicted
    /// like any other unpinned artifact. The commit epoch moves in the same locked step.
    pub fn commit(&self, workspace: &StoreWorkspace, created: &Created) -> StoreResult<()> {
        let _lock = PublishLock::take(&workspace.artifact_root)?;
        let root = contained_path(&workspace.artifact_root, &[])?;
        let mut claims = ClaimState::load(&root, self.now_ms.unwrap_or_else(wall_clock_ms))?;
        claims.epoch = claims.epoch.wrapping_add(1);
        claims.settle(created.batch.as_deref());
        claims.save(&root)
    }

    fn remove_created(&self, created: &Created) -> StoreResult<()> {
        let mut failed = false;
        for manifest in created.manifests.iter().rev() {
            failed |= unlink_quiet(Path::new(manifest)).is_err();
        }
        for target in created.targets.iter().rev() {
            let target = Path::new(target);
            let prefix = format!("{}.", target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
            let siblings = match target.parent().map(read_dir_checked) {
                Some(Ok(entries)) => entries.unwrap_or_default(),
                _ => {
                    failed = true;
                    continue;
                }
            };
            let has_manifest = siblings
                .iter()
                .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix) && entry.file_name().to_string_lossy().ends_with(MANIFEST_SUFFIX));
            if !has_manifest {
                failed |= unlink_quiet(target).is_err();
                forget_verified(target);
            }
        }
        if failed {
            return Err(StoreError::new("ARTIFACT_BATCH_ROLLBACK_FAILED", "Artifact batch failed and its newly created files could not all be removed"));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn prune_for_admission(
        &self,
        workspace: &StoreWorkspace,
        usage: (u64, u64),
        additional_bytes: u64,
        additional_entries: u64,
        protected_manifests: &mut BTreeSet<PathBuf>,
        protected_targets: &mut BTreeSet<PathBuf>,
        retained_uris: Option<&[String]>,
        epoch: u64,
    ) -> StoreResult<()> {
        let StoreLimits { max_bytes, max_entries, .. } = self.limits;
        let (mut usage_bytes, mut usage_entries) = usage;
        if usage_entries + additional_entries <= max_entries && usage_bytes <= max_bytes.saturating_sub(additional_bytes) && additional_bytes <= max_bytes {
            return Ok(());
        }
        // The caller keeps durable pins of its own: it must hand them over before anything is evicted.
        let retention_required =
            || StoreError::with_details("ARTIFACT_RETENTION_REQUIRED", "Artifact admission needs the caller's retained artifacts", json!({ "epoch": epoch }));
        let Some(retained_uris) = retained_uris else {
            return Err(retention_required());
        };
        if self.retention_epoch.is_some_and(|expected| expected != epoch) {
            return Err(retention_required());
        }
        for uri in retained_uris {
            let parsed = parse_uri(workspace, uri)?;
            protected_targets.insert(contained_path(&workspace.artifact_root, &[&parsed.sha256[..2], &parsed.sha256, &parsed.name])?);
            protected_manifests.insert(contained_path(
                &workspace.artifact_root,
                &[&parsed.sha256[..2], &parsed.sha256, &format!("{}.{}{MANIFEST_SUFFIX}", parsed.name, parsed.provenance_hash)],
            )?);
        }
        let target_bytes = max_bytes.saturating_sub(additional_bytes).min(max_bytes * 3 / 4);
        let target_entries = max_entries.saturating_sub(additional_entries).min(max_entries * 3 / 4);

        struct Retained {
            manifest: Manifest,
            stale_identity: bool,
            manifest_path: PathBuf,
            manifest_bytes: u64,
            modified_at: f64,
            target_path: PathBuf,
            target_bytes: u64,
        }
        let root = contained_path(&workspace.artifact_root, &[])?;
        let mut retained: Vec<Retained> = Vec::new();
        fn walk(workspace: &StoreWorkspace, directory: &Path, retained: &mut Vec<Retained>, usage_bytes: &mut u64, usage_entries: &mut u64) -> StoreResult<()> {
            let Some(children) = read_dir_checked(directory)? else { return Ok(()) };
            for child in children {
                let name = child.file_name().to_string_lossy().into_owned();
                let Some(metadata) = metadata_checked(&child.path())? else { continue };
                if metadata.file_type().is_symlink() {
                    return Err(StoreError::new("ARTIFACT_STORAGE_UNSAFE", "Artifact storage contains a symbolic link or junction"));
                }
                if metadata.is_dir() {
                    walk(workspace, &child.path(), retained, usage_bytes, usage_entries)?;
                    continue;
                }
                if !metadata.is_file() || !name.ends_with(MANIFEST_SUFFIX) {
                    continue;
                }
                let candidate = child.path();
                let drop_entry = |usage_bytes: &mut u64, usage_entries: &mut u64| {
                    let _ = unlink_quiet(&candidate);
                    *usage_entries = usage_entries.saturating_sub(1);
                    *usage_bytes = usage_bytes.saturating_sub(metadata.len());
                };
                let manifest = match read_manifest(&candidate) {
                    Ok(manifest) => manifest,
                    Err(error) if error.code == "ARTIFACT_NOT_FOUND" => continue,
                    Err(error) if recoverable(&error) => {
                        drop_entry(usage_bytes, usage_entries);
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let directory_name = directory.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let sound = name == format!("{}.{}{MANIFEST_SUFFIX}", manifest.name, manifest.provenance_hash)
                    && assert_address_integrity(&manifest, &directory_name, &manifest.provenance_hash, &manifest.name).is_ok();
                if !sound {
                    drop_entry(usage_bytes, usage_entries);
                    continue;
                }
                let target_path = directory.join(&manifest.name);
                let target_bytes = fs::metadata(&target_path).map(|m| m.len()).unwrap_or(0);
                retained.push(Retained {
                    stale_identity: !belongs_to(&manifest, workspace),
                    manifest,
                    manifest_path: candidate,
                    manifest_bytes: metadata.len(),
                    modified_at: modified_ms(&metadata),
                    target_path,
                    target_bytes,
                });
            }
            Ok(())
        }
        walk(workspace, &root, &mut retained, &mut usage_bytes, &mut usage_entries)?;
        let referenced: BTreeSet<PathBuf> = retained.iter().map(|entry| entry.target_path.clone()).chain(protected_targets.iter().cloned()).collect();
        fn reclaim_debris(directory: &Path, referenced: &BTreeSet<PathBuf>, usage_bytes: &mut u64) -> StoreResult<()> {
            let Some(children) = read_dir_checked(directory)? else { return Ok(()) };
            for child in children {
                let name = child.file_name().to_string_lossy().into_owned();
                let path = child.path();
                let Some(metadata) = metadata_checked(&path)? else { continue };
                if metadata.file_type().is_symlink() {
                    return Err(StoreError::new("ARTIFACT_STORAGE_UNSAFE", "Artifact storage contains a symbolic link or junction"));
                }
                if metadata.is_dir() {
                    reclaim_debris(&path, referenced, usage_bytes)?;
                    continue;
                }
                if !metadata.is_file() || name.ends_with(MANIFEST_SUFFIX) || name == LOCK_FILE || name == CLAIMS_FILE {
                    continue;
                }
                let temporary = name.starts_with(TEMPORARY_PREFIX);
                if !temporary && referenced.contains(&path) {
                    continue;
                }
                if now_ms() - modified_ms(&metadata) < DEBRIS_MINIMUM_AGE_MS {
                    continue;
                }
                if unlink_quiet(&path).is_ok() && !temporary {
                    *usage_bytes = usage_bytes.saturating_sub(metadata.len());
                }
            }
            Ok(())
        }
        reclaim_debris(&root, &referenced, &mut usage_bytes)?;

        let mut group_age: BTreeMap<String, f64> = BTreeMap::new();
        let mut protected_groups: BTreeSet<String> = BTreeSet::new();
        for entry in &retained {
            if let Some((group, _)) = chunk_membership(&entry.manifest) {
                let age = group_age.entry(group.clone()).or_insert(0.0);
                *age = age.max(entry.modified_at);
                if protected_manifests.contains(&entry.manifest_path) || protected_targets.contains(&entry.target_path) {
                    protected_groups.insert(group);
                }
            }
        }
        let eviction_age = |entry: &Retained| chunk_membership(&entry.manifest).map_or(entry.modified_at, |(group, _)| group_age[&group]);
        let index_first = |entry: &Retained| u8::from(chunk_membership(&entry.manifest).is_some_and(|(_, role)| role == "chunk"));
        retained.sort_by(|left, right| {
            u8::from(right.stale_identity)
                .cmp(&u8::from(left.stale_identity))
                .then_with(|| eviction_age(left).total_cmp(&eviction_age(right)))
                .then_with(|| index_first(left).cmp(&index_first(right)))
                .then_with(|| compare_code_units(&path_text(&left.manifest_path), &path_text(&right.manifest_path)))
        });
        let (mut current_bytes, mut current_entries) = (usage_bytes, usage_entries);
        for candidate in &retained {
            if current_bytes <= target_bytes && current_entries <= target_entries {
                break;
            }
            if protected_manifests.contains(&candidate.manifest_path) {
                continue;
            }
            if let Some((group, _)) = chunk_membership(&candidate.manifest)
                && protected_groups.contains(&group)
            {
                continue;
            }
            if fs::remove_file(&candidate.manifest_path).is_err() {
                continue;
            }
            current_entries = current_entries.saturating_sub(1);
            current_bytes = current_bytes.saturating_sub(candidate.manifest_bytes);
            if protected_targets.contains(&candidate.target_path) {
                continue;
            }
            let prefix = format!("{}.", candidate.manifest.name);
            let has_manifest = candidate.target_path.parent().and_then(|parent| fs::read_dir(parent).ok()).is_some_and(|entries| {
                entries
                    .flatten()
                    .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix) && entry.file_name().to_string_lossy().ends_with(MANIFEST_SUFFIX))
            });
            if has_manifest {
                continue;
            }
            if unlink_quiet(&candidate.target_path).is_ok() {
                current_bytes = current_bytes.saturating_sub(candidate.target_bytes);
            }
        }
        if current_entries + additional_entries > max_entries || current_bytes > max_bytes.saturating_sub(additional_bytes) {
            return Err(StoreError::new("ARTIFACT_STORAGE_LIMIT", "Artifact batch cannot fit after reclaiming expired artifacts"));
        }
        Ok(())
    }
}

fn relative_to_root(workspace: &StoreWorkspace, path: &str) -> StoreResult<String> {
    let root = contained_path(&workspace.artifact_root, &[])?;
    Path::new(path)
        .strip_prefix(&root)
        .map(|relative| relative.to_string_lossy().into_owned())
        .map_err(|_| StoreError::new("PATH_GENERATED_ROOT_ESCAPE", "Generated storage path escapes its configured root"))
}

fn existing_manifest_matches(path: &Path, expected: &str) -> StoreResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    match read_manifest(path) {
        Ok(manifest) => {
            if format!("{}\n", canonical_json(&manifest.to_value())) == expected {
                return Ok(true);
            }
            let wanted = parse_manifest(expected).ok_or_else(|| StoreError::new("ARTIFACT_MANIFEST_INVALID", "Artifact provenance manifest is invalid"))?;
            match assert_address_integrity(&manifest, &wanted.sha256, &wanted.provenance_hash, &wanted.name) {
                Err(error) if recoverable(&error) => {
                    unlink_quiet(path).map_err(|_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact content could not be written"))?;
                    Ok(false)
                }
                Err(error) => Err(error),
                Ok(()) => Err(StoreError::new("ARTIFACT_MANIFEST_INTEGRITY_FAILED", "Immutable artifact provenance manifest contains different bytes")),
            }
        }
        Err(error) if error.code == "ARTIFACT_NOT_FOUND" => Ok(false),
        Err(error) if matches!(error.code, "ARTIFACT_MANIFEST_INVALID" | "ARTIFACT_MANIFEST_LIMIT") => {
            // An interrupted write is a prefix of the expected bytes or a stale zero fill; either way
            // the file is removed and written again. Any other invalid file is removed the same way.
            let _ = INTERRUPTED_MANIFEST_MINIMUM_AGE_MS;
            unlink_quiet(path).map_err(|_| StoreError::new("ARTIFACT_WRITE_FAILED", "Artifact content could not be written"))?;
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(root: &Path) -> StoreWorkspace {
        StoreWorkspace { id: "w1".into(), artifact_root: path_text(root), workspace_identity: "a".repeat(64), owner_identity: "b".repeat(64) }
    }

    fn provenance() -> Value {
        json!({ "kind": "test", "toolVersion": "1", "schemaVersion": "1", "sourceHashes": { "a.txt": "c".repeat(64) } })
    }

    fn write(name: &str, content: &[u8]) -> ArtifactWrite {
        ArtifactWrite { name: name.into(), mime_type: "text/plain".into(), content: content.to_vec(), provenance: provenance(), description: None }
    }

    #[test]
    fn stores_reads_lists_and_describes() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap();
        let uri = &stored[0].link.uri;
        assert!(uri.starts_with("hoi4-agent://workspace/w1/artifact/"));
        let read = store.read(&ws, uri, None).unwrap();
        assert_eq!((read.bytes.as_slice(), read.total_size, read.mime_type.as_str()), (&b"hello"[..], 5, "text/plain"));
        assert_eq!(store.read(&ws, uri, Some((1, 2))).unwrap().bytes, b"el");
        assert_eq!(store.list(&ws).unwrap().len(), 1);
        let page = store.list_page(&ws, 10, None).unwrap();
        assert_eq!((page.total, page.artifacts.len(), page.has_more), (1, 1, false));
        assert_eq!(store.describe(&ws, uri).unwrap().link.sha256, sha256_hex(b"hello"));
        // The same content stored again gives the same address and creates nothing.
        let (again, created) = store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap();
        assert_eq!(again[0].link.uri, *uri);
        assert!(created.targets.is_empty() && created.manifests.is_empty());
    }

    #[test]
    fn refuses_bad_names_provenance_and_other_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        assert_eq!(store.put_batch(&ws, &[write("../x", b"1")], Some(&[])).unwrap_err().code, "ARTIFACT_NAME_INVALID");
        assert_eq!(store.put_batch(&ws, &[write("CON.txt", b"1")], Some(&[])).unwrap_err().code, "ARTIFACT_NAME_INVALID");
        assert_eq!(store.put_batch(&ws, &[write("x.manifest.json", b"1")], Some(&[])).unwrap_err().code, "ARTIFACT_NAME_INVALID");
        let mut bad = write("a.txt", b"1");
        bad.provenance["sourceHashes"] = json!({ "a": "nothex" });
        assert_eq!(store.put_batch(&ws, &[bad], Some(&[])).unwrap_err().code, "ARTIFACT_PROVENANCE_INVALID");
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"1")], Some(&[])).unwrap();
        let other = StoreWorkspace { id: "w2".into(), ..ws.clone() };
        assert_eq!(store.read(&other, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_WORKSPACE_MISMATCH");
        let stranger = StoreWorkspace { owner_identity: "d".repeat(64), ..ws.clone() };
        assert_eq!(store.read(&stranger, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
        assert_eq!(store.read(&ws, &format!("{}?x=1", stored[0].link.uri), None).unwrap_err().code, "ARTIFACT_URI_INVALID");
    }

    #[test]
    fn detects_tampered_content_and_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap();
        let path = PathBuf::from(&stored[0].path);
        fs::write(&path, b"HELLO").unwrap();
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_INTEGRITY_FAILED");
        let manifest = path.with_file_name(format!("a.txt.{}.manifest.json", stored[0].provenance_hash));
        fs::write(&manifest, b"{}").unwrap();
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_MANIFEST_INVALID");
    }

    #[test]
    fn enforces_single_and_entry_limits_and_chunks_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::new(StoreLimits { max_bytes: 10_000, max_entries: 50, max_single_bytes: 2000 });
        assert_eq!(store.put_batch(&ws, &[write("big.txt", &[b'x'; 2001])], Some(&[])).unwrap_err().code, "ARTIFACT_SINGLE_LIMIT");
        let content: Vec<u8> = (0..5000u32).map(|n| (n % 251) as u8).collect();
        let mut big = write("big.bin", &content);
        big.mime_type = "application/json".into();
        let (logical, physical, _) = store.put_chunked(&ws, &[big], Some(&[])).unwrap();
        assert_eq!(physical.len(), 4);
        assert_eq!(logical.len(), 1);
        assert_eq!(logical[0].link.mime_type, "application/json");
        let whole = store.read_logical(&ws, &logical[0].link.uri, "application/json", 10_000, 10).unwrap();
        assert_eq!(whole.bytes, content);
        assert_eq!(whole.name, "big.bin");
        let few = ArtifactStore::new(StoreLimits { max_bytes: 10_000, max_entries: 2, max_single_bytes: 2000 });
        assert_eq!(few.put_batch(&ws, &[write("a", b"1"), write("b", b"2"), write("c", b"3")], Some(&[])).unwrap_err().code, "ARTIFACT_STORAGE_LIMIT");
    }

    #[test]
    fn release_takes_back_only_what_the_batch_created() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (kept, _) = store.put_batch(&ws, &[write("keep.txt", b"keep")], Some(&[])).unwrap();
        let (fresh, created) = store.put_batch(&ws, &[write("keep.txt", b"keep"), write("new.txt", b"new")], Some(&[])).unwrap();
        assert_eq!(created.manifests.len(), 1);
        store.release(&ws, &created).unwrap();
        assert!(store.read(&ws, &kept[0].link.uri, None).is_ok());
        assert_eq!(store.read(&ws, &fresh[1].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
        let outside = Created { targets: vec![], manifests: vec![path_text(&std::env::temp_dir().join("x.manifest.json"))], ..Default::default() };
        assert_eq!(store.release(&ws, &outside).unwrap_err().code, "PATH_GENERATED_ROOT_ESCAPE");
    }

    #[test]
    fn prunes_the_oldest_artifacts_to_admit_a_new_batch() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::new(StoreLimits { max_bytes: 100_000, max_entries: 3, max_single_bytes: 1000 });
        // Each caller commits its batch; only an uncommitted one is held against eviction.
        let (first, created) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        store.commit(&ws, &created).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let (_, created) = store.put_batch(&ws, &[write("b", b"2")], Some(&[])).unwrap();
        store.commit(&ws, &created).unwrap();
        let (_, created) = store.put_batch(&ws, &[write("c", b"3")], Some(&[])).unwrap();
        store.commit(&ws, &created).unwrap();
        let (fourth, created) = store.put_batch(&ws, &[write("d", b"4")], Some(&[])).unwrap();
        store.commit(&ws, &created).unwrap();
        assert!(store.read(&ws, &fourth[0].link.uri, None).is_ok());
        assert_eq!(store.read(&ws, &first[0].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
        // A retained URI survives the same pressure.
        let (kept, created) = store.put_batch(&ws, &[write("e", b"5")], Some(&[])).unwrap();
        store.commit(&ws, &created).unwrap();
        let (_, created) = store.put_batch(&ws, &[write("f", b"6")], Some(&[kept[0].link.uri.clone()])).unwrap();
        store.commit(&ws, &created).unwrap();
        store.put_batch(&ws, &[write("g", b"7")], Some(&[kept[0].link.uri.clone()])).unwrap();
        assert!(store.read(&ws, &kept[0].link.uri, None).is_ok());
    }

    #[test]
    fn rejects_a_link_that_leaves_the_storage_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&root).unwrap();
        // A junction or symlink may not be creatable without privileges; skip when it is not.
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, root.join("ab")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, root.join("ab")).is_ok();
        if linked {
            assert_eq!(contained_path(&path_text(&root), &["ab", "x"]).unwrap_err().code, "PATH_GENERATED_ROOT_ESCAPE");
        }
        assert_eq!(contained_path(&path_text(&root), &["..", "x"]).unwrap_err().code, "PATH_GENERATED_ROOT_ESCAPE");
    }

    #[test]
    fn source_hash_evidence_is_deterministic() {
        let hashes: BTreeMap<String, String> = [("b".to_string(), "1".repeat(64)), ("a".to_string(), "2".repeat(64))].into();
        let evidence = bounded_source_hash_evidence(&hashes);
        assert_eq!(evidence["inventory"]["count"], 2);
        assert_eq!(evidence["inventory"]["truncated"], false);
        assert_eq!(evidence, bounded_source_hash_evidence(&hashes));
    }

    #[test]
    fn chunk_names_match_the_typescript_ones() {
        assert_eq!(chunk_artifact_name(&"a".repeat(64), 3), format!("chunk-{}-000003.part", "a".repeat(64)));
        assert_eq!(chunk_index_artifact_name("map.json", &"b".repeat(64)), format!("map.json.{}.chunks.json", "b".repeat(16)));
    }

    fn manifest_path_of(stored: &StoredArtifact) -> PathBuf {
        let target = PathBuf::from(&stored.path);
        target.with_file_name(format!("{}.{}.manifest.json", stored.link.name, stored.provenance_hash))
    }

    fn small_store(max_entries: u64) -> ArtifactStore {
        ArtifactStore::new(StoreLimits { max_bytes: 1_000_000, max_entries, max_single_bytes: 2000 })
    }

    // ---- Review item 1: the claim a put holds until its caller commits or releases it.

    #[test]
    fn release_keeps_what_another_batch_reused_after_this_one_created_it() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (first, created_first) = store.put_batch(&ws, &[write("a.txt", b"same bytes")], Some(&[])).unwrap();
        assert_eq!(created_first.manifests.len(), 1);
        // A second call stores the same artifact: it reuses what the first created and commits.
        let (second, created_second) = store.put_batch(&ws, &[write("a.txt", b"same bytes")], Some(&[])).unwrap();
        assert!(created_second.targets.is_empty() && created_second.manifests.is_empty());
        assert_eq!(first[0].link.uri, second[0].link.uri);
        // The first call's own commit fails and it rolls back: the second call's URI must survive.
        store.release(&ws, &created_first).unwrap();
        assert_eq!(store.read(&ws, &second[0].link.uri, None).unwrap().bytes, b"same bytes");
        store.commit(&ws, &created_second).unwrap();
        assert_eq!(store.read(&ws, &second[0].link.uri, None).unwrap().bytes, b"same bytes");
    }

    #[test]
    fn release_still_takes_back_everything_nobody_else_reused() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, created) = store.put_batch(&ws, &[write("a.txt", b"mine")], Some(&[])).unwrap();
        let other = store.put_batch(&ws, &[write("b.txt", b"another artifact")], Some(&[])).unwrap();
        store.release(&ws, &created).unwrap();
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
        assert!(store.read(&ws, &other.0[0].link.uri, None).is_ok());
    }

    #[test]
    fn eviction_leaves_an_uncommitted_batch_alone_until_it_commits() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(2);
        let (first, created) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        // A second batch needs the room and has no pins: it may not evict the uncommitted first one.
        let refused = store.put_batch(&ws, &[write("b", b"2"), write("c", b"3")], Some(&[])).unwrap_err();
        assert_eq!(refused.code, "ARTIFACT_STORAGE_LIMIT");
        assert_eq!(store.read(&ws, &first[0].link.uri, None).unwrap().bytes, b"1");
        // Once the first caller commits, its artifact is an ordinary unpinned one.
        store.commit(&ws, &created).unwrap();
        assert!(store.put_batch(&ws, &[write("b", b"2"), write("c", b"3")], Some(&[])).is_ok());
        assert_eq!(store.read(&ws, &first[0].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
    }

    #[test]
    fn a_crash_between_put_and_commit_leaves_no_orphan_claim_past_the_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(2);
        let (_, created) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        let token = created.batch.clone().unwrap();
        let root = contained_path(&ws.artifact_root, &[]).unwrap();
        let on_disk = |now: u64| ClaimState::load(&root, now).unwrap();
        assert!(on_disk(wall_clock_ms()).claims.contains_key(&token));
        // The caller never commits or releases. Before the expiry the artifact is held...
        assert_eq!(store.put_batch(&ws, &[write("b", b"2"), write("c", b"3")], Some(&[])).unwrap_err().code, "ARTIFACT_STORAGE_LIMIT");
        // ...and after it, a later call evicts it like any other unpinned artifact and the claim is gone.
        let later = ArtifactStore { now_ms: Some(wall_clock_ms() + CLAIM_LIFETIME_MS + 1000), ..small_store(2) };
        assert!(later.put_batch(&ws, &[write("b", b"2"), write("c", b"3")], Some(&[])).is_ok());
        let after = ClaimState::load(&root, wall_clock_ms() + CLAIM_LIFETIME_MS + 1000).unwrap();
        assert!(!after.claims.contains_key(&token));
        assert!(!fs::read_to_string(root.join(CLAIMS_FILE)).unwrap().contains(&token));
    }

    #[test]
    fn a_stale_pin_list_is_refused_after_a_commit() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(2);
        let (_, held) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        store.commit(&ws, &held).unwrap();
        let wanted = [write("b", b"2"), write("c", b"3")];
        // Without pins the engine asks for them and says which epoch they must be read at.
        let asked = store.put_batch(&ws, &wanted, None).unwrap_err();
        assert_eq!(asked.code, "ARTIFACT_RETENTION_REQUIRED");
        let epoch = asked.details.as_ref().unwrap()["epoch"].as_u64().unwrap();
        // A commit made while the caller was reading its pins moves the epoch.
        let (_, checkpoint) = store.put_batch(&ws, &[write("x", b"9")], Some(&[])).unwrap();
        store.commit(&ws, &checkpoint).unwrap();
        let stale = ArtifactStore { retention_epoch: Some(epoch), ..small_store(2) };
        let refused = stale.put_batch(&ws, &wanted, Some(&[])).unwrap_err();
        assert_eq!(refused.code, "ARTIFACT_RETENTION_REQUIRED");
        let current = refused.details.as_ref().unwrap()["epoch"].as_u64().unwrap();
        assert_eq!(current, epoch + 1);
        let fresh = ArtifactStore { retention_epoch: Some(current), ..small_store(2) };
        assert!(fresh.put_batch(&ws, &wanted, Some(&[])).is_ok());
    }

    // ---- Review item 2: a cached verification must not outlive the file it was made on.

    #[test]
    fn a_replacement_with_the_same_size_and_modification_time_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap();
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap().bytes, b"hello");
        let path = PathBuf::from(&stored[0].path);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let replacement = path.with_file_name("replacement.part");
        fs::write(&replacement, b"HELLO").unwrap();
        fs::OpenOptions::new().write(true).open(&replacement).unwrap().set_modified(modified).unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 5);
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_INTEGRITY_FAILED");
        // The collision check of a put hashes it too, instead of accepting the cached answer.
        assert_eq!(store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap_err().code, "ARTIFACT_HASH_COLLISION");
    }

    #[test]
    fn an_in_place_rewrite_with_a_restored_modification_time_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap();
        assert!(store.read(&ws, &stored[0].link.uri, None).is_ok());
        let path = PathBuf::from(&stored[0].path);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&path, permissions);
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        std::io::Write::write_all(&mut &file, b"HELLO").unwrap();
        file.set_modified(modified).unwrap();
        drop(file);
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_INTEGRITY_FAILED");
    }

    #[test]
    fn an_unchanged_file_is_hashed_once_and_a_release_forgets_it() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, created) = store.put_batch(&ws, &[write("a.txt", b"hello")], Some(&[])).unwrap();
        let path = PathBuf::from(&stored[0].path);
        let key = verification_key(&verification_scope(&ws), &path);
        store.read(&ws, &stored[0].link.uri, None).unwrap();
        assert!(verified_cache().lock().unwrap().contains_key(&key));
        store.release(&ws, &created).unwrap();
        assert!(!verified_cache().lock().unwrap().contains_key(&key));
        // The same file read under another workspace identity is verified on its own.
        assert_ne!(verification_scope(&ws), verification_scope(&StoreWorkspace { owner_identity: "d".repeat(64), ..ws.clone() }));
    }

    // ---- Review item 8: storage that cannot be read is an error, not an empty folder.

    #[test]
    fn unreadable_storage_is_an_error_and_a_missing_folder_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert!(read_dir_checked(&missing).unwrap().is_none());
        assert!(metadata_checked(&missing).unwrap().is_none());
        let file = dir.path().join("a-file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(read_dir_checked(&file).unwrap_err().code, "ARTIFACT_STORAGE_UNSAFE");
        assert_eq!(read_dir_checked(dir.path()).unwrap().unwrap().len(), 1);
    }

    // ---- Review item 10: negative cases of the TypeScript suite.

    #[test]
    fn an_oversized_planted_manifest_is_refused_and_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"one"), write("b.txt", b"two")], Some(&[])).unwrap();
        fs::write(manifest_path_of(&stored[0]), vec![b' '; MANIFEST_MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_MANIFEST_LIMIT");
        assert_eq!(store.read(&ws, &stored[1].link.uri, None).unwrap().bytes, b"two");
        let listed = store.list(&ws).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].uri, stored[1].link.uri);
    }

    #[test]
    fn a_corrupted_manifest_does_not_hide_other_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"one"), write("b.txt", b"two")], Some(&[])).unwrap();
        fs::write(manifest_path_of(&stored[0]), b"{ not json").unwrap();
        assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap_err().code, "ARTIFACT_MANIFEST_INVALID");
        assert_eq!(store.read(&ws, &stored[1].link.uri, None).unwrap().bytes, b"two");
        assert_eq!(store.list(&ws).unwrap().len(), 1);
        assert_eq!(store.list_page(&ws, 10, None).unwrap().total, 1);
    }

    #[test]
    fn interrupted_and_zero_filled_manifests_are_repaired_by_the_next_put() {
        for damage in ["zeros", "prefix"] {
            let dir = tempfile::tempdir().unwrap();
            let ws = workspace(dir.path());
            let store = ArtifactStore::default();
            let (stored, _) = store.put_batch(&ws, &[write("a.txt", b"one")], Some(&[])).unwrap();
            let manifest = manifest_path_of(&stored[0]);
            let original = fs::read(&manifest).unwrap();
            let damaged = if damage == "zeros" { vec![0u8; original.len()] } else { original[..original.len() / 2].to_vec() };
            fs::write(&manifest, damaged).unwrap();
            assert!(store.read(&ws, &stored[0].link.uri, None).is_err(), "{damage}");
            let (again, created) = store.put_batch(&ws, &[write("a.txt", b"one")], Some(&[])).unwrap();
            assert_eq!(created.manifests.len(), 1, "{damage}");
            assert_eq!(again[0].link.uri, stored[0].link.uri);
            assert_eq!(fs::read(&manifest).unwrap(), original, "{damage}");
            assert_eq!(store.read(&ws, &stored[0].link.uri, None).unwrap().bytes, b"one");
        }
    }

    #[test]
    fn an_artifact_of_an_earlier_workspace_identity_is_reclaimed_first() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let earlier = StoreWorkspace { workspace_identity: "e".repeat(64), ..ws.clone() };
        let store = small_store(2);
        let (mine, _) = store.put_batch(&ws, &[write("mine", b"1")], Some(&[])).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        // Newer than mine, but written under an identity the workspace no longer has.
        let (stale, stale_created) = store.put_batch(&earlier, &[write("stale", b"2")], Some(&[])).unwrap();
        store.commit(&ws, &stale_created).unwrap();
        store.put_batch(&ws, &[write("third", b"3")], Some(&[])).unwrap();
        assert_eq!(store.read(&earlier, &stale[0].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
        assert_eq!(store.read(&ws, &mine[0].link.uri, None).unwrap().bytes, b"1");
    }

    #[test]
    fn a_chunk_group_is_evicted_by_its_newest_member_with_the_index_first() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(6);
        let content: Vec<u8> = (0..5000u32).map(|n| (n % 251) as u8).collect();
        let mut big = write("big.bin", &content);
        big.mime_type = "application/json".into();
        let (logical, physical, created) = store.put_chunked(&ws, &[big], Some(&[])).unwrap();
        assert_eq!(physical.len(), 4);
        store.commit(&ws, &created).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let (single, single_created) = store.put_batch(&ws, &[write("s", b"s")], Some(&[])).unwrap();
        store.commit(&ws, &single_created).unwrap();
        let (_, other_created) = store.put_batch(&ws, &[write("t", b"t")], Some(&[])).unwrap();
        store.commit(&ws, &other_created).unwrap();
        // The seventh entry forces one eviction: the oldest group goes, its index before its chunks.
        let (_, last) = store.put_batch(&ws, &[write("u", b"u")], Some(&[])).unwrap();
        store.commit(&ws, &last).unwrap();
        assert!(store.read_logical(&ws, &logical[0].link.uri, "application/json", 10_000, 10).is_err());
        assert_eq!(store.read(&ws, &single[0].link.uri, None).unwrap().bytes, b"s");
        let surviving_chunks = physical[..3].iter().filter(|chunk| store.read(&ws, &chunk.link.uri, None).is_ok()).count();
        assert!(surviving_chunks >= 2, "only the index and at most one chunk may be gone, {surviving_chunks} chunks remain");
    }

    #[test]
    fn range_reads_are_capped_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = ArtifactStore::default();
        let content = vec![7u8; READ_BUFFER_BYTES + 500_000];
        let (stored, _) = store.put_batch(&ws, &[write("big.bin", &content)], Some(&[])).unwrap();
        let uri = &stored[0].link.uri;
        let capped = store.read(&ws, uri, Some((0, u64::MAX))).unwrap();
        assert_eq!((capped.bytes.len(), capped.total_size), (READ_BUFFER_BYTES, content.len() as u64));
        let tail = store.read(&ws, uri, Some((content.len() as u64 - 10, 100))).unwrap();
        assert_eq!(tail.bytes.len(), 10);
        let beyond = store.read(&ws, uri, Some((u64::MAX, 5))).unwrap();
        assert!(beyond.bytes.is_empty());
        assert_eq!(store.read(&ws, uri, Some((0, 0))).unwrap_err().code, "ARTIFACT_RANGE_INVALID");
    }

    // ---- Claims live on disk, so they hold across engine processes that share one root.

    /// The child process of the cross-process tests: a normal run returns at once.
    #[test]
    fn claim_child_process() {
        let Ok(spec) = std::env::var("HOI4_CLAIM_CHILD") else { return };
        let (mode, root) = spec.split_once('|').expect("mode|root");
        let ws = workspace(Path::new(root));
        let store = small_store(2);
        let code = match mode {
            "reuse" => match store.put_batch(&ws, &[write("a", b"1")], Some(&[])) {
                Ok((_, created)) => {
                    store.commit(&ws, &created).expect("commit");
                    0
                }
                Err(_) => 3,
            },
            "evict" => match store.put_batch(&ws, &[write("b", b"2"), write("c", b"3")], Some(&[])) {
                Ok(_) => 0,
                Err(error) if error.code == "ARTIFACT_STORAGE_LIMIT" => 4,
                Err(_) => 5,
            },
            _ => 6,
        };
        std::process::exit(code);
    }

    fn run_child(mode: &str, root: &Path) -> i32 {
        std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args(["store::tests::claim_child_process", "--exact", "--nocapture", "--test-threads=1"])
            .env("HOI4_CLAIM_CHILD", format!("{mode}|{}", path_text(root)))
            .status()
            .expect("child process")
            .code()
            .unwrap_or(-1)
    }

    #[test]
    fn another_process_that_reused_a_file_keeps_it_through_this_release() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(2);
        let (first, created) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        // Another engine process stores the same artifact, reuses what this one created, and commits.
        assert_eq!(run_child("reuse", dir.path()), 0);
        // This process's own commit fails and it rolls back: the other process's URI must survive.
        store.release(&ws, &created).unwrap();
        assert_eq!(store.read(&ws, &first[0].link.uri, None).unwrap().bytes, b"1");
    }

    #[test]
    fn another_process_cannot_evict_an_uncommitted_batch() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(2);
        let (first, created) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        assert_eq!(run_child("evict", dir.path()), 4, "the uncommitted batch must be held against the other process's eviction");
        assert_eq!(store.read(&ws, &first[0].link.uri, None).unwrap().bytes, b"1");
        store.commit(&ws, &created).unwrap();
        assert_eq!(run_child("evict", dir.path()), 0);
        assert_eq!(store.read(&ws, &first[0].link.uri, None).unwrap_err().code, "ARTIFACT_NOT_FOUND");
    }

    #[test]
    fn a_tampered_claim_file_forces_pins_to_be_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let store = small_store(2);
        let (_, created) = store.put_batch(&ws, &[write("a", b"1")], Some(&[])).unwrap();
        store.commit(&ws, &created).unwrap();
        let root = contained_path(&ws.artifact_root, &[]).unwrap();
        fs::write(root.join(CLAIMS_FILE), b"not json").unwrap();
        let state = ClaimState::load(&root, wall_clock_ms()).unwrap();
        assert!(state.claims.is_empty());
        assert!(state.epoch > 1_000_000, "the epoch jumps to the clock so every older list is refused");
    }
}

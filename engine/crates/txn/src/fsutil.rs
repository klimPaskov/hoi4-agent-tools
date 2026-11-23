//! File helpers of the rewrite engine: durable writes, file identity, hashing, ids and clock text.
//!
//! Ported from `src/hoi4_agent_tools/core/transactions.ts` (`durableWrite`, `fileExists`,
//! `fileIdentity`, `sameFileIdentity`) and `src/hoi4_agent_tools/core/canonical.ts` (`secureId`),
//! commit `9b7dc80d`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use hoi4_core::canonical::sha256_hex;
use hoi4_core::plan::Refusal;
use serde::{Deserialize, Serialize};

use crate::paths::io_refusal;

/// The device and file number of a regular file: which file a path names, not what it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileIdentity {
    pub device: String,
    pub inode: String,
}

/// The identity of the regular file at `path`, or `None` when nothing is there. A link, folder or
/// other non-regular entry is refused.
pub fn file_identity(path: &Path) -> Result<Option<FileIdentity>, Refusal> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_refusal("TRANSACTION_APPLY_FAILED", "File identity cannot be read", &error)),
    };
    if !metadata.is_file() {
        return Err(Refusal::new("TRANSACTION_SOURCE_TYPE_INVALID", "Transaction source or stage is not a regular file"));
    }
    platform_identity(path, &metadata).map(Some).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "File identity cannot be read", &error))
}

#[cfg(unix)]
fn platform_identity(_path: &Path, metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Ok(FileIdentity { device: metadata.dev().to_string(), inode: metadata.ino().to_string() })
}

#[cfg(windows)]
fn platform_identity(path: &Path, _metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    let handle = winapi_util::Handle::from_path_any(path)?;
    let information = winapi_util::file::information(&handle)?;
    Ok(FileIdentity { device: information.volume_serial_number().to_string(), inode: information.file_index().to_string() })
}

#[cfg(not(any(unix, windows)))]
fn platform_identity(_path: &Path, _metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "file identity is not supported on this platform"))
}

/// Whether anything (a file, folder or link) is at `path`.
pub fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// The bytes of the regular file at `path`, or `None` when nothing is there.
pub fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, Refusal> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(Refusal::new("TRANSACTION_SOURCE_TYPE_INVALID", "Transaction source or stage is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_refusal("TRANSACTION_APPLY_FAILED", "Source cannot be read", &error)),
    }
    fs::read(path).map(Some).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Source cannot be read", &error))
}

/// The SHA-256 of the regular file at `path`, or `None` when nothing is there.
pub fn hash_regular(path: &Path) -> Result<Option<String>, Refusal> {
    Ok(read_regular(path)?.map(|bytes| sha256_hex(&bytes)))
}

/// Writes `bytes` to a new same-folder temporary, flushes it to disk and renames it over `path`,
/// so the path holds either the old or the new bytes, never a mix.
pub fn durable_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(format!(".{}", random_id("tmp")));
    let temporary = path.with_file_name(name);
    let written = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

/// Flushes a folder's entries on systems that allow opening a folder; elsewhere a no-op.
pub fn sync_directory(path: &Path) {
    if cfg!(unix)
        && let Ok(directory) = File::open(path)
    {
        let _ = directory.sync_all();
    }
}

/// A unique id such as `txn_0123abcd-…`, in the TypeScript `secureId` shape (36 hex and dashes).
pub fn random_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or_default();
    let local = 0_u8;
    let seed = format!("{}:{nanos}:{}:{:p}:{:?}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed), &local, std::thread::current().id());
    let hash = sha256_hex(seed.as_bytes());
    format!("{prefix}_{}-{}-{}-{}-{}", &hash[0..8], &hash[8..12], &hash[12..16], &hash[16..20], &hash[20..32])
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or_default()
}

/// An ISO 8601 UTC time with milliseconds, as JavaScript `Date.toISOString` writes it.
pub fn iso_time(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rest = ms % 86_400_000;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1_000 % 60, rest % 1_000)
}

/// `path` with `suffix` appended to its file name.
pub fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times_like_javascript() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_795_000_000_123), "2026-11-18T11:06:40.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn makes_ids_in_the_secure_id_shape() {
        let first = random_id("txn");
        assert_eq!(first.len(), 40);
        assert!(first.starts_with("txn_"));
        assert!(first[4..].chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert_ne!(first, random_id("txn"));
    }
}

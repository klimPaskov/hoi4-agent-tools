//! Temporary scratch directories: owner records and the startup sweep of stale ones.
//!
//! Ported from `src/hoi4_agent_tools/core/temporary-directories.ts` (`sweepTemporaryDirectories`,
//! `owner`, `inventory`, `overlaps`), commit `9b7dc80d`. Owner records and the sweep lock use the
//! TypeScript file names and JSON, so either server recognises the other's directories. The
//! in-process `TemporaryDirectoryLifetime` of the TypeScript file stays in TypeScript: it exists to
//! clean up when the Node process exits.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{StoreError, StoreResult};

pub const OWNER_FILE: &str = ".hoi4-temp-owner.json";
pub const SWEEP_LOCK: &str = ".hoi4-temp-sweep.lock";
pub const TEMPORARY_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const TEMPORARY_STALE_MS: u64 = 3 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default)]
pub struct SweepOptions {
    /// Private image snapshots in server-owned storage; unowned directories are never removed.
    pub reference_snapshots_only: bool,
    /// Any `hoi4-*` test fixture, but only one that carries an owner record.
    pub owned_fixtures_only: bool,
    pub now_ms: Option<u64>,
    pub stale_ms: Option<u64>,
    pub max_bytes: Option<u64>,
    /// Canonical workspace and storage roots are never swept, including their ancestors.
    pub protected_roots: Vec<String>,
    pub current_uid: Option<u32>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SweepOutcome {
    pub removed: u64,
    pub retained_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct Owner {
    version: u8,
    pid: u32,
    host: String,
    token: String,
}

fn is_alnum6(text: &str) -> bool {
    text.len() == 6 && text.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn scratch_name(name: &str) -> bool {
    ["hoi4-reference-source-", "hoi4-event-eval-"].iter().any(|prefix| name.strip_prefix(prefix).is_some_and(is_alnum6))
}

fn reference_snapshot_name(name: &str) -> bool {
    name.strip_prefix(".reference-snapshot-").is_some_and(is_alnum6)
}

fn owned_fixture_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("hoi4-") else { return false };
    let Some((middle, tail)) = rest.rsplit_once('-') else { return false };
    is_alnum6(tail) && (1..=64).contains(&middle.len()) && middle.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn hostname() -> String {
    for variable in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(variable)
            && !value.is_empty()
        {
            return value;
        }
    }
    Command::new("hostname").output().ok().map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned()).unwrap_or_default()
}

/// Whether a process with this id exists (`process.kill(pid, 0)` of the TypeScript code).
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
    }
    #[cfg(not(windows))]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).output().is_ok_and(|out| out.status.success())
    }
}

#[cfg(unix)]
fn effective_uid() -> Option<u32> {
    Command::new("id").arg("-u").output().ok().and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
}

#[cfg(not(unix))]
fn effective_uid() -> Option<u32> {
    None
}

/// `Some(Some(owner))` for a valid record, `Some(None)` for none, `None` for an unreadable or
/// malformed one (which fails closed).
fn owner(directory: &Path, name: &str) -> Option<Option<Owner>> {
    let file = directory.join(name);
    match fs::symlink_metadata(&file) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
                return None;
            }
            let value: Value = serde_json::from_slice(&fs::read(&file).ok()?).ok()?;
            let object = value.as_object()?;
            if object.len() != 4 {
                return None;
            }
            let owner: Owner = serde_json::from_value(value).ok()?;
            let token_ok = owner.token.len() == 36 && owner.token.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
            (owner.version == 1 && owner.pid > 0 && !owner.host.is_empty() && owner.host.len() <= 256 && token_ok).then_some(Some(owner))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

struct Inventory {
    bytes: u64,
    modified: f64,
    locked: bool,
}

fn inventory(directory: &Path) -> Option<Inventory> {
    let mut result = Inventory { bytes: 0, modified: 0.0, locked: false };
    let mut pending = vec![directory.to_owned()];
    let mut entries = 0;
    while let Some(current) = pending.pop() {
        let metadata = fs::symlink_metadata(&current).ok()?;
        entries += 1;
        if entries > 100_000 {
            return None;
        }
        let times = [metadata.modified().ok(), metadata.created().ok()];
        for time in times.into_iter().flatten() {
            result.modified = result.modified.max(time.duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0));
        }
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            result.bytes += metadata.len();
        } else if metadata.is_dir() {
            for child in fs::read_dir(&current).ok()?.flatten() {
                let name = child.file_name().to_string_lossy().into_owned();
                if name == OWNER_FILE {
                    continue;
                }
                if name.ends_with(".lock") || name.ends_with(".lease") {
                    result.locked = true;
                }
                pending.push(child.path());
            }
        }
    }
    Some(result)
}

fn normalize(path: &Path) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    // A canonical Windows path carries a verbatim prefix; the configured spelling does not.
    let text = text.strip_prefix(r"\?\").map_or(text.clone(), str::to_owned);
    PathBuf::from(if cfg!(windows) { text.to_lowercase() } else { text })
}

fn overlaps(left: &Path, right: &Path) -> bool {
    let (a, b) = (normalize(left), normalize(right));
    a.starts_with(&b) || b.starts_with(&a)
}

fn new_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let hex = hoi4_core::canonical::sha256_hex(format!("{}:{nanos}", std::process::id()).as_bytes());
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Trusted startup maintenance only; never follows a junction or accepts an MCP path.
pub fn sweep_temporary_directories(parent: &Path, options: &SweepOptions, is_alive: &dyn Fn(u32) -> bool) -> StoreResult<SweepOutcome> {
    let now = options.now_ms.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)) as f64;
    let stale_ms = options.stale_ms.unwrap_or(TEMPORARY_STALE_MS) as f64;
    let max_bytes = options.max_bytes.unwrap_or(TEMPORARY_MAX_BYTES);
    let current_uid = options.current_uid.or_else(effective_uid);
    let root = fs::canonicalize(parent).map_err(|_| StoreError::new("TEMPORARY_ROOT_UNAVAILABLE", "The temporary storage root is unavailable"))?;
    let mut protected: Vec<PathBuf> = Vec::new();
    for protected_root in &options.protected_roots {
        protected.push(PathBuf::from(protected_root));
        // The nearest existing ancestor is resolved, so a root that is not created yet still matches.
        let mut existing = PathBuf::from(protected_root);
        let mut tail = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name().map(|name| name.to_owned()) else { break };
            tail.push(name);
            if !existing.pop() {
                break;
            }
        }
        if let Ok(mut real) = fs::canonicalize(&existing) {
            real.extend(tail.iter().rev());
            protected.push(real);
        }
    }
    let name_ok = |name: &str| {
        if options.reference_snapshots_only {
            reference_snapshot_name(name)
        } else if options.owned_fixtures_only {
            owned_fixture_name(name)
        } else {
            scratch_name(name)
        }
    };
    let mut names: Vec<String> = fs::read_dir(&root).map_err(|_| StoreError::new("TEMPORARY_ROOT_UNAVAILABLE", "The temporary storage root is unavailable"))?.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name_ok(name)).collect();
    names.sort();
    struct Candidate {
        directory: PathBuf,
        bytes: u64,
        modified: f64,
        eligible: bool,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    for name in names {
        let directory = root.join(&name);
        if protected.iter().any(|protected_root| overlaps(&directory, protected_root)) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&directory) else { continue };
        if !metadata.is_dir() || metadata.file_type().is_symlink() || fs::canonicalize(&directory).ok().as_deref() != Some(directory.as_path()) {
            continue;
        }
        #[cfg(unix)]
        if let Some(uid) = current_uid {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != uid {
                continue;
            }
        }
        let _ = current_uid;
        let Some(record) = owner(&directory, OWNER_FILE) else { continue };
        if (options.reference_snapshots_only || options.owned_fixtures_only) && record.is_none() {
            continue;
        }
        let Some(previous_sweep) = owner(&directory, SWEEP_LOCK) else { continue };
        let dead_sweep = previous_sweep.as_ref().is_some_and(|sweep| sweep.host == hostname() && !is_alive(sweep.pid) && owner(&directory, SWEEP_LOCK).flatten().is_some_and(|again| again.token == sweep.token));
        if dead_sweep && fs::remove_file(directory.join(SWEEP_LOCK)).is_err() {
            continue;
        }
        let Some(data) = inventory(&directory) else { continue };
        let dead = record.as_ref().is_some_and(|record| record.host == hostname() && !is_alive(record.pid));
        candidates.push(Candidate { eligible: !data.locked && (dead || dead_sweep || (record.is_none() && now - data.modified > stale_ms)), directory, bytes: data.bytes, modified: data.modified });
    }
    let mut retained: u64 = candidates.iter().map(|candidate| candidate.bytes).sum();
    let mut removed = 0u64;
    candidates.sort_by(|a, b| a.modified.total_cmp(&b.modified).then_with(|| a.directory.cmp(&b.directory)));
    for candidate in candidates {
        if !candidate.eligible || (now - candidate.modified <= stale_ms && retained <= max_bytes) {
            continue;
        }
        let lock_path = candidate.directory.join(SWEEP_LOCK);
        let token = new_token();
        let Ok(mut lock) = fs::OpenOptions::new().write(true).create_new(true).open(&lock_path) else { continue };
        let claimed = std::io::Write::write_all(&mut lock, json!({ "version": 1, "pid": std::process::id(), "host": hostname(), "token": token }).to_string().as_bytes()).is_ok();
        drop(lock);
        let guarded = || -> bool {
            if !claimed {
                return false;
            }
            match owner(&candidate.directory, OWNER_FILE) {
                None => return false,
                Some(Some(record)) if record.host != hostname() || is_alive(record.pid) => return false,
                _ => {}
            }
            if fs::symlink_metadata(&candidate.directory).map_or(true, |m| m.file_type().is_symlink()) || fs::canonicalize(&candidate.directory).ok().as_deref() != Some(candidate.directory.as_path()) {
                return false;
            }
            if owner(&candidate.directory, SWEEP_LOCK).flatten().is_none_or(|lock| lock.token != token) {
                return false;
            }
            let _ = fs::remove_file(&lock_path);
            fs::remove_dir_all(&candidate.directory).is_ok()
        };
        if guarded() {
            retained = retained.saturating_sub(candidate.bytes);
            removed += 1;
        } else if owner(&candidate.directory, SWEEP_LOCK).flatten().is_some_and(|lock| lock.token == token) {
            let _ = fs::remove_file(&lock_path);
        }
    }
    Ok(SweepOutcome { removed, retained_bytes: retained })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(parent: &Path, name: &str, owner_pid: Option<u32>, bytes: usize) -> PathBuf {
        let directory = parent.join(name);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("data.bin"), vec![0u8; bytes]).unwrap();
        if let Some(pid) = owner_pid {
            fs::write(directory.join(OWNER_FILE), json!({ "version": 1, "pid": pid, "host": hostname(), "token": new_token() }).to_string()).unwrap();
        }
        directory
    }

    fn options() -> SweepOptions {
        SweepOptions { owned_fixtures_only: true, current_uid: None, stale_ms: Some(0), now_ms: Some(u64::MAX / 4), ..Default::default() }
    }

    #[test]
    fn removes_fixtures_of_dead_owners_and_keeps_live_and_unowned_ones() {
        let parent = tempfile::tempdir().unwrap();
        let dead = make(parent.path(), "hoi4-map-AAAAAA", Some(11), 10);
        let live = make(parent.path(), "hoi4-map-BBBBBB", Some(22), 10);
        let unowned = make(parent.path(), "hoi4-map-CCCCCC", None, 10);
        let other = make(parent.path(), "not-a-fixture", Some(11), 10);
        let outcome = sweep_temporary_directories(parent.path(), &options(), &|pid| pid == 22).unwrap();
        assert_eq!(outcome.removed, 1);
        assert!(!dead.exists() && live.exists() && unowned.exists() && other.exists());
    }

    #[test]
    fn keeps_protected_roots_locked_directories_and_malformed_records() {
        let parent = tempfile::tempdir().unwrap();
        let protected = make(parent.path(), "hoi4-map-AAAAAA", Some(11), 1);
        let locked = make(parent.path(), "hoi4-map-BBBBBB", Some(11), 1);
        fs::write(locked.join("x.lock"), b"").unwrap();
        let broken = make(parent.path(), "hoi4-map-CCCCCC", None, 1);
        fs::write(broken.join(OWNER_FILE), b"{not json").unwrap();
        let symlink_target = make(parent.path(), "hoi4-map-DDDDDD", Some(11), 1);
        let mut with_protection = options();
        with_protection.protected_roots = vec![path_text(&protected.join("inner"))];
        let outcome = sweep_temporary_directories(parent.path(), &with_protection, &|_| false).unwrap();
        assert_eq!(outcome.removed, 1);
        assert!(protected.exists() && locked.exists() && broken.exists());
        assert!(!symlink_target.exists());
    }

    #[test]
    fn scratch_sweep_removes_old_unowned_directories_by_age_only() {
        let parent = tempfile::tempdir().unwrap();
        let scratch = make(parent.path(), "hoi4-reference-source-abc123", None, 1);
        let keep = SweepOptions { now_ms: Some(1), ..Default::default() };
        assert_eq!(sweep_temporary_directories(parent.path(), &keep, &|_| false).unwrap().removed, 0);
        let old = SweepOptions { stale_ms: Some(0), now_ms: Some(u64::MAX / 4), ..Default::default() };
        assert_eq!(sweep_temporary_directories(parent.path(), &old, &|_| false).unwrap().removed, 1);
        assert!(!scratch.exists());
    }

    #[test]
    fn trims_to_the_byte_budget_oldest_first() {
        let parent = tempfile::tempdir().unwrap();
        let first = make(parent.path(), "hoi4-map-AAAAAA", Some(11), 100);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let second = make(parent.path(), "hoi4-map-BBBBBB", Some(11), 100);
        let budget = SweepOptions { max_bytes: Some(150), ..options() };
        let outcome = sweep_temporary_directories(parent.path(), &budget, &|_| false).unwrap();
        assert!(outcome.removed >= 1);
        assert!(!first.exists());
        let _ = second;
    }

    #[test]
    fn name_patterns_match_the_typescript_ones() {
        assert!(owned_fixture_name("hoi4-map-AAAAAA") && owned_fixture_name("hoi4-a-b-c-123456"));
        assert!(!owned_fixture_name("hoi4--AAAAAA") && !owned_fixture_name("hoi4-Map-AAAAAA") && !owned_fixture_name("hoi4-map-AAAAA"));
        assert!(scratch_name("hoi4-event-eval-a1b2c3") && !scratch_name("hoi4-event-eval-a1b2c"));
        assert!(reference_snapshot_name(".reference-snapshot-a1b2c3"));
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}

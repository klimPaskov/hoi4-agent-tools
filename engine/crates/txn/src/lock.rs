//! The workspace write lock, shared with the TypeScript transaction manager.
//!
//! Ported from `src/hoi4_agent_tools/core/transactions.ts` (`withWorkspaceLock`,
//! `withWorkspaceLockWaiting`, `clearCrashedProcessLock`, `retireStaleLock`), commit `9b7dc80d`.
//! The lock is the same folder, `<cache>/locks/write.lock` with an `owner.json`, so a rewrite of
//! the engine and one of the TypeScript server exclude each other in one workspace.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use hoi4_core::canonical::canonical_json;
use hoi4_core::plan::Refusal;
use serde_json::{Value, json};

use crate::fsutil::{durable_write, iso_time, now_ms, random_id};
use crate::paths::{contained_generated_path, io_refusal};

/// An ownerless lock younger than this may be a holder between `mkdir` and writing its owner.
const OWNER_GRACE_MS: u64 = 30_000;
const RETRY_INTERVAL: Duration = Duration::from_millis(100);

struct ProcessIdentity {
    host: String,
    instance_id: String,
    started_at: String,
}

fn process_identity() -> &'static ProcessIdentity {
    static IDENTITY: OnceLock<ProcessIdentity> = OnceLock::new();
    IDENTITY.get_or_init(|| ProcessIdentity { host: host_name().to_lowercase(), instance_id: random_id("instance"), started_at: iso_time(now_ms()) })
}

fn host_name() -> String {
    let from_env = |name: &str| std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
    if cfg!(windows) {
        return from_env("COMPUTERNAME").unwrap_or_default();
    }
    if let Ok(text) = fs::read_to_string("/proc/sys/kernel/hostname")
        && !text.trim().is_empty()
    {
        return text.trim().to_owned();
    }
    if let Ok(output) = Command::new("hostname").output()
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !text.is_empty() {
            return text;
        }
    }
    from_env("HOSTNAME").unwrap_or_default()
}

/// Whether the process is alive: `Some(false)` only when the system says it does not exist.
fn process_alive(pid: u64) -> Option<bool> {
    if pid == u64::from(std::process::id()) {
        return Some(true);
    }
    if cfg!(windows) {
        let output = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Some(text.lines().any(|line| line.split(',').nth(1).is_some_and(|field| field.trim_matches('"') == pid.to_string())))
    } else {
        let output = Command::new("kill").args(["-0", &pid.to_string()]).output().ok()?;
        if output.status.success() {
            return Some(true);
        }
        let error = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if error.contains("no such process") { Some(false) } else { None }
    }
}

/// A held workspace lock; dropping it releases the lock when this holder still owns it.
pub struct WorkspaceLock {
    directory: PathBuf,
    transaction_id: String,
}

impl WorkspaceLock {
    /// Takes the lock, waiting up to `wait` while another live writer holds it.
    pub fn acquire(cache_root: &Path, transaction_id: &str, wait: Duration) -> Result<Self, Refusal> {
        let deadline = Instant::now() + wait;
        loop {
            match Self::try_acquire(cache_root, transaction_id) {
                Err(refusal) if refusal.code == "TRANSACTION_LOCKED" && Instant::now() < deadline => std::thread::sleep(RETRY_INTERVAL),
                other => return other,
            }
        }
    }

    fn try_acquire(cache_root: &Path, transaction_id: &str) -> Result<Self, Refusal> {
        let locks = contained_generated_path(cache_root, &["locks"])?;
        fs::create_dir_all(&locks).map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Lock storage cannot be created", &error))?;
        let locks = contained_generated_path(cache_root, &["locks"])?;
        let directory = contained_generated_path(&locks, &["write.lock"])?;
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !clear_crashed_process_lock(&directory) {
                    return Err(Refusal::new("TRANSACTION_LOCKED", "Another write transaction owns the workspace lock"));
                }
                match fs::create_dir(&directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        return Err(Refusal::new("TRANSACTION_LOCKED", "Another write transaction acquired the workspace lock during recovery"));
                    }
                    Err(error) => return Err(io_refusal("TRANSACTION_APPLY_FAILED", "Workspace lock cannot be taken", &error)),
                }
            }
            Err(error) => return Err(io_refusal("TRANSACTION_APPLY_FAILED", "Workspace lock cannot be taken", &error)),
        }
        let lock = Self { directory, transaction_id: transaction_id.to_owned() };
        let identity = process_identity();
        let owner = json!({
            "transactionId": transaction_id,
            "pid": std::process::id(),
            "host": identity.host,
            "instanceId": identity.instance_id,
            "processStartedAt": identity.started_at,
        });
        let owner_path = contained_generated_path(&lock.directory, &["owner.json"])?;
        durable_write(&owner_path, format!("{}\n", canonical_json(&owner)).as_bytes())
            .map_err(|error| io_refusal("TRANSACTION_APPLY_FAILED", "Workspace lock owner cannot be written", &error))?;
        Ok(lock)
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        // Release only this holder's lock; never one another process holds after a takeover.
        let owner = read_owner(&self.directory);
        let identity = process_identity();
        let ours = match &owner {
            Some(owner) => owner["instanceId"] == identity.instance_id.as_str() && owner["transactionId"] == self.transaction_id.as_str(),
            None => true,
        };
        if ours {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

fn read_owner(directory: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(directory.join("owner.json")).ok()?).ok()
}

/// Clears a lock whose owner provably crashed: a dead process on this host, or no owner long
/// after the lock was made. Anything else stays locked.
pub(crate) fn clear_crashed_process_lock(directory: &Path) -> bool {
    clear_crashed_process_lock_after(directory, OWNER_GRACE_MS)
}

fn clear_crashed_process_lock_after(directory: &Path, grace_ms: u64) -> bool {
    let owner_path = directory.join("owner.json");
    let bytes = match fs::read(&owner_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // mkdir is the exclusive primitive, so a holder is ownerless for a moment; only an
            // ownerless lock older than the grace period is evidence of a crash in that window.
            let Ok(modified) = fs::metadata(directory).and_then(|metadata| metadata.modified()) else { return false };
            let age = modified.elapsed().map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0);
            if age < grace_ms {
                return false;
            }
            return retire_stale_lock(directory, None);
        }
        // Corrupt or unreadable owner evidence is never cleared automatically.
        Err(_) => return false,
    };
    let Ok(owner) = serde_json::from_slice::<Value>(&bytes) else { return false };
    let Some(pid) = owner["pid"].as_u64().filter(|pid| *pid > 0 && *pid <= 9_007_199_254_740_991) else { return false };
    let (Some(host), Some(_), Some(_)) = (owner["host"].as_str(), owner["instanceId"].as_str(), owner["processStartedAt"].as_str()) else {
        return false;
    };
    // A PID has meaning only on the host that wrote it.
    if host.to_lowercase() != process_identity().host {
        return false;
    }
    if process_alive(pid) != Some(false) {
        return false;
    }
    retire_stale_lock(directory, Some(canonical_json(&owner)))
}

/// Moves a lock judged stale aside under a unique name; only one process wins the rename. When
/// the moved lock no longer carries the judged owner, a new holder took it, and it goes back.
fn retire_stale_lock(directory: &Path, judged_owner: Option<String>) -> bool {
    let mut name = directory.file_name().unwrap_or_default().to_owned();
    name.push(format!(".stale-{}", random_id("lock")));
    let tombstone = directory.with_file_name(name);
    if fs::rename(directory, &tombstone).is_err() {
        return false;
    }
    let moved_owner = read_owner(&tombstone).map(|owner| canonical_json(&owner));
    if moved_owner != judged_owner {
        let _ = fs::rename(&tombstone, directory);
        return false;
    }
    let _ = fs::remove_dir_all(&tombstone);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let directory = std::env::temp_dir().join(random_id("hoi4-txn-lock"));
        fs::create_dir_all(&directory).unwrap();
        fs::canonicalize(directory).unwrap()
    }

    fn plant_owner(cache: &Path, owner: Value) -> PathBuf {
        let lock = cache.join("locks").join("write.lock");
        fs::create_dir_all(&lock).unwrap();
        fs::write(lock.join("owner.json"), canonical_json(&owner)).unwrap();
        lock
    }

    /// A PID far above any the systems hand out, so it names no live process.
    const DEAD_PID: u64 = 4_194_301;

    #[test]
    fn excludes_a_second_holder_and_releases_on_drop() {
        let cache = scratch();
        let first = WorkspaceLock::acquire(&cache, "txn_a", Duration::ZERO).unwrap();
        let refused = WorkspaceLock::acquire(&cache, "txn_b", Duration::from_millis(250)).err().unwrap();
        assert_eq!(refused.code, "TRANSACTION_LOCKED");
        drop(first);
        assert!(!cache.join("locks/write.lock").exists());
        drop(WorkspaceLock::acquire(&cache, "txn_b", Duration::ZERO).unwrap());
        let _ = fs::remove_dir_all(cache);
    }

    /// Ported from "clears a crashed-process lock and recovers a configured workspace after restart".
    #[test]
    fn clears_a_crashed_process_lock() {
        let cache = scratch();
        plant_owner(
            &cache,
            json!({ "transactionId": "txn_x", "pid": DEAD_PID, "host": process_identity().host, "instanceId": "instance_old", "processStartedAt": "2026-01-01T00:00:00.000Z" }),
        );
        drop(WorkspaceLock::acquire(&cache, "txn_new", Duration::ZERO).unwrap());
        let _ = fs::remove_dir_all(cache);
    }

    /// Ported from "does not clear a lock owned by a live process during recovery".
    #[test]
    fn keeps_a_lock_owned_by_a_live_process() {
        let cache = scratch();
        let child = Command::new(if cfg!(windows) { "cmd" } else { "sleep" }).args(if cfg!(windows) { vec!["/C", "ping -n 6 127.0.0.1 >NUL"] } else { vec!["5"] }).spawn();
        let mut child = child.unwrap();
        plant_owner(
            &cache,
            json!({ "transactionId": "txn_x", "pid": child.id(), "host": process_identity().host, "instanceId": "instance_live", "processStartedAt": "2026-01-01T00:00:00.000Z" }),
        );
        assert_eq!(WorkspaceLock::acquire(&cache, "txn_new", Duration::ZERO).err().unwrap().code, "TRANSACTION_LOCKED");
        assert!(cache.join("locks/write.lock/owner.json").exists());
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(cache);
    }

    /// Ported from "does not clear a lock whose owner belongs to another host".
    #[test]
    fn keeps_a_lock_of_another_host() {
        let cache = scratch();
        plant_owner(
            &cache,
            json!({ "transactionId": "txn_x", "pid": DEAD_PID, "host": "another-host.invalid", "instanceId": "instance_old", "processStartedAt": "2026-01-01T00:00:00.000Z" }),
        );
        assert_eq!(WorkspaceLock::acquire(&cache, "txn_new", Duration::ZERO).err().unwrap().code, "TRANSACTION_LOCKED");
        let _ = fs::remove_dir_all(cache);
    }

    #[test]
    fn keeps_a_lock_with_corrupt_owner_evidence() {
        let cache = scratch();
        let lock = cache.join("locks").join("write.lock");
        fs::create_dir_all(&lock).unwrap();
        fs::write(lock.join("owner.json"), "{not json").unwrap();
        assert_eq!(WorkspaceLock::acquire(&cache, "txn_new", Duration::ZERO).err().unwrap().code, "TRANSACTION_LOCKED");
        let _ = fs::remove_dir_all(cache);
    }

    /// Ported from "clears an aged ownerless acquisition lock but not a fresh one".
    #[test]
    fn clears_an_aged_ownerless_lock_but_not_a_fresh_one() {
        let cache = scratch();
        let lock = cache.join("locks").join("write.lock");
        fs::create_dir_all(&lock).unwrap();
        assert_eq!(WorkspaceLock::acquire(&cache, "txn_new", Duration::ZERO).err().unwrap().code, "TRANSACTION_LOCKED");
        // The same lock once it is older than the grace period.
        assert!(clear_crashed_process_lock_after(&lock, 0));
        assert!(!lock.exists());
        drop(WorkspaceLock::acquire(&cache, "txn_new", Duration::ZERO).unwrap());
        let _ = fs::remove_dir_all(cache);
    }
}

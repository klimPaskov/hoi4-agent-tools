//! Tests of the rewrite engine on real temporary folders.
//!
//! Ported from `tests/unit/transactions.test.ts`, `tests/unit/transaction-batches.test.ts`,
//! `tests/unit/transaction-size.test.ts` and `tests/unit/transaction-root-change.test.ts`, commit
//! `9b7dc80d`; each test names the TypeScript case it carries. Every negative test also runs
//! against an applier that drops the rule it checks (`TxnApplier::dropping`) and asserts that the
//! refusal is then gone, so no test passes without its rule.

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use hoi4_core::canonical::sha256_hex;
use hoi4_core::diagnostics::{Category, Diagnostic, Severity};
use hoi4_core::ops::{OpContext, Registry};
use hoi4_core::plan::{FileChange, PlanApplier, Refusal, RewritePlan};
use serde_json::json;

use crate::applier::{Hooks, Rule, TxnApplier};
use crate::fsutil::random_id;
use crate::journal::{Binding, HeadMode, JOURNAL_FOLDER, Journal, State};
use crate::paths::Workspace;
use crate::state::ServerState;

const KEY: &str = "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e";
const OTHER_KEY: &str = "0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de";

struct Fixture {
    root: PathBuf,
    mod_root: PathBuf,
    cache: PathBuf,
    state: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(random_id("hoi4-txn-test"));
    let mod_root = root.join("mods").join("demo");
    fs::create_dir_all(&mod_root).unwrap();
    let root = crate::paths::canonical_path(&root).unwrap();
    let mod_root = crate::paths::canonical_path(&mod_root).unwrap();
    let cache = mod_root.join(".hoi4-agent").join("cache");
    let state = root.join("state");
    fs::create_dir_all(&state).unwrap();
    Fixture { root, mod_root, cache, state }
}

impl Fixture {
    fn binding(&self) -> Binding {
        Binding { workspace_id: "demo".into(), workspace_identity: sha256_hex(b"demo identity"), root_fingerprint: sha256_hex(b"demo roots"), principal: None }
    }

    fn server_state(&self, key: &str) -> ServerState {
        ServerState::open(&self.state, key).unwrap()
    }

    fn applier_with(&self, mod_root: &Path, cache: &Path, binding: Binding, key: &str) -> TxnApplier {
        TxnApplier::new(Workspace::open(mod_root, cache, None).unwrap(), binding, self.server_state(key))
    }

    fn applier(&self) -> TxnApplier {
        self.applier_with(&self.mod_root, &self.cache, self.binding(), KEY)
    }

    /// Runs `inspect` with this fixture's journal storage.
    fn with_journal<T>(&self, inspect: impl FnOnce(&Journal<'_>) -> T) -> T {
        let state = self.server_state(KEY);
        let binding = self.binding();
        let journal = Journal::open(&self.cache, &state, &binding).unwrap();
        inspect(&journal)
    }

    fn journal_state(&self, id: &str) -> State {
        self.with_journal(|journal| journal.load(id, HeadMode::Verify, true).unwrap().state)
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.mod_root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn read(&self, relative: &str) -> Option<Vec<u8>> {
        fs::read(self.mod_root.join(relative)).ok()
    }

    /// Every file under the mod root except generated storage, with its bytes.
    fn snapshot(&self) -> Vec<(String, Vec<u8>)> {
        fn walk(base: &Path, directory: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let relative = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                if relative.starts_with(".hoi4-agent") {
                    continue;
                }
                if entry.file_type().unwrap().is_dir() {
                    walk(base, &path, out);
                } else {
                    out.push((relative, fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.mod_root, &self.mod_root, &mut out);
        out.sort();
        out
    }

    fn journals(&self) -> Vec<String> {
        match fs::read_dir(self.cache.join(JOURNAL_FOLDER)) {
            Ok(listing) => listing.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn only_journal(&self) -> String {
        let journals = self.journals();
        assert_eq!(journals.len(), 1, "{journals:?}");
        journals[0].clone()
    }
}

fn change(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> FileChange {
    FileChange { path: path.into(), before_sha256: before.map(sha256_hex), after: after.map(<[u8]>::to_vec) }
}

fn plan(changes: Vec<FileChange>) -> RewritePlan {
    RewritePlan { workspace_id: "demo".into(), operation_kind: "test".into(), changes, diagnostics: Vec::new() }
}

fn link_directory(link: &Path, target: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).output().unwrap();
        assert!(status.status.success(), "mklink /J failed");
    }
}

type PathHook = Box<dyn Fn(&str) -> Result<(), Refusal> + Send + Sync>;
type IndexHook = Box<dyn Fn(&str, usize) -> Result<(), Refusal> + Send + Sync>;
type PlainHook = Box<dyn Fn() -> Result<(), Refusal> + Send + Sync>;
type BatchHook = Box<dyn Fn(&[String]) -> Result<(), Refusal> + Send + Sync>;

/// A hook that runs one action at a chosen point.
#[derive(Default)]
struct At {
    after_stage: Option<PathHook>,
    after_replace: Option<IndexHook>,
    before_post_validation: Option<PlainHook>,
    after_batch_intent: Option<BatchHook>,
}

impl Hooks for At {
    fn after_stage(&self, relative_path: &str) -> Result<(), Refusal> {
        self.after_stage.as_ref().map_or(Ok(()), |hook| hook(relative_path))
    }
    fn after_replace(&self, relative_path: &str, index: usize) -> Result<(), Refusal> {
        self.after_replace.as_ref().map_or(Ok(()), |hook| hook(relative_path, index))
    }
    fn before_post_validation(&self) -> Result<(), Refusal> {
        self.before_post_validation.as_ref().map_or(Ok(()), |hook| hook())
    }
    fn after_batch_intent(&self, relative_paths: &[String]) -> Result<(), Refusal> {
        self.after_batch_intent.as_ref().map_or(Ok(()), |hook| hook(relative_paths))
    }
}

/// Applies a plan whose rewrite "crashes" (panics) after replacing the file at `index`, leaving
/// its journal as a killed process would.
fn crash_after_replace(fixture: &Fixture, plan: &RewritePlan, index: usize) {
    let hooks = At {
        after_replace: Some(Box::new(move |_, at| {
            if at == index {
                panic!("simulated crash after replacing file {at}");
            }
            Ok(())
        })),
        ..At::default()
    };
    let applier = fixture.applier().with_hooks(Arc::new(hooks));
    let outcome = catch_unwind(AssertUnwindSafe(|| applier.apply(plan)));
    assert!(outcome.is_err(), "the rewrite should have crashed");
}

fn three_file_plan(fixture: &Fixture) -> (RewritePlan, Vec<(String, Vec<u8>)>) {
    fixture.write("common/a.txt", b"a = 1\r\n");
    fixture.write("common/b.txt", b"\xEF\xBB\xBFb = 1\n");
    let before = fixture.snapshot();
    let plan = plan(vec![
        change("common/a.txt", Some(b"a = 1\r\n"), Some(b"a = 2\r\n")),
        change("common/b.txt", Some(b"\xEF\xBB\xBFb = 1\n"), None),
        change("common/new/c.txt", None, Some(b"c = 3\n")),
    ]);
    (plan, before)
}

// --- Writes -------------------------------------------------------------------------------

/// "dry-runs, requires hash-bound apply, and writes text and binary atomically".
#[test]
fn writes_text_and_binary_bytes_exactly_and_leaves_no_journal() {
    let fixture = fixture();
    fixture.write("common/a.txt", b"old\r\n");
    let utf16 = [0xFF_u8, 0xFE, b'x', 0, b'\r', 0, b'\n', 0];
    let binary: Vec<u8> = (0..=255).collect();
    let applied = fixture
        .applier()
        .apply(&plan(vec![
            change("common/a.txt", Some(b"old\r\n"), Some(b"\xEF\xBB\xBFnew\r\nline\r\n")),
            change("gfx/b.dds", None, Some(&binary)),
            change("localisation/c_l_english.yml", None, Some(&utf16)),
        ]))
        .unwrap();
    assert_eq!(applied.changed_paths, ["common/a.txt", "gfx/b.dds", "localisation/c_l_english.yml"]);
    assert_eq!(fixture.read("common/a.txt").unwrap(), b"\xEF\xBB\xBFnew\r\nline\r\n");
    assert_eq!(fixture.read("gfx/b.dds").unwrap(), binary);
    assert_eq!(fixture.read("localisation/c_l_english.yml").unwrap(), utf16);
    assert_eq!(fixture.snapshot().len(), 3, "no stage or backup files remain");
    assert!(fixture.journals().is_empty(), "the finished journal is reclaimed");
    assert!(!fixture.cache.join("locks/write.lock").exists(), "the lock is released");
}

#[test]
fn deletes_files_and_skips_changes_that_change_nothing() {
    let fixture = fixture();
    fixture.write("a.txt", b"same");
    fixture.write("b.txt", b"gone");
    let applied = fixture.applier().apply(&plan(vec![change("a.txt", Some(b"same"), Some(b"same")), change("b.txt", Some(b"gone"), None)])).unwrap();
    assert_eq!(applied.changed_paths, ["b.txt"]);
    assert!(fixture.read("b.txt").is_none());
    let unchanged = fixture.applier().apply(&plan(vec![change("a.txt", Some(b"same"), Some(b"same"))])).unwrap();
    assert!(unchanged.changed_paths.is_empty());
    assert!(fixture.journals().is_empty());
}

#[test]
fn refuses_blocking_diagnostics_and_another_workspace() {
    let fixture = fixture();
    let mut blocked = plan(vec![change("a.txt", None, Some(b"x"))]);
    blocked.diagnostics.push(Diagnostic::new("X", Severity::Error, Category::Validation, "bad"));
    let refusal = fixture.applier().apply(&blocked).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_VALIDATION_BLOCKED");
    assert_eq!(refusal.diagnostics.len(), 1);
    let mut other = plan(vec![change("a.txt", None, Some(b"x"))]);
    other.workspace_id = "other".into();
    assert_eq!(fixture.applier().apply(&other).unwrap_err().code, "TRANSACTION_WORKSPACE_MISMATCH");
    assert!(fixture.snapshot().is_empty());
}

// --- Stale sources ------------------------------------------------------------------------

/// "rejects stale source after planning".
#[test]
fn refuses_a_stale_source_and_changes_nothing() {
    let fixture = fixture();
    fixture.write("a.txt", b"edited by the modder");
    let stale = plan(vec![change("new.txt", None, Some(b"n")), change("a.txt", Some(b"read by the writer"), Some(b"x"))]);
    let refusal = fixture.applier().apply(&stale).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_STALE");
    assert_eq!(fixture.snapshot(), [("a.txt".to_string(), b"edited by the modder".to_vec())]);
    // Creating a file that exists already is stale too.
    assert_eq!(fixture.applier().apply(&plan(vec![change("a.txt", None, Some(b"x"))])).unwrap_err().code, "TRANSACTION_STALE");
    // Without the rule the modder's edit is overwritten.
    fixture.applier().dropping(Rule::StaleSource).apply(&stale).unwrap();
    assert_eq!(fixture.read("a.txt").unwrap(), b"x");
}

/// "rechecks source immediately before replacement after staging work".
#[test]
fn rechecks_each_source_right_before_its_replacement() {
    for drop_rule in [false, true] {
        let fixture = fixture();
        fixture.write("a.txt", b"a");
        fixture.write("b.txt", b"b");
        let target = fixture.mod_root.join("b.txt");
        let hooks = At {
            after_stage: Some(Box::new(move |path| {
                if path == "b.txt" {
                    fs::write(&target, b"edited while staging").unwrap();
                }
                Ok(())
            })),
            ..At::default()
        };
        let mut applier = fixture.applier().with_hooks(Arc::new(hooks));
        if drop_rule {
            applier = applier.dropping(Rule::ReplaceRecheck).dropping(Rule::RollbackGuard);
        }
        let outcome = applier.apply(&plan(vec![change("a.txt", Some(b"a"), Some(b"A")), change("b.txt", Some(b"b"), Some(b"B"))]));
        if drop_rule {
            outcome.unwrap();
            assert_eq!(fixture.read("b.txt").unwrap(), b"B", "the edit is lost without the recheck");
        } else {
            assert_eq!(outcome.unwrap_err().code, "TRANSACTION_STALE");
            assert_eq!(fixture.snapshot(), [("a.txt".to_string(), b"a".to_vec()), ("b.txt".to_string(), b"edited while staging".to_vec())]);
            assert_eq!(fixture.journal_state(&fixture.only_journal()), State::RolledBack);
        }
    }
}

/// "applies a plan once when two applies of it race".
#[test]
fn applies_a_plan_once_when_two_applies_race() {
    let fixture = fixture();
    fixture.write("a.txt", b"1");
    let racing = plan(vec![change("a.txt", Some(b"1"), Some(b"2"))]);
    let applier = Arc::new(fixture.applier().with_lock_wait(Duration::from_secs(20)));
    let outcomes: Vec<Result<_, Refusal>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let applier = Arc::clone(&applier);
                let racing = racing.clone();
                scope.spawn(move || applier.apply(&racing))
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().find_map(|outcome| outcome.as_ref().err()).unwrap().code, "TRANSACTION_STALE");
    assert_eq!(fixture.read("a.txt").unwrap(), b"2");
}

#[test]
fn refuses_while_another_writer_holds_the_lock() {
    let fixture = fixture();
    fs::create_dir_all(fixture.cache.join("locks")).unwrap();
    let _held = crate::lock::WorkspaceLock::acquire(&fixture.cache, &random_id("txn"), Duration::ZERO).unwrap();
    let refusal = fixture.applier().apply(&plan(vec![change("a.txt", None, Some(b"x"))])).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_LOCKED");
    assert!(fixture.read("a.txt").is_none());
}

// --- Paths --------------------------------------------------------------------------------

/// "rejects distinct relative paths that resolve to one transaction target".
#[test]
fn refuses_duplicates_and_aliases_of_one_file() {
    let fixture = fixture();
    let duplicate = plan(vec![change("a.txt", None, Some(b"1")), change("a.txt", None, Some(b"2"))]);
    assert_eq!(fixture.applier().apply(&duplicate).unwrap_err().code, "TRANSACTION_DUPLICATE_FILE");
    let alias = plan(vec![change("common/a.txt", None, Some(b"1")), change("common\\a.txt", None, Some(b"2"))]);
    let refusal = fixture.applier().apply(&alias).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_DUPLICATE_FILE");
    assert!(refusal.message.contains("aliases"));
    if cfg!(windows) {
        let cased = plan(vec![change("Common/A.txt", None, Some(b"1")), change("common/a.txt", None, Some(b"2"))]);
        assert_eq!(fixture.applier().apply(&cased).unwrap_err().code, "TRANSACTION_DUPLICATE_FILE");
    }
    assert!(fixture.snapshot().is_empty());
    // Without the rule nothing refuses the plan as a duplicate.
    for plan in [&duplicate, &alias] {
        let outcome = fixture.applier().dropping(Rule::Duplicate).apply(plan);
        assert_ne!(outcome.err().map(|refusal| refusal.code), Some("TRANSACTION_DUPLICATE_FILE".to_string()));
    }
}

/// "joins pending path checks before refusing a plan and never writes across workspace boundaries"
/// and the path rules of `assertRelative`.
#[test]
fn refuses_unsafe_relative_paths_before_writing_anything() {
    let fixture = fixture();
    for (path, code) in [
        ("../other/a.txt", "PATH_TRAVERSAL"),
        ("/abs.txt", "PATH_ABSOLUTE_REJECTED"),
        ("a.txt:stream", "PATH_ALTERNATE_STREAM"),
        ("nul.txt", "PATH_WINDOWS_DEVICE"),
        ("", "PATH_EMPTY"),
    ] {
        let refusal = fixture.applier().apply(&plan(vec![change("fine.txt", None, Some(b"x")), change(path, None, Some(b"x"))])).unwrap_err();
        assert_eq!(refusal.code, code, "{path:?}");
    }
    assert!(fixture.snapshot().is_empty());
    assert!(!fixture.root.join("mods/other").exists());
}

/// "rejects a transaction cache descendant that escapes through a symlink or junction" (sources).
#[test]
fn refuses_a_write_through_a_link_that_leaves_the_mod() {
    let fixture = fixture();
    let outside = fixture.root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    link_directory(&fixture.mod_root.join("common"), &outside);
    let escaping = plan(vec![change("common/evil.txt", None, Some(b"x"))]);
    assert_eq!(fixture.applier().apply(&escaping).unwrap_err().code, "PATH_WRITE_OUTSIDE_ROOTS");
    assert!(!outside.join("evil.txt").exists());
    // Without the containment rule the write lands outside the mod.
    fixture.applier().dropping(Rule::PathContainment).apply(&escaping).unwrap();
    assert!(outside.join("evil.txt").exists());
}

/// "rejects transaction targets inside generated server storage".
#[test]
fn refuses_targets_in_generated_storage() {
    let fixture = fixture();
    let refusal = fixture.applier().apply(&plan(vec![change(".hoi4-agent/cache/x.txt", None, Some(b"x"))])).unwrap_err();
    assert_eq!(refusal.code, "PATH_GENERATED_STORAGE_RESERVED");
    let refusal = fixture.applier().apply(&plan(vec![change(".HOI4-AGENT/x.txt", None, Some(b"x"))])).unwrap_err();
    assert_eq!(refusal.code, "PATH_GENERATED_STORAGE_RESERVED");
    // A cache configured elsewhere inside the mod is reserved as well.
    let applier = fixture.applier_with(&fixture.mod_root, &fixture.mod_root.join("state"), fixture.binding(), KEY);
    assert_eq!(applier.apply(&plan(vec![change("state/locks/x", None, Some(b"x"))])).unwrap_err().code, "PATH_GENERATED_STORAGE_RESERVED");
}

/// "rejects a transaction cache descendant that escapes through a symlink or junction" (journal).
#[test]
fn refuses_a_journal_that_leaves_the_cache() {
    let fixture = fixture();
    fs::create_dir_all(&fixture.cache).unwrap();
    let outside = fixture.root.join("journal-outside");
    fs::create_dir_all(&outside).unwrap();
    link_directory(&fixture.cache.join(JOURNAL_FOLDER), &outside);
    let rewrite = plan(vec![change("a.txt", None, Some(b"x"))]);
    // Recovery reads the journal first, under the lock, and refuses the escape.
    let refusal = fixture.applier().apply(&rewrite).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_RECOVERY_REQUIRED");
    assert!(refusal.message.contains("escapes its configured root"), "{}", refusal.message);
    assert_eq!(fixture.applier().recover().unwrap_err().code, "PATH_GENERATED_ROOT_ESCAPE");
    assert!(fixture.read("a.txt").is_none());
    fixture.applier().dropping(Rule::JournalContainment).apply(&rewrite).unwrap();
    assert!(fixture.read("a.txt").is_some());
}

#[test]
fn refuses_a_linked_journal_folder() {
    let fixture = fixture();
    let journals = fixture.cache.join(JOURNAL_FOLDER);
    fs::create_dir_all(&journals).unwrap();
    let elsewhere = fixture.cache.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    link_directory(&journals.join(random_id("txn")), &elsewhere);
    assert_eq!(fixture.applier().apply(&plan(vec![change("a.txt", None, Some(b"x"))])).unwrap_err().code, "TRANSACTION_RECOVERY_REQUIRED");
    assert_eq!(fixture.applier().recover().unwrap_err().code, "TRANSACTION_JOURNAL_UNSAFE");
}

// --- Failure and rollback -----------------------------------------------------------------

/// "restores all files when apply fails between replacements" and "restores existing files and
/// removes new files after a large rewrite fails partway through".
#[test]
fn restores_every_file_when_a_replacement_fails() {
    let fixture = fixture();
    let (rewrite, before) = three_file_plan(&fixture);
    let hooks =
        At { after_replace: Some(Box::new(|_, index| if index == 1 { Err(Refusal::new("TEST_FAILURE", "injected")) } else { Ok(()) })), ..At::default() };
    let refusal = fixture.applier().with_hooks(Arc::new(hooks)).apply(&rewrite).unwrap_err();
    assert_eq!(refusal.code, "TEST_FAILURE");
    assert_eq!(fixture.snapshot(), before, "every file is back, and no stage or backup remains");
    assert_eq!(fixture.journal_state(&fixture.only_journal()), State::RolledBack);
}

/// "rolls back replaced files when another planned file was edited during apply" and "never
/// overwrites an unknown concurrent edit during automatic rollback".
#[test]
fn never_overwrites_an_unknown_edit_during_rollback() {
    for drop_rule in [false, true] {
        let fixture = fixture();
        let (rewrite, _) = three_file_plan(&fixture);
        let target = fixture.mod_root.join("common/a.txt");
        let hooks = At {
            before_post_validation: Some(Box::new(move || {
                fs::write(&target, b"modder edit during the rewrite").unwrap();
                Ok(())
            })),
            ..At::default()
        };
        let mut applier = fixture.applier().with_hooks(Arc::new(hooks));
        if drop_rule {
            applier = applier.dropping(Rule::RollbackGuard);
        }
        let refusal = applier.apply(&rewrite).unwrap_err();
        if drop_rule {
            assert_eq!(refusal.code, "TRANSACTION_WRITE_MISMATCH");
            assert_eq!(fixture.read("common/a.txt").unwrap(), b"a = 1\r\n", "without the guard the edit is destroyed");
        } else {
            assert_eq!(refusal.code, "TRANSACTION_ROLLBACK_STALE");
            assert_eq!(fixture.read("common/a.txt").unwrap(), b"modder edit during the rewrite");
            assert_eq!(fixture.journal_state(&fixture.only_journal()), State::Failed, "the failed journal stays as evidence");
        }
    }
}

#[test]
fn verifies_the_written_bytes() {
    for drop_rule in [false, true] {
        let fixture = fixture();
        fixture.write("a.txt", b"1");
        let target = fixture.mod_root.join("a.txt");
        let hooks = At {
            before_post_validation: Some(Box::new(move || {
                // The old bytes are back, as a failing disk or another writer leaves them.
                fs::write(&target, b"1").unwrap();
                Ok(())
            })),
            ..At::default()
        };
        let mut applier = fixture.applier().with_hooks(Arc::new(hooks));
        if drop_rule {
            applier = applier.dropping(Rule::WriteVerification);
        }
        let outcome = applier.apply(&plan(vec![change("a.txt", Some(b"1"), Some(b"2"))]));
        if drop_rule {
            assert!(outcome.is_ok(), "without verification a write that did not land is reported as written");
        } else {
            assert_eq!(outcome.unwrap_err().code, "TRANSACTION_WRITE_MISMATCH");
        }
        assert_eq!(fixture.read("a.txt").unwrap(), b"1");
    }
}

// --- Recovery -----------------------------------------------------------------------------

/// "recovers an interrupted applying journal to the exact before state".
#[test]
fn recovers_an_interrupted_rewrite_to_the_exact_before_state() {
    let fixture = fixture();
    let (rewrite, before) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 1);
    assert_ne!(fixture.snapshot(), before, "the crash left a half-written mod");
    let id = fixture.only_journal();
    assert_eq!(fixture.journal_state(&id), State::Applying);
    // Without recovery the half-written state stays.
    assert_eq!(fixture.applier().dropping(Rule::Recovery).recover().unwrap(), 0);
    assert_ne!(fixture.snapshot(), before);
    assert_eq!(fixture.applier().recover().unwrap(), 1);
    assert_eq!(fixture.snapshot(), before);
    assert_eq!(fixture.journal_state(&id), State::RolledBack);
    assert_eq!(fixture.applier().recover().unwrap(), 0, "a recovered journal is not replayed");
}

/// Recovery runs before the next rewrite of the workspace, under its lock.
#[test]
fn recovers_before_the_next_rewrite() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 0);
    fixture.applier().apply(&rewrite).unwrap();
    assert_eq!(fixture.read("common/a.txt").unwrap(), b"a = 2\r\n");
    assert!(fixture.read("common/b.txt").is_none());
    assert_eq!(fixture.read("common/new/c.txt").unwrap(), b"c = 3\n");
}

/// "resumes a rolling-back blob restore after the target was unlinked".
#[test]
fn resumes_a_rollback_from_the_journaled_before_bytes() {
    let fixture = fixture();
    let (rewrite, before) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 2);
    let id = fixture.only_journal();
    fixture.with_journal(|journal| {
        let mut manifest = journal.load(&id, HeadMode::Verify, true).unwrap();
        manifest.state = State::RollingBack;
        journal.write_manifest(&mut manifest).unwrap();
    });
    // The old rollback stopped after removing the target and its backup.
    fs::remove_file(fixture.mod_root.join("common/a.txt")).unwrap();
    for entry in fs::read_dir(fixture.mod_root.join("common")).unwrap() {
        let path = entry.unwrap().path();
        if path.to_string_lossy().ends_with(".backup") && path.to_string_lossy().contains("a.txt") {
            fs::remove_file(path).unwrap();
        }
    }
    assert_eq!(fixture.applier().recover().unwrap(), 1);
    assert_eq!(fixture.snapshot(), before);
}

/// "requires an intact before blob when recovering a missing rollback target".
#[test]
fn requires_intact_before_bytes_to_recover_a_missing_target() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 2);
    let id = fixture.only_journal();
    fixture.with_journal(|journal| {
        let mut manifest = journal.load(&id, HeadMode::Verify, true).unwrap();
        manifest.state = State::RollingBack;
        journal.write_manifest(&mut manifest).unwrap();
    });
    fs::remove_file(fixture.mod_root.join("common/a.txt")).unwrap();
    for entry in fs::read_dir(fixture.mod_root.join("common")).unwrap() {
        let path = entry.unwrap().path();
        if path.to_string_lossy().ends_with(".backup") && path.to_string_lossy().contains("a.txt") {
            fs::remove_file(path).unwrap();
        }
    }
    let blob = fixture.cache.join(JOURNAL_FOLDER).join(&id).join("blobs").join(sha256_hex(b"a = 1\r\n"));
    fs::write(&blob, b"a = 9\r\n").unwrap();
    assert_eq!(fixture.applier().recover().unwrap_err().code, "TRANSACTION_BLOB_INTEGRITY_FAILED");
    assert!(fixture.read("common/a.txt").is_none(), "no unverified bytes are restored");
    assert_eq!(fixture.journal_state(&id), State::Failed);
}

/// "fails recovery closed when source no longer matches before or after bytes".
#[test]
fn fails_recovery_closed_over_an_unknown_edit() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 1);
    fixture.write("common/a.txt", b"edited after the crash");
    assert_eq!(fixture.applier().recover().unwrap_err().code, "TRANSACTION_ROLLBACK_STALE");
    assert_eq!(fixture.read("common/a.txt").unwrap(), b"edited after the crash");
}

/// "rejects unauthenticated tampering before restart recovery" and "does not recover from a
/// journal whose hash-bound plan was changed".
#[test]
fn refuses_a_tampered_or_truncated_journal_and_writes_nothing() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 1);
    let crashed = fixture.snapshot();
    let path = fixture.cache.join(JOURNAL_FOLDER).join(fixture.only_journal()).join("manifest.json");
    let text = fs::read_to_string(&path).unwrap();
    let tampered = text.replacen("\"common/a.txt\"", "\"common/z.txt\"", 1);
    assert_ne!(text, tampered);
    fs::write(&path, &tampered).unwrap();
    assert_eq!(fixture.applier().recover().unwrap_err().code, "TRANSACTION_MANIFEST_AUTHENTICATION_FAILED");
    let refusal = fixture.applier().apply(&plan(vec![change("other.txt", None, Some(b"x"))])).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_RECOVERY_REQUIRED");
    assert!(refusal.message.contains("authentication"));
    fs::write(&path, &text[..text.len() / 2]).unwrap();
    assert_eq!(fixture.applier().recover().unwrap_err().code, "TRANSACTION_MANIFEST_INVALID");
    assert_eq!(fixture.snapshot(), crashed, "no refused journal changed a file");
    fs::write(&path, &text).unwrap();
    assert_eq!(fixture.applier().recover().unwrap(), 1);
}

/// "persists a private journal key": a journal is refused under another server key.
#[test]
fn refuses_a_journal_under_another_key() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 1);
    let crashed = fixture.snapshot();
    let other = fixture.applier_with(&fixture.mod_root, &fixture.cache, fixture.binding(), OTHER_KEY);
    assert_eq!(other.recover().unwrap_err().code, "TRANSACTION_MANIFEST_AUTHENTICATION_FAILED");
    assert_eq!(fixture.snapshot(), crashed);
}

/// "rejects a forged plan and matching public integrity hashes": a journal sealed with another
/// key that would restore an attacker's bytes. Without authentication the bytes are written.
#[test]
fn refuses_a_forged_journal_that_would_restore_other_bytes() {
    for drop_rule in [false, true] {
        let fixture = fixture();
        let (rewrite, _) = three_file_plan(&fixture);
        crash_after_replace(&fixture, &rewrite, 1);
        let id = fixture.only_journal();
        let evil = b"evil = yes\n";
        let directory = fixture.cache.join(JOURNAL_FOLDER).join(&id);
        fs::write(directory.join("blobs").join(sha256_hex(evil)), evil).unwrap();
        for entry in fs::read_dir(fixture.mod_root.join("common")).unwrap() {
            let path = entry.unwrap().path();
            if path.to_string_lossy().ends_with(".backup") && path.to_string_lossy().contains("a.txt") {
                fs::remove_file(path).unwrap();
            }
        }
        let mut manifest = fixture.with_journal(|journal| journal.load(&id, HeadMode::Verify, true).unwrap());
        for file in manifest.files.iter_mut().chain(manifest.plan_payload.files.iter_mut()).filter(|file| file.relative_path == "common/a.txt") {
            file.before_sha256 = Some(sha256_hex(evil));
            file.before_size = Some(evil.len() as u64);
            file.before_blob = Some(format!("blobs/{}", sha256_hex(evil)));
        }
        manifest.plan_hash = hoi4_core::canonical::hash_canonical(&serde_json::to_value(&manifest.plan_payload).unwrap());
        let attacker = ServerState::open(&fixture.state, OTHER_KEY).unwrap();
        let binding = fixture.binding();
        let forged = Journal::open(&fixture.cache, &attacker, &binding).unwrap().seal(&mut manifest).unwrap();
        fs::write(directory.join("manifest.json"), format!("{forged}\n")).unwrap();
        let mut applier = fixture.applier();
        if drop_rule {
            applier = applier.dropping(Rule::JournalAuthentication);
        }
        let outcome = applier.recover();
        if drop_rule {
            outcome.unwrap();
            assert_eq!(fixture.read("common/a.txt").unwrap(), evil, "without authentication the forged bytes are written");
        } else {
            assert_eq!(outcome.unwrap_err().code, "TRANSACTION_MANIFEST_AUTHENTICATION_FAILED");
            assert_eq!(fixture.read("common/a.txt").unwrap(), b"a = 2\r\n");
        }
    }
}

/// "rejects replay of an authenticated planned revision after automatic recovery".
#[test]
fn refuses_to_replay_an_older_authenticated_revision() {
    let fixture = fixture();
    let (rewrite, before) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 1);
    let path = fixture.cache.join(JOURNAL_FOLDER).join(fixture.only_journal()).join("manifest.json");
    let interrupted = fs::read(&path).unwrap();
    assert_eq!(fixture.applier().recover().unwrap(), 1);
    assert_eq!(fixture.snapshot(), before);
    fs::write(&path, interrupted).unwrap();
    assert_eq!(fixture.applier().recover().unwrap_err().code, "TRANSACTION_MANIFEST_REPLAY");
    assert_eq!(fixture.snapshot(), before);
}

/// "still refuses to replay an interrupted journal against changed roots".
#[test]
fn refuses_to_replay_an_interrupted_journal_against_another_root() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 1);
    let mut binding = fixture.binding();
    binding.root_fingerprint = sha256_hex(b"other roots");
    let applier = fixture.applier_with(&fixture.mod_root, &fixture.cache, binding, KEY);
    assert_eq!(applier.recover().unwrap_err().code, "TRANSACTION_ROOT_CHANGED");
}

/// "skips a journal folder whose plan never committed a manifest" and "finishes a rename-first
/// autonomous reclaim after restart".
#[test]
fn skips_uncommitted_journals_and_finishes_reclaims() {
    let fixture = fixture();
    let journals = fixture.cache.join(JOURNAL_FOLDER);
    let uncommitted = journals.join(random_id("txn"));
    fs::create_dir_all(uncommitted.join("blobs")).unwrap();
    let reclaiming = journals.join(format!(".reclaiming-{}", random_id("txn")));
    fs::create_dir_all(&reclaiming).unwrap();
    assert_eq!(fixture.applier().recover().unwrap(), 0);
    assert!(uncommitted.exists(), "a young uncommitted folder is left for its writer");
    assert!(!reclaiming.exists());
    fixture.applier().apply(&plan(vec![change("a.txt", None, Some(b"x"))])).unwrap();
}

// --- Batches ------------------------------------------------------------------------------

/// "keeps a matching external creation on an untouched pending path".
#[test]
fn keeps_an_untouched_pending_path_as_it_is() {
    let fixture = fixture();
    let rewrite = plan(vec![change("a.txt", None, Some(b"a")), change("b.txt", None, Some(b"b"))]);
    let hooks = At { after_batch_intent: Some(Box::new(|_| panic!("simulated crash after the batch intent"))), ..At::default() };
    let applier = fixture.applier().with_hooks(Arc::new(hooks));
    assert!(catch_unwind(AssertUnwindSafe(|| applier.apply(&rewrite))).is_err());
    // The modder creates b.txt with the very bytes the rewrite meant to write.
    fixture.write("b.txt", b"b");
    assert_eq!(fixture.applier().recover().unwrap(), 1);
    assert_eq!(fixture.snapshot(), [("b.txt".to_string(), b"b".to_vec())]);
}

/// "writes more than a thousand files while retaining stale-source protection and bounded
/// manifests" and "applies more than 5,000 files in one transaction and rolls all of them back on
/// failure" (with 1,100 files, several batches).
#[test]
fn writes_and_rolls_back_more_than_a_thousand_files() {
    let fixture = fixture();
    let count = 1_100;
    for index in 0..count {
        fixture.write(&format!("history/states/{index}.txt"), format!("state = {index}\n").as_bytes());
    }
    let before = fixture.snapshot();
    let changes: Vec<FileChange> = (0..count)
        .map(|index| {
            let path = format!("history/states/{index}.txt");
            let old = format!("state = {index}\n");
            FileChange { path, before_sha256: Some(sha256_hex(old.as_bytes())), after: Some(format!("state = {}\n", index + 1).into_bytes()) }
        })
        .collect();
    let hooks = At {
        after_replace: Some(Box::new(move |_, index| if index == count - 1 { Err(Refusal::new("TEST_FAILURE", "last file")) } else { Ok(()) })),
        ..At::default()
    };
    assert_eq!(fixture.applier().with_hooks(Arc::new(hooks)).apply(&plan(changes.clone())).unwrap_err().code, "TEST_FAILURE");
    assert_eq!(fixture.snapshot(), before);
    let applied = fixture.applier().apply(&plan(changes)).unwrap();
    assert_eq!(applied.changed_paths.len(), count);
    assert_eq!(fixture.read("history/states/1099.txt").unwrap(), b"state = 1100\n");
}

// --- Limits -------------------------------------------------------------------------------

/// "names the exceeded limit and the remedy" and "rejects transaction collections beyond compact
/// review limits".
#[test]
fn refuses_plans_beyond_the_structure_limits() {
    let fixture = fixture();
    let many: Vec<FileChange> = (0..=crate::limits::MAX_FILES).map(|index| change(&format!("f/{index}.txt"), None, Some(b"x"))).collect();
    let refusal = fixture.applier().apply(&plan(many)).unwrap_err();
    assert_eq!(refusal.code, "TRANSACTION_STRUCTURE_LIMIT");
    assert!(refusal.message.contains("15001 files (limit 15000)"));
    assert!(refusal.message.contains("split the change"));
    let mut noisy = plan(vec![change("a.txt", None, Some(b"x"))]);
    noisy.diagnostics =
        (0..=crate::limits::MAX_DIAGNOSTICS).map(|index| Diagnostic::new(format!("I{index}"), Severity::Info, Category::Validation, "note")).collect();
    assert_eq!(fixture.applier().apply(&noisy).unwrap_err().code, "TRANSACTION_STRUCTURE_LIMIT");
    assert!(fixture.snapshot().is_empty());
    fixture.applier().dropping(Rule::Limits).apply(&noisy).unwrap();
    assert!(fixture.read("a.txt").is_some());
}

/// "enforces journal count and byte budgets before persisting a plan".
#[test]
fn refuses_plans_beyond_the_journal_budget() {
    let fixture = fixture();
    fixture.write("a.txt", b"twenty bytes of text");
    let rewrite = plan(vec![change("a.txt", Some(b"twenty bytes of text"), Some(b"x"))]);
    let small = || fixture.applier().with_journal_budget(10, 128);
    assert_eq!(small().apply(&rewrite).unwrap_err().code, "TRANSACTION_JOURNAL_LIMIT");
    let none = fixture.applier().with_journal_budget(1 << 20, 0);
    assert_eq!(none.apply(&rewrite).unwrap_err().code, "TRANSACTION_JOURNAL_LIMIT");
    assert_eq!(fixture.read("a.txt").unwrap(), b"twenty bytes of text");
    assert!(fixture.journals().is_empty());
    small().dropping(Rule::Limits).apply(&rewrite).unwrap();
    assert_eq!(fixture.read("a.txt").unwrap(), b"x");
}

// --- Operations ---------------------------------------------------------------------------

#[test]
fn applies_and_recovers_through_the_engine_operations() {
    let fixture = fixture();
    fixture.write("a.txt", b"old");
    let mut registry = Registry::new();
    crate::register(&mut registry);
    assert_eq!(registry.names(), ["txn.apply", "txn.recover"]);
    let binding = fixture.binding();
    let workspace = json!({
        "workspaceId": "demo",
        "workspaceIdentity": binding.workspace_identity,
        "rootFingerprint": binding.root_fingerprint,
        "modRoot": fixture.mod_root,
        "cacheRoot": fixture.cache,
        "serverStateRoot": fixture.state,
        "journalKey": KEY,
    });
    let with = |extra: serde_json::Value| {
        let mut request = workspace.clone();
        request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        request
    };
    let roots = with(json!({
        "op": "txn.apply",
        "operationKind": "test",
        "changes": [
            { "path": "a.txt", "beforeSha256": sha256_hex(b"old"), "afterSize": 3 },
            { "path": "b/c.txt", "beforeSha256": null, "afterSize": 2 },
        ],
    }));
    let answer = registry.dispatch("txn.apply", &OpContext::default(), &roots, b"newhi").unwrap();
    assert_eq!(answer.result.unwrap(), json!({ "changedPaths": ["a.txt", "b/c.txt"] }));
    assert_eq!(fixture.read("a.txt").unwrap(), b"new");
    assert_eq!(fixture.read("b/c.txt").unwrap(), b"hi");
    let stale = registry.dispatch("txn.apply", &OpContext::default(), &roots, b"newhi").unwrap();
    let error = stale.result.unwrap_err();
    assert_eq!(error["code"], "TRANSACTION_STALE");
    assert!(error["message"].as_str().unwrap().contains("a.txt"));
    let short = registry.dispatch("txn.apply", &OpContext::default(), &roots, b"new").unwrap();
    assert_eq!(short.result.unwrap_err()["code"], "invalid_request");
    let long = registry.dispatch("txn.apply", &OpContext::default(), &roots, b"newhi!").unwrap();
    assert_eq!(long.result.unwrap_err()["code"], "invalid_request");
    let recover = registry.dispatch("txn.recover", &OpContext::default(), &with(json!({})), &[]).unwrap();
    assert_eq!(recover.result.unwrap(), json!({ "recovered": 0 }));
    let missing = registry.dispatch("txn.recover", &OpContext::default(), &with(json!({ "modRoot": fixture.root.join("nope") })), &[]).unwrap();
    assert_eq!(missing.result.unwrap_err()["code"], "WORKSPACE_MOD_ROOT_UNSAFE");
    // A missing or short key is refused, and no refusal echoes the key.
    for key in [json!(null), json!("abcd"), json!(&KEY[..62])] {
        let mut request = with(json!({}));
        request["journalKey"] = key;
        let refused = registry.dispatch("txn.recover", &OpContext::default(), &request, &[]).unwrap().result.unwrap_err();
        assert!(!refused.to_string().contains(&KEY[..16]));
        assert!(refused["code"] == "SERVER_STATE_KEY_INVALID" || refused["code"] == "invalid_request");
    }
}

// --- A refused rollback -------------------------------------------------------------------
//
// Ported from `tests/unit/transaction-refused-rollback.test.ts`, commit `d9b0268b`.

/// Every rollback backup below `common/`, by file name, in order.
fn backups(fixture: &Fixture) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(fixture.mod_root.join("common"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".backup"))
        .collect();
    found.sort();
    found
}

/// Applies three edits while another writer appends to `common/two.txt` before post-write
/// validation, which then fails. Rollback must refuse: the appended bytes are not this rewrite's.
fn refused_rollback(fixture: &Fixture, ttl_seconds: Option<u64>) -> (Refusal, String) {
    for name in ["one", "two", "three"] {
        fixture.write(&format!("common/{name}.txt"), format!("{name} = before\n").as_bytes());
    }
    let rewrite = plan(
        ["one", "two", "three"]
            .iter()
            .map(|name| change(&format!("common/{name}.txt"), Some(format!("{name} = before\n").as_bytes()), Some(format!("{name} = after\n").as_bytes())))
            .collect(),
    );
    let target = fixture.mod_root.join("common/two.txt");
    let hooks = At {
        before_post_validation: Some(Box::new(move || {
            fs::write(&target, b"two = after\nlane = appended\n").unwrap();
            Ok(())
        })),
        ..At::default()
    };
    let mut applier = fixture.applier().with_hooks(Arc::new(hooks));
    if let Some(seconds) = ttl_seconds {
        applier = applier.with_ttl_seconds(seconds);
    }
    let refusal = applier.apply(&rewrite).unwrap_err();
    (refusal, fixture.only_journal())
}

/// "removes the backups of files still at their after-bytes and names the rest".
#[test]
fn a_refused_rollback_removes_settled_backups_and_names_the_rest() {
    let fixture = fixture();
    let (refusal, id) = refused_rollback(&fixture, None);
    assert_eq!(refusal.code, "TRANSACTION_ROLLBACK_STALE");
    let retained: Vec<_> = refusal.diagnostics.iter().filter(|diagnostic| diagnostic.code == crate::RETAINED_BACKUPS_CODE).collect();
    assert_eq!(retained.len(), 1, "{:?}", refusal.diagnostics);
    let details = retained[0].details.as_ref().unwrap();
    assert_eq!(details["retainedBackupCount"], json!(1));
    assert_eq!(details["retainedBackups"], json!(["common/two.txt"]));
    // The applied files keep their result and lose their backups; the other writer's bytes stay.
    assert_eq!(fixture.read("common/one.txt").unwrap(), b"one = after\n");
    assert_eq!(fixture.read("common/three.txt").unwrap(), b"three = after\n");
    assert_eq!(fixture.read("common/two.txt").unwrap(), b"two = after\nlane = appended\n");
    assert_eq!(backups(&fixture), vec![format!("two.txt.hoi4-agent-{id}.backup")]);
    assert_eq!(fixture.journal_state(&id), State::Failed);
}

/// A backup whose bytes are not the recorded before bytes is never removed as settled.
#[test]
fn a_refused_rollback_keeps_a_backup_that_does_not_hold_the_before_bytes() {
    let fixture = fixture();
    for name in ["one", "two"] {
        fixture.write(&format!("common/{name}.txt"), format!("{name} = before\n").as_bytes());
    }
    let rewrite = plan(
        ["one", "two"]
            .iter()
            .map(|name| change(&format!("common/{name}.txt"), Some(format!("{name} = before\n").as_bytes()), Some(format!("{name} = after\n").as_bytes())))
            .collect(),
    );
    let common = fixture.mod_root.join("common");
    let two = common.join("two.txt");
    let hooks = At {
        before_post_validation: Some(Box::new(move || {
            fs::write(&two, b"two = edited\n").unwrap();
            for entry in fs::read_dir(&common).unwrap() {
                let path = entry.unwrap().path();
                if path.to_string_lossy().contains("one.txt.hoi4-agent-") && path.to_string_lossy().ends_with(".backup") {
                    fs::write(path, b"one = tampered\n").unwrap();
                }
            }
            Ok(())
        })),
        ..At::default()
    };
    let refusal = fixture.applier().with_hooks(Arc::new(hooks)).apply(&rewrite).unwrap_err();
    // The tampered backup fails integrity validation first, before any file changes.
    assert_eq!(refusal.code, "TRANSACTION_BLOB_INTEGRITY_FAILED");
    let details = refusal.diagnostics.iter().find(|diagnostic| diagnostic.code == crate::RETAINED_BACKUPS_CODE).unwrap().details.clone().unwrap();
    assert_eq!(details["retainedBackups"], json!(["common/one.txt", "common/two.txt"]));
    assert_eq!(backups(&fixture).len(), 2);
}

/// "lets its owner discard the failed journal and its remaining backups".
#[test]
fn the_owner_discards_a_failed_journal_and_its_remaining_backups() {
    let fixture = fixture();
    let (_, id) = refused_rollback(&fixture, None);
    let mut other = fixture.binding();
    other.principal = Some("someone-else".into());
    let stranger = fixture.applier_with(&fixture.mod_root, &fixture.cache, other, KEY);
    assert!(stranger.discard_failed(&id).is_err(), "another principal cannot discard it");
    assert_eq!(backups(&fixture).len(), 1);
    let discarded = fixture.applier().discard_failed(&id).unwrap();
    assert_eq!(discarded, crate::DiscardedJournal { removed_backups: 1, retained_backups: Vec::new() });
    assert!(backups(&fixture).is_empty());
    assert!(fixture.journals().is_empty(), "the journal is gone");
    assert_eq!(fixture.read("common/two.txt").unwrap(), b"two = after\nlane = appended\n");
}

/// "refuses to discard a journal that did not fail".
#[test]
fn refuses_to_discard_a_journal_that_did_not_fail() {
    let fixture = fixture();
    let (rewrite, _) = three_file_plan(&fixture);
    crash_after_replace(&fixture, &rewrite, 0);
    let id = fixture.only_journal();
    assert_eq!(fixture.journal_state(&id), State::Applying);
    assert_eq!(fixture.applier().discard_failed(&id).unwrap_err().code, "TRANSACTION_STATE_INVALID");
    assert_eq!(fixture.applier().recover().unwrap(), 1);
    assert_eq!(fixture.journal_state(&id), State::RolledBack);
    assert_eq!(fixture.applier().discard_failed(&id).unwrap_err().code, "TRANSACTION_STATE_INVALID");
}

/// "reclaims / keeps an expired failed journal when the workspace is at / not at its after-state".
#[test]
fn reclaims_an_expired_failed_journal_only_at_its_after_state() {
    for (two_bytes, reclaimed) in [(&b"two = after\n"[..], true), (&b"two = after\nlane = appended\n"[..], false)] {
        let fixture = fixture();
        let (_, id) = refused_rollback(&fixture, Some(0));
        fixture.write("common/two.txt", two_bytes);
        std::thread::sleep(Duration::from_millis(5));
        // The next rewrite prunes expired journals.
        fixture.applier().apply(&plan(vec![change("common/one.txt", Some(b"one = after\n"), Some(b"one = later\n"))])).unwrap();
        if reclaimed {
            assert!(fixture.journals().is_empty(), "{:?}", fixture.journals());
            assert!(backups(&fixture).is_empty());
        } else {
            assert_eq!(fixture.journals(), vec![id.clone()]);
            assert_eq!(fixture.journal_state(&id), State::Failed);
            assert_eq!(backups(&fixture).len(), 1);
        }
    }
}

# ADR 0048: Temporary fixture ownership and disk limits

## Cause

The reported `hoi4-reference-source-XXXXXX` directories are created by the reference image tests in the concurrent world-generation checkout, not by the 4.0.0 MCP. Each test calls `mkdtemp` without removing its fixture directory. The oversized-input test used a 1 GiB `FileHandle.truncate`; this can allocate real disk space on Windows. Repeated runs accumulated those files. A later change unlinks that file in `finally`, but still leaves the fixture directory. The separately authored, dated `hoi4-event-eval-2026-10-11` directory contains evaluation sources and retained evidence and is currently used by another job.

The shipped MCP has neither of those allocation sites. Its source readers do not extract a mod into temporary directories. Parsed source documents and index segments already use the shared, bounded, content-addressed persistent analysis cache under tool storage. Adding another source-copy cache would introduce disk use and stale-source risks without addressing this leak. Mutable test workspaces must remain isolated rather than share a cached source revision.

## Decision

Vitest fixture allocation records a private process/host/token owner marker. Fixtures created during a test are removed after that test, including failed tests; fixtures created by suite hooks remain until suite teardown. A synchronous exit hook is the fallback for normal or explicit process exit. The fixture guard rejects a truncate that would exceed the 256 MiB aggregate budget before allocating disk blocks. Oversized-input tests must inject a small limit rather than create gigabyte files.

Core startup maintenance sweeps only the exact random-six-character `hoi4-reference-source-*` and `hoi4-event-eval-*` scratch names. Configured workspace and storage roots, and their ancestors, are protected. Unmarked legacy scratch must be older than three hours, including its most recent descendant modification. Marked scratch must have a dead local process owner. Dead owners are evicted oldest first when retained scratch exceeds 256 MiB; an active owner is never evicted to meet a cap. Unknown, malformed, foreign-host or locked owners are retained. Dated evaluation evidence is excluded.

Canonical path checks reject scratch junctions, symlinks are not followed during inventory, and an exclusive sweep lock coordinates cleanup. Sharing violations fail closed for retry at the next startup. A hard kill cannot execute an exit hook; its dead-owner marker is recovered by the next sweep. No tool schema or workspace grant changes are introduced.

## Validation

Synthetic regression tests cover normal and explicit process exit, partial failure, stale legacy directories, fresh directories, dead-owner size eviction, live/foreign/malformed owners, locks, junctions, changed ownership, and rejecting a large truncate without growing the file. Existing source readers continue using the persistent analysis cache and configured source roots.

## Amendment (2026-10-24)

A hard kill of a test run (a stopped job, a usage limit, a crashed worker) leaves its marked fixtures behind, and the start-up sweep matched only the two product scratch names, so they were never collected: 2,441 fixtures (640 MB) had accumulated on one machine. The test setup now runs a second sweep, `ownedFixturesOnly`, over `hoi4-*` fixture names that removes only directories whose owner record names a dead local process, with the same staleness, size, lock and protected-root rules. Unmarked directories stay untouched.

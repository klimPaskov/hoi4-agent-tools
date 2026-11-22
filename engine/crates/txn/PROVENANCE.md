# Provenance: hoi4-txn

Sources this crate adapts, one row per adapted file. All sources are from this repository at commit `9b7dc80d`.

| Rust file | Adapted from | Commit |
| --------- | ------------ | ------ |
| `src/lib.rs` | `src/hoi4_agent_tools/core/transactions.ts` (module overview) | `9b7dc80d` |
| `src/limits.rs` | `src/hoi4_agent_tools/core/transaction-limits.ts` (all constants, `transactionBatchSize`); `maxJournals` and `ttlSeconds` of `TransactionManager` | `9b7dc80d` |
| `src/paths.rs` | `src/hoi4_agent_tools/core/workspace.ts` (`assertRelative`, `isPortablePathSegment`, `canonicalPath`, `isWithin`, `pathsOverlap`, `containedGeneratedPath`, the write branch of `WorkspaceResolver.resolvePath`) | `9b7dc80d` |
| `src/fsutil.rs` | `src/hoi4_agent_tools/core/transactions.ts` (`durableWrite`, `fileExists`, `fileIdentity`, `sameFileIdentity`); `src/hoi4_agent_tools/core/canonical.ts` (`secureId`) | `9b7dc80d` |
| `src/lock.rs` | `src/hoi4_agent_tools/core/transactions.ts` (`withWorkspaceLock`, `withWorkspaceLockWaiting`, `clearCrashedProcessLock`, `retireStaleLock`) | `9b7dc80d` |
| `src/journal.rs` | `src/hoi4_agent_tools/core/transactions.ts` (`TransactionManifest`, `TransactionFileChange`, `TransactionPendingFile`, `writeManifest`, `load`, `verifyManifestText`, `readVerifiedBlob`, `journalUsage`, `transactionDirectory`, the rename-first reclaim of `reclaimAutonomousAppliedJournal`) | `9b7dc80d` |
| `src/applier.rs` | `src/hoi4_agent_tools/core/transactions.ts` (`TransactionManager.plan`, `apply`, `recover`, `recoverTransaction`, `restoreInterruptedTransaction`, `restoreBeforeState`, `verifyCurrentFiles`, `safeFailure`, `TransactionHooks`) | `9b7dc80d` |
| `src/ops.rs` | new: the `txn.apply` and `txn.recover` engine operations (ADR 0091) | — |
| `src/tests.rs` | `tests/unit/transactions.test.ts`, `tests/unit/transaction-batches.test.ts`, `tests/unit/transaction-size.test.ts`, `tests/unit/transaction-root-change.test.ts` (the cases each test names) | `9b7dc80d` |

## Differences from the TypeScript engine

- **One call.** The TypeScript manager plans (journal, diff artifacts, dry-run validation) and applies in two calls bound by a plan hash and a principal. The engine checks, journals, replaces and verifies in one call under the workspace lock, so there is no plan hash, expiry, principal binding or status call to port. Dry-run and post-write validation stay with the caller: a plan with blocking diagnostics is refused, and the written bytes are verified against their hashes.
- **Journal location and binding.** Engine journals live in `<cache>/engine-transactions/`, apart from the TypeScript journals in `<cache>/transactions/`, so neither engine tries to load the other's manifests. A manifest is bound by a SHA-256 integrity hash over its canonical JSON. The engine holds no server key, so it does not carry the TypeScript HMAC authentication tag or the protected journal heads in server state. Recovery still re-resolves every path through the containment rules and restores only bytes it verifies against the journaled hashes.
- **The lock is shared.** `<cache>/locks/write.lock` with the same `owner.json` fields, so the engine and the TypeScript server exclude each other in one workspace. A live process is judged with `tasklist` on Windows and `kill -0` elsewhere; an unknown answer keeps the lock.
- **After blobs.** The new bytes are staged straight from the plan and checked against their hash after the durable write; only the before bytes are journaled for rollback, so the journal needs half the space.
- **Finished journals.** An applied or rolled-back journal is reclaimed (renamed aside, then removed) at once, as the TypeScript autonomous path does. A failed journal stays as evidence and counts against the journal budget.
- **Diffs and artifacts** are not part of the applier; they belong to the artifacts packet (P3).

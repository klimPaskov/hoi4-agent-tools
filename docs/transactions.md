# Transactions, diffs, and rollback

## Plan

A domain `plan_changes`/`map_plan` call calculates every affected source and binary file before writing. Proposed bytes are validated in memory. The plan persists content-addressed before/after blobs and produces source, binary, pixel, and rendered comparison artifacts where applicable.

Every proposed source target is resolved with write access restricted to the workspace's canonical
mod root. Transaction calls cannot write the game, a dependency, a fixture, artifact storage,
cache storage, or the reserved `.hoi4-agent` subtree as mod source.

The transaction API requires both validation phases: planning must return at least one explicit in-memory check, and apply must return at least one explicit post-write check. Missing or empty callbacks fail with `TRANSACTION_DRY_RUN_VALIDATION_REQUIRED` or `TRANSACTION_POST_VALIDATION_REQUIRED`; callers cannot opt out through the typed core API. Diff artifacts are committed as one batch with the journal only after the planning validator returns structurally valid results. A rejected validator or journal admission leaves artifact inventory unchanged. A completed dry run whose explicit checks fail remains reviewable as a blocked plan and cannot be applied.

Text diffs use an exact deterministic algorithm with a fixed memory bound and cancellation checks. If an exact diff would exceed the bound, planning stops with `DIFF_COMPLEXITY_LIMIT`; the server does not substitute a truncated, approximate, or misleading diff.

The returned transaction ID is not approval. Review:

- operations and unresolved choices;
- affected file list;
- source and visual diff resources;
- diagnostic locations and validation gates;
- expiry and plan hash.

Plan and mutation tool results keep only a bounded path sample plus the authenticated transaction
manifest resource. Review artifacts remain listed in that manifest rather than being duplicated as
hundreds of inline resource links. `hoi4.transaction_diff` returns at most 20 files, operation
summaries, and artifact links per page; follow every `nextCursor` until it is absent. Cursors are
bound to the immutable plan hash and fail if reused for a different transaction. Inline validation
contains at most five checks with an explicit truncation diagnostic; the manifest is the complete
validation record.

Focus plans include both the edited Clausewitz source and its adjacent `.focus-plan.json` design sidecar in one transaction. The manifest also retains the proposed generated-source map and sidecar artifacts through apply and rollback so each generated focus range remains traceable to its planning/source node.

## Apply

Call `hoi4.transaction_apply` separately with `workspaceId`, `transactionId`, and the exact 64-character `expectedPlanHash`. The server rejects a different principal/workspace, changed roots, failed dry run, expiry, reused state, or any changed before-hash.

The persisted immutable plan payload is recomputed against `planHash` whenever a manifest is
loaded. A recomputable integrity hash remains useful for deterministic diagnostics, but is never an
authorization boundary. Every exact-version manifest also carries an HMAC-SHA-256 tag over the
complete canonical payload except that tag itself, including expiry, state, applied files, failure,
rollback status, operations, plan, diagnostics, and validation. The random 256-bit key is created
atomically beneath the non-overlapping operator `serverStateRoot`; it is never derived from public
workspace data or exposed through MCP.

The same protected state stores one authenticated latest-revision head per admitted journal. An
older valid manifest is rejected as replay. Manifest replacement is cache-first and caller state is
updated only after persistence: a crash between cache replacement and protected-head commit may
reconcile only an HMAC-valid exact `+1` successor. Missing heads, gaps, conflicting same revisions,
and forged successors fail closed. Successor creation is durable before older revision-head files
are removed, so an old-head cleanup failure does not break loading.

Ordinary status, diff, and resource reads are pure: they accept only an exact protected head and
never promote state. An authenticated cache-first exact successor reports
`TRANSACTION_HEAD_RECONCILIATION_REQUIRED` until startup recovery or an authorized write path
performs the narrowly allowed reconciliation.

Unauthenticated journals from an older deployment are deliberately not auto-migrated. They remain
fail-closed for operator review because no server-held secret can prove their origin. Archive or
remove them explicitly before reclaiming their quota; do not manufacture an authentication tag.

During apply the server:

1. takes the exclusive workspace lock;
2. rechecks every precondition;
3. writes and flushes same-volume staged files;
4. journals backups and replacements in deterministic order;
5. rebuilds the shared index;
6. runs post-write validation;
7. removes temporary backups only after success.

The workspace lock serializes cooperating server processes that use the same cache. Before each
replacement, the current source hash is checked again; after post-write validation, every result
hash is checked. These checks detect stale ordinary edits, but they are not a race-proof
filesystem sandbox against a hostile operating-system principal.

## Failure and recovery

Any error starts rollback in reverse file order. Existing backups or persisted blobs restore exact original bytes, including BMP headers and padding. Restores stage and flush bytes before atomically renaming over the current target; they never unlink an existing target before a blob replacement. A durable `rolling_back` journal can also resume the legacy interrupted state where that target is already missing, but only after verifying its persisted before-blob. Startup scans unfinished journals and completes rollback before accepting a new write.

Runtime registration definitions are not persisted, but their hash-only ownership claims are.
Their unfinished journals are recovered only after the same principal re-registers an exactly
matching canonical workspace and the persistent claim is verified, before status or write access
is returned to the caller.

Lock owners record the host, process, server instance, and process start time. A dead owner on the same host is cleared during startup recovery; an ownerless acquisition lock is cleared only after a 30-second grace period. A live local owner and every different- or unknown-host owner remain authoritative. Automatic cross-host crash recovery is intentionally unsupported: deployments sharing a workspace/cache filesystem across hosts must provide single-writer orchestration and operator-confirmed recovery rather than relying on local PID evidence.

Multi-file atomicity is logical and recoverable, not an operating-system transaction. External
processes can briefly observe replacement steps. Under an operator-controlled filesystem, success
is returned only after post-write validation and final result-hash verification. A principal able
to concurrently replace directories, links, mounts, or files outside the transaction lock already
has direct filesystem authority and is outside the application security boundary; the server does
not claim race-proof atomicity against that actor.

## Journal retention and quotas

Transaction journals live under `<cacheRoot>/transactions`. The configurable defaults are 128
journals and 536,870,912 bytes per workspace cache. A plan must also fit its own rollback blobs,
serialized manifest, and replacement-work estimate beneath the byte ceiling. The plan is refused
with `TRANSACTION_JOURNAL_LIMIT` before a usable journal is committed if either the count, stored
bytes, or single-plan work budget would be exceeded. No smaller or truncated rollback journal is
substituted.

One manifest is bounded to 1,000 changed files, 1,000 operations, 10,000 read dependencies, 100
validation checks, 100 diagnostics, 512 artifacts, and 1,000 applied-file entries. Inputs over a
count limit or the existing serialized journal/work-byte budget are rejected, never truncated.
Post-write validation is preflighted against the combined check and diagnostic counts before the
manifest is mutated. A 100+1 overflow triggers exact rollback while preserving a schema-bounded
authenticated terminal journal.

Before committing a new plan, the server performs narrowly scoped retention cleanup:

- expired `planned` and `rolled_back` journals are removed by deleting their protected head first
  and cache journal second. A crash or later reintroduction of the cache copy then fails for a
  missing head rather than replaying;
- an incomplete transaction directory with no manifest is removed only after it is older than
  `transactionTtlSeconds`;
- `applied`, `failed`, `applying`, and `rolling_back` journals are not quota-evicted. Interrupted
  states are handled by recovery instead;
- malformed, integrity-failing, or otherwise unreadable journals are retained and continue to
  count against quota rather than being guessed safe to delete.

Only the latest protected revision is retained per live journal. Cache-without-head planned or
rolled-back remnants from an interrupted admission/prune are authenticated and removed safely;
active or unauthenticated remnants remain fail-closed. Head-without-cache remnants are removed
while reconciling a workspace. Protected state therefore remains bounded by admitted cache
journals rather than growing with revision or expiry churn.

After that cleanup, the server deterministically accepts the complete plan or refuses it. It does
not evict a valid applied/failed journal to make room. Operators who intentionally remove terminal
journals also remove their status, audit evidence, persisted blobs, and any later explicit rollback
ability.

Diff artifact creation and journal admission share a failure boundary. If the journal count or byte
check rejects a plan, the artifact store removes only content and provenance files created for that
attempt; artifact inventory is unchanged and any identical artifact retained by another operation
remains addressable.

## Explicit rollback

`hoi4.transaction_rollback` is available after successful apply. It first verifies that every current file still has the transaction's after-hash. An external edit makes rollback stale, protecting later work from being overwritten.

Rollback accepts cancellation through its path/hash verification preflight. Once byte restoration
starts, restore plus authenticated journal advancement is deliberately non-cancellable so a client
disconnect cannot strand a partial rollback.

Status/manifest reads and runtime recovery enumeration accept cancellation around filesystem
reads, JSON/schema validation, and protected-head verification. Once recovery begins restoring
source bytes, it follows the same non-cancellable critical-phase rule.

Transaction manifests are readable as:

```text
hoi4-agent://workspace/{workspaceId}/transaction/{transactionId}
```

Manifest resources use the same 1 MiB `offset`/`length` byte ranges as artifacts. A complete
strict-UTF-8 manifest may be returned as MCP `text`; every partial range is a base64 `blob`.
Advance `offset` by the decoded byte count and continue until a chunk is shorter than the requested
length. Transaction manifests have a separate fixed 16 MiB serialized ceiling, independent of the
larger rollback-blob journal budget.
Canonical resource bytes are cached by stable file identity and protected revision, with at most
eight entries and 16 MiB total, so later ranges do not repeatedly rebuild a large manifest object.

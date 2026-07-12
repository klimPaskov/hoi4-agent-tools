# Autonomous rewrites, transactions, and recovery

The recommended `"autonomous"` write policy exposes three source-mutation tools:

- `hoi4.focus_rewrite`;
- `hoi4.gui_rewrite`;
- `hoi4.map_rewrite`.

One rewrite call calculates every affected source and binary file, validates the proposed bytes in memory, persists an authenticated journal with exact recovery data, applies under the workspace lock, rebuilds the shared index, and post-validates the result. The caller does not receive or invoke separate transaction apply or rollback tools. Those tools are not registered in autonomous mode.

`"transactions"` remains available as an optional compatibility policy. It exposes the older `hoi4.focus_plan_changes`, `hoi4.gui_plan_changes`, and `hoi4.map_plan` tools, followed by `hoi4.transaction_diff`, `hoi4.transaction_apply`, `hoi4.transaction_status`, and `hoi4.transaction_rollback`. Both modes use the same core transaction engine and safety properties; only the public MCP workflow differs.

## Autonomous rewrite pipeline

Every autonomous rewrite follows this sequence inside one MCP call:

1. resolve targets with write access confined to the canonical mod root;
2. calculate the complete affected-file set and exact proposed bytes;
3. run domain-specific in-memory validation and create source, binary, pixel, or rendered evidence as applicable;
4. persist the plan, before/after blobs, authentication tag, and protected revision head;
5. recheck principal, workspace, canonical roots, expiry, and every before-hash under the workspace lock;
6. stage and replace files in deterministic order;
7. rebuild the shared index, run domain post-write validation, and verify every final hash;
8. return `execution: "applied"`, changed-file samples, validation, and evidence links only after success.

A proposal whose pre-write checks fail returns blocked with `execution: "blocked"` and changes no source bytes. A request whose desired bytes already match every target returns `execution: "unchanged"` as a successful no-op. Any error after replacement begins starts exact restoration before failure is returned. Startup recovery also completes restoration for an interrupted journal before another write is accepted. Autonomous mode therefore removes the client-driven review/apply handshake without weakening validation or recoverability.

The rewrite tools truthfully advertise `readOnlyHint: false` and `destructiveHint: true`. MCP does not mandate a confirmation prompt for each tool call. A coding-agent host can still prompt for or block the call under its own policy, and the server cannot override that host decision.

Git remains the recommended source-history, collaboration, and intentional-revert system. Internal recovery serves a different purpose: exact before-bytes and the durable journal prevent a failed multi-file rewrite from leaving partial corruption, including outside a Git checkout.

Successful autonomous journals are internal recovery data, not user history. They are reclaimed automatically when journal retention reaches its configured count or byte limit; authenticated source-linked evidence remains in the artifact store. Reviewed compatibility mode retains applied journals so its explicit rollback operation remains available.

## Planning and evidence

Proposed bytes are validated in memory before any source replacement. Every target is restricted to the workspace's canonical mod root; rewrites cannot write the game, a dependency, a fixture, artifact storage, cache storage, or the reserved `.hoi4-agent` subtree as mod source.

The transaction core requires both validation phases: planning must return at least one explicit in-memory check, and apply must return at least one explicit post-write check. Missing or empty callbacks fail with `TRANSACTION_DRY_RUN_VALIDATION_REQUIRED` or `TRANSACTION_POST_VALIDATION_REQUIRED`; domain adapters cannot opt out. Diff artifacts are committed as one batch with the journal only after the planning validator returns structurally valid results. A rejected validator or journal admission leaves artifact inventory unchanged. A completed plan whose explicit checks fail remains evidence for the blocked rewrite and cannot be applied.

Text diffs use an exact deterministic algorithm with a fixed memory bound and cancellation checks. If an exact diff would exceed the bound, planning stops with `DIFF_COMPLEXITY_LIMIT`; the server does not substitute a truncated, approximate, or misleading diff.

Autonomous rewrite results keep bounded path samples and return the generated evidence resources directly; internal transaction identifiers and plan hashes are not caller inputs or success-result fields. Every applied autonomous rewrite links a sanitized execution-validation JSON resource containing the complete pre-write and post-write checks, source-linked diagnostics, final target hashes, and any overflow diagnostic resources without exposing the internal transaction ID or plan hash. Inline validation remains capped at five checks for wire efficiency. Reviewed compatibility mode additionally exposes the authenticated transaction-manifest resource.

In reviewed compatibility mode, `hoi4.transaction_diff` returns at most 20 files, operation summaries, and artifact links per page. Follow every `nextCursor` until absent before applying. Cursors are bound to the immutable plan hash and fail if reused for a different transaction. A transaction ID is a journal identifier, not approval.

Focus rewrites include both the edited Clausewitz source and its adjacent `.focus-plan.json` design sidecar in one recoverable operation. The manifest retains the proposed generated-source map and sidecar artifacts after success or restoration so each generated focus range remains traceable to its planning/source node.

Complete focus proposal validation is a linked JSON resource. If proposed or post-write diagnostics exceed the fixed manifest allowance, validation still evaluates the complete set, stores it as a source-linked MCP resource, and retains a blocker-first bounded manifest summary. The plan phase reserves diagnostic capacity for the independent post-write phase, so a warning-heavy large tree does not weaken limits or prevent a valid rewrite.

## Apply pipeline and protected state

Autonomous tools pass their internal transaction ID and exact 64-character plan hash directly to the core apply path. In compatibility mode, the caller supplies the same values to `hoi4.transaction_apply`. The server rejects a different principal/workspace, changed roots, failed pre-write validation, expiry, reused state, or any changed before-hash.

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

Ordinary manifest-resource reads, and status/diff reads when compatibility mode exposes them, are pure: they accept only an exact protected head and never promote state. An authenticated cache-first exact successor reports
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

## Explicit rollback in compatibility mode

`hoi4.transaction_rollback` is available only in reviewed `"transactions"` mode after successful apply. It first verifies that every current file still has the transaction's after-hash. An external edit makes rollback stale, protecting later work from being overwritten.

Autonomous mode does not expose an explicit rollback tool. Failed application and post-validation restore automatically; an intentional later reversal belongs in Git or a new explicit domain rewrite.

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

# 28. Incremental source segments

## Decision

Workspace scans verify current file bytes and enumerate every selected root, including installed-game roots.
File size, timestamps, and inode metadata alone cannot establish content identity.
Unchanged content can reuse bounded, content-addressed parsed documents and file-local index facts.

All domain calls use the same Clausewitz parser cache.
Its retained entries are serialized process-local documents, not shared mutable ASTs.
Each cache hit creates an independent document with original bytes, encoding, tokens, locations, diagnostics, and source revision.
V8 serialization is an internal memory representation only; it is not a public artifact format or a persistent cross-version protocol.

The engine retains file-local symbols, references, and diagnostics before active-definition selection and cross-file validation.
Segment addresses include content, source location, root kind, load order, shadowing, selected province-table interpretation, and tool version.
Each aggregate rebuild selects active definitions and recomputes cross-file diagnostics from the current set of segments.
Event and technology services verify current source identities before reusing a derived graph, including edits made by another process without an explicit refresh request.
Technology reuse also verifies selected asset identities, so changing a texture cannot retain the previous presentation graph.
Parsing/index limits preserve incomplete coverage instead of caching a partial source as complete.
Typed reverse source edges identify transitive consumers, including cycles, without treating arbitrary strings or numbers as references.

Event and technology semantic fragments use the shared dependency observer in `core/semantic-dependencies.ts`.
The observer records actual typed definition-catalog lookups, including absent entries whose later addition may resolve an unknown helper, instead of guessing references from arbitrary source strings.
Catalog iteration or size access records the whole binding; individual lookups bind only the values actually read.
Fragment identities include source bytes, canonical source path, relative path, root kind, load order, shadowing, tool version, workspace/domain identity, inventory completeness, and the observed catalog values.
Identical technology text at different locations cannot reuse another file's source provenance.

On each source inventory change, the old and new typed definitions and recorded consumers feed `ReverseSourceDependencies`.
Changed files and their transitive consumers are reanalyzed, including cycles, removals, renames, overlays, and newly resolved helpers, while unrelated semantic fragments remain reusable.
Each reused fragment also rechecks its exact catalog-read signature against the current immutable scan context.
Per-consumer revision stamps retain pending invalidation across interrupted rebuilds, and a new baseline revision prevents old observations from becoming reusable after inventory eviction.
The aggregate graph, active definitions, helper projections, and cross-file diagnostics are still recomposed from the current fragments; this is not a claim that all graph work is file-local or incremental.

Dependency proof retention has separate 32 MiB estimated-byte budgets for fragment observations and source/definition inventories, with ceilings of 10,000 fragment proofs and 32 workspace/domain inventories per owner cache.
The owner services clear those proofs with their semantic caches, and a discarded proof requires reanalysis rather than an unproven fragment hit.
These process-local dependency observations do not contain scenario state and do not replace the authenticated cross-process parsed/index cache.

Parsed-document and index-segment retention each have a 64 MiB process-local budget and least-recently-used eviction.
Oversized entries remain analyzable without cache retention.
The existing idle release clears both caches; invalidating a workspace snapshot need not discard reusable immutable segments.
Cache hits and avoided indexing are measured separately from correctness and end-to-end request latency.

Authorized local processes also share an authenticated content-addressed cache beneath operator-owned server state.
Its scope includes workspace identity, root fingerprint, and principal, while its addresses include tool version and, for parsed documents, the exact Node/V8 runtime.
Hydration revalidates serialized documents against current bytes and paths before use.
Malformed, tampered, mismatched, or runtime-incompatible entries are ignored and healed from source; no cache entry can broaden workspace access.
The persistent cache has a 256 MiB and 50,000-entry global default budget plus a 16 MiB single-entry ceiling.

## Bounded expansion and recovery

Event and technology helper expansion streams distinct structural paths with an opaque continuation bound to workspace, principal, tool version, source revision, root selection, and depth. A page and its cursor publish together; changing page size or work allowance is safe, while changing the semantic query fails. Source inventories are verified on every continuation, and materialized graphs report incomplete depth or projection coverage.

Dependency checkpoints publish their envelope, chunks, and authenticated job commitment together. Active checkpoints pin resources until the job terminates; a failed replacement leaves the earlier checkpoint usable. Recovery must reject a stale source revision or tampered frontier rather than merge old and new evidence. These rules cover large graphs while keeping source scanning and byte verification mandatory.

## Shared rewrite execution

Rewrite execution and domain post-write validation reside in the shared core.
The previous MCP module paths re-export those same functions for compatibility; they do not contain another implementation.
A typed internal pre-apply hook allows a job coordinator to durably bind its request to the transaction journal before source mutation begins.
If that bookkeeping fails or the request is cancelled before application, no source write starts.
The existing apply, post-validation, and automatic recovery path remains unchanged.
Persistent rewrite jobs use this hook to bind their durable transaction and completion recipe before source application.

Transaction recovery also accepts one specific journal identity without enumerating or reclaiming other journals.
It authenticates the journal and checks its principal before reconciliation, acquires the existing workspace write lock, and reads the journal again under that lock.
Committed, planned, and terminal journals are returned without applying the write again.
Only interrupted applying or rolling-back journals enter the existing exact-byte restoration path.
A live writer retains its lock, and repeated recovery of a restored journal leaves its revision and source bytes unchanged.
Persistent job ownership and retry receipts are defined by [ADR 0029](0029-persistent-jobs.md); this internal transaction method is not a public rollback tool.

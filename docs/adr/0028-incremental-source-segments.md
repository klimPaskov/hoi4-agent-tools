# 28. Incremental source segments

Status: implemented for Stage 2; release qualification pending.

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

Parsed-document and index-segment retention each have a 64 MiB process-local budget and least-recently-used eviction.
Oversized entries remain analyzable without cache retention.
The existing idle release clears both caches; invalidating a workspace snapshot need not discard reusable immutable segments.
Cache hits and avoided indexing are measured separately from correctness and end-to-end request latency.

Authorized local processes also share an authenticated content-addressed cache beneath operator-owned server state.
Its scope includes workspace identity, root fingerprint, and principal, while its addresses include tool version and, for parsed documents, the exact Node/V8 runtime.
Hydration revalidates serialized documents against current bytes and paths before use.
Malformed, tampered, mismatched, or runtime-incompatible entries are ignored and healed from source; no cache entry can broaden workspace access.
The persistent cache has a 256 MiB and 50,000-entry global default budget plus a 16 MiB single-entry ceiling.

## Validation and remaining work

Synthetic tests compare cached and clean rebuilds across edits, additions, removals, renames, shadowing, load-order changes, province-table selection, typed transitive consumers, cycles, and unrelated files.
Negative tests cover partial sources, map-table limits, consumer mutations, bounded retention, generated-storage aliases, principal separation, persistent-entry tampering, and same-size/same-timestamp external edits.
A real child process reopens exact parsed and indexed facts, and a later engine heals a corrupted entry without changing the analysis result.

Event and technology services re-enumerate and hash their selected roots before reusing a derived graph.
Event focused analysis preserves structural helper calls and expands requested paths within explicit depth, node, and edge boundaries; full analysis materializes the bounded workspace helper projection.
Technology helper references retain complete eligible, excluded, unresolved, and deferred evidence under their declared bounds.
Read-job results and retained graph artifacts bind those coverage decisions to their exact source revision.

This implementation does not claim zero-cost change detection: root enumeration and byte verification remain mandatory correctness work.
The complete platform, package, publication, and installed-package gates remain release evidence.

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

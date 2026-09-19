# 28. Incremental source segments

Status: partially implemented for Stage 2; semantic consumer invalidation and resumable dependency frontiers are implemented, while full large-analysis and release acceptance remain pending.

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

## Validation and remaining work

Synthetic tests compare cached and clean rebuilds across edits, additions, removals, renames, shadowing, load-order changes, province-table selection, typed transitive consumers, cycles, and unrelated files.
Negative tests cover partial sources, map-table limits, consumer mutations, bounded retention, generated-storage aliases, principal separation, persistent-entry tampering, and same-size/same-timestamp external edits.
A real child process reopens exact parsed and indexed facts, and a later engine heals a corrupted entry without changing the analysis result.

Event and technology services re-enumerate and hash their selected roots before reusing a derived graph.
Event focused analysis preserves structural helper calls and expands requested paths within explicit depth, node, and edge boundaries; full analysis materializes the bounded workspace helper projection.
Technology helper references retain complete eligible, excluded, unresolved, and deferred evidence under their declared bounds.
Read-job results and retained graph artifacts bind those coverage decisions to their exact source revision.

Dependency checkpoints publish their logical envelope, all physical chunks, and authenticated job-record commitment under the artifact publication lock.
Active checkpoints pin their physical resources across engine processes sharing the same workspace identity and root fingerprint, including distinct authorized principal scopes.
Admission-pressure eviction reads authenticated job records through an operator-internal guard; it does not expose other principals' jobs through the public API.
Terminal jobs release those pins, and replacement-publication failure preserves the previous checkpoint.
Enumeration, resource counts, record sizes and logical chunk loading remain bounded; invalid or tampered pin records fail retention closed.
The checkpoint tests exercise fresh-engine hydration under repeated eviction pressure, terminal unpinning, revision/hash mismatches, failed replacement publication and tampered records.
The checkpoint suite passed five tests, including rejection of an unrecognized record filename.
Production worker recovery tests use separate synthetic event and technology fixtures with 2,500 helper branches, stop only the proven test-owned child after it publishes an intermediate checkpoint, and compare the replacement's entire tool result with a clean execution.
All four cases passed on 2026-09-13: both domains with unchanged source and with source edits before recovery.
The tests distinguish the checkpoint's source-scan revision from the technology presentation graph's derived revision and prove stale source checkpoints are not mixed with current evidence.
The targeted artifact, job, event-service, technology-acceptance, checkpoint, and traversal regression suites passed 110 tests across ten files; the four production recovery cases passed in a separate rerun.
Elementary-transition tests restore both node- and path-based walks after every transition, including cycles, convergence, depth boundaries, reversed adjacency order, and a 4,000-edge wide cursor.
Negative cases reject malformed frontiers and preserve the last valid state on cancellation or work-limit failure; worker policy cases bound retries and prohibit write replay or cancelled-job restart.
The semantic dependency regression initially reproduced workspace-wide invalidation after an unrelated helper addition in both domains and incorrect technology diagnostic provenance for identical source bytes in separate files.
The corrected nine-case suite compares cached and clean graphs through missing definitions, additions, same-size edits, transitive cycles, removals, renames, overlays, load-order changes, shadowing, inventory completeness, source-root isolation, and dependency-proof release.
It also asserts which source fragments were rebuilt, so graph equivalence alone cannot mask workspace-wide semantic reanalysis.
The first targeted event/technology, index/cache, and production worker-recovery regression passed 103 tests across eleven files.
A subsequent negative case exposed pending invalidation being lost when a rebuild stopped after inventory reconciliation; persistent per-consumer revision stamps fixed it, and the nine-case suite also checks bounded inventory eviction.
The final targeted matrix passed 114 tests across twelve files on 2026-09-13, including the project-owned large event and technology acceptance fixtures, parsed/index cache isolation, per-file provenance, transitive invalidation, and all four real-worker dependency-recovery cases.
This is local development evidence for the changed candidate, not the complete platform or release gate.
The opt-in `helper_expansion` mode in both inspectors uses `DependencyPages` to stream distinct structural edge paths without retaining completed traversal history.
The cursor contains only the active DFS frames and exact counters, while source inventories are rebuilt and verified on every page request.
Event state accesses and technology references are leaf edges, so one helper with many facts is paginated rather than attached as an unbounded record payload.
`core/helper-expansion.ts` binds opaque continuation resources to the configured workspace, root topology, principal, tool version, exact source revision, root selection, and depth.
Page and cursor publication is one artifact-store batch; page size and work allowance may change on resume, but semantic query changes fail explicitly.
This opt-in API is an additive candidate-3.1.0 change and does not alter representative-path selection in existing materialized graph modes.
Those graphs report incomplete coverage for depth and projection truncation.
The initial page regression passed 17 tests on 2026-09-13, including 786,431 compact traversal records, exponential source graphs, fresh-service resumption, source edits, principal and domain isolation, chunked cursor loading, cursor tampering, depth recovery, and exact MCP/persisted-job result equivalence.
The final frozen regression passed 190 tests across 22 files on 2026-09-13 in 232.21 seconds on this Windows host.
It includes both large domain acceptance fixtures, full event and technology MCP workflows, ordinary/persisted-job parity, all four real-worker interruption/recovery scenarios, checkpoint retention, semantic invalidation, and package metadata alongside the new page cases.
The generated request and summary schemas, packaged documentation, strict request validation, and additive result summary are synchronized for this candidate.
Type checking and scoped linting also passed; a complete `npm run check`, coverage, platform matrix, package installation, Inspector qualification, and publication are not established by this subset.
Broader materialized-graph memory refinement and complete Stage 2 acceptance remain pending.
The negotiated modern MCP task adapters are implemented in the local candidate and tracked separately in [ADR 0031](0031-modern-mcp-task-adapter.md); their presence does not qualify this stage for release.

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

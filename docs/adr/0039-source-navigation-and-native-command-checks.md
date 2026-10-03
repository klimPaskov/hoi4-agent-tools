# ADR 0039: Source navigation and native command checks

Status: accepted

## Decision

Extend `hoi4.source_lookup` with bounded structural navigation through exact parser nodes.
The active definition is selected by existing load-order rules, repeated keys require explicit occurrence selection, and structure and text continuations retain the source revision.
Definition-only reads for events and scripted helpers use narrow source-family scans; event consumers use the analyser's supported owner families, and other consumer queries use the broader workspace scan.
Semantic usage analysis is cached by the immutable scan snapshot, so changed sources cannot reuse prior reference results.

Expose `hoi4.script_validate` for standalone effect and trigger bodies.
The checker reads native command kinds and supported scopes from one selected local documentation authority and returns the exact source citations.
It checks explicit language wrappers and scopes, while unknown helpers, unsupported argument bodies, missing documentation, and bounded traversal exhaustion remain unresolved.
Documentation prose is not promoted into an inferred parameter type system.

## Compatibility and bounds

Existing source-lookup inputs retain their defaults; navigation fields are optional.
The added tool requires a minor package release and refreshed discovery documentation before publication.
Syntax, command-kind, and declared-scope checks do not establish runtime behavior or validate every command parameter.
Source replies are bounded to 2,000 bytes per definition, structural replies to 40 children per page, and validation input to 64,000 UTF-8 bytes with at most 256 visited entries.
The default public discovery surface has 35 tools and is bounded to 75 KiB.

Reference metadata and JSON-escaped text are byte-bounded before reaching the common wire envelope.
Structural continuation addresses unkeyed entries by index, and omitted child, definition, citation, and finding counts remain explicit.
Authority-filtered searches avoid unrelated roots, and cited reads reuse an authority hint while hashing current source bytes.

## Scan and cache behavior

Source verification overlaps up to eight file handles while reserving the aggregate byte allowance before reading a batch.
Concurrent byte reads are grouped within 16 MiB, with larger admitted files read alone.
Canonical root, file identity, size, and timestamps are checked around reads; changing or replaced files require a focused retry.
The scanner still hashes every admitted source and does not trust timestamps as content identity.

Resident scan snapshots are checked before persistent hydration.
Already resident parsed documents and index segments need no disk-cache import.
Optional cache persistence is bounded to 16 new entries and 1 MiB of payload per scan; later scans may fill additional entries.
Cache write limits do not truncate the source analysis, and `limitedBatches` records cache admission limits.

File enumeration uses a pinned glob implementation without the unpatched `braces` dependency chain.
Patterns remain root-relative, brace complexity is bounded, symbolic-link prefixes are excluded, and literal escaped filenames retain exact selection.
Enumeration accepts up to 8,192 exact paths while retaining a 512-wildcard ceiling, so large icon sets do not require unbounded wildcard fan-out.
The dependency audit and transition tests qualify this implementation change independently of the source-analysis results.

Worker readiness loads core infrastructure only.
After reading the authenticated job, the worker imports one fixed domain module and confirms the exact registered operation before execution.
Unrelated domain renderers and schemas do not contribute to every job's startup cost; no module path or executable is selected by client input.
The host closes its startup IPC channel only after the child acknowledges receipt, with a bounded acknowledgment window and phase/exit diagnostics for failed startup.

## Map evidence

Province ID continuity remains enforced for rewrites.
The offline Map modding reference, Provinces section, describes shifted province properties after ID gaps; read-only map inspection retains gap diagnostics without rewriting source.
The cited local snapshot revision is `0ad59bdfc32a65cde902d7fbf5d6de5142656efae3529ffac3cd0be5f96011d4`, lines 210–259, obtained through `hoi4.reference_read`.
Installed map-mode documentation does not settle province ID loading behavior.
The editor's acceptance of sparse IDs alone is insufficient evidence to weaken that rule, and no game execution was performed.

# ADR 0085: The shared symbol index on the engine, and the TypeScript index retired

Status: accepted

## Context

Maintainer decision M-8 ends with retiring the TypeScript index once nothing depends on it. ADR 0080, 0082 and 0083 moved `hoi4.mod_index`, `hoi4.source_lookup` and the closure option of `hoi4.script_validate` onto the engine's own symbol index. Every other tool still built `SymbolIndex` in TypeScript: the events, technology, decisions, focus, GUI, impact, package check, mechanics and scenario analyzers read its definitions, their `metadata`, locations, references and diagnostics.

A CPU profile of a Chaos Redux decision inventory spent 6.4 s of 11.1 s in the TypeScript index (parsing every script and localisation file, then walking it). The analysis itself took under a second.

The engine's index (ADR 0080) records kind, id, file and line, and only some references. The analyzers need more: each record's `metadata` (sprite textures, localisation values, decision categories, event types and the rest), full TypeScript locations (line, column and UTF-16 offset at both ends), every reference of every unshadowed file, and the parser diagnostics of the workspace's own files with their messages. They also index files that exist only in memory, such as proposed rewrites.

## Decision

**The engine does each file's work, the server keeps the bookkeeping.** `hoi4-engine index-files` (and the `index.files` operation of `hoi4-engine serve`) takes the files the server's scan read and answers, for each file:

- its definitions with their TypeScript location and metadata;
- its references;
- the diagnostics `indexFile` reported for it;
- the ceiling diagnostics that make the index skip it;
- whether a table or nesting ceiling made the index incomplete.

`SymbolIndex.fromEngine` then does what `SymbolIndex.build` did across files, in the same order: the `default.map` selection, load order and shadowing, the record and diagnostic ceilings, the skipped-source list, active definitions, collisions, unresolved references and the final sort. That bookkeeping is a few hundred lines and cheap. The parsing and walking were the cost, and they move.

**The port.** `symbol_index::records` and the reader and walk it builds on gain what the analyzers read. The reader keeps node end offsets and, on request, every source diagnostic with its TypeScript message, place and details. The walk records each definition's span and metadata, and the localisation reader each entry's value. Positions are converted from bytes to the TypeScript line, column and UTF-16 offset through a table of line starts. Locations travel as six numbers, and the server adds the path and the symbol they name. The mod index, source lookup and closure keep their faster counting path.

**Files by path, in-memory files by bytes.** Each file is named by its absolute path and the SHA-256 the scan read. The engine reads the file and answers `retry` when the file is gone or holds other bytes, which covers a proposed rewrite or an edit since the scan. The server then sends those files' bytes in the frame's payload in a second request. Files `indexFile` would not read are not sent.

**Two ways to call it.** `SymbolIndex.buildAsync` (the workspace scan and the event scan) uses the resident engine (ADR 0077), with the answer in the frame's payload. `SymbolIndex.build` stays synchronous for its many callers (overlays of proposed sources, tests) and runs the one-shot command with `spawnSync`. A missing or failing engine is `ENGINE_UNAVAILABLE`. Nothing falls back to TypeScript.

**What is retired.** The TypeScript walk, the map-table readers and the file-segment cache (`IndexSegmentCache`, the `previous` reuse) go. The persistent analysis cache goes too. Its only producer at scan time was the TypeScript index, which parsed every file while indexing, and issue 69 found it gave no speed-up. The parsed-source cache in memory stays, because the analyzers still parse the files they read.

**Parity.** `scripts/symbol-index-parity.ts` ran the TypeScript scan and index and the engine index over the same files, on the installed game and every benchmark mod. It compared every definition (kind, id, file, location, metadata, overridden, source-shadowed), every reference, every diagnostic, the skipped sources, completeness and the file list, in order. `tests/unit/engine-symbol-index.test.ts` compares the two on synthetic sources covering every definition family, localisation, map tables, malformed syntax, non-ASCII text and CR LF, Windows-1252 bytes, game and shadowed files, and files on disk, in memory and edited since the scan. The pull request records the result. The script needs the TypeScript builder, so it is removed by the commit that retires the builder. The commit before that one keeps it, to run it again.

## Consequences

- Every analyzer gets its index from the engine. On Chaos Redux the index took 2.8 to 5.2 s on the engine where the TypeScript scan and index took 26 s.
- A change to a definition, reference or metadata rule is made once, in the engine. The TypeScript bookkeeping in `SymbolIndex` stays the one place for cross-file rules.
- Every tool that builds the shared index needs the engine, as the mod index already does. The tests use the cargo build the test setup finds (ADR 0080).
- `CoreEngine` loses `indexSegments` and the persistent-cache hooks. `analysis-cache/` under the server state root is no longer written, and an existing one can be deleted.
- An edit re-indexes every file of the scan. The TypeScript segment cache re-indexed only the edited ones. The engine's per-file work is fast enough that this costs about a second on a large mod. A per-file cache in the resident engine, keyed by path and hash, can follow if a measured warm case needs it.

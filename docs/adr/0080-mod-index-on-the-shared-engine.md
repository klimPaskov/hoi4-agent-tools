# ADR 0080: `hoi4.mod_index` on the shared engine, and the shared symbol index

Status: accepted

## Context

ADR 0074 names `hoi4.mod_index` as the first existing route to move onto the shared Rust engine. The TypeScript route read, hashed and parsed every source of the workspace through `CoreEngine.scan` before it could count anything: a first overview of Chaos Redux took 13 to 23 seconds against a 2 second target (benchmark problem 13), and a repeated call still took seconds because each scan reads and hashes every file again. The next route, `hoi4.source_lookup`, reads the same index, so what moves now must be the index itself, not a private copy for one tool.

The engine's own `index.rs` has a different taxonomy (`Kind`) for its checks and reads files with `hoi4-syntax`, whose tree differs from the TypeScript reader's in ways that change counts: `key { }` and `rgb { }` forms, operators where a value belongs, white space outside ASCII and the per-file diagnostic ceiling that made the TypeScript index skip a file.

## Decision

**One shared symbol index in the engine.** `engine/crates/engine/src/symbol_index/` reproduces the TypeScript index for the TypeScript kinds: the reader (`reader.rs`, a port of `core/source`), the scan (`scan.rs`, a port of `core/scanner.ts` and the subset of `file-glob.ts` the shared scan uses), the definition rules (`walk.rs`) and the index with `default.map` selection, map tables, skipped-source coverage and the `overridden` and `sourceShadowed` rules (`mod.rs`). Each record keeps its kind, id, file (root kind, load order, display path) and line. `engine/PROVENANCE.md` names the TypeScript source and commit of each file. References, record metadata, diagnostics and the segment cache are not carried over; `hoi4.source_lookup` adds what it needs when it moves.

**The server still owns the workspace.** The request (`hoi4-mod-index-request/1`) carries the roots the resolver produced (kind, path, load order, DLC label, `replace_path` folders), the shared scan's glob patterns and the configured scan ceilings. The engine applies them as the TypeScript scanner did, including `replace_path` covering subfolders (the difference from the game that ADR 0074 records stays until it is decided on its own) and the `SCAN_FILE_LIMIT` and `SCAN_BYTE_LIMIT` codes. Glob syntax outside what the shared scan uses is refused (`SCAN_PATTERN_UNSUPPORTED`). The descriptor is still read in TypeScript.

**Two commands.** `hoi4-engine mod-index` answers the tool: kind counts of definitions that are not overridden, folder totals and event namespaces for `overview`, and used, highest and first free number for `next_id`. `hoi4-engine symbol-index` prints every record (`hoi4-symbol-index/1`), for the parity check and for the next route. The TypeScript route shapes the answer (sorting, the 60-folder and 200-namespace caps), so the tool's output is unchanged.

**No fallback.** The route runs the engine once per call through the engine client (ADR 0074). A missing, crashing or out-of-shape engine is `ENGINE_UNAVAILABLE`; a refused request keeps the engine's code. The resident process (ADR 0077) is not used yet: a call reads the files again, which the operating system's file cache keeps fast, and a cache keyed by path, size and modification time can follow when a measured warm call needs it.

**Tests need an engine.** The tool's existing tests run unchanged against a cargo build: `tests/helpers/engine-binary.ts` points `HOI4_ENGINE` at `engine/target` (or `CARGO_TARGET_DIR`) when it is unset, and CI and the release workflow build `hoi4-engine-cli` before `npm run check`. Tests that check an unavailable engine still set `HOI4_ENGINE` themselves. `mcp-focus-engine.test.ts` is left without an engine: it changes `HOI4_ENGINE` after a job worker has started, and a worker keeps the environment it started with. The real-engine tests that skipped in CI for want of a binary now run there.

**Parity is checked on real workspaces.** `scripts/mod-index-parity.ts` runs the TypeScript scan and the engine on the installed game and the benchmark mods and diffs the (kind, id, overridden) multisets, file counts, completeness, folder totals, kind counts, namespaces and `next_id` answers. The result for this change is in its pull request.

## Consequences

- `hoi4.mod_index` answers the same data from the engine in about a second where the TypeScript scan took tens of seconds.
- Platforms without a bundled engine, and a container image built without the `engine-bin` context, answer `ENGINE_UNAVAILABLE` for `hoi4.mod_index`. Contributors need a Rust toolchain to run the full test suite.
- Two readers of the TypeScript rules now exist until the TypeScript index retires. A change to the TypeScript index rules must be made in both, and the parity script shows a missed one.
- `hoi4.source_lookup` can move onto `symbol_index` next.

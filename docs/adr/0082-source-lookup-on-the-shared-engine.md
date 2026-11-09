# ADR 0082: `hoi4.source_lookup` definitions on the shared engine

Status: accepted

## Context

ADR 0080 moved `hoi4.mod_index` onto the shared Rust engine and built the symbol index there so that `hoi4.source_lookup` could follow. `source_lookup` answered from a full TypeScript scan of the workspace: it read, hashed and parsed every source before it could name one definition, the first call on the game took about 54 seconds against a 3 second target, and the scan was repeated whenever any file changed.

A lookup answers four things from the index: the definitions of a symbol (with their lines), the references to it, the revision of the scan that produced them, and, for a miss, the near names. The references come from two TypeScript passes (`SymbolIndex` reference extraction and `scanImpactSemanticReferences`) that the engine does not carry yet. `includeReferences` defaults to true, so a default call still needs them.

## Decision

**A `source-lookup` command answers the definitions.** `hoi4-engine source-lookup` (`hoi4-source-lookup-request/1`) takes the same roots, patterns and scan ceilings as `mod-index`, plus the symbol, an optional kind and the number of definitions to return. It builds the shared symbol index and answers with the definitions (kind, id, file, root kind, load order, `overridden`, `sourceShadowed`, first and last line, the file's absolute path and SHA-256), the number of definitions and distinct kinds, completeness, and, when nothing defines the symbol, the indexed ids within three edits. The server picks the five suggestions from those candidates with the English locale order the TypeScript route used, because the engine cannot reproduce that collation.

**The revision is the scan's revision.** `ScanSnapshot.revision` is the SHA-256 of the canonical JSON of every scanned file's absolute path, display path, relative path, root kind, load order, shadowing file and content hash. The engine computes the same value, so an `expectedRevision` taken from any other tool still matches. A parity check on the installed game and the benchmark mods compares the two values.

**The server reads only the chosen files.** The engine never returns source text. The server reads each returned definition's file for the lines and the nested navigation, only from inside a configured root, within the scan's file ceiling, and only when its SHA-256 equals the one the engine scanned: a file that changed in between answers `SOURCE_REVISION_STALE`. The nested navigation needs the definition's offsets, which the engine does not record; the server finds the assignment by its first and last line in its own parse of that one file.

**Scope of this step.** A request with `includeReferences: false` and a symbol answers from the engine. A request with `includeReferences: true`, and a request for a source position (`path` and `line`, which already scans only that file's folder family), still answer from the TypeScript scan. Moving the references onto the engine is the next step and keeps issue 107 open; it needs reference extraction and the semantic scan in Rust.

**No fallback.** A missing, crashing or out-of-shape engine is `ENGINE_UNAVAILABLE` for a request the engine answers; the TypeScript path is not a fallback for it. A request outside this step's scope never needs the engine.

## Consequences

- A lookup without references no longer scans the workspace in TypeScript. The reference answer is unchanged until the next step, so a default call is as slow as before.
- The engine's symbol records now carry the last line of each definition, and the reader records each block's closing line. The `symbol-index` output gains `endLine`.
- Definitions of localisation keys and scalars end on their own line. The records of the map tables (provinces, province colours, adjacencies, supply nodes and railways) carry no lines, as in the TypeScript index, and the engine answers 0, which the server reports as no line. Nested navigation into a definition on which no assignment starts answers `SOURCE_STRUCTURE_UNAVAILABLE`.
- A change to the TypeScript scan's revision inputs must be made in the engine too; the parity script shows a missed one.

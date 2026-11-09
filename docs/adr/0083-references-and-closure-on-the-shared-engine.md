# ADR 0083: References and the whole-mod closure on the shared engine

Status: accepted

## Context

ADR 0082 moved the definitions of `hoi4.source_lookup` onto the shared Rust engine. A default call (`includeReferences: true`) still scanned the workspace in TypeScript, because the references come from two passes the engine did not carry: the definition walk of `SymbolIndex` (technology, focus, GUI and state edges) and `scanImpactSemanticReferences` (the typed script edges of events, focuses, decisions, ideas, technologies, scripted effects and triggers, scripted GUIs and on-actions). The first default call on the game took about 54 seconds against a 3 second target.

Issue 107 also asks for a whole-mod closure option of `hoi4.script_validate`: resolved, unresolved and unknown counts per kind, with the verdict `incomplete` whenever anything is unknown. HOI4 Factory stage S04 needs both before it starts.

## Decision

**The engine finds the references.** The `source-lookup` request takes `includeReferences` and `maxReferences`. The definition walk records the TypeScript walk's references when it visits the same branches, so a rule that adds a definition adds its references in the same place. A new `symbol_index::semantic` module ports `ownerFor`, `staticTarget`, `stateKeyTarget` and the emit rules of the semantic scan, with on-actions included as `hoi4.source_lookup` asked. Both passes keep only the references to the requested symbol, but count every reference and every unresolved one, so `referenceCount`, `referencesComplete` and `unresolvedReferenceCount` carry the whole scan's ceilings, as in TypeScript. The answer lists the index's references first, then the semantic ones sorted by path, owner, target kind, target and edge, drops the ones of another target kind, and merges two at the same place with the same edge. The reader records the start offset of every scalar and block, because that place is the identity of a reference (two `has_idea = x` on one line stay two).

**The route sends every symbol lookup to the engine.** A request with a symbol answers from the engine whatever `includeReferences` says. Only a request for a source position (`path` and `line`) still scans in TypeScript: it reads one folder family and needs the scan's file bytes. A missing or out-of-shape engine is `ENGINE_UNAVAILABLE` for every lookup that names a symbol.

**The closure is its own engine command.** `hoi4-engine closure` (`hoi4-closure-request/1`) builds the same index, keeps every reference the mod's own, unshadowed sources record (`RootKind::Mod` and `Fixture`, via `References::OwnFiles`; the game's and the other roots' references are counted for the ceilings only), and classifies each by its target kind:

- **resolved**: an active definition of that kind and id exists; a localisation key counts when any language defines it; a write of a variable, flag or event target resolves, and so does a read some scanned source writes;
- **unresolved**: no definition exists and no skipped source could define that kind;
- **unknown**: the target cannot be named statically, a skipped source could define the kind, or a read of a variable, flag or event target has no writer in the scanned sources (a writer in a file the scan does not read cannot be ruled out).

The verdict is `incomplete` whenever anything is unknown or the index or the semantic scan is partial, `unresolved` when only unresolved references remain, and `closed` otherwise. The option is `closure: true` of `hoi4.script_validate`, exclusive with `source` and `path`, and it answers the usual envelope with `checksPerformed: ["closure"]`, `valid` true, false or null for the three verdicts, `partialReasons` for the unknown parts, and a `closure` object with the verdict, the scan revision, completeness, the number of sources and the counts in total and per kind. The `documentation` field is absent, because the check reads no documentation.

**Scope of the closure.** It counts what the walk and the semantic scan see. A reference kind neither records (for example effects in `history/` files, which the semantic scan does not read) is not in the counts, so `closed` means the recorded references resolve, not that the mod has no reference problems. The per-kind counts name what was checked.

**No fallback.** A missing, crashing or out-of-shape engine is `ENGINE_UNAVAILABLE`; no TypeScript path stands in for it.

## Consequences

- A default `hoi4.source_lookup` call no longer scans the workspace in TypeScript. `scripts/source-lookup-parity.ts` compares the engine's references with the TypeScript scan's on the installed game and the benchmark mods.
- The reply of `hoi4-engine source-lookup` gains `references`, `referenceCount`, `semanticComplete` and `unresolvedReferenceCount`; the server's schema defaults them for an engine that predates them.
- `hoi4.script_validate`'s input schema gains `closure` and its output gains `closure`, and `documentation` becomes optional. This is a minor version change; the existing modes answer as before.
- The reader's `Scalar` and `Block` carry start offsets, and `Symbol` carries `active` (the definition `find` returns), which the semantic scan uses to decide who owns a reference.
- A change to a reference rule of the TypeScript index must be made in the engine's walk too; the parity script shows a missed one.

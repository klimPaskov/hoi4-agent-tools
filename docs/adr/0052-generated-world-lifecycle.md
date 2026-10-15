# ADR 0052: Generated world lifecycle and starting scenarios

## Context

Reference maps need an inspectable interpretation before source writes. Rebuilding a world with fewer states or regions can leave obsolete files active, and a technically valid map lacks the country data needed to enter a campaign.

## Decision

Reference worlds default to `startingScenario: true`; procedural worlds retain their prior behavior. The same typed generator emits the bookmark, country histories, recruitable infantry template, two starting divisions, stockpiles and a production line alongside the geography. `worldName` names the bookmark. Replaced startup and AI folders prevent old-world scripted initialization from acting on unrelated IDs. Existing continent identifiers remain declared for shared portrait/script dependencies. No new authored events, decisions or national focus trees are generated.

The core managed-output planner records generated relative paths and SHA-256 values. The map adapter supplies a constrained output-path policy. Subsequent generation verifies prior content and removes obsolete recorded files through the shared atomic rewrite engine, before indexing the new memberships. Edited outputs, malformed inventories, duplicate paths and unsupported paths block regeneration. The manifest itself is included in the same transaction, and ordinary stale-source checks cover both it and the generated files. Unrelated authored files are retained.

The interpretation preview is mandatory evidence for uncertain artwork, not a guarantee of visual understanding. Ink, handwriting and paper seams can be mistaken for geography; a separately cleaned reference and reviewed semantic controls preserve the original while allowing corrections. An explicit reviewed label set excludes OCR names, including when that set is empty. Names stay separate from terrain pixels.

Failed generation emits failure/validation evidence without presenting the unchanged inherited world as a proposed world. Complete-world semantic diffs have an aggregate inline byte limit, preserving the response budget for counts and image links; full diffs remain content-addressed artifacts.

## Consequences

The MCP surface remains offline. Loading a world, advancing simulation, moving units and saving/reloading require separate user-authorized acceptance. A starter scenario does not supply authored politics, demographics or a balanced campaign. Public schema additions require the 4.1.0 minor release and regenerated schemas.

Synthetic regressions cover regeneration with fewer states, preservation of unrelated files, refusal of modified/invalid inventories, starter ownership and units, retained continent identifiers, native building records, lake speckles, failed-generation evidence and bounded diff responses.

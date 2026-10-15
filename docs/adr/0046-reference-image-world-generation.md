# ADR 0046: Reference images as inputs to atomic world generation

## Context

Creating a new map from artwork required agents to translate the entire coastline into polygon coordinates before calling the MCP server. Illustrated maps also contain terrain, river and label cues, but those cues can be ambiguous and large source images can exceed a practical analysis memory budget.

## Decision

Extend the existing `create_world` operation with an optional, strictly validated `reference` object. `reference.imagePath` alone is sufficient. Countries and dimensions become optional; reference worlds default to a vanilla-scale 5632 by 2048 output with aspect-preserving sea padding. Reference defaults use 12 provinces per state, 60 land or 30 sea provinces per strategic region and 80 requested rivers. Existing requests retain their explicit parameter behavior, and procedural requests retain their existing dimension, grouping and river defaults. This is an additive public feature requiring a minor semantic version update and regenerated schemas.

All inputs are raster files relative to the authorized writable mod root. The shared core loader uses workspace canonical-path resolution, an open source handle and before/after identity checks. It streams the verified open source handle into an exclusively created private snapshot and hashes those same chunks, then decodes that owned snapshot using sequential libvips reads and produces a bounded working PNG. Snapshot roots are canonical, protected and outside workspace capabilities, and cleanup runs on success, error and cancellation. This prevents an ABA pathname swap from introducing unauthorized pixels under the original source hash. Source bytes and decoded pixels have independent ceilings. The original file remains read-only. No URLs, arbitrary host paths, commands or game execution are accepted.

Extraction produces typed land/water, terrain, elevation, moisture, river and political fields. World generation consumes these through internal planning context; raster arrays do not enter public tool arguments or transaction manifests. Optional aligned political, terrain and height images and reviewed masks, city points and semantic labels refine uncertain interpretation. Offline English OCR offers confidence-filtered candidates, without promising correct interpretation of handwriting, arbitrary languages or decorative artwork. OCR runs first so recognized text bounds can be excluded from terrain classification; a warning makes the possible coastline smoothing explicit. Defaults and warnings keep an image-only request usable when political borders or semantic labels are uncertain.

The source's original hash and root identity become normal transaction read dependencies and artifact provenance. Transaction read-dependency checks now use the same fixed-memory hash path instead of loading every source into a full buffer. A stale or escaped reference blocks the existing all-or-nothing application.

Earth-scale maps can produce repeated warnings that exceed the journal's diagnostic ceiling. Repeated informational and warning codes are summarized with occurrence counts, deterministic samples and links to a complete bounded validation artifact, including the validator's exact omission counts. Errors, blockers and hard-diagnostic omission markers are preserved and continue to block application. Post-write validation uses the same warning rollup. Drainage review notes are reported as one counted diagnostic with five samples. A fresh mod without its own province bitmap retains inherited source dependencies but skips validation and rendering of the unrelated vanilla map as a baseline.

`hoi4.map_rewrite` accepts `preview: true`. It performs the same preparation and validation and returns content-addressed reference, terrain, political and comparison evidence, while skipping transaction preparation and application. The usual call applies the rewrite internally. No separate apply tool, transaction identifier, plan hash or rollback command is exposed.

## Consequences

The MCP server remains the product surface. Offline previews are generated evidence and cannot establish in-game rendering or campaign behavior. Installed terrain palettes and state categories continue to inform output through typed context shared with generation.

Artwork cannot determine demographics, economic balance, unmarked political borders or every handwritten name. Such values remain explicit generated assumptions, and reviewed controls can refine the result. Future interpretation improvements must retain deterministic behavior, bounds, provenance, canonical-path checks and negative tests.

CI uses original, synthetic imagery. Third-party source images and large local outputs are not committed as fixtures or included in the npm package. Architecture, schema and security tests cover image-only requests, bounds, malformed input, traversal, root escapes, principal isolation, cancellation and stale provenance.

# ADR 0005: Shared offline scene rendering

- Status: accepted
- Date: 2026-07-10

## Decision

Focus, GUI, and map renderers create deterministic scene data, canonical SVG/HTML/JSON, and PNG rasterizations through Sharp. Render profiles include source, asset, and font hashes; resolution; UI scale; scenario/state; schema and renderer versions; and deterministic layout inputs.

Every raster path uses the shared fixed render budget before Sharp, Buffer, or typed-array pixel allocation. Axes are limited to 16,384 pixels; generated artifacts to 50,331,648 pixels; decoded source textures to 16,777,216 pixels; and all charged variants in one request to 67,108,864 pixel units. The ceilings are deliberately not operator-tunable: public schemas reject products known at admission time, while source-derived and codec-derived violations return deterministic `RENDER_*_BLOCKED` service blockers. GUI decoded rasters and extracted frames share the request budget and are cached once per source/frame. Focus raster icons are metadata-validated once per distinct URI but charged once per rendered occurrence; distinct icon URIs also share a 67,108,864-character encoded ceiling and a 33,554,432-byte decoded-input ceiling.

## Rationale

An SVG-first layer supports source-linked annotations and exact vector inspection while producing real bitmap evidence. Browser screenshot rendering would add nondeterministic host/browser behavior and is unnecessary. The GUI renderer models parsed files offline and never controls the game.

## Consequences

HTML artifacts are inspectable documents with no mutation endpoint. They are not editors. Cross-platform byte equality is asserted only for the tested render profile; semantic geometry and pixel thresholds cover other supported platforms. Focus/GUI graph depth, node, edge, and pair-comparison work also has fixed ceilings so validation cannot turn a bounded render into unbounded recursive or quadratic work.

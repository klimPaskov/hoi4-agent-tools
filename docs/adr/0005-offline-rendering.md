# ADR 0005: Shared offline scene rendering

- Status: accepted
- Date: 2026-07-10

## Decision

Focus, GUI, and map renderers create deterministic scene data, canonical SVG/HTML/JSON, and PNG rasterizations through Sharp. Render profiles include source, asset, and font hashes; resolution; UI scale; scenario/state; schema and renderer versions; and deterministic layout inputs.

## Rationale

An SVG-first layer supports source-linked annotations and exact vector inspection while producing real bitmap evidence. Browser screenshot rendering would add nondeterministic host/browser behavior and is unnecessary. The GUI renderer models parsed files offline and never controls the game.

## Consequences

HTML artifacts are inspectable documents with no mutation endpoint. They are not editors. Cross-platform byte equality is asserted only for the tested render profile; semantic geometry and pixel thresholds cover other supported platforms.

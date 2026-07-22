# ADR 0014: Read-only Technology Tree Viewer

- Status: accepted
- Date: 2026-07-22

## Decision

Add technology and doctrine analysis as a fifth domain backed by the shared workspace resolver, Clausewitz source model, load-order handling, symbol index, diagnostics, artifact storage, caching, and deterministic rendering services. Keep the public surface compact:

- `hoi4.tech_inspect`, with `scan`, `folders`, `trace`, `explain`, `unlocks`, `bonus_coverage`, `lint`, and `impact` modes
- `hoi4.tech_render`
- `hoi4.tech_compare`

Technology identity remains separate from its folder-placement instances. Folder views use source coordinates and GUI gridbox geometry; dependency and semantic views are labelled as generated analysis. JSON is authoritative, and complete graphs, focused folder views, SVG, PNG, optional HTML, comparisons, diagnostics, and provenance use the existing MCP artifact resource.

All three tools are read-only. They do not generate technologies, rewrite source, score balance, simulate research, register MCP prompts, or launch the game. Dynamic and meta-generated references that cannot be proven remain explicit with confidence and blocker data.

## Rationale

Technology behavior is distributed across technology and doctrine definitions, folders, GUI geometry, categories, tags, unlock targets, bonuses, grants, history, localisation, sprites, and helper effects. One source-linked graph lets coding agents answer path, placement, unlock, reference, and patch-impact questions without duplicating parsers or loading a large tree into the prompt.

Three tools with focused modes preserve those capabilities while keeping the complete sixteen-tool discovery response below the fixed 32 KiB budget. Large renders use a bounded overview and per-folder resources, so graphs with more than 1,000 technologies remain queryable and visually reviewable.

## Consequences

The public package advances to version 2.2.0 and exposes sixteen tools. CI includes a project-owned 1,040-technology, 13-folder fixture with classic and current doctrines, exclusive branches, multiple placements, unlock targets, bonuses, grants, assets, deliberate defects, and expected graph and reference manifests. Acceptance covers exact reconstruction, provenance, diagnostics, comparison, stable rendering, cancellation, resource retrieval, incremental indexing, both transports, package installation, and official MCP Inspector workflows.

Opt-in local tests read installed vanilla and an external mod without copying or changing their files. Unsupported static-analysis cases remain visible rather than being replaced with guessed runtime behavior.

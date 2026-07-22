# Technology trees

The Technology Tree Viewer reconstructs classic technologies, legacy doctrine technologies, and current doctrine definitions across the active mod, configured dependencies, and vanilla sources. It links prerequisites, folder placements, exclusive choices, categories, tags, unlocks, bonuses, grants, localisation, icons, and AI metadata without launching the game.

Use the three technology tools directly from the target mod.

## Inspect

`hoi4.tech_inspect` provides eight focused modes:

- `scan`: build the complete technology graph and report its inventory, diagnostics, analysis limits, and revision.
- `folders`: list folder roots and source placements, or inspect one `folderId`.
- `trace`: follow prerequisites, descendants, or both from a `technologyId` with bounded depth and node limits.
- `explain`: collect one technology's definition, placements, paths, exclusivity, metadata, effects, unlocks, grants, bonuses, and unresolved references.
- `unlocks`: filter unlock relationships by technology, target kind, or target ID.
- `bonus_coverage`: show which technologies or categories are covered by discovered research bonuses.
- `lint`: filter source-linked findings by classification, diagnostic code, folder, or technology.
- `impact`: find the definitions, placements, edges, grants, bonuses, unlocks, localisation, sprites, and files affected by a proposed removal or rename.

Example trace:

```json
{
  "mode": "trace",
  "technologyId": "infantry_weapons",
  "direction": "both",
  "maxDepth": 12,
  "maxNodes": 2000
}
```

Impact mode takes a subject with `kind` set to `technology`, `category`, `folder`, or `unlock_target`. A rename also requires `replacementId`:

```json
{
  "mode": "impact",
  "impact": {
    "kind": "technology",
    "id": "old_technology",
    "operation": "rename",
    "replacementId": "new_technology"
  }
}
```

Findings are separated into confirmed errors, probable defects, design warnings, and unresolved analysis. Roots, grant-only technologies, early dates, zero AI weights, repeated effects, and routing nodes are evaluated in context instead of being treated as automatic defects.

## Render

`hoi4.tech_render` returns authoritative JSON with deterministic SVG and PNG resources; set `includeHtml` when a bundled static report is useful. Available views are `summary`, `folder`, `dependencies`, `technology`, `doctrine`, `exclusive`, `memberships`, `bonuses`, `grants`, `unlocks`, `metadata`, `assets`, and `unresolved`.

Folder renders use the actual folder assignments, gridbox geometry, and technology coordinates found in source. Dependency and other semantic views are explicitly labelled as generated analysis layouts. Missing sprites, textures, or localisation remain identifiable from JSON and vector output even when no icon raster is decoded.

Example folder render:

```json
{
  "view": "folder",
  "folderId": "infantry_folder",
  "maxNodes": 1000,
  "includeHtml": false
}
```

Large dependency requests return a bounded overview plus focused folder resources and a coverage manifest. The graph itself is not truncated: use the manifest and linked `hoi4-agent://` resources to inspect the relevant folder or branch without loading the entire system into the prompt.

## Compare

`hoi4.tech_compare` compares cached revisions, graph resources, current source, or proposed in-memory source overlays. It reports added, removed, renamed, or moved technologies; graph and placement changes; metadata, category, tag, unlock, grant, bonus, localisation, and icon changes; introduced and resolved findings; and newly reachable or disconnected content.

`before` and `after` each accept `{ "revision": "<sha256>" }` or `{ "artifactUri": "hoi4-agent://..." }`. Proposed overlays take `{ relativePath, source, expectedSourceHash? }`; use `source: null` to model deletion. Overlays are analyzed without writing them.

```json
{
  "proposedSources": [
    {
      "relativePath": "common/technologies/example.txt",
      "source": "technologies = { example_tech = { start_year = 1936 } }\n"
    }
  ],
  "render": true,
  "maxRenderNodes": 500
}
```

## Agent workflow

For an unfamiliar technology system, an agent can scan it, discover folders, trace or explain the relevant path, render only the needed views, edit Clausewitz source through its normal repository workflow, and compare the result. The same graph and revision back every query and artifact, so folder placement, dependency structure, unlock impact, and cross-file references stay aligned.

This is static analysis. Exact runtime research time, AI choices, balance, arbitrary dynamic grants, and unsupported visibility behavior are not inferred. Dynamic expressions remain in the results with their confidence and blockers, and no destination is invented.

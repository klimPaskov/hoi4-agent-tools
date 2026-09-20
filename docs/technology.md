# Technology trees

The Technology Tree Viewer reconstructs classic technologies, legacy doctrine technologies, and current doctrine definitions across the active mod, configured dependencies, and vanilla sources. It links prerequisites, folder placements, exclusive choices, categories, tags, unlocks, bonuses, grants, localisation, icons, and AI metadata without launching the game.

Use the three technology tools directly from the target mod.

## Inspect

`hoi4.tech_inspect` provides nine focused modes:

- `scan`: build the technology graph and report its inventory, diagnostics, analysis limits, and revision. Small graphs include the complete graph in the report; large graphs return exact counts, grouped findings, samples, and the revision for focused follow-up queries.
- `folders`: list folder roots and source placements, or inspect one `folderId`.
- `trace`: follow prerequisites, descendants, or both from a `technologyId` with bounded depth and node limits.
- `explain`: collect one technology's definition, placements, paths, exclusivity, metadata, effects, unlocks, grants, bonuses, and unresolved references.
- `unlocks`: filter unlock relationships by technology, target kind, or target ID.
- `bonus_coverage`: show which technologies or categories are covered by discovered research bonuses.
- `lint`: filter source-linked findings by classification, diagnostic code, folder, or technology.
- `impact`: find the definitions, placements, edges, grants, bonuses, unlocks, localisation, sprites, and files affected by a proposed removal or rename.
- `helper_expansion`: stream source-linked scripted-effect call paths and helper-owned technology references with bounded pages and revision-bound continuation.

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

Findings are separated into confirmed errors, probable defects, design warnings, and unresolved analysis. Roots, grant-only technologies, early dates, zero AI weights, repeated effects, and routing nodes are evaluated in context instead of being treated as automatic defects. The viewer keeps its authoritative graph in memory while the linked scan artifact remains a bounded summary; use its revision with the focused inspect modes or a render resource to inspect the relevant records.

Ordinary technology inspection uses the materialized graph and its explicit helper-depth and projection limits.
Workspaces with a game root, more than 1,000 scanned files, or more than 4,096 helper calls retain direct references and expose deferred helper expansion as incomplete coverage; `helper_expansion` pages provide bounded paths for those workspaces.
A truncated helper expansion reports incomplete coverage.
For a large helper closure, [bounded helper expansion](helper-expansion.md) uses the structural call inventory and streams source-linked paths without first materializing the full projection.
It preserves separate conditional call sites and identifies source, cycle, and depth boundaries without simulating trigger outcomes.

## Render

`hoi4.tech_render` returns authoritative JSON with deterministic SVG and PNG resources; set `includeHtml` when a bundled static report is useful. Folder renders read the actual `techtree_<folder>_item` and `techtree_<folder>_small_item` geometry, choose the small item for technologies that do not unlock equipment or explicitly force it, and place the source GUI's year labels. Available views are `summary`, `folder`, `dependencies`, `technology`, `doctrine`, `exclusive`, `memberships`, `bonuses`, `grants`, `unlocks`, `metadata`, `assets`, and `unresolved`.

Folder renders use folder assignments, gridbox geometry, technology coordinates, and item dimensions found in source. File-local `@` constants in technology coordinates are resolved before placement. A technology with multiple prerequisite roots can use its own declared gridbox. The item template supplies its unavailable, available, or researched skin, icon center, name position, and design-team icon position when the corresponding sprites resolve. `sub_technology_slot_<index>` geometry positions each declared subtechnology icon; a missing slot stays visible as unresolved placement metadata. The folder's tiled panel sprite fills the canvas, and source `*_techtree_bg` sprites render behind technology nodes at their declared GUI positions; when the GUI omits a sprite size, the decoded dimensions supply it. Year labels retain their source font, box dimensions, alignment, orientation, and colour declarations in the graph. Sprite declarations and texture files resolve through the active load order across the mod, configured dependencies, and the detected or configured game installation. The authoritative JSON and SVG expose `layoutSize`, rendered sprite coverage, and unresolved sprite names without embedding image data in JSON. `sourceAccurate` describes source pixel placement only; it is not a percentage of visual agreement with a game screenshot. The game may change the visibility of design-team icons and status corners at runtime. Dependency and other semantic views are labelled as generated analysis layouts.

A `small` 72-pixel item can still display its source `GFX_*_medium` artwork at full card size; the layout name does not select smaller icon art.

Example folder render:

```json
{
  "view": "folder",
  "folderId": "infantry_folder",
  "maxNodes": 1000,
  "includeHtml": false
}
```

Pass `scenario: { "year": 1936, "researchedTechnologyIds": ["infantry_weapons"] }` to `hoi4.tech_render` to display known researched technologies, exclusive conflicts, and missing source prerequisites. Folder renders select the corresponding item skin when its sprite is available. The JSON lists the missing prerequisite IDs and years ahead of the scenario date for each displayed technology. A `structural_candidate` status means the supplied research set has no known structural blocker; country conditions and other dynamic requirements remain unresolved. Unknown researched IDs are rejected.

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

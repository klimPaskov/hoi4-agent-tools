# Focus trees

Use `hoi4.focus_inspect`, `hoi4.focus_render`, `hoi4.focus_raster`, and `hoi4.focus_rewrite` for national focus trees and continuous focus palettes.

## Create a tree

A complete plan should include:

- tree ID and country assignment;
- branch and lane groups;
- exact prerequisites and mutual exclusions;
- availability, visibility, bypass, and route locks;
- rewards and links to decisions, events, ideas, characters, or scripted helpers;
- focus positions, convergence points, and shared support branches;
- titles, descriptions, icons, filters, and AI behavior.

The `plan` argument of `hoi4.focus_rewrite` follows [focus-plan.schema.json](../schemas/focus-plan.schema.json).
The easiest starting point for an existing tree is the imported plan in the `plans` array of the JSON artifact returned by `hoi4.focus_inspect`.
A minimal plan that creates a two-focus tree looks like this:

```json
{
  "relativePath": "common/national_focus/my_focus_tree.txt",
  "treeId": "my_focus_tree",
  "createIfMissing": true,
  "plan": {
    "schemaVersion": 1,
    "id": "my_focus_tree",
    "countryAssignment": {
      "raw": {
        "text": "{ factor = 0 modifier = { add = 10 tag = AAA } }",
        "referencedFocusIds": []
      },
      "countryTags": ["AAA"]
    },
    "default": false,
    "branchGroups": [],
    "laneGroups": [],
    "entryFocusIds": ["my_root_focus"],
    "focuses": [
      {
        "id": "my_root_focus",
        "label": "Root focus",
        "prerequisites": { "operator": "and", "groups": [] },
        "mutuallyExclusive": [],
        "routeLocks": [],
        "position": { "mode": "fixed", "x": 0, "y": 0, "pinned": false },
        "visibility": "normal",
        "convergence": false,
        "sharedSupport": false,
        "icons": [{ "kind": "static", "sprite": "GFX_goal_generic_political_pressure" }],
        "localisation": { "titleKey": "my_root_focus", "descriptionKey": "my_root_focus_desc" },
        "ai": {
          "raw": { "text": "{ factor = 1 }", "referencedFocusIds": [] },
          "majorRoute": false,
          "strategyIds": []
        },
        "filters": ["FOCUS_FILTER_POLITICAL"],
        "links": [],
        "cost": 10,
        "completionReward": { "text": "{ add_political_power = 50 }", "referencedFocusIds": [] },
        "rawPassthrough": []
      },
      {
        "id": "my_second_focus",
        "label": "Second focus",
        "prerequisites": {
          "operator": "and",
          "groups": [{ "operator": "or", "focusIds": ["my_root_focus"], "rawPassthrough": [] }]
        },
        "mutuallyExclusive": [],
        "routeLocks": [],
        "position": {
          "mode": "relative",
          "x": 0,
          "y": 1,
          "relativeTo": "my_root_focus",
          "pinned": false
        },
        "visibility": "normal",
        "convergence": false,
        "sharedSupport": false,
        "icons": [{ "kind": "static", "sprite": "GFX_goal_generic_construct_civ_factory" }],
        "localisation": { "titleKey": "my_second_focus", "descriptionKey": "my_second_focus_desc" },
        "ai": {
          "raw": { "text": "{ factor = 1 }", "referencedFocusIds": [] },
          "majorRoute": false,
          "strategyIds": []
        },
        "filters": ["FOCUS_FILTER_INDUSTRY"],
        "links": [],
        "cost": 10,
        "completionReward": {
          "text": "{ add_tech_bonus = { bonus = 0.5 uses = 1 category = industry } }",
          "referencedFocusIds": []
        },
        "rawPassthrough": []
      }
    ],
    "sharedFocusIds": [],
    "continuousFocusPaletteIds": [],
    "continuousFocusIds": [],
    "rawPassthrough": [],
    "provenance": {
      "sourcePath": "plan:my_focus_tree",
      "sourceHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "importedPlanHash": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  }
}
```

Raw blocks such as `countryAssignment.raw`, `ai.raw`, and `completionReward` hold the Clausewitz block text including its braces; the rewrite writes it after the matching key.
Each `prerequisites.groups` entry is one `prerequisite` block whose `focusIds` are alternatives.
`provenance` must be present: an imported plan carries the hashes of the source it came from, and a plan for a new tree may use 64-character hexadecimal placeholders as shown.
When `treeId` is also supplied, it must equal `plan.id`.

For a missing target, call `hoi4.focus_rewrite` with `createIfMissing: true`. Review the proposed and final artifacts returned by the rewrite, then inspect and render the result. Call `hoi4.focus_raster` when the review needs decoded source icons and a deterministic PNG. Do not call a tree complete with placeholder rewards, missing localisation, missing icons, or absent AI choices.

## Clean an existing tree

For a layout-only cleanup of an existing national tree, call `hoi4.focus_rewrite` without a plan:

```json
{
  "relativePath": "common/national_focus/my_tree.txt",
  "treeId": "my_tree",
  "layoutMode": "compact"
}
```

A plan-free call is accepted only in national mode with `layoutMode: "compact"`.
It requires `treeId`, works on an existing focus source, and rejects `createIfMissing: true`.
Every other national rewrite requires a `plan`.
`compactFocusIds` (1 to 10,000 IDs), `pinnedFocusIds` (up to 10,000 IDs), and `symmetryGroups` (up to 64 groups) are accepted only with `layoutMode: "compact"`.

Compact mode imports the tree, resets authored presentation coordinates and lane bounds, and performs a deterministic reflow in the same rewrite call. It keeps prerequisites, mutual exclusions, availability, bypasses, rewards, icons, localisation, AI behavior, and route/lane membership unchanged.

The rewrite measures canvas bounds, same-row spacing, the same curved connector paths used by the renderer, connector lengths, connector-node intersections, branch balance, overall centering, and topology-aware fake-complexity patterns. Compact mode evaluates preservation, occupied-row repair, prerequisite-depth reflow, linear-chain repair, sibling balancing, and combined compression strategies, then chooses the cleanest valid result. Equivalent branches are aligned by dependency depth even when their authored rows differ, and connector shape is prioritized before raw canvas dimensions so a shorter canvas cannot win by introducing unnecessary horizontal detours. Sparse direct sibling fan-outs are packed around their parent at the minimum readable spacing, with each exclusive descendant branch moving as a unit and shared convergence focuses staying centered. Dense branches remain wider only when their contents need the room. It refuses invalid geometry such as overlapping or cramped focuses, bad parent order, rendered crossings, connectors through unrelated focuses, or an off-center canvas. Long connectors, fake detours, staircase or zigzag chains, and avoidable sibling imbalance are optimization priorities instead of independent rejection budgets.

Use the default `layoutMode: "authored"` with a complete plan when deliberately designing coordinates or changing gameplay. Set `layoutMode: "compact"` with a complete plan when creating a large automatically arranged tree. Inspect and render calls remain useful before or after either rewrite mode, but a separate plan is not required for compact cleanup.

For a bounded layout repair, set `compactFocusIds` to the focus IDs whose positions may change and `pinnedFocusIds` to anchors that must keep their current coordinates. The compact planner preserves the positions and coordinates of every focus outside the selection and leaves gameplay fields untouched. It evaluates candidate layouts against the current tree and reports a constraint error if the selected repair cannot preserve those anchors without worsening connector or spacing defects.

Pass `symmetryGroups` with a `centerFocusId` and one or more `{ "leftFocusId": "...", "rightFocusId": "..." }` pairs to `hoi4.focus_rewrite` in compact mode when named branches should align at equal distance and row around a center focus. A pair may contain a pinned or unselected focus; incompatible fixed positions produce a conflict with the specific pair and offsets.

A cleanup should not change gameplay relationships to improve the picture. One `prerequisite` block containing several focus IDs is an OR group; several prerequisite blocks are AND requirements.

## Continuous focus palettes

Set `mode: "continuous"` on `hoi4.focus_inspect`, `hoi4.focus_render`, or `hoi4.focus_rewrite` to work with a `continuous_focus_palette` instead of a national tree; the default mode is `national`.

- `hoi4.focus_inspect` and `hoi4.focus_render` select one palette with `paletteId`.
  Without it, inspection includes every palette in the selected source, and rendering requires the source to contain exactly one palette.
  The inspection JSON artifact lists the imported palette plans in `continuousFocusPalettes`.
- `treeId` is rejected in continuous mode.
  Inspection also rejects `previous`, `laneSpacing`, `nodeSpacing`, and `scenario`, and rendering rejects `horizontalSpacing`, `verticalSpacing`, `reviewScale`, and `cropFocusIds`.
- Rendering accepts `columns` (1 to 12) only in continuous mode, and continuous `padding` must be at least 24 pixels.
- `hoi4.focus_rewrite` requires a `plan` that matches [continuous-focus-palette.schema.json](../schemas/continuous-focus-palette.schema.json); the palette is identified by `plan.id`, and the rewrite has no `paletteId` field.
  `layoutMode` must stay `authored`, and `horizontalSpacing`, `verticalSpacing`, `padding`, and `reviewScale` are rejected.
- A palette needs a mod-owned source.
  Creating a palette with `createIfMissing: true` requires a new source file, so an unrelated existing file is never repurposed.

## Layout metadata and unsupported script

Branch names, lane assignments, working labels, and other planning-only data may be stored in a `.focus-plan.json` file beside the focus source. HOI4 does not load that file.

If malformed or unsupported script makes a requested change ambiguous, the rewrite stops and explains the blocker instead of guessing.

## What inspection checks

Inspection and rendering can report missing references, invalid prerequisite structure, duplicate or overlapping positions, insufficient spacing, long or crossing connectors, branch asymmetry, route conflicts, missing localisation or sprites, weak terminal branches, repeated rewards, and missing AI metadata. National-tree inspection also returns the exact `continuous_focus_position` coordinates and linked palette IDs in its compact result, so an agent can identify and move the continuous-focus area without opening the full artifact. Renders are offline review artifacts, not game screenshots.

For a named tree, pass `scenario: { "completedFocusIds": ["my_route_root"] }` to `hoi4.focus_inspect`. The linked inspection artifact records each focus's prerequisite groups, route locks, exclusive choices, and unresolved runtime fields against that completed set. The inline tree summary counts completed, blocked, unresolved, and structural candidate focuses, plus contradictory completed choices. A structural candidate still requires runtime trigger evaluation before an agent can call it playable.

Pass up to 16 `cropFocusIds` to `hoi4.focus_raster` for source-linked problem crops around specific focuses. Each crop uses the same rendered pixels as the full tree; a JSON manifest records the focus ID, crop bounds, image hash, and diagnostics. An unknown focus ID is reported explicitly.

The layout JSON reports horizontal, vertical, and Manhattan grid spans for every prerequisite connector in `layout.connectorMeasurements`.

`hoi4.focus_render` is the normal structural view and writes complete HTML, SVG, JSON, and source-map artifacts without decoding every icon or creating a PNG. `hoi4.focus_raster` adds decoded icons and the high-fidelity PNG. National trees with 200 or more focuses raster at half scale by default; pass `reviewScale` from `0.25` through `1` when a different PNG size is needed.

The public workflow is regression-tested with 1,024-focus creation, compact rewrites, deterministic repeat runs, inspection, vector rendering, and raster rendering. A separate 1,024-icon test decodes a distinct texture for every focus. Large source diffs use the same deterministic review-artifact path instead of blocking at the quadratic matrix size.

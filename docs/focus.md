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

Compact mode imports the tree, resets authored presentation coordinates and lane bounds, and performs a deterministic reflow in the same rewrite call. It keeps prerequisites, mutual exclusions, availability, bypasses, rewards, icons, localisation, AI behavior, and route/lane membership unchanged.

The rewrite measures canvas bounds, same-row spacing, the same curved connector paths used by the renderer, connector lengths, connector-node intersections, branch balance, overall centering, and topology-aware fake-complexity patterns. Compact mode evaluates preservation, occupied-row repair, prerequisite-depth reflow, linear-chain repair, sibling balancing, and combined compression strategies, then chooses the cleanest valid result. Equivalent branches are aligned by dependency depth even when their authored rows differ, and connector shape is prioritized before raw canvas dimensions so a shorter canvas cannot win by introducing unnecessary horizontal detours. Sparse direct sibling fan-outs are packed around their parent at the minimum readable spacing, with each exclusive descendant branch moving as a unit and shared convergence focuses staying centered. Dense branches remain wider only when their contents need the room. It refuses invalid geometry such as overlapping or cramped focuses, bad parent order, rendered crossings, connectors through unrelated focuses, or an off-center canvas. Long connectors, fake detours, staircase or zigzag chains, and avoidable sibling imbalance are optimization priorities instead of independent rejection budgets.

Use the default `layoutMode: "authored"` with a complete plan when deliberately designing coordinates or changing gameplay. Set `layoutMode: "compact"` with a complete plan when creating a large automatically arranged tree. Inspect and render calls remain useful before or after either rewrite mode, but a separate plan is not required for compact cleanup.

For a bounded layout repair, set `compactFocusIds` to the focus IDs whose positions may change and `pinnedFocusIds` to anchors that must keep their current coordinates. The compact planner preserves the positions and coordinates of every focus outside the selection and leaves gameplay fields untouched. It evaluates candidate layouts against the current tree and reports a constraint error if the selected repair cannot preserve those anchors without worsening connector or spacing defects.

Pass `symmetryGroups` with a `centerFocusId` and one or more `{ "leftFocusId": "...", "rightFocusId": "..." }` pairs to `hoi4.focus_rewrite` in compact mode when named branches should align at equal distance and row around a center focus. A pair may contain a pinned or unselected focus; incompatible fixed positions produce a conflict with the specific pair and offsets.

A cleanup should not change gameplay relationships to improve the picture. One `prerequisite` block containing several focus IDs is an OR group; several prerequisite blocks are AND requirements.

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

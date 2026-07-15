# Focus trees

Use `hoi4.focus_inspect`, `hoi4.focus_render`, and `hoi4.focus_rewrite` for national focus trees and continuous focus palettes. Omit `workspaceId` when the MCP working directory is inside the target mod.

## Create a tree

A complete plan should include:

- tree ID and country assignment;
- branch and lane groups;
- exact prerequisites and mutual exclusions;
- availability, visibility, bypass, and route locks;
- rewards and links to decisions, events, ideas, characters, or scripted helpers;
- focus positions, convergence points, and shared support branches;
- titles, descriptions, icons, filters, and AI behavior.

For a missing target, call `hoi4.focus_rewrite` with `createIfMissing: true`. Review the proposed and final artifacts returned by the rewrite, then inspect and render the result. Do not call a tree complete with placeholder rewards, missing localisation, missing icons, or absent AI choices.

## Clean an existing tree

For a layout-only cleanup of an existing national tree, call `hoi4.focus_rewrite` without a plan:

```json
{
  "workspaceId": "my-mod",
  "relativePath": "common/national_focus/my_tree.txt",
  "treeId": "my_tree",
  "layoutMode": "compact"
}
```

Compact mode imports the tree, resets authored presentation coordinates and lane bounds, and performs a deterministic reflow in the same rewrite call. It keeps prerequisites, mutual exclusions, availability, bypasses, rewards, icons, localisation, AI behavior, and route/lane membership unchanged.

The rewrite measures canvas bounds, same-row spacing, the same curved connector paths used by the renderer, connector lengths, connector-node intersections, branch balance, and overall centering. A bounded refinement pass moves automatic gateways and blockers only when the measured connector result improves. The rewrite refuses changes with close focuses, rendered crossings, excessive branch imbalance, an off-center canvas, or connector and size metrics outside absolute and source-relative limits.

Use the default `layoutMode: "authored"` with a complete plan when deliberately designing coordinates or changing gameplay. Set `layoutMode: "compact"` with a complete plan when creating a large automatically arranged tree. Inspect and render calls remain useful before or after either rewrite mode, but a separate plan is not required for compact cleanup.

A cleanup should not change gameplay relationships to improve the picture. One `prerequisite` block containing several focus IDs is an OR group; several prerequisite blocks are AND requirements.

## Layout metadata and unsupported script

Branch names, lane assignments, working labels, and other planning-only data may be stored in a `.focus-plan.json` file beside the focus source. HOI4 does not load that file.

If malformed or unsupported script makes a requested change ambiguous, the rewrite stops and explains the blocker instead of guessing.

## What inspection checks

Inspection and rendering can report missing references, invalid prerequisite structure, duplicate or overlapping positions, insufficient spacing, long or crossing connectors, branch asymmetry, route conflicts, missing localisation or sprites, weak terminal branches, repeated rewards, and missing AI metadata. Renders are offline review artifacts, not game screenshots.

National trees with 200 or more focuses render review PNGs at half scale by default so large agent workflows stay responsive. Pass an explicit `reviewScale` from `0.25` through `1` when a different raster size is needed; HTML, SVG, JSON, layout, and diagnostics remain complete.

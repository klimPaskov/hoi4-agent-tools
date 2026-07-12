# Focus trees

Use `hoi4.focus_inspect`, `hoi4.focus_render`, and `hoi4.focus_rewrite` for national focus trees and continuous focus palettes. Start with `hoi4.mods` when the mod ID is not known.

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

1. Inspect the tree and read its diagnostics.
2. Render the current layout before changing coordinates.
3. Keep prerequisites, mutual exclusions, availability, bypasses, rewards, icons, localisation, and AI behavior unless the task explicitly changes them.
4. Group branches and lanes by their gameplay role. Existing coordinates remain fixed until movable focuses are marked for automatic placement; keep only deliberate anchors fixed.
5. Submit the complete plan to `hoi4.focus_rewrite` and review its proposed layout for overlaps, connector crossings, branch spacing, and route readability.
6. Inspect and render the result.

A cleanup should not change gameplay relationships to improve the picture. One `prerequisite` block containing several focus IDs is an OR group; several prerequisite blocks are AND requirements.

## Layout metadata and unsupported script

Branch names, lane assignments, working labels, and other planning-only data may be stored in a `.focus-plan.json` file beside the focus source. HOI4 does not load that file.

If malformed or unsupported script makes a requested change ambiguous, the rewrite stops and explains the blocker instead of guessing.

## What inspection checks

Inspection and rendering can report missing references, invalid prerequisite structure, duplicate or overlapping positions, route conflicts, missing localisation or sprites, weak terminal branches, repeated rewards, and missing AI metadata. Renders are offline review artifacts, not game screenshots.

National trees with 200 or more focuses render review PNGs at half scale by default so large agent workflows stay responsive. Pass an explicit `reviewScale` from `0.25` through `1` when a different raster size is needed; HTML, SVG, JSON, layout, and diagnostics remain complete.

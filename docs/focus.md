# Focus trees

Build focus trees, arrange branches and preview the result.
Use `hoi4.focus_inspect`, `hoi4.focus_render` and `hoi4.focus_rewrite` for national focus trees and continuous-focus palettes.

## Create a tree

The agent assembles the tree from your request. For a direct API call, the `plan` argument should include:

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

For a missing target, call `hoi4.focus_rewrite` with `createIfMissing: true`. Review the proposed and final artifacts returned by the rewrite, then inspect and render the result. `hoi4.focus_render` returns a deterministic PNG with decoded source icons. Do not call a tree complete with placeholder rewards, missing localisation, missing icons, or absent AI choices.

## Layout quality

A tree can be structurally correct and still look wrong: a main line that steps one column left on every row, one branch floating off in a corner, half the canvas empty. Structure and layout are separate questions, so every `hoi4.focus_inspect` and `hoi4.focus_rewrite` result carries a **layout verdict** next to the structural answer. `validation.passed` stays the structural answer; the check `focus-layout-verdict` carries the layout one. "Structure ok" never means the layout is good.

| Verdict   | Meaning                                                                                                                        | What to do                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `pass`    | Every calibrated metric lies inside the range of the installed game's own trees.                                               | Look at the render anyway: metrics cannot see composition.               |
| `review`  | A metric leaves the vanilla range, or a design flag is raised. Advisory.                                                       | Look at `hoi4.focus_render` and decide whether it is intended.           |
| `revise`  | A metric is far outside the vanilla range, or five or more are outside it.                                                     | The tree is not finished. Repair the failing branch, then inspect again. |
| `blocked` | A hard defect: two focuses on one coordinate, a prerequisite that is not above its dependant, or plaques that overlap in game. | Fix the defect first. Hand-typed coordinates are the usual cause.        |

The result also carries a **scorecard** (at most 12 rows inline, the full list in the linked artifact), a fix for each failing row (`fix.action`, `fix.targetFocusIds`, `fix.suggested`, `fix.expectedMetricChange`, `fix.preservesGameplay`), `nextActions`, and `notEvaluated`, which always names what the tool cannot judge: gameplay and balance, visual review, and in-game connector geometry. A tree below 8 focuses gets only the hard-defect checks, and a tree below 40 focuses is never asked to `revise` because vanilla has too few small trees to set a limit.

### Metrics

| Id     | What it measures                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| H1     | Focuses on the same coordinate. Branches that are never visible together (`allow_branch`, hidden, or below a conditional focus) may share one. |
| H2     | A prerequisite that is not on an earlier row than its dependant.                                                                               |
| H3     | Plaques closer than their own width (about 1.6 columns) on one row; the game's minimum spacing is 2.                                           |
| H4     | Connector stems that run through an unrelated plaque, per 100 links. Advisory.                                                                 |
| H5     | Stems that cross the bar of an unrelated connector, per 100 links. Advisory.                                                                   |
| S1     | Largest empty rectangle as a fraction of the canvas.                                                                                           |
| S2, S3 | Side balance (focuses left against right of the centre column) and mass skew (mean column against the centre).                                 |
| S4     | Fill ratio: focuses over the cells of the bounding box. Low is bad.                                                                            |
| S5     | Row-centroid wander: how far the centre of each row drifts, as a fraction of the width.                                                        |
| S6     | Single-focus chains that jog sideways, per 100 links.                                                                                          |
| S7     | Sibling subtrees that share columns on the same rows, as a fraction of sibling pairs.                                                          |
| S8     | Largest distance between a fan-out's centre and its parent, in columns. Shown, never part of the verdict.                                      |
| S9     | Unrelated connectors that share a bar or stem, per 100 links. Advisory.                                                                        |
| S10    | Largest gap in rows between a focus and the row after its lowest prerequisite.                                                                 |
| S11    | Sibling groups whose members sit on different rows.                                                                                            |
| D1, D2 | Longest run of single-successor focuses, and the fraction of leaves.                                                                           |
| D3, D4 | Exclusive choices that rejoin six or more rows later, and a canvas taller than 2.5 rows per plaque column.                                     |

The limits of S1 to S11, H4, H5, D1 and D2 are computed from the installed game's national focus trees (67 trees of 8 or more focuses, in two size buckets: 40 to 120 and over 120 focuses) and stored as derived numbers in `src/hoi4_agent_tools/focus/quality/focus-quality-calibration.json`. `review` starts at the edge of the vanilla range; `revise` starts a margin beyond it. H4, H5 and S9 can raise a tree to `review` at most until the connector model below is confirmed in the game. Design flags (D1 to D4) are proxies for the question "does the player choose anything?" and always go to a person: the tool never changes prerequisites, rewards or names for them.

`npm run focus:calibrate -- --write` recomputes the file from the installed game. The local test `tests/local/focus-quality-calibration.test.ts` recomputes it whenever the game is found and fails when the stored file differs. `npm run focus:calibrate -- --report` prints how often an unseen vanilla-quality tree is flagged: about 82 percent `pass`, 15 percent `review` and 3 percent `revise` with the limits fitted without that tree.

### Connector model

The game draws right-angle connectors: a stem leaves the parent, a horizontal bar runs in the gap above the child's row, and a stem enters the child. Crossings, connector-through-plaque and shared-bar counts use that model, not the curved connector of the icon render, which over-reported crossings by a factor of nine on vanilla trees. All connectors between the parents and children of an **all-to-all bundle** (two or more parents that are each a prerequisite of the same two or more children) share one bar in the game and are never counted against each other, and neither are the members of an OR group. The model was read from one in-game screenshot for adjacent rows; multi-row bar placement is unverified, so confirm it with a screenshot of a multi-row connector before treating H4, H5 or S9 as defects.

`FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED`, `FOCUS_AVOIDABLE_CONNECTOR_CROSSING` and `FOCUS_LAYOUT_CONNECTOR_THROUGH_NODE` come from the curved model and are no longer shown in inspect and render results; the linked artifact keeps them.

### Workflow for an agent

1. Establish the design: purpose, route families, the choices the player makes.
2. Write a lane plan: ordered branches (`branchGroups`, `laneGroups`) with their intended width and where they rejoin.
3. Define prerequisites, exclusive choices and convergence.
4. Place with `position.mode: "auto"` so the solver centres, spaces and balances the branches. Hand-written `x` and `y` are for exact anchors only; hand-typed coordinates are the usual cause of drift and lopsided branches.
5. `hoi4.focus_render` and look at the inline overview and crops.
6. Read the scorecard and answer: can every branch be named from the picture, and is every asymmetry intended?
7. Revise one failing branch at a time with `layoutMode: "compact"`, `compactFocusIds` and `pinnedFocusIds`; pass the previous layout as `previous` to `hoi4.focus_inspect` to get the `layoutDelta`.
8. Validate structure and gameplay.
9. Show the before and after pictures and the scorecard to a person when the project asks for it.
10. Check the tree in the game.

`layoutDelta` reports `verdictBefore` and `verdictAfter`, the scores, the metrics that improved and regressed, the moved focuses, a hash of the focuses that did not move (`unmovedHash`), and hashes of the prerequisites and exclusions with `prerequisitesUnchanged` and `mutualExclusionsUnchanged`, so a layout repair can prove that it changed coordinates only.

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

The rewrite measures canvas bounds, same-row spacing, the same curved connector paths used by the renderer, connector lengths, connector-node intersections, branch balance, overall centering, and topology-aware fake-complexity patterns. Compact mode evaluates preservation, occupied-row repair, prerequisite-depth reflow, linear-chain repair, sibling balancing, and combined compression strategies, then chooses the cleanest valid result. Equivalent branches are aligned by dependency depth even when their authored rows differ, and connector shape is prioritized before raw canvas dimensions so a shorter canvas cannot win by introducing unnecessary horizontal detours. Sparse direct sibling fan-outs are packed around their parent at the minimum readable spacing, with each exclusive descendant branch moving as a unit and shared convergence focuses staying centered. Dense branches remain wider only when their contents need the room. A candidate must not be worse than the layout in place: no more hard layout errors, same-row spacing violations, crossings or connector-through-plaque counts in the in-game connector model (see [Layout quality](#layout-quality)), no worse layout verdict, and a centred canvas unless the tree already was not. A new tree starts from zero. When no candidate qualifies, or the layout already has the verdict `pass`, the call changes nothing and says why (`compactOutcome` with `reason` `verdict_pass`, `no_better_candidate` or `candidates_regress` and `blockedBy`, and the info diagnostic `FOCUS_COMPACT_NOTHING_TO_IMPROVE`); the first rewrite of a tree still writes its planning sidecar. A refusal of a new tree (`FOCUS_COMPACT_QUALITY_BLOCKED`) lists each blocking item in `details.blocking` with its before and after value and a remedy. Long connectors, fake detours, staircase or zigzag chains, and avoidable sibling imbalance are optimization priorities instead of independent rejection budgets.

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

### Stale source and source encoding

A rewrite starts from a plan returned by `hoi4.focus_inspect`. If the source file changed in meaning after that inspection, `hoi4.focus_rewrite` refuses with `FOCUS_SOURCE_CHANGED_SINCE_PLAN` and writes nothing, because applying the plan would overwrite the other change with the plan's older values. Call `hoi4.focus_inspect` again, reapply the intended edit to the new plan, and retry. There is no override. A change that only touches comments or formatting does not trigger the refusal, and neither does a source that already equals the plan.

Source files are read as UTF-8 (with or without a byte order mark) and, when they are not valid UTF-8, as Windows-1252. Windows-1252 leaves the bytes 0x81, 0x8D, 0x8F, 0x90 and 0x9D undefined, so a file containing any of them cannot be edited without changing those bytes. Inspection still works and reports the warning `SOURCE_ENCODING_NOT_ROUND_TRIPPABLE`; every rewrite of that file is refused with the same code. Convert the file to UTF-8, or replace those bytes, and retry.

## What inspection checks

Inspection and rendering can report missing references, invalid prerequisite structure, duplicate or overlapping positions, insufficient spacing, long or crossing connectors, branch asymmetry (and, in the layout verdict, empty space, imbalance, drift and chains with no choice), route conflicts, missing localisation or sprites, weak terminal branches, repeated rewards, and missing AI metadata. National-tree inspection also returns the exact `continuous_focus_position` coordinates and linked palette IDs in its compact result, so an agent can identify and move the continuous-focus area without opening the full artifact. Renders are offline review artifacts, not game screenshots.

For a named tree, pass `scenario: { "completedFocusIds": ["my_route_root"] }` to `hoi4.focus_inspect`. The linked inspection artifact records each focus's prerequisite groups, route locks, exclusive choices, and unresolved runtime fields against that completed set. The inline tree summary counts completed, blocked, unresolved, and structural candidate focuses, plus contradictory completed choices. A structural candidate still requires runtime trigger evaluation before an agent can call it playable.

Pass up to 16 `cropFocusIds` to `hoi4.focus_render` for source-linked problem crops around specific focuses. Each crop uses the same rendered pixels as the full tree; a JSON manifest records the focus ID, crop bounds, image hash, and diagnostics. An unknown focus ID is reported explicitly.

The layout JSON reports horizontal, vertical, and Manhattan grid spans for every prerequisite connector in `layout.connectorMeasurements`.

`hoi4.focus_render` returns an in-game-style schematic of the layout inline (no second call): an overview of at most 1,500 pixels and up to five close-ups of the places the scorecard blames, or of the branches named in `cropBranchIds` (up to 8; a derived branch is named by its first focus) and the focuses named in `cropFocusIds`. Failing focuses are outlined (red for hard defects, amber otherwise), exclusive choices are joined by red dashes, OR prerequisites are dotted, and a ruler shows the grid coordinates. Pass `inline: false` for linked artifacts only. The inline pictures are tool renders, not game screenshots, and carry no icons; the result lists each image in `data.inlineImages` with its region. It also writes complete HTML, SVG, JSON and source-map artifacts and a high-fidelity PNG with decoded icons. Pass `png: false` for the faster structural view without decoding icons. National trees with 200 or more focuses raster at half scale by default; pass `reviewScale` from `0.25` through `1` when a different PNG size is needed.

The public workflow is regression-tested with 1,024-focus creation, compact rewrites, deterministic repeat runs, inspection, vector rendering, and raster rendering. A separate 1,024-icon test decodes a distinct texture for every focus. Large source diffs use the same deterministic review-artifact path instead of blocking at the quadratic matrix size.

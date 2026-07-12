# Focus Tree Workbench

The workbench imports existing focus source into a structured plan without normalizing away unsupported fields. It models tree/country assignment, branches and lanes, explicit prerequisite groups, exclusions, route locks, bypass/availability, fixed/relative/pinned/automatic positions, planner-only hidden/crisis/conditional routes, convergence, shared support, icons, localisation, AI/filter metadata, linked content, and raw passthrough.

Linked reward content is taken from the actual effect grammar. Native effects are distinguished by
the bundled catalog of all 553 identifiers documented for the supported HOI4 1.19.2 build. Direct scripted-effect calls, including calls nested in
`IF`/`ELSE`, iterator scopes, and weighted `random_list` entries, link to the shared scripted-effect
index. Native control/trigger blocks and country, state, character, event-target, or variable scopes
are traversed without becoming helper links. Decision-category tooltips link to indexed top-level
categories; decision targets recognized as formables link to the formable symbol; cosmetic tags do
not masquerade as formables. Missing links retain the exact reward source location.

Decision categories are additive database fragments: the category definition under
`common/decisions/categories` and one or more decision-member blocks may legitimately share an ID.
The shared index retains those fragments without reporting a duplicate-definition collision while
still honoring same-relative-file shadowing and load-order source ownership.

National focus `cost` values support finite numbers and safe file-scoped constants such as
`@focus_cost_standard`. Targeted layout updates preserve the exact existing cost lexeme, including
numeric formatting and comments. A cost token outside the typed model is retained unchanged when
the plan does not explicitly replace it; the compiler refuses to generate an arbitrary scalar.

National focuses and continuous focuses use their actual HOI4 source models. National trees come from the workspace registration's configured `roots.focus` paths. Continuous focuses come from `common/continuous_focus/*.txt` as `continuous_focus_palette = { ... focus = { ... } }`; matching country palettes take precedence over the default palette, and the compiler never emits a `continuous` field inside a national `focus = { ... }` block.

## Agent workflow

1. `hoi4.project_scan` builds the common workspace/index revision.
2. `hoi4.focus_scan` imports active national trees, matching continuous-focus palettes, active localisation, sprite definitions, and only the exact texture paths referenced by those sprites.
3. `hoi4.focus_lint` separates syntax, reference, layout, and design diagnostics. Omit `mode` for national-tree compatibility, or pass `mode: "continuous"` with an optional `paletteId` to lint a palette directly.
4. `hoi4.focus_layout` calculates stable integer coordinates. Pinned positions and existing coordinates anchor incremental changes.
5. `hoi4.focus_render` returns deterministic HTML, SVG, PNG, JSON, and generated-source-map resources. National mode also returns the graph layout and hash-bound planning sidecar; a uniform `reviewScale` from `0.25` through `1.0` keeps unusually wide or deep trees within bounded raster limits without changing logical geometry or source coordinates. Continuous mode accepts palette columns and renders the actual continuous-focus source model.
6. In autonomous mode, `hoi4.focus_rewrite` accepts either a national plan (the default when `mode` is omitted) or `mode: "continuous"` with a continuous-palette plan. It makes source-preserving range edits where possible, produces before/proposed/bitmap-diff evidence, journals exact recovery bytes, applies, rebuilds the index, and post-validates in one call. National plans may set `horizontalSpacing`, `verticalSpacing`, `padding`, and a uniform `reviewScale` for both review renders; those pixel-space settings do not alter focus coordinates or compiled HOI4 source. National plans also maintain the adjacent planning sidecar. To create a first tree or palette in a new mod source file, set `createIfMissing: true`; without it, missing sources and IDs refuse. Creation never appends a different target to an existing source file, never copies a read-only game/dependency file into a shadowing mod path, and restores newly created source and sidecar files automatically if the rewrite fails.
7. Check `execution`, drift, diagnostics, validation, changed files, source maps, and diff artifacts. `execution: "planned"` means validation blocked the proposal without changing source; `execution: "applied"` means post-write validation succeeded.

With the optional `"transactions"` compatibility policy, use `hoi4.focus_plan_changes`, page through `hoi4.transaction_diff`, and call `hoi4.transaction_apply` with the exact plan hash instead. The same core validation and recovery engine is used.

## Repairing an existing large tree

Imported authored coordinates are fixed by design. A plain `hoi4.focus_layout` call therefore
audits an existing layout without silently rearranging it. To opt a badly structured tree into a
full cleanup, the coding agent must make the movement policy explicit:

1. Scan, lint, and render the baseline, then read the complete imported plan resource. Use the same
   national `reviewScale` for baseline, transaction, and final renders when the default canvas is too
   large.
2. Preserve every prerequisite group, exclusion, route lock, reward, raw passthrough entry, source
   location, and provenance value.
3. Model the intended route architecture with `branchGroups`, `laneGroups`, `branchId`, and
   `laneId`. Give lanes stable order and, where appropriate, horizontal bounds.
4. Keep only deliberate trunk or convergence anchors fixed/pinned. Change every movable focus to
   `{ "mode": "auto", "pinned": false }`; `preferredX` and `preferredY` may retain the authored
   route intent without making those coordinates mandatory.
5. Submit the complete plan to `hoi4.focus_rewrite`. The call performs layout, compilation,
   lint, source-preserving range edits, deterministic before/proposed rendering, bitmap diffing,
   journaling, application, index rebuild, and post-write validation.
   For an unusually wide or deep tree, set a uniform national `reviewScale` between `0.25` and
   `1.0`; `0.4` is appropriate for a very large comparison. It scales nodes, text, connectors, and
   the viewport together, avoiding artificial overlap. The same scale governs both sides of the
   comparison and affects only artifact pixels, never source-grid coordinates. Explicit spacing and
   padding remain available when the artifact's logical presentation itself needs adjustment.
6. Inspect the returned validation and evidence links. Rescan, lint, and render when additional
   final evidence is useful. A blocked proposal changes nothing; failure after replacement begins
   restores every affected file automatically.

This workflow is suitable for hundreds of focuses. The solver keeps parents above children,
rejects visible overlap and duplicate coordinates, separates bounded lanes, validates relative
chains, and minimizes avoidable connector crossings. It never changes gameplay relationships to
make a picture look cleaner.

## Authoring a large tree

For a new tree, translate route requirements into the strict public schema at
`hoi4-agent://schema/focus-plan`. A robust plan uses a centered entry/trunk, bounded political or
strategic lanes, separately modelled shared-support lanes, exact AND/OR prerequisite groups,
reciprocal route exclusions, explicit convergence and capstones, automatic positions, and complete
localisation/icon/AI/link metadata. Unsupported Clausewitz blocks belong in `rawPassthrough` so they
round-trip instead of being approximated.

This minimal national plan is schema-valid. It intentionally omits an icon and reward; a production
tree should add complete presentation and gameplay data before rewriting:

```json
{
  "schemaVersion": 1,
  "id": "example_tree",
  "default": false,
  "branchGroups": [
    {
      "id": "constitutional",
      "label": "Constitutional route",
      "family": "politics",
      "focusIds": ["example_entry"],
      "laneId": "centre",
      "major": true,
      "hidden": false,
      "crisis": false,
      "conditional": false,
      "aiStrategyIds": []
    }
  ],
  "laneGroups": [
    { "id": "left", "label": "Left route", "order": 0, "minimumX": -12, "maximumX": -5 },
    { "id": "centre", "label": "Constitutional trunk", "order": 1, "minimumX": -2, "maximumX": 2 },
    { "id": "right", "label": "Right route", "order": 2, "minimumX": 5, "maximumX": 12 }
  ],
  "entryFocusIds": ["example_entry"],
  "focuses": [
    {
      "id": "example_entry",
      "label": "Example entry",
      "branchId": "constitutional",
      "laneId": "centre",
      "prerequisites": { "operator": "and", "groups": [] },
      "mutuallyExclusive": [],
      "routeLocks": [],
      "position": { "mode": "auto", "pinned": false, "preferredX": 0, "preferredY": 0 },
      "visibility": "normal",
      "convergence": false,
      "sharedSupport": false,
      "icons": [],
      "localisation": {
        "titleKey": "example_entry",
        "descriptionKey": "example_entry_desc",
        "workingLabel": "Example entry"
      },
      "ai": { "majorRoute": true, "strategyIds": [] },
      "filters": ["FOCUS_FILTER_POLITICAL"],
      "links": [],
      "rawPassthrough": []
    }
  ],
  "sharedFocusIds": [],
  "continuousFocusPaletteIds": [],
  "continuousFocusIds": [],
  "rawPassthrough": [],
  "provenance": {
    "sourcePath": "plan:example_tree",
    "sourceHash": "0000000000000000000000000000000000000000000000000000000000000000",
    "importedPlanHash": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

Within each focus, one `prerequisites.groups` entry represents one Clausewitz `prerequisite` block
whose listed focuses are OR alternatives. Multiple group entries are AND requirements. For a new
target, use `sourcePath: "plan:<tree-id>"` and 64 zeroes for both initial hashes, then call
`hoi4.focus_rewrite` with `createIfMissing: true`. Use that convention only for a missing
target. Existing sources normally use imported, hash-bound provenance; resolving intentional
plan/source drift additionally requires explicit `authority: "plan"`. The server refuses to append
a different tree to an occupied source file and still requires complete pre-write and post-write validation.

## Prerequisite and route semantics

One `prerequisite` block containing several `focus` entries is an OR group. Several prerequisite blocks are ANDed. The importer preserves that grouping exactly. It never flattens prerequisites into a graph that changes meaning.

Structured route locks compile only to valid trigger fields: selection conditions use `available`, while branch visibility uses `allow_branch`. `all`, `any`, exclusion, and impossible locks compile to direct conditions, `OR`, `NOT`, and `always = no` respectively. Hidden/crisis labels are design metadata, not Clausewitz keys; re-import enrichment restores them from the sidecar without emitting invalid `hidden =` or `crisis =` markers.

## Planning sidecar

Branch/lane assignment, shared-support status, working labels, planner visibility/reveal intent, terminal/payoff classification, and major-route AI notes are design metadata rather than HOI4 fields. A source file such as `common/national_focus/example.txt` therefore has an adjacent `example.focus-plan.json` sidecar.

The sidecar records the exact generated source SHA-256. Enrichment is explicit and succeeds only for the matching tree and source hash; stale or mismatched sidecars produce diagnostics and do not silently override source truth. Source-only imports remain valid when no sidecar exists.

## Localisation and sprite resolution

Scan and render select active localisation and sprite symbols through the shared load-order index. Rendered titles use the active language value, and icons use frame zero from the active sprite's real `texturefile` and `noOfFrames` definition. Sprite strips are cropped to the resolved frame rather than displayed as a whole image.

Raster discovery is deliberately exact: the shared workspace scan does not walk every `gfx/**/*.dds` or `gfx/**/*.png` file. After resolving referenced sprites, the asset catalog scans only their normalized texture paths. Missing localisation, sprite, texture, or unsupported-frame diagnostics retain the originating focus/icon source location.

## Layout contract

Hard constraints keep parents above children, coordinates unique, visible nodes non-overlapping, automatic nodes inside configured lane bounds, pinned nodes fixed, and relative-position chains valid. Automatic preferred coordinates are clamped to their lane; a full lane raises `FOCUS_LAYOUT_LANE_CAPACITY_BLOCKED`. Fixed, relative, or prior-stable coordinates outside their declared lane are preserved as evidence but produce a blocking `FOCUS_LAYOUT_LANE_BOUNDS_VIOLATION`. The solver records every move and unsatisfied constraint. It never changes a prerequisite, silently stacks nodes, or invents a route.

Mutual-exclusion relationships are also layout constraints: newly placed automatic endpoints must retain at least the configured `nodeSpacing` in horizontal focus-grid columns. Fixed, relative, pinned, and prior-layout coordinates are stability anchors. The solver does not move those anchors to improve mutual-exclusion spacing or connector routing; it emits `FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED` with the movable and preserved endpoints when authored constraints make the gap impossible.

For each new automatic node, the solver evaluates integer candidates in deterministic distance and direction order, rejects visible overlap and mutual-exclusion violations, and chooses the nearest candidate with the fewest connector crossings. A crossing-only move is recorded as `moved_to_reduce_crossings` with its before/after count. Remaining crossings produce `FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED` with the preserved endpoints and reason. Supplying a previous layout makes its existing automatic nodes stable anchors, so a small addition cannot reshuffle an accepted tree.

Weak dangling branches, terminal payoff, missing AI, and repeated generic rewards remain deterministic design warnings. Layout heuristics never become automatic gameplay edits.

## Drift and source maps

The plan records imported source and semantic hashes. If both saved plan and hand-edited script diverge, regeneration is blocked until the coding agent explicitly identifies the authoritative source. Raw fields remain attached to source ranges either way. An explicitly created target reports `target_missing` drift with `requiresAuthority: false`; that status means there is no prior target to reconcile, not that an existing source was overwritten.

Every compiled or proposed focus block receives a source-map entry containing the focus ID, generated location, planning-node location when available, and imported source location when available. National render artifacts use `<tree>.focus.source-map.json`; continuous renders use `<palette>.continuous.source-map.json`. Rewrite journals retain the corresponding proposed source map and all review artifacts after success or automatic restoration.

## Artifacts

Each rendered node includes its ID, resolved title/working label, resolved icon frame or diagnostic, coordinates, prerequisite type, exclusions, branch family, planner visibility/convergence/terminal state, AI metadata, and source-linked diagnostics. HTML search and filters inspect evidence only; they cannot write source.

National-tree renders store `<tree>.focus.html`, `.svg`, `.png`, `.json`, `.source-map.json`, and `.plan.json`. Continuous-palette renders use the same core artifact store and produce `<palette>.continuous.html`, `.svg`, `.png`, `.json`, and `.source-map.json`. The JSON embeds the same complete generated-source map that is also stored separately, and all formats carry content hashes plus source/render provenance.

A national focus rewrite also stores `<tree>.focus.proposed-validation.json`. It contains every
diagnostic and validation check from re-importing, laying out, and linting the compiled proposal.
When that complete set is larger than the fixed transaction-manifest allowance, the manifest keeps
a blocker-first bounded summary and an explicit resource diagnostic; it never drops findings from
the validation decision. The rewrite boundary uses the same pattern for oversized post-write
diagnostics.

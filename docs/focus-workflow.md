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

National focuses and continuous focuses use their actual HOI4 source models. National trees come from the workspace registration's configured `roots.focus` paths. Continuous focuses come from `common/continuous_focus/*.txt` as `continuous_focus_palette = { ... focus = { ... } }`; matching country palettes take precedence over the default palette, and the compiler never emits a `continuous` field inside a national `focus = { ... }` block.

## Agent workflow

1. `hoi4.project_scan` builds the common workspace/index revision.
2. `hoi4.focus_scan` imports active national trees, matching continuous-focus palettes, active localisation, sprite definitions, and only the exact texture paths referenced by those sprites.
3. `hoi4.focus_lint` separates syntax, reference, layout, and design diagnostics. Omit `mode` for national-tree compatibility, or pass `mode: "continuous"` with an optional `paletteId` to lint a palette directly.
4. `hoi4.focus_layout` calculates stable integer coordinates. Pinned positions and existing coordinates anchor incremental changes.
5. `hoi4.focus_render` returns deterministic HTML, SVG, PNG, JSON, and generated-source-map resources. National mode also returns the graph layout and hash-bound planning sidecar; continuous mode accepts palette columns and renders the actual continuous-focus source model.
6. `hoi4.focus_plan_changes` accepts either a national plan (the backward-compatible default) or `mode: "continuous"` with a continuous-palette plan. Both make source-preserving range edits where possible and produce before/proposed/bitmap-diff review artifacts before creating the dry-run transaction. National plans also maintain the adjacent planning sidecar. To create a first tree or palette in a new mod source file, the coding agent must set `createIfMissing: true`; without that explicit flag, missing sources and IDs refuse. Creation never appends a different target to an existing source file, because doing so could repurpose unrelated source or its adjacent planning sidecar. It uses a transparent source-linked before render, never copies a read-only game/dependency file into a shadowing mod path, and rolls back newly created source and sidecar files atomically.
7. Review drift, diagnostics, source maps, diff artifacts, and plan hash before apply.

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

Hard constraints keep parents above children, coordinates unique, visible nodes non-overlapping, pinned nodes fixed, route lanes separated, and relative-position chains valid. The solver records every move and unsatisfied constraint. It never changes a prerequisite, silently stacks nodes, or invents a route.

Mutual-exclusion relationships are also layout constraints: newly placed automatic endpoints must retain at least the configured `nodeSpacing` in horizontal focus-grid columns. Fixed, relative, pinned, and prior-layout coordinates are stability anchors. The solver does not move those anchors to improve mutual-exclusion spacing or connector routing; it emits `FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED` with the movable and preserved endpoints when authored constraints make the gap impossible.

For each new automatic node, the solver evaluates integer candidates in deterministic distance and direction order, rejects visible overlap and mutual-exclusion violations, and chooses the nearest candidate with the fewest connector crossings. A crossing-only move is recorded as `moved_to_reduce_crossings` with its before/after count. Remaining crossings produce `FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED` with the preserved endpoints and reason. Supplying a previous layout makes its existing automatic nodes stable anchors, so a small addition cannot reshuffle an accepted tree.

Weak dangling branches, terminal payoff, missing AI, and repeated generic rewards remain deterministic design warnings. Layout heuristics never become automatic gameplay edits.

## Drift and source maps

The plan records imported source and semantic hashes. If both saved plan and hand-edited script diverge, regeneration is blocked until the coding agent explicitly identifies the authoritative source. Raw fields remain attached to source ranges either way. An explicitly created target reports `target_missing` drift with `requiresAuthority: false`; that status means there is no prior target to reconcile, not that an existing source was overwritten.

Every compiled or proposed focus block receives a source-map entry containing the focus ID, generated location, planning-node location when available, and imported source location when available. National render artifacts use `<tree>.focus.source-map.json`; continuous renders use `<palette>.continuous.source-map.json`. Dry-run transactions retain the corresponding proposed source map and all review artifacts after apply and rollback.

## Artifacts

Each rendered node includes its ID, resolved title/working label, resolved icon frame or diagnostic, coordinates, prerequisite type, exclusions, branch family, planner visibility/convergence/terminal state, AI metadata, and source-linked diagnostics. HTML search and filters inspect evidence only; they cannot write source.

National-tree renders store `<tree>.focus.html`, `.svg`, `.png`, `.json`, `.source-map.json`, and `.plan.json`. Continuous-palette renders use the same core artifact store and produce `<palette>.continuous.html`, `.svg`, `.png`, `.json`, and `.source-map.json`. The JSON embeds the same complete generated-source map that is also stored separately, and all formats carry content hashes plus source/render provenance.

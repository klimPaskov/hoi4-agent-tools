# ADR 0059: Border naturalness metric and validator

## Context

A generated or edited map can be valid and still look artificial: province, state and country borders that ignore rivers, ridges and shores. A generated mod map passed every structural check while its borders sat at chance level against the land (province, state and country enrichment 0.94, 0.70 and 0.50; vanilla 1.35, 1.40 and 1.46). Nothing in the tool measured this, so neither a person nor a generator could tell whether a change made borders better. The territory assignment service (plan section C11) and a mod's acceptance check (for example at least 85% of state-border length and 70% of country-border length follow nature) both need the same number from code, not from a render.

## Decision

`src/hoi4_agent_tools/map/border-quality.ts` computes the metric in the map domain; `border-quality-input.ts` builds its input from a scanned `MapWorkspaceIndex`. `hoi4.map_inspect` and the render overlay call the same functions as any other code.

**Border.** A border edge is the pair of orthogonally adjacent pixels (the east-west seam wraps) that belong to two different groups of land provinces. Coast edges (land against sea or lake) are counted apart and never enter a land-border share. Groups are provinces, states (a province in exactly one state), strategic regions and countries (the owner of the province's state); a province with no group excludes its edges and is counted as unlabelled.

**Natural features** are marked per pixel, computed row by row from the source planes with a few rows of state (the planes are never copied, and the vanilla-size map stays within a bounded working set):

| Feature         | Definition                                                                                                                    | Belongs to |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `river`         | within 2 pixels (Chebyshev) of a `rivers.bmp` pixel with an index of 0 to 11                                                  | barrier    |
| `slope`         | within 1 pixel of a land pixel whose central-difference height gradient magnitude is at least 2 per pixel                     | barrier    |
| `lakeShore`     | within 1 pixel of a lake province pixel                                                                                       | barrier    |
| `extra`         | within 1 pixel of a pixel of a caller-supplied plane (for example a geography wall range)                                     | barrier    |
| `terrainChange` | within 1 pixel of a change between obstacle terrain classes (mountain, forest, jungle, marsh) in `terrain.bmp`; water ignored | natural    |

The barrier set (river, slope, lake shore, extra) is the plan's measurement. The natural set adds terrain-class changes, which `common/terrain` supplies through the graphical terrain entries. An edge carries the union of the features at its two pixels. The central-difference gradient reproduces the plan's published base rates (0.407 of vanilla land and 0.037 of that mod's land; this implementation measures land pixel pairs, 0.430 and 0.040).

**Per layer** the report gives:

- `barrier.alignment`, the share of border length in the barrier set; `barrier.baseRate`, the share of all land pixel pairs in it (what chance gives); `barrier.enrichment`, their ratio, or null when the base rate is under 2% (the metric would mislead);
- `natural.share`, the plain share of border length on any natural feature, its per-feature breakdown, its own base rate and enrichment, and the share when the coast counts as a natural line;
- `straightness`: every seventh border edge is a sample; the same-border edges within 24 pixels are fitted with a total-least-squares line; a perpendicular RMS under 0.9 pixel is locally straight. Windows with fewer than 12 edges are skipped and counted;
- `longRuns`: the share of border length in Douglas-Peucker segments (tolerance 3) longer than 60 pixels, and the share of those that are mostly not on a feature;
- `worstRuns`: up to 20 (at most 100) longest artificial runs, maximal stretches of edges on no feature with natural gaps of at most 3 edges bridged, with both sides, both ends, length, chord and the natural share inside.

**Targets.** Enrichment at least 1.6 for every layer and straightness at most 0.12 for region and country borders (the plan's values). Province borders are shorter than the straightness window, so almost every sample is straight (vanilla 0.67) and they have no straightness target; state borders are shorter and straighter in vanilla (0.20), so their limit is 0.25. `MAP_BORDER_ARTIFICIAL_REVIEW` (warning) names the layer and the failing metrics and carries the worst run; `MAP_BORDER_NOT_MEANINGFUL` (info) reports a layer whose base rate is under 2% or that has no features at all; `MAP_BORDER_INPUT_MISSING` (info) names the bitmaps that were absent or the wrong size; `MAP_BORDER_QUALITY_UNAVAILABLE` (warning) replaces the whole report when the raster is missing or the work budget is exceeded. None of these fail validation.

**Bounds and determinism.** One pass builds a table of the land border edges (13 bytes per edge) and refuses with `MAP_BORDER_QUALITY_BUDGET_EXCEEDED` above 8 million edges (a vanilla-size map has about 0.4 million); the pass and the tracing yield to the event loop and honour the abort signal. There is no random number, clock or locale in any result; numbers are rounded to four places. The layers share the table, so adding a layer costs one pass over the edges, not over the raster.

**Surfaces.** `hoi4.map_inspect` takes `quality: true` (default off, full inspection only) and returns `data.quality` (per layer: status, groups, border and coast length, alignment, base rate, enrichment, natural share, straight fraction, long-run share, artificial run count, the three worst runs), the diagnostics above, and the artifact `map-border-quality.<revision>.json` with the complete report; the `map-inspect` artifact also embeds it. Only then are `rivers.bmp` and `terrain.bmp` scanned. The overlay `border-quality` (any base layer, tiles and areas included) paints the state borders green where natural and orange where not and the worst artificial run of each layer in a layer colour (province white, state red, region yellow, country magenta). Code calls `measureBorderNaturalness` (full report), `buildBorderEdgeTable` once and `scoreBorderAssignment` per candidate grouping of provinces (no raster access; the score of a territory assignment), and `checkBorderTargets` for acceptance checks.

## Consequences

The plan asked for the flag to default on and for a render layer; the flag is off by default so existing requests, artifacts and golden hashes are unchanged, and the render is an overlay so it composes with every base layer. `create_world.borderQuality` (report or enforce) is not added here: a generator that cannot meet the targets yet would block every write, so enforcement waits for the feature-aware partition (C9) and territory assignment (C11), which will call the same functions.

The plain natural share depends on the feature radii. On vanilla it is 0.70 for states and 0.73 for countries with the defaults, below an acceptance wording of 85% for states; the options (`riverRadius`, `slopeRadius`, `terrainRadius`, `extraRadius`) are part of the public function so the acceptance check can fix its definition and report it. The metric rewards alignment with rough height data; thresholds are soft (warnings) and every number is shown.

Tests use synthetic fixtures: borders drawn along a meandering river against a ruler line, slope, terrain-class, lake-shore and extra-plane cases, the seam and the coast, unknown and out-of-table provinces, run ranking, limits and gap bridging, determinism, input and option validation, the edge budget and cancellation, a map at the engine's 13,238,272 pixel limit, the inspect and overlay surfaces, and the procedural generator's own world. Reproductions on installed vanilla and a generated mod map are recorded in `docs/map.md` and `docs/plans/zin-map-pipeline.md`; no game file is copied into the repository.

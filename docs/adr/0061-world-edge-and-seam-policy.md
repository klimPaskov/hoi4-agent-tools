# ADR 0061: World edge and seam policy

## Context

The engine wraps the map horizontally and treats it as a sphere for day and night: every map sampler uses wrap addressing, and no define or `default.map` key turns this off. A reference picture keeps its own edges, so land that touches column 0 or the last column is cut by a straight vertical line where the world repeats, and provinces at the two edges are adjacent. A generated mod map had land on 1,037 rows of its seam and on 2,674 columns of its top row. `ambient_object.txt` was a comment, which drops the base map's north and south frame borders.

## Decision

`create_world.edge` is optional. Omitting it keeps today's behaviour; `edge: {}` selects the open-sea band.

- `sea-band` clears land and lakes from `bandPx` east and west (default `max(192, 4% of the width)`, never more than a quarter of the width) and `polarPx` north and south (default 64, at most a quarter of the height). The cleared outline is ragged (value noise, up to 50% deeper), so the new coast does not read as a ruled line; land fragments the clearing detached sink; the new coast gets a shelf and a coastal land ramp. The water colour map falls to its deepest tint at the seam. The change is reported as a `MAP_EDGE_LAND_CLEARED` warning with the number of pixels.
- `rim` keeps land to the seam and ends it in a wall: heights rise from 150 to 230 over `rimPx` (default 160), the terrain becomes permanent-snow mountain, the colour map darkens to 55%, and `adjacencies.csv` gets one `impassable` row for each pair of distinct land provinces that meet across the seam (`MAP_EDGE_RIM_ADJACENCIES`, information). The polar band is still cleared. Rivers are routed before the rim is raised, so a river that reaches a rim flows uphill there; keep rivers out of it.
- `none` is explicit opt-out.

A city inside a band that would be cleared is an error (`MAP_EDGE_FEATURE_IN_BAND`) naming it; nothing is silently erased. Sea names may stand in the band. The check covers cities and victory-point names, not automatically recognised labels, which are not tied to land.

`ambientFrame: true` writes the wind entity and the north frame at `z = height + 142`, the south frame at `z = -140` and the logo frame at `x = round(0.5327 * width)`, `z = height + 82`, which reproduces the base map's positions at 5,632 x 2,048 (2,190, -140, 3,000 and 2,130). Ambient water objects and the DLC wall mesh are left out. The file is an existing managed output.

Validation always reports the seam: `MAP_EDGE_LAND_CUT` is a warning for rows where land touches the first or last column and an error when the world was created with `sea-band`; `MAP_SEAM_LAND_ADJACENCY` (information) counts land provinces that meet across the seam and how many are blocked; `MAP_POLAR_LAND` (information) counts land in the top and bottom rows; `MAP_HEIGHT_SEAM_STEP` warns about a height step across the seam.

## Consequences

Old requests are unchanged. The band trades land for a clean world: a picture whose continents run off the edge loses the part inside the band, which the warning reports. The frame meshes at widths other than the base map's are untested (unverified), and the band against rim choice needs the owner's probe maps (plan section "The horizontal wrap"); the tool never launches the game.

Province generation can fail with `MAP_WORLD_UNREPRESENTABLE_TOPOLOGY` when land fills the same rows at both edges (a four-province corner across the seam); the sea band avoids it, and the gap is logged in the tool-gap list.

Regressions: defaults and the quarter-width limit, no land inside the band or the polar rows, ragged outlines, fragments that sink, shelf and ramp values, features in the band, rim heights, terrain, colour and exact adjacency rows against an independent count, frame positions and script validity, determinism, and seam validators on fixtures with land on the west, east and both sides.

## Amendment: the wall (2026-11-05)

An owner sailed from the far west of a `rim` world to its far east: `rim` blocks only land provinces across the seam, and the sea at both edges is one connected sea. An `impassable` adjacency is documented to block "the connection between two provinces" (kit wiki, `map_modding.md`, Adjacencies), but the base game's 93 impassable rows all join touching land provinces and nothing shows one stopping fleets, so the tool does not rely on it for sea (`gameplay/crossing-validation.ts` already flags an impassable row on a non-land province).

`edge.mode: "wall"` therefore removes the water instead. A band of `rimPx` (default 48, so that even its narrowest rows hold a default 400-pixel land province; the seam columns alone close the seam) at the east and west edges, ragged between 60% and 100% of it with fractal noise, becomes land over the full height and gets the rim's heights, colour darkening and seam rows. Its look is not one snow range: `wallTerrain: "auto"` takes, for each row and side, the terrain of the nearest land beyond the wall, or snow toward the poles and mountain elsewhere where it meets only water, smoothed along the edge; caller segments `{y0, y1, kind}` override rows. Land provinces with most of their pixels in it form their own states, written as the base game writes its 21 impassable states (`state_modding.md`, Optional; `history/states/1022 - Interior Borneo.txt`): `impassable = yes` with `force_link_ownership_to` the nearest passable state, that state's owner, category `enclave`, infrastructure 0 and nothing built. Nearest counts province steps over land and water, because a wall usually stands in what was sea and touches no passable state. Cities in the band and workspace capitals in the wall are errors; generated capitals avoid it. Validation reports water on the seam columns of a `wall` world as `MAP_EDGE_WALL_OPEN` (error). `polarPx: 0` is allowed for every mode and lets land reach the top and bottom edges.

Unverified in the game: how the engine draws a wall that fills the seam, and whether fleets path around an impassable state's coast as expected. Regressions: the full-height land at both seam columns, the band staying within `rimPx`, the filled-water note, the impassable states and their links and owners, the seam rows, `MAP_EDGE_WALL_OPEN` on a `rim` world validated as a wall, a city in the band, polar land with `polarPx: 0`, and determinism.

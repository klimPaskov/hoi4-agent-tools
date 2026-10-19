# Maps

Generate a new world, split states and reshape provinces. Preview the map and update the scripts that refer to it.
Use `hoi4.map_inspect` and `hoi4.map_rewrite` for provinces, states, regions, supply, railways, positions, ownership, resources, buildings and localisation.

## Generate a world from one image

Put a PNG, JPEG or WebP reference in your mod workspace, then call `hoi4.map_rewrite`:

```json
{
  "operations": [{ "kind": "create_world", "reference": { "imagePath": "references/sketch.png" } }]
}
```

For a first run, copy the project-owned [synthetic hand sketch](images/reference-maps/sketch.png) to `references/sketch.png` in your mod. The [synthetic flat political map](images/reference-maps/political.png) is another ready-made input; copy it to `references/political.png` and change `imagePath` accordingly. The examples are intentionally small and contain no third-party artwork.

The server generates the complete map and supporting country/state files in one validated atomic rewrite. No country list, manual masks, coordinates or separate apply call is required. `workspaceId` defaults to the current mod, and the operation ID defaults to `world`. The default reference world is 5632 by 2048 pixels; the artwork retains its aspect ratio within sea padding. Set `width` and `height` to choose other multiples of 256 within the map pixel budget. Reference defaults group 12 provinces per state, 60 land provinces or 30 sea provinces per strategic region, and request 80 rivers; explicit values override these defaults.

Add `"preview": true` at the top level to return offline reference, terrain and political PNGs, a comparison and counts without changing mod files. Repeat the request without `preview` to apply it. Preview uses the same extraction, generation and validation as application, and never launches the game.

Use a cleaned, unlabelled raster for production generation. Handwriting, sheet joins and map frames can become false islands or relief. Keep the original unchanged, remove these marks in a separate reference, compare its coastlines with the original, then inspect the terrain preview before writing. Supply reviewed names through `reference.labels` and `reference.cities`; an explicit label list, including an empty list, prevents OCR from adding unreviewed names. The server does not automatically redraw artwork or promise lossless interpretation of every map.

Reference worlds enable `startingScenario` by default; procedural worlds keep it off unless requested. The starter includes a bookmark, country histories, provisional councils, recruitable infantry templates, two equipped divisions per country, stockpiles, an infantry production line, supply and building positions. `worldName` sets the bookmark title. Demographics, industry and ownership remain provisional. Existing world events, decisions, startup hooks and country-specific AI strategy folders are replaced; shared game systems remain dependencies and can report unused-definition warnings. Generated names use the localisation replacement folder, and explicit country color declarations match the flags. Inherited country tags receive inactive histories. The adjacent launcher `.mod` file must mirror the generated `descriptor.mod` replacement paths. The server cannot enable a launcher playset or test a campaign.

Regeneration records generated paths and hashes in `.hoi4-agent-world.json`. It removes obsolete recorded outputs through the same atomic rewrite and refuses to overwrite recorded files edited since generation. Preserve that inventory. Unrelated authored files are not deleted; validation can block a rebuild if they conflict with the generated world. Large world diffs remain linked evidence so counts and preview images fit within the MCP response budget.

Automatic interpretation recognizes visual land/water and terrain cues, derives relief and drainage, and uses flat political colors when available. Offline English OCR supplies candidate names and city locations; recognized text bounds are masked before terrain classification so ocean labels do not become islands. Masks near a coastline can soften its detail and produce a review warning. Decorative text, handwriting, unknown languages and visually ambiguous borders may be missed or misclassified; diagnostics identify uncertain interpretation and deterministic defaults. Population, resources, buildings and country ownership inferred from artwork are generated assumptions, not historical facts or a balance assessment.

Optional `reference` controls refine the same call:

| Field                                                       | Meaning                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `politicalImagePath`, `terrainImagePath`, `heightImagePath` | Additional aligned workspace images for political regions, terrain cues or grayscale height.                                                             |
| `mode`                                                      | `auto`, `illustrated`, `satellite`, `sketch`, `political` or `grayscale`.                                                                                |
| `crop`                                                      | `{x,y,width,height}` in original source pixels.                                                                                                          |
| `ignoreMasks`                                               | Polygons that exclude legends, frames or decorative areas.                                                                                               |
| `annotations`                                               | `{kind,polygon}` semantic polygons: sea, land, plains, lake, forest, desert, mountain, snow, volcano, hills, marsh or jungle.                            |
| `riverAnnotations`                                          | Paths for known rivers.                                                                                                                                  |
| `palette`                                                   | `{kind,color:{r,g,b}}` color cues for the same semantic kinds.                                                                                           |
| `coastDetail`                                               | Detail preservation from 0 to 1.                                                                                                                         |
| `cities`                                                    | `{name,x,y,countryTag?}` reviewed city and optional capital anchors. `countryTag` must name a generated country.                                         |
| `labels`                                                    | `{name,x,y,kind}` reviewed names for `state`, `country`, `city`, `sea`, `region`, `mountain` or `geography`; useful for handwritten or ambiguous labels. |

Reviewed geography labels preserve names for lakes, rivers, forests and other features in localisation and generated-world provenance. They do not invent a native HOI4 map entity or turn a geographic label into a city or victory point.

All annotation positions and polygons use normalized 0 to 1 coordinates relative to the original, uncropped reference, with the origin at its top left. Crop uses source pixels instead. Explicit `countries` on the operation supplies reviewed country tags, names, colors and relative shares. If borders or names cannot be inferred reliably, the server generates named defaults and reports the assumptions. Manual controls are optional and never change the original image.

Only relative paths inside the authorized mod workspace are accepted. URLs, absolute paths, traversal, generated storage and symlink escapes are refused. The source is bounded to 1 GiB and 300 million decoded pixels; analysis uses a reduced working PNG up to 3072 pixels per side. The verified source handle is streamed into an exclusive private temporary snapshot, and the same copied bytes are hashed and decoded; the snapshot is removed on completion, failure or cancellation. The original SHA-256 is checked again before writing, using a streaming read, so replacing the source after preparation blocks application. CI image fixtures are synthetic and project-owned. Attributed comparison images may be published separately with permission and remain outside the npm package.

## Describe a world as a geography model

A reference picture says where land and water are. A geography model says what the world is: seas, lands, mountain ranges with passes, volcanoes, rivers from a lake to a sea, lakes, forests and deserts, straits, sites and climate, each with an id and a name. `create_world` accepts one as `geography` (inline) or `geographyPath` (a workspace-relative `.json` file of at most 4 MiB; prefer the file for anything beyond a few hundred vertices). It may stand alone or accompany a `reference` picture. [geography-model.schema.json](../schemas/geography-model.schema.json) is the complete schema; [ADR 0055](adr/0055-geography-model-input.md) records the design.

Preview it before anything else:

```json
{
  "preview": true,
  "operations": [
    {
      "kind": "create_world",
      "width": 5120,
      "height": 2560,
      "geographyPath": "geography/world.json"
    }
  ]
}
```

The preview validates the model, resolves its ids and areas, and returns `map-geography-overlay.png` (every feature drawn with its id; defects outlined in red for errors and orange for warnings) and `map-geography-report.json` (resolved ids, areas in frame units and pixels, lengths, resolved references, climate and every diagnostic), with a summary in `data.geography`. It reads only the model: no map is planned and no mod file changes. The overlay is an offline drawing, not a game screenshot.

**World synthesis from the model is not available yet.** A request without `preview` loads and validates the model and is then blocked with `MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE` (or `MAP_GEOGRAPHY_INVALID` when the model has errors); nothing is written. Relief, rivers, climate and biomes are generated from the model by later stages.

A model is one object with `"version": 1` and any of these arrays. Unknown keys are refused.

| Array       | Feature and main fields                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seas`      | `polygons` (outer rings), optional `holes`, `depthClass` (`shelf`, `open`, `abyss`), `ice` 0 to 1, `kind` (`ocean`, `sea`, `gulf`, `fjord`)                                                                                       |
| `lands`     | `polygons`, `holes`, `kind` (`continent`, `island`, `archipelago`, `peninsula`), `region`, default `biome` and `fertility`, `elevationBase`, `coastDetail`                                                                        |
| `regions`   | `polygons` (optional), `terrain` target shares, `density` (`provincesPerState` as `[smallest, usual, largest]`, `provinceAreaPx`)                                                                                                 |
| `ranges`    | `path` (points, each optionally with `halfWidth` and `peak`), `closed`, `halfWidth`, `peak`, `profile` (`ridge`, `massif`, `escarpment`, `wall`), `asymmetry`, `snowline`, `spurs`, `barrier` (`none`, `impassable`, `fort-line`) |
| `passes`    | `range` with `at` (0 to 1 along the range), or a `position` point (the range is found for you), `width`, `depth`, `fort` 0 to 5                                                                                                   |
| `volcanoes` | `at`, `radius`, `peak`, `crater`, `active`                                                                                                                                                                                        |
| `plateaus`  | `polygons`, `height` (a low value makes a basin or chasm), `edge` (`cliff`, `ramp`)                                                                                                                                               |
| `rivers`    | `source` (point or `{lake}`), `mouth` (point, `{sea}`, `{lake}` or `{river}` for a tributary), `via` points, `size` 1 to 5, `delta`                                                                                               |
| `lakes`     | `polygons` or `center` with `radius`, `depthClass`, `outflow` (a river id), `gameplay` (`lake`, `inland-sea`)                                                                                                                     |
| `biomes`    | `kind` (`forest`, `desert`, `marsh`, `ice`, `plains`, `farmland`, `jungle`, `steppe`, `tundra`, `hills`), `polygons`, `density`, `fertility`, `z` priority                                                                        |
| `straits`   | `between` (two points on land or `{land}` ids), a `path` through the water, or both; `rule` (`open`, `army-closed`, `navy-closed`), `width`                                                                                       |
| `sites`     | `kind` (`capital`, `city`, `fortress`, `port`, `ruin`, `temple`, `mine`, `landmark`), `at`, `importance` 1 to 5, `country`, `onWater`, `lake`                                                                                     |
| `roads`     | `path`, `importance` 1 to 3                                                                                                                                                                                                       |
| `places`    | `kind` (`cape`, `bay`, `gulf`, `peninsula`, `reef`, `landmark`, `other`), `at`: a name for later naming stages, on any surface                                                                                                    |
| `climate`   | `windFrom` (compass bearing the wind comes from), `temperature` (`warm` and `cold` degrees Celsius), `warmBandY`, `rainScale`, `seasonality`                                                                                      |

Every feature also takes `id` (letters, digits, `_`, `.`, `-`; unique across the whole model), `name`, `tags` and `note`. Coordinates are normalised to the whole world frame, origin top left, x east and y south, like `reference.labels`; a point is `{"x":0.3,"y":0.4}` or `[0.3, 0.4]`. Lengths (`radius`, `halfWidth`, `width`) are fractions of the map width, so a circle stays round at any aspect ratio. Heights (`peak`, `height`, `elevationBase`) are 0 to 1 of the relief scale. A polygon has 3 to 2,000 vertices, a path 2 to 2,000; a model has at most 4,000 features and 200,000 vertices and points. Order does not matter: features are sorted by id, rings oriented and defaults filled, and the report carries a `modelHash` that is the same for the same world however it was written.

A model that needs an edit is reported by `MAP_GEOGRAPHY_*` diagnostics that name the feature. Errors: `ID_DUPLICATE`, `RING_DEGENERATE`, `RING_SELF_INTERSECTION`, `POLYGONS_OVERLAP`, `HOLE_OUTSIDE`, `HOLES_WITHOUT_POLYGONS`, `REF_UNKNOWN`, `REF_KIND`, `PASS_SHAPE`, `PASS_OFF_RANGE`, `RIVER_SOURCE_NOT_LAND`, `RIVER_MOUTH_NOT_WATER`, `RIVER_CYCLE`, `LAKE_SHAPE`, `LAKE_NOT_IN_LAND`, `LAKE_OUT_OF_FRAME`, `VOLCANO_NOT_ON_LAND`, `VOLCANO_CRATER_RADIUS`, `STRAIT_SHAPE`, `STRAIT_ENDPOINT`, `STRAIT_SAME_LAND`, `SITE_IN_WATER`, `BIOME_CONFLICT` (different kinds overlap at the same `z`), `BIOME_OVER_WATER`, `PATH_DEGENERATE`, `CLIMATE_TEMPERATURE_ORDER`, `REGION_DENSITY_ORDER`, `NO_LAND` (no lands and no reference picture), `LIMIT_FEATURES` and `LIMIT_POINTS`. Warnings: `LAND_OVERLAP`, `SEA_OVER_LAND`, `LAKE_TOO_SMALL`, `LAKE_OUTFLOW_MISMATCH`, `PASS_OVERLAP`, `VOLCANO_OVERLAP`, `RANGE_ON_WATER`, `PATH_SELF_INTERSECTION`, `RIVER_VIA_NOT_LAND`, `STRAIT_PATH_ON_LAND`, `STRAIT_NO_WATER`, `SITE_DUPLICATE_POSITION`, `REGION_EMPTY`, `REGION_TERRAIN_SUM`, `NAME_DUPLICATE`, `RING_DUPLICATE_VERTEX`, `PATH_DUPLICATE_VERTEX`, `FEATURE_IN_EDGE_BAND` and `DIAGNOSTICS_TRUNCATED` (more than 1,000 findings; the worst severity is kept). A file that cannot be used at all fails the call instead, with `MAP_GEOGRAPHY_PATH_INVALID`, `SOURCE_TOO_LARGE`, `JSON_INVALID`, `SCHEMA_INVALID` or `SOURCE_AMBIGUOUS`. A point within 0.003 map widths of a coast counts as land, so a river mouth or a port drawn on the shore does not fail on a simplified coastline; the error for an inland mouth reports its `inlandDistance` so it can be snapped.

`FEATURE_IN_EDGE_BAND` marks land, plateaus, ranges, volcanoes, sites, passes and river points inside `max(192 pixels, 4% of the width)` east and west or 64 pixels north and south of the frame, because the game wraps the map horizontally. Until the `edge` option exists it is a warning.

`geographyPath` follows the rules of `reference.imagePath`: relative paths inside the authorized mod workspace only; URLs, absolute paths, traversal, symlink and junction escapes are refused; the file is read once, its SHA-256 is taken from the bytes that are parsed, and a change after preparation blocks the write as stale. A file that is not JSON or does not match the schema is an error, not a partial preview. CI models are synthetic and project-owned.

## Inspect and navigate the complete map

`hoi4.map_inspect` finds map problems and returns a full-map PNG plus a searchable, clickable HTML navigator by default. The navigator supports pan, zoom, fit-to-map, search by numeric ID, localisation key, or localised name, and exact click lookup for province, state, and strategic-region IDs. Hovering reports both top-left bitmap coordinates and bottom-left HOI4 map coordinates.

The linked JSON catalog contains every active province definition, state, and strategic region with resolved names, alternate localisation values, source paths and lines, raster bounds and centers, memberships, neighbors, victory points, resources, buildings, ports, supply nodes, railways, normal and special adjacencies, building positions, unit positions, weather positions, and entity locators. Large catalog and render data remain in MCP resources instead of filling the agent prompt.

Use `query` for a compact name or ID result list and `coordinates` for exact pixel or map-coordinate lookup. Use `provinceIds`, `stateIds`, and `regionIds` for focused records. Up to 32 selected provinces can also produce exact geometry as maximal `[y, startX, endXExclusive]` row runs.

Set `lookupOnly: true` for coordinate, query, and selected-ID lookups without full validation, the complete catalog artifact, overview rendering, or province geometry export. The lookup artifact contains only the requested matches and source revision. Use full inspection for allocation previews or province row runs.

`hoi4.map_inspect` accepts these fields:

| Field                | Default and limits               | Meaning                                                                                                                                                                                                                 |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provinceIds`        | `[]`, at most 32                 | Province records to return, with exact geometry row runs.                                                                                                                                                               |
| `stateIds`           | `[]`, at most 1,000              | State records to return.                                                                                                                                                                                                |
| `regionIds`          | `[]`, at most 1,000              | Strategic-region records to return.                                                                                                                                                                                     |
| `query`              | optional, at most 256 characters | Name, localisation key, or ID search.                                                                                                                                                                                   |
| `queryLimit`         | 100, range 1 to 1,000            | Maximum `query` matches.                                                                                                                                                                                                |
| `coordinates`        | `[]`, at most 100                | `{ "kind": "pixel", "x", "y" }` with top-left bitmap pixels, or `{ "kind": "map", "x", "z" }` with HOI4 map coordinates.                                                                                                |
| `lookupOnly`         | `false`                          | Return only the requested lookups, as described above.                                                                                                                                                                  |
| `includeOverview`    | `true`                           | Render the full-map PNG and navigator; set `false` to skip the overview render.                                                                                                                                         |
| `allocationRequests` | `[]`, at most 100                | Preview the next free identifiers: `{ "kind": "state", "requestedId"? }` or `{ "kind": "province", "requestedId"?, "requestedColor"? }`, where `requestedColor` is `{ "r", "g", "b" }`. Not accepted with `lookupOnly`. |
| `quality`            | `false`                          | Also measure border naturalness (see [Border naturalness](#border-naturalness)). Full inspection only; not accepted with `lookupOnly` or a rendered view.                                                               |

Give `hoi4.map_inspect` a `layer`, `overlays`, `scale`, `tile` or `area` to render that view instead of validating; the result is the same complete catalog and navigator drawn with the chosen base layer and overlays, and lookups (`query`, `coordinates`, IDs) belong in a separate call. Base layers include province, state, strategic region, terrain, continent, owner, controller, cores, claims, and coast. Overlays include coastlines, ports, victory points, resources, state and province buildings, supply nodes, railways, adjacencies, building, unit, and weather positions, and `border-quality` (see [Border naturalness](#border-naturalness)).

A rendered view takes `layer` (default `province`), up to 12 `overlays`, and an integer `scale` from 1 to 16 (default 1).

Pass `tile: { x, y, width, height }` for a reusable bounded PNG, JSON, and HTML view of one top-left bitmap area. The tile preserves the selected base layer and overlays, and its JSON records raster dimensions and province IDs in the area. Identical source revisions and render settings produce identical artifact hashes.

Pass `area: { provinceIds, stateIds, regionIds, padding }` to render the exact bounding area of those map entities with optional pixel padding. The result reports the resolved tile coordinates. An unknown ID or an area larger than 2,048 pixels in either direction is explicit, so a narrower selection can be requested.

## Border naturalness

A map can be structurally valid and still look artificial because its borders ignore the land. `hoi4.map_inspect` with `quality: true` measures how well province, state, strategic-region and country borders follow natural lines, and the `border-quality` overlay shows where they do not. The measurement is offline, deterministic and bounded; it reads `provinces.bmp` and the definitions, the states and regions, and (when present and the size of the province map) `heightmap.bmp`, `rivers.bmp` and `terrain.bmp` with the `common/terrain` entries. A bitmap that is absent or of another size is skipped, listed in `data.quality.skippedInputs` and reported as `MAP_BORDER_INPUT_MISSING`.

A **border** is a land-to-land pixel edge between two different groups of provinces (the east-west seam counts); the coast is counted apart. A border lies on a **natural feature** when it is within 2 pixels of a river, within 1 pixel of a steep height gradient (central difference of at least 2 per pixel), within 1 pixel of a lake, or within 1 pixel of a change between obstacle terrain classes (mountain, forest, jungle, marsh) in `terrain.bmp`. Each layer reports:

| Field                    | Meaning                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alignment`              | Share of border length in the barrier set (rivers, slopes, lake shores).                                                                                                                      |
| `baseRate`, `enrichment` | Share of all land on the same features, and `alignment / baseRate`. 1 is chance; vanilla is 1.35 to 1.46, the engineering target 1.6. Null (`not-meaningful`) when the base rate is under 2%. |
| `naturalShare`           | The plain share of border length on any natural feature, terrain changes included; `naturalShareWithCoast` also counts the coast as a natural line.                                           |
| `straightFraction`       | Share of samples (every seventh border pixel) whose 24-pixel window of the same border is a straight line (RMS under 0.9 pixel). Vanilla country borders 0.11, target at most 0.12.           |
| `longRunShare`           | Share of border length in straight segments longer than 60 pixels after simplification (tolerance 3).                                                                                         |
| `artificialRuns`         | Count and longest length of stretches that follow no feature.                                                                                                                                 |
| `worstRuns`              | The longest artificial runs (three inline, twenty in the artifact) with both sides, ends, length and chord, so a fix can target them.                                                         |

`MAP_BORDER_ARTIFICIAL_REVIEW` (warning) names a layer below the targets (enrichment 1.6 for every layer; straightness 0.12 for region and country, 0.25 for state, none for province because province borders are shorter than the window). `MAP_BORDER_NOT_MEANINGFUL` (info) means the map has almost no rivers or slopes to align to. `MAP_BORDER_QUALITY_UNAVAILABLE` (warning) means the map has no raster or exceeds the border-edge budget (8 million edges; a vanilla-size map has about 0.4 million). These diagnostics never fail validation. The complete report is the artifact `map-border-quality.<revision>.json`.

Measured with this implementation (the plan's script gave the enrichment values in brackets):

| Map                                           | Layer    | Enrichment  | Natural share | Straight samples |
| --------------------------------------------- | -------- | ----------- | ------------- | ---------------- |
| Installed vanilla 1.19.3 (earliest bookmark)  | province | 1.35 (1.37) | 0.69          | 0.67             |
|                                               | state    | 1.40 (1.42) | 0.70          | 0.20             |
|                                               | region   | 1.39        | 0.70          | 0.11             |
|                                               | country  | 1.46 (1.53) | 0.73          | 0.11 (0.093)     |
| ZIN map of 2026-10-18                         | province | 0.94 (0.94) | 0.08          | 0.99             |
|                                               | state    | 0.70 (0.69) | 0.07          | 0.37             |
|                                               | region   | 0.59        | 0.06          | 0.13             |
|                                               | country  | 0.50 (0.52) | 0.09          | 0.22 (0.178)     |
| Procedural `create_world`, 1024 x 512, seed 7 | state    | 1.03        | 0.32          | 0.24             |

A 13.1 million pixel map takes about 1.5 seconds and 100 MB of additional memory. The ZIN rows use the installed game's `common/terrain` for the terrain classes. The last row is the repository's own procedural output: its borders sit at chance level against rivers and slopes, which is what the metric exists to show. The same functions are available to other code: `measureBorderNaturalness` for a full report, `buildBorderEdgeTable` and `scoreBorderAssignment` to score many candidate groupings of provinces without reading the raster again, and `checkBorderTargets` for an acceptance check such as the ZIN rule that at least 85% of state-border length and 70% of country-border length follows nature (vanilla itself reaches 0.70 and 0.73 with the default feature radii, so fix the radii in the check).

The `border-quality` overlay is added to any base layer (state is the natural choice): state borders are green where they follow a feature and orange where they do not, and the worst artificial run of each layer is drawn two pixels wide (province white, state red, region yellow, country magenta). It works with `tile` and `area`, and scans the river and terrain bitmaps for that render only.

## Catalog consistency

Validation reads the active `common/terrain/*.txt` categories and `map/continent.txt` (or the continent file `default.map` names) along with the map files.
A province whose terrain no category defines reports `MAP_TERRAIN_UNKNOWN`, and a land province with a continent number beyond the continents listed reports `MAP_CONTINENT_UNKNOWN`; continent IDs follow their order in the file.
Seas and lakes must use a category with `is_water = yes` (`MAP_SEA_TERRAIN_INVALID`, `MAP_LAKE_TERRAIN_INVALID`), land provinces must not (`MAP_LAND_TERRAIN_WATER`), and a strategic region's `naval_terrain` must name a category with `naval_terrain = yes` (`MAP_REGION_NAVAL_TERRAIN_INVALID`).
When no terrain category file is available, seas and lakes are checked against the base game's `ocean` and `lakes` names instead, and unknown terrain is not reported.

The engine stops reading `adjacencies.csv` at its first `-1` row.
Rows after it are not read and report `MAP_ADJACENCY_AFTER_TERMINATOR`; a file without that row reports `MAP_ADJACENCY_TERMINATOR_MISSING` as a warning, because the offline wiki describes it as required although at least one published mod omits it.

## Rewrite requests

`hoi4.map_rewrite` takes an ordered list of 1 to 100 operations in `operations`, an optional integer `diffScale` from 1 to 16 for the comparison render (default 1), and an optional `requestKey` for background retries:

```json
{
  "operations": [
    {
      "id": "create-western-state",
      "kind": "create_state",
      "provinceIds": [120, 121, 122],
      "displayName": "Western State"
    }
  ],
  "diffScale": 2
}
```

An operation list may hold up to 100 operations and is applied in order.
Every operation has a unique `id` (1 to 256 characters), an optional `summary`, and a `kind`.
The supported kinds are:

- whole maps: `create_world`;
- states: `create_state`, `split_state`, `merge_states`, `move_state_provinces`, `update_state`;
- provinces: `create_province`, `split_province`, `merge_provinces`, `remove_province`, `update_province_definition`;
- strategic regions: `move_region_provinces`;
- identifiers and script references: `renumber_map_entity`, `remap_map_references`;
- derived data: `regenerate_map_positions`, `rebuild_supply`;
- adjacency: `add_normal_adjacency`, `remove_normal_adjacency`, `add_adjacency`, `remove_adjacency`;
- supply and railways: `add_supply_node`, `remove_supply_node`, `add_railway`, `remove_railway`;
- positions: `upsert_building_position`, `remove_building_position`, `upsert_unit_position`, `remove_unit_position`, `upsert_weather_position`, `remove_weather_position`;
- entity locators: `update_entity_locator`.

The complete operation schema is [map-operation.schema.json](../schemas/map-operation.schema.json).
The examples below show single operations; each goes inside the `operations` array.

## Create states

The compact `create_state` form needs selected provinces and a `displayName` or `name`:

```json
{
  "id": "create-western-state",
  "kind": "create_state",
  "provinceIds": [120, 121, 122],
  "displayName": "Western Ireland"
}
```

When all selected provinces belong to one state, the tool infers that source state, allocates the state ID, creates `STATE_<id>` localisation, divides manpower, resources, and slot buildings (factories, dockyards, refineries and other buildings that share state slots) by land-pixel share in whole units, keeps level buildings such as infrastructure, air bases, anti-air and radar at their level in both parts, carries dated history to both parts, copies owner, controller, cores, and claims, and moves province-bound records with their provinces. Supply, railway, port, victory-point, building-position, and strategic-region references remain connected.

Pass `sourceStateId`, `stateId`, `name`, `fileName`, `localisation`, or the complete distribution object when the defaults are not the intended design. `split_state` retains the explicit contract for callers that want every policy written out.

## Create provinces

The compact `create_province` form needs a source province and exact geometry:

```json
{
  "id": "create-western-province",
  "kind": "create_province",
  "sourceProvinceId": 4812,
  "geometry": {
    "kind": "rectangle",
    "origin": { "x": 2330, "y": 740 },
    "width": 12,
    "height": 9
  }
}
```

Geometry may be a rectangle, an even-odd polygon, explicit pixels, or a hash-bound raster mask. The tool allocates an unused contiguous province ID and unused RGB color after scanning game, dependencies, and mod sources. By default it inherits the source definition, state and strategic-region membership, and retains connected data on the source unless the new province itself must receive it.

Pass `provinceId`, `definition`, or the full distribution object when an exact override is needed. All selected pixels must belong to the named source province; this keeps a creation request deterministic.

## Change IDs

Use `renumber_map_entity` for `province`, `state`, or `strategic-region` IDs:

```json
{
  "id": "swap-state-ids",
  "kind": "renumber_map_entity",
  "entity": "state",
  "fromId": 12,
  "toId": 18
}
```

If the destination exists, the default behavior swaps the two IDs. Province swaps update definitions, state and region membership, victory points, province buildings, adjacency, supply nodes, railways, unit positions, building sea references, and standard province and victory-point localisation keys. State swaps update state records, standard state localisation keys, and building-position state references. Strategic-region swaps update region records, standard localisation keys, and weather-position references. Province and strategic-region operations preserve their required contiguous ID sets.

Renumbering also inspects active event, focus, decision, scripted helper, on-action, idea, character, and country-history source for typed scalar map fields. It rewrites only parsed values in `province`, `province_id`, `start_province`, `target_province`, `state`, `state_id`, `start_state`, `target_state`, `owns_state`, `controls_state`, `transfer_state`, `transfer_state_to`, `strategic_region`, and `strategic_region_id`. Other numbers, comments, and identifiers remain untouched. A matching reference in a read-only game or dependency source blocks the operation with its path and field. A script that cannot be safely parsed also blocks the operation.

Set `collision` to `reject` to require an unused destination. Set `renameLocalisation` to `false` only when custom localisation-key handling is intentional.

## Move provinces between states

`move_state_provinces` hands provinces from one state to another.
Without a `distribution` (or with `"distribution": "proportional"`) the values follow the land: the target receives the moved provinces' share of the source's land pixels of its manpower (the state's population), resources and slot buildings (factories, dockyards, refineries and the like), in whole units.
Level buildings (infrastructure, air bases, anti-air, radar) stay at their level in the source, and the target takes the higher level of the two.
Victory points and province buildings follow their province, and the moved provinces take the target's owner, controller, cores and claims because they are now part of the target.
The provinces must share the target's strategic region, or the operation stops; set `strategicRegion: "move-to-target-region"` in a full `distribution` to move them to the target's region.
Pass a full `distribution` with `stateValues: "retain-in-current-states"` to leave manpower, resources and buildings where they are, or `"proportional-by-land-pixels"` to write the automatic choice out.

```json
{
  "id": "give-province-to-neighbour",
  "kind": "move_state_provinces",
  "sourceStateId": 64,
  "targetStateId": 65,
  "provinceIds": [3314]
}
```

Nothing is lost or duplicated: for any split, merge or move, the sums of manpower, each resource and each slot building over all states are the same before and after.

## Other map changes

`hoi4.map_rewrite` also moves and merges states, moves provinces between strategic regions, merges or removes provinces, changes province definitions and types, adds or removes normal and special adjacency, and updates supply, railway, building, unit, weather, and entity-locator records. Send one ordered operation list when several connected changes belong together.

Every rewrite returns changed-area, changed-ID, semantic, affected-file, diagnostic, and rendered comparison evidence. A failed operation does not leave a partial multi-file result.

## Check script references

Set `references: true` on `hoi4.map_inspect` to also read events, focuses, decisions, scripted effects and triggers, on-actions, ideas, characters, AI strategies and areas, and country and unit history.
It reports:

- `MAP_SCRIPT_REFERENCE_MISSING`: a state, province or strategic region named by number that the map does not define, as `owns_state = 64`, `has_full_control_of_state = 64`, `transfer_state = 64`, `set_state_controller = 64`, `capital = 64`, a state scope `64 = { ... }`, a `prioritize = { 64 65 }` list, a `state`, `to_state` or `start_state` argument, a province argument such as `set_province_controller` or `province = { id = 3314 }`, a strategic region in `region = 12` or `ships_in_area`, a unit `location`, or an AI area's `strategic_regions`; an error in the mod's own files and a warning in game or dependency files;
- `MAP_STATE_TAG_UNKNOWN`: a state owner, controller, core or claim whose tag no `common/country_tags` file declares;
- `MAP_COUNTRY_CAPITAL_NOT_OWNED`: a country that owns states but has its capital in another country's state.

The data's `scriptReferences` counts the references checked and the missing ones. Numeric keys inside `random_list` and other weighted blocks are weights and are not read as states.

## Keep scripts in step with geography

`remap_map_references` rewrites the script references of one entity kind after a split, merge, removal or renumbering:

```json
{
  "id": "brandenburg-split",
  "kind": "remap_map_references",
  "entity": "state",
  "mapping": [
    { "from": 64, "to": [64, 1082] },
    { "from": 917, "to": null }
  ],
  "readOnlySources": "override"
}
```

One target replaces the number. Several targets keep the first and copy the whole referencing assignment for each further target, so `64 = { add_core_of = ROOT }` becomes one block per successor and `owns_state = 64` becomes one condition per successor. In a list such as `prioritize = { 64 65 }` the extra targets join the list.
Keys that take exactly one value (`capital`, `state`, `to_state`, `start_state`, `province`, `region` and the like) are never copied or deleted: they change to the first target, and when their state has no successor they stay as they are and are reported as `MAP_REFERENCE_NEEDS_REVIEW` with the file and line, so that you choose the new target. They also remain visible to `references: true`. `null` removes the referencing assignment. Game and dependency files are never edited: with `readOnlySources: override` the files that need the change are copied into the mod with it, and otherwise the operation refuses and lists them. `pathPrefixes` limits the rewrite to some folders. Run it in the same request as the split so the review shows both.

`merge_states`, `create_state` and `split_state` can do this themselves: add `"remapReferences": "refuse"` (or `"override"`, which copies the game files that need it into the mod) and the merged-away states are renamed to the survivor, or the source state's references are extended to the new part, in the same plan.

## Positions and supply

`regenerate_map_positions` places building, unit-stack and weather positions from province geometry. By default (`mode: missing`) it only adds what is absent: positions for each building model a state or province lacks (from `show_on_map` and the spawn points in `common/buildings`), a full unit-stack set for provinces without one, and a small and a big weather object for strategic regions without one. `mode: replace` rewrites the positions of the selected `stateIds`, `provinceIds` and `regionIds`. Interior points keep away from province borders, naval bases face the sea province they open onto, and floating harbours sit on the water and name their land province. `positions` limits it to `buildings`, `units` or `weather`; heights come from the heightmap.

`rebuild_supply` places a supply node in a state's capital province (its `capital`, else its highest victory point, else its largest land province) and joins nodes to their country's hub, the state with the most victory points, by the cheapest railway through land that belongs to a state, preferring the country's own provinces and avoiding impassable borders. `mode: connect` (the default) handles named `stateIds`, or without them only states with a supply gap: no node within three land provinces. `mode: replace` rebuilds the whole network. `railwayLevel` (default 1) and `capitalRailwayLevel` (default 3, for lines through the hub) set railway levels.

## Create a new world

`create_world` writes a complete map for a total-conversion mod:

```json
{
  "id": "world",
  "kind": "create_world",
  "width": 2048,
  "height": 1024,
  "seed": 7,
  "landCoverage": 0.35,
  "continents": 3,
  "countries": [
    { "tag": "AUR", "name": "Aurelia" },
    { "tag": "BOR", "name": "Borea", "share": 2, "ideology": "democratic" },
    { "tag": "CAL", "name": "Calder", "color": { "r": 160, "g": 40, "b": 40 } }
  ],
  "continentNames": ["Aster", "Brum", "Corvel"]
}
```

Width and height are multiples of 256 with at most 13,238,272 pixels. Land comes from noise around `continents` centres to the requested `landCoverage`, or from `landPolygons` in pixel coordinates; the map's east-west seam and polar rows stay sea in generated worlds, while a reference picture keeps its own edges unless you set `edge` (see [Water, colour and the world edge](#water-colour-and-the-world-edge)). Provinces grow evenly from spread seeds (or follow natural lines, see [Feature-aware provinces, states and strategic regions](#feature-aware-provinces-states-and-strategic-regions)) (`landProvincePixels`, default 400, and `seaProvincePixels`, default 2,500, both capped so no province exceeds an eighth of the map), stay connected, avoid four-province corners and are at least 20 pixels. Enclosed water becomes land or, when large, a lake.

The operation writes `provinces.bmp`, `definition.csv`, `default.map`, `continent.txt`, `heightmap.bmp`, `terrain.bmp`, `rivers.bmp` (rivers run downhill to the coast), `trees.bmp`, `cities.bmp`, `world_normal.bmp`, the land and water colour maps, `adjacencies.csv`, strategic regions (`landProvincesPerRegion`, `seaProvincesPerRegion`) with weather by latitude, states (`provincesPerState`) with population, category, buildings, resources, victory points and ports, country tags, country files, history and three-band flags, a bookmark, localisation, and every position, supply node and railway. Countries grow from spread-out capitals in proportion to `share`; each state lies within one country and one strategic region.

With `replaceBaseGame` (default `true`) it adds `replace_path` lines for `history/states`, `history/countries`, `history/units`, `map/strategicregions`, `map/supplyareas` and `common/bookmarks` to `descriptor.mod`, and its info diagnostic reminds you that the launcher's `.mod` file beside the mod folder needs the same lines. Base-game events, focuses and decisions still name base-game states; `map_inspect` with `references: true` lists them for replacement or remapping. The same seed always gives the same world. Refine it with the other operations.

### Feature-aware provinces, states and strategic regions

By default provinces grow evenly from spread seeds and states and regions grow by breadth-first clusters, which ignore rivers, ridges and shores. Set `partition: "feature-aware"` (default `legacy`; a world given a `geography` defaults to it) to cut along natural lines instead (ADR 0058, plan section C9):

- Province borders are pulled onto rivers, steep slopes and ridges, wall ranges and lake shores (a watershed whose step cost rises on them). A province that still straddles a river or wall is cut along it.
- Province size follows the land: small in fertile valleys, on coasts and beside rivers, large on mountains and wasteland (`landArea.fertile`, `hills`, `mountain`, `waste`, in pixels), and per geography region through its `density.provinceAreaPx`. Without bands they follow `landProvincePixels` (0.35, 1, 2.2 and 3.4 times, scaled so the mean stays `landProvincePixels`). Sea provinces are small near a coast and large on the open sea (`seaArea.coastal` and `open`, from `seaProvincePixels`), and a channel no wider than `narrowStraitPx` (24) gets two sea provinces across it.
- States and strategic regions are clusters over the province graph that avoid joining across rivers and ranges, prefer like ground, never mix geography regions or named seas, and respect `provincesPerState` (`[smallest, largest]`, or a region's own `density.provincesPerState`) and `regionSize`.
- `barrierStrength` (0 to 60, default 20) sets how hard borders are pulled onto natural lines; `minProvincePixels` (default 40) is the smallest planned province.

```json
{
  "id": "world",
  "kind": "create_world",
  "width": 5120,
  "height": 2560,
  "partition": "feature-aware",
  "landProvincePixels": 400,
  "partitionTuning": {
    "landArea": { "fertile": 120, "hills": 400, "mountain": 800, "waste": 1100 },
    "provincesPerState": [6, 12],
    "barrierStrength": 24
  }
}
```

All the engine rules hold as before: provinces are connected, no box exceeds an eighth of the map, no four provinces meet at a corner, provinces are at least 20 pixels where a same-kind neighbour exists, and at most 65,000 exist. A plan that needs more than 21,000 provinces is refused with `MAP_PARTITION_PROVINCE_COUNT_HIGH` and the fields to change; both partitions warn with that code above 14,000 provinces. Contradictory bands (`MAP_PARTITION_AREA_BANDS_CONTRADICTORY`), reversed ranges, a map too small for `minProvincePixels` (`MAP_PARTITION_MAP_TOO_SMALL`) and `partitionTuning` with `legacy` are refused before anything is written. Info notes report the provinces cut along rivers or straits (`MAP_PARTITION_SPLITS`) and coast pixels adjusted because a 2 x 2 block touched its own kind only at a corner (`MAP_PARTITION_MASK_SMOOTHED`). Check the result with `hoi4.map_inspect` and `quality: true` (border naturalness).

Code that needs the same cut calls `partitionWorld` (`src/hoi4_agent_tools/map/partition.ts`): it takes `PartitionFields` (distance to river, ridge strength, slope, terrain class, region id, fertility and a barrier mask; `partitionFieldsFromBitmaps` computes a basic version from `heightmap.bmp`, `terrain.bmp` and `rivers.bmp`, `partitionFieldsFromGeography` adds regions and walls) and returns the provinces, the barrier raster, the size distribution and a weighted province graph (`buildProvinceGraph`, `provinceEdgeCosts`) that the territory assignment service reuses.

Measured on project-owned synthetic fixtures: a 1,024 x 512 world with a dense river net goes from province and state border enrichment 1.02 and 0.98 to 1.34 and 2.22 (natural share of state borders from 0.24 to 0.55). On a 5,120 x 2,560 fixture (400 and 2,500 pixel provinces) the legacy partition has 25,514 provinces and enrichment 0.97 and 0.90, the feature-aware one 17,061 (land mean 399 pixels, p10 228, p90 507; sea mean 2,345) and enrichment 1.75 and 3.38; it partitions in about 9 seconds and 0.8 GiB, and the whole `create_world` takes about 20 seconds. Province borders cannot be more enriched than the length of the natural lines allows; the numbers are in ADR 0058.

## Water, colour and the world edge

Three behaviours shape how a generated map looks in the game. The tool computes them offline from the engine's own formulas; it never runs the game, so the first in-game look still needs your review.

### Lakes

The engine draws water everywhere with an opacity that depends on the heightmap: a pixel at height 91 or lower is fully opaque, 93 is 56% opaque and 95 or higher is invisible. Every `create_world` therefore writes lake interiors at the sea height 89, with a one to two pixel bank toward the shore (93, then 91), and gives lake pixels the graphical terrain of the ocean (index 15 in the base game). A graphical terrain entry with `texture = 255`, such as the base game's `lakes` entry, names no atlas tile and is never chosen for a category.

Water that does not read as a lake is not written as one. Enclosed water below 60 pixels becomes land (`MAP_LAKE_TOO_SMALL`), and lake water that touches the open sea becomes sea (`MAP_LAKE_CONNECTED_TO_SEA`). Both appear as warnings with the pixel count and a location, so a reference picture's pond is never silently lost. The water colour maps use a shelf-to-deep gradient fitted to the base game and a lighter lake tint. This changes the output of every request that has lakes; the old output was a defect (see the changelog).

### Colour map and graphical terrain

`colormap.profile` is `legacy` (the original flat tints, kept so existing requests do not change) or `calibrated`. `look` (`vanilla-temperate`, `fertile`, `arid` or `custom`) chooses a palette set and selects the calibrated profile; `custom` needs `colormap.palette` with `{ "plains": { "r", "g", "b" }, ... }` for any of plains, farmland, forest, hills, desert, mountain, marsh, jungle, snow, urban, lakes and ocean. The calibrated map follows the base game's measurements (land mean value about 74, over a thousand distinct colours): dark class colours varied by low-frequency noise, hillshade, wetness and a slow hue drift, with permanent snow tinted as snow instead of plains. It also writes farmland (index 5) on wet flat plains, sparse forest (4) in thinned forest and grassy mountain (20) on wet mountains, when the active terrain files define those indices.

```json
{
  "id": "world",
  "kind": "create_world",
  "reference": { "imagePath": "references/world.png" },
  "look": "fertile",
  "edge": {},
  "ambientFrame": true
}
```

### The world edge

The engine wraps the map horizontally, so land that touches the first or last column is cut by a straight line where the world repeats. Without `edge` nothing changes and validation reports `MAP_EDGE_LAND_CUT` for such rows. With `edge`:

| `edge` field | Default                                                     | Meaning                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`       | `sea-band` when `edge` is given                             | `sea-band` clears land from the east and west edges and the poles to open sea with a ragged outline; `rim` ends land at the seam in an impassable snow range; `none` opts out.     |
| `bandPx`     | `max(192, 4% of the width)`, at most a quarter of the width | East and west sea band.                                                                                                                                                            |
| `polarPx`    | 64, at most a quarter of the height                         | North and south sea band.                                                                                                                                                          |
| `rimPx`      | 160, at most a quarter of the width                         | Width of the rim range for `rim`. Heights rise from 150 to 230, the colour map darkens and `adjacencies.csv` gets one `impassable` row per pair of land provinces across the seam. |

A band wider than a quarter of the world is refused (`MAP_EDGE_BAND_TOO_WIDE`). A city inside a band that would be cleared is an error (`MAP_EDGE_FEATURE_IN_BAND`) naming it; land that is cleared is reported with its pixel count (`MAP_EDGE_LAND_CLEARED`). `ambientFrame: true` writes the north and south frame borders and the logo frame into `ambient_object.txt` at the base map's positions scaled to the world height (the north frame at `z = height + 142`, the south frame at `z = -140`); by default the file is a comment, which drops the frame. The wrap cannot be removed with data; the band makes it invisible and the rim makes it a wall. Which looks better in the game is for you to judge with a probe map. Rivers are routed before the rim is raised, so keep them out of a rim.

### Appearance validation

`hoi4.map_inspect` and every `create_world` check the files that decide the look, for the files the mod ships: `heightmap.bmp`, `terrain.bmp`, `rivers.bmp`, `trees.bmp`, `cities.bmp`, `world_normal.bmp` and the colour maps. Format and size defects are errors; statistical deviations are warnings. Severities are set so the installed base game raises no error.

| Code                                                                                   | Severity         | Meaning                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAP_LAKE_SURFACE_TOO_HIGH`                                                            | error or warning | Lake pixels above height 91 away from the shore; an error when more than 5% of the lake.                                                                                       |
| `MAP_LAKE_TEXTURE_UNRENDERED`                                                          | error            | A pixel uses a graphical terrain with `texture = 255`.                                                                                                                         |
| `MAP_LAKE_TOO_SMALL`, `MAP_LAKE_CONNECTED_TO_SEA`, `MAP_HEIGHT_LAKE_ABOVE_SURFACE`     | warning          | A lake body under 60 pixels, a lake province bordering the sea, lake pixels at or above the water surface.                                                                     |
| `MAP_HEIGHT_FORMAT`, `_SIZE`, `_LAND_BELOW_COAST`, `_SEA_ABOVE_SURFACE`, `_SEAM_STEP`  | error or warning | Heightmap depth and size, land under 94, sea above 94 and a step between the first and last column.                                                                            |
| `MAP_TERRAIN_BITMAP_FORMAT`, `_SIZE`, `_INDEX_UNDEFINED`                               | error or warning | Terrain bitmap depth, size and palette indices no `common/terrain` entry defines (an error when widespread).                                                                   |
| `MAP_RIVER_FORMAT`, `_SIZE`, `_INDEX_INVALID`, `_BLOCK`                                | error            | River bitmap depth, size, indices other than 0 to 11, 254 and 255, and 2 x 2 blocks of river pixels (a warning when rare).                                                     |
| `MAP_RIVER_PALETTE_COUNT`, `_NOT_ORTHOGONAL`, `_SOURCE_COUNT`, `_ON_WATER`, `_DENSITY` | warning          | Header colour count other than 0, pixels with no orthogonal river neighbour, rivers without exactly one source, river pixels on sea, more than 2.5% of land or 130,000 pixels. |
| `MAP_TREES_FORMAT`, `_SIZE`, `_INDEX_INVALID`, `_ON_WATER`                             | error or warning | Tree bitmap depth, size (75/256 of the map), indices beyond the palette and trees over open water.                                                                             |
| `MAP_COLORMAP_SIZE`                                                                    | error            | A colour map that is not half (land) or 1/2, 1/4, 1/8 (water) of the province map.                                                                                             |
| `MAP_COLORMAP_RANGE`, `MAP_WATER_COLORMAP_FLAT`                                        | warning          | Land mean value outside 50 to 100, fewer than 400 distinct 5-bit colours or a deviation under 15; a flat water map.                                                            |
| `MAP_NORMAL_SIZE`, `_NOT_UNIT`, `_RESPONSE`, `MAP_CITIES_SIZE`, `_INDEX_UNDEFINED`     | error or warning | Normal map size and unit length, its response to the height step (the base game's is about 2.6) and the city map.                                                              |
| `MAP_EDGE_LAND_CUT`                                                                    | warning or error | Land on the first or last column; an error when the world was created with `sea-band`.                                                                                         |
| `MAP_SEAM_LAND_ADJACENCY`, `MAP_POLAR_LAND`, `MAP_COLORMAP_ALPHA_CITY`                 | info             | Land provinces that meet across the seam (and how many are blocked), land in the top and bottom rows, city lights over water.                                                  |

Not implemented: a check that river widths never narrow downstream (it needs a flow direction the file does not hold), and a mesh check for `trees.bmp` beyond the declared palette. Bitmaps are read in row strips and validation yields between strips, so a 13-million-pixel map stays cancellable and within memory.

## Worked example: build a world, then reshape it

1. Create the world. The same seed always gives the same world.

   ```json
   {
     "operations": [
       {
         "id": "world",
         "kind": "create_world",
         "width": 1024,
         "height": 512,
         "seed": 11,
         "countries": [
           { "tag": "AUR", "name": "Aurelia" },
           { "tag": "BOR", "name": "Borea", "share": 2 }
         ]
       }
     ]
   }
   ```

2. Inspect it. `hoi4.map_inspect` with `references: true` lists scripts that still name base-game states. Fix those with `remap_map_references` (to a new state) or by replacing the script.

3. Reorganise in one request. The merge folds state 12 into state 11 and rewrites every script that named 12; the move gives one province to a neighbour with its share of population, resources and factories.

   ```json
   {
     "operations": [
       {
         "id": "merge",
         "kind": "merge_states",
         "targetStateId": 11,
         "sourceStateIds": [12],
         "remapReferences": "override"
       },
       {
         "id": "move",
         "kind": "move_state_provinces",
         "sourceStateId": 11,
         "targetStateId": 13,
         "provinceIds": [402]
       }
     ]
   }
   ```

4. Repair what a change leaves behind. `rebuild_supply` joins new or changed states to their country's supply network, `regenerate_map_positions` adds missing building, unit and weather positions, and `hoi4.map_inspect` with `references: true` must report no `MAP_SCRIPT_REFERENCE_MISSING` and no `MAP_REFERENCE_NEEDS_REVIEW` follow-ups before the mod is released.

`tests/unit/map-reorganise.test.ts` runs this sequence on a generated world and checks that totals of manpower, resources and factories are unchanged.

## Dated state history

Map inspection reads active `common/bookmarks/*.txt` sources and uses the earliest valid bookmark date as the state-history basis. Supported owner, controller, core, claim, victory-point, and building commands in earlier dated blocks contribute to the inspected state and its rendered owner or controller layer. If no bookmark date is available, dated state fields retain their direct values and inspection reports `MAP_STATE_DATED_HISTORY_UNRESOLVED`.

Map rewrites preserve dated source blocks byte-for-byte. An update to a field overridden by an applicable dated block returns `MAP_DATED_STATE_HISTORY_CONFLICT`. Province membership changes also block when a dated victory point or building entry would need remapping. A split divides dated blocks like the undated values: dated ownership, cores and other effects apply to both parts, dated victory points and province buildings follow their provinces, level buildings keep their level and slot buildings divide by the same land share. A merge carries the source states' dated blocks into the target, but refuses a source whose dated history sets building levels (`MAP_DATED_STATE_DISTRIBUTION_UNSUPPORTED`), because each part's later value replaces its own and the two cannot be combined; move those provinces with `move_state_provinces` or edit the block first. A merge keeps the highest level building and sums slot buildings, and its distribution policy may be omitted. A direct edit with only later dated changes may proceed; those later commands remain and can supersede the direct value at later bookmarks. Edit the dated source deliberately when that later behavior is the intended change.

`floating_harbor` placement rows differ from fixed `naval_base_spawn` ports. Their XYZ coordinates normally identify a sea placement, while the final numeric field names a land target. The map catalog does not count floating-harbor placements as starting naval-base locators. A missing or non-land target is an error. An off-sea position or an unusual state/coastal association is a review warning because those patterns also occur in installed vanilla map data; the warning retains the exact source line.

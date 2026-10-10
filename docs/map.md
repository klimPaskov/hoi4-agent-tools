# Maps

Use `hoi4.map_inspect` and `hoi4.map_rewrite` for provinces, states, strategic regions, adjacency, supply nodes, railways, positions, ownership, cores, claims, resources, buildings, and localisation.

## Inspect and navigate the complete map

`hoi4.map_inspect` validates the map and returns a full-map PNG plus a searchable, clickable HTML navigator by default. The navigator supports pan, zoom, fit-to-map, search by numeric ID, localisation key, or localised name, and exact click lookup for province, state, and strategic-region IDs. Hovering reports both top-left bitmap coordinates and bottom-left HOI4 map coordinates.

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

Give `hoi4.map_inspect` a `layer`, `overlays`, `scale`, `tile` or `area` to render that view instead of validating; the result is the same complete catalog and navigator drawn with the chosen base layer and overlays, and lookups (`query`, `coordinates`, IDs) belong in a separate call. Base layers include province, state, strategic region, terrain, continent, owner, controller, cores, claims, and coast. Overlays include coastlines, ports, victory points, resources, state and province buildings, supply nodes, railways, adjacencies, and building, unit, and weather positions.

A rendered view takes `layer` (default `province`), up to 12 `overlays`, and an integer `scale` from 1 to 16 (default 1).

Pass `tile: { x, y, width, height }` for a reusable bounded PNG, JSON, and HTML view of one top-left bitmap area. The tile preserves the selected base layer and overlays, and its JSON records raster dimensions and province IDs in the area. Identical source revisions and render settings produce identical artifact hashes.

Pass `area: { provinceIds, stateIds, regionIds, padding }` to render the exact bounding area of those map entities with optional pixel padding. The result reports the resolved tile coordinates. An unknown ID or an area larger than 2,048 pixels in either direction is explicit, so a narrower selection can be requested.

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

## Other map changes

`hoi4.map_rewrite` also moves and merges states, moves provinces between strategic regions, merges or removes provinces, changes province definitions and types, adds or removes normal and special adjacency, and updates supply, railway, building, unit, weather, and entity-locator records. Send one ordered operation list when several connected changes belong together.

Every rewrite returns changed-area, changed-ID, semantic, affected-file, diagnostic, and rendered comparison evidence. A failed operation does not leave a partial multi-file result.

## Check script references

Set `references: true` on `hoi4.map_inspect` to also read events, focuses, decisions, scripted effects and triggers, on-actions, ideas, characters, AI strategies and areas, and country and unit history.
It reports:

- `MAP_SCRIPT_REFERENCE_MISSING`: a state, province or strategic region named by number that the map does not define, as `owns_state = 64`, as a state scope `64 = { ... }`, as a country `capital`, a unit `location`, or an AI area's `strategic_regions`; an error in the mod's own files and a warning in game or dependency files;
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

One target replaces the number. Several targets keep the first and copy the whole referencing assignment for each further target, so `64 = { add_core_of = ROOT }` becomes one block per successor and `owns_state = 64` becomes one condition per successor. `null` removes the referencing assignment. Game and dependency files are never edited: with `readOnlySources: override` the files that need the change are copied into the mod with it, and otherwise the operation refuses and lists them. `pathPrefixes` limits the rewrite to some folders. Run it in the same request as the split so the review shows both.

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

Width and height are multiples of 256 with at most 13,238,272 pixels. Land comes from noise around `continents` centres to the requested `landCoverage`, or from `landPolygons` in pixel coordinates; the map's east-west seam and polar rows stay sea. Provinces grow evenly from spread seeds (`landProvincePixels`, default 400, and `seaProvincePixels`, default 2,500, both capped so no province exceeds an eighth of the map), stay connected, avoid four-province corners and are at least 20 pixels. Enclosed water becomes land or, when large, a lake.

The operation writes `provinces.bmp`, `definition.csv`, `default.map`, `continent.txt`, `heightmap.bmp`, `terrain.bmp`, `rivers.bmp` (rivers run downhill to the coast), `trees.bmp`, `cities.bmp`, `world_normal.bmp`, the land and water colour maps, `adjacencies.csv`, strategic regions (`landProvincesPerRegion`, `seaProvincesPerRegion`) with weather by latitude, states (`provincesPerState`) with population, category, buildings, resources, victory points and ports, country tags, country files, history and three-band flags, a bookmark, localisation, and every position, supply node and railway. Countries grow from spread-out capitals in proportion to `share`; each state lies within one country and one strategic region.

With `replaceBaseGame` (default `true`) it adds `replace_path` lines for `history/states`, `history/countries`, `history/units`, `map/strategicregions`, `map/supplyareas` and `common/bookmarks` to `descriptor.mod`, and its info diagnostic reminds you that the launcher's `.mod` file beside the mod folder needs the same lines. Base-game events, focuses and decisions still name base-game states; `map_inspect` with `references: true` lists them for replacement or remapping. The same seed always gives the same world, and the result is validated like any other rewrite; afterwards refine it with the other operations.

## Dated state history

Map inspection reads active `common/bookmarks/*.txt` sources and uses the earliest valid bookmark date as the state-history basis. Supported owner, controller, core, claim, victory-point, and building commands in earlier dated blocks contribute to the inspected state and its rendered owner or controller layer. If no bookmark date is available, dated state fields retain their direct values and inspection reports `MAP_STATE_DATED_HISTORY_UNRESOLVED`.

Map rewrites preserve dated source blocks byte-for-byte. An update to a field overridden by an applicable dated block returns `MAP_DATED_STATE_HISTORY_CONFLICT`. Province membership changes also block when a dated victory point or building entry would need remapping. A split divides dated blocks like the undated values: dated ownership, cores and other effects apply to both parts, dated victory points and province buildings follow their provinces, level buildings keep their level and slot buildings divide by the same land share. A merge carries the source states' dated blocks into the target, but refuses a source whose dated history sets building levels (`MAP_DATED_STATE_DISTRIBUTION_UNSUPPORTED`), because each part's later value replaces its own and the two cannot be combined; move those provinces with `move_state_provinces` or edit the block first. A merge keeps the highest level building and sums slot buildings, and its distribution policy may be omitted. A direct edit with only later dated changes may proceed; those later commands remain and can supersede the direct value at later bookmarks. Edit the dated source deliberately when that later behavior is the intended change.

`floating_harbor` placement rows differ from fixed `naval_base_spawn` ports. Their XYZ coordinates normally identify a sea placement, while the final numeric field names a land target. The map catalog does not count floating-harbor placements as starting naval-base locators. A missing or non-land target is an error. An off-sea position or an unusual state/coastal association is a review warning because those patterns also occur in installed vanilla map data; the warning retains the exact source line.

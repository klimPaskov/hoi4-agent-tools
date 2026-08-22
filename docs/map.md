# Maps

Use `hoi4.map_inspect`, `hoi4.map_render`, and `hoi4.map_rewrite` for provinces, states, strategic regions, adjacency, supply nodes, railways, positions, ownership, cores, claims, resources, buildings, and localisation.

## Inspect and navigate the complete map

`hoi4.map_inspect` validates the map and returns a full-map PNG plus a searchable, clickable HTML navigator by default. The navigator supports pan, zoom, fit-to-map, search by numeric ID, localisation key, or localised name, and exact click lookup for province, state, and strategic-region IDs. Hovering reports both top-left bitmap coordinates and bottom-left HOI4 map coordinates.

The linked JSON catalog contains every active province definition, state, and strategic region with resolved names, alternate localisation values, source paths and lines, raster bounds and centers, memberships, neighbors, victory points, resources, buildings, ports, supply nodes, railways, normal and special adjacencies, building positions, unit positions, weather positions, and entity locators. Large catalog and render data remain in MCP resources instead of filling the agent prompt.

Use `query` for a compact name or ID result list and `coordinates` for exact pixel or map-coordinate lookup. Use `provinceIds`, `stateIds`, and `regionIds` for focused records. Up to 32 selected provinces can also produce exact geometry as maximal `[y, startX, endXExclusive]` row runs.

`hoi4.map_render` creates the same complete catalog and navigator with a chosen base layer and overlays. Base layers include province, state, strategic region, terrain, continent, owner, controller, cores, claims, and coast. Overlays include coastlines, ports, victory points, resources, state and province buildings, supply nodes, railways, adjacencies, and building, unit, and weather positions.

## Create states

The compact `create_state` form needs selected provinces and a display name:

```json
{
  "id": "create-western-state",
  "kind": "create_state",
  "provinceIds": [120, 121, 122],
  "displayName": "Western Ireland"
}
```

When all selected provinces belong to one state, the tool infers that source state, allocates the state ID, creates `STATE_<id>` localisation, divides manpower, resources, and state buildings by land-pixel share, copies owner, controller, cores, and claims, and moves province-bound records with their provinces. Supply, railway, port, victory-point, building-position, and strategic-region references remain connected.

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

Set `collision` to `reject` to require an unused destination. Set `renameLocalisation` to `false` only when custom localisation-key handling is intentional.

## Other map changes

`hoi4.map_rewrite` also moves and merges states, moves provinces between strategic regions, merges or removes provinces, changes province definitions and types, adds or removes normal and special adjacency, and updates supply, railway, building, unit, weather, and entity-locator records. Send one ordered operation list when several connected changes belong together.

Every rewrite returns changed-area, changed-ID, semantic, affected-file, diagnostic, and rendered comparison evidence. A failed operation does not leave a partial multi-file result.

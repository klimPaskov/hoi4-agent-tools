# Maps

Use `hoi4.map_inspect`, `hoi4.map_render`, and `hoi4.map_rewrite` for provinces, states, strategic regions, adjacency, supply nodes, railways, positions, ownership, cores, claims, resources, buildings, and localisation.

## Create or reshape map content

Map changes may add, split, merge, remove, or redefine provinces and states; update strategic regions; edit normal or special adjacency; and update supply, railway, building, unit, or weather positions.

Geometry must be exact. Use existing province IDs, integer polygon boundaries with the required fill rule, a validated raster mask, or explicit pixels. Natural-language geography can guide an agent, but it is not rewrite geometry.

Pass up to 32 `provinceIds` to `hoi4.map_inspect` to receive a linked exact-geometry JSON artifact. It records the active map dimensions, unknown IDs, and each known province as maximal `[y, startX, endXExclusive]` runs sorted in top-left raster order. Derive a bounded pixel subset or mask from those runs before calling `hoi4.map_rewrite`; row runs are inspection evidence, not a rewrite geometry kind.

For state or province moves, splits, merges, removals, or type changes, explicitly state what happens to applicable data:

- state membership and strategic region membership;
- manpower, resources, buildings, and victory points;
- owner, controller, cores, and claims;
- ports, supply nodes, and railways;
- building, unit, weather, and entity positions;
- normal and special adjacency;
- state localisation.

Build one ordered list of exact operations, call `hoi4.map_rewrite`, and review its before, proposed, and changed-area evidence. Then inspect and render the result.

## Inspect and clean a map

1. Inspect the affected map area and read reference diagnostics.
2. Render a baseline with the relevant province, state, region, terrain, coastline, supply, railway, ownership, or building overlays.
3. Build one ordered list of exact repair operations.
4. Supply every required geometry and data-movement choice.
5. Rewrite, then inspect and render the result.

Common cleanup work includes duplicate IDs or colors, bitmap/definition mismatches, invalid state or region membership, broken adjacency, missing localisation, disconnected province geometry, invalid ports or victory points, and stale supply or railway references.

The map tools do not infer a corridor, choose a replacement province, redistribute state data, reconnect a railway, or move a port without an explicit instruction. ID and color allocation checks the configured game, dependencies, and mod before choosing a value.

## Review boundary

Map renders are offline evidence. Final inspection checks that references remain valid and changes stay within the declared geometry. Unsupported or ambiguous changes stop with a blocker instead of applying a partial substitute.

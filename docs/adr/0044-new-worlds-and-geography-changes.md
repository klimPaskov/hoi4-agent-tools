# ADR 0044: New worlds and geography changes that keep the rest of the mod consistent

## Context

Map rewrites could split, merge and renumber states and provinces in an existing map, but a mod that wanted its own world had to draw every file by hand, and a geography change left three kinds of work undone:

- Building, unit and weather model positions, supply nodes and railways had to be placed by hand for every new state or province.
- Events, focuses, decisions, scripted helpers, country history and AI areas that named a split, merged or removed state still named the old number, often in base-game files the mod cannot edit.
- A state split divided levels such as infrastructure between the parts and wrote fractional building counts, and a state with dated history (about a fifth of the base-game states) could not be split at all.

## Decision

`hoi4.map_rewrite` gains four operations and `hoi4.map_inspect` one check:

1. `create_world` generates a complete map from a compact description: dimensions, seed, land coverage or outlines, province, state and region sizes, and countries with their shares. It writes the province bitmap and definitions, heightmap, terrain, rivers, trees, cities, normal map, colour maps, continents, strategic regions with latitude-based weather, states with population, buildings, resources and victory points, country files, history, flags, a bookmark, localisation, and `replace_path` entries in `descriptor.mod` for the base-game folders it replaces. Positions and the supply network come from the same planners as the repair operations. Generation is deterministic for a seed and validated like any other rewrite.
2. `regenerate_map_positions` adds missing building, unit-stack and weather positions, or rewrites them for a selection, from province geometry: interior points away from borders, coastal points facing the sea province a port opens onto, and floating harbours on the water naming their land province.
3. `rebuild_supply` gives states a supply node in their capital province and joins nodes to their country's hub by the cheapest railway through the country's own land. Without named states it only repairs supply gaps: states with no node within three provinces.
4. `remap_map_references` rewrites script references to states, provinces or strategic regions. One target replaces the number; several targets copy the referencing assignment once per target; `null` removes it. Base-game and dependency files are copied into the mod with the change only when `readOnlySources: override` is given.
5. `map_inspect` with `references: true` reports script references to undefined states, provinces and regions, state owners, controllers, cores and claims whose tag no `common/country_tags` file declares, and countries that own states but have their capital elsewhere.

State splits keep level buildings (any building without `shares_slots` in `common/buildings`, or infrastructure, air base, anti-air and radar when no definitions are present) in both parts and divide slot buildings and resources in whole units; merges keep the highest level and sum slot buildings. Dated history blocks are divided the same way: ownership and other dated effects apply to both parts, and victory points and province buildings follow their provinces.

## Consequences

A new world replaces `history/states`, `history/countries`, `history/units`, `map/strategicregions`, `map/supplyareas` and `common/bookmarks` in the base game. Base-game events, focuses and decisions that name base-game states still load; `map_inspect` with `references: true` lists them, and the mod either replaces those folders too or remaps the references.

The launcher reads `replace_path` from the `.mod` file beside the mod folder, which is outside the workspace; the rewrite reports the lines that file needs.

Merges still refuse a source state whose dated history sets buildings, because a dated `buildings` block sets absolute levels and two parts' dated values cannot be combined without knowing which applied first.

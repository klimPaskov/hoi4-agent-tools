# ADR 0079: Painted relief and impassable land

## Context

An owner reviewed a generated world in the game. They found its mountains barely visible and the ground rough. They wanted the map to work as a strategic board: high ranges and rough ground that no army may enter, crossed only at a few guarded passes.

The two inputs describe mountains differently. The geography model's ranges approximate drawn mountains with polylines and half-widths. A palette-classified reference picture says, pixel by pixel, where the mountains are. Range lines with `barrier: "impassable"` already block borders across them (ADR 0062). But whole areas could not be made impassable, and nothing checked that impassable land left every realm a way out.

The base game, measured over its land provinces (1.19.4.1, `reliefStatistics`):

| Land               | Median | 90th percentile | 99th percentile | Maximum | Mean step |
| ------------------ | ------ | --------------- | --------------- | ------- | --------- |
| All land           | 107    |                 | 213             | 239     | 2.69      |
| Mountain provinces | 129    | 172             | 223             |         |           |
| Hills provinces    | 115    | 140             |                 |         |           |

Its 21 impassable states all set `impassable = yes` with `force_link_ownership_to`, category `enclave` and infrastructure 0 (for example `history/states/1022 - Interior Borneo.txt`).

## Decision

### Painted relief

`create_world.relief.painted` raises the macro relief toward the picture's mountain, hills and volcano classes. It runs before the hydrology, so the model's rivers route around the raised ground.

- **Blurring.** Each class becomes its share of every half-resolution cell, blurred over `falloffPx` (default 24). A single painted pixel lifts nothing, and class edges become slopes. At the default, the steepest macro step on a large massif is about 12 and the mean step about 1.9.
- **Heights.** Mountains rise toward `PEAK_BASE + PEAK_SPAN * peak` under ridged noise, hills under gentle noise, and volcanoes with half the falloff. A cell keeps the model's height where that is higher.
- **Snow.** Painted mountains get permanent snow above `232 - 92 * latitude^1.5`.
- **Defaults.** The peaks (0.82, 0.27, 0.9) put painted cores near the base game's mountain and hills figures. `MAP_RELIEF_SYNTHESIZED` now reports the base game's figures beside the world's.
- **Inputs.** It needs both a reference picture and a geography model; otherwise it fails with `MAP_RELIEF_PAINTED_INPUTS`. It is off by default, so earlier worlds are unchanged.

### Impassable land

Impassable land comes from two sources:

- the palette kind `impassable_mountain`, which counts as mountain for terrain, colour, snow and relief, and adds a raster mask;
- model `regions` with `impassable: true`, which is an error without polygons.

Provinces with most of their pixels in impassable land form impassable states, the same way the `wall` edge does (ADR 0061):

- `impassable = yes`, linked to the nearest passable state (counted in province steps) and owned as it is;
- category `enclave`, with nothing built.

Capitals and ports avoid impassable land. Cities and workspace capitals on it are refused with `MAP_FEATURE_IN_IMPASSABLE`. It rises toward `impassablePeak` (0.95), even when `relief.painted` is off.

### Reachability

`MAP_REALM_CUT_OFF` and `MAP_REALM_ENCLOSED` are warnings. They compare two land graphs joined by `sea` crossings: one with every province and border, and one without the impassable provinces and blocked borders. They report what impassable land alone separates.

## Consequences

Owners get dramatic, readable mountains where they painted them, and impassable massifs that behave like the base game's interior states.

Not done yet:

- A pass cut as a corridor of passable provinces through impassable land. Passes still open range lines only.
- A check that a range-line pass joins both sides. Today only a gap that joins no two provinces is reported.

How the engine draws large impassable states, and how units path around them, is not verified in the game; the tool never launches it.

Regressions:

- Painted relief on a synthetic grid: slopes, single pixels, hills, higher model ground, water, snow and determinism.
- A world whose painted block stands far above the same world without it.
- The inputs error and the option schema.
- The palette kind and its mask.
- Impassable states from paint and from a model region, their links, and the city refusal.
- The region error.
- The reach notes: land cut off, realms boxed in, islands, and a sea crossing that opens the way.

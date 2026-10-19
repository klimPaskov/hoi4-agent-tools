# ADR 0053: Lake and water rendering conventions

## Context

A generated world drew its lakes as faint patches. The engine draws a water layer over the whole map with an opacity that depends on the heightmap, not on the province type: `pdxwater.shader` computes `1 - saturate((h / 95.7 - 0.954) * 25)` on a 3 x 3 average of the heightmap, so a pixel at 91.3 or lower is fully opaque, a pixel at 93 is 56% opaque, and a pixel at 95.1 or higher is invisible. The generator wrote every lake pixel at height 93 with graphical terrain index 14. That index belongs to the `lakes` entry of `common/terrain/00_terrain.txt`, whose `texture = 255` names no atlas tile. Measured on the ZIN map: 140 lake provinces, all at height 93 and index 14, a mean water opacity of 0.555 and none above 0.9. The base game keeps 99.995% of its sea at height 89, writes 94% of its lake pixels at 91 or lower, and gives lakes the index of ocean or plains. The water colour map was a near-constant tint.

## Decision

Lake pixels are written at the sea's interior height, 89, with a one to two pixel bank toward the shore (93 for the pixel next to land, 91 for the next). The graphical index of a lake pixel is the index of the `ocean` category. `buildWorldContext` never chooses a graphical terrain entry with `texture = 255` as the representative of a category, records the entry with its reason in `unrenderedTerrain`, and lists every entry in `terrainEntries` so later stages can look variants up. Without terrain files the default numbering gives lakes index 15.

`waterAlpha(height)` in `map/water.ts` is the shared implementation of the engine formula, used by the validators and by tests that must not trust the generator.

Water that does not read as a lake is not written as one. Enclosed water below 60 pixels becomes land (`MAP_LAKE_TOO_SMALL`), and lake water that touches the open sea becomes sea (`MAP_LAKE_CONNECTED_TO_SEA`). Both are reported as warnings with the pixel count and a location. Lake provinces keep the definition type `lake` and terrain `lakes`; the height decides what is drawn.

The water colour map follows the base game: the sea tint is a piecewise-linear function of the distance to land, fitted to the means measured in `colormap_water_0.dds` (bright over the shelf, 83,130,175 at 5 to 10 pixels; dark in the deep, 34,57,78 beyond 160), varied by deterministic large-scale noise; lakes use the base game's lake tint (58,102,147) with a lighter shore gradient. The three levels stay at half, quarter and eighth of the map size in uncompressed 32-bit DDS. A darkening hook lets the world edge policy (ADR 0061) paint the seam in the deepest tint.

Validation reads the written files. `MAP_LAKE_SURFACE_TOO_HIGH` is an error when more than 5% of lake pixels stand above 91 beyond the bank, and a warning for a few stray pixels (the base game has about 0.1%). `MAP_LAKE_TEXTURE_UNRENDERED` is an error for any pixel of an index whose terrain entry has `texture = 255`. `MAP_HEIGHT_LAKE_ABOVE_SURFACE`, `MAP_LAKE_TOO_SMALL` (counted per lake body, not per province), `MAP_LAKE_CONNECTED_TO_SEA` and `MAP_WATER_COLORMAP_FLAT` are warnings. Severities are calibrated so the installed base game raises no error.

## Consequences

The lake fix changes the heightmap, terrain bitmap and water colour maps of every `create_world` request that has lakes, not only of requests that opt in: the old output was a defect, not a style. The changelog says so. Everything else in an old request, including all province, state and country output, is unchanged for a seed.

The bank differs from the plan's first sketch (93 to 95 over three pixels). A bank that wide leaves a lake of ordinary size below the 0.95 mean opacity that the acceptance checks require, and the 3 x 3 average in the shader already softens the shore. The look in the game is derived from the shader, not observed (unverified); the owner probe maps in the plan settle it. Whether the engine lets ships or ports use a `lake` province is also unsettled, so inland seas stay a design question for the geography model.

Regressions: alpha and height tests against an independent copy of the engine formula, texture-255 exclusion in the world context, lake floor and sea-contact normalisation, determinism, and negative validator tests that inject height 93 and index 14.

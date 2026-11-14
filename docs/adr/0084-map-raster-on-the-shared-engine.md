# ADR 0084: The province raster on the shared engine, and what step 4 of M-8 moves

Status: accepted

## Context

Maintainer decision M-8 moves the server's heavy work onto the shared Rust engine (ADR 0074) in a set order. Steps 1 to 3 are done (ADR 0080, 0082 and 0083). Step 4 is "the map hot paths, then the remaining analyzers". Before choosing what moves, the slow calls of the real benchmark were profiled with V8's CPU profiler on the benchmark machine (Ryzen 5 7500F, 32 GB):

- **A full `hoi4.map_inspect` of the game** (27 s of CPU) spent 8.7 s in `landDistanceField` for the lake check of the heightmap, 4 s in the province geometry checks (4-connected parts 2 s, holes, thin runs), 2 to 3.5 s building a symbol index the map never read, 1.4 s building the province raster and 1.4 s rendering.
- **`hoi4.event_inspect` `state_flow` on Chaos Redux** (141 s) spent about 60 s hashing canonical JSON and 22 s collecting garbage. Parsing took 7.5 s and the TypeScript symbol index 6 s.

Most of that time is not work that Rust would do better. It is work that should not happen. The unused index, a `z.json()` pass over every checkpoint (25 s), about 3 GB of conditions hashed inline in the event graph hash, and a lake distance flood across every sea pixel to answer "farther than three pixels from land?" are removed in TypeScript (pull requests 169 and 171). Porting them would have kept the waste in another language.

What remains on the map path is per-pixel work over the 11.5 million pixels of the game's `provinces.bmp`. TypeScript does it with string-keyed `Map` lookups and per-pixel allocations, and runs the geometry checks as generators that yield at every pixel.

## Decision

**The province raster and the geometry checks move to the engine.** `hoi4_engine::map_provinces` ports `buildProvinceRaster` (province per pixel, extent and coordinate sums, neighbours, pairs that touch only across the wrapping seam, colours without a definition, coastal provinces) and the three geometry checks of `validation.ts` (4-connected parts wrapping sideways, holes from the digital Euler characteristic, one-pixel-thin runs). Every list keeps the iteration order of the TypeScript `Map` or `Set` it replaces, because later steps iterate them and their order reaches diagnostics.

**The server sends the decoded bitmap.** `BmpImage.decode` stays in TypeScript, with its header checks and its byte preservation for rewrites. The request (`hoi4-map-provinces-request/1`) carries the bitmap's bytes and where its pixels are (size, row order, bit depth, pixel offset, row stride, palette), the defined colours with their province ids, and each definition's type. The answer (`hoi4-map-provinces/1`) is a JSON line and then the province ids as little-endian 32-bit integers, so 46 MB of ids travel without JSON. A palette index outside the palette is `MAP_BMP_PALETTE_INDEX_INVALID` with the same pixel and index `BmpImage.rgbAt` reports.

**One synchronous call per map model.** The map model (`MapWorkspaceIndex`) is built in one synchronous pass, and its constructor needs the raster for coastal provinces and ports. It calls the one-shot `hoi4-engine map-provinces` with `spawnSync`, framed like the resident engine (ADR 0077). Only two places build a model per tool call: the scan and the projection of a rewrite. A process start costs tens of milliseconds against seconds of TypeScript. The same work is the `map.provinces` operation of `hoi4-engine serve` for a later caller that can wait asynchronously.

**No fallback.** A missing, failing or out-of-shape engine is `ENGINE_UNAVAILABLE` for every map tool that reads `provinces.bmp`. `buildProvinceRaster` and the TypeScript checks stay as the reference that tests and the parity script compare against. Validation still runs the TypeScript checks for a raster that carries no engine topology (`ProvinceRaster.topology`).

**Parity is proven on real maps.** `scripts/map-raster-parity.ts` builds the map model of the installed game and every benchmark mod and compares the engine's raster with the TypeScript one: every pixel, every map and set in iteration order, and the parts, holes and thin runs. `tests/unit/map-engine-raster.test.ts` does the same on generated bottom-up, top-down and palette maps with undefined colours, stray pixels and a thin line. The result for this change is in its pull request.

**What step 4 does not move yet.** Rendering stays in TypeScript until a render case is measured slow. The analyzers (events, technology, decisions, GUI, focus) keep their domain logic in TypeScript. Their measured cost was hashing and checkpointing, now fixed in place, and their remaining shared cost is the TypeScript symbol index, which step 5 replaces with the engine's for every analyzer at once. Moving each analyzer's domain logic into Rust is not part of M-8. A new analyzer is written on the engine from the start, as WP-8 says.

## Consequences

- A full map inspection of the game no longer spends seconds on the raster and the geometry checks. The pull request records the before and after numbers.
- Map tools need the engine, as `hoi4.mod_index` and `hoi4.source_lookup` already do, and the tests use the cargo build the test setup finds (ADR 0080).
- A change to the raster or the geometry rules must be made in both places while the TypeScript reference exists. The parity test and script show a missed one.
- `ProvinceRaster` gains the optional `topology` field.

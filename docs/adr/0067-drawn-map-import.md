# ADR 0067: Import of a drawn map: sheet registration, stable ids and authored overrides

Status: proposed (2026-10-24). No schema or code change is made before the ZIN lead has read this design (request ZR-2 in `docs/plans/zin-requests.md`).

## Context

The ZIN mod must import its owner's map of Aoaz through `hoi4.map_rewrite` (ZIN requirement R-10, acceptance A-10). Two sources are possible, and the owner has not yet chosen (ZIN question Q-04):

- **The full drawing.** One RGBA picture of 17,520 x 12,720 pixels (447 MB PNG): thirteen coloured-pencil sheets laid side by side, each at its own drawn scale and position, with sea hatching, ink labels and paper seams. The mod records twelve sheet registrations that move, scale and (for one sheet) mirror each sheet into the approved 18 October game layout of 5,120 x 2,560: per sheet a `drawingBox`, a `drawingAnchor`, a `worldAnchor` and `scaleWorldPerDrawing` (a negative x scale mirrors), registered by landmark pairs to about 80 pixels. The drawing frame is normalised, so the same numbers apply to the 3,200 x 2,323 working mosaic. Several drawing boxes overlap each other by up to 2% of the drawing (the bands at y 0.50 to 0.52 and x 0.375 to 0.40).
- **The cleaned layout.** `Aoaz-clean-v3.png`, 5,120 x 2,560 with exactly eleven flat class colours, already in the game layout.

The mod also keeps a vector geography model (`aoaz.json`: 44 seas, 89 lands, 63 ranges, 32 rivers, 12 lakes, 86 sites, 19 regions ...). It is a GeoJSON-like document of its own (`geometry` objects, extra `drawing` coordinates per feature), not the geography schema version 1 of ADR 0055.

What `create_world` does today (code read at `9ed6351`):

- One reference picture, fitted into the frame by aspect-preserving scaling with sea padding, optionally cropped by an axis-aligned box. No affine registration, no mosaic.
- Every source is first reduced to at most 3,072 pixels per side (`REFERENCE_WORKING_MAX_SIDE`). The cleaned layout would lose 40% of its width and be scaled back up; the full drawing's mirrored East sheet would be read at about half the resolution its 5,120-pixel target needs.
- A `palette` snaps every pixel to the nearest entry. An indexed picture with an unexpected colour is silently classified instead of reported.
- Province ids are numbered by the reading order of each province's first pixel; province colours, states and strategic regions are drawn from one random stream. Any change anywhere renumbers and recolours the whole world. The managed-output manifest (ADR 0052) records only paths and hashes, and regeneration refuses with `MANAGED_OUTPUT_EDITED` once any generated file was edited.
- There is no file of authored adjustments that is applied again after each generation. Reviewed `labels`, `cities` and `annotations` cover part of it, inline in the request.
- With a geography model, the picture supplies the coast and terrain classes, and the model supplies relief, rivers and partition fields. (PR 36 review: the model's regions, densities and walls do not yet reach the partition, and the heightmap can show sea under land after coast smoothing. Both are fixed in PR 36 before this work builds on it.)

A-10 requires: all layers aligned and compared with the drawing; `hoi4_map_inspect` and the validators pass; a second import with no source change writes identical files; an authored override survives a re-import; a deliberately broken input gives an accurate diagnostic; the other map workflows keep passing their tests.

## Decision

Extend `create_world`; add no new tool and no separate apply step. One call previews (`preview: true`) or writes the whole import, as every rewrite does. Everything below is optional and additive; a request without the new fields behaves byte for byte as before.

### 1. Registered reference sheets

`reference` gains `sheets` (inline) or `sheetsPath` (a workspace-relative `.json` file, loaded like `geographyPath`: canonical-path guard, single verified read, size bound, SHA-256 as a read dependency). The document, schema `reference-sheets.schema.json`, version 1:

```json
{
  "version": 1,
  "source": { "width": 17520, "height": 12720, "sha256": "optional" },
  "fill": "sea",
  "sheets": [
    {
      "id": "east",
      "box": [0.036, 0.5, 0.4, 1.0],
      "clip": [
        [0.036, 0.52],
        [0.4, 0.52],
        [0.4, 1.0],
        [0.036, 1.0]
      ],
      "anchor": [0.142, 0.7],
      "target": [0.89, 0.618],
      "scale": [-1.13, 1.66],
      "order": 10,
      "palette": [{ "kind": "sea", "color": [37, 62, 155] }],
      "mode": "illustrated"
    }
  ]
}
```

- Coordinates in `box`, `clip` and `anchor` are normalised to the drawing; `target` is normalised to the world frame. The map is `world = target + scale * (drawing - anchor)` per axis, the form the mod already records; `affine: [a, b, c, d, e, f]` may replace `anchor`, `target` and `scale` when a rotation is ever needed. Internally every sheet becomes one affine map and its inverse.
- `clip` (optional polygon, drawing coordinates) cuts a sheet out of its box, so overlapping drawing boxes never pull a neighbour's paper into a sheet. Without it the box is the clip.
- `order` resolves overlapping targets: the higher order wins, ties are an error. `fill` (`sea` or `error`) says what world pixels outside every sheet become.
- `source.width` and `height` must equal the decoded picture, and `sha256`, when given, must equal its hash; a mismatch is an error, so transforms recorded for one drawing are never applied to another.
- Without `sheets` the picture is one sheet with the identity map and the frame's size. This is the cleaned layout's path, and the existing single-picture behaviour (padding fit) is unchanged when neither `sheets` nor the new `fit: "frame"` is given.

Decoding. The source is read once, sequentially, through the existing snapshot loader (ADR 0046) and reduced by libvips area averaging to a working scale chosen from the sheets: the smallest scale at which every sheet still has at least one working pixel per world pixel (for ZIN about one third, 5,840 x 4,240, about 74 MB of RGB), bounded by a pixel ceiling of 64 megapixels with `MAP_IMPORT_SOURCE_TOO_LARGE` above it. This replaces the fixed 3,072-pixel cap only for registered imports and for `fit: "frame"`; a single picture without them keeps today's cap and output. Then every world pixel is mapped back to its sheet by the inverse affine and sampled bilinearly in the working picture (nearest for `paletteMatch: "exact"`), in horizontal strips as the geography rasteriser does, so no full-size floating-point buffer exists.

Classification runs per sheet, after warping, at world resolution, with the existing reference classifier, so OCR text masking, water cleaning and component cleaning apply as today. Each sheet may carry its own `palette` and `mode`, because the sheets' sea blues differ by sheet. New `reference.paletteMatch`: `nearest` (today's behaviour, the default) or `exact`: every pixel must equal a palette colour, and any other colour is the error `MAP_IMPORT_PALETTE_UNKNOWN_COLOR` with the colour, its count and the first five world coordinates. The cleaned layout is imported with `exact` and its eleven colours mapped to classes.

The output of this stage is one frame-aligned class raster (land, sea, lake, terrain classes, river and text masks). Everything downstream (geography synthesis, partition, outputs) consumes it exactly as it consumes a picture today, so every layer derives from one registration and `provinces.bmp`, `heightmap.bmp`, `terrain.bmp`, `rivers.bmp`, `trees.bmp`, the normal and colour maps and all text files share one frame by construction.

### 2. Which layer comes from which source

The frame is 5,120 x 2,560 for ZIN (the largest province map the engine accepts at that height; the lead confirmed it on 24 October 2026). The import never chooses the frame from the picture: `width` and `height` are required with `sheets` or `fit: "frame"`, and a geography model whose frame differs is the existing error `MAP_GEOGRAPHY_FRAME_MISMATCH`.

| Layer or fact                                                                 | From the drawing's pixels (or the cleaned layout)                                             | From the model's vectors                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coastline: which pixel is land and which is sea                               | yes, the only source when a picture is given                                                  | `lands` and `seas` polygons are not drawn into the mask; they are compared with it (agreement check), name land masses and seas, and give containment. Without a picture they draw the coast, as today. |
| Lakes                                                                         | no: drawn lake colour inside land becomes land unless a model lake covers it, and is reported | `lakes` carve the land, always (shape, ports)                                                                                                                                                           |
| Terrain classes (plains, forest, hills, mountain, desert, marsh, ice, jungle) | yes, as the base class where no model area applies                                            | `forests`, `deserts`, `marshes`, `ice`, `plains`, `hills` and biome areas override the drawn class inside their polygons; region `terrain` shares are checked against the result                        |
| Relief and the heightmap                                                      | no                                                                                            | ranges (crest, half-width, height, `wall`), volcanoes, plateaus and passes drive synthesis (ADR 0056) together with the terrain classes; the drawing's shading is never read as height                  |
| Rivers (`rivers.bmp`)                                                         | no: pencil rivers are not extracted (the drawn-river trace stays off for imports)             | `rivers` paths and hydrology (ADR 0056)                                                                                                                                                                 |
| Straits and adjacencies                                                       | no                                                                                            | `straits` (and override `adjacencies`)                                                                                                                                                                  |
| Sites, capitals, victory points, ports                                        | no                                                                                            | `sites` (and override `states`)                                                                                                                                                                         |
| Province, state and strategic-region grouping                                 | land, sea and lake mask and terrain only                                                      | `regions` (borders, densities), seas (sea regions), walls (ADR 0058)                                                                                                                                    |
| Names                                                                         | no (handwriting is not read; OCR stays off for imports)                                       | every name, then override `names`                                                                                                                                                                       |
| Roads, places, coasts features                                                | no                                                                                            | yes                                                                                                                                                                                                     |
| World edge                                                                    | land the drawing puts in the edge band is cleared or refused by `edge`                        | the model's edge features are checked by `edge`                                                                                                                                                         |

R-18 requires open sea at the horizontal seam, so a ZIN import uses `edge: {"mode": "sea-band"}`: land in the east and west bands (`max(192 px, 4% of the width)`) is an error in the model (`MAP_GEOGRAPHY_*` edge diagnostic) and in the warped drawing (`MAP_IMPORT_EDGE_LAND`, with the sheet and the pixel count), not a silent cut. The model's current edge cliffs (`edges`, `wrapPolicy` in `aoaz.json`) must become open sea before an import can pass.

Consequence for the model's repair: its `lands` and `seas` polygons need only agree with the drawing within the agreement threshold; the vectors that must be right are lakes, ranges, rivers (from high ground to a mouth in the drawing's water), straits, sites, regions, terrain areas and names.

### 3. Precedence and agreement

Highest first: authored overrides (section 5), the geography model, the registered drawing, applied per layer as the table says. The import measures how far model and drawing disagree before planning: land-sea intersection over union, the largest disagreeing areas, model features that fall in the drawing's water, and terrain shares per model region. Below thresholds that the request may set (`reference.agreement`), disagreement is a warning with an artifact; above them it is the blocker `MAP_IMPORT_SOURCES_DISAGREE`, because two sources about 80 pixels apart would otherwise produce coasts that neither the owner nor the model drew. The preview always shows both outlines.

### 4. Stable ids across re-imports

New `create_world.ids`: `{ "mode": "fresh" | "stable" }`, default `fresh` (today). `stable` requires a ledger from an earlier import and refuses (`MAP_IMPORT_IDS_NO_BASELINE`) without one; the first ZIN import is `fresh` and establishes it.

- **Ledger.** A generated, managed file `map/.hoi4-agent-ids.json` (in the managed-output allow-list, hash-checked like every generated file): source hashes, the generator version, and per province its id, colour, kind, area and a representative interior pixel (the deepest pixel of its distance transform, ties by reading order); per state and strategic region its id, members and name key.
- **Matching.** The new partition is matched to the previous `provinces.bmp` (verified against the manifest, so never a hand-edited file) in one raster pass that counts overlaps between old ids and new labels. A new province keeps an old id when each holds more than half of the other's pixels: mutual majority, so no id is ever claimed twice and no order dependence remains. States and strategic regions are matched the same way on pixel-weighted membership.
- **New and removed entities.** Unmatched new provinces take freed ids in ascending order, then ids above the maximum. Provinces and strategic regions need contiguous ids (docs/map.md), so when the world shrinks the highest ids move into the remaining holes; states use the same rule. Every moved id is listed in `map-id-remap.json` and counted in `MAP_IMPORT_IDS_RENUMBERED`; references in authored mod files (events, history, focuses) are found and, with `remapReferences: "override"`, rewritten in the same transaction through the existing reference remapper, or the write refuses as it does for splits today.
- **Colours.** Matched provinces keep their colour. New provinces get a colour from a hash of the seed and their representative pixel, probed past colours in use, instead of from the shared random stream, so a change in one place cannot recolour the world.
- **Determinism.** With `stable`, an import whose sources, overrides, ledger and options did not change produces the same partition and therefore the same files, and the transaction is a no-op (A-10's second-import check). `fresh` keeps today's guarantee: the same inputs and seed give the same files.

### 5. Authored overrides that survive regeneration

New `create_world.overridesPath`: a workspace-relative `.json` file the mod author owns, schema `world-overrides.schema.json`, version 1. The tool reads it with the same guards as `geographyPath` and never writes it, so its bytes and history stay the author's. Every entry has an `id` unique in the file, so diagnostics name it. Entries are keyed by world points, never by numeric ids, so they survive renumbering:

- `surface`: polygons forced to land, sea, lake or a terrain class (the role `reference.annotations` has inline today, without its 128-polygon limit).
- `provinces`: `pins` (points that must be separate province centres) and `merges` (points whose provinces must be one), terrain or impassable at a point.
- `states`: at a point: `name`, `owner`, `cores`, `category`, `manpower`, `resources`, `buildings`, `victoryPoints` (each at a point with a value and a name), `capital` (a point).
- `strategicRegions`: at a point: `name`, `navalTerrain`, `weather`.
- `names`: at a point: province, state, region or sea names with an optional `formerLabel`.
- `adjacencies`: from a point to a point, optionally through a point, with type and name (straits, canals, impassable crossings).
- `countries`: territory seeds, forced and blocked points, for the territory service (C11) once it lands.

Overrides are applied after partition and before outputs, through the same typed state, region and adjacency records `update_state` and the other operations already write. An override that cannot apply is an error, never skipped: a point in the wrong surface (a victory point in water), a point outside the frame, two entries giving one entity different values, a merge across a sea, an unknown tag, a state whose capital lies in another state. Each names the entry `id`, the point and the entity it resolved to.

Hand edits of generated files still block regeneration (`MANAGED_OUTPUT_EDITED`); the error now lists the files and, for state and region files, the changed fields, and says that the override file is where such a change belongs. Capturing edits into the override file automatically is not part of this decision.

### 6. Diagnostics and evidence

Errors block the write and a preview reports them all: source size or hash mismatch, unreadable or oversized source, a sheet box or clip outside the drawing, a zero or non-finite scale, a sheet target entirely outside the frame, overlapping targets with equal order, `fill: "error"` with uncovered pixels, unknown colours under `exact`, sources that disagree beyond the threshold, invalid overrides, a missing ledger under `stable`. Warnings: sheet edges that cut land (land touching a clip edge that is not a frame edge), class shares far from the model's region shares, small disagreeing areas. Every code has a negative test with a synthetic picture.

The preview and the write return, as content-addressed artifacts: `map-import-registration.png` (the warped drawing at reduced size with sheet outlines and ids, labelled an offline drawing of the source, never a game image), `map-import-alignment.png` (warped drawing with the generated coast and province borders over it), `map-import-classes.png`, `map-import-report.json` (per-sheet coverage, overlaps, class shares, agreement metrics, override resolution, id matching counts) and, with `stable`, `map-id-remap.json`. The private drawing itself never leaves the workspace's artifact store, and the artifacts are reduced drawings for review, never copies at source resolution.

After the write, the existing post-write validation runs, plus three alignment checks: all bitmaps have the frame size; every land province pixel has a height above sea level in `heightmap.bmp` and every water pixel below it; coast intersection over union between the class raster and `provinces.bmp` is at least 0.99. Failure rolls the transaction back as every failed validation does.

### 7. What stays the mod's work

The tool takes the geography schema version 1 of ADR 0055 and the sheet document above. Converting `aoaz.json` into those two documents is ZIN data work (the field mapping is direct: `geometry.coordinates` to points and rings, `sheets.*` to sheet entries with `drawingBox` to `box`, `drawingAnchor` to `anchor`, `worldAnchor` to `target`, `scaleWorldPerDrawing` to `scale`). The tool does not read the mod's own model format; a generic GeoJSON input for any mod can be a separate request. The drawing must lie inside the mod workspace to be read: the mod's git-ignored `docs/reference/originals/` copy qualifies, the private folder outside the mod does not, and no root is widened for it.

### 8. Order of implementation

1. Exact palette matching, `fit: "frame"` and the working-size rule (the cleaned layout imports correctly at full resolution). Small, independent of Q-04.
2. Registered sheets, the agreement measurement and the import artifacts.
3. Authored overrides.
4. Stable ids, the ledger and reference remapping.
5. The alignment checks and A-10 end-to-end test on a synthetic three-sheet drawing with a mirrored sheet.

Steps 1 and 2 serve either Q-04 answer; 3 to 5 are needed for both.

## Consequences

The owner's drawing can be re-imported after any edit to the drawing, the transforms, the model or the overrides without losing authored work or renumbering unrelated provinces, and every failure names the sheet, colour, point or entry at fault. The public `hoi4.map_rewrite` schema gains optional fields and two published schemas (`reference-sheets`, `world-overrides`); this is a minor version, reviewed for compatibility before it is merged. Registered imports use more memory than the 3,072-pixel working copy (about 74 MB of working picture for ZIN), bounded by the 64-megapixel ceiling and measured against the 19 October baselines. Stable ids add one raster pass and a ledger file to every stable import.

Not covered: recognising the owner's handwriting as names (labels stay reviewed input), registering sheets automatically (the transforms are authored data), rotation estimation, and capturing hand edits into the override file.

Tests use only synthetic, project-owned pictures: registration round trips (forward then inverse within half a pixel), mirrored sheets, overlapping targets and clips, exact palette refusals, strip-height invariance, the no-op second import, an override surviving a re-import that moves a coast, id stability when one province splits, contiguous renumbering when the world shrinks, every diagnostic code, traversal and principal isolation for the two new paths, cancellation, and the legacy single-picture and procedural worlds unchanged.

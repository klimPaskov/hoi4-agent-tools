# Agent Nudger map workflow

Agent Nudger is a headless declarative map transaction service for coding agents. HTML/PNG/JSON maps are inspection evidence, not a manual editor.

## Indexed sources

The shared scan connects province bitmap and definitions, states, strategic regions, terrain/continent values, adjacency CSV, supply nodes, railways, victory points, resources/buildings, ownership/control/cores/claims, coast/ports, placement files, localisation, and dependency overrides. It honors each workspace's configured `roots.map`, `roots.states`, and `roots.localisation` directories. Files named by the active `default.map` (including adjacency, supply-node, railway, province, definition, and position files) remain authoritative for active reads and additive writes. Allocation and collision evidence additionally resolves every scanned root's own `default.map`-selected definition filename. A partial root without its own selector inherits the active definition filename for evidence only. If any selector-owning root has a malformed, parser-limited, or otherwise diagnostic-bearing `default.map`, map scan and indexing stop with `MAP_DEFAULT_MAP_SELECTOR_BLOCKED`; the service never substitutes `definition.csv`, `provinces.bmp`, or an inherited selector for an untrustworthy file.

## Geometry input

Province geometry apply requires one exact representation:

- selected existing province IDs;
- polygon with integer raster-boundary coordinates and explicit `fillRule: "even-odd"`;
- raster mask manifest with dimensions, origin, exact selected-pixel count, SHA-256, and canonical Base64 data;
- explicit absolute pixel region (`kind: pixels`).

Natural-language descriptions can guide a coding agent, but are not accepted as apply geometry.

Polygon vertices describe raster cell boundaries, not pixel indices. For a raster of `width` by `height`, every vertex must use an integer `x` from `0` through `width` and an integer `y` from `0` through `height`; the right and bottom boundary values `width` and `height` are valid. A greater coordinate is rejected with `MAP_GEOMETRY_OUT_OF_BOUNDS` before bounding-box or raster-work allocation, and polygon geometry is never silently clipped. Rasterization samples each candidate pixel at its center, `(x + 0.5, y + 0.5)`, using the required even-odd fill rule. Every selected center must still belong to the declared source province.

Raster-mask `data` is one byte per cell in row-major order. Every byte is exactly `0` or `1`; the SHA-256 is computed over those decoded bytes. The declared rectangle must fit the active raster, its byte length must equal `width * height`, and both the selected count and hash must match before every selected absolute pixel is checked against the source province. A mask may describe at most 20,000,000 cells, while any one split, mask, polygon, normal-adjacency transfer set, whole-province color update, or merge may select/recolor at most 1,000,000 pixels. Polygon admission also stops at 50,000,000 cell-point comparisons. Counts known from the manifest or indexed province geometry are checked before decoding, raster scanning, or selection-buffer allocation; an over-limit operation returns `MAP_SELECTED_PIXEL_BUDGET_BLOCKED` without proposing changes.

Selected geometry is represented internally as deterministic row-major numeric offsets rather than coordinate strings or `{x, y, color}` object arrays. The fixed 1,000,000-pixel ceiling keeps the primary four-byte offset buffer below 4 MiB (4,000,000 bytes), and uniform recolors copy the BMP once and write directly through those offsets. Explicit-coordinate duplicates and normal-adjacency transfer duplicates are detected by numeric offset. Source BMP operations use exact colors without antialiasing, interpolation, resizing, alpha conversion, or palette quantization. Untouched bytes and pixels remain identical.

## State payload policies

Split/merge/move operations do not guess manpower, resources, buildings, victory points, ownership, control, cores, claims, supply, or railway behavior. Each applicable payload must select an explicit policy:

- remain with original state;
- move with a named province;
- deterministic proportional distribution;
- exact manifest values;
- block until resolved.

Proportional rounding is deterministic and checked for conservation. The transaction remains blocked while any required policy is unresolved.

State move, split, and merge manifests also declare `ports`, `supplyNodes`, `railways`, and `positions` as `follow-province`. Those records are keyed by a selected province or its state association, so their source bytes remain unchanged except for the already modelled state-ID field on applicable position rows. The explicit literals make that behavior reviewable and prevent a partial distribution object from silently choosing it.

New states require an explicit name localisation key and a strict `localisation` policy. `existing` requires exactly one safe active `l_english` entry. `upsert` updates only the quoted value of that exact entry, appends to an explicitly targeted existing file, or creates an explicitly targeted file in a configured localisation root. Created and edited files are UTF-8 with BOM. Comments, key versions, spacing, line endings, ordering, unknown lines, and unrelated entries are preserved. Missing policy/target/key, duplicate active keys, unsafe paths, target mismatch, non-BOM encoding, or malformed target source blocks the whole operation before it contributes changes.

`StateRecord.capital` is inspection-only derived data: select the province with the highest exact victory-point value, then the lowest province ID on a tie. Current state source has no generic `capital = <province>` field. Agent Nudger never emits or patches that assignment. `update_state.changes.capital` is therefore an assertion, not a write: it is accepted only beside an exact `victoryPoints` payload whose derived result matches the assertion (including `null` for no victory points). State moves, splits, and merges derive the result from their explicit VP policy.

## Province merge and removal

`merge_provinces` and `remove_province` accept arbitrary compatible source IDs; removed IDs do not need to be the highest rows in `definition.csv`. Surviving definitions are compacted deterministically to contiguous IDs from zero in old-ID order. Removed source IDs map to the target's compacted ID, including when the target itself moves downward.

The same total old-to-new map is applied atomically to state membership, victory points, province buildings, strategic regions, special-adjacency endpoints and through-provinces, supply nodes, railways, unit positions, and building-position sea references. Source pixels are repainted with the target color; other province colors and pixels remain unchanged. Reference collisions created by the merge are resolved by the declared sum/deduplicate policy. Definition row order, comments and extra fields, text-file comments, line endings, and source encoding are retained by targeted rewrites, and rollback restores every affected file byte-for-byte.

Compaction requires an active definition table that is already contiguous from zero and unambiguous by ID and color. The merge also requires every source and target to share province type plus exact state and strategic-region membership; these are refusal cases rather than guessed redistribution.

Province split/create manifests explicitly retain existing victory points, province buildings, ports, supply nodes, railways, special adjacencies, positions, and entity locators on the source province while the selected pixels and new ID join the declared state and strategic region. To move connected data to the new province, place the corresponding exact remove/add or update operations after the split in the same ordered transaction. Omitting any retention field blocks the split before geometry changes are proposed.

## Province type migration

`update_province_definition` can migrate among `land`, `sea`, and `lake`. A real type change requires the complete strict `distribution` object; missing, partial, unknown, or transition-incompatible policies block the operation before it contributes any file change.

The policy explicitly covers:

- exact state membership (`retain`, `remove` with the indexed state ID, or `assign` with a target state ID);
- retention of state-level values in their current states and strategic-region membership;
- victory points and non-port province buildings (`retain-if-valid` or `remove`);
- naval-base buildings plus port placements/references (`retain-if-valid` or `remove`);
- supply nodes (`retain-if-valid` or `remove`);
- railways (`retain-if-valid` or remove every containing route; routes are never silently spliced);
- building and unit positions (`retain-if-valid` or `remove`) and entity locators (`retain-at-coordinate`, because type migration does not alter geometry);
- special adjacency endpoint/through references (`retain-if-valid` or `remove-referencing`).

Land-to-water requires removal from the exact indexed state and cannot leave that state without land. Water-to-land requires an explicit existing target state in the same strategic region. Sea targets require `ocean` terrain and continent `0`; lake targets require `lakes` and continent `0`; land targets require a non-water terrain and nonzero continent. Coastal fields and neighboring coastal changes remain exact manifest inputs and are verified by final map validation. Dependency removals and the definition edit share one hash-bound transaction, so apply and rollback cover every affected state, definition, network, position, and adjacency file together.

When a dependency should move rather than disappear, place the corresponding exact `update_state`, position, supply, railway, or adjacency operation after the type migration in the same ordered manifest. The migration policy removes or retains the old record explicitly; the later operation supplies the new target explicitly.

## Normal and special adjacency

Special adjacency rows remain declarative `add_adjacency` and `remove_adjacency` operations against the active `default.map` adjacency CSV. Normal topological adjacency is derived only from four-neighbor province bitmap geometry (including horizontal map wrap) and uses separate `add_normal_adjacency` and `remove_normal_adjacency` operations.

Every normal-adjacency operation carries unique exact pixel transfers with a coordinate, the province currently owning that pixel, and the destination province. Both requested endpoints and all transfer provinces must exist, every source must match the active raster, and every transfer must involve at least one requested endpoint. Agent Nudger repaints only those 24-bit pixels, rebuilds topology, and blocks/rolls back the operation unless the requested pair is present after an add or absent after a remove. Related coastal-definition changes remain explicit ordered operations in the same transaction.

## Allocation

ID/color allocation scans current game, dependencies, and mod sources first, including the definition table selected by each root's own `default.map` even when its filename differs from the active table. It records per-file/root maxima, used ranges, active definition contiguity, collisions, reserved values, selected value/color, and source revision. Explicit values are checked against the same evidence. A lower-root ID/color collision is returned as a named dependency conflict on the manifest operation that requested it. The allocator never assumes the numerically next value is safe.

## Artifacts and validation

Map base layers cover province, state, strategic region, terrain, continent, owner, controller, cores, claims, and coast. Overlays cover coastlines, ports, victory points, resources, state buildings, province buildings, supply nodes, railways, special adjacencies, building positions, unit positions, and weather positions. Resource/building data is present in canonical JSON as exact sorted state/province maps as well as deterministic PNG markers; HTML embeds the same JSON and PNG with pan/zoom controls. Render loops honor cancellation signals.

Every map preflight stores three content-addressed PNG/JSON/HTML triplets: baseline (`map-before.*`), proposed (`map-proposed.*`), and changed-pixel/semantic diff (`map-diff.*`). Their links and content hashes are included in the transaction plan hash. Semantic diff JSON includes definitions, state/region membership, full state values (manpower, category, resources, owner/controller, cores/claims, VPs, state/province buildings, and derived capital), ports, building/unit/weather positions, entity locators, supply, railways, exact special-adjacency records, and exact bitmap-derived normal-adjacency pairs.

Validation detects duplicate IDs/colors, bitmap-definition mismatches, invalid references, unassigned/multi-state land, invalid derived capitals/VPs/ports/regions/adjacency/supply/rail/placements, removed references, coast inconsistencies, duplicate state IDs, missing localisation, ownership/control conflicts, lost payload, changes outside declared bounds, and dependency conflicts. Geometry review includes disconnected components, one-pixel corridors, and enclosed province holes. Hole detection uses one bounded digital-topology pass and reports `MAP_PROVINCE_HOLE_REVIEW` as a warning because intentional enclaves can be valid; provinces crossing the horizontally wrapping seam are excluded from planar hole classification. Baseline comparisons diagnose dimensions, file/DIB header, row orientation, pixel offset, bit depth, and palette changes separately. Sea and legitimate lake/island cases are not misclassified as missing state membership.

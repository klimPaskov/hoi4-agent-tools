# Changelog

## 4.6.2 - 2026-10-31

- Check the points of workspace countries together and give each capital a province (ADR 0073). `create_world` now reports every capital or seed that lies outside the world or in water (with the nearest land), in the unowned area, an own exclusion or another realm's claim, or within 10 pixels of a point of another realm, in one error (`MAP_WORLD_REALM_POINTS_INVALID`, `details.problems`; a single problem keeps its own code), before the relief synthesis starts. `create_world.synthesisCheck` runs the same check and lists the points beside the failing rivers (`data.synthesisCheck.realmPoints`). In the feature-aware partition every capital and seed is a province seed of its own, so capitals that are 20 to 40 pixels apart no longer fail with `MAP_WORLD_REALM_POINT_CONFLICT`. Feature-aware worlds with workspace countries get a slightly different province partition; other worlds are unchanged.

## Unreleased

- Raise the pinned overrides of three transitive dependencies to their fixed releases, clearing every `npm audit --omit=dev` advisory: `fast-uri` 3.1.9 (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp), `hono` 4.13.13 (GHSA-5r4p-p66f-jhc7) and `ip-address` 10.7.4 (GHSA-rxp7-6hxx-x8q5). No source or schema change.

## 4.6.1 - 2026-10-26

- Stop flagging `constant:<category>.<key>` script-constant reads as scoped temporary-variable reads (`KNOWN_MISTAKE_TEMP_VARIABLE_SCOPE_PREFIX`).
- Make declared passes saddles whatever else stands there (ADR 0072). After the macro relief is composed, the heights in a pass's corridor are capped at the pass's saddle level, so a volcano cone, plateau or neighbouring feature that overlaps a pass no longer fills the gap and no longer fails the world with `MAP_PASS_NOT_LOWER`. Another range's body is left alone. `create_world.synthesisCheck` now also reports `MAP_PASS_NOT_LOWER`, so a preview catches what the write would block on. Models whose passes were refused now write; worlds with no overlapping feature on a pass are unchanged.

## 4.6.0 - 2026-10-25

- Add the territory assignment service (ADR 0060). `assign_territory` grows up to 512 countries over the states or provinces of a map from capital and anchor seeds (state, province or pixel) with forced and blocked land, preferred strategic regions, subjects inside an overlord, merges, island policies, size targets by weight, extra cores and claims, and writes owner, controller, cores and claims. Borders follow rivers, ranges, lake shores and terrain changes (a shortest-path growth with barrier-weighted steps, size balancing, a corridor for cut-off seeds and a local search that shortens the artificial border); the result reports sizes against targets and the same seeds grown on distance alone. With `unit: "province"` the states a border cuts are regrouped in one pass, conserving population, resources and buildings exactly. `repartition_states` regroups the states of chosen owners along natural lines, and `update_states` edits up to 5,000 states in one rewrite. New diagnostics `MAP_TERRITORY_*`.
- Land listed in `assign_territory.unowned`, and landmasses without a seed under `islandPolicy: "unowned"`, lose their owner (and controller) with `ownership.unowned: "clear"`, the default, or keep it with `"keep"`; states outside `scope` are never edited. Refusals name the state or province of the request (`MAP_TERRITORY_SEED_UNAVAILABLE`, `_FORCED_BLOCKED`, `_FORCED_CONFLICT`, `_FORCED_UNREACHABLE` carry `stateId` or `provinceId`). Results of a territory operation add `data.territory`.
- Add `borderQuality` (`off`, `report`, `enforce`) and `borderTargets` to the territory operations and to `create_world` (G-58). The border naturalness of the proposed map is measured after the whole request and reported (`MAP_BORDER_QUALITY_MEASURED`, artifact `map-territory-report.json`); `enforce` blocks the write below the targets (`MAP_TERRITORY_BORDER_ARTIFICIAL`, `MAP_WORLD_BORDER_ARTIFICIAL`) and is refused for the legacy partition.
- A feature-aware `create_world` without a reference picture now grows its generated countries along natural lines instead of blind breadth-first growth; legacy worlds are byte-identical, and workspace-owned countries (`countries.source: "workspace"`) keep the realm growth of ADR 0069.
- Public schema change: new operation kinds `assign_territory`, `repartition_states` and `update_states` and new optional fields `borderQuality` and `borderTargets` on `create_world` (minor version at release; the schemas are regenerated).
- Plan straits, passes and walls from a geography model (ADR 0062). A world built from a geography now writes each `strait` as a named `sea` row in `adjacencies.csv` with a rule in `adjacency_rules.txt` (`open`, `army-closed`, `navy-closed`), `impassable` rows for every pair of land provinces across a range with `barrier: "impassable"` except at its passes, land forts (`bunker`) at passes with a `fort` level, and sea provinces for a lake with `gameplay: "inland-sea"` with a canal row to the open sea. The partition now uses the model's regions, named seas and walls. New optional `create_world.autoStraits` (`true` or `{ maxGapPx }`). Diagnostics: `MAP_CROSSINGS_PLANNED`, `MAP_INLAND_SEA_CREATED`, `MAP_INLAND_SEA_SEALED`, `MAP_STRAIT_UNRESOLVED`, `MAP_STRAIT_DUPLICATE`, `MAP_STRAIT_NOT_NARROW`, `MAP_PASS_BLOCKED`, `MAP_RANGE_NOT_CLOSED` and the refusal `MAP_IMPASSABLE_ROW_LIMIT`. `hoi4.map_inspect` and every created world also check rules against rows and wall rows on any map: `MAP_ADJACENCY_RULE_MISSING`, `_DUPLICATE`, `_INVALID`, `_UNUSED`, `MAP_IMPASSABLE_NOT_ADJACENT`, `MAP_IMPASSABLE_NOT_LAND`, `MAP_ADJACENCY_ROW_LIMIT`, `MAP_RAILWAY_CROSSES_IMPASSABLE`, `MAP_UNIT_POSITION_MISSING`; thresholds are set so the installed game raises nothing above information. Worlds without a geography are unchanged.
- Plan ports, development, names and railways from a geography model (ADR 0063). Ports follow a harbour score (concavity, shelter, river mouth, depth class, sites) with levels from site importance; population, category, infrastructure, factories, resources (ranges, `mine` sites, jungle) and victory points follow fertility, rivers, coast, passes and sites with no random rolls; states, strategic regions, victory points and lake provinces are named from sites, lakes, rivers, ranges, regions, lands and seas by containment, with counted placeholders (`MAP_NAME_PLACEHOLDER`); railways use a terrain-aware cost (ground, climb, rivers, gates, roads) and trunk lines of level 2 reach large cities. New optional `create_world.development: { model: "geography" | "legacy" }` (default `geography` for a geography world) and an optional `resource` on geography `mine` sites. Other diagnostics: `MAP_DEVELOPMENT_PLANNED`, `MAP_PORT_LAKE_UNSUPPORTED`, `MAP_PORT_SITE_NOT_COASTAL`, `MAP_SITE_UNPLACED`.
- Accept a strait between two coasts of one land as a crossing between two provinces of that land when its straight line crosses water (`MAP_GEOGRAPHY_STRAIT_SAME_LAND` is then `info`; across no water it stays an error), and add `bay` as a sea `kind` of the geography model (ADR 0062). Public schema change: one more allowed value of `seas[].kind` (minor version).
- Public schema change: new optional fields `development` and `autoStraits` on `create_world` and `resource` on geography sites (minor version at release; the schemas are regenerated; compatibility review: additive optional input only, no output field changed, behaviour changes only for worlds built from a geography).
- Stop reporting the validation findings of a map that a failed `create_world` left in place: a world that cannot generate now returns only its own blockers, and a successful replacement of a map is validated on the map it produces instead of being compared with the map it replaces (ADR 0070). Before, a river that could not reach its mouth came back with three `MAP_VALIDATION_OPERATION_UNOWNED` blockers about the old map.
- Let drawn rivers carve their valleys (ADR 0071). A river whose course crosses a divide higher than 22 height units (a volcano cone, a foothill, the tip of a range) is no longer refused: its bed is cut through the rise as a gorge, and each crossing is reported as the warning `MAP_RIVER_CARVED_CROSSING` with the river, climb and divide location (world pixel, height, nearest range or volcano). Models that were refused now write; models that wrote are unchanged.
- Report every named river with an impossible course in one run: `MAP_RIVER_UNREACHABLE_MOUTH` (a mouth on another landmass, a source or via point that cannot be reached, a lake without a shore) keeps its code and top-level fields and gains `details.rivers`, each with its reason or `blockedBy` another failed river.
- Add `create_world.synthesisCheck` (with `preview: true` and a geography): run only the relief and river synthesis and report all impossible rivers and carved crossings without writing (`MAP_SYNTHESIS_CHECK_READY`, `MAP_SYNTHESIS_CHECK_BLOCKED`, `data.synthesisCheck`). Public schema change: one new optional field on `create_world` (minor version).

## 4.5.0 - 2026-10-25

- Refuse `hoi4.focus_rewrite` with `FOCUS_SOURCE_CHANGED_SINCE_PLAN` when the focus source changed in meaning after the plan was inspected, instead of reverting the external change to the plan's values (national trees and continuous palettes). Comment and formatting changes and a source that already equals the plan are still accepted. Reported by the HOI4 Factory S01 EXP-02 probe.
- Refuse every rewrite of a file that is not valid UTF-8 and contains bytes Windows-1252 cannot represent (0x81, 0x8D, 0x8F, 0x90, 0x9D) with `SOURCE_ENCODING_NOT_ROUND_TRIPPABLE`. Previously the encoder wrote 0x9D for each of them without a diagnostic. Reads and inspection continue and add a warning with the same code. Valid UTF-8 and valid Windows-1252 files are unchanged.
- Place countries the mod already owns (ADR 0069): `create_world.countries` accepts `{ "source": "workspace", "realms": [...] }` besides the array. Each realm is a declared tag with a capital point and optional seeds, claim and exclusion polygons and a weight; `unowned` polygons and `islands` (`nearest`, `one-owner`, `unowned`) decide land no country claims. The world then writes only the map, states, strategic regions and their names, and none of the countries' files. New refusals `MAP_WORLD_REALM_TAG_UNKNOWN`, `MAP_WORLD_REALM_TAG_DYNAMIC`, `MAP_WORLD_REALM_POINT_OUTSIDE`, `MAP_WORLD_REALM_POINT_WATER`, `MAP_WORLD_REALM_POINT_CONFLICT` and `MAP_WORLD_REALM_CLAIM_OVERLAP`; notes `MAP_WORLD_REALMS_PLACED` and `MAP_WORLD_STATE_UNOWNED`; result field `data.realms` and artifact `map-world-realms.json`. Public schema change: `countries` becomes a union of the existing array and the new object (minor version). Requests with the array are unchanged.
- Report what a world write does to the previous world's files: `MAP_WORLD_OUTPUTS_RECONCILED`, `data.outputs` (written, retired and released counts with up to 200 paths each) and the artifact `map-world-outputs.json`. With workspace countries an edited country file of the previous world is released to the mod (`MAP_WORLD_OUTPUT_RELEASED`) instead of refusing the write; every other edited output still refuses with `MANAGED_OUTPUT_EDITED`.
- Report the declared country tags after every world write (`MAP_WORLD_TAG_COUNT`) and warn above 439 (`MAP_WORLD_TAG_COUNT_HIGH`), the count at which one measured game build overflowed its flag sheet.

## 4.4.0 - 2026-10-24

- Collect test fixtures that a killed or crashed test run left in the temporary folder: the test setup now also sweeps `hoi4-*` fixtures that carry an owner record of a process that has ended (`sweepTemporaryDirectories` option `ownedFixturesOnly`). Unmarked folders and folders of a live process are never removed. Interrupted local runs had left 2,441 such folders (640 MB).
- Fix the province count of generated worlds (found by the map import campaign, ZR-4). Extra provinces in high and wet land were added on top of `landProvincePixels`, so reference worlds, whose terrain is wet, got 50 to 95% more land provinces than requested (18,000 to 23,000 instead of about 13,000); they now redistribute the requested size, and lakes are cut at the sea size. When neither province size is given and the land would still need more than 14,000 provinces, both sizes grow towards 13,000 (`MAP_WORLD_PROVINCE_SIZE_RAISED`); chosen sizes above 21,000 provinces are refused before generation (`MAP_PARTITION_PROVINCE_COUNT_HIGH`) instead of failing on a 23 MB `unitstacks.txt`. This changes the province partition, and with it every derived file, of every `create_world` for a seed.
- Repair a coast that crosses the east-west seam by one pixel (`MAP_WORLD_SEAM_CORNER_REPAIRED`) instead of refusing the picture with `MAP_WORLD_UNREPRESENTABLE_TOPOLOGY`. `MAP_TEXT_FILE_LIMIT` and `MAP_TEXT_RECORD_LIMIT` now name the file.
- Register a drawing made of sheets onto the world frame: `create_world.reference.sheets` or `reference.sheetsPath` (schema `reference-sheets.schema.json`, version 1) map each sheet with anchor, target and scale (negative to mirror) or an affine, with an optional clip and an order for overlaps (ADR 0067, step 2). The picture is read at the resolution the sheets need and every layer derives from the registered picture. New errors `MAP_REFERENCE_SHEETS_*` and `MAP_REFERENCE_SHEET_*` name the sheet, pixel count and position at fault.
- Report import evidence for registered, frame-fitted or exact-palette references and for a picture beside a geography model: `map-import-report.json`, `map-import-classes.png`, `map-import-alignment.png`, `map-import-registration.png`, the inline `data.import` of a model preview, and the land agreement between model and picture (`reference.agreement`, defaults 0.85 to block with `MAP_IMPORT_SOURCES_DISAGREE` and 0.95 to warn), with model sites, volcanoes and river ends on the wrong surface (`MAP_IMPORT_FEATURE_SURFACE`). A model preview with a picture now also loads and registers the picture. Public schema change: new optional fields and one new published schema (minor version).
- Add `create_world.reference.paletteMatch` (`nearest`, the default, or `exact`) and `reference.fit` (`contain`, the default, or `frame`) for pictures that are already the game layout, such as a cleaned class map (ADR 0067, step 1). `exact` classifies by exact palette colour, skips the visual heuristics and fails with `MAP_REFERENCE_PALETTE_UNKNOWN_COLOR` (colours, counts, source pixels) or `MAP_REFERENCE_PALETTE_CONFLICT`; `frame` maps the picture onto `width` x `height` at the frame resolution instead of the 3,072-pixel working copy and refuses another shape with `MAP_REFERENCE_FRAME_ASPECT`. Public schema change: new optional fields (minor version). Requests without them are unchanged.
- Carry a whole-mod apply in one transaction (ZR-5): the file ceiling rises from 5,000 to 15,000 and the authenticated manifest ceiling from 16 to 32 MiB. Large applies replace files in batches that grow with the file count (16 files up to 1,024, at most 256), so the manifest is written about 128 times instead of twice per 16 files; ordinary rewrites are unchanged. `TRANSACTION_STRUCTURE_LIMIT` now names each exceeded limit and the remedy. See the amendment to ADR 0047.
- Resolve `workspaceId: "current"` for sessions started outside every mod, such as a coding agent working in another repository or its subagents. When the client roots and the working directory identify no mod, the server now uses the new optional configuration key `defaultWorkspace`, then the only mod workspace, then the one mod that has the named source (`relativePath` of the focus tools, `path` of `hoi4.script_validate`). `WORKSPACE_CONTEXT_NOT_FOUND` and `WORKSPACE_CONTEXT_REQUIRED` now list up to 32 workspace IDs and names and say how to fix the call. A default outside a principal's grants is never used. See ADR 0066.
- Security update: zod 4.6.7 (GHSA-mrhx-c7xc-m3w5, memory exhaustion when validating oversized constrained collections), body-parser 2.4.0, undici 8.12.3 and vite 8.2.4, so `npm audit --audit-level=high` passes again. The regenerated schemas now state the fixed tuple lengths the server already enforced (`items: false`, `minItems`, `maxItems`), and the scalar `anyOf` in `gui-helper.schema.json` became an equivalent type list. No accepted input changes. With zod 4.6, a JSON object key `__proto__` in a strictly validated input (such as a geography model) is refused as an unknown key; zod 4.4 dropped it silently. Neither version let it reach `Object.prototype`. The `qs` override moves from 6.16.0 to 6.16.1, which body-parser 2.4.0 requires.
- Fix lakes in generated worlds (ADR 0053). Lake pixels are written at the sea height 89 with a one to two pixel bank instead of height 93, where the engine draws water only 56% opaque, and use the ocean's graphical terrain instead of index 14, whose `lakes` entry names no atlas tile (`texture = 255`). `buildWorldContext` never selects such an entry and reports it in `unrenderedTerrain`. Enclosed water below 60 pixels becomes land (`MAP_LAKE_TOO_SMALL`) and lake water that touches the open sea becomes sea (`MAP_LAKE_CONNECTED_TO_SEA`). The water colour maps now follow the base game (shelf-to-deep gradient, lake tint). This changes the heightmap, terrain bitmap and water colour maps of every `create_world` request that has lakes, so their file hashes change; provinces, states, countries and the other files are unchanged for a seed.
- Add optional `create_world.look` (`vanilla-temperate`, `fertile`, `arid`, `custom`) and `colormap` (`profile`: `calibrated` or `legacy`, `palette`) for a dark, varied land colour map calibrated to the base game, permanent-snow tint, and farmland, sparse-forest and grassy-mountain terrain indices (ADR 0054). Without them the colour map is unchanged.
- Add optional `create_world.edge` (`mode`: `sea-band`, `rim`, `none`; `bandPx`, `polarPx`, `rimPx`) and `ambientFrame` for the wrapping world seam and the north and south frame borders (ADR 0061), with the diagnostics `MAP_EDGE_LAND_CLEARED`, `MAP_EDGE_FEATURE_IN_BAND`, `MAP_EDGE_BAND_TOO_WIDE` and `MAP_EDGE_RIM_ADJACENCIES`. Without them nothing changes.
- Validate the appearance files (`MAP_RIVER_*`, `MAP_TERRAIN_BITMAP_*`, `MAP_HEIGHT_*`, `MAP_TREES_*`, `MAP_COLORMAP_*`, `MAP_WATER_COLORMAP_FLAT`, `MAP_NORMAL_*`, `MAP_CITIES_*`, `MAP_LAKE_*`, `MAP_EDGE_LAND_CUT`, `MAP_SEAM_LAND_ADJACENCY`, `MAP_POLAR_LAND`) in `hoi4.map_inspect` and in every world being created. Thresholds are set so the installed base game raises no error. Existing mods can see new warnings; only a defect that covers a whole lake, river or file is an error.
- Public schema change: new optional fields on `create_world` (minor version at release; the schemas are regenerated).
- Add the geography model, version 1, as an optional input of `create_world`: `geography` (inline) or `geographyPath` (a workspace-relative `.json` file of at most 4 MiB, loaded with the canonical-path guard, a verified single read and a stale-source dependency like `reference.imagePath`). A strict, versioned schema describes seas, lands, regions, ranges, passes, volcanoes, plateaus, rivers, lakes, biomes, straits, sites, roads, places and climate in normalized world coordinates; `schemas/geography-model.schema.json` is published. The public `hoi4.map_rewrite` schema change is additive (a minor version).
- Resolve the model deterministically (features sorted by id, rings oriented, defaults filled, areas, containment and cross-references derived, one canonical hash) and validate it with `MAP_GEOGRAPHY_*` diagnostics. `hoi4.map_rewrite` with `preview: true` returns `map-geography-overlay.png`, `map-geography-report.json` and a `data.geography` summary without planning any map. Without `preview`, a model is loaded and validated and the write is blocked with `MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE` until relief, hydrology and biome synthesis exist. See ADR 0055.
- Measure border naturalness. `hoi4.map_inspect` accepts `quality: true` (full inspection) and returns `data.quality` for the province, state, strategic-region and country borders: alignment with rivers, steep gradients, lake shores and terrain-class changes, enrichment over chance, the plain natural share of border length, locally straight samples, long straight runs and the worst artificial runs, with the artifact `map-border-quality.<revision>.json` and the diagnostics `MAP_BORDER_ARTIFICIAL_REVIEW`, `MAP_BORDER_NOT_MEANINGFUL`, `MAP_BORDER_INPUT_MISSING` and `MAP_BORDER_QUALITY_UNAVAILABLE` (none fail validation). The new `border-quality` overlay draws natural and artificial state borders and the worst runs. Both are additive and optional, so existing requests are unchanged (compatibility review: new optional input field, new overlay value and new optional output field; next release is a minor version). See ADR 0059.
- Add the opt-in feature-aware partition for `create_world` (ADR 0058): `partition: "feature-aware"` (default `legacy`, which keeps every old request byte-identical; a world given a geography defaults to feature-aware) cuts provinces along rivers, ridges, steep slopes, wall ranges and shores with a watershed, sizes them by terrain, fertility, coast, rivers and the geography region's density (sea provinces small on the shelf, large in the open sea, two sea provinces across a narrow strait), and clusters states and strategic regions along natural lines, geography regions and named seas. The optional `partitionTuning` (`landArea`, `seaArea`, `provincesPerState`, `regionSize`, `barrierStrength`, `minProvincePixels`, `narrowStraitPx`) sets the bands. New diagnostics `MAP_PARTITION_*`: contradictory bands, a map too small for the minimum province, `partitionTuning` with `legacy`, a plan above 21,000 provinces (also names the fields to change, closing the late `MAP_TEXT_FILE_LIMIT` failure for this partition), a warning above 14,000 provinces for both partitions, and info notes for provinces cut along rivers and straits and for coast pixels adjusted at diagonal contacts. The reusable service (`partitionWorld`, `buildProvinceGraph`, `provinceEdgeCosts`, `partitionFieldsFromBitmaps`, `partitionFieldsFromGeography`) takes a typed `PartitionFields` input that the relief and hydrology stages will also fill. For a geography world the partition reads the model's regions, named seas, region densities (`provinceAreaPx`, `provincesPerState`) and wall ranges, the synthesised heights and the walls, fort lines and crests of the synthesis barrier field, so states and strategic regions stay inside one geography region and no province straddles a wall; the mask smoothing runs before the synthesis there, so a coast pixel turned to land gets a land height. The terrain synthesis and the feature-aware partition stop when the request is cancelled. Public schema change: new optional fields on `create_world` (minor version at release; the schemas are regenerated). Compatibility review: the partition adds optional inputs only and no output schema field; the output schema change of this release is the additive `synthesis` and `unsupported` fields of the model preview (below). Responses can change without a schema change: a `create_world` above 14,000 provinces now carries the `MAP_PARTITION_PROVINCE_COUNT_HIGH` warning with the legacy partition too, while its files stay byte-identical.

- Synthesize relief and rivers from a geography model (ADR 0056). `create_world` with `geography` or `geographyPath` now builds the land, `heightmap.bmp`, `world_normal.bmp`, `rivers.bmp` and the permanent-snow terrain from the model instead of being blocked: ranges as ridge, massif, escarpment and wall profiles with asymmetry, spurs, passes and snow lines, volcanoes with craters, plateaus and chasms, fractal base relief and coast ramps, on a half-size macro grid with full-resolution detail; erosion-aware rivers (priority-flood conditioning, named rivers routed as least-cost paths with bends, tributaries, deltas and lake outlets, an accumulation network at a target density, stream-power valleys, widths by catchment from 3 to 11) written as one-pixel orthogonal paths with a green source per river, red tributary ends and yellow distributary starts; the normal map from the float height field at the base game's response. A request without a geography is unchanged, byte for byte.
- Add optional `create_world.relief` (`scale`: `vanilla`, `low`, `dramatic`; `detail` 0 to 1) and let `create_world.rivers` be `{ density }` (share of land pixels, default 0.02, at most 2.5% of land or 130,000 pixels) as well as an integer; with a geography an integer limits the unnamed river systems. Both need a geography (`MAP_RELIEF_REQUIRES_GEOGRAPHY`, `MAP_RIVER_DENSITY_REQUIRES_GEOGRAPHY`). A model that declares biomes, climate, fertility, region terrain shares or sea ice is still blocked with `MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE`, whose message and details now name those parts; the model preview's `data.geography[].synthesis` is `available` or `unavailable` and `unsupported` lists the parts.
- New generation-time diagnostics for geography worlds: `MAP_RELIEF_SYNTHESIZED` (statistics and the first named rivers), `MAP_PASS_NOT_LOWER` and `MAP_RIVER_UNREACHABLE_MOUTH` (errors), `MAP_RANGE_CREST_LOW`, `MAP_VOLCANO_NO_CRATER`, `MAP_RELIEF_FLAT`, `MAP_RIVER_STRAIGHT_RUN`, `MAP_RIVER_DENSITY`, `MAP_RIVER_PIXEL_ROUTE_INCOMPLETE` (warnings), `MAP_LAKE_ENDORHEIC`, `MAP_RIVER_STREAMS_DROPPED` and `MAP_RIVER_DELTA_SKIPPED` (info). The result also carries typed barrier, valley, crest-distance and mountain fields for the feature-aware partition (documented in the ADR).
- Public schema change: new optional field `relief` and a union type for `rivers` on `create_world`, and the new output fields `synthesis` (now `available` or `unavailable`) and `unsupported` in the model preview summary (minor version at release; the schemas are regenerated).

## 4.3.0 - 2026-10-19

- Run probability analysis on every installed HOI4 version. `metadata.gameVersionVerification` records the observed build as `workspace_verified`, `workspace_observed` or `version_unknown` instead of refusing with `PROBABILITY_GAME_VERSION_UNSUPPORTED` or `PROBABILITY_GAME_VERSION_UNVERIFIED`; decision inspection evaluates AI weights on any version.
- Recognize every effect the installed game documents in `documentation/effects_documentation.md` as native in event and focus analysis, so effects added by later patches are not reported as missing scripted helpers.

## 4.2.0 - 2026-10-19

- Keep job workers running when a discovered mod folder is removed after server start. Workers now resolve only workspaces whose roots still exist, while a job for the removed workspace still fails with `WORKSPACE_ROOT_MISSING`.
- Stop `hoi4.event_inspect` `scan` from failing with `RangeError: Invalid string length` on large mods. The graph snapshot is measured before serialization and omitted above 128 MiB with the info diagnostic `EVENT_GRAPH_SNAPSHOT_OMITTED`.
- Return `data.summary` from event inspection: selection finding counts by classification and code with the ten most severe source-linked findings, trace sizes and event IDs, and root counts.
- Resolve `event_target:name` reads against `save_global_event_target_as` producers; `global_event_target:name` reads still require a global producer. This removes false `EVENT_TARGET_READ_BEFORE_SAVE` probable defects.
- Record temporary-variable and temporary-array writes, `round_variable`, `modulo_variable`, `randomize_variable`, `set_variable_to_random` and `resize_array`. Link variable reads to writers inside scripted helpers, scope-prefixed names and `array^index` elements, removing most false `EVENT_GATE_WITHOUT_WRITER` warnings.
- Stop inferring missing scripted helpers from native effect arguments, condition blocks of decisions, ideas, focuses and raids, trigger iterators and data fields of definition files.
- Report unresolved references in event analysis only for symbol kinds that analysis indexes; sprite and interface references are left to the full index.
- Keep distinct event findings in one owner separate instead of collapsing them to the first finding per code.
- Report impact dynamic references only for symbol kinds the traversal reaches, list affected files in `data.affectedFilePaths`, and leave `changedFiles` empty for this read-only analysis.
- Treat undeclared `has_variable` and `has_event_target` inputs as unresolved in open decision scenarios, matching flags; `closedFlags: true` keeps them absent.
- Complete workspace-wide event `lint`, `state_flow`, `impact` and unselected renders on large mods. Helper expansion stops at its fixed work ceiling with an `EVENT_HELPER_PROJECTION_LIMIT` finding instead of failing with `DEPENDENCY_WORK_LIMIT`, and dependency checkpoints are spaced by the size of the previous save so their cost stays linear.
- Remove quadratic passes from root discovery, event cycle checks, selector-scoped lint and terminal or unresolved renders. Root discovery on Chaos Redux with vanilla falls from minutes to under a second.
- Report each recursive scripted-helper loop once instead of once per caller, and read `event_target:founder.values` as the target `founder`.
- Return the overview and the branch renders that fit when an unselected overview spends its raster budget, with `omittedBranchRenders` and `coverage.budgetOmittedBranches`, instead of `RENDER_AGGREGATE_BLOCKED`.
- Add `data.summary` to `explain_path` (route found, steps, event IDs, failure reason) and event `impact` (reach counts); root summaries list the mod's own callerless events first with counts by layer, and finding summaries rank the mod's files first with `byLayer` counts.
- Keep decision gate, cost and lifecycle evidence when the installed game version is not verified for AI-weight adapters; the AI part is unresolved with a `PROBABILITY_GAME_VERSION_UNSUPPORTED` warning.
- Raise the semantic reference ceiling for impact analysis and source lookup to its supported maximum of 1,000,000, so a large mod with the base game is analyzed completely.

## 4.1.0 - 2026-10-15

- Add reference-image `create_world` requests with automatic dimensions, countries, biomes, coastline interpretation, drainage, offline English label recognition, optional aligned layers and reviewed semantic hints.
- Add `preview: true` to map rewrites. Previews validate and render without creating or applying a rewrite transaction; failed generation is never illustrated using the unchanged base-game map.
- Guard local reference inputs with canonical workspace checks, bounded decoding, fixed-memory original-source hashing and stale-source verification. OCR uses packaged local model data and bounded worker lifetimes.
- Generate smoother relief, connected terrain-dependent provinces and downhill rivers; use installed palette conventions, distinct country filenames and actual urban footprints.
- Cache map colors per province instead of hashing them for every rendered pixel. Retain deterministic pixels and artifact contents.
- Preserve reviewed city, state, sea and region names and report uncertain interpretation. Map generation remains an offline foundation, with live acceptance evidence reported separately.
- Add starter bookmarks, country histories, infantry templates, units, stockpiles and production; isolate old-world AI and startup hooks while retaining shared continent identifiers.
- Track generated outputs and safely remove obsolete files on regeneration; reject edited outputs and malformed inventories. Bound complete-world inline diffs so preview links remain available.
- Clean detached water speckles without turning lake islands into ocean pockets, preserve native province extent limits, and emit building positions without a spurious final record.

## 4.0.5 - 2026-10-14

- Keep child anchors independent of parent `origo`, so centered native windows place their controls inside the frame.
- Preview division and HQ branches separately and close native selector overlays by default. Existing scenario values and visibility bindings select panels explicitly.
- Preserve dropdown button and expanded-panel boundaries, including closed visibility, settled positions, backgrounds, clipping and attached scrollbars.
- Render background-free scroll containers using their declared viewport bounds; retain findings for explicitly disabled clipping and invalid boundaries or references.
- Resolve public scrollbar templates despite unrelated private namesakes. Public tool schemas and dependency versions are unchanged.

## 4.0.4 - 2026-10-14

- Preview individual GUI windows without redundant full symbol indexes, workspace-wide asset fallback or unbound country-flag inventories; reuse condition definitions across render variants.
- Index technology sources once across layers and scope folder rendering to definitions, layouts and unlock targets. Full inspection retains inbound grants and references.
- Report render phases and include the last phase in worker deadline errors. Existing parsing, raster-memory, canonical-path and stale-source limits remain enforced.
- Resolve transitive localisation `$KEY$` references across files and bounded scenario substitutions; retain diagnostics for cycles and missing runtime values.
- Honour numeric flag presence in scalar visibility checks, matching valued-flag super-event localisation conditions.
- Preserve supplied GUI scenarios by default; exploratory `generatedScenarios` is now opt-in. Explicit state/resolution matrices and public schema shapes are unchanged.
- Retain regression coverage for hidden sub-windows, timed animated-sprite frames, 16-bit DDS portraits, declared font colours, worker recovery and render-memory ceilings.

## 4.0.3 - 2026-10-12

- Publish the README with the supplied HOI4 MCP Server thumbnail and direct links to the demo video on YouTube.
- Include the exact install command in the authored release page. Server behavior, tool schema shapes and dependency versions are unchanged from 4.0.1.

## 4.0.2 - 2026-10-12

Not published: release validation stopped before publication because the authored page omitted its install command.

- Put the published demo video first in the README, using the supplied HOI4 MCP Server thumbnail and a direct link to the YouTube video.
- Use a public image URL so the thumbnail also loads on the npm package page.
- Documentation and release metadata only; server behavior, tool schemas and dependency versions are unchanged.

## 4.0.1 - 2026-10-12

- Clean temporary test fixtures after each test, suite teardown and normal process exit. Reject fixture truncation above a 256 MiB aggregate disk budget before Windows allocates the file.
- Recover stale reference-source and random-name event-evaluation scratch on startup after three hours, with local process leases, lock and canonical-path checks. Evict dead owners oldest first under a 256 MiB scratch cap; preserve live owners and dated benchmark evidence.
- Document the leak's test-fixture origin. MCP reference lookup already reads configured sources directly and uses the shared persistent analysis cache; it does not copy a source tree per call or process.
- Describe modding tasks in plain language across the README, guides, package metadata and MCP tool descriptions.

### GUI render

- Decode uncompressed 16-bit RGB DDS portraits, including the 5:5:5 format used by vanilla leaders; truncated pixel data remains unsupported.
- Preserve declared font colours when a same-name bitmap atlas is loaded, including the dark super-event description font. Atlas metadata no longer outranks a named font declaration, and source links retain that declaration.
- `hoi4.gui_render` and `hoi4.gui_inspect` model the engine-controlled branches of `countrypoliticsview` instead of drawing all of them: no faction, faction leader, faction member and balance of power are chosen from the scenario country (`tag`, `ideology`, `faction`, `balanceOfPower`, or its `history/countries` facts at the scenario date), and `pol_faction_icon` follows the ruling ideology instead of its static frame. Explicit scenario visibility, values and selected frames still win.
- GUI text keys are matched without regard to case, so a window that spells `buttontext` in lower case (the vanilla trade window) shows its localised label instead of the key.
- Element visibility honours `show` as well as `visible`, `hide` and `hidden`, and scenario `name.visible` values may be yes/no words or 1/0 as well as booleans.

### Job workers

- Uncaught worker failures log only a bounded diagnostic code; exception messages, stacks and thrown values are excluded to protect source text and credentials.
- A worker that stops without a result is now reported by its real cause. The host keeps each worker's exit code, signal and last standard error and fails the job with `JOB_WORKER_EXIT` naming a V8 heap limit (with its size), a native out-of-memory, a native crash, an external termination, a stop by the server's own deadline, or an uncaught job error with its error code. Earlier releases discarded this and always suggested that memory ran out. Logs of workers that ended unexpectedly are kept, newest ten, in `job-workers/logs` under the server state root.
- Workers start with a V8 heap ceiling of a quarter of physical memory, between 2,048 and 8,192 MiB, when `jobWorkerMaxHeapMiB` is not set. Node's own default tops out near 4.5 GB, which a large GUI render on a big mod can approach.
- `hoi4.gui_render` rasterizes its derived variants, the comparison renders and the galleries one at a time instead of together, which lowers the peak native memory of a render.

## 4.0.0 - 2026-10-10

### Known mistakes

- Add a reviewed, source-cited list of documented script mistakes (`known-mistakes.json`, with a detector for each rule) in place of a mutable learned-rule database. `hoi4.script_validate` in file mode flags seven of them as `KNOWN_MISTAKE_<RULE>` with the symptom and the fix and reports `known_mistakes` in `checksPerformed`: an event without `add_namespace`, an event number that is not a whole number below 100,000, a timer on a triggered-only event, an automatic event that can fire every day, a news event that is not `major` or is `fire_only_once`, a date window shorter than the 20-day trigger check, and a scope prefix on a temporary variable.
- `hoi4.reference_context` returns the `knownMistakes` of the requested surface, and `hoi4.error_log` adds `knownMistake` (rule id and fix) to a logged message that a rule explains. A rule that no longer applies is kept as `resolved` with the date and reason and is not applied.

### Maps

- `move_state_provinces` redistributes by default: without a `distribution`, or with `"proportional"`, the target receives the moved provinces' share of the source state's manpower, resources and slot buildings (in whole units; levels such as infrastructure keep the higher value). `stateValues: "retain-in-current-states"` keeps the old behaviour.
- `merge_states`, `create_state` and `split_state` accept `remapReferences` (`refuse` or `override`) to rewrite the scripts that named the state in the same plan.
- Script references now include `has_full_control_of_state`, `set_state_controller`, `to_state`, `border_state`, `capital` in any script, `set_province_controller`, `reset_province_name`, `goto_province`, `prioritize_location`, `to_province`, `region`, `area`, `prioritize = { ... }` lists and `province = { id = ... }` blocks. Arguments that take exactly one value are never copied or deleted by a remap; they change to the first successor, or stay and are reported as `MAP_REFERENCE_NEEDS_REVIEW`.
- `MAP_COUNTRY_CAPITAL_NOT_OWNED` is checked only in `history/countries`.

### Tools

- Show at most 8 resource links beside a result (images first); every artifact stays in `structuredContent.artifacts`. A GUI render result was about 33 KB, a third of it links listed twice. Passed validation checks that only report a problem "not detected" are no longer listed.

### Workers

- A warm job worker whose heap still holds more than 40% of its limit after a job and a full collection exits instead of waiting for the next job. Against the real Chaos Redux mod, a GUI render followed by a decision inspection in one worker ran past the 4 GB heap limit and ended with `JOB_WORKER_EXIT`; the next job now starts in a fresh worker. The `JOB_WORKER_EXIT` message now names an out-of-memory exit and the `jobWorkerMaxHeapMiB` setting.

### Documentation

- Add a troubleshooting guide with the error codes and their fixes, the tool audit and the review of smerss/Clausewitz-MCP and cpntodd/HOI4-MCP under `docs/plans`, a worked example that builds and reshapes a world in the map guide, and a section on adding a known mistake to the development guide.

### Breaking changes

- 37 tools become 28, one inspect tool per domain:
  - `hoi4.probability_inspect` finds weighted logic and evaluates it in the same call, with a fact-free scenario when none is given; `evaluate: false` returns only the inventory. `hoi4.probability_analyze` replaces `hoi4.probability_evaluate`'s siblings `_sweep`, `_simulate`, `_sequence`, `_compare` and `_render`, selected by `analysis`; `hoi4.probability_evaluate` itself is folded into `hoi4.probability_inspect`.
  - `hoi4.event_compare` and `hoi4.tech_compare` become `mode: compare` of `hoi4.event_inspect` and `hoi4.tech_inspect`.
  - `hoi4.focus_raster` is folded into `hoi4.focus_render`, which now produces the PNG with decoded icons by default; `png: false` keeps the vector-only output.
  - `hoi4.map_render` is folded into `hoi4.map_inspect`: a `layer`, `overlays`, `scale`, `tile` or `area` renders that view.
- Inline results list at most 12 scanned files, mod files first.

- The HTTP server verifies the bearer token before it reads a request body, so an unauthenticated `POST /mcp` receives `401` without its body being parsed; body-dependent scopes such as `hoi4:write` for rewrites are checked again afterwards.
- Behind a trusted proxy, rate limiting uses the rightmost `X-Forwarded-For` hop that is not a trusted proxy instead of the leftmost, client-supplied entry.
- A rewrite journal that cannot be recovered no longer stops startup: the server starts, and rewrites of that workspace fail with `TRANSACTION_RECOVERY_REQUIRED` until recovery succeeds. A journal folder without a manifest is skipped.
- Rolling back a transaction keeps a planned file that was never replaced and has no backup, instead of refusing the whole rollback; a replaced file that changed since still reports `TRANSACTION_STALE`.
- `tools/list` omits the JSON Schema dialect and the safe-integer bounds that every integer field repeated; field types, ranges and descriptions are unchanged.

### Agent ergonomics

- Accept the argument shorthands agents most often send: an event selector as a plain string or without `kind`, a GUI scenario without `id`, a decision inspection without a scenario, a probability scenario set as a bare list or without ids and `state`, a probability `source` as a string, and `generatedScenarios.maxScenarios`. The full event selector is published in the tool schema. Also a namespace wildcard such as `chaosx.nr14.*`, a selector with `id` for its own field, a trace started from `from`, a GUI inspection without a scenario, a decision by `decisionId`, and a script file check that names the kind and scope its file fixes.
- Answer invalid arguments with a tool error, code `INVALID_ARGUMENTS`, naming each failing field, what it expected and a working call, instead of a protocol error that clients reduced to "Invalid tool arguments". Error and blocked results carry their blockers in the text content, which is what clients show for an error.
- Find decisions in files that open the same category block more than once; such decisions were reported as unresolved definitions. Decision inspections list each scenario's eligible, visible and available outcome inline, and a sample of any unresolved definitions.
- A snippet check without a `kind` is read as the effect or trigger with fewer errors and unresolved commands, and a `limit`, `maxDepth`, `maxNodes` or `maxEdges` above its maximum is lowered to the maximum, instead of rejecting the call.
- Return the answer inline: probability results rank the strongest candidates per scenario with weight, probability and MTTH, list the facts still missing, and list the largest changes of a comparison.
- An event ID in a probability `candidatePool` stands for all its options and a `random_list` ID for its entries; a pool alone finds its defining file; a wrong adapter guess, such as a mission named as a decision, switches to the matching adapter.
- Order inline diagnostics with the mod's own files first, summarise an omitted flood by code, and keep the first diagnostics of an oversized result instead of dropping them all.
- Name the error kind and a path-free message for unexpected failures, and print the cause of a startup failure such as a configuration file's JSON error.
- `hoi4.error_log` adds a fix hint per category, groups messages that differ only in names and numbers into `patterns`, and compares each new launch's log with the previous one: `sinceLastLaunch` counts new, persisting and fixed entries and every entry says whether it is new.
- Every tool description now says what the tool is for, shows a working example call and gives the size of the answer, and every invalid-argument error shows an example for its tool (28 of 28; ten before). Tests send each published example to its tool's schema, and `docs/tools.md` lists the examples with the result sizes.

### Speed

- Keep a job worker warm for `jobWorkerIdleSeconds` (default 180) after a job, so its server's next job reuses the loaded indexes instead of scanning cold. An idle worker holds no execution slot and exits with its server; a failed job never leaves a worker for reuse.
- Authenticate persistent cache entries over their metadata and payload hash instead of the whole payload, decode a cached parsed document when it is first read instead of for every file at load, and stop copying the payload of an entry that is already stored on every scan. The entry format version is 2, so older entries are rewritten once. Fill the canonical copy used for hashing and for index segments directly, about 40% faster on large segments with identical output.
- Record where a cold index of a large mod spends its time, and why a background warm-up of the persistent cache does not help it, in ADR 0045. Add `npm run benchmark:cold`, which times `hoi4.mod_index`, an event lint and a decision inventory in a first and a second server process.

### Maps

- Add `create_world` to `hoi4.map_rewrite`: a complete new map from dimensions, a seed, land coverage or outlines and countries, with provinces, terrain, heights, rivers, trees, colour maps, continents, strategic regions with weather, states, country files, history, flags, a bookmark, localisation, positions, supply and `replace_path` entries.
- Add `regenerate_map_positions` (building, unit-stack and weather positions from geometry), `rebuild_supply` (supply nodes in state capitals joined to each country's hub by railway, or only the states with a supply gap) and `remap_map_references` (rewrite script references to changed states, provinces or regions, copying a reference per successor, and override game files only on request).
- Add `references: true` to `hoi4.map_inspect`: missing state, province and region references across events, focuses, decisions, helpers, history and AI areas, undeclared state tags, and countries whose capital they do not own.
- Split states with dated history: dated ownership and effects apply to both parts, and dated victory points and buildings follow their provinces. Merges carry dated blocks without building levels.
- Keep level buildings (infrastructure, air bases, anti-air, radar, or any building without `shares_slots`) at their level in both parts of a split and at the highest level in a merge, and divide slot buildings and resources in whole units.
- A merge's distribution policy may be omitted. Generated positions take their height from the heightmap. Province 0's reserved null row no longer reports an unknown terrain or a missing continent.
- Name transaction diff artifacts safely for files with spaces in their names.
- Say why a restored rewrite failed: `JOB_REWRITE_RESTORED` now names the error and the first failing check or blocking diagnostic, such as `GUI_REFERENCE_UNRESOLVED`, instead of only that the source was restored.
- Review a new world over sources that hold no map without a "before" picture, instead of failing with `MAP_RENDER_RASTER_MISSING`.
- Notice a changed `descriptor.mod` at the next scan of a running server. A new world adds `replace_path` folders to the descriptor, and its post-write check used to see the base-game states it replaces and fail on duplicate state IDs until the server restarted. Jobs, transactions and caches keep the workspace identity they started under.
- Stop undoing map rewrites that touch a state file. The post-write check scanned only the changed files, so every province a state lists counted as an unresolved reference unless the rewrite also changed `map/definition.csv`; a split, merge or manpower change on a real map was restored with `JOB_REWRITE_RESTORED`. The check now also reads `map/default.map` and the map CSV files.

### Tools

- Add `hoi4.error_log`: read the game's `logs/error.log` from its last launch, grouped by category, with each entry's source file, line and layer, whether that file changed since the log was written, and `scope`, `category` and text filters. Set `gameUserRoot` when the game's user folder is not found automatically.
- Add `hoi4.mod_index`: summarize a mod's descriptor, definitions by kind, folders and event namespace ranges, or find the next free numbered ID for an event namespace or prefix across every source layer, with the first unused gap.
- Name the tool and up to five failing fields with their reasons when the 2026-07-28 server rejects tool arguments.
- Check every supported family of `hoi4.script_validate` file mode from one shared scan, skip localisation from shadowed files in player-text checks, and report only `§` colour codes in news text.
- Report an overlapping pair whose visibility the GUI scenario does not decide only as `GUI_UNRESOLVED_VISIBILITY_OVERLAP`, without a generic overlap or click-region conflict.
- Print `startup_timeout_sec = 120` and `tool_timeout_sec = 600` in the Codex registrations from `hoi4-agent-tools-setup --print-client-config`.

### Fixes

- Lex Clausewitz whitespace with a character-code test instead of a regular expression per character, which shortens the cold index of a large mod by roughly a quarter.
- Update the MCP SDK packages (`@modelcontextprotocol/sdk` 1.32.1, `core`, `server` and `client` 2.3.1, `node` 2.1.1) and `sharp` 0.35.5 past their published high-severity advisories.
- Keep each file's own diagnostics when an index is rebuilt incrementally after an edit; a rebuild could copy other files' errors and lose real ones.
- Close a cancelled stdio request so the idle limit still applies, count a request open for twice the idle limit as abandoned, and finish open requests before exiting after the launching process exits.
- Record an orphaned worker's own deadline as `JOB_DEADLINE_EXCEEDED` instead of leaving the job running.
- Start one worker launcher per job across HTTP requests and polls, and spawn nothing when the job has finished or a live worker runs it.
- Re-check a rewrite's journal under the workspace lock before applying it, re-hash the backup it moves aside, and take over a stale workspace lock only through an atomic rename that one process can win.
- Refuse reads, not only writes, of server storage (`.hoi4-agent`, artifact and cache roots) through workspace paths.
- Keep artifact listings from removing a folder that a concurrent write is filling.
- Evict a chunked artifact by the age of its newest member, index first, and protect all its pieces when any of them is protected, so a large result's index never points at evicted pieces.
- Treat a job store lock held for more than ten minutes as abandoned even when its process ID now belongs to another process, and wait at most two minutes for the lock before failing with `JOB_STORE_BUSY`, so a lock left by a crashed process cannot hang every job.
- Sweep expired finished job results on first use, and keep the record of a refused task call for five minutes.
- Bound retained scan snapshots by bytes, remove temporary files from failed heartbeat writes, and drop server records silent for two hours.
- Release a foreground task's cancellation listener when the task finishes.

### Documentation

- Restructure the README around what the server does, a four-step quick start, a grouped tool table with what each area writes, and safety notes.
- Add a configuration reference with every key, range, default location and environment variable.
- Complete the GUI scenario and request field tables, and document the prompt, resources, task-capable tools and setup troubleshooting commands.
- Add `docs/RELEASING.md`, the checklist for tagging a release, and describe the stdio smoke suites in the development guide: every tool called once with an agent-style argument shape and once with a wrong field, a generated world split, merged and repaired, and the same calls against the installed game and a real mod.

## 3.10.0 - 2026-10-06

- Rebuild a workspace index after an edit from the previous index, parsing and indexing only changed files, and keep the latest scan of each pattern set and each GUI graph scope instead of one per workspace. A repeated GUI preview of a large, actively edited mod took 64 s instead of 244 s.
- Admit parsed documents to a full cache only on their second miss and only in place of entries never read, so scans larger than the cache no longer serialize and evict every document; build scripted-localisation definitions only for windows that show scripted localisation.
- List every server process sharing a server state root, with its memory, last client activity and execution limits, in the `hoi4-agent://server/status` resource of local stdio connections.
- Refuse an `hoi4.event_compare` or `hoi4.tech_compare` call without references before scanning when no earlier revision is cached, instead of after a full scan.
- Report a `hoi4.tech_render` folder view without `folderId` as a readable argument error instead of a raw validation dump.
- Ship `proxy-addr` 2.0.8, which fixes IP spoofing through IPv4-mapped IPv6 trust subnets (GHSA-jqcg-44mw-7w3h); the HTTP server sets no `trust proxy`, so earlier releases did not reach the affected code.

## 3.9.0 - 2026-10-06

- Exit a stdio server whose launching process has exited, and add `stdioIdleExitMinutes` so clients that keep idle per-subagent connections no longer accumulate servers.
- Stop a read-only job whose worker outlives `jobDeadlineSeconds` (`JOB_DEADLINE_EXCEEDED`) or ignores cancellation for `jobCancelGraceSeconds`, so a blocked worker can no longer hang a workflow.
- Stop an orphaned read-only job worker at `jobDeadlineSeconds` even after its dispatching server has exited, and add `jobWorkerMaxHeapMiB` to bound each worker's heap.
- Check a whole mod file with `hoi4.script_validate` `path`: every event, decision, focus, scripted helper, and on-action body with the scope its structure fixes, the mod's own scripted helpers as known commands, and building, ideology, and resource trigger keys.
- Report a dynamic variable compared as a trigger (`SCRIPT_DYNAMIC_VARIABLE_AS_TRIGGER`) and a scope link outside its documented source scopes (`SCRIPT_SCOPE_LINK_WRONG_SCOPE`), and enter `owner`, `controller`, `capital_scope`, `overlord`, and `faction_leader` blocks with their target scope.
- Check player-facing text in `hoi4.script_validate` file mode: colour codes in news and report events, including through scripted localisation, development wording in shown text, and unlocalised flags in decision and focus requirement tooltips.
- Report visible events fired inside `every_*` loops that reach one player once per iteration, either through a fixed recipient or as a major event (`SCRIPT_EVENT_POPUP_REPEATED`).
- Publish the GUI scenario shape on `hoi4.gui_inspect`, `hoi4.gui_render`, and `hoi4.gui_rewrite`, with `id` required, so clients can build a valid scenario from discovery.
- Add `closedFlags` to GUI scenarios: undeclared flags are unset, as in the game, so flag-driven tab pages and panels render one at a time.
- Resolve a window's scripted localisation exactly under the supplied scenario wherever its flags, variables, and values decide the branch; undecided tokens still render as `[dynamic_loc]`.
- Warn with `GUI_UNRESOLVED_VISIBILITY_OVERLAP` when overlapping elements are drawn together because the scenario does not decide which one is visible.
- Warn with `GUI_NEAR_CENTRE_OFFSET` when an element sits a few pixels from its parent's horizontal centre.
- Add `background: "transparent"` to GUI scenarios for renders without the preview backdrop.

## 3.8.1 - 2026-10-05

- Start normally when finished rewrite journals were recorded before the workspace roots changed, such as before installed DLC folders became source layers, and let them expire; an interrupted rewrite under changed roots is still refused.

## 3.8.0 - 2026-10-04

- Rank documentation with field-weighted BM25 over identifier-aware terms, cite identifier table rows as exact one-line sections, return each result's best-matching `matchLine`, and split sections by CommonMark fences.
- Locate a source position with `hoi4.source_lookup` `path` and `line`: return its layer, the containing definitions, the enclosing assignment chain, and a `keyPath` that navigates back to it.
- Suggest indexed identifiers within three edits when `hoi4.source_lookup` finds no definition.
- Layer installed `dlc/` and `integrated_dlc/` folders between the base game and mods in internal-ID order, so source lookups, renders, and analyses find DLC sprites, interfaces, and portraits; `includeGameDlc: false` opts out.
- Apply `replace_path` entries from mod and dependency descriptors in addition to configured replace paths.
- Check province terrain and continents against the active `common/terrain` categories and `continent.txt`, accept any water terrain for seas and lakes, check strategic-region `naval_terrain`, and report adjacency rows after the `-1` terminator or a missing terminator.
- Search unresolved GUI asset names in grouped wildcard patterns, so windows with hundreds of missing textures render within the wildcard-pattern ceiling.
- Retry transient Windows sharing violations on job records and capacity leases, release record handles before parsing, bound delete-pending capacity slots by elapsed time, and report worker coordination failures with a fixed stage and allowlisted native code.
- Keep every production dependency inside its declared range in the published shrinkwrap, so `npm ls` succeeds in consumer installs; the `@hono/node-server` override is no longer needed.

## 3.7.0 - 2026-10-04

- Publish an `npm-shrinkwrap.json` so every install reproduces the reviewed dependency closure, including all platforms' optional Sharp binaries (about 300 MB installed).
- Navigate exact nested source assignments and page through bounded child structure, including repeated keys and same-line blocks.
- Limit definition-only event/helper lookups to their source family and reuse semantic reference analysis for unchanged snapshots.
- Check snippet syntax, native command kinds, and declared scopes against cited installed or explicitly selected generated documentation, with unresolved coverage reported separately.
- Verify source files in bounded parallel batches, reject changing or replaced paths, and bound optional cache persistence without truncating analysis.
- Load isolated workers' domain modules after authenticating the job, preserving exact operation admission and recorded write policies.
- Filter reference scans by authority, reuse citation hints, decode supported reference encodings, and preserve byte-bounded continuations and explicit omission counts.
- Replace the unpatched globbing dependency chain and update vulnerable transitive pins, preserving relative-path, symlink, literal-filename and pattern-complexity checks.

## 3.6.0 - 2026-09-27

- Preview immediate tooltip text from source localisation with declared position, width and padding, using the source tooltip sprite and font.
- Keep unknown GUI visibility and enablement separate from confirmed states, branch coverage and click regions.
- Identify inferred scrollbar gutter geometry as approximate.
- Provide a shorter setup guide, practical examples with real renders, and a separate tool reference; remove redundant planning and release-history documents.

## 3.5.1 - 2026-09-27

- Preserve installed-game and offline-wiki citations in compact reference context bundles, select question-relevant sections within required sources, and report sources omitted by the result limit separately from missing files.
- Exercise one-, two-, and eight-result context budgets across six real-source work surfaces while retaining the nine-query discovery benchmark.
- Allow up to five minutes for npm registry processing before publication verification fails.

## 3.5.0 - 2026-09-26

- Search and read bounded, revision-bound local offline-wiki, installed-game, and optional generated-script documentation sections; retrieve task citation bundles and exact indexed source definitions and usages through four read-only MCP tools.
- Compare hash-bound frozen probability source files at their logical gameplay paths while preserving physical source provenance and leaving current files untouched.
- Keep candidate eligibility overrides separate from weight-modifier conditions so an eligible scenario does not force every modifier to apply.
- Evaluate hidden and custom-tooltip trigger wrappers with their enclosed conditions while excluding presentation metadata from eligibility logic.
- Accept explicit GUI scenario dates and state-controller facts, evaluate their source conditions, render requested native windows at their declared settled show position, and resolve native list templates and scenario-only localisation from the correct source.
- Honor single-line native labels and preserve the first inferred font line, with explicit fidelity reporting for undersized native text-height conventions.
- Preserve dotted event namespaces so a namespace query selects its own events rather than unrelated systems sharing the first name segment.
- Compact selected event diagrams without retaining empty row gaps from the rest of the workspace graph.
- Resolve supported dated state-history values at the earliest active bookmark for map inspection, and refuse state rewrites that would silently conflict with or discard dated commands.
- Interpret floating-harbor placements as sea-side markers with land targets, preserving vanilla-compatible anomalies as source-linked review warnings instead of thousands of false map errors.
- Show alternatives within a national focus prerequisite group with dotted connectors, leaving individually required prerequisites solid.
- Draw wide technology-folder icons at their decoded sprite dimensions and the source GUI's icon anchor, preserving 131×52 chemical cylinders instead of shrinking them to 70×70.
- Include user-approved in-game focus and technology captures beside current-source and source-matched historical MCP renders, with source revisions and explicit whole-image comparison limits.
- Include native-size vanilla and Chaos Redux interface references with declared scenarios, full images, diagnostics, and source hashes; keep game imagery outside the npm package.

## 3.4.1 - 2026-09-25

- Validate technology renders against the requested view's source placement, node coverage, and sprite resolution without inheriting unrelated graph-wide diagnostics, while reporting deferred whole-workspace helper projection as a separate analysis boundary; resolve subtechnology art from the source GUI slot before using a technology-id fallback and include every referenced slot texture in the asset scan.
- Accept focused event inspection and render evidence when every event source was scanned and no blocking diagnostics remain, while retaining deferred workspace-wide helper and lifecycle projections as an explicit boundary.
- Keep repeated window-local GUI control names additive in the shared index, exclude engine-owned compound-control roles from scripted click-effect requirements, and preserve compact operation summaries when linked evidence exceeds the MCP wire budget.
- Parse each active scripted-effect source document once when building mechanic helper inventories so bounded real-workspace scenarios do not multiply parser state by the number of helpers in a file.
- Interpret declared temporary-variable assignment, arithmetic, rounding, clamping, and scope-valued inputs with chain-wide unscoped semantics in bounded mechanic scenarios.
- Evaluate `has_variable` against declared scenario state so guarded defaults and subsequent temporary-variable arithmetic remain deterministic.
- Follow a live replacement worker through its terminal publication instead of returning a nonterminal job record during concurrent checkpoint recovery.

## 3.4.0 - 2026-09-20

- Add branch-local focus cleanup with pinned anchors and symmetry groups, connector measurements, source-linked crops, and scenario-backed structural route diagnostics.
- Report GUI visibility and enabled branches, measured label and background boxes, and matched source-baseline renders alongside scenario comparisons.
- Expose complete source-backed probability catalogs, actionable missing scenario inputs, and eligible, excluded, and unresolved inventories.
- Add selected event-chain comparisons and revision-bound bounded helper expansion while retaining explicit lifecycle coverage limits.
- Compose technology folders from source pixel placements, native item skins, icon and subtechnology positions, panel and background artwork, year labels, and supplied research scenarios; report unresolved placement and asset coverage honestly.
- Resolve source `GFX_*_medium` artwork and design-team overlays at native item size for chemical and biological warfare folders.
- Compose installed GUI backgrounds, focus inlays, container scrolling, native button and progress shaders, and scenario-driven rows from source assets and control states.
- Bound focus connector and overlap diagnostics on anchored trees with thousands of nodes.
- Add focused map lookups, reusable render tiles, affected-area output, and typed external script-reference updates for map renumbering.

## 3.3.0 - 2026-09-20

- Add `hoi4.mechanic_test` with copied versioned scenario state, bounded source effects, explicit time advancement, traces, and typed gameplay assertions.
- Add `hoi4.package_check` for declarative package definitions, calls, registrations, localisation, assets, and required suite-case references.
- Add `hoi4.scenario_test` for named inline or workspace-owned suites through fixed read-only operations, case artifacts, and authenticated revision-bound continuation.
- Share declared condition state across GUI and probability adapters while preserving their public inputs and specialized evaluation semantics.

## 3.2.0 - 2026-09-20

- Add read-only `hoi4.impact_inspect` with active and overridden definitions, direct and transitive source consumers, state-key access roles, cycle and coverage evidence, and in-memory source comparisons.
- Connect event, focus, decision, idea, technology, scripted-helper, localisation, scripted-GUI, GUI, sprite, and texture references where typed static source evidence supports an edge; leave dynamic and unsupported references unresolved.
- Identify affected declared scenario-suite cases from bounded workspace-owned JSON references without executing them.
- Add read-only `hoi4.decision_inspect` for decision and mission inventory, declared actor and target gates, costs and direct payments, lifecycle paths, and scenario-by-scenario source comparisons.
- Reuse the probability adapters for decision and mission AI scores and score comparisons, retaining linked traces and explicit proposal limits.
- Serve both tools through ordinary and persistent native MCP tasks over legacy and modern stdio and HTTP routes, with revision-bound linked reports and source-preserving overlays.

## 3.1.0 - 2026-09-20

- Reuse authenticated content-addressed parsed documents and file-local index segments across authorized local processes while revalidating current source bytes, load order, shadowing, workspace topology, and principal scope.
- Rebuild exact indexes from immutable segments, retain typed reverse source dependencies, and heal malformed or tampered persistent cache entries without trusting timestamps or file sizes.
- Run event, technology, probability, map, GUI, and focus analysis in fixed-entry isolated workers backed by durable authenticated jobs, revision-fenced ownership, bounded retention, and source-revision result checkpoints.
- Advertise optional negotiated MCP tasks for all long-running domain calls while preserving exact ordinary-call results, progress, cancellation, linked resources, tool errors, and both stdio and HTTP compatibility.
- Share task execution, authorization, and all 23 domain tool definitions with an MCP 2026-07-28 Tasks extension adapter, routed by production stdio and authenticated HTTP entry points.
- Share `hoi4.job_inspect` and `hoi4.job_cancel` between protocol adapters as responsive, principal-private compatibility controls that remain available while domain execution slots are occupied.
- Share the bounded probability-analysis prompt metadata and body between protocol adapters without starting jobs or source analysis.
- Advertise the same server instructions through legacy initialization and modern discovery.
- Deliver opt-in modern request progress through the SDK's related-notification API, preserving ordered heartbeats and cancellation over connection and auto-streaming production HTTP serving.
- Pin each bounded stdio connection to its opening protocol era and route authenticated modern HTTP claims through strict SDK validation without changing legacy stateful sessions or the existing request-security gates.
- Share the two opt-in ChaosX private-tool implementations between stdio protocol generations while keeping them absent from ordinary and HTTP catalogs.
- Pin patched Sharp, Hono, Vitest, and coverage packages while retaining the exact dependency graph in the lockfile.
- Require caller-stable request keys for native background focus, GUI, and map rewrites; deduplicate exact retries independently of polling hints and reject conflicting reuse.
- Derive new job IDs from private server state, preserve authenticated earlier retry receipts without replay, and authenticate modern task handles before execution admission or cancellation.
- Renew only task-visibility metadata for exact retries of expired rewrite receipts, preserving terminal outcomes and source edits through native and ordinary calls in both protocol generations.
- Share bounded artifact-resource reads between protocol generations, including exact byte ranges, continuation links, manifest projection, and workspace-grant checks.
- Bind rewrite transactions and domain completion recipes before source application, reconcile stopped workers without replanning, and retain post-write validation artifacts without changing immutable plan hashes.
- Retain revision-addressed event and technology graphs for comparisons after process restart, and preserve explicit helper, source, candidate, node, edge, and render coverage boundaries.
- Add opt-in bounded `helper_expansion` pages for event and technology inspection, preserving distinct source call paths and resumable principal- and revision-bound cursors without retaining completed traversal history.
- Mark depth- and projection-truncated materialized helper graphs incomplete, and retain explicit cycle, dynamic-reference, source-coverage, and page-retention boundaries.
- Harden Windows atomic job publication, bounded pre-dispatch worker-lease transfer retries, disconnect recovery, principal isolation, task expiry, and mutation-receipt retention under concurrent clients.

## 3.0.9 - 2026-09-08

- Evaluate GUI scripted-localisation branches through the shared structured condition evaluator instead of regex threshold guesses.
- Correct inclusive boundaries, compound conditions, negation, variable operands, constants, and named scopes; retain the existing probability API through core compatibility exports.
- Resolve source-backed scripted-trigger calls, including declared scalar parameters, and retain helper provenance and unresolved conditions.
- Keep an unknown earlier localisation branch unresolved instead of selecting a ranked candidate or an unproven fallback.
- Preserve explicit values and seeded exploratory previews, expose optional named GUI scope bindings, and include per-choice condition evidence in scenario artifacts.
- Add independent condition truth-table tests and generated-scenario-to-render regressions for the reported failures, colours, scoped helpers, placeholders, and repeatable SVG/PNG output.
- Align the sparse-mod stdio test's overall budget with its RPC waits and honor matching progress notifications without removing the finite test deadline.
- Avoid Windows path-resolution races while concurrent stdio processes release capacity slots, retaining private-root validation and explicit linked-slot rejection.
- Retry Windows delete-pending capacity-slot creation without admitting duplicate work; persistent permission failures remain bounded errors.

## 3.0.8 - 2026-09-05

- Queue simultaneous tool calls fairly across HTTP sessions and coordinate expensive operations across local task processes sharing private server state.
- Rotate across every waiting session and canonicalize configured storage aliases, including Windows short-name paths, before acquiring shared execution capacity.
- Keep every tool call responsive with strictly increasing MCP progress notifications during execution and queue waits; allow cancellation and discovery while tool capacity is occupied.
- Separate HTTP request admission and body-byte reservations from expensive execution capacity, replacing the two-request ceiling with defaults suitable for parallel agents.
- Keep active HTTP sessions alive, yield during shared source indexing, and serialize backpressured stdio output without leaking listeners or leaving sends pending after a disconnect.
- Share cached GUI source graphs across sessions using the same engine instead of retaining a separate graph per client.
- Reverify artifacts after metadata changes caused by concurrent publication-link cleanup, avoiding false hash collisions while still rejecting altered bytes.
- Serialize artifact admission, publication, and failed-batch cleanup across processes so one writer cannot remove evidence committed by another.
- Add concurrent production workflows spanning focus, GUI, map, event, technology, and probability tools over both transports, including shared artifacts, session expiry, cancelled queue entries, and abandoned process recovery.
- Qualify each map layer separately from semantic and pixel diffs so failures and deadlines identify the affected operation rather than an aggregate rendering loop.
- Update `fast-uri` and `qs` to patched releases identified by the dependency audit.

## 3.0.7 - 2026-09-01

- Reclaim detached parser, graph, and render memory after the idle cache window so parallel coding-agent tasks do not retain large V8 heaps and trigger `Transport closed` through host memory exhaustion. Idle cleanup is coordinated across every MCP domain and never compacts during an active tool call.
- Give packed-package build, pack, and isolated-install qualification enough time on loaded Windows runners while retaining bounded subprocess timeouts.

## 3.0.6 - 2026-09-01

- Prevent long-lived coding-agent tasks from exhausting the host and closing MCP transports. Stdio disconnects now abort in-flight requests, vanilla scan caches are byte-bounded, event and technology histories are reduced, probability results are bounded, and heavy domain caches are released after a concurrent-safe idle window.
- Improve enlarged HOI4 bitmap text with restrained Lanczos2 interpolation while leaving native atlas coverage unchanged. The renderer still applies no sharpening, thresholding, opacity gain, or reconstructed edges.
- Refresh the source-backed Chaos Meter, Communist Insurgency, and settings-window render examples with the production GUI route.

## 3.0.5 - 2026-09-01

- Remove enlarged-font edge reconstruction and per-glyph coverage normalization. HOI4 bitmap glyphs now use their decoded atlas samples with nearest-neighbour scaling and integer output placement, without synthetic sharpening, thresholding, gain adjustment, or invented edge pixels.

## 3.0.4 - 2026-09-01

- Reconstruct enlarged HOI4 bitmap-font antialias edges at the target pixel density and snap bitmap glyphs to the output grid so fractional and high-scale renders remain crisp without changing the declared font face or metrics.
- Normalize opaque coverage in compressed language atlases before applying localisation colours, preventing faint glyph masks from turning coloured text grey, translucent, or empty on local and VPS renders.
- Extend the installed-game font audit to shape every language-override descriptor at 4× in addition to its native and 2× sizes while retaining complete mixed-colour base-font renders.

## 3.0.3 - 2026-08-31

- Authenticate the final read-only GitHub API provenance check with the workflow token so shared-runner anonymous rate limits cannot leave a valid public release red.

## 3.0.2 - 2026-08-31

- Render enlarged HOI4 bitmap glyphs as pre-scaled atlas masks so VPS and Linux output stays crisp instead of depending on platform SVG interpolation.
- Apply bitmap-font face, border, and localisation colours with portable alpha masks instead of SVG colour-matrix filters that could be ignored by remote rasterizers.
- Clarify that GUI `uiScale` represents the in-game layout scale and is not an artifact zoom control.

## 3.0.1 - 2026-08-31

- Render technology folders with the source GUI's actual small and regular item geometry, infer small items from equipment unlock behavior, and include horizontal or vertical year guides.
- Restore the opt-in `chaosx.focus_country_assets` and `chaosx.visual_revision` tools with direct and stdio discovery coverage.
- Infer unambiguous source-backed probability adapters for evaluate, sweep, simulation, and comparison calls, including calls that previously failed with `PROBABILITY_MANIFEST_REQUIRED` or `PROBABILITY_SURFACE_EMPTY` after a mismatched adapter selection.

## 3.0.0 - 2026-08-31

- Promote the complete focus, GUI, map, event, technology, and probability MCP surface to the stable 3.0 release line after full synthetic, installed-game, external-workspace, transport, package, Inspector, and Registry qualification.
- Render installed HOI4 bitmap fonts and language overrides from their native atlases with deterministic metrics, borders, crisp scaling, and localisation colours; keep the exhaustive installed-font audit as a release regression gate.
- Resolve scenario and dynamic-list country scopes into real ideology-aware flags using each masked-shield definition's own asset dimensions, and render inline HOI4 text icons that appear only after dynamic text substitution.
- Keep large legitimate event and technology workspaces complete and support scenario-resolved dynamic weighted pools without automatic partial-analysis fallbacks.
- Keep explicit-file probability inspection narrow, bound retained source and immutable-game scan caches, and avoid full-workspace rescans when rendering inline or declared custom-pool analyses.
- Build event graphs from one merged source index, retain raw comparison sources instead of parsed scan snapshots, and route selector-scoped inspection and rendering through the focused event graph.
- Keep the public repository focused on the supported release by using one maintained branch and manually reviewed dependency updates.

## 2.8.11 - 2026-08-30

- Render vanilla HOI4 bitmap fonts with their native atlas masks, legacy page fallbacks, inverted-mask handling, declared glyph channels, crisp scaled sampling, borders, and localisation colours; qualify every shipped descriptor and base font family.
- Keep large event and technology workspaces complete by separating game and mod scans, accepting large legitimate Clausewitz sources, retaining large state-access inventories, and removing automatic focused-analysis fallbacks.
- Inspect, evaluate, and compare complete declared dynamic weighted pools with scenario-resolved candidate weights, eligibility, exact probabilities, and complete candidate inventories.
- Authenticate GitHub release-state API checks so release publication does not fail on anonymous API limits.

## 2.8.10 - 2026-08-30

- Fix vanilla BMFont corruption by following declared face and outline channel coverage directly instead of guessing polarity independently for each glyph.
- Add full-word mixed-colour raster coverage and pixel-level face/outline mask checks for glyphs with very different filled areas.
- Keep cross-process artifact admission stable when Windows temporarily locks an in-progress artifact file, and retain tool-discovery headroom for multi-digit patch versions.

## 2.8.9 - 2026-08-29

- Decode BMFont channel roles so installed HOI4 atlases render their face and outline masks separately instead of losing localisation colours.
- Infer black-on-white and white-on-transparent glyph-mask polarity, preserving support for both vanilla fonts and custom mod fonts.

## 2.8.8 - 2026-08-29

- Correct GUI font selection so mod definitions override lower-load-order game definitions, language-specific overrides only apply to their language, and extensionless WOFF assets resolve.
- Accept numeric-block and six-digit Paradox colors, normalize fractional text-color channels, and place color runs from kerning-aware measurements without clipping glyph overhangs.
- Make generated GUI scenarios favour ordinary values, respect literal numeric limits and progress ranges, and keep current/limit pairs coherent.

## 2.8.7 - 2026-08-28

- Isolate stale, foreign, oversized, malformed, and address-mismatched artifact manifests so one bad generated record cannot block unrelated probability, event, GUI, or other MCP evidence routes.
- Repair corrupted deterministic manifests from recomputed expected bytes, validate cached probability resources before reuse, and keep direct foreign-artifact access unavailable without exposing cross-workspace content.

## 2.8.6 - 2026-08-28

- Generate source-aware scripted-GUI scenarios from complete parent/child surfaces, real scripted-localisation candidates, simple threshold conditions, coherent tab states, scoped values, meter ranges, and dynamic-list rows while keeping explicit scenario values authoritative.
- Preserve native HOI4 bitmap-font antialiasing and shadow pixels when applying face and localisation colours, including global and per-font `textcolors` palettes.
- Prevent stale workspace artifacts and irrelevant language font atlases from blocking GUI calls, resolve alternate vanilla raster extensions and repeated path separators, and keep placeholder scenarios opt-in so their intentionally unresolved state does not pollute normal validation.

## 2.8.5 - 2026-08-28

- Render bitmap-font face and localisation colours through alpha masks, including black source atlases, and load exact per-font HOI4 `textcolors` palettes.
- Generate configurable seeded GUI scenarios with plausible dynamic text, numeric values, meters, lists, visibility, control states, and animation frames while retaining explicit values and the unresolved placeholder view.

## 2.8.4 - 2026-08-28

- Render each declared HOI4 font face with its own glyph atlas, native metrics, face colour, border colour, and inherited language-override styling.
- Keep native HOI4 bitmap or outline glyphs when localisation colour markup changes part of a line instead of replacing the line with the generic tool font.

## 2.8.3 - 2026-08-27

- Centered native button labels when HOI4 GUI source uses `text =` instead of `buttonText =`, matching the in-game horizontal and vertical alignment inside button frames.
- Added one scenario `values` map for concrete runtime variables, dynamic text, meter fills, sprites, frames, positions, visibility, and enabled states so agents can render complete value-driven GUI versions without assembling several low-level override maps.

## 2.8.2 - 2026-08-27

- Composed top-level scripted-GUI child windows through `parent_scripted_gui`, instantiated external dynamic-list entry containers, and applied row-scoped image, frame, position, visibility, and enabled values.
- Applied constant scripted visibility and click-enabled triggers, narrowed target scans and diagnostics to linked GUI surfaces, and accepted documented installed-game scripted-GUI contexts without hard false failures.
- Rendered language-correct HOI4 bitmap fonts and recovered installed-game first-page atlases whose actual filename omits the declared page suffix.
- Resolved alternate installed raster extensions, stopped shared sprite textures from producing false symbol collisions, cached unchanged scanned bytes, refreshed active artifact recency, and reclaimed stale temporary artifact debris.
- Made concurrent artifact accounting tolerate entries that finish publishing between enumeration and inspection, and emit the first long-operation progress heartbeat immediately.

## 2.8.1 - 2026-08-27

- Added periodic MCP progress heartbeats for long GUI inspections, renders, and rewrites, with repeated progress notifications that preserve monotonic work values and still honor cancellation.

## 2.8.0 - 2026-08-26

- Added structured `ROOT`, `THIS`, `PREV`, `FROM` chain, saved-scope, and event-target bindings to probability scenarios.
- Added deterministic enumeration and exact complete-pool shares for declared dynamic destination, opposition, donor, and other runtime scope pools.
- Extended exact branching, sweeps, and simulation to update scoped and pool-candidate state without flattening it into the root scenario.
- Added MCP resource counts, a published callable example, 2,048-candidate coverage, and source-linked trigger traces for dynamic scope pools.

## 2.7.0 - 2026-08-24

- Made scripted-GUI layout follow Clausewitz orientation, element-origin, center-position, relative-dimension, local-scale, container-clipping, and fixed text-bound behavior.
- Added deterministic nine-slice cornered tiles, filled/background progress bars, masked shields, and inline localisation GFX icons.
- Resolved ordinary and inline GUI assets case-insensitively through mod, dependency, and installed-game layers so vanilla graphics remain visible in mod renders.
- Removed synthetic state-color overlays from normal renders and retained actual sprite-frame evidence for the requested state.

## 2.6.0 - 2026-08-22

- Added a shared complete map catalog with resolved names, source locations, geometry, memberships, networks, positions, buildings, ports, adjacency, and localisation evidence.
- Made map inspection return a full-map overview and a searchable, clickable HTML navigator with exact province hit testing and pixel/map coordinate lookup.
- Added compact state and province creation defaults, rectangle province geometry, and one-call province, state, and strategic-region ID swapping with connected map-reference and standard localisation updates.

## 2.5.3 - 2026-08-22

- Resolved and embedded technology icons through the complete mod, dependency, and installed-game load order, including vanilla sprites used by mod content.
- Recognized vanilla `SpriteType` capitalization consistently in the shared index and GUI source graph.
- Decoded uncompressed vanilla DDS textures whose header stores total linear size instead of row pitch.
- Added deterministic cross-root focus, scripted-GUI, and technology regressions plus an opt-in installed-game DDS render test.

## 2.5.2 - 2026-08-15

- Distinguished HOI4 small and large technology layouts in graph data and source-positioned folder renders, including exact 72×72 small items selected by `force_use_small_tech_layout`.
- Reverified the public Technology Tree Viewer MCP workflow across
  `hoi4.tech_inspect`, `hoi4.tech_render`, and `hoi4.tech_compare` before
  publication.

## 2.5.1 - 2026-08-13

- Published artifact contents and provenance manifests atomically across independent MCP processes, preventing event, probability, GUI, and other concurrent inspections from observing partially written manifests.
- Recovered clearly interrupted zero-filled or truncated provenance manifests during matching writes and storage pruning while continuing to reject arbitrary malformed or tampered manifests.
- Tolerated temporary-file disappearance during concurrent storage scans without weakening artifact integrity validation.
- Added cross-process publication, interrupted-write recovery, and fail-closed integrity regressions, then verified event inspection, probability inspection, and artifact-resource workflows against the repaired store.

## 2.5.0 - 2026-08-09

- Added exact continuous-focus coordinates and linked palette IDs to compact national focus inspection results.
- Added source-first probability inspection that discovers compatible adapters, candidate counts, and selector examples without requiring the caller to guess a surface type.
- Changed empty or mismatched probability inspection into an actionable discovery result with a reason and suggested adapter while keeping evaluation, sweeps, and simulation strict.
- Prevented focus-tree blocks from being misclassified as decision or mission weighted surfaces.

## 2.4.0 - 2026-08-09

- Added named value-driven scripted-GUI scenario matrices with deterministic SVG, PNG, JSON, and per-element visibility, movement, size, text, and frame-change evidence.
- Added scenario assertions for visible and hidden elements, background or panel containment, and exact label-to-control centering, with source-linked diagnostics across every supplied variant.
- Modelled native HOI4 button-text centering and added automatic diagnostics for visibly off-center labels and text or controls crossing a parent background boundary.
- Updated the production MCP SDK to 1.30.0, the official Inspector to 2.1.0, the Registry publisher to 1.8.1, and patched dependencies; the dependency audit reports no known vulnerabilities.
- Updated the Inspector harness for the current CLI entry point, result envelope, explicit environment forwarding, and longer connection startup budget.
- Generalized installed-game integration tests so mods without their own focus, event, or technology definitions still qualify and use the available vanilla-backed analysis surfaces.

## 2.3.13 - 2026-08-06

- Repacked sparse sibling fan-outs around their structural parent instead of preserving avoidable long prerequisite connectors.
- Moved exclusive descendant branches with their compacted sibling root while keeping shared convergence focuses anchored.
- Added direct branch-packing regressions and reverified the public 1,024-focus MCP rewrite workflow.

## 2.3.12 - 2026-08-05

- Made compact focus rewrites choose among preservation, row compression, linear-chain repair, sibling balancing, and combined strategies instead of forcing one aggressive transformation.
- Limited rewrite rejection to invalid geometry while retaining long paths, fake complexity, branch balance, and compactness as prioritized cleanup objectives.
- Added whole-cohort sibling refinement, collision-aware incremental placement, stable repeat rewrites, and regression coverage through the public Ireland and 1,024-focus MCP workflows.

## 2.3.11 - 2026-08-05

- Made compact focus rewrites straighten offset linear chains and reject artificial staircase or zigzag geometry.
- Tightened compact layout acceptance so long connectors, connector paths through focuses, crossings, asymmetric sibling groups, and off-anchor branches cannot survive a successful cleanup.
- Kept the stricter rewrite deterministic and verified it through the public 1,024-focus MCP workflow.

## 2.3.10 - 2026-08-04

- Routed focus operations to the unique discovered mod containing a requested source when a stale client root points at another mod.
- Added regression coverage for a stale client context requesting Ireland's focus source without a workspace selector.

## 2.3.9 - 2026-08-04

- Bound omitted-workspace tool calls to the connected MCP client's active filesystem root instead of the server process's original working directory.
- Added cross-workspace regression coverage proving an Ireland client root cannot be misdirected to a Slop Redux server working directory.

## 2.3.8 - 2026-08-04

- Regenerated the clean-install lockfile with the release-pinned npm so optional native runtime metadata is complete in CI.

## 2.3.7 - 2026-08-04

- Updated patched transitive URL, address, CORS, and glob dependencies after new npm advisories blocked the 2.3.6 publication gate.

## 2.3.6 - 2026-08-04

- Resolved discovered mod workspaces by their normalized directory or display name so coding agents do not need internal hashed registration IDs.
- Accepted prior automatic and discovered workspace IDs when they uniquely identify the same mod after configuration or path changes.
- Verified focus, GUI, map, event, technology, and weighted-logic inspection against an external `ireland_total_overhaul` mod workspace.

## 2.3.5 - 2026-08-02

- Replaced all-domain scans in focus, map, probability, rewrite validation, and country-asset discovery with domain-specific source inventories.
- Prevented large unrelated mod files from producing `SCAN_BYTE_LIMIT` errors in otherwise bounded MCP work and added low-ceiling regression coverage.

## 2.3.4 - 2026-07-28

- Bounded large game-backed event scans before workspace-wide lifecycle and helper analysis could exhaust the MCP process and close the stdio transport.
- Added automatic focused event analysis for large workspaces, explicit deferred-analysis diagnostics, source-profile reporting, and deterministic regression coverage.

## 2.3.3 - 2026-07-26

- Regenerated the npm lockfile with the pinned release npm so clean installs include the patched optional native runtime packages.

## 2.3.2 - 2026-07-26

- Pinned patched transitive `brace-expansion` and `postcss` releases so the CI and release audit remain clean without changing the MCP Inspector surface.

## 2.3.1 - 2026-07-26

- Fixed large vanilla-plus-mod technology scans that could consume multiple gigabytes and leave the MCP transport open until a client timeout closed it.
- Added automatic focused technology analysis for game-backed and large workspaces, retaining direct source evidence and helper-call indexing while deferring workspace-wide scripted-effect projections.

## 2.3.0 - 2026-07-22

- Added a read-only AI and MTTH Scenario Analyzer with inspect, evaluate, sweep, simulate, sequence, compare, and render tools.
- Added versioned adapters for event MTTH and options, decisions, missions, focuses, technologies, doctrines, direct random chance, `random_list`, supported AI strategy factors, and declared custom weighted pools without treating unlike HOI4 systems as one probability formula.
- Added exact and bounded scenario evaluation, AST-path provenance, nested-random path probabilities, ranges, alternatives, distributions, numeric correlations, configurable diagnostics, named acceptance bands, and explicit external-factor support.
- Added threshold-aware sweeps with trigger-adjacent breakpoints, local elasticities, pairwise interactions, rank reversals, cliffs, and missed target bands.
- Added constant-memory Latin hypercube and seeded pseudo-random simulation, global input importance, Wilson intervals, and discrete daily-hazard MTTH samples with bounded quantile retention and uncertainty evidence.
- Added declared-manifest sequence analysis for recovery, caps, cooldowns, removal, resets, timer changes, terminal states, and per-category outcomes without executing effects or inferring campaign state.
- Added scenario-hash-bound deterministic ranking, matrix, waterfall, timing-survival, sensitivity, threshold, sequence, comparison, and unresolved renders with scenario, candidate, and metric filters.
- Added fail-closed installed-game build verification for the versioned probability adapters.
- Added generated public schemas, callable examples, source evidence, deterministic artifacts, and a project-owned fixture containing more than 150 weighted blocks, 250 scenarios, exact expectations, unresolved cases, and a stateful pool.
- Verified analyzer discovery and workflows over stdio and authenticated Streamable HTTP, package installation, resource retrieval, cancellation, stale-result handling, workspace isolation, large candidate pools, and the official MCP Inspector.
- Expanded event-graph capacity for installed-game and large-mod analysis beyond 100,000 nodes while retaining bounded artifact validation.
- Reconfirmed MCP protocol `2025-11-25`, TypeScript SDK 1.29.0, Inspector 1.0.0, Registry schema `2025-12-11`, and Registry publisher 1.8.0 for this release.

## 2.2.0 - 2026-07-22

- Added a read-only Technology Tree Viewer for classic technologies, legacy and current doctrines, source folder layouts, prerequisites, exclusive choices, categories, tags, unlocks, bonuses, grants, metadata, localisation, icons, and cross-file references.
- Added `hoi4.tech_inspect`, `hoi4.tech_render`, and `hoi4.tech_compare`, with complete graph resources, bounded large-tree overviews, focused folder renders, in-memory source comparison, and rename or removal impact analysis.
- Added source-linked diagnostic classification for structural, placement, reference, unlock, bonus, doctrine, AI, localisation, icon, and unresolved static-analysis findings.
- Added a deterministic 1,040-technology acceptance workspace with 13 folders, expected graph and reference manifests, stable SVG and PNG evidence, cancellation, incremental indexing, resource retrieval, and stdio, secured Streamable HTTP, package, and agent-workflow coverage.
- Pinned patched transitive HTTP, URI, and shell parsing dependencies; the release dependency audit reports no known vulnerabilities.
- Reconfirmed MCP protocol `2025-11-25`, TypeScript SDK 1.29.0, Registry schema `2025-12-11`, and Registry publisher 1.7.9 for this release.

## 2.1.1 - 2026-07-18

- Updated container attestation verification for current in-toto `Statement/v1` documents emitted by BuildKit.

## 2.1.0 - 2026-07-18

- Added `hoi4.focus_raster` for decoded focus icons and deterministic PNG reviews while keeping inspection, vector rendering, and rewrites responsive on very large trees.
- Added public MCP regressions that create, compact, inspect, render, and rasterize 1,024-focus trees, including a separate 1,024-distinct-icon raster workload.
- Replaced the quadratic large-source diff ceiling with a deterministic linear-memory patience diff so large rewrites still return exact review artifacts.
- Raised distinct raster-operation capacity for large icon sets and deduplicated GUI sprite-frame raster work by texture and frame.
- Separated full localisation inventories from connected map topology limits and raised the shared index capacity for installed-game scale.
- Added automatic generated-artifact retention so long-running agent workflows reclaim older artifacts instead of stopping at the storage ceiling.
- Made broad GUI inspection index only connected localisation, reuse decoded textures, and return bounded workspace projections for very large source graphs.
- Made broad event scans structural by default, with helper expansion in focused queries and compact indexed resources for very large graphs.
- Suppressed unrelated vanilla parser noise while retaining mod and dependency diagnostics that affect the requested content.
- Added regressions for 500,100 localisation records, 1,024 distinct focus textures, large GUI and event graphs, raster discovery, package installation, and agent workflows.

## 2.0.0 - 2026-07-15

- Removed the workspace inventory tool and made the current mod implicit for local MCP calls.
- Starting the server inside any mod now works without a config file or per-mod setup command.
- Updated the published client examples, Registry metadata, and installation verification for the twelve-tool surface.
- Distinguished unresolved numeric values (`[X]`) from unresolved text-returning dynamic localisation (`[dynamic_loc]`) and applied supported HOI4 `§` text colours in offline GUI previews.

## 1.2.0 - 2026-07-13

- Added a read-only Event Chain Viewer for scanning, tracing, explaining, linting, rendering, and comparing large HOI4 event chains.
- Kept the event surface to three tools with seven inspect modes and linked authoritative graph artifacts, keeping the public surface to twelve tools within the fixed discovery budget. Local calls now resolve the mod containing the MCP working directory.
- Added event workflow documentation, package and Registry metadata, and project-owned acceptance coverage for more than 300 event definitions.
- Reconfirmed MCP protocol `2025-11-25`, TypeScript SDK 1.29.0, Registry schema `2025-12-11`, and Registry publisher 1.7.9 for this release.

## 1.1.1 - 2026-07-13

- Replaced the repository About text with a direct description of the focus-tree, GUI, and map tools.
- Simplified the README introduction and HTTP summary so operational safeguards remain in their dedicated documentation.

## 1.1.0 - 2026-07-12

- Added plan-free `compact` rewrites for existing national focus trees while retaining authored mode for complete plans and new trees.
- Added deterministic candidate reflow, vertical-gap compression, gateway refinement, spacing, rendered-curve crossing, connector-node, branch-balance, centering, and canvas metrics, with absolute and relative compact-layout gates.
- Preserved automatic placement intent in focus planning sidecars so later imports can continue deterministic layout work.
- Reduced MCP tool-discovery payload size by about 83% while keeping full runtime validation, and bounded inline results so large plans and artifacts stay in MCP resources.
- Verified coexistence with repository `AGENTS.md` instructions, skills, plans, and subagent workflows; the server exposes domain tools without taking over task orchestration.
- Refreshed the authentication and lint dependencies while retaining the current MCP SDK, Inspector, protocol, and Registry publisher versions.

## 1.0.0 - 2026-07-12

- Reduced the MCP surface to ten tools for discovering mods and creating, inspecting, rendering, and rewriting focus trees, scripted GUIs, and maps.
- Added automatic writable discovery for every mod directly inside configured mod folders.
- Replaced multi-step write workflows with one-call rewrites. Validation, atomic writes, stale-file checks, and failure recovery run inside the server.
- Added large-tree workflow coverage, multi-file GUI creation, exact province-geometry export, and resumable artifact chunks.
- Simplified setup to `hoi4-agent-tools-setup --init`, with automatic Windows, macOS, and Linux path detection and optional explicit path flags.
- Consolidated the user documentation around setup and the three HOI4 work areas.
- Removed runtime workspace registration, manual rollback, legacy write-policy inputs, and package-level library/schema exports.
- Renamed the HTTP discovery grant to `allowDiscoveredMods`; it grants discovered mod IDs only.

Earlier release history is preserved in the [commit history](https://github.com/klimPaskov/hoi4-agent-tools/commits/main).

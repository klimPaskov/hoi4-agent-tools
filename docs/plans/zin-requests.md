# ZIN request record

Shared record between the ZIN lead session and the HOI4 Agent Tools worker. The lead adds requests and verification results; the worker keeps status, implementation references and evidence current. Format: `docs/zin-handoff/03-MCP-WORKER-SPEC.md` section 3 in the ZIN mod.

## Launch

- Worker launched 24 October 2026 by the ZIN lead session through the desktop app's `start_session` tool.
- Method: separate session in the tool repository.
- Model id: `claude-opus-5-5` (Opus 5.5; confirmed by the worker's own environment).
- Working directory: `C:/Users/klimp/Documents/Projects/hoi4-agent-tools` (main checkout, no app worktree).
- The worker develops only in its own worktrees under `.claude/worktrees/`. This record lives on the integration branch `claude/zin-integration` (worktree `.claude/worktrees/zin-integration`) until it is merged to `main`.

## Main checkout

The mod's `tools/content/apply.mts` imports the atomic rewrite engine from the main checkout, so the main checkout runs whatever is checked out there. The worker announces every switch here before making it.

| Date       | Branch                           | Head      | Note                                                                  |
| ---------- | -------------------------------- | --------- | --------------------------------------------------------------------- |
| 2026-10-24 | `claude/zin-map-pipeline-phase1` | `9ed6351` | state at launch, clean, package 4.3.0; unchanged by the worker so far |

## Installed runtime

| Date       | Prefix                                                        | Version | Registrations                                                                                                               |
| ---------- | ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | `C:/Users/klimp/AppData/Local/hoi4-agent-tools/runtime-v430/` | 4.3.0   | `~/.claude.json` `mcpServers.hoi4_agent_tools` points at it (checked 2026-10-24); `~/.codex/config.toml` not yet re-checked |

## Announcements

Schema changes, compatibility changes, releases, runtime installs and server restarts, newest first.

- 2026-10-24: no server restart, runtime install or main-checkout switch yet. Planned, each announced again here before it happens: after PR 36 merges, the main checkout moves from `claude/zin-map-pipeline-phase1` to `main` (same engine code plus the PR 36 fixes); the ZR-1 fix ships in the next release (4.4.0) and then needs a runtime install and a reconnect.
- 2026-10-24: proposed schema changes for ZR-2 (ADR 0067): optional `create_world` fields `reference.sheets`/`sheetsPath`, `reference.paletteMatch`, `reference.fit`, `reference.agreement`, `ids`, `overridesPath`; two new published schemas `reference-sheets` and `world-overrides`. ZR-1 adds the configuration key `defaultWorkspace`. All additive, minor version. ZR-2 is not implemented until the lead has read ADR 0067.
- 2026-10-24: the lead renamed Erdae to Aoaz in the mod (`81bc85a` on the mod's local branch `zin/integration-r3`; table in `docs/lore/names_traceability.md`). Private originals keep their names (`docs/reference/originals/Erdae.png`, `Erdae-working.jpg`). New tool docs, fixtures and ZIN-facing text say Aoaz; two tool test strings keep the old name for now (operation id `erdae` in `tests/integration/mcp-stdio-smoke.test.ts`, path case `geography/erdae.json` in `tests/unit/map-geography-schema.test.ts`); neither feeds a recorded hash, and they will be renamed with the next change to those tests. The worker now reads `tools/content/data/geography/aoaz.json` and `docs/reference/cleaned/Aoaz-clean-v3.png`.

## Index

| Id   | Title                                                                                           | Priority                     | Status                                                                |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| ZR-1 | Validators fail with `WORKSPACE_CONTEXT_NOT_FOUND` outside the mod folder                       | P1                           | in review (fix on `claude/zr1-workspace-discovery`; workaround below) |
| ZR-2 | Import of the owner's drawn map                                                                 | P0 design, P1 implementation | in progress (design approved; step 1)                                 |
| ZR-3 | PR 36 review findings (geography partition fields, heights after coast smoothing, cancellation) | P1                           | in progress (worker, proactive)                                       |
| ZR-4 | Reliability campaign: at least 100 web maps through the import                                  | P1                           | in progress (pass 1 running: 144 maps)                                |

## ZR-1: Validators fail with `WORKSPACE_CONTEXT_NOT_FOUND` outside the mod folder

- Opened: 2026-10-24 by lead (backlog item 7 of the worker prompt)
- Priority: P1
- ZIN task: every task that validates script or inspects the map from an agent or subagent session (R-10 and all content work).
- Tool or workflow: `hoi4_script_validate`, `hoi4_map_inspect` and every tool whose `workspaceId` defaults to `current`.
- Inputs and reproduction: runtime 4.3.0 (`runtime-v430`), config `modRoots` = the HOI4 `mod` folder (seven mods, ZIN is `mod_zin_86bac5c64231`). From this worker session (client roots: the tool repository and the shared notes folder, neither inside a mod), 2026-10-24:
  - `hoi4_script_validate {"source":"add_political_power = 10","kind":"effect","scope":"country"}` -> `WORKSPACE_CONTEXT_NOT_FOUND` "The active MCP client roots do not identify a registered HOI4 mod workspace".
  - `hoi4_script_validate {"path":"common/national_focus/zin_noris.txt"}` -> the same error.
  - `hoi4_map_inspect {"lookupOnly":true,"query":"Fandanar","workspaceId":"mod_zin_86bac5c64231"}` -> `MAP_LOOKUP_COMPLETED` (7,109 definitions, 1,332 states, 275 regions, 186 ports). An explicit id works.
- Current behaviour: with the default `workspaceId: "current"` the server asks the client for its MCP roots and accepts only a root inside (or containing) a mod workspace (`WorkspaceResolver.resolveClientWorkspaceId`, `src/hoi4_agent_tools/core/workspace.ts`). A session whose working directory is the mod or any subfolder of it works (this is why the lead's session succeeds; the existing unit test covers a subfolder root). A session started elsewhere fails: the tool repository, a worktree, a scratchpad, or a subagent of such a session (subagents share the parent's MCP connection and roots). The error names neither the candidate workspace ids nor the fix. The fallback that finds the one mod containing a requested `path` (`resolveUniqueModSourceWorkspaceId`) is never reached, because the roots check throws first.
- Required capability or improvement: (1) when the roots do not identify a mod, fall back to the unique mod that contains the requested source path; (2) an optional configured default workspace for sessions outside any mod, respecting principal grants; (3) an actionable error listing the candidate workspace ids and both fixes (pass `workspaceId`, or set the default).
- Evidence: the calls above; code path `create.ts` `resolveCurrentWorkspaceId` -> `resolveClientWorkspaceId`; `operation-context.ts` `resolveOperationWorkspaceForSource`.
- Impact: every agent session not started in the mod folder needs the opaque id `mod_zin_86bac5c64231`, which it cannot discover from the error.
- Acceptance: unit and MCP tests for the three cases plus negatives (path in two mods stays ambiguous, default outside the principal's grants is refused, unknown default id is a configuration error); from this worker session, `hoi4_script_validate {"path":"common/national_focus/zin_noris.txt"}` without `workspaceId` resolves ZIN after the release.
- Status: in review (reproduced; fixed on a branch; the subfolder case already worked and is covered by a test)
- Implementation: branch `claude/zr1-workspace-discovery`, ADR 0066. When the client roots and the working directory identify no mod, `current` now resolves to (1) the new optional configuration key `defaultWorkspace` (an ID or short form such as `"zin"`; refused at startup when unknown, ambiguous or `current`; never used for a principal without a grant), (2) the only mod, (3) for the `path` of `hoi4_script_validate` and the `relativePath` of the focus tools, the one mod that has that file. Otherwise `WORKSPACE_CONTEXT_NOT_FOUND` and `WORKSPACE_CONTEXT_REQUIRED` list up to 32 workspace ids and names and say: pass `workspaceId`, start in the mod folder, or set `defaultWorkspace`.
- How to use (after the release): nothing for a validated `path` that only ZIN has; otherwise `"defaultWorkspace": "zin"` in `C:/Users/klimp/AppData/Roaming/hoi4-agent-tools/config.json` (the worker proposes that edit with the release install), or `{"workspaceId":"zin"}` per call.
- Verification: unit tests `tests/unit/workspace-context.test.ts` (10, with negatives: unknown, ambiguous and reserved default; principal without grant; a path in two mods stays `WORKSPACE_SOURCE_AMBIGUOUS`; a traversal path is not recovered) and MCP tests in `tests/integration/mcp-client-roots.test.ts` (client root outside every mod: focus inspect and script validate by path, the candidate list, the default).
- Workaround now (runtime 4.3.0, verified 2026-10-24 from this session): pass `"workspaceId":"zin"`; the short form already resolves to `mod_zin_86bac5c64231` (`hoi4_script_validate {"source":"add_political_power = 10","kind":"effect","scope":"country","workspaceId":"zin"}` returned `SCRIPT_CHECKED`).
- Remaining integration work: release 4.4.0, runtime install, reconnect; then the lead confirms from a subagent without `workspaceId`.

## ZR-2: Import of the owner's drawn map

- Opened: 2026-10-24 by lead
- Priority: P0 design, P1 implementation
- ZIN task: R-10 (acceptance A-10), base for R-11 to R-18.
- Tool or workflow: `hoi4_map_rewrite` `create_world` with the geography model and a reference.
- Inputs and reproduction: the full drawing `C:/Users/klimp/Documents/ZIN/World/Erdae/Maps/Colored/Erdae Full Colored Map.png` (17,520 x 12,720 RGBA, private, never committed or embedded) plus the per-sheet transforms in the mod's `tools/content/data/geography/aoaz.json` (formerly `erdae.json`) (`sheets`: twelve sheets, each `drawingBox`, `drawingAnchor`, `worldAnchor`, `scaleWorldPerDrawing`, `mirrorX`; accuracy about 80 px); the alternative source is the cleaned layout `docs/reference/cleaned/Aoaz-clean-v3.png` (5,120 x 2,560, 11 flat colours). Owner question Q-04 decides which.
- Current behaviour (code read at `9ed6351`): one reference picture fitted by aspect-preserving padding, no registration or mosaic; every source reduced to at most 3,072 px per side (the cleaned layout loses 40% of its width); `palette` snaps to the nearest colour and never reports an unknown colour; province ids by reading order and colours, states and regions from one random stream, so any change renumbers the world; no authored-override file; edited generated files block regeneration (`MANAGED_OUTPUT_EDITED`). The mod's `aoaz.json` is its own GeoJSON-like format, not geography schema version 1. The drawing (17,520 x 12,720, 447 MB) has twelve recorded sheet registrations whose drawing boxes overlap by up to 2%.
- Required capability or improvement: an import from the full drawing plus transforms (and from the cleaned layout) to the 5,120 x 2,560 game layout with aligned layers, ids stable across re-imports, an authored-override source file that survives regeneration, accurate diagnostics on broken input, other map workflows unaffected.
- Evidence: design `docs/adr/0067-drawn-map-import.md` on `claude/zin-integration`. Summary: extend `create_world` (one call, preview or write). (1) Registered sheets (`reference.sheets` or `sheetsPath`: per sheet `box`, optional `clip`, `anchor`, `target`, `scale` with a negative x for the mirror, `order`, its own `palette`), decoded once at the working scale the sheets need (about 5,840 x 4,240 for ZIN, under a 64-megapixel ceiling) and warped into one frame-aligned class raster from which every layer derives. (2) `paletteMatch: "exact"` for the cleaned layout (unknown colours are errors with coordinates) and `fit: "frame"`. (3) Precedence: overrides, then the geography model, then the drawing, with a measured model-drawing agreement that blocks above a threshold. (4) `ids: {"mode":"stable"}` with a managed ledger `map/.hoi4-agent-ids.json`: mutual-majority overlap matching keeps ids and colours; new ids fill holes; contiguous renumbering only when the world shrinks, with `map-id-remap.json` and reference remapping. (5) `overridesPath`: an author-owned JSON file the tool never writes, entries keyed by world points (surface polygons, province pins and merges, state data, region data, names with `formerLabel`, adjacencies, territory seeds), each failure naming its entry. (6) Artifacts `map-import-registration.png`, `map-import-alignment.png`, `map-import-classes.png`, `map-import-report.json`; post-write checks: frame sizes, land above and water below sea level, coast IoU at least 0.99.
- Impact: R-10 and every later map requirement.
- Acceptance: A-10.
- Status: in progress (design approved by the lead 2026-10-24; implementing in the order of ADR 0067 section 8)
- Lead decisions (2026-10-24): (1) ZIN's source is the full drawing with the recorded per-sheet transforms, read from the mod's git-ignored copy `docs/reference/originals/Erdae.png` (byte-identical to the private original); the cleaned-layout path stays supported but is not ZIN's. (2) The lead owns section 7: the converter from `aoaz.json` to geography schema version 1 and the sheet document, the override file, and the model repair; the worker names the exact schema files and versions once step 2 lands. (3) Conservative default agreement thresholds; the preview artifact reports the measured land-sea IoU for ZIN. (4) Releases: first one as soon as PR 36 and steps 1 and 2 are merged (4.4.0), second with steps 3 to 5; each announced here before install. (5) ZR-4 runs alongside; its fixes go into the same importer. (6) Names are never read from the drawing; renamed labels (borrowed names, every "-waith" name) go through the override file's `names` with `formerLabel`.
- Implementation: pending. Order: 1 exact palette, `fit: "frame"` and the working-size rule; 2 registered sheets and agreement; 3 overrides; 4 stable ids; 5 alignment checks and the A-10 end-to-end test on a synthetic three-sheet drawing.
- Verification: pending
- Target frame: 5,120 x 2,560 (lead, 2026-10-24: the largest province map the engine accepts at this height; the 6,144 x 2,560 comment in the old politics script is stale).
- Layer split (ADR 0067 section 2, added 2026-10-24 at the lead's request): from the drawing's pixels only the land and sea mask (coastline) and the base terrain classes; from the model's vectors lakes (always carve), terrain areas (override the drawn class), relief (ranges, volcanoes, plateaus, passes), rivers, straits, sites, regions and their densities, walls, names, roads and places. The model's `lands` and `seas` polygons do not draw the coast when a picture is given; they are checked against it, name land masses and seas and give containment. Pencil rivers and handwriting are not read. The seam: `edge.mode: "sea-band"` is required for ZIN (R-18); land in the edge bands is an error, so the model's edge cliffs must become open sea.
- Questions for the lead: answered 2026-10-24 (see the lead decisions above).
- Q-04 answered (owner via the lead, 2026-10-24): the ZIN map targets the owner's full drawing plus the recorded per-sheet transforms at 5,120 x 2,560; the design keeps the cleaned layout as a second input. The owner also ordered the reliability campaign ZR-4.
- Remaining integration work: the lead's conversion of the model and sheets.

## ZR-3: PR 36 review findings

- Opened: 2026-10-24 by worker (proactive)
- Priority: P1 (the map import builds on this branch)
- ZIN task: R-10 to R-12 (the geography model's regions, densities and walls must shape provinces, states and regions).
- Tool or workflow: `hoi4_map_rewrite` `create_world` with `geography` and the feature-aware partition (PR 36, `claude/zin-map-pipeline-phase1`).
- Inputs and reproduction: review of PR 36 at `9ed6351` with probe tests in a throwaway worktree.
- Current behaviour: (1) the model's regions, region densities and wall ranges never reach the partition (`partitionFieldsFromGeography` has no production caller; the synthesis barrier fields are not passed), so a write succeeds while ignoring them; (2) after coast smoothing (`MAP_PARTITION_MASK_SMOOTHED`), pixels turned from sea to land keep the water height 93 in `heightmap.bmp` (30 pixels on a 1,024 x 512 probe); (3) cancellation does not reach synthesis or partition; (4) stale text in ADR 0058 and the tool description. Legacy outputs are byte-identical to `main` (311 and 249 files compared); types and schemas are clean; 227 relevant tests pass.
- Required capability or improvement: fix 1 to 4 with tests, then merge PR 36.
- Evidence: the review notes above and a probe reproduction of finding 2.
- Impact: without the fix a ZIN world from the model would ignore the Great Wall range as a border and the region densities.
- Acceptance: a world-level test that regions and walls shape the partition; a heights test after smoothing; a cancellation test; `npm run check`; CI green on PR 36.
- Status: in progress
- Implementation: branch `claude/pr36-fixes` (from PR 36), pushed to the PR branch after `npm run check`.
- Verification: pending
- Remaining integration work: none for the lead until the release.

## ZR-4: Reliability campaign: at least 100 web maps through the import

- Opened: 2026-10-24 by lead, on the owner's instruction (the lead asked for id ZR-3, which was already taken by the PR 36 findings). Owner's words, relayed verbatim: "Try many different maps from the web. Like at least 100 different maps and each time you fix any defects and improve the tool more and more until its like extremely reliable."
- Priority: P1
- ZIN task: R-10, A-10 (the import must be reliable on any drawn or printed map, not only on Aoaz).
- Tool or workflow: `hoi4_map_rewrite` `create_world` with `reference` (today's single-picture path), then the registered-sheet and exact-palette paths of ZR-2 as they land; `hoi4_map_inspect` and the validators on every result.
- Inputs and reproduction: at least 100 varied map images from the web: hand-drawn fantasy maps, scanned atlases, coloured political maps, relief and satellite-style maps, small and very large, odd aspect ratios, labels and ink noise, islands and archipelagos, lakes and rivers, maps that touch the frame edge. Each runs end to end in a dedicated test mod workspace (never the ZIN mod), preview and write, then inspect and validate.
- Storage and licences: downloads stay out of git under the ignored folder `campaign/maps/` of the tool repository, one folder per image; the committed manifest `docs/plans/map-campaign/manifest.json` lists per image the source URL, licence, author, dimensions, bytes and SHA-256. Only images whose licence allows redistribution (public domain, CC0, CC BY with attribution) may become committed fixtures; recurring defects become tests with small synthetic or licence-clear fixtures.
- Per map recorded: URL, licence, dimensions, category, outcome (passes, defect found, refused correctly), defects, fix (importer and validators only, never output patching), the commit that fixed it, time and memory.
- Current behaviour: not started. Downloading files needs the user's explicit approval in the worker session; requested 2026-10-24.
- Required capability or improvement: every map either imports to a world that passes inspection and validation, or is refused with an accurate diagnostic; no crash, hang, silent wrong output or unbounded memory.
- Evidence: the running table below.
- Impact: confidence that the Aoaz import and every later re-import behave.
- Acceptance: at least 100 maps run; the last full pass has no unexplained failure; every defect class has a regression test.
- Status: open
- Implementation: harness and manifest on the worker's campaign branch (pending)
- Verification: pending
- Remaining integration work: none for the lead.

### Reliability table

| #   | Map | Licence | Size | Category | Outcome | Defect | Fix |
| --- | --- | ------- | ---- | -------- | ------- | ------ | --- |

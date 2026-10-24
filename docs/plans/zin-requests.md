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

| Date       | Branch                           | Head      | Note                                                     |
| ---------- | -------------------------------- | --------- | -------------------------------------------------------- |
| 2026-10-24 | `claude/zin-map-pipeline-phase1` | `9ed6351` | state at launch, clean, package 4.3.0                    |
| 2026-10-24 | `main`                           | `3733d4a` | after PRs 36 to 39; `npm ci` run; engine import verified |

## Installed runtime

| Date       | Prefix                                                        | Version | Registrations                                                                                                               |
| ---------- | ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | `C:/Users/klimp/AppData/Local/hoi4-agent-tools/runtime-v430/` | 4.3.0   | `~/.claude.json` `mcpServers.hoi4_agent_tools` points at it (checked 2026-10-24); `~/.codex/config.toml` not yet re-checked |

## Announcements

Schema changes, compatibility changes, releases, runtime installs and server restarts, newest first.

- 2026-10-24: PR 40 (ZR-2 steps 1 and 2) merged, `main` at `7e154a1`; the main checkout stays on its verified `3733d4a` until the release. PR 41 (campaign fixes) is in its final CI run; then the 4.4.0 version bump.
- 2026-10-24: **main-checkout switch done.** PR 39 (ZR-5) merged; the main checkout is on `main` at `3733d4a`, clean, with `npm ci` run (zod 4.6.7). Verified by importing the engine from the checkout as `apply.mts` does: `TRANSACTION_MAX_FILES` 15,000, manifest ceiling 32 MiB, batch size 79 for 5,051 files. `apply.mts` can now apply the whole content tree in one transaction (remove its 4,500-file batching). The installed runtime is unchanged (4.3.0) until the 4.4.0 install, announced separately.
- 2026-10-24: merged to `main`: PR 38 (dependency security update), PR 37 (ZR-1), PR 36 (map pipeline phase 1 with the ZR-3 fixes), `main` at `dc980bd`. Open with CI running: PR 39 (ZR-5), PR 40 (ZR-2 steps 1 and 2), PR 41 (campaign fixes). **Main checkout switch announced:** once PR 39 (ZR-5) merges, the main checkout moves from `claude/zin-map-pipeline-phase1` (`9ed6351`) to `main`, followed by `npm ci` there (zod is now 4.6.7). The mod's `apply.mts` then imports the engine with the 15,000-file ceiling. Do not run `apply.mts` while the switch is in progress; the worker posts here when it is done.
- 2026-10-24: no server restart, runtime install or main-checkout switch yet. Planned, each announced again here before it happens: after PR 36 merges, the main checkout moves from `claude/zin-map-pipeline-phase1` to `main` (same engine code plus the PR 36 fixes); the ZR-1 fix ships in the next release (4.4.0) and then needs a runtime install and a reconnect.
- 2026-10-24: proposed schema changes for ZR-2 (ADR 0067): optional `create_world` fields `reference.sheets`/`sheetsPath`, `reference.paletteMatch`, `reference.fit`, `reference.agreement`, `ids`, `overridesPath`; two new published schemas `reference-sheets` and `world-overrides`. ZR-1 adds the configuration key `defaultWorkspace`. All additive, minor version. ZR-2 is not implemented until the lead has read ADR 0067.
- 2026-10-24: the lead renamed Erdae to Aoaz in the mod (`81bc85a` on the mod's local branch `zin/integration-r3`; table in `docs/lore/names_traceability.md`). Private originals keep their names (`docs/reference/originals/Erdae.png`, `Erdae-working.jpg`). New tool docs, fixtures and ZIN-facing text say Aoaz; two tool test strings keep the old name for now (operation id `erdae` in `tests/integration/mcp-stdio-smoke.test.ts`, path case `geography/erdae.json` in `tests/unit/map-geography-schema.test.ts`); neither feeds a recorded hash, and they will be renamed with the next change to those tests. The worker now reads `tools/content/data/geography/aoaz.json` and `docs/reference/cleaned/Aoaz-clean-v3.png`.

## Merge and release plan (2026-10-24)

Order, each with `npm run check` locally and CI green: (1) dependency security update (`claude/deps-advisories-2026-10-24`; new advisories made `npm audit` fail every PR's CI), (2) PR 36 with its review fixes (`claude/pr36-fixes`), (3) PR 37 (ZR-1), (4) ZR-2 steps 1 and 2 (`claude/zr2-import`), (5) campaign fixes D2 to D4 (`claude/campaign-fixes-1`), then release 4.4.0, installed into a fresh runtime prefix with both registrations backed up and updated; announced here before the install. Local checks on this machine time out in four load-sensitive HTTP and concurrency tests while the campaign runs; they are rerun on an idle machine and CI is the reference for them.

## Index

| Id   | Title                                                                                           | Priority                     | Status                                                                 |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| ZR-1 | Validators fail with `WORKSPACE_CONTEXT_NOT_FOUND` outside the mod folder                       | P1                           | merged (PR 37); release 4.4.0 pending                                  |
| ZR-2 | Import of the owner's drawn map                                                                 | P0 design, P1 implementation | steps 1 and 2 merged (PR 40); release 4.4.0 pending; steps 3 to 5 next |
| ZR-3 | PR 36 review findings (geography partition fields, heights after coast smoothing, cancellation) | P1                           | merged (PR 36)                                                         |
| ZR-4 | Reliability campaign: at least 100 web maps through the import                                  | P1                           | in progress (15 of 144 run; 5 defect classes diagnosed)                |
| ZR-5 | Whole-mod content apply exceeds the 5,000-file transaction limit                                | P1                           | merged (PR 39); usable now from the main checkout                      |

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
- Status: merged (PR 37, `602a6b8`, 2026-10-24; CI green on Linux and Windows); released with 4.4.0 (pending)
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
- Status: steps 1 and 2 merged (PR 40, `7e154a1`, 2026-10-24, CI green on Linux and Windows); released with 4.4.0 (pending); steps 3 to 5 (overrides, stable ids, alignment checks) next
- Lead decisions (2026-10-24): (1) ZIN's source is the full drawing with the recorded per-sheet transforms, read from the mod's git-ignored copy `docs/reference/originals/Erdae.png` (byte-identical to the private original); the cleaned-layout path stays supported but is not ZIN's. (2) The lead owns section 7: the converter from `aoaz.json` to geography schema version 1 and the sheet document, the override file, and the model repair; the worker names the exact schema files and versions once step 2 lands. (3) Conservative default agreement thresholds; the preview artifact reports the measured land-sea IoU for ZIN. (4) Releases: first one as soon as PR 36 and steps 1 and 2 are merged (4.4.0), second with steps 3 to 5; each announced here before install. (5) ZR-4 runs alongside; its fixes go into the same importer. (6) Names are never read from the drawing; renamed labels (borrowed names, every "-waith" name) go through the override file's `names` with `formerLabel`.
- Implementation: branch `claude/zr2-import` (based on PR 36): step 1 `82067a4` (`reference.paletteMatch`, `reference.fit: "frame"`, frame-resolution working copy), step 2 `3617a94` (`reference.sheets` / `sheetsPath`, import report and agreement, model preview registers the picture), fix `7f71c80` (working-copy byte limit, found on the real drawing). ADR 0067 section 9 records where the implementation differs from the design (error-code prefix `MAP_REFERENCE_`, one palette for all sheets, controls in world coordinates with sheets). Still to come: 3 overrides; 4 stable ids; 5 alignment checks and the A-10 end-to-end test.
- Schemas to target now (lead's question 2): geography model `schemas/geography-model.schema.json` version 1 (keep `biomes`, `climate`, land `biome`/`fertility`, region terrain shares and sea ice out until C8 lands: a model with them is blocked with `MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE`); sheet document `schemas/reference-sheets.schema.json` version 1 (on the branch; published with 4.4.0). The override file schema (`world-overrides`, version 1) comes with step 3.
- How to call it (after 4.4.0): `hoi4_map_rewrite {"workspaceId":"zin","preview":true,"operations":[{"id":"world","kind":"create_world","width":5120,"height":2560,"edge":{"mode":"sea-band"},"reference":{"imagePath":"docs/reference/originals/Erdae.png","sheetsPath":"<your sheets file>.json","palette":[...],"agreement":{"minLandIou":0.85}},"geographyPath":"<your model>.json"}]}`. The preview registers the drawing, compares it with the model without planning a map, and returns `data.import` (land IoU, uncovered pixels, hidden sheets, misplaced features) and `map-import-report.json`, `map-import-alignment.png`, `map-import-classes.png`, `map-import-registration.png`.
- Real-drawing probe (2026-10-24, a copy of `Erdae.png` in a scratch workspace with the twelve `aoaz.json` sheets converted one to one, no clips, no palette): 55 s, peak 778 MiB, working copy 5,786 x 4,250. Data findings for the lead: give every sheet an explicit `order` (with file-position orders `mag` is entirely hidden) and a `clip` (the mirrored `east` box carries neighbouring sheets' lettering), and pass a palette with each sheet's sea blue. Details and images (private, local only): the shared notes folder, `zin-registration-probe/`.
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
- Status: merged (PR 36, `dc980bd`, 2026-10-24; CI green on Linux and Windows)
- Implementation: commits `3c0354b` (geography regions, densities and walls reach the partition; smoothing before synthesis for geography worlds; the request signal reaches synthesis and partition; world-level tests in `tests/unit/map-world-geography-partition.test.ts`) and `c0e6c61` (ADR 0058, tool description and changelog corrected).
- Verification: pending
- Remaining integration work: none for the lead until the release.

## ZR-5: Whole-mod content apply exceeds the 5,000-file transaction limit

- Opened: 2026-10-24 by lead
- Priority: P1
- ZIN task: applying the integrated content build to the mod (R-0c, every game file through the shared atomic rewrite engine).
- Tool or workflow: `TransactionManager.plan` in `src/hoi4_agent_tools/core/transactions.ts` (line 458), called by the mod's `tools/content/apply.mts` line 94 with one operation covering the whole staged tree.
- Inputs and reproduction: mod `zin` at `3f755f1` (master), `cd tools && node --import tsx content/apply.mts apply` with the tool's main checkout on `claude/zin-map-pipeline-phase1`; the plan writes 4,693 files and deletes 358.
- Current behaviour: `ServiceError TRANSACTION_STRUCTURE_LIMIT`, details `files: 5051, filesLimit: 5000` (operations 1 of 1000).
- Required capability or improvement: one atomic transaction carries a whole-mod content apply of this size and larger (the content tree will pass 8,000 files), by raising the file limit with a measured memory and time cost or by a supported chunked or streamed transaction that still commits or rolls back atomically; the error names the remedy.
- Evidence: the error object above.
- Impact: the integrated build cannot be applied in one transaction; the lead's stopgap splits the apply into atomic transactions of at most 4,500 files, losing all-or-nothing behaviour across the whole apply.
- Acceptance: `apply.mts apply` with 5,051 and with 12,000 files commits atomically in one transaction (or a documented atomic chunked mode), rolls back fully on an injected failure, with a test at the limit and above it, and timings recorded.
- Status: merged (PR 39, `3733d4a`, CI green on Linux and Windows); available to `apply.mts` from the main checkout now; in the 4.4.0 release
- Implementation: commit `273960f`. The file ceiling rises from 5,000 to 15,000 and the authenticated manifest ceiling from 16 to 32 MiB (a manifest entry measured about 940 bytes). Root cause of the slow large applies: every 16-file replacement batch rewrote and fsynced the whole manifest twice (intent and checkpoint), and the manifest grows with the file count, so a large apply was quadratic (632 manifest writes of up to 4.7 MB for 5,051 files). Batches now grow with the file count to about 64 batches (16 files up to 1,024, at most 256); ordinary rewrites are unchanged; recovery already handles pending intents of any length. `TRANSACTION_STRUCTURE_LIMIT` names each exceeded limit and the remedy. ADR 0047 amendment.
- Verification: `tests/unit/transaction-size.test.ts` (batch sizes; the error names the exceeded limit, such as `15,001 files (limit 15,000)`, and the remedy; one 5,051-file transaction applied, then a second one failing post-validation rolls every file back) plus the existing transaction, batch and recovery suites: 80 tests pass. Benchmark (synthetic tree of small text files, 3 rounds: first write, rewrite, injected post-write failure; measured on the worker's Windows machine while other jobs shared the disk, so timings are indicative):

| Files  | Code                     | Plan s (3 rounds) | Apply s (3 rounds)                                             | Manifest       | Peak RSS |
| ------ | ------------------------ | ----------------- | -------------------------------------------------------------- | -------------- | -------- |
| 5,051  | before (16-file batches) | 31 / 138 / 116    | 321 / 465 / 267 (rolled back)                                  | 3.4 to 4.7 MB  | 526 MiB  |
| 5,051  | after                    | 15 / 41 / 79      | 38 / 150 / 402 (rolled back; a stray test run shared the disk) | 3.4 to 4.7 MB  | 494 MiB  |
| 12,000 | after                    | 67 / 86 / 127     | 198 / 142 / 230 (rolled back)                                  | 8.2 to 11.3 MB | 920 MiB  |

Every sampled file held the expected bytes after each apply and after each rollback.

- How to use (after 4.4.0 and the main-checkout switch): remove the 4,500-file batching in `tools/content/apply.mts` and plan the whole change in one `manager.plan`; keep the 4 GiB journal option for the art.
- Remaining integration work: the lead removes the batching and records the real apply timing.

## ZR-4: Reliability campaign: at least 100 web maps through the import

- Opened: 2026-10-24 by lead, on the owner's instruction (the lead asked for id ZR-3, which was already taken by the PR 36 findings). Owner's words, relayed verbatim: "Try many different maps from the web. Like at least 100 different maps and each time you fix any defects and improve the tool more and more until its like extremely reliable."
- Priority: P1
- ZIN task: R-10, A-10 (the import must be reliable on any drawn or printed map, not only on Aoaz).
- Tool or workflow: `hoi4_map_rewrite` `create_world` with `reference` (today's single-picture path), then the registered-sheet and exact-palette paths of ZR-2 as they land; `hoi4_map_inspect` and the validators on every result.
- Inputs and reproduction: at least 100 varied map images from the web: hand-drawn fantasy maps, scanned atlases, coloured political maps, relief and satellite-style maps, small and very large, odd aspect ratios, labels and ink noise, islands and archipelagos, lakes and rivers, maps that touch the frame edge. Each runs end to end in a dedicated test mod workspace (never the ZIN mod), preview and write, then inspect and validate.
- Storage and licences: downloads stay out of git under the ignored folder `campaign/maps/` of the tool repository, one folder per image; the committed manifest `docs/plans/map-campaign/manifest.json` lists per image the source URL, licence, author, dimensions, bytes and SHA-256. Only images whose licence allows redistribution (public domain, CC0, CC BY with attribution) may become committed fixtures; recurring defects become tests with small synthetic or licence-clear fixtures.
- Per map recorded: URL, licence, dimensions, category, outcome (passes, defect found, refused correctly), defects, fix (importer and validators only, never output patching), the commit that fixed it, time and memory.
- Current behaviour: downloads approved by the user in the worker session on 2026-10-24. 144 maps from Wikimedia Commons (514 MB, all free licences: 55 public domain, 53 CC BY-SA, 10 no restrictions, 9 CC0, 17 other free licences; 27 thousand to 176 million pixels; aspect 0.4 to 3.3) in `.tmp/map-campaign/maps/` of the main checkout (git-ignored); manifest `docs/plans/map-campaign/manifest.json` on `claude/map-campaign`. Pass 1 paused at 15 of 144 (2026-10-24) so that local checks run on a quiet machine; it resumes where it stopped.
- Required capability or improvement: every map either imports to a world that passes inspection and validation, or is refused with an accurate diagnostic; no crash, hang, silent wrong output or unbounded memory.
- Evidence: the running table below.
- Impact: confidence that the Aoaz import and every later re-import behave.
- Acceptance: at least 100 maps run; the last full pass has no unexplained failure; every defect class has a regression test.
- Status: open
- Implementation: harness and manifest on the worker's campaign branch (pending)
- Verification: pending
- Remaining integration work: none for the lead.

### Defects found so far (pass 1, first 11 maps: 7 pass, 4 fail)

Diagnosed on `main` and on PR 36; fixes go into one campaign-fix branch after release 4.4.0, each with a regression test.

| Id  | Map                                          | Symptom                                                                      | Root cause                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                  |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D4  | all reference worlds                         | 17,000 to 23,000 provinces at defaults (vanilla about 13,000): Aerdor 18,633 | `world-provinces.ts` `sites()` adds up to two extra land sites per sampling box from elevation and moisture (moisture 0.45 to 0.96 on reference terrain) on top of the `landProvincePixels` target instead of redistributing them; lakes use the land target | redistribute (keep the expected count at area / target), lakes at a lake target, and a planned-count budget on the legacy path (scale defaults to about 13,000, refuse above 21,000) |
| D3  | Lentärzan Fourt (3,758 x 1,878)              | `MAP_TEXT_FILE_LIMIT` without naming the file                                | `map/unitstacks.txt` 23.4 MB for 34,700 provinces (a D4 consequence)                                                                                                                                                                                         | D4, the count refusal before derived tables, and the file named in the error                                                                                                         |
| D2  | An anciente mappe of Fairyland (2,000 x 615) | `MAP_WORLD_UNREPRESENTABLE_TOPOLOGY`                                         | paper margin read as land reaches both frame edges; a horizontal coast crosses the east-west seam, where province parts never join but the corner check wraps, so the corner can never be resolved                                                           | repair seam corners in the mask before partitioning (one pixel, reported); detect uniform paper margins                                                                              |
| D1  | A Map of Cielago (922 x 898)                 | write job died in native code (0xC0000409), preview passed                   | not reproduced in isolation (twice OK, 204 to 218 s, peak 5.6 GB); likely an allocation failure under memory pressure from parallel runs                                                                                                                     | phase markers and peak memory in the worker log, one automatic retry of a native crash before any write, lower peak memory (see D5)                                                  |
| D5  | Map of Elindrafel 7 (4,000 x 4,000)          | one call over 30 minutes, then cancelled and restored                        | load: in isolation the write takes 209 s (generation 79 s, diff render 32 s, apply 54 s, post-validation 35 s); four review artifacts of about 95 MB each; a cancellation during post-validation is reported as "verification failed"                        | smaller review artifacts, reuse of the preview plan, the real cause reported on restore                                                                                              |

### Reliability table

| #   | Map | Licence | Size | Category | Outcome | Defect | Fix |
| --- | --- | ------- | ---- | -------- | ------- | ------ | --- |

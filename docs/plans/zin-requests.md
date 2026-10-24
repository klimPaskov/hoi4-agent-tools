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

| Date | Branch | Head | Note |
| --- | --- | --- | --- |
| 2026-10-24 | `claude/zin-map-pipeline-phase1` | `9ed6351` | state at launch, clean, package 4.3.0; unchanged by the worker so far |

## Installed runtime

| Date | Prefix | Version | Registrations |
| --- | --- | --- | --- |
| 2026-10-24 | `C:/Users/klimp/AppData/Local/hoi4-agent-tools/runtime-v430/` | 4.3.0 | `~/.claude.json` `mcpServers.hoi4_agent_tools` points at it (checked 2026-10-24); `~/.codex/config.toml` not yet re-checked |

## Announcements

Schema changes, compatibility changes, releases, runtime installs and server restarts, newest first.

- 2026-10-24: nothing announced yet. No server restart, runtime install or main-checkout switch is planned before the lead is told here.

## Index

| Id | Title | Priority | Status |
| --- | --- | --- | --- |
| ZR-1 | Validators fail with `WORKSPACE_CONTEXT_NOT_FOUND` outside the mod folder | P1 | in progress (reproduced) |
| ZR-2 | Import of the owner's drawn map | P0 design, P1 implementation | in progress (design) |

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
- Status: in progress (reproduced; subfolder case confirmed working by code and test)
- Implementation: pending
- Verification: pending
- Remaining integration work: until the release, call with `"workspaceId":"mod_zin_86bac5c64231"` from sessions outside the mod folder.

## ZR-2: Import of the owner's drawn map

- Opened: 2026-10-24 by lead
- Priority: P0 design, P1 implementation
- ZIN task: R-10 (acceptance A-10), base for R-11 to R-18.
- Tool or workflow: `hoi4_map_rewrite` `create_world` with the geography model and a reference.
- Inputs and reproduction: the full drawing `C:/Users/klimp/Documents/ZIN/World/Erdae/Maps/Colored/Erdae Full Colored Map.png` (17,520 x 12,720 RGBA, private, never committed or embedded) plus the per-sheet transforms in the mod's `tools/content/data/geography/erdae.json` (`sheets`: twelve sheets, each `drawingBox`, `drawingAnchor`, `worldAnchor`, `scaleWorldPerDrawing`, `mirrorX`; accuracy about 80 px); the alternative source is the cleaned layout `docs/reference/cleaned/Erdae-clean-v3.png` (5,120 x 2,560, 11 flat colours). Owner question Q-04 decides which.
- Current behaviour: to be confirmed in the design. The geography model in the mod is a GeoJSON-style document (`geometry` objects, extra `drawing` coordinates per feature) that is not the tool's geography schema version 1; `create_world` takes one reference picture fitted by padding, with no per-sheet transform.
- Required capability or improvement: an import from the full drawing plus transforms (and from the cleaned layout) to the 5,120 x 2,560 game layout with aligned layers, ids stable across re-imports, an authored-override source file that survives regeneration, accurate diagnostics on broken input, other map workflows unaffected.
- Evidence: pending (design).
- Impact: R-10 and every later map requirement.
- Acceptance: A-10.
- Status: in progress (design ADR being written; the worker tells the lead here before any schema change)
- Implementation: pending
- Verification: pending
- Remaining integration work: owner answer to Q-04 (the design takes both sources).

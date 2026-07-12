# Shared Architecture

## Purpose

Build one reusable engine with three focused modules. The modules share workspace discovery, parsing, indexing, diagnostics, transactions, configuration, artifacts, and machine-readable results. Do not create three unrelated services.

The implementation belongs under the standalone root defined in `00_standalone_project_bootstrap.md`.

A suggested source layout is:

```text
src/hoi4_agent_tools/
  core/
  focus/
  gui/
  map/
  mcp/
  schemas/
```

## Required research

Before implementation:

- Write the standalone project's own `AGENTS.md`.
- Read the offline Paradox wiki pages for national focuses, interface modding, scripted GUI, graphical assets, maps, states, provinces, data structures, effects, triggers, scopes, and localisation.
- Read relevant official documentation under the installed Hearts of Iron IV `documentation` folder.
- Inspect vanilla implementations.
- Inspect approved reference mods only when vanilla and official documentation do not answer a concrete question.
- Search available public libraries for parsers, graph layout, image processing, MCP support, and test utilities before building replacements.
- Treat Chaos Redux sources as reference material only.

Write architecture decision records for the implementation language, parser, image libraries, graph-layout library, rendering layer, MCP SDK, storage, test strategy, packaging, and unsupported cases.

## Workspace resolver

Resolve these inputs from registered workspace configuration:

- mod root
- installed game root
- dependency mod roots and load order
- replace-path behavior
- localisation roots
- interface and GFX roots
- map roots
- generated artifact root
- cache root
- test fixture root

The engine must support many unrelated HOI4 mods. Project adapters are optional configuration packages. They cannot change the safety model or core file semantics.

## Clausewitz source model

The shared source model must:

- preserve comments
- preserve unknown keys and raw blocks
- preserve ordering where it matters
- track file, line, column, and token locations
- support targeted rewrites without formatting unrelated content
- report malformed syntax with useful locations
- expose symbols and references across files
- preserve localisation encoding, including UTF-8 BOM files
- preserve a no-change round trip

If a construct cannot be rewritten safely, retain the original token range and block the edit.

## Index and dependency graph

Index focus IDs, tree IDs, sprites, textures, GUI elements, scripted GUI entries, localisation keys, state IDs, province IDs and colors, strategic regions, adjacencies, supply nodes, railways, and related references.

The index must understand vanilla, the active mod workspace, configured dependencies, and load order. It must identify collisions and overridden definitions.

## Agent service contract

All public capability is exposed through the MCP server defined in `06_public_mcp_server.md`. Internal services and test harnesses may invoke the same typed functions directly, but there is no supported interactive focus, GUI, or map application.

Every MCP operation must return structured results containing:

- status and deterministic error code
- workspace ID
- files scanned
- proposed or changed files
- source-linked diagnostics
- rewrite outcome when relevant
- artifact resource links
- validation results
- blocker details
- automatic recovery status when a write fails

Scanning, linting, rendering, and preview generation are read-only.

## Autonomous rewrites and internal transactions

Every write operation must:

1. verify that the canonical mod workspace is operator-authorized for effective `writePolicy: "autonomous"`
2. enforce the authenticated principal, workspace grant, transport write scope, and path-containment boundaries
3. calculate the complete affected-file set
4. validate the proposed result in memory and refuse blockers before source mutation
5. generate source and visual evidence where relevant
6. acquire the workspace write lock and reject stale source or changed roots
7. persist an authenticated internal journal with exact original bytes and the intended replacements
8. replace the complete file set with recoverable logical atomicity
9. rebuild the affected index and run post-write validation
10. restore exact original bytes automatically when any required write or validation step fails
11. return the completed rewrite outcome, diagnostics, changed-file list, and evidence resources in the same MCP call

The primary MCP contract must not require a coding agent to receive or resubmit a transaction ID or plan hash, page through a transaction diff, call a separate apply operation, or invoke rollback. Internal transaction manifests remain implementation and recovery records rather than caller authorization tokens. A manually staged `writePolicy: "transactions"` mode may remain available as an explicitly enabled compatibility surface, but the public documentation, prompts, and acceptance path use autonomous one-call rewrites.

## Generated workspace

Use an ignored per-workspace folder such as `.hoi4-agent/` for caches, previews, artifacts, internal journals, and automatic-recovery data. The standalone server repository keeps only synthetic fixtures and its own test artifacts.

Generated previews are evidence for the coding agent. The HOI4 source files remain authoritative.

## Non-goals

Do not build a shallow content generator. Do not replace gameplay design. Do not require a runtime framework inside HOI4. Do not create an interactive dashboard or editor. Do not put core behavior into transport code. The MCP server calls the shared engine and remains the only supported external tool interface.

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
- transaction ID when relevant
- artifact resource links
- validation results
- blocker details
- rollback status when relevant

Scanning, linting, rendering, and preview generation are read-only.

## Transactions

Every write operation must:

1. calculate the complete affected-file set
2. validate the proposed result in memory
3. generate source and visual diffs where relevant
4. save rollback data
5. return a transaction ID and plan hash
6. require a separate MCP apply call
7. write atomically
8. rebuild the affected index
9. run post-write validation
10. roll back when a required check fails

Use a declarative transaction manifest that agents can inspect, replay, compare, and cite in handoffs.

## Generated workspace

Use an ignored per-workspace folder such as `.hoi4-agent/` for caches, previews, artifacts, and rollback data. The standalone server repository keeps only synthetic fixtures and its own test artifacts.

Generated previews are evidence for the coding agent. The HOI4 source files remain authoritative.

## Non-goals

Do not build a shallow content generator. Do not replace gameplay design. Do not require a runtime framework inside HOI4. Do not create an interactive dashboard or editor. Do not put core behavior into transport code. The MCP server calls the shared engine and remains the only supported external tool interface.

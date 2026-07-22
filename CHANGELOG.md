# Changelog

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

Earlier release history is available in the [Git tags](https://github.com/klimPaskov/hoi4-agent-tools/tags).

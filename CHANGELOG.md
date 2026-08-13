# Changelog

## 2.5.1 - 2026-08-13

- Published artifact contents and provenance manifests atomically across independent MCP processes, preventing event, probability, GUI, and other concurrent inspections from observing partially written manifests.
- Recovered clearly interrupted zero-filled or truncated provenance manifests during matching writes and storage pruning while continuing to reject arbitrary malformed or tampered manifests.
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

Earlier release history is available in the [Git tags](https://github.com/klimPaskov/hoi4-agent-tools/tags).

# Changelog

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

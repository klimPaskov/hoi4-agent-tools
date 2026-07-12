# Changelog

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

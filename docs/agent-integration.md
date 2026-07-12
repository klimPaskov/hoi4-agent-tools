# Agent integration and autonomous tool selection

HOI4 Agent Tools is a capability server for coding agents. Once an MCP-compatible host has a persistent server registration, the coding agent should decide when to invoke it from the task and repository context. The server does not need a special activation phrase and does not replace the agent's planning, research, or source-control workflow.

## Persistent local availability

Use a durable server configuration and a pinned package version. The MCP host launches the stdio process when needed, so no background daemon or manual server window is required.

Suggested durable configuration locations:

- Windows: `%APPDATA%\hoi4-agent-tools\config.json`
- macOS: `~/.config/hoi4-agent-tools/config.json`
- Linux: `~/.config/hoi4-agent-tools/config.json`

Keep transaction state outside every game, mod, dependency, artifact, and cache root. Generated artifact/cache storage may also be placed outside the mod by using `storageRoots`, `artifactRoot`, and `cacheRoot`. See [configuration](configuration.md).

Create and validate a configuration:

```bash
npm install --global hoi4-agent-tools@0.1.7
hoi4-agent-tools-setup --init-config /absolute/path/config.json --workspace /absolute/path/mod --workspace-id my_mod --workspace-name "My Mod" --game /absolute/path/game
hoi4-agent-tools-setup --diagnose --config /absolute/path/config.json
hoi4-agent-tools-setup --print-client-config --config /absolute/path/config.json
```

The setup utility creates a read-only configuration unless `--enable-writes` and a separate `--server-state` root are supplied. `--print-client-config` prints both a pinned `npx` registration and an optional global-install registration. It does not edit an MCP host's settings.

Generic host registration:

```json
{
  "mcpServers": {
    "hoi4_agent_tools": {
      "command": "npx",
      "args": ["-y", "hoi4-agent-tools@0.1.7"],
      "env": {
        "HOI4_AGENT_CONFIG": "/absolute/path/config.json"
      }
    }
  }
}
```

Codex registration:

```toml
[mcp_servers.hoi4_agent_tools]
command = "npx"
args = ["-y", "hoi4-agent-tools@0.1.7"]
startup_timeout_sec = 120

[mcp_servers.hoi4_agent_tools.env]
HOI4_AGENT_CONFIG = "/absolute/path/config.json"
```

Use `npx.cmd` on Windows. Restart the coding-agent host after adding or changing the registration. Statically configured workspaces remain available across every server process; runtime `hoi4.project_register` registrations intentionally last only for the current process.

## Autonomous selection rules

A coding agent should select this server when a registered HOI4 workspace task involves any of these surfaces:

- national focus trees or continuous focus palettes;
- Clausewitz prerequisite, route-lock, mutual-exclusion, localisation, icon, AI, or linked-content validation;
- scripted GUI, interface, GFX, sprites, fonts, animation states, deterministic previews, or visual comparisons;
- states, provinces, province geometry, strategic regions, adjacency, supply nodes, or railways;
- source-preserving dry runs, visual diffs, atomic multi-file apply, or rollback for those surfaces.

Do not use the server for arbitrary shell commands, general repository edits, game automation, or in-game screenshots. It exposes typed HOI4 services, not a command runner.

The normal first calls are:

1. `hoi4.project_status` to discover the configured workspace ID and write status.
2. `hoi4.project_scan` when a complete shared symbol/reference revision is useful.
3. The relevant domain scan and lint tools.
4. Deterministic layout/render/compare tools before a source plan.

Large artifacts are returned as opaque `hoi4-agent://` resources. Read the linked resource instead of asking the tool to inline it. Artifact reads are range-bounded; use `?offset=N&length=1048576` until the complete advertised size has been retrieved.

## Large focus-tree repair

Use the Focus Tree Workbench for large or badly structured trees: broken or ambiguous prerequisites, duplicate coordinates, avoidable connector crossings, unstable route layout, missing references, weak convergence, or a tree whose visual structure no longer matches its route architecture.

The safe repair sequence is:

1. Call `hoi4.focus_scan`, `hoi4.focus_lint`, and `hoi4.focus_render` for the existing source. A very wide or deep national tree can pass `reviewScale` from `0.25` through `1.0`; retain that scale for transaction and final review artifacts.
2. Read the complete imported plan resource and baseline HTML/SVG/PNG/JSON/source-map artifacts.
3. Preserve prerequisites, exclusions, route locks, rewards, comments, raw passthrough, source locations, and provenance.
4. Assign explicit `branchGroups`, `laneGroups`, `branchId`, and `laneId` metadata that reflect the intended route architecture.
5. Keep only deliberate anchors fixed or pinned. Imported authored `x`/`y` values are intentionally treated as fixed; nodes do not become movable merely because `hoi4.focus_layout` was called.
6. Change movable nodes to automatic positions, optionally retaining route intent with preferred coordinates:

   ```json
   {
     "mode": "auto",
     "pinned": false,
     "preferredX": 8,
     "preferredY": 12
   }
   ```

7. Submit the complete plan to `hoi4.focus_plan_changes`. This performs the deterministic proposed layout, source-preserving compilation, lint, before/proposed render, bitmap comparison, and dry-run transaction. For a national tree whose default review canvas would exceed the bounded renderer, pass a uniform `reviewScale` from `0.25` through `1.0` (for example, `0.4` for a very large tree). It scales the complete visual rather than crowding node geometry, is applied identically to before and proposed artifacts, and does not change compiled focus coordinates. Optional `horizontalSpacing`, `verticalSpacing`, and `padding` controls remain available for intentional review-presentation changes.
8. Follow every `hoi4.transaction_diff` cursor. Review the source map, changed fields, diagnostics, and visual artifacts.
9. Apply only when the coding-agent host's write policy authorizes it, using the exact transaction ID and expected plan hash.
10. Rescan, lint, and render the applied source. Use `hoi4.transaction_rollback` with the same hash if validation fails or the reviewed result is not acceptable.

`hoi4.focus_layout` by itself is deliberately conservative. It preserves fixed, relative, pinned, and prior-stable nodes. Full-tree cleanup is an explicit plan decision because silently rearranging authored coordinates would be unsafe.

## Creating a large focus tree

The coding agent translates repository requirements and route descriptions into the public `FocusTreePlan` schema at `hoi4-agent://schema/focus-plan`. The MCP server validates and compiles that typed plan; it is not an unbounded natural-language generator.

A serious large-tree plan should define:

- a small number of intentional fixed anchors and automatic branch nodes;
- lane and branch groups with stable order and horizontal bounds;
- exact AND/OR prerequisite grouping;
- reciprocal route exclusions where the UI should show them;
- shared support lanes that stay available to compatible political routes;
- convergence points, capstones, failure states, hidden/reveal metadata, and late-game payoffs;
- localisation keys, icon sprites, AI weights/strategies, filters, and links to decisions, events, ideas, leaders, helpers, and formables;
- raw passthrough for unsupported or not-yet-modelled Clausewitz content.

For a new source beneath `common/national_focus`, call `hoi4.focus_plan_changes` with `createIfMissing: true`. Use `plan:<tree-id>` as creation `provenance.sourcePath` and 64 zeroes for both initial provenance hashes only when the target is missing. Existing targets normally use imported, hash-bound provenance; resolving intentional plan/source drift additionally requires explicit `authority: "plan"`. Creation refuses to append a different tree to an existing source file. The first write is still a dry-run transaction with transparent before evidence and complete proposed artifacts.

## Write autonomy and safety boundary

Agents may autonomously discover workspaces, scan, lint, lay out, render, compare, inspect artifacts, and prepare dry-run transactions. Source apply remains a distinct capability boundary:

- global `writePolicy` must be `transactions`;
- the canonical mod workspace must be allowlisted and `writeEnabled`;
- the dry run must be complete and unexpired;
- every source hash and principal/workspace binding is rechecked;
- the separate apply call must carry the exact expected plan hash;
- the coding-agent host's configured write/approval policy must authorize the apply.

This division lets agents decide when the MCP is useful and do the analysis autonomously without turning discovery into implicit source mutation.

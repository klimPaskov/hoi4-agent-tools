# Agent integration and autonomous tool selection

HOI4 Agent Tools is a capability server for coding agents. Once an MCP-compatible host has a persistent server registration, the coding agent should decide when to invoke it from the task and repository context. The server does not need a special activation phrase and does not replace the agent's planning, research, or source-control workflow.

## Persistent local availability

Use a durable server configuration and a pinned package version. The MCP host launches the stdio process when needed, so no background daemon or manual server window is required.

Suggested durable configuration locations:

- Windows: `%APPDATA%\hoi4-agent-tools\config.json`
- macOS: `~/.config/hoi4-agent-tools/config.json`
- Linux: `~/.config/hoi4-agent-tools/config.json`

Keep rewrite state outside every game, mod, dependency, artifact, and cache root. Generated artifact/cache storage may also be placed outside the mod by using `storageRoots`, `artifactRoot`, and `cacheRoot`. See [configuration](configuration.md).

Create and validate a configuration:

```bash
npm install --global hoi4-agent-tools@0.2.0
hoi4-agent-tools-setup --init-config /absolute/path/config.json --workspace /absolute/path/mod --workspace-id my_mod --workspace-name "My Mod" --game /absolute/path/game
hoi4-agent-tools-setup --diagnose --config /absolute/path/config.json
hoi4-agent-tools-setup --print-client-config --config /absolute/path/config.json
```

The initialization command above creates a read-only configuration. To choose the recommended autonomous mode instead, replace that initialization command with:

```bash
hoi4-agent-tools-setup --init-config /absolute/path/config.json --workspace /absolute/path/mod --workspace-id my_mod --workspace-name "My Mod" --game /absolute/path/game --autonomous-writes --server-state /separate/operator/state
```

`--autonomous-writes` writes `"writePolicy": "autonomous"` and enables the named mod workspace. Use `--reviewed-writes --server-state /separate/operator/state` only when compatibility with the separate transaction review/apply sequence is required; `--enable-writes` remains a compatibility alias for reviewed mode. The flags are mutually exclusive. `--print-client-config` prints both a pinned `npx` registration and an optional global-install registration; it does not edit an MCP host's settings.

Generic host registration:

```json
{
  "mcpServers": {
    "hoi4_agent_tools": {
      "command": "npx",
      "args": ["-y", "hoi4-agent-tools@0.2.0"],
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
args = ["-y", "hoi4-agent-tools@0.2.0"]
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
- source-preserving rewrites, visual diffs, and recoverable multi-file changes for those surfaces.

Do not use the server for arbitrary shell commands, general repository edits, game automation, or in-game screenshots. It exposes typed HOI4 services, not a command runner.

The normal first calls are:

1. `hoi4.project_status` to discover the configured workspace ID, effective `writePolicy`, and write status.
2. `hoi4.project_scan` when a complete shared symbol/reference revision is useful.
3. The relevant domain scan and lint tools.
4. Deterministic layout/render/compare tools before a source rewrite.

Large artifacts are returned as opaque `hoi4-agent://` resources. Read the linked resource instead of asking the tool to inline it. Artifact reads are range-bounded; use `?offset=N&length=1048576` until the complete advertised size has been retrieved.

## Large focus-tree repair

Use the Focus Tree Workbench for large or badly structured trees: broken or ambiguous prerequisites, duplicate coordinates, avoidable connector crossings, unstable route layout, missing references, weak convergence, or a tree whose visual structure no longer matches its route architecture.

The autonomous repair sequence is:

1. Call `hoi4.focus_scan`, `hoi4.focus_lint`, and `hoi4.focus_render` for the existing source. A very wide or deep national tree can pass `reviewScale` from `0.25` through `1.0`; retain that scale for proposed and final evidence.
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

7. Submit the complete plan once to `hoi4.focus_rewrite`. This performs deterministic proposed layout, source-preserving compilation, lint, before/proposed rendering, bitmap comparison, journal admission, application, index rebuild, and post-write validation. For a national tree whose default review canvas would exceed the bounded renderer, pass a uniform `reviewScale` from `0.25` through `1.0` (for example, `0.4` for a very large tree). It scales the complete visual rather than crowding node geometry, is applied identically to before and proposed artifacts, and does not change compiled focus coordinates. Optional `horizontalSpacing`, `verticalSpacing`, and `padding` controls remain available for intentional review-presentation changes.
8. Check `execution`, `changedFiles`, diagnostics, validation, source-map links, and visual evidence in the result. A blocked proposal has `execution: "planned"` and changes no source. A successful rewrite has `execution: "applied"`.
9. Rescan, lint, and render when additional final evidence is useful. The rewrite call already rescans and post-validates; if any application or post-validation step fails, the journal restores every affected file automatically before failure is returned.

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

For a new source beneath `common/national_focus`, call `hoi4.focus_rewrite` with `createIfMissing: true`. Use `plan:<tree-id>` as creation `provenance.sourcePath` and 64 zeroes for both initial provenance hashes only when the target is missing. Existing targets normally use imported, hash-bound provenance; resolving intentional plan/source drift additionally requires explicit `authority: "plan"`. Creation refuses to append a different tree to an existing source file. The one-call rewrite retains transparent before evidence, complete proposed artifacts, and exact recovery bytes for the newly created source and sidecar.

## Write autonomy and safety boundary

Read-only remains the default. With global `writePolicy: "autonomous"` and `writeEnabled: true` on a canonical mod workspace, the server exposes only the one-call source tools:

- `hoi4.focus_rewrite`;
- `hoi4.gui_rewrite`;
- `hoi4.map_rewrite`.

Each rewrite internally creates a complete hash-bound plan, validates it, persists an authenticated journal and exact before-bytes, applies it under the workspace lock, rebuilds the shared index, and post-validates. Invalid proposals never apply. Stale source, wrong principal/workspace bindings, write-scope failure, application errors, final hash mismatch, and post-validation failures fail closed; failures after replacement begins trigger automatic restoration. Transaction status, diff, apply, and rollback tools are intentionally not registered in autonomous mode.

MCP itself does not mandate a confirmation dialog for each mutating tool. The rewrite tools advertise `readOnlyHint: false` and `destructiveHint: true`, but those annotations are hints to the client. The server cannot override a coding-agent host policy that prompts for, blocks, or otherwise constrains the call. Operators grant server-side authority through configuration and, for HTTP, the `hoi4:write` scope; clients independently decide how that authority is presented to users.

Git remains the project-history, collaboration, and intentional-revert layer. The authenticated journal is separate operational recovery: it prevents an interrupted or invalid multi-file rewrite from being reported as success or left partially applied.

## Reviewed transaction compatibility

Set `writePolicy: "transactions"` (or initialize with `--reviewed-writes`) only when a client or workflow still depends on the older review boundary. In that mode, the server exposes `hoi4.focus_plan_changes`, `hoi4.gui_plan_changes`, and `hoi4.map_plan`; callers page through `hoi4.transaction_diff`, then call `hoi4.transaction_apply` with the exact transaction ID and plan hash. `hoi4.transaction_status` and explicit `hoi4.transaction_rollback` are also available. The same planning, hash checks, journal, post-validation, and failure-recovery engine is used in both write modes.

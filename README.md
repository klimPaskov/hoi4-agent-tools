# HOI4 Agent Tools

HOI4 Agent Tools is a source-preserving Model Context Protocol server for coding agents working on Hearts of Iron IV mods. It combines a Focus Tree Workbench, Scripted GUI Studio, and headless map rewrite system over one shared parser, workspace index, renderer, artifact store, and recovery engine.

The agent workflow is:

```text
agentic HOI4 modding kit → coding agent selects the MCP capability → MCP tools → registered external mod workspace
```

The coding agent decides when the HOI4 capability is relevant; no special prompt is required once the server is registered with the agent host. The MCP server is the product interface. There is no focus editor, GUI editor, map editor, dashboard, or gameplay-tool CLI. The setup utility only creates server configuration, checks dependencies, and prints client configuration for review.

## Install

Requires Node.js 22 or 24.

```bash
npm install --global hoi4-agent-tools@0.2.0
hoi4-agent-tools-setup --init-config /path/to/config.json --workspace /path/to/mod --workspace-id my_mod --workspace-name "My Mod" --game /path/to/game
hoi4-agent-tools-setup --diagnose --config /path/to/config.json
hoi4-agent-tools-setup --print-client-config --config /path/to/config.json
```

The generated configuration is read-only unless a write flag is supplied. To let the coding agent complete validated focus, GUI, and map rewrites in one call, initialize the configuration with:

```bash
hoi4-agent-tools-setup --init-config /path/to/config.json --workspace /path/to/mod --workspace-id my_mod --workspace-name "My Mod" --game /path/to/game --autonomous-writes --server-state /separate/operator/state
```

`--autonomous-writes` selects the recommended `"autonomous"` write policy. For compatibility with the older review/apply sequence, use `--reviewed-writes --server-state /separate/operator/state` instead; the legacy `--enable-writes` spelling remains an alias for that reviewed mode. Autonomous and reviewed flags are mutually exclusive. Both write-enabled policies require the separate state root, which must not overlap source, registration, artifact, cache, fixture, or generated-storage roots. The utility never edits an MCP client's settings.

For one-shot stdio installation, clients can launch:

```text
npx -y hoi4-agent-tools@0.2.0
```

with `HOI4_AGENT_CONFIG` set to the persistent server config path.

For permanent local availability, keep the configuration at a durable absolute path, add the pinned stdio entry to the coding-agent host once, and restart that host. It will launch the server automatically on future tasks; a separate daemon is not required. A global npm installation is optional because the pinned `npx` entry is reproducible on every supported platform.

## Minimal configuration

```json
{
  "version": 1,
  "writePolicy": "read-only",
  "registrationRoots": ["/projects/hoi4-mods"],
  "writableRegistrationRoots": [],
  "workspaces": [
    {
      "id": "my_mod",
      "name": "My Mod",
      "root": "/projects/hoi4-mods/my-mod",
      "gameRoot": "/games/Hearts of Iron IV",
      "dependencyRoots": [],
      "replacePaths": [],
      "writeEnabled": false
    }
  ]
}
```

All public paths are workspace-relative. Installed game and dependency roots are always read-only. Runtime mod registration additionally requires a separate, default-empty `writableRegistrationRoots` capability, so a read-only source root cannot be relabelled as a mod. By default, caches, render evidence, authenticated rewrite journals, and recovery blobs live under the workspace's ignored `.hoi4-agent/` directory; `artifactRoot` and `cacheRoot` may instead select allowlisted external storage. The private journal-authentication key and replay-protection heads live only under the separate operator `serverStateRoot`.

A complete external-storage example is available in the repository at [`examples/config/autonomous.json`](https://github.com/klimPaskov/hoi4-agent-tools/blob/main/examples/config/autonomous.json).

See [configuration](docs/configuration.md) and [security](docs/security.md) before enabling writes.

## Client configuration

Generic JSON-based clients:

```json
{
  "mcpServers": {
    "hoi4_agent_tools": {
      "command": "npx",
      "args": ["-y", "hoi4-agent-tools@0.2.0"],
      "env": { "HOI4_AGENT_CONFIG": "/absolute/path/to/config.json" }
    }
  }
}
```

Codex `config.toml`:

```toml
[mcp_servers.hoi4_agent_tools]
command = "npx"
args = ["-y", "hoi4-agent-tools@0.2.0"]
env = { HOI4_AGENT_CONFIG = "/absolute/path/to/config.json" }
```

On Windows, use `npx.cmd`. The complete persistent-registration and autonomous-selection guide is in [agent integration](docs/agent-integration.md). Additional repository examples are under [`examples/clients`](https://github.com/klimPaskov/hoi4-agent-tools/tree/main/examples/clients).

## Write modes and recovery

The server starts read-only. Operators can choose one of two explicit write policies:

- `"autonomous"` exposes `hoi4.focus_rewrite`, `hoi4.gui_rewrite`, and `hoi4.map_rewrite`. Each call plans the complete change, validates proposed bytes, persists an authenticated journal and recovery blobs, applies under the workspace lock, rebuilds the index, and post-validates. A failure restores the original bytes automatically before the call reports failure. No transaction diff, apply, status, or rollback tools are exposed in this mode.
- `"transactions"` is an optional compatibility mode. It exposes the older `*_plan_changes`/`map_plan` tools and the separate `hoi4.transaction_diff`, `hoi4.transaction_apply`, `hoi4.transaction_rollback`, and `hoi4.transaction_status` sequence.

Both write modes require an isolated persistent `serverStateRoot`, a canonical allowlisted mod workspace with `writeEnabled: true`, valid proposed changes, unchanged source hashes, and write authorization for remote access. Stale and cross-workspace writes fail closed. The autonomous rewrite tools truthfully advertise `destructiveHint: true`; MCP does not require a user prompt for every destructive tool call, and the server cannot override the coding-agent host's own approval or filesystem policy. A host may still prompt for or block a call.

Git remains the recommended project-history and collaboration layer. It is not the in-flight recovery mechanism: the server's journal and exact before-bytes prevent a failed multi-file rewrite from leaving a partially changed workspace, even when the workspace is not a Git repository. See [autonomous rewrites and transactions](docs/transactions.md).

## Tool families

- Projects: `hoi4.project_register`, `hoi4.project_scan`, `hoi4.project_status`
- Focus: scan, import, lint, layout, render, rewrite, and export
- GUI: scan, lint, deterministic render/state matrix, compare, and rewrite
- Map: scan, inspect, allocate, rewrite, render, and validate
- Reviewed transactions (usable for source writes only in compatibility mode): `hoi4.transaction_diff`, `hoi4.transaction_apply`, `hoi4.transaction_rollback`, `hoi4.transaction_status`
- Artifacts: `hoi4.artifact_list`, `hoi4.artifact_describe`, plus opaque MCP resources

Large HTML, SVG, PNG, JSON, fidelity, hierarchy, map, and diff outputs are resources rather than oversized tool responses. MCP prompts guide focus, GUI, and map workflows but never bypass validation.

## When coding agents should use this server

Agents should select HOI4 Agent Tools proactively when a registered workspace task touches national or continuous focus trees, scripted GUI/GFX/localisation, or map/state/province/rail/supply data.

Large focus trees are a flagship workflow. Use the workbench to import and preserve an existing tree, detect broken references and prerequisite semantics, find overlaps and avoidable connector crossings, assign coherent route lanes, produce deterministic evidence, and compile a hash-bound rewrite. The same typed plan supports creating large new trees from an agent's structured interpretation of route requirements, including OR/AND prerequisites, mutually exclusive routes, shared support lanes, convergence, hidden branches, localisation, icons, AI metadata, and late-game payoffs.

Start with `hoi4.project_status` or `hoi4.project_scan`, then use the relevant scan/lint/layout/render family. Existing authored coordinates are intentional stability anchors; a full repair must explicitly change movable imported nodes to automatic positions before `hoi4.focus_rewrite`. Very large national-tree baseline, proposed, and final renders can use one uniform bounded review scale without changing compiled focus coordinates. In compatibility mode, use `hoi4.focus_plan_changes` and the reviewed transaction sequence instead. See [Focus Tree Workbench](docs/focus-workflow.md).

## Offline rendering boundary

Scripted GUI Studio parses and renders source files itself. It never launches, controls, automates, hooks, or captures screenshots from Hearts of Iron IV. Every GUI render is labelled as an offline representation and includes a fidelity report with modelled, approximated, ignored, missing, unsupported, and unresolved fields.

## Streamable HTTP

`hoi4-agent-tools-http` provides stateful Streamable HTTP on `127.0.0.1` by default. Every request requires authentication. Non-loopback deployment additionally requires HTTPS, OAuth/OIDC JWT verification, allowed origins, Host validation, principal-to-workspace grants, and limits. See [self-hosting](docs/self-hosting.md); legacy SSE-only transport is not provided.

## Documentation

- [Documentation index](docs/README.md)
- [Agent integration and autonomous tool selection](docs/agent-integration.md)
- [Architecture](docs/architecture.md)
- [Focus workflow](docs/focus-workflow.md)
- [GUI workflow and fidelity](docs/gui-workflow.md)
- [Map workflow](docs/map-workflow.md)
- [Testing and fixtures](docs/testing.md)
- [Compatibility](docs/compatibility.md)
- [Known limitations](docs/limitations.md)
- [Release and Registry publication](docs/release.md)

## Development

```bash
npm ci
npm run check
npm run inspector
```

Portable CI uses only project-owned synthetic fixtures. Opt-in local integration tests may read installed game and external mod sources but never copy or modify them.

Apache-2.0 licensed. Hearts of Iron IV and Paradox Interactive are trademarks of their respective owners; this project is unaffiliated.

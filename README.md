# HOI4 Agent Tools

HOI4 Agent Tools is a source-preserving Model Context Protocol server for coding agents working on Hearts of Iron IV mods. It combines a Focus Tree Workbench, Scripted GUI Studio, and headless map transaction system over one shared parser, workspace index, renderer, artifact store, and rollback engine.

The workflow is:

```text
human request → coding agent → MCP tools → registered external mod workspace
```

The MCP server is the product interface. There is no focus editor, GUI editor, map editor, dashboard, or gameplay-tool CLI. The setup utility only creates server configuration, checks dependencies, and prints client configuration for review.

## Install

Requires Node.js 22 or 24.

```bash
npm install --global hoi4-agent-tools@0.1.3
hoi4-agent-tools-setup --init-config /path/to/config.json --workspace /path/to/mod --game /path/to/game
hoi4-agent-tools-setup --diagnose --config /path/to/config.json
hoi4-agent-tools-setup --print-client-config --config /path/to/config.json
```

The generated configuration is read-only. Add `--enable-writes --server-state /separate/operator/state` only when transaction apply/rollback is intended. The state root is mandatory in transaction mode and must not overlap source, registration, artifact, cache, fixture, or generated-storage roots. The utility never edits an MCP client's settings.

For one-shot stdio installation, clients can launch:

```text
npx -y hoi4-agent-tools@0.1.3
```

with `HOI4_AGENT_CONFIG` set to the reviewed config path.

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

All public paths are workspace-relative. Installed game and dependency roots are always read-only. Runtime mod registration additionally requires a separate, default-empty `writableRegistrationRoots` capability, so a read-only source root cannot be relabelled as a mod. Caches, render evidence, transaction manifests, and rollback blobs live under the workspace's ignored `.hoi4-agent/` directory; the private journal-authentication key and replay-protection heads live only under the separate operator `serverStateRoot`.

See [configuration](docs/configuration.md) and [security](docs/security.md) before enabling writes.

## Client configuration

Generic JSON-based clients:

```json
{
  "mcpServers": {
    "hoi4_agent_tools": {
      "command": "npx",
      "args": ["-y", "hoi4-agent-tools@0.1.3"],
      "env": { "HOI4_AGENT_CONFIG": "/absolute/path/to/config.json" }
    }
  }
}
```

Codex `config.toml`:

```toml
[mcp_servers.hoi4_agent_tools]
command = "npx"
args = ["-y", "hoi4-agent-tools@0.1.3"]
env = { HOI4_AGENT_CONFIG = "/absolute/path/to/config.json" }
```

On Windows, use `npx.cmd`. Additional reviewed examples are under [`examples/clients`](examples/clients).

## Safe write protocol

The server starts read-only. A source write requires all of the following:

1. global transaction writes enabled with an isolated persistent `serverStateRoot`;
2. a registered workspace whose canonical root is allowlisted and write-enabled;
3. a completed in-memory dry run with all affected files and validation results;
4. a persisted transaction ID and plan hash;
5. human approval through the coding-agent client;
6. a separate `hoi4.transaction_apply` call carrying the exact expected plan hash.

Apply rechecks the principal, workspace, canonical roots, expiry, and every source hash. Stale or cross-workspace plans are rejected. Multi-file changes use a durable journal and exact rollback blobs; post-write validation failure restores the original bytes. See [transactions](docs/transactions.md).

## Tool families

- Projects: `hoi4.project_register`, `hoi4.project_scan`, `hoi4.project_status`
- Focus: scan, import, lint, layout, render, plan changes, and export
- GUI: scan, lint, deterministic render/state matrix, compare, and plan changes
- Map: scan, inspect, allocate, plan, render, and validate
- Transactions: `hoi4.transaction_diff`, `hoi4.transaction_apply`, `hoi4.transaction_rollback`, `hoi4.transaction_status`
- Artifacts: `hoi4.artifact_list`, `hoi4.artifact_describe`, plus opaque MCP resources

Large HTML, SVG, PNG, JSON, fidelity, hierarchy, map, and diff outputs are resources rather than oversized tool responses. MCP prompts guide safe focus, GUI, and map workflows but never bypass validation.

## Offline rendering boundary

Scripted GUI Studio parses and renders source files itself. It never launches, controls, automates, hooks, or captures screenshots from Hearts of Iron IV. Every GUI render is labelled as an offline representation and includes a fidelity report with modelled, approximated, ignored, missing, unsupported, and unresolved fields.

## Streamable HTTP

`hoi4-agent-tools-http` provides stateful Streamable HTTP on `127.0.0.1` by default. Every request requires authentication. Non-loopback deployment additionally requires HTTPS, OAuth/OIDC JWT verification, allowed origins, Host validation, principal-to-workspace grants, and limits. See [self-hosting](docs/self-hosting.md); legacy SSE-only transport is not provided.

## Documentation

- [Documentation index](docs/README.md)
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

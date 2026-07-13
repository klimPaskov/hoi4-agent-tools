# HOI4 Agent Tools

HOI4 Agent Tools is an MCP server for coding agents to inspect, create, and clean up Hearts of Iron IV focus trees, scripted GUIs, and maps. It works directly with configured mod folders and produces offline renders for review.

## What it does

- Focus trees: inspect structure and references, render layouts, create trees, and reorganize existing branches.
- Scripted GUIs: trace GUI, GFX, scripted-GUI, and localisation links; render states; create or repair interface source.
- Maps: inspect provinces, states, regions, adjacency, supply, and railways; render layers; create and repair exact map data.

## Setup

Requires Node.js 22 or 24.

```bash
npm install --global hoi4-agent-tools@1.1.1
hoi4-agent-tools-setup --init
```

`--init` discovers the usual HOI4 game and mod locations and writes the default per-user configuration. No `HOI4_AGENT_CONFIG` environment variable is needed. For custom paths, multiple mod roots, or a custom config location, see [Setup](docs/setup.md).

## Connect your agent

```bash
hoi4-agent-tools-setup --print-client-config
```

Paste the printed Codex or generic global-install entry into your MCP client, then restart it. The utility prints the correct command for the current operating system.

## Tools

| Tool                 | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `hoi4.mods`          | List the writable mods available to the coding agent.            |
| `hoi4.focus_inspect` | Read focus trees and report structural or reference problems.    |
| `hoi4.focus_render`  | Render an existing focus tree or continuous palette.             |
| `hoi4.focus_rewrite` | Create or update a focus tree.                                   |
| `hoi4.gui_inspect`   | Read a scripted GUI and its linked assets and logic.             |
| `hoi4.gui_render`    | Render GUI states and resolutions offline.                       |
| `hoi4.gui_rewrite`   | Create or update a GUI source package.                           |
| `hoi4.map_inspect`   | Read map, state, province, region, supply, and railway data.     |
| `hoi4.map_render`    | Render map layers and overlays.                                  |
| `hoi4.map_rewrite`   | Create or update map data from an ordered list of exact changes. |

Large outputs are linked `hoi4-agent://` resources. For resources over 1 MiB, follow the `continuationUri` returned in `_meta` until it is `null`; clients may also request byte ranges with `?offset=<bytes>&length=<bytes>`.

## Coexistence with agent workflows

HOI4 Agent Tools provides HOI4 domain operations; it does not register MCP prompts, replace repository instructions such as `AGENTS.md`, manage skills or plans, or start subagents. The coding agent decides when to call it as part of its existing workflow.

Connecting and listing tools does not scan mod source. Compact tool schemas and linked resources keep large diagnostics, renders, and diffs out of the agent's working context until needed. Only `hoi4.*_rewrite` calls edit mod source.

## Create or clean content

Ask your agent in normal task language. A typical workflow is inspect, render, rewrite, then inspect the result.

- Focus trees: "Create a complete national focus tree for this route specification," or "Compact this existing tree into a balanced, readable layout." Existing trees can use a plan-free compact reflow; new trees use a complete plan. See [Focus trees](docs/focus.md).
- Scripted GUIs: "Create a scripted GUI for this mechanic," or "Render this window at common resolutions and fix clipping, missing assets, and click-region conflicts." See [Scripted GUIs](docs/gui.md).
- Maps: "Create a state from these exact provinces," or "Inspect this state and split these provinces while keeping supply and railway references valid." See [Maps](docs/map.md).

## HTTP

Use stdio for local MCP clients. For shared or remote deployments, see [HTTP](docs/http.md).

## Development

```bash
npm ci
npm run check
```

See [Development](docs/development.md). Apache-2.0 licensed. Hearts of Iron IV and Paradox Interactive are trademarks of their respective owners; this project is unaffiliated.

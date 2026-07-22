# HOI4 Agent Tools

HOI4 Agent Tools is an MCP server for coding agents to understand Hearts of Iron IV event chains and technology systems and to inspect, create, or clean up focus trees, scripted GUIs, and maps. Start it in a mod folder and it works there immediately, with offline renders for review.

## What it does

- Focus trees: inspect structure and references, render layouts, create trees, and reorganize existing branches.
- Scripted GUIs: trace GUI, GFX, scripted-GUI, and localisation links; render states; create or repair interface source.
- Maps: inspect provinces, states, regions, adjacency, supply, and railways; render layers; create and repair exact map data.
- Event chains: scan definitions and call sites, trace routes and state flow, lint references, render graphs, and compare revisions without editing event source.
- Technology trees: reconstruct technology and doctrine paths, folder layouts, unlocks, bonuses, grants, metadata, assets, and structural changes.

## Setup

Requires Node.js 22 or 24.

```bash
npm install --global hoi4-agent-tools@latest
```

Start the MCP with its working directory set to the mod you are editing. No config or per-mod registration is required: the server finds that mod automatically. Run `hoi4-agent-tools-setup --init` only when you want persistent discovery for several mod roots, a custom game path, or a remote deployment; see [Setup](docs/setup.md).

## Connect your agent

```bash
hoi4-agent-tools-setup --print-client-config
```

Paste the printed Codex or generic global-install entry into your MCP client, then restart it. The utility prints the correct command for the current operating system.

## Tools

| Tool                 | Purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `hoi4.focus_inspect` | Read focus trees and report structural or reference problems.                           |
| `hoi4.focus_render`  | Produce fast HTML, SVG, JSON, and source-linked layout artifacts.                       |
| `hoi4.focus_raster`  | Produce a high-fidelity PNG review with decoded source icons.                           |
| `hoi4.focus_rewrite` | Create or update a focus tree.                                                          |
| `hoi4.gui_inspect`   | Read a scripted GUI and its linked assets and logic.                                    |
| `hoi4.gui_render`    | Render GUI states and resolutions offline.                                              |
| `hoi4.gui_rewrite`   | Create or update a GUI source package.                                                  |
| `hoi4.map_inspect`   | Read map, state, province, region, supply, and railway data.                            |
| `hoi4.map_render`    | Render map layers and overlays.                                                         |
| `hoi4.map_rewrite`   | Create or update map data from an ordered list of exact changes.                        |
| `hoi4.event_inspect` | Scan, trace, explain, lint, or assess event chains and their state flow.                |
| `hoi4.event_render`  | Render source-linked event routes, options, timing, state, scope, and unresolved edges. |
| `hoi4.event_compare` | Compare event-chain topology and diagnostics between revisions.                         |
| `hoi4.tech_inspect`  | Scan, trace, explain, lint, and assess technology and doctrine systems.                 |
| `hoi4.tech_render`   | Render source layouts, dependency paths, unlocks, grants, metadata, and asset coverage. |
| `hoi4.tech_compare`  | Compare technology graphs, placements, references, diagnostics, and source overlays.    |

Large outputs are linked `hoi4-agent://` resources. For resources over 1 MiB, follow the `continuationUri` returned in `_meta` until it is `null`; clients may also request byte ranges with `?offset=<bytes>&length=<bytes>`.

## Coexistence with agent workflows

HOI4 Agent Tools provides HOI4 domain operations; it does not register MCP prompts, replace repository instructions such as `AGENTS.md`, manage skills or plans, or start subagents. The coding agent decides when to call it as part of its existing workflow.

Connecting and listing tools does not scan mod source. Compact tool schemas and linked resources keep large diagnostics, renders, and diffs out of the agent's working context until needed. Event and technology tools analyze source without editing it; only `hoi4.*_rewrite` calls edit mod source.

## Create or clean content

Ask your agent in normal task language. A typical workflow is inspect, render, rewrite, then inspect the result. The agent can call a raster tool when a pixel review is useful without paying that cost during every structural operation.

- Focus trees: "Create a complete national focus tree for this route specification," or "Compact this existing tree into a balanced, readable layout." Existing trees can use a plan-free compact reflow; new trees use a complete plan. See [Focus trees](docs/focus.md).
- Scripted GUIs: "Create a scripted GUI for this mechanic," or "Render this window at common resolutions and fix clipping, missing assets, and click-region conflicts." See [Scripted GUIs](docs/gui.md).
- Maps: "Create a state from these exact provinces," or "Inspect this state and split these provinces while keeping supply and railway references valid." See [Maps](docs/map.md).
- Event chains: "Trace every route from this event and explain where its flags and variables change," or "Compare the workspace event graph with its previous revision and render the affected routes." See [Event chains](docs/events.md).
- Technology trees: "Explain everything this technology requires and unlocks," or "Compare this technology patch and render every affected folder and doctrine branch." See [Technology trees](docs/technology.md).

## HTTP

Use stdio for local MCP clients. For shared or remote deployments, see [HTTP](docs/http.md).

## Development

```bash
npm ci
npm run check
```

See [Development](docs/development.md). Apache-2.0 licensed. Hearts of Iron IV and Paradox Interactive are trademarks of their respective owners; this project is unaffiliated.

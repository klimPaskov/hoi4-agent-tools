# HOI4 Agent Tools

Give your coding agent one MCP server for Hearts of Iron IV modding.
It can find local documentation and vanilla examples, inspect a mod, render its trees and interfaces, compare source behavior, and make focused edits to focus trees, GUIs and maps.
The pictures below use real Chaos Redux or installed HOI4 files; click any image for the full-size version.

## Get started

Install [Node.js](https://nodejs.org/) 22.19+ in the Node 22 line, or Node.js 24, then run:

```bash
npm install --global hoi4-agent-tools
hoi4-agent-tools-setup --print-client-config
```

Add the printed configuration to your MCP client and open your mod as its workspace.
The install is about 280 MiB, because npm fetches the image library's binaries for every platform to keep each install identical.
Keep an installed copy of HOI4 available for vanilla examples, artwork and fonts.
The [setup guide](docs/setup.md) covers connecting your agent and choosing game or mod paths.

Ask your agent to find a focus tree and render it, locate the installed documentation for a script command, or preview a scripted GUI at different UI scales.
The examples below show the results.

## Examples

[Focus trees](#focus-trees-and-alternative-prerequisites) · [Technology folders](#technology-folders-and-card-artwork) · [Interfaces](#scripted-interfaces) · [Maps and events](#maps-and-event-chains) · [Local rules and AI](#local-rules-and-ai-weights) · [All tools](#complete-tool-list)

### Focus trees and alternative prerequisites

| Focus tree  | Supplied in-game capture                                                                                                    | MCP source preview                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 52 focuses  | [![Medium focus tree in game](docs/images/comparisons/fury-ingame.png)](docs/images/comparisons/fury-ingame.png)            | [![Medium focus tree preview](docs/images/comparisons/fury-mcp.png)](docs/images/comparisons/fury-mcp.png)            |
| 111 focuses | [![Large focus tree in game](docs/images/comparisons/holy-realm-ingame.png)](docs/images/comparisons/holy-realm-ingame.png) | [![Large focus tree preview](docs/images/comparisons/holy-realm-mcp.png)](docs/images/comparisons/holy-realm-mcp.png) |
| 124 focuses | [![Branching focus tree in game](docs/images/comparisons/utopia-ingame.png)](docs/images/comparisons/utopia-ingame.png)     | [![Branching focus tree preview](docs/images/comparisons/utopia-mcp.png)](docs/images/comparisons/utopia-mcp.png)     |

Dotted connectors in the MCP preview mark focuses where either preceding focus satisfies one prerequisite group.
The tree previews show route structure; the game's focus screen has different framing, labels and icons.
The [focus guide](docs/focus.md) explains inspection, rendering and edits, and the [comparison details](docs/visual-comparisons.md#focus-trees) retain source revisions.

### Technology folders and card artwork

> Render a technology folder. Check card sizes, artwork, links and missing placements.

| Folder           | Supplied in-game capture                                                                                                                   | MCP source preview                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Vanilla infantry | [![Infantry folder in game](docs/images/comparisons/infantry-ingame.png)](docs/images/comparisons/infantry-ingame.png)                     | [![Infantry technology folder](docs/images/comparisons/infantry-mcp.png)](docs/images/comparisons/infantry-mcp.png)                          |
| Mod wide cards   | [![Mod technology folder in game](docs/images/comparisons/chemical-recent-ingame.png)](docs/images/comparisons/chemical-recent-ingame.png) | [![Mod technology folder preview](docs/images/comparisons/chemical-historical-mcp.png)](docs/images/comparisons/chemical-historical-mcp.png) |

The mod folder preview uses the source revision recorded with its screenshot and includes wide equipment cards.
Armored-car artwork that installed DLC folders provide appears in the infantry preview.
The [technology comparison](docs/visual-comparisons.md#technology-folders) records its source revision, and the [technology guide](docs/technology.md) covers inspection and doctrine paths.

### Scripted interfaces

> Preview an interface with its game assets and fonts. Check states, text clipping and clickable areas at 100% and 125% UI scale.

| Interface              | Supplied in-game capture                                                                                                                  | MCP source preview                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Vanilla video options  | [![Options in game](docs/images/comparisons/gui/options-video-ingame.png)](docs/images/comparisons/gui/options-video-ingame.png)          | [![Options preview](docs/images/comparisons/gui/options-video-mcp.png)](docs/images/comparisons/gui/options-video-mcp.png)          |
| Vanilla priority panel | [![Priority panel in game](docs/images/comparisons/gui/skoda-priority-ingame.png)](docs/images/comparisons/gui/skoda-priority-ingame.png) | [![Priority panel preview](docs/images/comparisons/gui/skoda-priority-mcp.png)](docs/images/comparisons/gui/skoda-priority-mcp.png) |
| Mod management window  | [![Management window in game](docs/images/comparisons/gui/tag-manager-ingame.png)](docs/images/comparisons/gui/tag-manager-ingame.png)    | [![Management window preview](docs/images/comparisons/gui/tag-manager-mcp.png)](docs/images/comparisons/gui/tag-manager-mcp.png)    |

The management window capture comes from an older layout.
The video options preview has no observed gamma value, and the priority panel's capture frames its background differently.

| Mod event log                                                                                                        | Mod status panel                                                                                                                        | Mod status panel, second tab                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [![Event Log preview](docs/images/comparisons/gui/event-log-mcp.png)](docs/images/comparisons/gui/event-log-mcp.png) | [![Chaos Meter status](docs/images/comparisons/gui/chaos-meter-status-mcp.png)](docs/images/comparisons/gui/chaos-meter-status-mcp.png) | [![Chaos Meter deaths](docs/images/comparisons/gui/chaos-meter-deaths-mcp.png)](docs/images/comparisons/gui/chaos-meter-deaths-mcp.png) |

| Vanilla decisions                                                                                                                                        | Vanilla occupation                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![Decision window](docs/images/comparisons/native-ui/countrydecisionview-window.png)](docs/images/comparisons/native-ui/countrydecisionview-window.png) | [![Occupation window](docs/images/comparisons/native-ui/countryoccupationview-window.png)](docs/images/comparisons/native-ui/countryoccupationview-window.png) |

The event log, status panel, decision and occupation previews use declared states or positions for layout review.
They are source previews, not observations of a running campaign.
See the [interface gallery](docs/gui-comparisons.md) for full images and fidelity notes, and the [GUI guide](docs/gui.md) for scenario inputs.

### Maps and event chains

> Find Brandenburg on the map, inspect its provinces and neighbours, and show the affected source files before a change.

> Trace an event's options and follow-up events. Point out unresolved calls and link each route to its source.

| Source map                                                                                                                      | Mod event chain                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [![Map rendered from installed source](docs/images/comparisons/source/map-mcp.png)](docs/images/comparisons/source/map-mcp.png) | [![Chaos Redux event options](docs/images/comparisons/source/event-chain-mcp.png)](docs/images/comparisons/source/event-chain-mcp.png) |

The [map guide](docs/map.md) covers connected province, state, supply and railway data.
The [event guide](docs/events.md) covers routes, scope, timing and unresolved references.

### Local rules and AI weights

> Find the installed documentation for `save_event_target_as`, read the relevant section, and show a vanilla usage with file and line references.

> Compare this decision's `ai_will_do` score before and after a change in peace and war. List missing conditions separately from known results.

The [reference example](docs/research/reference-benchmark.md) found the installed effect documentation first and read its relevant 12-line section instead of loading whole wiki pages.
The [AI guide](docs/probability.md) covers supported weights, chance and timing models; a source score alone does not establish an AI click probability.
The [examples guide](docs/examples.md) has more prompt details.

## Complete tool list

The default server exposes 35 tools.
Your agent can select them from ordinary language; use the live tool schema for call parameters.

| Tool                        | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `hoi4.focus_inspect`        | Read focus trees, continuous-focus placement, and structural or reference problems.                              |
| `hoi4.focus_render`         | Produce fast HTML, SVG, JSON, and source-linked layout artifacts.                                                |
| `hoi4.focus_raster`         | Produce a PNG preview with decoded source icons.                                                                 |
| `hoi4.focus_rewrite`        | Create or update a focus tree.                                                                                   |
| `hoi4.gui_inspect`          | Read a scripted GUI and its linked assets and logic.                                                             |
| `hoi4.gui_render`           | Render generated and explicit GUI scenarios, states, resolutions, and layout diagnostics.                        |
| `hoi4.gui_rewrite`          | Create or update a GUI source package.                                                                           |
| `hoi4.map_inspect`          | Search, click, navigate, and inspect the complete rendered map and its linked data.                              |
| `hoi4.map_render`           | Render full-map layers, overlays, names, IDs, coordinates, and source-linked catalogs.                           |
| `hoi4.map_rewrite`          | Create or update states, provinces, IDs, networks, positions, and connected map data.                            |
| `hoi4.reference_context`    | Get compact, cited wiki and installed documentation pointers for a modding surface.                              |
| `hoi4.reference_search`     | Search local documentation in plain words or script names; each result names its answering line.                 |
| `hoi4.reference_read`       | Read one revision-bound section, with line continuation.                                                         |
| `hoi4.source_lookup`        | Find exact definitions, overrides and usages across game, DLC and mod, or the definition containing a file line. |
| `hoi4.script_validate`      | Check snippet syntax, native command kinds, and declared scopes against local documentation.                     |
| `hoi4.event_inspect`        | Scan, trace, explain, lint, or assess event chains and their state flow.                                         |
| `hoi4.event_render`         | Render source-linked event routes, options, timing, state, scope, and unresolved edges.                          |
| `hoi4.event_compare`        | Compare event-chain topology and diagnostics between revisions.                                                  |
| `hoi4.impact_inspect`       | Trace symbol and changed-file consumers across source systems and compare proposals.                             |
| `hoi4.decision_inspect`     | Inventory and evaluate decisions or missions under declared scenarios and source changes.                        |
| `hoi4.mechanic_test`        | Execute bounded source effects on a copied declared scenario and check assertions.                               |
| `hoi4.package_check`        | Check declarative package definitions, calls, registrations, assets, and case links.                             |
| `hoi4.scenario_test`        | Run named source and domain cases in resumable, revision-bound batches.                                          |
| `hoi4.job_inspect`          | Inspect durable background work or retrieve its completed tool result.                                           |
| `hoi4.job_cancel`           | Durably request cancellation of authorized background work.                                                      |
| `hoi4.tech_inspect`         | Scan, trace, explain, lint, and assess technology and doctrine systems.                                          |
| `hoi4.tech_render`          | Render source layouts with real item sizes and year guides, plus dependencies and assets.                        |
| `hoi4.tech_compare`         | Compare technology graphs, placements, references, diagnostics, and source overlays.                             |
| `hoi4.probability_inspect`  | Locate weighted logic and discover compatible adapters, candidates, and required inputs.                         |
| `hoi4.probability_evaluate` | Evaluate supported weights, probability and timing models, and missing inputs.                                   |
| `hoi4.probability_sweep`    | Find sensitivity, breakpoints, cliffs, and rank reversals across declared ranges.                                |
| `hoi4.probability_simulate` | Run deterministic sampled analysis with confidence and convergence data.                                         |
| `hoi4.probability_sequence` | Analyze declared recovery, caps, cooldowns, resets, timers, and terminal states.                                 |
| `hoi4.probability_compare`  | Attribute AI-weight and MTTH changes between real or proposed source.                                            |
| `hoi4.probability_render`   | Render cached rankings, matrices, timing, sensitivity, sequence, and comparisons.                                |

Set `HOI4_AGENT_TOOLS_CHAOSX=1` to expose two optional Chaos Redux workflow tools: `chaosx.focus_country_assets` and `chaosx.visual_revision`.
The [tool guide](docs/tools.md) explains results, linked artifacts and long operations.

## How it fits your workflow

The server works through your coding agent and follows the mod workspace you provide.
It keeps large renders and reports in linked files, and retrieves relevant documentation sections instead of whole manuals.
Your repository instructions and review process still apply.

Inspection and rendering do not edit the mod.
The focus, GUI and map rewrite tools can change source files after checking the proposed edit.
The server does not launch or control the game; previews and source tests cannot prove live clicks, AI choices or engine timing.

[Documentation](docs/README.md) · [Tool reference](docs/tools.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Apache-2.0 licensed.
Hearts of Iron IV artwork belongs to its respective owners; this project is unaffiliated with Paradox Interactive.

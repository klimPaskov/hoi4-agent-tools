# HOI4 Agent Tools

Give your coding agent tools for Hearts of Iron IV modding.
Read mod files, find the right documentation, preview trees and interfaces, and make focused changes to focus trees, GUIs and maps.

## Get started

Install [Node.js](https://nodejs.org/) 22.19+ in the Node 22 line, or Node.js 24, then run:

```bash
npm install --global hoi4-agent-tools
hoi4-agent-tools-setup --print-client-config
```

Add the printed configuration to your MCP client and open your mod as its workspace.
Keep an installed copy of HOI4 available for vanilla examples, artwork and fonts.
The [setup guide](docs/setup.md) covers connecting your agent and choosing game or mod paths.

Then try:

> Render this mod's focus trees and show which prerequisites are alternatives.

> Find the installed documentation for `save_event_target_as`, read the relevant section, and show a vanilla example.

> Preview this scripted GUI at 100% and 125% UI scale and check for clipped text or overlapping controls.

## What you can do

| Task                                                                 | Guide                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Find the right wiki section, game documentation or source definition | [Local references](docs/reference.md)                                    |
| Inspect, preview, create or reorganize a focus tree                  | [Focus trees](docs/focus.md)                                             |
| Trace event chains, decisions, costs and dependencies                | [Events](docs/events.md) · [Decisions](docs/analysis.md)                 |
| Preview technology and doctrine trees                                | [Technology trees](docs/technology.md)                                   |
| Inspect and repair scripted interfaces                               | [Scripted GUIs](docs/gui.md)                                             |
| Find states and provinces, preview maps and edit connected map data  | [Maps](docs/map.md)                                                      |
| Compare AI weights and test declared mechanic scenarios              | [AI analysis](docs/probability.md) · [Mechanic tests](docs/mechanics.md) |

## Real examples

These previews were rendered from Chaos Redux and installed HOI4 files.
Click an image to open it at full size.

| Fury focus tree                                                                                  | Vanilla Options interface                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [![Fury focus tree](docs/images/comparisons/fury-mcp.png)](docs/images/comparisons/fury-mcp.png) | [![Options interface](docs/images/comparisons/gui/options-video-mcp.png)](docs/images/comparisons/gui/options-video-mcp.png) |

Follow the [examples guide](docs/examples.md) for useful prompts and expected results.
See [focus and technology comparisons](docs/visual-comparisons.md) and [interface comparisons](docs/gui-comparisons.md) for supplied in-game captures beside the renders.

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

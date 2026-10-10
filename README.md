# HOI4 Agent Tools

[![npm](https://img.shields.io/npm/v/hoi4-agent-tools)](https://www.npmjs.com/package/hoi4-agent-tools)
[![Node.js](https://img.shields.io/node/v/hoi4-agent-tools)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/hoi4-agent-tools)](LICENSE)

An [MCP](https://modelcontextprotocol.io/) server that lets a coding agent such as Claude Code, Codex or Cursor read, preview, analyse and safely edit a Hearts of Iron IV mod.
Your agent gets cited answers from the game's own documentation, pictures of focus trees, technology folders, interfaces and maps, and checks that catch load errors before you launch the game.

[![A large focus tree rendered from mod source](docs/images/comparisons/holy-realm-mcp.png)](docs/images/comparisons/holy-realm-mcp.png)

## What it does

| Area                   | Ask your agent, for example                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| Find the rule          | "Find the installed documentation for `save_event_target_as` and show a vanilla usage with file and line." |
| Check before launch    | "Check `events/my_events.txt` for scope errors, then group the last `error.log` by category."              |
| See the tree           | "Render this mod's largest focus tree and list focuses with missing icons."                                |
| Preview the window     | "Preview this scripted GUI at 100% and 125% UI scale and check for clipped text."                          |
| Read the map           | "Find Brandenburg, list its provinces and neighbours, and show the files a change would touch."            |
| Reshape the map        | "Split Brandenburg in two and update every event and focus that names it."                                 |
| Build a new world      | "Create a 2048x1024 world with six countries, then list what still needs hand-made content."               |
| Follow the events      | "Trace this event's options and follow-up events and point out unresolved calls."                          |
| Weigh the AI           | "Show the AI weights of event `my_mod.12`'s options, then compare them before and after my change."        |
| Plan new content       | "Give me the next free event ID in my namespace and summarize what the mod defines."                       |
| Edit with a safety net | "Add a new branch to this focus tree" — the edit is validated before anything is written.                  |

The server never launches the game.
Previews and tests are built from source files, so they show what the source says, not what a running campaign did.

## Quick start

1. Install [Node.js](https://nodejs.org/) 22 (22.19 or later) or 24, and keep Hearts of Iron IV installed for vanilla files, artwork and fonts.
2. Install the server:

   ```bash
   npm install --global hoi4-agent-tools
   ```

3. Print the client configuration:

   ```bash
   hoi4-agent-tools-setup --print-client-config
   ```

   Paste the `globalInstall` block into a JSON client such as Claude Code, Claude Desktop or Cursor, or the `codexTomlGlobal` block into Codex's `config.toml`.

4. Open your mod folder as the agent's workspace and try: "Render this mod's largest focus tree."

The [setup guide](docs/setup.md) covers several mods, explicit game paths, local wiki snapshots and troubleshooting with `--discover` and `--diagnose`.

## Examples

Each pair shows a capture from the game next to the server's preview of the same source.

| In game                                                                                                                                | Server preview                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [![Focus tree in game](docs/images/comparisons/fury-ingame.png)](docs/images/comparisons/fury-ingame.png)                              | [![Focus tree preview](docs/images/comparisons/fury-mcp.png)](docs/images/comparisons/fury-mcp.png)                              |
| [![Infantry technology folder in game](docs/images/comparisons/infantry-ingame.png)](docs/images/comparisons/infantry-ingame.png)      | [![Infantry technology folder preview](docs/images/comparisons/infantry-mcp.png)](docs/images/comparisons/infantry-mcp.png)      |
| [![Video options in game](docs/images/comparisons/gui/options-video-ingame.png)](docs/images/comparisons/gui/options-video-ingame.png) | [![Video options preview](docs/images/comparisons/gui/options-video-mcp.png)](docs/images/comparisons/gui/options-video-mcp.png) |

In focus previews, dotted lines mark alternative prerequisites: any one of them unlocks the focus.
The focus screen in the game has its own framing, labels and icons, and the video options preview has no observed gamma value.
More comparisons, with their source revisions and fidelity notes, are in the [focus and technology gallery](https://github.com/klimPaskov/hoi4-agent-tools/blob/main/docs/visual-comparisons.md), the [interface gallery](https://github.com/klimPaskov/hoi4-agent-tools/blob/main/docs/gui-comparisons.md) and the [examples guide](docs/examples.md), which also shows map and event renders.

## Tools

The default server has 28 tools.
Agents pick them from ordinary language, so you rarely need their names.

| Area                        | Tools                                                                                                                   | Writes                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| References and source       | `reference_context`, `reference_search`, `reference_read`, `source_lookup`, `script_validate`, `error_log`, `mod_index` | —                       |
| Focus trees                 | `focus_inspect`, `focus_render`, `focus_rewrite`                                                                        | review files; mod files |
| Scripted GUIs               | `gui_inspect`, `gui_render`, `gui_rewrite`                                                                              | review files; mod files |
| Maps                        | `map_inspect`, `map_rewrite`                                                                                            | review files; mod files |
| Events                      | `event_inspect`, `event_render`                                                                                         | —                       |
| Technology and doctrines    | `tech_inspect`, `tech_render`                                                                                           | —                       |
| AI weights and timing       | `probability_inspect`, `probability_analyze`                                                                            | —                       |
| Decisions, impact and tests | `impact_inspect`, `decision_inspect`, `mechanic_test`, `package_check`, `scenario_test`                                 | —                       |
| Background jobs             | `job_inspect`, `job_cancel`                                                                                             | job state               |

Every name starts with `hoi4.`.
"Review files" are images and reports in the server's own storage; only the three `*_rewrite` tools change mod files.
The [tool reference](docs/tools.md) gives each tool's purpose, prompts, resources and long-running behaviour.

## Safety and limits

- The server reads the mod, its dependencies, the installed game, local reference folders and the game's error log.
- Inspection and rendering never change mod files.
  The focus, GUI and map rewrite tools validate a proposed edit before writing it and write it as a journaled transaction, so an interrupted write is restored rather than left half-applied.
- Large renders and reports are stored as linked files, and documentation is returned as cited sections rather than whole manuals.
- The server does not launch or control the game.
  Previews and source tests cannot prove live clicks, AI choices or engine timing; a source score alone does not establish an AI click probability.
- Your repository instructions and review process still apply.

## Configuration

Started inside a mod folder, the server needs no configuration file.
`hoi4-agent-tools-setup --init` writes one when you work on several mods or the game is not found automatically.
For remote or shared use, `hoi4-agent-tools-http` serves the same tools over HTTP with tokens or OAuth.
See the [configuration reference](docs/configuration.md) and the [HTTP guide](docs/http.md).

## Documentation

- [Setup](docs/setup.md) and [configuration](docs/configuration.md)
- [Examples](docs/examples.md) and [tool reference](docs/tools.md)
- Guides: [local references](docs/reference.md), [focus trees](docs/focus.md), [scripted GUIs](docs/gui.md), [maps](docs/map.md), [events](docs/events.md), [technology](docs/technology.md), [AI weights and timing](docs/probability.md), [decisions and impact](docs/analysis.md), [mechanic and package tests](docs/mechanics.md)
- [Background jobs](docs/jobs.md) and [HTTP](docs/http.md)
- [Development](docs/development.md), [changelog](CHANGELOG.md) and [security policy](SECURITY.md)
- [Documentation index](docs/README.md)

## Development

```bash
npm ci
npm run check
```

See the [contributing guide](https://github.com/klimPaskov/hoi4-agent-tools/blob/main/CONTRIBUTING.md) and the [development guide](docs/development.md).

## License

Apache-2.0; see [LICENSE](LICENSE) and the [third-party notices](docs/third-party-notices.md).
Hearts of Iron IV artwork belongs to Paradox Interactive; this project is unaffiliated with Paradox Interactive.
The in-game captures were supplied for these comparisons.

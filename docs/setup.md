# Setup

You need a coding agent that supports MCP and Node.js 22 (22.19 or later) or Node.js 24.
Keep an installed copy of Hearts of Iron IV available for vanilla references, artwork and fonts.

## 1. Install

```bash
npm install --global hoi4-agent-tools
```

The package publishes an `npm-shrinkwrap.json`, so every registry or `npx` install receives the same reviewed dependency versions.
npm installs the image library's prebuilt binaries for every supported platform from it, about 280 MiB in total; the server loads only the one for your system.

Source inspection can work without an installed game.
Previews need the assets and fonts referenced by the mod; missing files are reported in the result.

## 2. Connect your agent

```bash
hoi4-agent-tools-setup --print-client-config
```

The command prints four alternatives:

| Key               | Use it for                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `globalInstall`   | JSON clients (Claude Code, Claude Desktop, Cursor and others), global install |
| `codexTomlGlobal` | Codex `config.toml`, global install                                           |
| `generic`         | JSON clients that should start a pinned version through `npx`                 |
| `codexToml`       | Codex `config.toml` through `npx`                                             |

Copy one of them into your MCP client; the printed command is correct for your platform.
The Codex entries also set `startup_timeout_sec = 120`, `tool_timeout_sec = 600` and an idle limit, because the first scan of a large mod and long renders exceed Codex's default timeouts.
The [client examples](../examples/clients) show the same entries without your paths.

Open the mod as your agent's workspace.

### How the server picks your mod

Every tool takes an optional `workspaceId`; the default, `"current"`, means the mod that contains the client's workspace root or, when the client sends no roots, the server's working directory.
With no configuration file, the server configures itself from that folder, so set the MCP process working directory to the mod if your client does not supply roots.
After `--init` writes a configuration file, every folder under its mod roots is a workspace, and the current mod is the one that contains the client root or working directory; when that matches no mod and several are configured, pass the mod's `workspaceId`.
The [configuration reference](configuration.md#how-the-server-picks-your-mod) gives the exact rules, the default file location, every key and the environment variables.
Indexes are kept in the server's state folder and generated images in workspace storage, both in your user data directory by default.

## 3. Try a small task

> Find the focus trees in this mod and render one of them.

> Find the installed documentation for `save_event_target_as` and read only the relevant section.

Continue with the [examples guide](examples.md).
Without a configuration file, the folder must look like a mod: it needs `descriptor.mod` or standard HOI4 content folders.

## Choose game and mod paths

Use explicit paths if automatic discovery cannot find the game, or if you want to configure several mods:

```bash
hoi4-agent-tools-setup --init --mod-root "/projects/hoi4-mods" --game-root "/games/Hearts of Iron IV"
hoi4-agent-tools-setup --print-client-config
```

`--mod-root` is a parent folder containing mod directories, not the game installation.
It can be repeated for several locations.
`--game-root` points to the installed game.
Use quoted Windows paths on Windows, for example `"C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV"`.

For a custom configuration location, add `--config PATH` to both setup commands.
`--workspace-storage-root PATH` chooses where generated images and rewrite transactions are saved.
Linked mod directories are not followed; configure their real parent directory instead.

### How sources are layered

Sources load in the engine's order: the base game, then each installed folder under `dlc/` and `integrated_dlc/` in order of its internal DLC ID, then dependencies, then the mod.
A later layer replaces a file with the same path from an earlier one, so a DLC's version of an interface file is the active one and the base game's copy is reported as shadowed.
Results name a DLC layer by its folder, for example `dlc023_man_the_guns:interface/mtg_leaders.gfx`.
Only folders that contain a `dlcNNN.dlc` descriptor and resolve inside the game root are layers; archives inside a DLC folder are not unpacked.
An installed DLC folder is not proof that the DLC is enabled in a particular playset; check `has_dlc` where content depends on it.
Set `"includeGameDlc": false` on a configured workspace to analyze the base game alone.

`replace_path` entries in a mod's or dependency's `descriptor.mod` unload earlier-loaded files under that folder, as the engine does, and join any `replacePaths` configured for the workspace.
Entries that are not plain relative folders, such as `../outside` or wildcard paths, are ignored.

## Add local reference material

Place an offline wiki snapshot in `paradox_wiki/` inside the mod.
An optional generated documentation dump can go in `script_docs/`.
For a configured workspace, `wikiRoot` and `scriptDocsRoot` can point to other absolute directories.
The server reads these local files; it does not download the wiki.
See [Local references](reference.md) for source selection and missing-source reports.

## Common problems

| Problem                             | Check                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The agent cannot find a mod         | Open the mod workspace, set the server working directory, or configure its real parent with `--mod-root`.                   |
| A render lacks icons or fonts       | Confirm `--game-root` and the mod's asset paths. Read the missing-file findings.                                            |
| A control's state is unresolved     | Supply the scenario's required country, state, controller or variable inputs; do not assume a visible control is available. |
| A large query takes several minutes | Start with the specific tree, window or source area you need. Use [background jobs](jobs.md) when supported by your client. |
| Idle server processes accumulate    | Set an idle limit as described in [Server lifetime](#server-lifetime).                                                      |
| The game reported errors at startup | Ask the agent to read them with `hoi4.error_log`; set `gameUserRoot` if the game's user folder is not found automatically.  |
| Startup or a tool call times out    | Raise the client's timeouts; the printed Codex entries allow 120 seconds for startup and 600 seconds per call.              |

Two setup commands help with path problems:

```bash
hoi4-agent-tools-setup --discover
hoi4-agent-tools-setup --diagnose
```

`--discover` prints the mod and game folders the server can detect, without writing anything.
`--diagnose` checks the configured paths and their permissions, the Node.js version and the image library, and accepts `--config PATH`.
`--help` lists every option.

For remote or shared deployments, use the [HTTP guide](http.md).

### A running game

This server reads source and never launches, controls or watches the game.
Pair it with a live-game MCP server, such as the separate HOI4 Live Tools project, for anything that needs the running game: launching and loading saves, the console, firing events, reading popups and the screen, playing time forward, and log deltas during a session.
Use this server to find and fix the source (`hoi4.error_log` maps last launch's errors to files and says which ones a relaunch removed), and the live server to reproduce and confirm in game.

### Server lifetime

A stdio server exits when its client closes stdin, and when the process that launched it, such as a `cmd.exe` shim, has exited and no request is still open.
Some clients start a server for every subagent and keep each connection open after the subagent finishes, so idle servers accumulate and each holds its own index in memory.
A server with no client traffic and no open request for `stdioIdleExitMinutes` minutes (0–10,080) exits.
That setting applies to every client sharing the server configuration, so prefer the `HOI4_AGENT_STDIO_IDLE_EXIT_MINUTES` environment variable in the affected client's registration; the Codex registrations printed by `hoi4-agent-tools-setup --print-client-config` set it to 30.
The variable takes a whole number from 0 to 10,080; an empty value uses the configuration, and any other value stops the server at startup with an error.
A client that later calls an exited server reports it as disconnected, so leave the limit at `0` (never) for a single long-lived session.
Over stdio, read the `hoi4-agent://server/status` resource to see every server process that shares the server state root, with its transport, memory, last client activity and the execution limits in effect. Records of exited processes are removed on read; a server that has not updated its record for five minutes is listed as stale.

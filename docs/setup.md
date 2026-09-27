# Setup

You need a coding agent that supports MCP and Node.js 22.19+ in the Node 22 line, or Node.js 24.
Keep an installed copy of Hearts of Iron IV available for vanilla references, artwork and fonts.

## 1. Install

```bash
npm install --global hoi4-agent-tools
```

Source inspection can work without an installed game.
Previews need the assets and fonts referenced by the mod; missing files are reported in the result.

## 2. Connect your agent

```bash
hoi4-agent-tools-setup --print-client-config
```

Copy the printed `globalInstall` configuration into your MCP client, or use `codexTomlGlobal` for a TOML-based Codex configuration.
The printed command is correct for your platform.

Open the mod as your agent's workspace.
If your client does not supply workspace roots, set the MCP process working directory to that mod folder.
The server can then select the active mod without a separate configuration file.
It keeps indexes and generated images in your user data directory.

## 3. Try a small task

> Find the focus trees in this mod and render one of them.

> Find the installed documentation for `save_event_target_as` and read only the relevant section.

Continue with the [examples guide](examples.md).
A mod normally has `descriptor.mod` or standard HOI4 content folders; an empty folder needs a descriptor or explicit configuration.

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
`--workspace-storage-root PATH` chooses where generated indexes and images are saved.
Linked mod directories are not followed; configure their real parent directory instead.

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

The supplied Codex registration allows 120 seconds for startup and 600 seconds per tool call.
For remote or shared deployments, use the [HTTP guide](http.md).

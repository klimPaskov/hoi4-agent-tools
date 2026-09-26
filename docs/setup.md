# Setup

For Codex, the supplied registration allows 120 seconds for startup and 600 seconds per tool call.
Large source scans and GUI renders can take several minutes; keep selectors and scenario matrices bounded and use negotiated task support when available.
`tool_timeout_sec` is the per-server tool deadline described in the [official configuration reference](https://developers.openai.com/ja-JP/docs/config-file/config-reference).

HOI4 Agent Tools requires Node.js 22.19 or later in the Node 22 line, or Node.js 24.

## Install

```bash
npm install --global hoi4-agent-tools
```

Set the MCP process working directory to the mod being edited. The server creates its local workspace in memory, keeps generated artifacts in the per-user data directory, and starts without a config file. The installed game is detected when available for vanilla references; it is not required for source inspection or offline rendering.

When the MCP server starts with its working directory inside a mod, every focus, GUI, map, event, and technology call uses that mod automatically. Configured multi-mod or remote deployments can use explicit workspace selection.

Local startup accepts normal descriptor-based mods and sparse descriptor-less mods that contain standard HOI4 content folders. Empty roots need a `descriptor.mod` or an explicit configuration so the server does not guess an unrelated directory.

## Optional persistent configuration

Use `--init` only when you need several mod roots, a fixed game path, or a shared/remote process:

### Configure explicit paths

Use explicit paths when discovery is incomplete or when you want to expose more than one mod root:

```bash
hoi4-agent-tools-setup --init --mod-root /projects/hoi4-mods --mod-root /workshop/hoi4-mods --game-root "/games/Hearts of Iron IV" --workspace-storage-root /var/lib/hoi4-agent-tools
```

- `--mod-root PATH` adds a parent folder containing mods. Repeat it for additional locations.
- `--game-root PATH` selects the installed game folder used for vanilla references.
- `--workspace-storage-root PATH` selects where indexes, renders, and other generated workspace files are stored.
- `--config PATH` writes or reads a config at a custom path instead of the default per-user location.

The corresponding config fields are `modRoots`, `gameRoot`, and `workspaceStorageRoot`.

For a configured workspace, `wikiRoot` can select an absolute path to an offline Paradox Wiki snapshot and `scriptDocsRoot` can select an absolute path to a user-supplied generated documentation dump. Without these fields, the reference tools look for `paradox_wiki/` and `script_docs/` inside the mod. See [Local references](reference.md).

Linked directory entries are not followed. If a mod folder is a symlink or junction, configure the real parent directory as another `--mod-root`.

## MCP client registration

```bash
hoi4-agent-tools-setup --print-client-config
```

Use the printed `globalInstall` or `codexTomlGlobal` entry. It is platform-correct and uses the default config without an environment variable. For a custom config, add `--config PATH` when printing the registration.

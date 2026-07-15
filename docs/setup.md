# Setup

HOI4 Agent Tools requires Node.js 22 or 24.

## Install

```bash
npm install --global hoi4-agent-tools
```

Set the MCP process working directory to the mod being edited. The server creates its local workspace in memory, keeps generated artifacts in the per-user data directory, and starts without a config file. The installed game is detected when available for vanilla references; it is not required for source inspection or offline rendering.

When the MCP server starts with its working directory inside a mod, every focus, GUI, map, and event call uses that mod automatically. Omit `workspaceId`. Explicit `workspaceId` values remain available for configured multi-mod or remote deployments.

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

Linked directory entries are not followed. If a mod folder is a symlink or junction, configure the real parent directory as another `--mod-root`.

## MCP client registration

```bash
hoi4-agent-tools-setup --print-client-config
```

Use the printed `globalInstall` or `codexTomlGlobal` entry. It is platform-correct and uses the default config without an environment variable. For a custom config, add `--config PATH` when printing the registration.

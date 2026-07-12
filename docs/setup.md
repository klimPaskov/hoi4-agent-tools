# Setup

HOI4 Agent Tools requires Node.js 22 or 24.

## Install and initialize

```bash
npm install --global hoi4-agent-tools@1.1.0
hoi4-agent-tools-setup --init
```

The setup command discovers standard HOI4 game and mod locations, creates a separate storage folder for generated workspace data, and writes the default per-user config. Each configured mod root is a parent folder whose immediate child directories are individual mods. Every discovered mod is writable through the three rewrite tools; no per-mod write switch or approval step is required. The installed game remains reference-only.

After connecting the MCP server, call `hoi4.mods` to confirm which mods are available.

## Override discovered paths

Use explicit paths when discovery is incomplete or when you want to expose more than one mod root:

```bash
hoi4-agent-tools-setup --init --mod-root /projects/hoi4-mods --mod-root /workshop/hoi4-mods --game-root "/games/Hearts of Iron IV" --workspace-storage-root /var/lib/hoi4-agent-tools
```

- `--mod-root PATH` adds a parent folder containing mods. Repeat it for additional locations.
- `--game-root PATH` selects the installed game folder used as a read-only reference.
- `--workspace-storage-root PATH` selects where indexes, renders, and other generated workspace files are stored.
- `--config PATH` writes or reads a config at a custom path instead of the default per-user location.

The corresponding config fields are `modRoots`, `gameRoot`, and `workspaceStorageRoot`.

Linked directory entries are not followed. If a mod folder is a symlink or junction, configure the real parent directory as another `--mod-root`.

## MCP client registration

```bash
hoi4-agent-tools-setup --print-client-config
```

Use the printed `globalInstall` or `codexTomlGlobal` entry. It is platform-correct and uses the default config without an environment variable. For a custom config, add `--config PATH` when printing the registration.

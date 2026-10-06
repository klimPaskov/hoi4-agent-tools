# Configuration

Most users need no configuration file: start the server inside a mod folder and it configures itself for that mod.
When you want fixed game and mod paths or several mods, `hoi4-agent-tools-setup --init` writes a file for you, as described in [Setup](setup.md).

## Where the file lives

The server reads one JSON file, chosen in this order:

1. the path after `--config`, for example `hoi4-agent-tools --config /srv/hoi4/config.json`;
2. the path in the `HOI4_AGENT_CONFIG` environment variable;
3. the default path for your system.

| System          | Default configuration path                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Windows         | `%APPDATA%\hoi4-agent-tools\config.json`                                                                                     |
| Linux and macOS | `$XDG_CONFIG_HOME/hoi4-agent-tools/config.json`, or `~/.config/hoi4-agent-tools/config.json` when `XDG_CONFIG_HOME` is unset |

`APPDATA` takes precedence over `XDG_CONFIG_HOME` when both are set.

The server builds an automatic configuration only when all of these hold: `HOI4_AGENT_CONFIG` is unset, `--config` is absent or names the default path, and no file exists at the default path.
In every other case a missing or unreadable file stops startup with `CONFIG_READ_FAILED`, and a file that fails validation stops it with `CONFIG_INVALID`.

The automatic configuration works like this:

- Starting from the server's working directory and moving up through its parents, the server takes the first folder that looks like a mod: it has `descriptor.mod`, a standard `common/` subfolder such as `common/national_focus`, or a standard content folder such as `events/` or `localisation/` with matching files.
  The search stops at a game installation (a folder with `hoi4.exe`, `run_hoi4` or `steam_appid.txt`), and startup fails with `AUTO_MOD_ROOT_NOT_FOUND` when nothing is found.
- That folder becomes the only workspace, with the ID `auto_<folder name>`.
- The game folder is the first existing folder among `HOI4_GAME_ROOT` and the standard Steam locations on Windows, Linux and macOS.
- Server state and generated files use the default storage locations below.

| Storage                | Default location                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverStateRoot`      | `$XDG_STATE_HOME/hoi4-agent-tools/state`, else `%LOCALAPPDATA%\hoi4-agent-tools\state`, else `~/.local/state/hoi4-agent-tools/state`               |
| `workspaceStorageRoot` | `$XDG_DATA_HOME/hoi4-agent-tools/workspaces`, else `%LOCALAPPDATA%\hoi4-agent-tools\workspaces`, else `~/.local/share/hoi4-agent-tools/workspaces` |

`hoi4-agent-tools-setup --init` writes these same two locations into the file it creates.
A hand-written file has no storage defaults: set `serverStateRoot` yourself, and leave out `workspaceStorageRoot` only if generated files may live inside each mod.

What each location holds:

- `serverStateRoot` holds the persistent index and parsed-source cache (`analysis-cache/`), background jobs (`jobs/`, `job-workers/`), the records of running server processes (`servers/`) and the key that authenticates rewrite journals.
- `workspaceStorageRoot` holds one folder per workspace ID, with `artifacts/` for rendered images and other generated results and `cache/` for rewrite transactions and locks.
- Without `workspaceStorageRoot`, a mod workspace keeps these in `.hoi4-agent/artifacts` and `.hoi4-agent/cache` inside the mod folder.

## A minimal file

```json
{
  "version": 1,
  "serverStateRoot": "D:/hoi4-agent-tools/state",
  "modRoots": ["D:/hoi4-mods"],
  "gameRoot": "C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV",
  "workspaceStorageRoot": "D:/hoi4-agent-tools/workspaces"
}
```

Every subfolder of a `modRoots` entry becomes a mod workspace, and every key not shown takes its default.
Unknown keys are rejected at every level, so a misspelled key stops startup instead of being ignored.
The full machine-readable definition is the [configuration JSON schema](../schemas/configuration.schema.json), and [config.json](../examples/config/config.json) is the same example with Linux paths.

## How the server picks your mod

Every tool takes a `workspaceId` argument, which defaults to `"current"`.

For `"current"`, the server asks the MCP client for its workspace roots when the client supports them:

- It selects the one mod workspace that contains a client root or lies inside one.
- No match fails with `WORKSPACE_CONTEXT_NOT_FOUND`, and more than one match fails with `WORKSPACE_CONTEXT_AMBIGUOUS`.

When the client does not supply roots, the server uses its own working directory:

- It selects the one mod workspace that contains the working directory.
- If the working directory is in no mod and exactly one mod workspace exists, it selects that mod.
- If the working directory is in no mod and several mod workspaces exist, the call fails with `WORKSPACE_CONTEXT_REQUIRED`, and the error lists the available workspace IDs.
- With no mod workspace at all, the call fails with `WORKSPACE_CONTEXT_NOT_FOUND`.

When a tool reads a named source file with `"current"` and the selected mod lacks that file, the server uses the one other mod that has it, and fails with `WORKSPACE_SOURCE_AMBIGUOUS` if several do.

To choose a mod explicitly, pass its workspace ID.
A configured workspace keeps the `id` you gave it.
A mod found under `modRoots` gets an ID of the form `mod_<folder name>_<12 hex characters>`.
For a mod workspace, the server also accepts a short form: the mod's folder name or workspace name in lower case with other characters replaced by `_`, optionally prefixed with `auto_` or `mod_`.
A `mod_<folder name>_<hash>` ID whose hash no longer matches resolves by its folder name in the same way.
A short form that matches several mods fails with `WORKSPACE_CONTEXT_AMBIGUOUS`, and an unknown ID fails with `WORKSPACE_NOT_REGISTERED`.
Over HTTP, a principal sees only the workspaces granted to it, and any other ID fails with `WORKSPACE_INACCESSIBLE`.

## Paths

| Key                    | Type             | Range       | Default | Purpose                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`              | number           | `1`         | none    | Configuration format version; required.                                                                                                                                                                                                                                                                                           |
| `serverStateRoot`      | absolute path    |             | unset   | Private folder for indexes, jobs and server records. Required whenever `modRoots` or a `mod` workspace is configured.                                                                                                                                                                                                             |
| `modRoots`             | array of paths   | up to 16    | `[]`    | Parent folders whose direct subfolders each become a writable mod workspace. Hidden and linked subfolders are skipped, and a subfolder already registered under `workspaces` keeps that registration.                                                                                                                             |
| `gameRoot`             | path             |             | unset   | The installed game, used by every `mod` workspace that sets no `gameRoot` of its own.                                                                                                                                                                                                                                             |
| `gameUserRoot`         | path             |             | unset   | The game's user-data folder holding `logs/error.log`, read by `hoi4.error_log`. When unset, the server tries the folder containing a mod's parent `mod/` folder, then `Documents/Paradox Interactive/Hearts of Iron IV` (also under `%OneDrive%` on Windows), or `~/.local/share/Paradox Interactive/Hearts of Iron IV` on Linux. |
| `workspaceStorageRoot` | path             |             | unset   | Base folder for generated files: each workspace stores `artifacts/` and `cache/` in `<workspaceStorageRoot>/<workspace ID>/`. When unset, mods use `.hoi4-agent/` inside the mod.                                                                                                                                                 |
| `storageRoots`         | array of paths   | up to 16    | `[]`    | Additional folders in which an explicit `artifactRoot` or `cacheRoot` may be placed.                                                                                                                                                                                                                                              |
| `workspaces`           | array of objects | up to 1,000 | `[]`    | Explicit workspace registrations, described in the next section.                                                                                                                                                                                                                                                                  |

## Workspaces

Each entry in `workspaces` registers one source folder.

| Key               | Type                        | Range                                          | Default                        | Purpose                                                                                                                                                                            |
| ----------------- | --------------------------- | ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string                      | lower-case letter, then up to 63 of `a-z0-9_-` | none                           | Workspace ID used in tool calls and grants; required. `current` is reserved.                                                                                                       |
| `name`            | string                      | 1–200 characters                               | none                           | Display name; required.                                                                                                                                                            |
| `root`            | path                        |                                                | none                           | The workspace folder; required and must exist.                                                                                                                                     |
| `kind`            | `mod`, `game`, `dependency` |                                                | `mod`                          | `mod` is writable source. `game` registers an installed game as read-only source with its DLC layered after it. `dependency` is read-only source.                                  |
| `gameRoot`        | path                        |                                                | top-level `gameRoot` for `mod` | The installed game loaded beneath this workspace.                                                                                                                                  |
| `includeGameDlc`  | boolean                     |                                                | `true`                         | Layer the game's `dlc/` and `integrated_dlc/` folders between the game and the mod. Set `false` to analyze the base game alone.                                                    |
| `dependencyRoots` | array of paths              | up to 16                                       | `[]`                           | Read-only mods loaded after the game and DLC and before this workspace, in list order.                                                                                             |
| `dependencies`    | array of objects            | up to 16                                       | `[]`                           | The same as `dependencyRoots`, with a `replacePaths` list per dependency: `{ "root": "...", "replacePaths": ["..."] }`. Use either this or `dependencyRoots`, not both.            |
| `replacePaths`    | array of relative paths     | up to 1,000                                    | `[]`                           | Folders whose earlier-loaded files this workspace unloads, as `replace_path` does. Entries from the folder's `descriptor.mod` are added automatically. Ignored for `kind: "game"`. |
| `wikiRoot`        | absolute path               |                                                | `paradox_wiki/` in the mod     | Folder of the offline wiki snapshot used by the reference tools.                                                                                                                   |
| `scriptDocsRoot`  | absolute path               |                                                | `script_docs/` in the mod      | Folder of a generated script documentation dump used by the reference tools.                                                                                                       |
| `roots`           | object                      |                                                | see below                      | Folders, relative to each source layer, that the domain tools scan.                                                                                                                |
| `artifactRoot`    | path                        |                                                | see below                      | Where rendered images and other generated results are stored.                                                                                                                      |
| `cacheRoot`       | path                        |                                                | see below                      | Where rewrite transactions and locks are stored.                                                                                                                                   |
| `fixtureRoot`     | path                        |                                                | unset                          | A read-only folder of extra source files scanned with the workspace at the base game's load position and treated as workspace-owned source.                                        |

`artifactRoot` and `cacheRoot` default to `<workspaceStorageRoot>/<id>/artifacts` and `<workspaceStorageRoot>/<id>/cache`, or, without `workspaceStorageRoot`, to `.hoi4-agent/artifacts` and `.hoi4-agent/cache` inside a `mod` workspace.
A `game` or `dependency` workspace needs both, either explicitly or through `workspaceStorageRoot`.

Relative paths in `replacePaths` and `roots` must be plain relative folders of up to 1,024 characters: no leading `/`, drive letter, `:`, `..` segment or wildcard character (`* ? [ ] { } !`).

| `roots` key    | Default                                   | Scanned for                   |
| -------------- | ----------------------------------------- | ----------------------------- |
| `localisation` | `["localisation", "localisation_synced"]` | Localisation files            |
| `interface`    | `["interface"]`                           | `.gui` and `.gfx` files       |
| `gfx`          | `["gfx"]`                                 | Sprite definitions and images |
| `map`          | `["map"]`                                 | Map data                      |
| `focus`        | `["common/national_focus"]`               | National focus trees          |
| `scriptedGui`  | `["common/scripted_guis"]`                | Scripted GUI definitions      |
| `states`       | `["history/states"]`                      | State history                 |

Each `roots` key takes up to 16 folders, and setting `roots` replaces only the keys you list.

## Scan and storage limits

| Key                      | Type    | Range          | Default               | Purpose                                                                                                                                                      |
| ------------------------ | ------- | -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scanMaxFiles`           | integer | 1–1,000,000    | 100,000               | Most files one source scan may enumerate across all layers; more fails with `SCAN_FILE_LIMIT`.                                                               |
| `scanMaxBytes`           | integer | 1 MiB or more  | 268,435,456 (256 MiB) | Most bytes one source scan may read; more fails with `SCAN_BYTE_LIMIT`.                                                                                      |
| `scanMaxFileBytes`       | integer | 64 KiB or more | 67,108,864 (64 MiB)   | Largest single file a scan may read.                                                                                                                         |
| `artifactMaxBytes`       | integer | 1 MiB or more  | 536,870,912 (512 MiB) | Total size of one workspace's artifact store. When a new artifact would exceed it, older unpinned artifacts are removed down to three quarters of the limit. |
| `artifactMaxEntries`     | integer | 1–100,000      | 5,000                 | Number of artifacts one workspace keeps, pruned the same way.                                                                                                |
| `artifactMaxSingleBytes` | integer | 1 MiB or more  | 134,217,728 (128 MiB) | Largest single artifact.                                                                                                                                     |

## Tools, jobs and lifetime

| Key                     | Type    | Range      | Default | Purpose                                                                                                                                                               |
| ----------------------- | ------- | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentTools`    | integer | 1–32       | 2       | Expensive tool calls one server process runs at once.                                                                                                                 |
| `maxSharedTools`        | integer | 1–128      | 4       | Expensive calls and job workers that run at once across every server process sharing the same `serverStateRoot`.                                                      |
| `jobDeadlineSeconds`    | integer | 1–86,400   | 1,800   | A read-only job still running this long after dispatch is stopped and fails with `JOB_DEADLINE_EXCEEDED`. Rewrite jobs are never stopped this way.                    |
| `jobCancelGraceSeconds` | integer | 1–600      | 10      | A read-only job still running this long after cancellation is stopped and settles as cancelled.                                                                       |
| `jobWorkerMaxHeapMiB`   | integer | 256–65,536 | unset   | Memory ceiling for each job worker's JavaScript heap, in MiB. Unset keeps Node's default.                                                                             |
| `stdioIdleExitMinutes`  | integer | 0–10,080   | 0       | A stdio server with no client traffic and no open request for this many minutes exits. `0` never exits. `HOI4_AGENT_STDIO_IDLE_EXIT_MINUTES` overrides it per client. |

See [Persistent jobs and MCP tasks](jobs.md) for how jobs, cancellation and recovery behave.

## HTTP

These keys sit inside the `http` object and are used only by `hoi4-agent-tools-http`.

| Key                           | Type                  | Range              | Default             | Purpose                                                                                                                                                                                      |
| ----------------------------- | --------------------- | ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                        | string                |                    | `127.0.0.1`         | Listening address, also accepted in the `Host` header. Anything other than `127.0.0.1`, `localhost` or `::1` counts as public.                                                               |
| `port`                        | integer               | 0–65535            | 3210                | Listening port; `0` lets the system choose one.                                                                                                                                              |
| `publicUrl`                   | URL                   |                    | unset               | The address clients use: an HTTP(S) origin or its exact `/mcp` endpoint, without credentials, query or fragment. Its host name is also accepted in the `Host` header. Required with `oauth`. |
| `allowedOrigins`              | array of URLs         |                    | `[]`                | Exact browser origins allowed to call the server. A request carrying any other `Origin` header is refused.                                                                                   |
| `trustedProxyAddresses`       | array of IP addresses |                    | `[]`                | Reverse proxies whose `X-Forwarded-For` header identifies the real client for rate limiting.                                                                                                 |
| `tokens`                      | array of objects      | up to 1,000        | `[]`                | Static bearer tokens for loopback use; see below.                                                                                                                                            |
| `principals`                  | array of objects      | up to 1,000        | `[]`                | OAuth subjects allowed to connect; see below.                                                                                                                                                |
| `oauth`                       | object                |                    | unset               | OAuth or OpenID Connect token verification; see below.                                                                                                                                       |
| `maxBodyBytes`                | integer               | 1,024–67,108,864   | 67,108,864 (64 MiB) | Largest request body.                                                                                                                                                                        |
| `headersTimeoutMs`            | integer               | 1,000–120,000      | 10,000              | Time allowed to receive request headers.                                                                                                                                                     |
| `requestTimeoutMs`            | integer               | 1,000–300,000      | 30,000              | Time allowed to receive a complete request.                                                                                                                                                  |
| `keepAliveTimeoutMs`          | integer               | 1,000–120,000      | 5,000               | How long an idle connection stays open.                                                                                                                                                      |
| `maxConnections`              | integer               | 1–100,000          | 512                 | Open connections.                                                                                                                                                                            |
| `maxRequestsPerSocket`        | integer               | 1–100,000          | 100                 | Requests served on one connection before it closes.                                                                                                                                          |
| `maxConcurrentRequests`       | integer               | 1–1,024            | 128                 | Requests handled at once. Up to 16 more small requests, such as cancellations, are still admitted when it is full.                                                                           |
| `maxSessions`                 | integer               | 1–10,000           | 128                 | Open MCP sessions.                                                                                                                                                                           |
| `maxSessionsPerPrincipal`     | integer               | 1–10,000           | 32                  | Open MCP sessions per principal.                                                                                                                                                             |
| `maxEventStreams`             | integer               | 1–10,000           | 128                 | Open server-to-client event streams.                                                                                                                                                         |
| `maxEventStreamsPerPrincipal` | integer               | 1–10,000           | 32                  | Open event streams per principal.                                                                                                                                                            |
| `maxSessionEventBytes`        | integer               | 65,536–67,108,864  | 2,097,152 (2 MiB)   | Resumable event history kept for one session.                                                                                                                                                |
| `maxEventStoreBytes`          | integer               | 65,536–268,435,456 | 16,777,216 (16 MiB) | Resumable event history kept for all sessions together.                                                                                                                                      |
| `requestsPerMinute`           | integer               | 1–100,000          | 6,000               | Requests per minute from one client address before authentication, and again per principal after it.                                                                                         |
| `sessionTtlSeconds`           | integer               | 60–86,400          | 3,600               | An idle session with no active request expires after this many seconds. A session never outlives its credential.                                                                             |

Each `tokens` entry:

| Key                   | Type             | Range                                        | Default | Purpose                                                                                       |
| --------------------- | ---------------- | -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `principal`           | string           | 1–128 of `A-Z a-z 0-9 . _ @ -`               | none    | Name of the client; required.                                                                 |
| `tokenEnv`            | string           | upper-case letter, then 1–127 of `A-Z 0-9 _` | none    | Environment variable holding the secret; required. The secret must be at least 32 characters. |
| `workspaceIds`        | array of strings | up to 1,000                                  | `[]`    | IDs of configured `workspaces` this client may use.                                           |
| `allowDiscoveredMods` | boolean          |                                              | `false` | Also grant every mod found under `modRoots`.                                                  |

A static token always carries both the `hoi4:read` and `hoi4:write` scopes, so it can also run rewrite tools.

Each `principals` entry:

| Key                   | Type             | Range                            | Default | Purpose                                              |
| --------------------- | ---------------- | -------------------------------- | ------- | ---------------------------------------------------- |
| `principal`           | string           | 1–256 of `A-Z a-z 0-9 . _ @ : -` | none    | The token subject (`sub` claim) to allow; required.  |
| `workspaceIds`        | array of strings | up to 1,000                      | `[]`    | IDs of configured `workspaces` this subject may use. |
| `allowDiscoveredMods` | boolean          |                                  | `false` | Also grant every mod found under `modRoots`.         |

The `oauth` object:

| Key                    | Type             | Range                                                         | Default         | Purpose                                                                        |
| ---------------------- | ---------------- | ------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `issuer`               | URL              |                                                               | none            | Expected `iss` claim; required.                                                |
| `jwksUri`              | URL              |                                                               | none            | Where the signing keys are fetched; required.                                  |
| `audience`             | string           | 1 character or more                                           | none            | Expected `aud` claim; required.                                                |
| `authorizationServers` | array of URLs    | 1 or more                                                     | none            | Authorization servers advertised in the protected resource metadata; required. |
| `requiredScopes`       | array of strings |                                                               | `["hoi4:read"]` | Scopes every request needs. Rewrite tools also need `hoi4:write`.              |
| `algorithms`           | array            | `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, `EdDSA` | `["RS256"]`     | Accepted token signature algorithms.                                           |

An OAuth principal receives exactly the scopes in its token, and a token must carry an expiry.
With `oauth` and `publicUrl` set, the server publishes protected resource metadata at `/.well-known/oauth-protected-resource/mcp`.

## Rules checked at startup

The server refuses to start when the file breaks any of these rules.

File contents:

- `version` is `1`, and no level contains an unknown key.
- `serverStateRoot` is an absolute path, and it is set whenever `modRoots` is non-empty or any workspace has `kind: "mod"`.
- `scanMaxFileBytes` is not larger than `scanMaxBytes`, and `artifactMaxSingleBytes` is not larger than `artifactMaxBytes`.
- `http.maxSessionEventBytes` is not larger than `http.maxEventStoreBytes`.
- `http.headersTimeoutMs` is not longer than `http.requestTimeoutMs`, and `http.keepAliveTimeoutMs` is shorter than `http.headersTimeoutMs`.
- A workspace uses `dependencyRoots` or `dependencies`, not both.
- Workspace IDs are unique, and no workspace uses the ID `current`.
- `http.oauth` and `http.tokens` are not both set.
- Token principals are unique, token environment variable names are unique, OAuth principals are unique, and no name appears both as a token principal and as an OAuth principal.
- Every `workspaceIds` entry in `tokens` and `principals` names a workspace listed under `workspaces`.

Folders:

- Every `modRoots` entry is an existing real folder, not a link, and no two of them overlap.
- `workspaceStorageRoot` does not overlap any `modRoots` entry.
- `serverStateRoot` does not overlap any mod, game, dependency, fixture, wiki, documentation, storage, artifact or cache folder.
- Each workspace's `root`, `gameRoot`, dependency folders and `fixtureRoot` exist, and its game, dependency and fixture folders neither overlap each other nor the workspace folder.
- `artifactRoot` and `cacheRoot` lie inside the mod's own `.hoi4-agent/artifacts` and `.hoi4-agent/cache` folders, `workspaceStorageRoot` or a `storageRoots` entry; they do not overlap each other or any source folder.
- A workspace's own folders do not overlap another workspace's folders, and its read-only folders do not overlap another workspace's mod, artifact or cache folder.
- At most 1,000 workspaces exist in total, counting mods found under `modRoots`, and a game folder lists at most 256 DLC folders.

HTTP server only:

- `http.tokens` or `http.oauth` is configured.
- With `oauth`, `publicUrl` is set and `principals` is not empty.
- Every static token's environment variable holds at least 32 characters, and no two tokens share a secret.
- When the server is public, because `host` or the `publicUrl` host is not `127.0.0.1`, `localhost` or `::1`, it must use `oauth`, `publicUrl` must use HTTPS, the issuer, signing-key and authorization server URLs must use HTTPS, and `allowedOrigins` must not be empty.

## Environment variables

| Variable                                             | Read by                                                                                     | Purpose                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOI4_AGENT_CONFIG`                                  | `hoi4-agent-tools`, `hoi4-agent-tools-http`, setup `--diagnose` and `--print-client-config` | Configuration file path when `--config` is not given. `--init` writes to `--config` or the default path and ignores this variable.                                                        |
| `HOI4_GAME_ROOT`                                     | automatic configuration, setup `--init` and `--discover`                                    | First game folder to try, before the standard Steam locations.                                                                                                                            |
| `HOI4_MOD_ROOTS`                                     | setup `--init` and `--discover`                                                             | Extra mod parent folders to discover, separated by `;` on Windows and `:` elsewhere. `--init` uses discovered folders only when no `--mod-root` is given.                                 |
| `HOI4_AGENT_STDIO_IDLE_EXIT_MINUTES`                 | `hoi4-agent-tools`                                                                          | Overrides `stdioIdleExitMinutes` for one client registration. It must be a whole number from 0 to 10,080; an empty value keeps the configured setting, and any other value stops startup. |
| `HOI4_AGENT_TOOLS_CHAOSX`                            | `hoi4-agent-tools`                                                                          | `1` exposes the optional Chaos Redux workflow tools listed in [Tools](tools.md). The HTTP server never exposes them.                                                                      |
| the variable named by `tokenEnv`                     | `hoi4-agent-tools-http`                                                                     | Secret for a static bearer token, at least 32 characters.                                                                                                                                 |
| `APPDATA`, `XDG_CONFIG_HOME`                         | every command                                                                               | Location of the default configuration file.                                                                                                                                               |
| `XDG_STATE_HOME`, `XDG_DATA_HOME`, `LOCALAPPDATA`    | automatic configuration, setup `--init`                                                     | Default `serverStateRoot` and `workspaceStorageRoot`.                                                                                                                                     |
| `ProgramFiles(x86)`                                  | automatic configuration, setup `--init` and `--discover`                                    | Base of the standard Windows Steam location.                                                                                                                                              |
| `OneDrive`, `OneDriveConsumer`, `OneDriveCommercial` | setup `--init` and `--discover`; `OneDrive` also `hoi4.error_log`                           | Additional `Documents` folders searched for mods and, for `OneDrive`, for the game's user-data folder.                                                                                    |

## Related

- [Setup](setup.md) for installation, client registration and `hoi4-agent-tools-setup`.
- [HTTP](http.md) for loopback and remote deployments.
- [Persistent jobs and MCP tasks](jobs.md) for background work, cancellation and retention.

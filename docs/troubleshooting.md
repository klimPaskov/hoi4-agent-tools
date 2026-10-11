# Troubleshooting

Start with the message: every failed call returns a tool error whose text names the code, what went wrong and what to do next.
This page lists the codes you are most likely to meet, then the checks for problems that have no code.

## Setup and connection

| Symptom                                                     | Cause and fix                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client lists no `hoi4.*` tools                          | The server did not start. Run `hoi4-agent-tools-setup --diagnose`, which checks the Node.js version (22.19 or newer, or 24), the image library and the configured paths. Then restart the client.   |
| `WORKSPACE_CONTEXT_NOT_FOUND`                               | The server does not know which mod you mean. Open the mod folder as the client's working directory, or configure it with `--mod-root` or a workspace in the [configuration file](configuration.md). |
| `WORKSPACE_CONTEXT_AMBIGUOUS`                               | The working directory is inside more than one configured mod. Pass `workspaceId`, or open the one folder you mean.                                                                                  |
| `WORKSPACE_NOT_REGISTERED`                                  | The `workspaceId` is not in the configuration. Use `"current"`, or a workspace id from the configuration file.                                                                                      |
| Renders lack icons or fonts, native commands are unresolved | The game folder is not configured. Set `--game-root` (or `gameRoot`) to the Hearts of Iron IV folder; `hoi4-agent-tools-setup --discover` prints the folders it can find.                           |
| `ERROR_LOG_NOT_FOUND`                                       | Launch the game once, or set `gameUserRoot` to the folder that holds `logs/`, `mod/` and `save games/` (with OneDrive that is often under `OneDrive\Documents`).                                    |
| `AUTH_INVALID` over HTTP                                    | The bearer token is missing, expired or for another server. See the [HTTP guide](http.md).                                                                                                          |
| Startup or a call times out in the client                   | A cold scan of a large mod takes minutes. Raise the client's startup and tool timeouts (the printed Codex entries use 120 and 600 seconds), or use [background jobs](jobs.md).                      |
| Many idle `node` processes                                  | Some clients keep a server per subagent. Set `HOI4_AGENT_STDIO_IDLE_EXIT_MINUTES`; see [Server lifetime](setup.md#server-lifetime).                                                                 |

## Arguments and results

| Code or symptom                         | Cause and fix                                                                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENTS`                     | The call does not match the tool's schema. The error names each failing field, what it expected and a working call; copy that example, or see [Example calls](tools.md#example-calls).                   |
| `valid: null` from `script_validate`    | Nothing is wrong that the checker could prove, but some commands, argument blocks or scopes were not checked. Read `unresolvedCount` and the unresolved findings; `null` is not a pass.                  |
| `MCP_RESPONSE_TRUNCATED`                | The inline result exceeded its 32 KB budget. The omitted detail is in the linked artifacts (see `artifacts` in the structured content); narrow the selector for a smaller answer.                        |
| `SCAN_SOURCE_CHANGED`                   | A file changed while it was being read. Repeat the call; if it keeps happening, stop the tool or editor that is rewriting the file.                                                                      |
| `SCAN_BYTE_LIMIT`, `SCAN_PATTERN_LIMIT` | The request reads more source than the configured limits allow. Ask for the specific tree, window or folder, or raise the limits in [Scan and storage limits](configuration.md#scan-and-storage-limits). |
| `REFERENCE_REVISION_STALE`              | A documentation file changed after the search. Search again and read with the new `id` and `revision`.                                                                                                   |
| `REFERENCE_RESPONSE_TOO_LARGE`          | The citation bundle is too large for one reply. Lower `limit` or search a specific source.                                                                                                               |
| `ARTIFACT_NOT_FOUND`                    | The artifact left the server's bounded store. Run the tool again; archive images you need to keep.                                                                                                       |
| `JOB_DEADLINE_EXCEEDED`                 | A long job ran past `jobDeadlineSeconds` and was stopped. Narrow it, or raise the limit in the configuration.                                                                                            |
| `JOB_STORE_BUSY`                        | A crashed server process still holds the job store lock. Wait for the lease to expire (ten minutes) or stop the stale `node` process.                                                                    |
| `JOB_NOT_FOUND`                         | The finished result expired. Start the operation again.                                                                                                                                                  |

## Rewrites

Use the error code to find what prevented a focus, GUI or map edit.

| Code                                     | Cause and fix                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSACTION_STALE`                      | A source file changed after the review was made. Inspect again and repeat the rewrite on the current source.                                                                                 |
| `TRANSACTION_RECOVERY_REQUIRED`          | An earlier rewrite was interrupted and its journal could not be recovered yet. Reads still work; the message names the reason. Restart the server, and repair the named file if it persists. |
| `TRANSACTION_ROLLBACK_STALE`             | A file changed since the rewrite, so it cannot be rolled back safely. Restore the file from version control.                                                                                 |
| `MAP_STATE_DISTRIBUTION_REQUIRED`        | A state operation was given an incomplete explicit policy. Omit `distribution` for the automatic land-share policy, or send every field (see [Maps](map.md)).                                |
| `MAP_STATE_REGION_DISTRIBUTION_CONFLICT` | Moved or merged provinces lie in different strategic regions. Use `strategicRegion: "move-to-target-region"`, or move the provinces between regions first.                                   |
| `MAP_EXTERNAL_REFERENCE_READ_ONLY`       | Base-game or dependency scripts name a changed state. Repeat with `remapReferences` or `readOnlySources` set to `override` to copy them into the mod with the numbers changed.               |
| `MAP_DATED_STATE_HISTORY_CONFLICT`       | A dated block (`1939.1.1 = { ... }`) overrides the value you are changing. Edit that block, or change the later date's value deliberately.                                                   |
| `MAP_SCRIPT_REFERENCE_MISSING` (error)   | A script names a state, province or region the map does not define. Remap it with `remap_map_references`, or correct the script.                                                             |
| `MAP_REFERENCE_NEEDS_REVIEW` (info)      | A single-valued argument such as `capital = 64` had no single successor and was left as it was. Choose its new target by hand.                                                               |

## Game and live testing

This server reads source and never starts the game.
To reproduce a problem in game, read what the game logged with `hoi4.error_log` (the last launch only, with the file and line where the message names one), then fix the file and ask `hoi4.script_validate` with `path` to check it before relaunching.
For launching, loading a save and watching a campaign, pair it with the separate HOI4 Live Tools server (see [A running game](setup.md#a-running-game)).

## Still stuck

Run `hoi4-agent-tools-setup --diagnose`, then open an issue at <https://github.com/klimPaskov/hoi4-agent-tools/issues> with the tool name, the arguments (without private paths), the error code and message, and the output of `hoi4-agent-tools-setup --diagnose`, which includes the server and Node.js versions.
For a security problem use the [Security Policy](../SECURITY.md) instead of a public issue.

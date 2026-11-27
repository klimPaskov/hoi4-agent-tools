# ADR 0092: The stdio server answers before the workspaces load

Status: accepted (Agent Tools lead, issue 292)

## Context

The stdio entry read the configuration, discovered every mod under the configured mod roots (directory listing, `lstat`, `realpath`, descriptor and `replace_path` reads), swept the temporary directory, and only then connected the transport. A client got no answer to `initialize` meanwhile. On 4.20.1 with one real configuration that took 14.6 s, and up to 26 s with six servers starting at once, against 2.3 s with no configuration. A client with a startup or list timeout showed the server as connected with no tools.

The tool list does not depend on the workspaces. It comes from the profiles (`HOI4_AGENT_TOOLS_PROFILES`, the configuration's `profiles`, or the stdio default `core`) and from the configured plugins, and none of those need the resolver.

## Decision

**Two halves of `WorkspaceResolver.create`.** `prepare` checks the configured roots (canonical paths, overlaps, unsafe mod roots) and opens the server state. It reads no mod folder. `populate` resolves the configured workspaces and discovers the mods. `create` is `prepare` then `populate`, so the HTTP server, the job workers and the setup command behave as before. Until `populate` ends, every workspace lookup (`list`, `get`, `resolveWorkspaceId`, `resolveCurrentWorkspaceId`, `resolveClientWorkspaceId`) fails with `WORKSPACE_STARTUP_PENDING`.

**`createEngine(path, { workspaces: 'background' })`.** It reads the configuration, applies the profiles, runs `prepare`, builds the engine and returns. The loading, the temporary-directory sweep and the journal recovery run behind `engine.deferStartup`, and `engine.recovered()` settles when they end. The stdio entry uses this option.

**The transport's hold covers the loading.** `serveNegotiatedStdio` already answered `initialize`, `ping`, `tools/list` and `prompts/list` at once and held every other request until `engine.recovered()` settled. It now holds them until the workspaces are loaded as well, so tool calls, resource reads and the other requests that need a workspace wait, in arrival order.

**A startup error is reported, not fatal.** A configuration error (`CONFIG_READ_FAILED`, `CONFIG_INVALID`, ...), a failed `prepare` (`WORKSPACE_MOD_ROOT_UNSAFE`, ...) or a failed `populate` (`WORKSPACE_DEFAULT_UNKNOWN`, ...) no longer ends the process. The engine writes the same `startup_failed` event to stderr as before, with the error's `code`, and `resolver.failStartup` makes every workspace lookup throw the original error. The first call that needs a workspace answers with that code through the normal tool error path. The tool list comes from the profiles and plugins. A configuration that cannot be read is replaced by an empty one with the same profiles.

## What stays

The transport limits and idle exit, the recovery semantics, the HTTP entry (which loads everything before it listens), the plugin loading and the error codes. The Rust transport of ADR 0091 carries the same order: answer the handshake and the list from the configuration, hold the other requests until the workspaces are loaded, and report a startup error on the first call that needs them.

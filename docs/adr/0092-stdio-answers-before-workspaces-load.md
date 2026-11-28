# ADR 0092: The stdio server answers before the workspaces load, and loads them on first use

Status: accepted (Agent Tools lead, issues 292 and 296)

## Context

The stdio entry read the configuration, discovered every mod under the configured mod roots (directory listing, `lstat`, `realpath`, descriptor and `replace_path` reads), swept the temporary directory, and only then connected the transport. A client got no answer to `initialize` meanwhile. On 4.20.1 with one real configuration that took 14.6 s, and up to 26 s with six servers starting at once, against 2.3 s with no configuration. A client with a startup or list timeout showed the server as connected with no tools.

Most sessions never call a tool, yet each idle server also held 354 to 784 MB of private memory with a configuration, against 112 MB without one (issue 296): the heap grew from about 58 MB at the handshake to about 298 MB 75 s later, in work the server started by itself.

The tool list does not depend on the workspaces. It comes from the profiles (`HOI4_AGENT_TOOLS_PROFILES`, the configuration's `profiles`, or the stdio default `core`) and from the configured plugins, and none of those need the resolver.

## Decision

**Two halves of `WorkspaceResolver.create`.** `prepare` checks the configured roots (canonical paths, overlaps, unsafe mod roots) and opens the server state. It reads no mod folder. `populate` resolves the configured workspaces and discovers the mods. `create` is `prepare` then `populate`, so the HTTP server, the job workers and the setup command behave as before. Until `populate` ends, every workspace lookup (`list`, `get`, `resolveWorkspaceId`, `resolveCurrentWorkspaceId`, `resolveClientWorkspaceId`) fails with `WORKSPACE_STARTUP_PENDING`.

**`createEngine(path, { workspaces: 'background' })`.** It reads the configuration, applies the profiles, runs `prepare`, builds the engine and returns. Nothing else starts. The loading and the temporary-directory sweep are set as `engine.deferStartup` work, which runs when `engine.recovered()` is first asked for. The stdio entry uses this option.

**The transport starts the loading on the first request that needs it.** `serveNegotiatedStdio` answers `initialize`, `ping`, `tools/list` and `prompts/list` at once, starts nothing for them, and calls `engine.recovered()` when the first other message arrives. It holds that message and every later one until the loading ends, in arrival order. A server that never gets such a request never loads a workspace.

**Each workspace recovers on its first use.** `engine.recoverOnDemand()` replaces the recovery of every workspace at startup. A workspace's interrupted rewrite is recovered once, before the first file access through the resolver (`refreshDescriptors`, `resolvePath`, `resolvePathInRoot`), before the first job for it is submitted and before the first rewrite of it is planned or applied (`TransactionManager.setRecoveryGate`). A failed recovery is recorded as before: the `transaction_recovery_blocked` event goes to stderr, reads go on, and rewrites of that workspace are refused with `TRANSACTION_RECOVERY_REQUIRED`. The recovery's own file access does not wait for itself.

**A startup error is reported, not fatal.** A configuration error (`CONFIG_READ_FAILED`, `CONFIG_INVALID`, ...), a failed `prepare` (`WORKSPACE_MOD_ROOT_UNSAFE`, ...) or a failed `populate` (`WORKSPACE_DEFAULT_UNKNOWN`, ...) no longer ends the process. The engine writes the same `startup_failed` event to stderr as before, with the error's `code`, and `resolver.failStartup` makes every workspace lookup throw the original error. The first call that needs a workspace answers with that code through the normal tool error path. The tool list comes from the profiles and plugins. A configuration that cannot be read is replaced by an empty one with the same profiles.

## What stays

The transport limits and idle exit, the recovery semantics and their error codes, the HTTP entry (which loads everything before it listens), the plugin loading and the error codes. The Rust transport of ADR 0091 carries the same order: answer the handshake and the list from the configuration, load the workspaces on the first request that needs them, recover each workspace on its first use, and report a startup error on the first call that needs them. Releasing a workspace's in-memory caches after an idle period stays with issue 296.

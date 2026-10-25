# ADR 0066: Workspace fallback for sessions outside every mod

## Context

Every tool takes `workspaceId`, defaulting to `current`. For `current` the server asks the MCP client for its roots and accepts only a root inside a mod workspace or containing one; without roots it uses its own working directory. A coding agent started in another folder (the tool repository, a git worktree, a scratch folder) advertises roots outside every mod, and so do its subagents, which share the parent's MCP connection. With several mods under a configured mod root, every implicit call then failed with `WORKSPACE_CONTEXT_NOT_FOUND`, an error that named neither the candidate workspaces nor the fix. The recovery that picks the one mod holding a requested source file never ran, because the roots check threw first. A coding agent working on a total-conversion mod hit this on 19 October 2026.

## Decision

When neither the client roots nor the working directory identify a mod, `current` resolves in this order:

1. The configured `defaultWorkspace`, a new optional configuration key holding a workspace ID or short form. Startup resolves it once and refuses an unknown or non-mod workspace (`WORKSPACE_DEFAULT_UNKNOWN`) and an ambiguous short form (`WORKSPACE_CONTEXT_AMBIGUOUS`); the schema refuses `current`. The default is used only when the calling principal can see it, so it never widens a grant.
2. The only mod workspace the caller can see. The working-directory path already did this; the roots path now does too.
3. For tools that name a source file (the focus tools' `relativePath`, `hoi4.script_validate`'s `path`), the one mod that has the file, through the existing `resolveUniqueModSourceWorkspaceId`: canonical-path checks, traversal refusal and `WORKSPACE_SOURCE_AMBIGUOUS` when several mods have it.

A roots match still wins over the default, and several roots matches still fail as ambiguous. When nothing applies, `WORKSPACE_CONTEXT_NOT_FOUND` (roots) and `WORKSPACE_CONTEXT_REQUIRED` (working directory) list up to 32 workspace IDs and names with the total count, and the message names the three fixes: pass `workspaceId` (an ID or the mod folder name), start the client in the mod folder, or set `defaultWorkspace`. The details carry no host paths beyond what `WORKSPACE_CONTEXT_REQUIRED` already returned.

## Consequences

Agents in other folders work without knowing the opaque discovered ID, and an error tells them what to pass. The configuration schema gains one optional key, so existing configurations are unchanged; no public tool schema changes. Unit tests cover the default, the single mod, the order against a roots match, the refused defaults, principal grants and source recovery with its ambiguous, missing and traversal cases; an MCP test covers a client whose only root is outside every mod.

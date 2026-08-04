# ADR 0021: Client-root workspace context

- Status: accepted
- Date: 2026-08-04

## Decision

When a local MCP call omits its workspace, resolve the active mod from filesystem roots advertised by that connected MCP client. Match only canonical roots against already configured or discovered mod workspaces. A unique match is required. If the client does not advertise roots, retain working-directory inference for compatibility.

Explicit workspace names and IDs continue to resolve without consulting client roots. Streamable HTTP sessions use their own server context, so one client's roots cannot select another session's workspace. Principal grants still filter all candidates before selection.

## Rationale

An MCP process can outlive or be reused independently of the coding task that originally launched it. Process working directory alone can therefore select a stale mod when an agent opens another repository. MCP client roots carry the active project context for the connected session and avoid a workspace-switch tool or mod-local setup state.

## Consequences

Clients that advertise roots receive correct per-session mod selection even when the server process started elsewhere. Empty, unmatched, or multiply matching root sets fail explicitly instead of falling back to an unrelated mod. Clients without roots must still launch the server from inside the intended mod or supply an explicit workspace reference.

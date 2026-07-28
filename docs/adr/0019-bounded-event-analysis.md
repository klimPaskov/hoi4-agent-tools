# ADR 0019: Bounded event analysis for large workspaces

- Status: accepted
- Date: 2026-07-28

## Decision

Game-backed and other large event workspaces automatically use a focused source profile for broad inspection. The profile scans event definitions and on-actions, retains direct calls, state accesses, source locations, and unresolved references, and skips workspace-wide helper projection and lifecycle passes. The graph reports `analysisMode: "focused"` and an `EVENT_FOCUSED_ANALYSIS_DEFERRED` boundary.

Small synthetic or mod-only workspaces retain the full event graph and diagnostic passes. Focused trace and path requests remain bounded by their depth, node, edge, and helper settings.

## Rationale

The full vanilla-plus-mod event surface can contain thousands of unrelated source fragments. Building every derived helper and lifecycle relationship before answering a roots query consumed multiple gigabytes and left the stdio server running until the client closed the transport. Narrowing only the broad large-workspace source profile keeps the server responsive while preserving direct evidence for agent follow-up.

## Consequences

Large broad scans return partial results by design, with the omitted workspace-wide passes named in the linked report. Agents should use bounded trace, path, state, lint, render, or source queries for a specific chain. The server never guesses deferred routes or claims complete large-workspace event coverage.

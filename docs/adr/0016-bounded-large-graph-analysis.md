# Bounded large-graph analysis

Status: accepted

Large installed-game workspaces must remain queryable without forcing an MCP client to serialize every derived record into one request. Read-only technology scans therefore return exact counts, grouped inventories, representative samples, and a revision for follow-up queries when the graph exceeds the inline record budget. Game-backed and other large technology scans also use the bounded helper-expansion policy in [ADR 0018](0018-bounded-technology-helper-expansion.md), so the cached graph is marked partial when workspace-wide scripted-effect projections are deferred.

Event scans use the same bounded-report rule. Game-backed or other large event workspaces automatically use a focused source profile containing event definitions and on-actions, retain direct calls and state accesses, and defer workspace-wide helper projections and lifecycle passes. The graph records `analysisMode: "focused"`, returns an explicit `EVENT_FOCUSED_ANALYSIS_DEFERRED` boundary, and remains source-linked for bounded trace and path follow-up. Small workspaces retain the complete graph and diagnostic passes.

The full profile still includes active mod, dependency, and game sources. The focused large-workspace profile deliberately narrows broad input to event definitions and on-actions so the server does not materialize thousands of unrelated source fragments before returning. The viewer reports the resulting source inventory and deferred boundary rather than silently inventing missing routes.

This keeps the MCP response and artifact sizes bounded while preserving deterministic revisions, source locations, focused follow-up queries, and rollback-free read-only behavior.

# Bounded large-graph analysis

Status: accepted

Large installed-game workspaces must remain queryable without forcing an MCP client to serialize every derived record into one request. Read-only technology scans therefore return exact counts, grouped inventories, representative samples, and a revision for follow-up queries when the graph exceeds the inline record budget, while the viewer retains the complete graph in its cache.

Event scans use the same bounded-report rule and keep the complete source-linked graph available for focused modes. Focused event traces and path explanations use the structural graph and materialize helper projections only along the requested bounded route, so a large helper network does not delay or exhaust a single request. On large graphs those focused calls also defer workspace-wide issue and state-link passes; use scan, lint, state, impact, comparison, or render for full diagnostic inventories. Broad analyses keep their complete helper projections when those analyses require workspace-wide derived evidence.

The shared scan still includes active mod, dependency, and game sources. Country and state-history files remain in the source inventory, but the event analyzer only parses setup files that contain an event-call assignment; event/common definitions and localization remain source-linked. The viewer reports the resulting source inventory and diagnostics rather than silently inventing missing routes.

This keeps the MCP response and artifact sizes bounded while preserving deterministic revisions, source locations, focused follow-up queries, and rollback-free read-only behavior.

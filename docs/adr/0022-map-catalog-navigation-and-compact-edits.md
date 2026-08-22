# ADR 0022: Complete map catalog, navigation, and compact edits

- Status: accepted
- Date: 2026-08-22

## Decision

Build one shared map catalog from the active `MapWorkspaceIndex` and use it for MCP inspection, JSON renders, and the HTML map navigator. The catalog resolves localised names and joins source locations, raster geometry, state and strategic-region memberships, topology, networks, positions, buildings, resources, ports, and locators.

Embed an exact province-ID hit map in the HTML artifact. Search and click navigation operate on catalog data and the hit map, so they do not approximate IDs from display colors or screen geometry. The artifact is an inspection surface; all source changes continue through `hoi4.map_rewrite`.

Add compact defaults to `create_state` and `create_province` while retaining the existing explicit forms. Compact state creation infers one unambiguous source state, uses proportional land-pixel distribution for divisible state values, copies state identity data, and follows province-bound records. Compact province creation inherits the source definition and connected membership and accepts rectangle geometry in addition to existing exact forms.

Add `renumber_map_entity` for province, state, and strategic-region IDs. Occupied destinations swap by default. The operation rewrites every indexed map-domain reference and standard localisation key and rejects province or strategic-region results that break required contiguous ID sets.

## Rationale

Agents need one bounded resource that answers where an ID is, what it is called, what contains it, what it references, and where its source is. The former passive image plus raw metadata required repeated scans and manual joins. State and province creation also repeated large policy payloads even when the intended behavior was the common deterministic case.

## Consequences

`hoi4.map_inspect` produces a full overview unless the caller disables it or no valid province raster exists. `hoi4.map_render` JSON is a complete catalog rather than a collection of loosely related arrays. Existing explicit operations remain valid, while compact creation and ID swapping reduce agent context and tool-call size.

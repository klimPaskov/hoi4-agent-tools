# ADR 0004: Deterministic constraint layout

- Status: accepted
- Date: 2026-07-10
- Updated: 2026-08-06

## Decision

Use a project-owned layered constraint solver with integer coordinates, deterministic tie-breaking, stable route lanes, pinned-node constraints, mutual-exclusion spacing, incremental stability anchors, objective layout metrics, and explicit unsatisfied-constraint reports.

The public rewrite has two deliberate modes. `authored` is the default for complete plans and preserves fixed, relative, and pinned presentation constraints. `compact` is an explicit cleanup mode for national trees; it may clear those presentation constraints and lane bounds while retaining gameplay data and route/lane membership. An existing tree can request compact reflow with its workspace, path, and tree ID and does not need to repeat the complete plan. Compact planning evaluates separate preservation, row-compression, linear-chain, sibling-balance, and combined strategies so an aggressive cleanup cannot displace an otherwise cleaner candidate.

## Rationale

ELK and Dagre were evaluated. They are strong general graph-layout libraries, but their floating layouts and global rearrangement behavior do not directly satisfy stable HOI4 coordinates, source-relative positions, route-family lanes, pinned nodes, or explainable blocked layouts. The evaluated ELK layout reduced raw canvas bounds but increased total connector traffic and weakened route-family grouping. Adding its runtime and license surface was not justified by the visual result. The focus model still keeps the solver behind an interface so a future version can adopt another implementation without changing public schemas.

## Consequences

The solver does not change prerequisites or stack nodes to force success. Automatic nodes reject visible overlaps and same-row or mutual-exclusion gaps smaller than `nodeSpacing`, then minimize connector crossings and span across deterministic integer candidates. A bounded post-pass evaluates rendered crossings, connector-node hits, maximum and total connector span, long-edge count, branch balance, bounds, and centering before moving automatic nodes or complete sibling cohorts. Compact mode repacks sparse sibling cohorts at the minimum readable spacing around their structural parent. Exclusive descendant branches move with their sibling root so a shorter first connector does not merely transfer the detour to the next row, while shared convergence nodes remain anchored. Dense cohorts may retain additional width when their descendant geometry requires it to avoid overlap, crossings, or connector-node intersections. Compact mode also straightens mechanically linear chains and minimizes offset linear detours, staircase chains, and zigzags that manufacture visual complexity. Fixed, relative, and pinned nodes stay fixed in authored mode; prior automatic coordinates remain stability preferences only while they remain collision-free and parent-valid.

Every layout reports bounds, spacing, rendered-curve connector, connector-node, branch-balance, and centering metrics. Compact rewrites have a correctness gate: they must eliminate visible overlap, too-close same-row pairs, invalid parent order, rendered-curve crossings, and connector paths through unrelated focuses, and they must center the result within half a column. Long connectors, linear detours, staircase or zigzag geometry, and sibling balance are prioritized optimization targets rather than independent rejection budgets because improving one complex route can legitimately increase another aggregate span.

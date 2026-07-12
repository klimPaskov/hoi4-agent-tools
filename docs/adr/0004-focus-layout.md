# ADR 0004: Deterministic constraint layout

- Status: accepted
- Date: 2026-07-10
- Updated: 2026-07-12

## Decision

Use a project-owned layered constraint solver with integer coordinates, deterministic tie-breaking, stable route lanes, pinned-node constraints, mutual-exclusion spacing, incremental stability anchors, objective layout metrics, and explicit unsatisfied-constraint reports.

The public rewrite has two deliberate modes. `authored` is the default for complete plans and preserves fixed, relative, and pinned presentation constraints. `compact` is an explicit cleanup mode for national trees; it may clear those presentation constraints and lane bounds while retaining gameplay data and route/lane membership. An existing tree can request compact reflow with its workspace, path, and tree ID and does not need to repeat the complete plan.

## Rationale

ELK and Dagre were evaluated. They are strong general graph-layout libraries, but their floating layouts and global rearrangement behavior do not directly satisfy stable HOI4 coordinates, source-relative positions, route-family lanes, pinned nodes, or explainable blocked layouts. The evaluated ELK layout reduced raw canvas bounds but increased total connector traffic and weakened route-family grouping. Adding its runtime and license surface was not justified by the visual result. The focus model still keeps the solver behind an interface so a future version can adopt another implementation without changing public schemas.

## Consequences

The solver does not change prerequisites or stack nodes to force success. Automatic nodes reject visible overlaps and same-row or mutual-exclusion gaps smaller than `nodeSpacing`, then minimize connector crossings and span across deterministic integer candidates. A bounded post-pass evaluates rendered crossings, connector-node hits, maximum and total connector span, long-edge count, branch balance, bounds, and centering before moving an automatic gateway or blocker. Fixed, relative, and pinned nodes stay fixed in authored mode; prior automatic coordinates remain stability preferences rather than permanent anchors.

Every layout reports bounds, spacing, rendered-curve connector, connector-node, branch-balance, and centering metrics. Compact rewrites have absolute and relative quality gates: they must eliminate too-close same-row pairs and rendered-curve crossings, keep local branches or broad subtree envelopes balanced, center the result within half a column, remain inside graph-size-based width and connector budgets, and avoid source-relative regressions. Connector paths through unrelated nodes remain explicit measured diagnostics with a bounded compact-layout budget.

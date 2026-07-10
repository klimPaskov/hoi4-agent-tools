# ADR 0004: Deterministic constraint layout

- Status: accepted
- Date: 2026-07-10

## Decision

Use a small project-owned layered constraint solver with integer coordinates, deterministic tie-breaking, stable route lanes, pinned-node constraints, mutual-exclusion spacing, incremental stability anchors, crossing counts, and explicit unsatisfied-constraint reports.

## Rationale

ELK and Dagre were evaluated. They are strong general graph-layout libraries, but their floating layouts and global rearrangement behavior do not directly satisfy stable HOI4 coordinates, source-relative positions, route-family lanes, pinned nodes, or explainable blocked layouts. The focus model still keeps the solver behind an interface so a future version can adopt a library without changing public schemas.

## Consequences

The solver does not change prerequisites or stack nodes to force success. New automatic nodes reject visible overlaps and mutual-exclusion gaps smaller than `nodeSpacing`, then minimize connector crossings across deterministic integer candidates. Fixed, relative, pinned, and prior-layout nodes are never moved for these presentation heuristics. When their authored constraints leave a mutual-exclusion gap or connector crossing unsatisfied, the result identifies the preserved and still-movable endpoints. These presentation findings remain warnings rather than semantic errors.

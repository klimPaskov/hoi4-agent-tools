# ADR 0013: Read-only Event Chain Viewer

- Status: accepted
- Date: 2026-07-13

## Decision

Add event-chain analysis as a fourth domain backed by the shared workspace resolver, Clausewitz source model, symbol index, diagnostics, configuration, artifacts, and deterministic rendering services. Keep the public surface compact:

- `hoi4.event_inspect`, with `scan`, `roots`, `trace`, `explain_path`, `state_flow`, `lint`, and `impact` modes
- `hoi4.event_render`
- `hoi4.event_compare`

All three tools are read-only. They operate on source and content-addressed artifacts, return compact summaries with exact source locations, and place complete JSON graphs, SVG, PNG, HTML, diagnostics, and comparisons in the existing artifact resource template. JSON is authoritative. Unresolvable dynamic or meta-generated calls remain explicit unresolved edges.

Do not register an event writer, runtime simulator, MCP prompt, dashboard, or editor. The server never launches the game. The thirteen-tool discovery response must remain within the fixed 32 KiB budget.

## Rationale

Event behavior is distributed across definitions, call sites, options, timing blocks, scopes, flags, variables, and saved targets. A source-linked graph makes large chains reviewable by coding agents, while seven inspect modes avoid a long list of narrowly named tools. Read-only analysis lets agents continue using their normal repository instructions and editing workflow and then compare the result.

## Consequences

The public package advances to version 1.2.0 and exposes thirteen tools. CI gains a project-owned 300-plus-definition event fixture and deterministic topology, state-flow, render, comparison, transport, package, and discovery tests. Local opt-in tests may read installed vanilla and external mods but do not copy or modify them. Static analysis limitations are always reported rather than replaced with guessed runtime behavior.

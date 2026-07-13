# ADR 0008: Synthetic acceptance workspaces and layered tests

- Status: accepted
- Date: 2026-07-10

## Decision

CI uses only project-owned synthetic workspaces: a 255-focus tree, a 170-element scripted GUI, a nontrivial 24-bit BMP mini-world, and an event workspace with more than 300 definitions and deterministic route defects. Test layers cover unit, source round-trip, property, schema, golden artifact, graph topology, event state and scope flow, image comparison, bitmap diff, transaction fault/recovery, security/isolation, both MCP transports, Inspector, package installation, and Registry validation.

Local opt-in tests read configured installed-game and external-mod roots without copying or modifying them. Performance reports cover cold and warm scans, layouts, renders, and event graph construction.

## Rationale

Portable CI cannot depend on proprietary content. Synthetic fixtures allow precise defect oracles and deterministic outputs, while local integration catches format drift in real installations.

## Consequences

Fixture generators are maintenance tools, not completion evidence by themselves. Expanded fixtures, expected topology, goldens, and hashes are reviewed and committed. A skipped local suite is reported as environment-dependent rather than converted into a CI pass.

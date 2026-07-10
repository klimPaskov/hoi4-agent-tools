# ADR 0010: Explicit fidelity and refusal

- Status: accepted
- Date: 2026-07-10

## Decision

Unknown script stays in raw CST ranges. Read-only scans may report partial semantics. A write is blocked whenever the requested edit would cross malformed syntax, ambiguous plan/script drift, an unsupported source encoding, unresolved split distribution, unknown geometry, missing authoritative IDs/colors, or a renderer-dependent value that the caller has not supplied.

GUI artifacts classify fields as modelled, approximated, ignored, missing, unsupported, or unresolved. Approximations are never silently promoted to modelled behavior. Static and design heuristics never rewrite gameplay meaning automatically.

## Rationale

Guessing is more dangerous than refusing in a source-modification server. Fidelity reports let coding agents distinguish useful evidence from an asserted game-equivalent result.

## Consequences

The limitations catalogue is versioned and reproducible. Adding support narrows a documented category and requires fixtures. The project does not provide fallback renders or placeholder data as completion evidence.

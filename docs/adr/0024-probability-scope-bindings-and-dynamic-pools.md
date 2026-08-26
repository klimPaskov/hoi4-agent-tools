# ADR 0024: Probability scope bindings and dynamic pools

- Status: accepted
- Date: 2026-08-26

## Decision

Extend probability scenarios with structured Clausewitz scope bindings and declared dynamic scope pools.

Each binding owns an identifier, optional scope type and actor, state, flags, event targets, and optional pool weight. Trigger evaluation carries a scope context through `ROOT`, `THIS`, `PREV`, exact `FROM` chains, saved scopes, event targets, and scripted-trigger expansion. Inner trigger and variable reads use the active binding instead of root state.

A scenario may also declare one or more dynamic scope pools. A pool binds every catalog candidate to an exact scope alias, evaluates either an inline trigger filter or named scripted trigger, and returns deterministic eligible, excluded, and unresolved membership. Complete uniform and proportional pools additionally return exact conditional probabilities. Incomplete catalogs remain enumerable but are not normalized.

Scoped uncertain-input paths and pool-candidate paths use the same structured scenario update mechanism in exact branching, sweeps, and simulation. Full pool rows stay in the authoritative JSON resource; the MCP response reports only pool counts.

## Rationale

Complex HOI4 event systems commonly select a destination, opposition actor, donor, target state, or similar runtime scope from a dynamically filtered catalog. A single root-state dictionary and coarse `scope.FROM = true` declaration cannot explain those filters and can incorrectly skip the conditions inside a special-scope block.

Structured bindings let the analyzer evaluate the actual conditions without executing the game or inventing campaign state. Declared candidate catalogs make large runtime pools inspectable while preserving the existing rule that normalized probabilities require a complete denominator.

## Consequences

The scenario schema gains optional `scopes` and `scopePools` fields without invalidating existing version 1.0 scenario documents. Analysis JSON may include per-scenario scope-pool results. Public MCP tool schemas remain compact because scenario payloads continue to use runtime-validated nested schemas.

The analyzer still cannot discover unknown campaign entities or execute effects that build a pool. The caller supplies the relevant candidate catalog and state; the analyzer applies source or inline trigger logic to that catalog and exposes every unresolved fact.

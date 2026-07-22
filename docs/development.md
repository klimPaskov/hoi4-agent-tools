# Development

Install dependencies and run the complete project check:

```bash
npm ci
npm run check
```

`npm run check` runs formatting, type checks, tests, fixture checks, schema generation checks, build checks, and package validation. Use narrower commands during iteration:

```bash
npm run test
npm run test:coverage
npm run fixtures:check
npm run build
npm run inspector
```

Keep changes focused and include tests for behavior changes. CI fixtures must be synthetic and project-owned; never commit installed-game or third-party-mod content. Public tool or schema changes require compatibility review and a versioned release.

The event-chain acceptance fixture contains more than 300 project-owned event definitions and exercises routes, options, timing, state flow, scope changes, unresolved dynamic calls, rendering, and comparison.

The technology acceptance fixture contains 1,040 project-owned technologies across 13 folders and exercises classic and current doctrines, prerequisites, exclusive branches, multiple placements, unlocks, bonuses, grants, assets, unresolved references, rendering, and comparison.

The probability fixture contains more than 150 weighted blocks, 250 scenarios, and a declared stateful pool. Run `npm run benchmark` after analyzer changes. On the July 22, 2026 reference run, cold indexing took 28 ms, a cached block evaluation 29 ms, the 250-row matrix 85 ms, one million draws 9 ms, 3/12/25-candidate sequence cases 20/2,079/356 ms, and retrieval of a 1.84 MB result 3 ms. Review budgets are 250 ms, 150 ms, 750 ms, 100 ms, 200/10,000/3,000 ms, and 100 ms respectively; accuracy, method metadata, and omitted probability must not be weakened to meet them.

Local opt-in tests can also read an installed game and an external mod without copying their sources:

```bash
HOI4_GAME_ROOT="/games/Hearts of Iron IV" \
HOI4_EXTERNAL_MOD_ROOT="/projects/hoi4-mod" \
npm run test:local
```

Add `HOI4_DEPENDENCY_ROOTS` as the platform path-delimited list when the external mod has dependencies. Local tests remain read-only.

See the package [Security Policy](../SECURITY.md) for private vulnerability reporting.

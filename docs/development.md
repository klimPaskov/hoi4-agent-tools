# Development

Install dependencies and run the complete project check:

```bash
npm ci
npm run check
```

`npm run check` runs formatting, lint, type checks, tests, fixture checks, schema generation checks, build checks, package validation, and MCP Registry metadata validation. Use narrower commands during iteration:

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

`npx vitest run tests/integration/mcp-concurrent-workloads.test.ts` tests simultaneous production calls across the tool domains over six HTTP sessions and four independent stdio processes, including artifact retrieval and queued cancellation. Execution limits and connection behavior are described in [HTTP](http.md) and the [concurrency decision](https://github.com/klimPaskov/hoi4-agent-tools/blob/main/docs/adr/0026-concurrent-request-execution.md).

Persistent-job qualification covers authenticated record publication, request-key conflicts, read-result checkpoints, transaction-journal reconciliation, stopped-owner takeover, native task negotiation, ordinary-call parity, reconnect isolation, rewrite cancellation before source application, and fixed-entry worker execution. The public lifecycle contract is documented in [Persistent jobs and MCP tasks](jobs.md).

The probability fixture contains more than 150 weighted blocks, 250 scenarios, and a declared stateful pool. Run `npm run benchmark` after analyzer changes. On the July 22, 2026 reference run, cold indexing took 28 ms, a cached block evaluation 29 ms, the 250-row matrix 85 ms, one million draws 9 ms, 3/12/25-candidate sequence cases 20/2,079/356 ms, and retrieval of a 1.84 MB result 3 ms. Review budgets are 250 ms, 150 ms, 750 ms, 100 ms, 200/10,000/3,000 ms, and 100 ms respectively; accuracy, method metadata, and omitted probability must not be weakened to meet them.

Local opt-in tests can also read an installed game and an external mod without copying their sources:

```bash
HOI4_GAME_ROOT="/games/Hearts of Iron IV" \
HOI4_EXTERNAL_MOD_ROOT="/projects/hoi4-mod" \
npm run test:local
```

Add `HOI4_DEPENDENCY_ROOTS` as the platform path-delimited list when the external mod has dependencies. Local tests remain read-only.

`tests/integration/mcp-stdio-smoke.test.ts` starts the real `src/bin/stdio.ts` entry point and calls every exposed tool once with the argument shape an agent sends, then once with a deliberately wrong field.
Each success must be a non-error `ok` result whose inline structured content stays under 40 KB, and each wrong call must be a `INVALID_ARGUMENTS` tool error that names the field and shows a working example.
The suite also builds a world with `create_world`, splits and merges a state with `create_state` and `merge_states`, repairs script references with `remap_map_references`, and load-checks the resulting `definition.csv`, state, strategic region, supply and railway files independently of the server's own validator.
`tests/local/mcp-stdio-smoke.test.ts` repeats the read-only calls against the installed game (through an empty mod) and the external mod above; set `HOI4_SMOKE_REPORT` to a file path to receive the per-tool coverage table with timings.
`npm run benchmark:cold` times the slow first calls (`hoi4.mod_index`, an event lint and a decision inventory) of a real mod in a fresh server process and again in a second process on the same state folder; the maintainer checklist for tagging a release is `docs/RELEASING.md` in the repository.

The installed-game qualification also parses every shipped bitmap-font descriptor, resolves every atlas page, shapes native and enlarged glyphs, verifies deterministic raster output, and checks HOI4 localisation colours across base fonts and language overrides.

## Adding a known mistake

`src/hoi4_agent_tools/reference/known-mistakes.json` is the reviewed list behind `known_mistakes` in `hoi4.script_validate`, the `knownMistakes` of `hoi4.reference_context`, and the `knownMistake` of `hoi4.error_log`.
It is not written at run time: a mistake enters it through a commit.

1. Find the mistake in the offline wiki, the game documentation, or a reproduced `error.log` message, and note the page, heading and item.
   A rule without a source is not accepted.
2. Add the rule: a unique snake_case `id`, `severity` (`error` when the definition cannot work, `warning` otherwise), the `surfaces` it belongs to, a `title`, the `mistake`, its `symptom`, the `fix`, the `sources`, and, when the game logs a fixed message, a `logPattern` regular expression.
3. Add the detector with the same id in `known-mistakes.ts`, working on the parsed file, and the families it applies to.
   `tests/unit/known-mistakes.test.ts` fails when a rule has no detector or a detector has no rule; add a case that flags the mistake and one that accepts the corrected script.
4. When the rule is written from a recurring `error.log` pattern, run `hoi4.error_log` first: its `patterns` show the shapes, and the new `logPattern` makes later logs name the fix.

When the game fixes the behaviour, or the rule turns out to be wrong, set `status` to `resolved` and add `resolution` with the date and the reason, and leave the entry in the file.
A resolved rule is not applied and its detector is skipped; deleting it would lose why it was removed.

See the package [Security Policy](../SECURITY.md) for private vulnerability reporting.

## Dependencies

`npm-shrinkwrap.json` is published and fixes the complete production dependency tree for every consumer, who no longer receive newer transitive releases on their own.
Run `npm audit --omit=dev` and `npm audit signatures` before each release, and publish a new version with a refreshed shrinkwrap when a production advisory is fixed upstream.
Keep `overrides` inside every dependent's declared range; consumers do not apply this package's overrides, and `tests/package/metadata.test.ts` checks each production dependency edge in the shrinkwrap against its range.

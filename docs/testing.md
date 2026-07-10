# Testing and fixtures

```bash
npm ci
npm run test
npm run test:coverage
npm run fixtures:check
npm run build
npm run inspector
npm run check
```

## Portable CI

CI owns all inputs:

- a 255-focus workspace with ten route families, exclusions, convergence, planner-sidecar hidden/crisis/shared-support metadata, relative/pinned/automatic positions, a real `continuous_focus_palette`, active localisation, a two-frame sprite texture, and resolved synthetic references;
- a 170-element five-tab GUI with a dynamic list, target cards, meters, distinct frame animation, modal, all required states, licensed fixture font, and defect variants;
- a nontrivial 24-bit BMP mini-world with islands, exact split masks/polygons, state/region/network/adjacency data, and invalid variants.

Suites cover parser byte round trips, encodings, property cases, source locations, overlay/load order, custom focus roots, exact referenced-texture scanning, strict schemas, deterministic goldens, generated-source maps, planning-sidecar enrichment, image comparisons, font metrics, bitmap diffs, transaction fault/recovery, path security, cross-workspace isolation, stdio, Streamable HTTP, auth/origin/session limits, resource/prompt/tool discovery, package installation, Registry schema, and end-to-end agent workflows.

## Local integration

Set paths explicitly; tests are read-only:

```bash
HOI4_GAME_ROOT=/path/to/game \
HOI4_EXTERNAL_MOD_ROOT=/path/to/mod \
npm run test:local
```

Optionally set `HOI4_DEPENDENCY_ROOTS` to dependency roots separated by the operating system path delimiter (`;` on Windows, `:` on POSIX).

Three local tests parse and deterministically render a large vanilla focus tree, build and render a current GUI/GFX/font source graph, and scan/render/store the current province map with state, coastline, supply-node, and railway data against one external mod. Generated caches and artifacts stay in a temporary directory that is removed after the suite; the external roots remain read-only, no files are copied into the repository, and the game is never launched.

`npm run test:local` uses a project-owned validation runner around the standalone local Vitest configuration. It routes only `tests/local`, preserves ordinary Vitest failure codes, and independently requires the exact focus, GUI, and map qualification workflows to finish. The command fails when paths are absent and the tests skip, when a required workflow is not collected, when a worker terminates or runs out of memory, when Vitest reports any unhandled error, or when the reporter lifecycle is incomplete. A zero Vitest exit code alone is therefore not treated as success.

## Performance

Run the explicit, non-CI benchmark with `npm run benchmark`. It records cold/warm shared scans, the 255-node focus layout/render, the 150+ element GUI state gallery, and a full cross-root synthetic map scan plus all base-layer renders. Cache keys include content hashes; a deterministic unit test mutates content while preserving size and modification time to prove safe invalidation.

Current measurements, methodology, and rerun instructions are in [performance.md](performance.md).

# ADR 0043: One inspect tool per domain, forgiving arguments, compact answers and warm workers

## Context

Coding-agent transcripts from the 3.x releases showed where agents lost time:

- Most failed calls were argument errors, not domain errors. An event selector sent as a string or without `kind`, a GUI scenario without `id`, a decision inspection without a scenario, and a probability scenario set without ids or `state` together accounted for several hundred refused calls.
- `hoi4.probability_inspect` returned only an inventory. Agents then had to build a scenario set by hand and call `hoi4.probability_evaluate` to see a single weight; the weights themselves were only in a linked file.
- Seven probability tools, separate compare tools for events and technology, `hoi4.focus_raster` beside `hoi4.focus_render`, and `hoi4.map_render` beside `hoi4.map_inspect` made the tool list long without giving agents distinct jobs. Several tools were never called.
- Inline results carried up to 64 scanned file paths and diagnostics from unrelated game files, while the useful numbers stayed in artifacts.
- Every domain call ran in a freshly started worker process that rebuilt its indexes from disk, so a GUI render or decision inspection of a large mod took minutes even when the previous call had loaded the same files.

## Decision

1. Each domain has one inspect tool, and a separate render or rewrite tool only where the output differs in kind:
   - `hoi4.probability_inspect` finds the weighted source and evaluates it in the same call, with a fact-free scenario when none is given. `hoi4.probability_analyze` covers comparison, sweeps, simulation, declared sequences and re-rendering behind one `analysis` field.
   - `hoi4.event_inspect` and `hoi4.tech_inspect` take `mode: compare` for graph comparisons.
   - `hoi4.focus_render` produces the PNG with decoded icons by default; `png: false` keeps the faster vector-only output.
   - `hoi4.map_inspect` renders a layer, overlays, a tile or an entity area when any of those fields is given.
     The default server has 29 tools instead of 37. One list in `core/domain-tools.ts` names the durable domain tools for task routing, worker admission and request lifecycles.
2. Shorthand arguments are rewritten to their canonical form before validation, in one module shared by both protocol eras and by direct task submission. Each rule maps one unambiguous shorthand to one canonical value; anything else still fails validation with the field named.
3. Results answer inline. Probability results carry a ranking of the strongest candidates per scenario and the facts still missing; inline file inventories list at most twelve paths, mod files first; diagnostics in mod files come before those in game files; a flood of diagnostics is summarised by code; and an oversized result keeps its first diagnostics instead of dropping all of them. Unexpected failures name the error kind and a path-free message.
4. A job worker stays warm for `jobWorkerIdleSeconds` (default 180) after a job and runs its host's next job with the indexes it already holds. It returns its capacity slot while idle, exits when its host disconnects or the idle time ends, and a failed job always ends the worker. `jobWorkerIdleSeconds: 0` restores one worker per job.

## Consequences

Removed tool names are a breaking change, shipped in 4.0.0. Callers of `hoi4.probability_evaluate`, `_sweep`, `_simulate`, `_sequence`, `_compare` and `_render`, `hoi4.event_compare`, `hoi4.tech_compare`, `hoi4.focus_raster` and `hoi4.map_render` move to the merged tools; the arguments are unchanged apart from the selecting field.

A warm worker keeps one heap's worth of indexes for up to three minutes after use. Hosts that serve rare, very large requests can lower `jobWorkerIdleSeconds` or set `jobWorkerMaxHeapMiB`.

Argument normalization only accepts shapes observed from agents. Adding a rule requires a test that the shorthand and the canonical form produce the same request.

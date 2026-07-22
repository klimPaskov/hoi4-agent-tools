# Specification 09c: MCP Contract and Artifacts

## 1. Public interface

Expose a compact read-only MCP family using the server's established namespace.

Suggested operations:

- `hoi4.probability_inspect`
- `hoi4.probability_evaluate`
- `hoi4.probability_sweep`
- `hoi4.probability_simulate`
- `hoi4.probability_sequence`
- `hoi4.probability_compare`
- `hoi4.probability_render`

Final names must follow the implemented server convention.

All operations must be annotated read-only. There is no dry-run, apply, rollback, or rewrite operation for this family.

## 2. Inspect

`probability_inspect` locates a weighted surface and reports:

- adapter candidate
- source block and source location
- candidates and pool completeness
- referenced triggers, values, constants, helpers, flags, variables, and scopes
- unsupported constructs
- required scenario inputs
- whether exact probabilities, timing, score-only analysis, or no analysis is currently possible

It performs no sampling unless explicitly requested by another operation.

## 3. Evaluate

`probability_evaluate` runs exact or bounded analysis for one or more named scenarios.

Input includes:

- workspace and revision
- source target or inline source
- scenario set
- candidate-pool override when needed
- horizon for timing analysis
- requested metrics
- diagnostic thresholds

Output follows the result schema and returns resource URIs for large traces and visuals.

## 4. Sweep

`probability_sweep` varies declared scenario inputs.

Support:

- one-way ranges
- enumerated alternatives
- selected pairwise grids
- breakpoint search
- target-band checks
- rank-reversal search

The tool reports the tested space. It must not imply coverage outside that space.

## 5. Simulate

`probability_simulate` samples uncertain scenario inputs or supported stochastic timing.

Require:

- explicit distribution definitions
- deterministic seed
- sample budget
- requested confidence level
- stopping or convergence rule

Return sampled frequencies, timing quantiles, intervals, convergence data, and unresolved rare outcomes.

## 6. Sequence

`probability_sequence` evaluates a custom weighted-pool manifest.

Support:

- next-selection ranking
- top-k sequence paths
- expected time to selected categories
- outcome count distributions
- cooldown and starvation analysis
- terminal-state probability

Return exact, beam-search, or Monte Carlo method metadata for each result.

## 7. Compare

`probability_compare` compares revisions, snapshots, or virtual source.

Return:

- candidate additions and removals
- eligibility changes
- raw value changes
- probability and timing changes
- rank reversals
- target-band regressions
- explanation by changed source term
- assumption and adapter changes

A result is blocked when the two sides cannot be compared under compatible semantics.

## 8. Render

`probability_render` converts an existing analysis result into requested resources. It does not rerun analysis unless the result hash is stale or incompatible.

Supported resources may include:

- `probability://analysis/<id>/result.json`
- `probability://analysis/<id>/ranking.svg`
- `probability://analysis/<id>/matrix.svg`
- `probability://analysis/<id>/waterfall/<candidate>.svg`
- `probability://analysis/<id>/timing.svg`
- `probability://analysis/<id>/sensitivity.svg`
- `probability://analysis/<id>/sequence.svg`
- `probability://analysis/<id>/comparison.svg`
- `probability://analysis/<id>/unresolved.json`

The server may expose PNG equivalents and an optional HTML bundle.

## 9. Result size and pagination

Return concise summaries in tool responses. Place large candidate tables, traces, sample data, and visual artifacts in resources.

Support filtering by candidate, scenario, diagnostic severity, source file, and metric.

Large operations must support progress and cancellation. A cancelled run must not publish a complete result marker.

## 10. Safety and isolation

- resolve all source paths through the configured workspace
- keep vanilla and reference mods read-only
- parse inline source in memory or a private temporary overlay
- never apply a patch
- never write inside gameplay directories
- keep cache and artifacts in the configured tool workspace
- reject scenario inputs that attempt path escape or arbitrary code execution
- do not evaluate injected Python, shell, or template code

## 11. Error model

Use structured statuses:

- `complete`
- `partial`
- `blocked`
- `cancelled`
- `stale`

A partial result must name every unsupported or unresolved term that can affect the conclusion.

## 12. Agent-facing prompt

Add one optional MCP prompt for analyzing weighted logic. It should ask the coding agent to identify the source surface, choose representative scenarios, inspect required inputs, run the narrowest useful analysis, review uncertainty, and return to the normal coding workflow.

Do not create a human wizard or a central project skill around the prompt.

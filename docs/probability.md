# AI and MTTH scenario analysis

The probability tools explain weighted HOI4 logic under explicit world-state scenarios. They inspect real mod source or proposed in-memory source, show which conditions and modifiers apply, calculate only probabilities supported by the selected HOI4 surface, and keep every unresolved input visible.

Use them for event timing and option weights, decision and mission scores, focus selection, technology and doctrine selection, direct random chances, `random_list`, supported AI strategy factors, and declared custom weighted pools.

| Tool                        | Use                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `hoi4.probability_inspect`  | Discover weighted blocks, adapters, candidates, provenance, capabilities, and unsupported constructs.                           |
| `hoi4.probability_evaluate` | Evaluate eligibility, modifier traces, raw values, proven probabilities, and MTTH horizon chances across scenarios.             |
| `hoi4.probability_sweep`    | Sweep declared ranges and locate sensitivity changes, breakpoints, and rank reversals.                                          |
| `hoi4.probability_simulate` | Sample declared distributions with a deterministic seed and confidence intervals.                                               |
| `hoi4.probability_sequence` | Analyze only recovery, caps, cooldowns, removal, resets, timers, and terminal states declared by a custom pool manifest.        |
| `hoi4.probability_compare`  | Attribute changes in eligibility, modifiers, values, probabilities, timing, ranks, and unresolved analysis to a proposed patch. |
| `hoi4.probability_render`   | Render cached ranking, matrix, waterfall, timing, sensitivity, sequence, comparison, and unresolved views.                      |

All seven tools are read-only. Proposed source is parsed in memory and never written. When an installed game root is configured, evaluation fails closed unless `launcher-settings.json` identifies the supported HOI4 build and checksum. Results otherwise state that they target the adapter version without claiming local-game verification.

## Scenarios

A scenario contains only state the caller is willing to declare. Missing values stay unresolved. Alternatives and ranges produce exact branches or bounds; probability distributions require `hoi4.probability_simulate`.

```json
{
  "schemaVersion": "1.0",
  "id": "route_states",
  "scenarios": [
    {
      "id": "defensive_war",
      "actor": "EXM",
      "date": "1939.9.1",
      "state": {
        "has_war": true,
        "variable.foreign_influence": 45,
        "focus.external_factors_complete": true
      },
      "flags": ["route_independent"]
    }
  ]
}
```

Focus, technology, and doctrine probabilities require a complete candidate pool. Their engine rule is an independent uniform score race, not weight divided by total weight. Focus scenarios use `focus.external_factors_complete: true` only after the caller has supplied every relevant prerequisite and strategy factor. Technology and doctrine scenarios use `technology.external_factors_complete: true` only after cost, date, bonus, strategy, and candidate effects are accounted for.

Decision and mission adapters intentionally return scores and ranks without inventing normalized probabilities. Event-option and `random_list` adapters normalize only their complete local pools. Direct random remains an independent percentage. MTTH horizon chance uses the versioned game timing model and returns a bound when an inactive-to-active polling phase is unknown.

Named acceptance bands and configurable diagnostic thresholds let a test suite state intended probability, timing, starvation, dominance, prevalence, and sensitivity limits. Evaluate, sweep, and simulation requests can name the metrics of interest; that set is retained in result metadata while the authoritative result keeps the eligibility and trace context required to explain them. Sweeps enumerate declared alternatives exactly, add trigger breakpoints and their adjacent values for continuous ranges, and report local elasticities, pairwise interactions, rank reversals, cliffs, and missed target bands. Sweep expansion is bounded and rejected before it can silently truncate the requested analysis.

## Results

Authoritative JSON keeps these fields separate:

- eligibility;
- raw value or raw interval;
- conditional selection probability or deterministic probability interval;
- effective MTTH and cumulative time chance;
- sampled frequency and statistical confidence interval;
- scenario prevalence.

Every candidate includes source provenance with a stable AST path, an ordered modifier trace, support level, and unresolved analysis. `external` support means the parsed candidate is valid but its surrounding game factors were not fully declared. The tool response stays compact; complete matrices, traces, simulations, comparisons, and visuals are linked MCP resources.

Nested `random_list` entries report both their conditional share inside the immediate list and their full path probability through every enclosing list. Dynamic parent paths remain explicit unresolved evidence.

Deterministic simulation uses constant-memory Latin hypercube sampling by default, with seeded pseudo-random sampling available when requested. Numeric distributions can use a Gaussian copula correlation matrix. Discrete or categorical correlation requests are sampled independently and reported as unresolved instead of being approximated silently. Simulation reports Wilson intervals, effective sample count, global input importance, and HOI4 daily-hazard MTTH samples. Timing quantiles use a deterministic bounded reservoir and include their confidence basis and retained sample count.

## Proposed patches

Pass `inlineClausewitz` or `virtualPatch` in a source selector to analyze text without writing it. `hoi4.probability_compare` evaluates the before and after source under the same scenarios and attributes each changed rank, score, probability, or uncertainty to its modifier trace.

## Declared sequences

Sequence analysis accepts a `customPoolManifest`. The manifest is the complete model boundary: candidates, selection mode, cadence, state, recovery, caps, cooldowns, removals, resets, timer changes, and terminal states. Small finite systems use exact state distributions, bounded systems expose omitted beam mass, and large systems use deterministic seeded Monte Carlo. Results include per-candidate and per-category next-choice probability, expected selections, ever-selected probability, starvation, and expected first-selection day. The analyzer never executes event effects or infers wider campaign state.

## Visual review

`hoi4.probability_render` produces deterministic ranking, matrix, waterfall, timing-survival, sensitivity, threshold, sequence, comparison, and unresolved views. Filters can select scenarios, candidates, and metrics. Pass the scenario hash returned by evaluation as `expectedScenarioHash` when a caller needs a render bound to that exact analysis; a stale hash returns a structured stale-result diagnostic and no visual artifact.

Adapter evidence and known boundaries are recorded in [probability-adapter-evidence.md](research/probability-adapter-evidence.md).

Callable argument examples are in [`examples/probability`](../examples/probability). Generated JSON Schemas for every operation, scenario sets, custom pools, and authoritative results are in [`schemas`](../schemas).

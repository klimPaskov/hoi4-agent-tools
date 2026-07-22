# Specification 09: AI and MTTH Scenario Analyzer

## 1. Purpose

Build a read-only MCP tool family that makes weighted HOI4 logic understandable to a coding agent.

A coding agent should be able to provide a real source block or proposed block, define one or more world-state scenarios, and receive a source-linked explanation of:

- which outcomes are eligible
- which conditions are true, false, or unresolved
- the base score or timing value
- every modifier that applied or did not apply
- the final raw score for each outcome
- normalized selection probability when the complete pool and surface semantics permit it
- cumulative chance within a requested time horizon when timing semantics are known
- the most and least likely outcomes under each scenario
- threshold conditions that make an outcome dominant, rare, or impossible
- how a patch changes rankings, probabilities, timing, and uncertainty

The tool must solve inspection and validation problems. A graph or calculator that only repeats base factors is insufficient.

## 2. Product boundary

The analyzer is for coding agents through MCP.

It must not:

- generate or rewrite gameplay source
- choose intended probabilities or balance targets
- claim to simulate the full HOI4 strategic AI
- execute arbitrary effects
- infer hidden runtime state from incomplete inputs
- turn every weight-like number into a probability
- normalize candidates when the candidate pool is incomplete
- present sampled frequency as exact engine probability
- launch or control HOI4
- create a human-facing editor or dashboard

The tool may inspect source, evaluate declared scenarios, generate analysis resources, compare virtual source states, and report defects. All public operations are read-only.

## 3. Supported weighted surfaces

Provide versioned adapters for:

- event `mean_time_to_happen`
- event option `ai_chance`
- decision and mission `ai_will_do`
- national focus `ai_will_do`
- technology and doctrine `ai_will_do`
- direct `random` chance blocks
- `random_list` and other supported weighted lists
- supported AI strategy factors that influence a known selection surface
- project-defined weighted pools described by an explicit transition manifest

Each adapter must state whether it can produce:

- eligibility only
- a raw score only
- a normalized conditional probability
- a time distribution
- a sampled sequence distribution

Do not share one generic formula across surfaces whose engine selection rules differ.

## 4. Source and proposal inputs

Accept:

- a workspace source location
- an event, focus, decision, technology, helper, or option identifier
- a bounded file or namespace selection
- inline Clausewitz source
- a virtual patch or before-and-after source pair
- a complete explicit candidate pool
- a custom weighted-pool manifest

Every parsed block and computed term must retain file, line, column, AST path, identifier, and helper-expansion provenance where available.

Unsupported meta expansion, dynamic identifiers, script values, scripted localisation, custom effects, or ambiguous scopes must remain unresolved. Never replace them with guessed constants.

## 5. Scenario model

A scenario can define:

- actor and relevant scopes
- date and elapsed time
- flags, variables, arrays, event targets, and saved scopes
- country, state, diplomacy, war, ideology, resource, and production facts
- DLC, rules, difficulty, and historical mode where the adapter needs them
- candidate availability
- exact values
- enumerated alternatives
- bounded numeric ranges
- named probability distributions
- correlations between uncertain values
- scheduled state changes across a time horizon

Use three-valued trigger evaluation: true, false, or unresolved.

An unresolved trigger must propagate into an interval, branch set, or sampled uncertainty result. It must not silently become false or true.

## 6. Analysis modes

### Exact snapshot

Evaluate one fixed scenario. Return eligibility, raw values, modifier traces, normalized probabilities where valid, and blockers.

### Scenario matrix

Evaluate many named scenarios and rank outcomes in each. Show scenario coverage, dominance, starvation, and reversals.

### Parameter sweep

Vary one or more inputs across declared ranges. Detect breakpoints, ordering changes, plateaus, cliffs, and pairwise interactions.

### Time-horizon analysis

For supported MTTH or scheduled hazard surfaces, calculate effective timing, cumulative chance by date, quantiles, survival probability, and the contribution of each scheduled state interval.

### Monte Carlo analysis

Sample uncertain inputs and supported state transitions with a deterministic seed. Report estimates, confidence intervals, convergence, and rare-outcome limits.

### Stateful pool sequence analysis

For a declared custom pool, simulate only the selection state described by the manifest, such as weight recovery, cap reduction, cooldown, removal, reset, timer compression, and category growth. Return likely next outcomes, top sequence paths, expected waiting times, count distributions, and starvation risk.

Do not execute arbitrary gameplay effects. State changes outside the manifest remain fixed or unresolved.

### Comparison

Compare revisions, source snapshots, or proposed source. Attribute every material probability or timing change to changed conditions, weights, candidates, transitions, or unsupported analysis.

## 7. Required explanations

For every candidate, provide:

- eligibility result and trigger trace
- base value
- ordered applied modifiers
- ordered skipped modifiers and their failed conditions
- unresolved modifiers
- final raw value or interval
- pool denominator and candidate set when normalization is valid
- conditional selection probability or interval
- time-horizon values when valid
- rank and rank changes
- source locations for every term

For every scenario, provide:

- top outcomes
- bottom eligible outcomes
- impossible outcomes
- unresolved outcomes
- dominant factors
- closest ranking reversal
- incomplete-pool warning
- adapter confidence and game-version identity

## 8. Diagnostics

Detect at least:

- all eligible weights equal zero
- negative or non-finite values
- missing fallback option where the surface requires one
- candidate pool incomplete or inconsistent
- outcome never eligible across supplied scenarios
- eligible outcome that is effectively starved
- one outcome dominant across nearly every supplied scenario
- rare outcome unexpectedly common
- intended common outcome unreachable
- modifier with no satisfiable supplied scenario
- conflicting or duplicate modifier conditions
- large discontinuity caused by one threshold
- multiplication chain with extreme order-of-magnitude growth
- MTTH horizon with negligible chance
- time schedule with uncovered intervals
- unknown input that controls most of the result
- Monte Carlo sample too small for the reported rare outcome
- correlated inputs sampled as independent
- before-and-after regression in a named acceptance band
- unsupported construct hidden behind a seemingly precise number

Diagnostics must distinguish confirmed defects, probable risks, design observations, and unresolved analysis.

## 9. Artifacts

JSON is authoritative. Also support:

- scenario ranking table
- probability matrix
- modifier waterfall
- timing and survival curve
- sensitivity curve
- threshold map
- stateful sequence tree
- before-and-after comparison
- unresolved-input report

Generate SVG and PNG where a visual improves agent inspection. Optional HTML may bundle the resources, but it is not a supported human application.

## 10. Reproducibility and performance

Record:

- workspace identity
- source revision or content hashes
- game and adapter version
- scenario-set hash
- candidate-pool hash
- random seed
- sample count
- numerical precision
- unsupported constructs
- generated resource URIs

Use incremental indexing and cached expression evaluation. Unchanged inputs must produce stable candidate IDs, trace IDs, ordering, exact results, and seeded sampled results.

## 11. Completion standard

The tool is complete only when a coding agent can inspect a large weighted system, define representative and uncertain world states, understand why outcomes rank as they do, calculate supported timing and choice probabilities, find edge cases and dominance problems, compare a patch, and identify every limit without editing source or launching the game.

# Specification 09a: Probability and Uncertainty Model

## 1. Metric names are strict

The result model must keep these concepts separate:

- **eligibility**: whether a candidate can participate
- **raw value**: the evaluated factor, score, chance, or timing value before pool normalization
- **conditional selection probability**: candidate share inside a complete categorical pool
- **effective MTTH**: the evaluated timing parameter for a supported adapter
- **cumulative chance**: chance of at least one occurrence within a horizon under stated polling or hazard rules
- **sampled frequency**: observed share in a seeded simulation
- **scenario prevalence**: share of user-supplied or sampled world states in which a condition holds

Never label one metric as another.

## 2. Deterministic numeric model

Use decimal or rational arithmetic for parsed constants and deterministic modifier chains. Preserve the written value and evaluated value.

For a supported categorical pool with complete eligible candidates and non-negative weights:

```text
P(candidate i | one selection) = weight_i / sum(all eligible weights)
```

Apply this formula only when the surface adapter declares that the engine performs categorical weighted selection at that point.

If the denominator is zero, return an explicit zero-pool diagnostic. Do not invent equal probabilities.

## 3. Modifier evaluation

Each adapter defines order and meaning for `base`, `factor`, `add`, modifiers, clamps, and unsupported terms.

The trace must preserve:

1. starting value
2. condition result for each term
3. operation
4. operand
5. intermediate value
6. source location
7. scope and helper call path

A modifier whose condition is unresolved creates a branch or interval. It does not disappear.

## 4. MTTH and time conversion

Do not hardcode one MTTH formula for every game version or surface.

Each MTTH adapter must expose:

- the verified engine interpretation
- polling interval or evaluation schedule
- whether the named MTTH is a median, mean, or another parameter
- the per-check or continuous hazard conversion
- trigger re-evaluation behavior
- whether state changes reset, preserve, or alter accumulated chance
- the documentation and fixture proving the rule

For generic declared models, support both:

```text
Discrete checks: F(n) = 1 - (1 - p)^n
Continuous median parameter m: F(t) = 1 - 2^(-t / m)
```

The result must name which model was used. These generic formulas must not be presented as verified HOI4 semantics unless the adapter evidence supports them.

For time-varying discrete risk, combine interval survival:

```text
S(total) = product(1 - p_interval)^(checks_in_interval)
F(total) = 1 - S(total)
```

For time-varying continuous hazard, integrate or piecewise-combine survival according to the adapter model.

## 5. Unknown and partial inputs

Use three-valued logic and interval propagation.

For an unresolved boolean branch, evaluate each satisfiable branch when practical. Return:

- minimum value
- maximum value
- branch conditions
- branch count
- conditions that control the interval

For missing candidate pools, return raw values and bounded statements only. Never show a normalized probability with a fake denominator.

For an input range, use interval arithmetic when monotonicity is proven. Use bounded search or sampling when it is not.

## 6. Scenario matrices

A scenario matrix is user-defined coverage, not a probability distribution unless row weights are supplied.

Report separately:

- result in each named row
- weighted aggregate when row prevalence is explicitly provided
- unweighted coverage count
- scenario assumptions

Do not say an outcome has a 70 percent campaign chance because it wins seven of ten hand-written scenarios.

## 7. Sampling

Monte Carlo output must record:

- deterministic seed
- random-number generator identity
- sample count
- burn-in when a stateful model needs it
- convergence checks
- confidence interval method
- effective sample size when samples are correlated
- observed rare-event count

Use Wilson or another documented interval for categorical frequencies. Use quantile uncertainty for timing distributions.

When a reported event occurs too few times for a stable estimate, label it unresolved at the requested precision. Do not display excessive decimal places.

Support stratified or Latin-hypercube sampling for broad continuous ranges. Preserve declared correlations.

## 8. Sensitivity and dominance

Provide:

- one-way sweeps
- breakpoint detection
- rank reversal points
- local elasticity where meaningful
- pairwise interaction checks for selected variables
- global importance for sampled uncertain inputs
- dominant-condition explanation

Do not generate balance advice automatically. The analyzer can report that one factor controls most outcomes or that a target band is missed. The coding agent decides how to change the design.

## 9. Stateful weighted pools

A custom pool manifest may declare:

- initial weights and caps
- eligibility
- recovery rate and cadence
- cap changes after selection
- one-time removal
- cooldowns
- category resets
- timer range and compression
- state variables updated by selection
- terminal conditions

The sequence engine may evaluate only those declared transitions.

Use exact dynamic programming for small finite state spaces. Use top-k beam search for readable likely paths. Use seeded Monte Carlo for large or continuous states. Report which method produced each result.

Do not execute event effects, country behavior, wars, economy, or map changes. These belong in the scenario schedule or remain outside the model.

## 10. Comparison rules

A comparison must separate changes caused by:

- candidate eligibility
- candidate addition or removal
- base value
- modifier condition
- modifier magnitude
- timing schedule
- pool transition
- scenario definition
- adapter version
- newly unsupported analysis

A change in adapter or scenario assumptions must not be presented as a source-code regression.

## 11. Numerical reporting

Include enough precision to review the result, but avoid false precision.

Every estimated metric must show whether it is:

- exact
- bounded
- sampled
- score-only
- unsupported

Every displayed percentage must retain its numerator, denominator, formula, or sampling basis in JSON.

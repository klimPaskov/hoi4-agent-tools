# Specification 09b: Clausewitz Weight Adapters

## 1. Adapter registry

Weighted HOI4 surfaces do not share one selection algorithm. Implement a versioned adapter registry.

Each adapter records:

- adapter ID and semantic version
- supported game versions
- source block types
- candidate discovery rules
- eligibility rules
- modifier order
- pool normalization rules
- evaluation cadence
- timing conversion when relevant
- scope expectations
- supported trigger and value expressions
- unsupported constructs
- documentation and test fixtures
- confidence level

An adapter must fail closed when the installed game version or source form is unsupported.

## 2. Shared parsing

Reuse the existing parser, AST, workspace resolver, source map, symbol index, constants resolver, trigger index, and helper call graph.

Resolve where supported:

- file-scoped `@` constants
- `common/script_constants`
- scripted triggers
- scripted values
- named modifiers
- scopes and event targets
- arrays and variables
- DLC and rule gates
- helper expansion

Preserve raw unsupported blocks. Do not simplify or rewrite source.

## 3. Trigger evaluation tiers

Classify trigger support:

- **exact**: evaluated from declared scenario state
- **bounded**: all satisfiable outcomes can be enumerated or interval-bounded
- **sampled**: scenario supplies a distribution for the unknown input
- **external**: depends on engine state not represented by the scenario
- **unsupported**: parser or semantics are not implemented

Propagate the weakest material tier into the result.

## 4. Event MTTH adapter

Inspect the event trigger, `mean_time_to_happen`, modifier conditions, calling scope, and evaluation cadence.

Return:

- trigger eligibility
- effective timing parameter
- modifier trace
- cumulative chance and quantiles only when the game-version timing model is verified
- scheduled-state contribution
- unresolved trigger or cadence limits

Do not assume the trigger remains true across the horizon. Require a schedule or state model for changing conditions.

## 5. Event option `ai_chance` adapter

Discover every AI-selectable option in the event and the option fallback behavior.

Return raw option weights and normalized conditional option probabilities only when the complete option set is known.

Account for option availability and any adapter-defined default behavior. Report all-zero option pools and options that can never be chosen under supplied scenarios.

## 6. Decision and mission `ai_will_do` adapter

Separate:

- decision visibility and availability
- AI check cadence
- raw willingness score
- target selection
- cost and cooldown gates
- competition with other decisions when the engine semantics can be represented

A willingness score is not automatically a click probability. Produce a probability only when the adapter has the required candidate set, cadence, and selection semantics. Otherwise return score, rank, and scenario sensitivity.

## 7. National focus adapter

Evaluate available focus candidates, bypass state, prerequisites, ongoing-focus restrictions, AI factors, and supported strategy modifiers.

Return conditional next-focus probability only for a complete candidate set and verified selection adapter. Long-route simulation requires an explicit transition manifest or a bounded tree state supplied by the caller.

Do not simulate wars, diplomacy, focus effects, or future availability unless they are declared as transitions.

## 8. Technology and doctrine adapter

Evaluate research availability, category restrictions, ahead-of-time state, path exclusions, research-slot context, AI factors, and supported strategy modifiers.

Return raw priority and conditional selection probability only where the complete research candidate pool and adapter semantics are known.

Do not treat research time as selection weight. Do not infer future industry or equipment state.

## 9. Direct random adapters

For direct percentage chance, return the declared chance after supported modifiers or clamps.

For `random_list`, discover all eligible entries and evaluate the surface-specific weight rules. Normalize only a complete eligible list.

Nested random blocks must retain path probability and source provenance. Unsupported dynamic entry creation remains unresolved.

## 10. AI strategy adapters

AI strategy factors often modify another decision surface and may not be probabilities themselves.

Return:

- active strategy factors
- affected target or behavior
- modifier trace
- downstream adapter links when known

Do not normalize standalone strategy values unless the engine documentation defines a categorical pool.

## 11. Custom pool adapter

Allow a mod to describe a weighted selection system with the custom-pool schema.

The manifest must identify:

- source candidates
- eligibility expressions
- weight expressions
- normalization event
- selection cadence
- state transitions
- reset and terminal behavior

The adapter validates that every transition field is declared. Unknown effects are ignored only with a visible unresolved warning.

## 12. Proposed-source mode

The caller may submit inline source or a virtual patch.

Parse it in an isolated overlay without writing to disk. Resolve dependencies against the selected workspace revision. Record the virtual-source hash and changed AST paths.

Before-and-after comparison must use the same adapter and scenario set unless the caller explicitly requests an assumption change.

## 13. Version verification

Before implementation, inspect current official documentation, local game documentation, vanilla examples, and focused empirical fixtures for every adapter.

Store the evidence path and tested game version in adapter metadata. When a game update changes semantics, invalidate stale cached probability claims.

# Specification 09d: Validation and Acceptance

## 1. Test layers

Add:

- parser and source-map tests
- adapter semantic tests
- exact arithmetic tests
- interval and three-valued logic tests
- probability identity tests
- timing and survival tests
- Monte Carlo calibration tests
- seeded reproducibility tests
- sensitivity and breakpoint tests
- custom-pool transition tests
- comparison attribution tests
- MCP schema and annotation tests
- cancellation and stale-result tests
- workspace isolation tests
- resource retrieval tests

## 2. Mathematical properties

Test at least:

- normalized eligible probabilities sum to one within declared tolerance
- multiplying every weight in a categorical pool by the same positive constant does not change shares
- adding an ineligible candidate does not change shares
- increasing one positive weight cannot lower its own categorical share when other values stay fixed
- zero weight never wins a positive-weight pool
- interval results contain exact endpoint evaluations where monotonicity is claimed
- cumulative chance never decreases over time
- survival stays between zero and one
- identical seed and inputs reproduce sampled output
- exact and sampled results agree within the declared confidence target on supported fixtures
- before-and-after identity produces no regression

## 3. Synthetic fixture

Create a project-owned fixture containing at least:

- 150 weighted source blocks
- 40 focus candidate sets
- 30 decision or mission candidate sets
- 20 technology or doctrine candidate sets
- 25 event option sets
- 20 direct random or `random_list` sets
- 15 MTTH event families
- nested scripted triggers and constants
- exact, unresolved, bounded, and sampled inputs
- modifier stacking and threshold cliffs
- complete and intentionally incomplete pools
- all-zero and negative-value defect cases
- dynamic identifiers that must remain unresolved
- one stateful weighted pool with recovery, cap reduction, cooldown, removal, reset, category growth, and timer transitions
- 250 named scenario rows

Maintain an expected-result manifest with exact candidate values, probabilities, timing points, diagnostics, and source locations.

## 4. Stateful pool fixture

The pool fixture must prove:

- next-selection probabilities
- weight recovery over time
- cap reduction after repeat selection
- one-time removal
- cooldown expiration
- major-category growth
- category reset after major selection
- timer compression and reset
- expected time to first major outcome
- top sequence paths
- starvation detection
- deterministic seeded results

No arbitrary gameplay effect may influence the fixture unless it is expressed as a declared transition.

## 5. Unknown-input tests

Include:

- unresolved boolean conditions
- numeric ranges
- enumerated state alternatives
- correlated distributions
- scheduled trigger changes
- incomplete scope information
- unsupported meta-generated IDs

Prove that the tool returns bounds or unresolved results and never silently substitutes defaults.

## 6. Adapter integration tests

Against the locally installed game version, test at least one substantial example for every implemented adapter.

Use vanilla and approved external mods as read-only inputs. Do not copy their source into the public repository.

Record:

- game version
- adapter version
- source hash
- tested surface
- expected interpretation
- unsupported constructs

## 7. Empirical verification

Where static documentation is insufficient, create small local test fixtures to verify selection or timing semantics. Keep the public test data project-owned.

Do not require automated game launching as part of the public analyzer. Empirical adapter research can be a development task performed separately and documented with reproducible fixture results.

## 8. MCP acceptance

Prove:

- every public operation is read-only
- tool schemas reject malformed scenario sets
- inspect identifies required inputs
- exact evaluation returns source-linked traces
- sweep finds known breakpoints and rank reversals
- simulation reports seed, intervals, and convergence
- sequence analysis honors every declared transition
- compare attributes known changes correctly
- render resources match the authoritative result hash
- cancellation stops long runs cleanly
- stale source or scenario hashes invalidate old claims
- no operation writes to the mod or vanilla roots

## 9. Performance

Measure:

- cold workspace indexing
- cached single-block evaluation
- 250-row scenario matrix
- one million simple sampled draws
- stateful sequence analysis at several state-space sizes
- large trace resource retrieval

Set performance budgets after measurement. Do not hide accuracy loss behind an undocumented fast mode.

## 10. Completion gate

Do not mark the tool complete if:

- two weighted surfaces share one unverified adapter
- normalized probabilities can be produced from incomplete pools
- MTTH timing is presented without a verified model
- unresolved conditions are treated as false or zero
- sample results omit seed or uncertainty
- stateful analysis executes undeclared effects
- comparison cannot separate source changes from assumption changes
- source provenance is missing
- any public operation can edit gameplay files
- the synthetic fixture or local adapter integration tests are incomplete

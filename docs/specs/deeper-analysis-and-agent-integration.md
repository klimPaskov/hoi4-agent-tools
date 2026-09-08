# Deeper analysis and agent integration

## Acceptance and boundaries

Accepted by the user's explicit implementation request on 2026-09-06, following the five-stage plan in this task.
This document tracks implementation and evidence; an unchecked requirement is not complete.
The product remains a standalone, mod-independent MCP server with one shared core.
Project-specific suites and integration rules belong to the external mod, not the public package.
No dashboard, manual editor, central MCP skill, game launching, gameplay redesign, or copied proprietary fixtures are authorized.
Existing calls and optional private extension routes remain compatible.
Do not restart coding-agent applications or interrupt their active MCP processes.

## Stage 1: GUI correctness — planned 3.0.9

- [x] Replace GUI scenario trigger regexes with structured, shared condition evaluation.
- [x] Cover inclusive comparisons, Boolean combinations, negation, helpers, constants, and explicit scopes.
- [x] Preserve probability semantics, explicit values, seeded exploration, and placeholder previews.
- [x] Keep unknown conditions unresolved; never rank or guess a branch as proven eligible.
- [x] Reproduce the three observed helper failures and test the complete generation-to-render path.
- [ ] Complete release qualification, publication verification, and side-by-side local installation.

## Stage 2: Incremental analysis and persistent jobs — planned 3.1.0

- [ ] Cache per-file parsed/indexed segments and reverse dependencies; invalidate additions, removals, renames, load-order changes, aliases, and same-size/same-timestamp edits.
- [ ] Reuse content-addressed analysis across authorized local processes without sharing private results across workspace/principal boundaries.
- [ ] Expand event/technology helper closure incrementally with source-revision-bound checkpoints and exact coverage boundaries.
- [ ] Add persistent jobs, bounded CPU workers, responsive control traffic, cancellation, and result retrieval.
- [ ] Recover read-only work from checkpoints and reconcile rewrite outcomes through transaction journals.
- [ ] Deduplicate background rewrites using caller-reusable request keys; never blindly replay an uncertain write.
- [ ] Add native negotiated MCP task adapters and ordinary `hoi4.job_inspect` / `hoi4.job_cancel` compatibility tools.
- [ ] Prove crash recovery, isolation, incremental/full-rebuild equivalence, and release/install qualification.

## Stage 3: Cross-system impact and decisions — planned 3.2.0

- [ ] Add `hoi4.impact_inspect` over the shared graph: symbols, locations, changed files, proposed overlays, active/overridden definitions, consumers, affected files, and scenario suites.
- [ ] Connect events, focuses, decisions, ideas, technologies, helpers, variables, flags, targets, localisation, GUI, and assets.
- [ ] Add `hoi4.decision_inspect`: inventory, eligibility, targets, affordability/payment, cooldowns, mission completion/cancellation/timeout, and comparisons.
- [ ] Reuse the probability service for AI scores and retain exact unresolved dynamic-reference evidence.
- [ ] Test broken multi-system connections and actor/target scope distinctions; qualify release and installation.

## Stage 4: Mechanic tests, packages, and suites — planned 3.3.0

- [ ] Introduce one shared scenario model with adapters for existing GUI/probability inputs.
- [ ] Add `hoi4.mechanic_test` as bounded source execution on isolated scenario state, not campaign simulation.
- [ ] Support variables/arithmetic, flags, targets, arrays, conditionals, finite declared scope iteration, scripted helpers, documented balance operations, and supported dynamic substitutions.
- [ ] Execute explicit steps/time advances; unsupported operations make dependent assertions unresolved.
- [ ] Test conservation, array alignment, affordability/payment, repeated setup, single payments, exclusivity, cleanup, and end states.
- [ ] Add `hoi4.package_check` for declarative definitions, calls, registrations, localisation, assets, and required tests; prohibit embedded code and arbitrary commands.
- [ ] Add `hoi4.scenario_test` for inline/workspace-relative suites using typed domain services, named cases, source selectors, assertions, and views.
- [ ] Batch/resume large suites without silently dropping cases.
- [ ] Prove intentional failures, unknown-input handling, deterministic traces, and release/install qualification.

## Stage 5: Domain refinement and visual regression — planned 3.4.0

- [ ] Focus: branch-local cleanup, pinned anchors, symmetry groups, preserved unaffected branches/gameplay, connector measurements, problem crops, incompatible-constraint explanations, and scenario-backed feasibility/choice diagnostics.
- [ ] GUI: visibility/boundary branch coverage, hidden/disabled explanations, label/background measurements, and matched source-baseline comparison through `gui_render`; preserve `comparisonScenario` semantics.
- [ ] Probability: source-backed catalogs, minimal missing inputs, and complete eligible/excluded/unresolved inventories.
- [ ] Events: chain-selectable comparisons and revision-bound lazy helper/scope expansion.
- [ ] Technology: native folder composition, backgrounds, subtechnology placement, year styling, supported scenario presentation, and unchanged read-only boundary.
- [ ] Map: lightweight lookups, reusable tiles, affected-area rendering, and typed external script references for renumbering without arbitrary numeric replacements.
- [ ] Prove diagnostic precision, unrelated-content preservation, matched visual identities, and release/install qualification.

## Cross-stage validation

- [ ] Every release: complete existing tests, Windows/Linux and Node matrix, both transports, official MCP Inspector, installation, and exact public publication checks.
- [ ] At least 64 concurrent mixed-domain requests across 16 clients and two workspaces, with cancellations, disconnects, worker failures, and recovery.
- [ ] Rewrite crash points before/during/after commit; no duplicate changes or cross-job artifact deletion.
- [ ] Focus fixtures with 1,024, 4,096, and 10,000 nodes, including chains, wide branches, convergences, anchors, and incompatible constraints.
- [ ] Complete large helper/candidate analysis and explicit continuations.
- [ ] GUI branch/list/flag/texticon/font/colour/native/fractional-scale and screenshot-backed regressions.
- [ ] Map pixel, semantic, connectivity, and external-reference regressions.

Public CI uses project-owned synthetic fixtures.
Local installed-game/mod checks remain opt-in and never launch the game or copy proprietary material into the public repository.
Measure avoided parsing, bounded memory, fairness, and control responsiveness rather than claiming unlimited concurrency or universal timings.

## External workflow integration and rollout

- [ ] Create external mod-owned profiles under its chosen testing directory; no path convention is required by the server.
- [ ] Cover meter/settings/insurgency GUI states, transfer invariants, event integration, and representative focus/technology surfaces in the requested external test workspace.
- [ ] Use supplied screenshots with explicit matching scenarios; never hide discrepancies with sharpening, resizing, or changed test inputs.
- [ ] Update existing owner-skill, subagent, and AGENTS sections without setup guidance or a central MCP skill.
- [ ] Route non-trivial skill changes through the requested skill-maintenance specialist; edit canonical runtime instructions and use existing generators while preserving unrelated changes.
- [ ] Keep mechanic-specific facts in profiles and report external gameplay defects separately, without editing gameplay to make tests pass.
- [ ] Commit/publish only completed stages; synchronize versions, schemas, documentation, and Registry metadata.
- [ ] Install verified versions side-by-side and preserve active processes; retain historical tags while keeping one latest public release entry after verification.

Planned versions use the next unused compatible version if the registry advances.
No stage is complete until its code, tests, public package, installation, and applicable integration have evidence.

## Evidence ledger

No stage completed yet.
The implementation began from commit `d8a8117b18649eee622f9acb44c11462a1ee9950` (3.0.8).

Stage 1 implementation and targeted regressions are present; release qualification remains pending.
The independent condition and production GUI pipeline suites passed 80 tests on 2026-09-08, including explicit `variables`, `stateValues`, and scoped operands.
The existing GUI, probability, and GUI-scan suites passed 72 tests after the final input-precedence corrections.
The first full release run passed 552 tests across five shards and failed the sparse-mod stdio test at its 45-second outer deadline; shards six through eight were not reached.
An instrumented rerun completed initialization and source-backed focus inspection in about 61 seconds with progress notifications and the correct workspace.
The stdio regression now gives both RPC waits and teardown an explicit overall budget and refreshes only a matching tool-progress idle timeout.
The corrected test passed in 108.8 seconds on this host; that is functional evidence, not a responsiveness pass, and the latency remains a Stage 2 finding.
The remaining shards and clean full-matrix release qualification are pending.
See [the shared-condition decision](../adr/0027-shared-condition-evaluation.md) for the architecture and remaining interpreter boundaries.

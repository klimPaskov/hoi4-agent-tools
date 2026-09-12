# Deeper analysis and agent integration

## Acceptance and boundaries

Accepted by the user's explicit implementation request on 2026-09-06, following the five-stage plan in this task.
This document tracks implementation and evidence; an unchecked requirement is not complete.
The product remains a standalone, mod-independent MCP server with one shared core.
Project-specific suites and integration rules belong to the external mod, not the public package.
No dashboard, manual editor, central MCP skill, game launching, gameplay redesign, or copied proprietary fixtures are authorized.
Existing calls and optional private extension routes remain compatible.
Do not restart coding-agent applications or interrupt their active MCP processes.

## Stage 1: GUI correctness — released 3.0.9

- [x] Replace GUI scenario trigger regexes with structured, shared condition evaluation.
- [x] Cover inclusive comparisons, Boolean combinations, negation, helpers, constants, and explicit scopes.
- [x] Preserve probability semantics, explicit values, seeded exploration, and placeholder previews.
- [x] Keep unknown conditions unresolved; never rank or guess a branch as proven eligible.
- [x] Reproduce the three observed helper failures and test the complete generation-to-render path.
- [x] Complete release qualification, publication verification, and side-by-side local installation.

## Stage 2: Incremental analysis and persistent jobs — candidate 3.1.0

- [x] Cache per-file parsed/indexed segments and reverse dependencies; invalidate additions, removals, renames, load-order changes, aliases, and same-size/same-timestamp edits.
- [x] Reuse content-addressed analysis across authorized local processes without sharing private results across workspace/principal boundaries.
- [x] Expand event/technology helper closure incrementally with source-revision-bound checkpoints and exact coverage boundaries.
- [x] Add persistent jobs, bounded CPU workers, responsive control traffic, cancellation, and result retrieval.
- [x] Recover read-only work from checkpoints and reconcile rewrite outcomes through transaction journals.
- [x] Deduplicate background rewrites using caller-reusable request keys; never blindly replay an uncertain write.
- [x] Add native negotiated MCP task adapters and ordinary `hoi4.job_inspect` / `hoi4.job_cancel` compatibility tools.
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
- [x] At least 64 concurrent mixed-domain requests across 16 clients and two workspaces, with cancellations, disconnects, worker failures, and recovery.
- [x] Rewrite crash points before/during/after commit; no duplicate changes or cross-job artifact deletion.
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

Stage 1 is release-qualified, published, and installed side-by-side.
Stages 2–5 remain incomplete.
The implementation began from commit `d8a8117b18649eee622f9acb44c11462a1ee9950` (3.0.8).

Stage 1 implementation and targeted regressions are complete; release evidence follows.
The independent condition and production GUI pipeline suites passed 80 tests on 2026-09-08, including explicit `variables`, `stateValues`, and scoped operands.
The existing GUI, probability, and GUI-scan suites passed 72 tests after the final input-precedence corrections.
The first full release run passed 552 tests across five shards and failed the sparse-mod stdio test at its 45-second outer deadline; shards six through eight were not reached.
An instrumented rerun completed initialization and source-backed focus inspection in about 61 seconds with progress notifications and the correct workspace.
The stdio regression now gives both RPC waits and teardown an explicit overall budget and refreshes only a matching tool-progress idle timeout.
The corrected test passed in 108.8 seconds on this host; that is functional evidence, not a responsiveness pass, and the latency remains a Stage 2 finding.
All eight shards are covered in aggregate after the corrected stdio test and an npm-environment rerun of the package-path regression: 840 passing tests and one platform-specific skip.
CI on commit `7e3ac02` passed Ubuntu/Node 24 but found a Windows/Node 22 capacity-slot canonicalization race under independent stdio processes; release qualification remains blocked until the correction passes a fresh complete matrix.
The correction passed nine local capacity and mixed-transport tests, including 128 competing instances and rejection of a linked slot without modifying its outside owner.
The follow-up matrix on `8febc64` passed both Linux versions, coverage, and Inspector, but both Windows versions exposed `EPERM` while recreating a delete-pending slot.
The additional correction retries only the Windows admission race with a finite consecutive-failure boundary; fresh qualification is still required.
Candidate commit `550a99e` passed 11 local capacity and mixed-transport tests, including both deterministic Windows fault-injection cases.
CI run `34267750562` completed successfully for that exact commit on Windows and Linux with Node 22 and 24, including the container job.
Tag `v3.0.9` points to that qualified commit; release workflow `34270785407` completed successfully through npm, container, GitHub, Registry, and exact public-install verification.
Local Windows `npm run publication:install` also verified the clean published package over stdio and authenticated HTTP.
An independent versioned local installation contains 3.0.9; its 132 dependency signatures and 19 attestations verified successfully.
No active server or coding-agent process was restarted or replaced.
GitHub has one latest public release entry, v3.0.9, and both v3.0.8 and v3.0.9 tags remain.
See [the shared-condition decision](../adr/0027-shared-condition-evaluation.md) for the architecture and remaining interpreter boundaries.

Stage 2 has a complete local 3.1.0 candidate implementation; release qualification remains pending.
Content-addressed parsed documents, file-local index segments, typed reverse source dependencies, and the authenticated cross-process cache preserve exact source identities and coverage boundaries while re-enumerating and verifying current bytes.
Event and technology graphs revalidate external edits and retain revision-addressed helper and comparison evidence.
Synthetic incremental/full-rebuild cases cover additions, removals, renames, aliases, shadowing, load-order changes, same-size/same-timestamp edits, partial limits, cycles, tampering, and principal isolation.
The 1,024-, 4,096-, and 10,000-focus inventory fixtures reconstruct every definition; these Stage 2 indexing fixtures do not establish the Stage 5 layout gate.
See [incremental source segments](../adr/0028-incremental-source-segments.md) for the cache, invalidation, and helper-coverage contract.

Authenticated persistent jobs now back all event, technology, probability, map, GUI, and focus reads plus the three rewrite tools.
Fixed-entry child workers, local and cross-process admission, fenced ownership, durable cooperative cancellation, bounded retention, result-ready checkpoints, transaction bindings, and completion recipes survive process and connection boundaries without accepting commands or module selectors from clients.
Native MCP tasks preserve exact ordinary-call results, including tool-level structured errors and linked resources; `hoi4.job_inspect` and `hoi4.job_cancel` remain responsive control traffic when execution capacity is occupied.
Rewrite request keys deduplicate identical retries, reject conflicting reuse, retain mutation receipts after task expiry, and reconcile journals without replanning or blindly replaying an uncertain write.
Discovered workspace grants and principal isolation are reconstructed exactly in child workers.
See [persistent jobs](../adr/0029-persistent-jobs.md) and [the public task guide](../jobs.md) for the lifecycle contract.

Local evidence through 2026-09-12 includes 125 passing Stage 2 core tests with one platform-specific skip across 11 files, all 8 probability workflow tests, and the 64-request/16-client mixed-domain stress scenario.
A 12-file job, native-task, concurrency, and HTTP-security matrix passed 78 of 79 assertions; the only failure was a Windows `ENOTEMPTY` during temporary-fixture deletion after the reconnect assertions completed.
The fixture now uses the same bounded Windows deletion retry as the other worker suites, and the affected native-task/security subset passes all 6 assertions.
Typechecking, linting, the production build, package dry run, and Registry validation passed during candidate development.
These are development results rather than immutable release evidence.

Remaining Stage 2 gates are a reviewed candidate commit, clean generated-file checks, the complete local test and coverage commands, official Inspector qualification, Windows/Linux and Node 22/24 CI, publication, exact public-install verification, and a side-by-side local installation.
Stages 3–5 and external Chaos Redux integration have not started.

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

## Stage 2: Incremental analysis and persistent jobs — released 3.1.0

- [x] Cache per-file parsed/indexed segments and reverse dependencies; invalidate additions, removals, renames, load-order changes, aliases, and same-size/same-timestamp edits.
- [x] Reuse content-addressed analysis across authorized local processes without sharing private results across workspace/principal boundaries.
- [x] Expand event/technology helper closure incrementally with source-revision-bound checkpoints and exact coverage boundaries.
- [x] Add persistent jobs, bounded CPU workers, responsive control traffic, cancellation, and result retrieval.
- [x] Recover interrupted read-only expansion work from checkpoints and reconcile rewrite outcomes through transaction journals.
- [x] Deduplicate background rewrites using caller-reusable request keys; never blindly replay an uncertain write.
- [x] Add native negotiated MCP task adapters and ordinary `hoi4.job_inspect` / `hoi4.job_cancel` compatibility tools.
- [x] Prove crash recovery, isolation, incremental/full-rebuild equivalence, and the Windows/Linux, Node 22/24 qualification matrix.
- [x] Verify publication, exact public installation, and side-by-side local installation.

## Stage 3: Cross-system impact and decisions — 3.2.0

- [x] Add `hoi4.impact_inspect` over the shared graph: symbols, locations, changed files, proposed overlays, active/overridden definitions, consumers, affected files, and scenario suites.
- [x] Connect events, focuses, decisions, ideas, technologies, helpers, variables, flags, targets, localisation, GUI, and assets.
- [x] Add `hoi4.decision_inspect`: inventory, eligibility, targets, affordability/payment, cooldowns, mission completion/cancellation/timeout, and comparisons.
- [x] Reuse the probability service for AI scores and retain exact unresolved dynamic-reference evidence.
- [x] Test broken multi-system connections and actor/target scope distinctions; qualify release and installation.

## Stage 4: Mechanic tests, packages, and suites — released 3.3.0

- [x] Introduce one shared scenario model with adapters for existing GUI/probability inputs.
- [x] Add `hoi4.mechanic_test` as bounded source execution on isolated scenario state, not campaign simulation.
- [x] Support variables/arithmetic, flags, targets, arrays, conditionals, finite declared scope iteration, scripted helpers, documented balance operations, and supported dynamic substitutions.
- [x] Execute explicit steps/time advances; unsupported operations make dependent assertions unresolved.
- [x] Test conservation, array alignment, affordability/payment, repeated setup, single payments, exclusivity, cleanup, and end states.
- [x] Add `hoi4.package_check` for declarative definitions, calls, registrations, localisation, assets, and required tests; prohibit embedded code and arbitrary commands.
- [x] Add `hoi4.scenario_test` for inline/workspace-relative suites using typed domain services, named cases, source selectors, assertions, and views.
- [x] Batch/resume large suites without silently dropping cases.
- [x] Prove intentional failures, unknown-input handling, deterministic traces, and release/install qualification.

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
Stage 5 remains incomplete until its final release and external profile checks are recorded below.
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

The first Stage 2 candidate was incomplete; later implementation and qualification evidence follows.
Review of candidate `041f586` found that reverse source dependencies were not consumed by product analysis and that job checkpoints retained completed results, not interrupted helper-expansion progress.
At that checkpoint the published production transport adapters supported the SDK 1.x task extension, while modern-protocol routing remained local and unqualified.
Those requirements were reopened above and addressed in the subsequent candidate.
Content-addressed parsed documents, file-local index segments, typed reverse source dependencies, and the authenticated cross-process cache preserve exact source identities and coverage boundaries while re-enumerating and verifying current bytes.
Event and technology graphs revalidate external edits and retain revision-addressed helper and comparison evidence.
Synthetic incremental/full-rebuild cases cover additions, removals, renames, aliases, shadowing, load-order changes, same-size/same-timestamp edits, partial limits, cycles, tampering, and principal isolation.
The 1,024-, 4,096-, and 10,000-focus inventory fixtures reconstruct every definition; these Stage 2 indexing fixtures do not establish the Stage 5 layout gate.
See [incremental source segments](../adr/0028-incremental-source-segments.md) for the cache, invalidation, and helper-coverage contract.

Intermediate event and technology dependency frontiers bind their exact source graph, roots, ordering, visited policy, adjacency cursor, and work bounds to authenticated, eviction-pinned job resources.
The worker host permits at most two replacement attempts after proven read-worker death, never repeats an unchanged checkpoint twice, and preserves cancellation without replaying writes.
On 2026-09-13, four production-process recovery cases passed against synthetic 2,500-helper fixtures: event and technology analysis with unchanged and changed source files, each matching a clean execution's entire tool result.
The ten-file artifact/job/event/technology/frontier subset passed 110 other tests, including retained-checkpoint eviction, malformed frontiers, per-transition resume equivalence, work/cancellation boundaries, and retry policy.
The event/technology MCP-job and worker-policy/startup matrix passed 35 tests across four files, including ordinary/task result and artifact parity, launcher exit, fresh-server comparison recovery, and worker death before or immediately after the startup handshake.
Shared semantic dependency observation now feeds the typed reverse consumer graph for event and technology fragment invalidation.
Nine cases prove cached/clean graph equivalence and selective rebuilding across missing definitions, additions, edits, cycles, removals, renames, overlays, load-order changes, source-root isolation, interrupted rebuilds, and inventory eviction.
The same regression reproduced and fixed technology cache-key collisions that attributed identical source bytes to the wrong file.
The final twelve-file domain/index/cache/worker-recovery subset passed 114 tests on 2026-09-13, including both project-owned large acceptance fixtures and the interrupted-invalidation and inventory-eviction corrections.
Both inspectors implement opt-in `helper_expansion` pages with compact source-revision- and principal-bound continuation resources.
Distinct structural call paths, helper-owned state accesses and technology references are streamed under explicit page, work, depth, and cycle boundaries.
Seventeen focused tests passed on 2026-09-13, including 786,431 compact traversal records, fresh-service resumption, same-length external source edits, principal/domain/query isolation, chunked cursor loading, tampered resources, exponential helper networks, depth recovery, and exact MCP/persisted-job result parity.
The final frozen 22-file regression passed 190 tests in 232.21 seconds on this Windows host, covering the page API, large domain fixtures, complete event/technology MCP workflows, job parity, all four real-worker recovery cases, checkpoint retention, cache invalidation, and package metadata.
The candidate includes generated helper request/summary schemas and packaged continuation documentation; no stage commit, publication, installation, or full release qualification was performed for this tranche.
At that checkpoint, broader materialized-graph memory refinement and modern negotiated protocol adapters remained pending.
These targeted passes do not qualify Stage 2 for release.

The modern operation/task tranche extracts one protocol-independent execution and authorization service and one catalog for all 23 task-capable domain tools.
The 2025 adapter retains its wire contract while the candidate 2026-07-28 adapter implements per-request extension negotiation, durable flat handles, inlined polling results, cancellation acknowledgements, ignored input updates, and pre-creation client-root exchange.
The published SDK 2.0.0 task-routing gate is reproduced and handled at its public transport seam without exposing the private dispatch names or replacing envelope/era checks.
The first modern suite passed 13 tests on 2026-09-13, including official SDK ordinary calls and both connection and Fetch-based HTTP serving; 28 legacy event/technology task regressions also passed after the execution extraction.
The expanded matrix initially passed 56 of 57 tests and exposed the published SDK's failure to cancel request ID `0`.
The public transport seam preserves exact zero/empty-string wire IDs while supplying truthy private IDs to the SDK, rejects active duplicates, validates cancellations before releasing mappings, and clears mappings on completion/cancellation/close.
The corrected frozen 12-file matrix passed all 84 tests in 289.47 seconds on 2026-09-13.
It includes 16 modern integration cases, two focused zero/empty-ID regressions, all six legacy domain job/task routes, legacy authenticated HTTP tasks, metadata/context/progress contracts, and package metadata.
Modern and legacy rewrite retries return one bound receipt without replaying source edits, including an independent source change after the original commit.
See [the modern adapter decision](../adr/0031-modern-mcp-task-adapter.md) for scope, SDK limitations, and remaining production integration.
At that checkpoint, production entry points, linked resources, compatibility controls, progress, real transport/authentication gates, full qualification, and dependency-advisory updates remained incomplete.
The identifier-hardening tranche replaces new plain scope/key IDs with a domain-separated, server-secret HMAC derivation and checks authenticated earlier receipts under the same publication lock.
Earlier receipts are not moved or replayed, and conflicts, tampering, and ambiguous dual-generation records fail closed.
Modern task handles carry a separate authenticated suffix so even an earlier receipt receives an unguessable modern reference; signature validation precedes execution admission and cancellation.
The initial five-file hardening matrix passed 50 tests in 86.20 seconds on 2026-09-13, covering authenticated reference controls, concurrent/reopened receipt storage, modern transport paths, and both legacy native-task transports.
The expanded frozen matrix passed all 113 tests across 13 files in 203.80 seconds on 2026-09-13 using the supported `npm test --` invocation.
Its first direct-Node invocation omitted `npm_execpath`, so the package-install regression failed while the other 112 checks passed; the npm-driven rerun passed every check without changing source.
The hardening tranche is verified locally, not release-qualified or installed.
The expired-mutation retry regression reproduced unpollable retry handles on both modern transports.
The implementation now renews only authenticated protocol-visibility metadata under the submission lock, preserving the original terminal execution, result, request identity, and transaction.
Both ordinary and native retries in both protocol generations return that saved outcome without source replay; failed and cancelled rewrites remain terminal.
The three-file expiry matrix passed 55 tests in 76.89 seconds on 2026-09-13, including authenticated HTTP retries, concurrent renewal, reopening, and invalid metadata rejection.
The modern candidate delegates artifact-resource reads to a shared bounded core reader, including workspace grants, byte ranges, UTF-8 boundaries, manifest metadata, and continuation links.
The frozen 15-file matrix passed all 133 tests in 327.02 seconds on 2026-09-13, including altered artifacts, ungranted workspaces, HTTP resource routing headers, and complete reconstruction of a 1,601-element real-worker GUI artifact.
The candidate also shares compatibility job controls and the probability-analysis prompt with the legacy server.
The two protocol factories share the same agent-facing server instructions.
Seven focused tests passed in 9.67 seconds, proving control responsiveness with occupied execution slots, principal-private job results, cancellation scopes, prompt parity, and an identical 25-tool catalog.
The final post-extraction 17-file regression passed all 153 tests in 425.13 seconds on 2026-09-13, including both modern serving paths, legacy discovery and workflows, resource reconstruction, and package metadata/install checks.
The earlier 152-of-153 run exposed a stale 23-tool assertion in the official-client test; the corrected client test verifies the full 25-tool catalog and decoded prompt content, with wire-shape checks retained separately.
The candidate factory also shares ordinary-call progress ordering and heartbeat lifecycle with the legacy adapter through the SDK's request-related notification API.
Nineteen focused tests passed in 30.81 seconds, including progress before completion over SDK connection and Fetch-based HTTP serving, SSE cancellation before admission, silent JSON calls, missing/falsy tokens, and timer cleanup.
The expanded nine-file progress and legacy-compatibility regression passed all 73 tests in 121.78 seconds on 2026-09-19.
Pinned Sharp, Hono, Vitest, and coverage patch releases produced an installed graph with zero npm audit findings on 2026-09-19.
The focused post-update GUI rendering, HTTP security and streaming, modern task, and package regression passed all 111 tests in 113.29 seconds.
Local production stdio/HTTP routing and stdio-only opt-in private-tool parity are implemented; full platform, release, and installation qualification remain incomplete.

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

The eight separately run test shards passed 1,135 tests with one skip on 2026-09-19.
Two shard-1 safety deadlines were enlarged after their isolated scenarios passed and the loaded shard exceeded the earlier caps; the rerun passed all 134 tests.
The shard-8 coexistence test was updated to assert returned scanned-source evidence instead of spying on an in-process scanner that cannot observe worker execution; its rerun passed all 139 tests.
The production build, 267-file package dry run, Registry metadata validation, zero-finding npm audit, and official MCP Inspector's 25-tool workflow passed locally.
The separate Stage 2 qualification checkout excludes the unfinished Stage 5 GUI renderer changes; its generated-fixture and schema cleanliness gates, typecheck, lint, formatting, build, package dry run, and Registry metadata validation passed on 2026-09-19.
A mixed-shard HTTP stress failure exposed an `ENOENT` during worker-capacity lease handoff before IPC dispatch.
The host now classifies that precise pre-dispatch loss and makes at most two additional admission attempts without replaying work; unit tests cover successful recovery and bounded persistent failure, and the full 134-test shard passed after the correction.
At the 2026-09-19 local checkpoint, a reviewed candidate commit, the exact `npm run check` and coverage commands, Windows/Linux and Node 22/24 CI, publication, exact public-install verification, and a side-by-side local installation remained.
Commit `b34f0420c631ac6eb8a0805214d4132ca4a57803` passed CI run `35467092544` on Windows and Linux with Node 22 and 24.
Every matrix job passed `npm run check`; the Ubuntu Node 22 job also passed `npm run test:coverage` and the official MCP Inspector.
The exact source qualified by that run is on branch `codex/stage2-3.1.0`; it was a pre-release qualification checkpoint.
The final Stage 2 release commit `8b0dc93abf63951704006810c7b4fc5f0ded4a3c` passed CI run `35494152486` on Windows and Linux with Node 22 and 24, including coverage, the official MCP Inspector, and container checks.
Tag `v3.1.0` peels to that commit on main.
Release workflow `35496091503` completed on attempt 2 through npm, GHCR, immutable GitHub release, MCP Registry, exact public verification, and clean installation.
The first attempt published the signed npm tarball, but its immediate verification saw the preceding `latest` dist-tag during registry propagation; the failed verification and dependent jobs were rerun after the public registry showed 3.1.0 as latest, without repeating npm publication.
An independent Windows installation at `C:/Users/klimp/AppData/Local/hoi4-agent-tools/3.1.0` reports version 3.1.0 and verified 135 dependency signatures and 23 attestations.
The active older installation and coding-agent processes were not restarted or replaced.
Stage 3 release commit `24e80d5f8a4e6c641e73d7cc6c9c2bee34ba0132` passed CI run `35505308755` on Windows and Linux with Node 22 and 24, including coverage, the official MCP Inspector, and container checks.
Tag `v3.2.0` peels to that commit on main.
Release workflow `35507374620` completed on attempt 2 through npm, GHCR, immutable GitHub release, MCP Registry, exact public verification, and clean installation.
The first attempt published the signed npm tarball, but its immediate verification read the previous `latest` dist-tag; only the failed verification chain was rerun after the registry exposed 3.2.0 as latest.
An independent Windows installation at `C:/Users/klimp/AppData/Local/hoi4-agent-tools/3.2.0` reports version 3.2.0 and verified 135 dependency signatures and 23 attestations.
A separate clean public-install check verified the published 27-tool package over stdio and authenticated HTTP.
The active older installation and coding-agent processes were not restarted or replaced.
Stage 4 release commit `183a1364e8a6e29d2226305cf804a20e4365a42f` passed CI run `35512553434` on Windows and Linux with Node 22 and 24, including coverage, the official MCP Inspector, and container checks.
Tag `v3.3.0` peels to that commit on main.
Release workflow `35512562595` completed on attempt 2 through npm, GHCR, immutable GitHub release, MCP Registry, exact public verification, and clean installation.
The first attempt published the signed npm tarball, but its immediate verification read the prior `latest` dist-tag; only the failed verification chain was rerun after the registry exposed 3.3.0 as latest.
An independent Windows installation at `C:/Users/klimp/AppData/Local/hoi4-agent-tools/3.3.0` reports version 3.3.0 and verified 135 dependency signatures and 23 attestations.
A separate clean public-install check verified the published package over stdio and authenticated HTTP.
The active older installation and coding-agent processes were not restarted or replaced.
Stage 5 and the wider external test-profile integration remain open.

The three Chaos Redux focus examples contain 52 Fury, 111 Holy Realm, and 124 Utopia Manifesto focuses. Their rendered branch arrangements can be compared at 96-pixel horizontal and 130-pixel vertical spacing, but the in-game icon plates, continuous-focus panel, frame, and connector styling are visibly different from the offline focus cards. No whole-tree 99.9% pixel-accuracy claim follows from those images.
The sampled chemical and biological folder renders place 22 of 22 and 12 of 12 current-source nodes, respectively, and resolve every requested sprite. Seven native-size technology card crops from supplied game captures match the rendered card interiors at normalized grayscale correlations from 0.998712 to 0.999589 without resizing. These scores measure selected cards, not complete folder images; the supplied chemical viewport depicts a different 40-node source revision.
The combined local check on commit `1e7e0dd` passed 1,215 tests with one skip across eight shards, deterministic fixture and schema checks, the production build, a 304-file package dry run, and Registry validation. The opt-in installed-game scrollbar template test passed both scroll endpoints after outer-window attachment geometry was corrected, and both private images were visually reviewed. Cross-platform CI, public release, installation, and external suite execution remain open.

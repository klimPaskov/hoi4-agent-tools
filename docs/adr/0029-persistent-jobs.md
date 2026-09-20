# 29. Persistent jobs

Status: Stage 2 implementation and the Windows/Linux, Node 22/24 release matrix are qualified at commit `b34f042`; publication and installed-package verification are tracked in the [stage ledger](../specs/deeper-analysis-and-agent-integration.md).

## Decision

Long-running domain operations use authenticated persistent jobs as their single execution record.
The same typed operation serves ordinary MCP calls, negotiated native MCP tasks, and isolated workers; transport handlers do not contain a second domain implementation.
Event, technology, probability, map, GUI, and focus reads are registered, as are focus, GUI, and map rewrites.

Job metadata lives in operator-owned server state outside mod roots.
The server-state authentication key covers the workspace identity, root fingerprint, principal, validated request, request hash, tool version, revision, ownership, progress, cancellation, checkpoints, result, transaction binding, and rewrite-result recipe.
Records contain validated JSON request data, including user-supplied source text for rewrite requests, but never callbacks, module selectors, executable commands, or bearer tokens.
Large domain evidence remains in authenticated linked resources.

## Identity, authorization, and retention

Every submission, lookup, list, cancellation, and result retrieval derives its scope from the workspace resolver.
The client cannot supply a principal, root fingerprint, or ownership scope.
Remote mutations require both an enabled workspace write policy and `hoi4:write`.

Read jobs receive independent random identities unless an explicit deduplication key is supplied; a canonical request hash binds their complete execution inputs.
Background rewrites additionally require a caller-reusable request key.
The receipt namespace binds the key to workspace identity, roots, and principal; its original binding additionally covers the tool, input, and tool version.
New receipt IDs are server-secret-derived with a separate HMAC domain, not hashes of predictable caller inputs alone.
The publication lock also protects lookup of authenticated earlier receipts, which remain at their original identities and cannot be bypassed by retrying after the derivation changes.
Damaged receipts and ambiguous dual-generation records fail closed without starting another execution.
Reusing the same key for a different tool in that namespace is a conflict, not an independent receipt.
Protocol polling and retention hints do not change execution identity.
An identical retry returns the same record, while a key reused with different inputs fails.
Ordinary-call compatibility creates a session-and-request-derived fallback key, and a sessionless call uses a fresh nonce so unrelated callers cannot collide.

Terminal read records are removed after their negotiated task retention period.
Mutation records remain as durable receipts after task visibility expires so an uncertain write cannot be replayed.
Task retention is clamped from one minute to seven days and defaults to 24 hours.
An exact retry of an expired mutation renews only authenticated task-visibility metadata, preserving its terminal execution, result, transaction, and original execution timestamps.
The same publication lock deduplicates concurrent renewals, and neither task lookup nor a conflicting request renews visibility.
The protocol's reported lifetime includes the task's elapsed age plus the renewed bounded visibility window; it does not create or execute another job.

## Publication and ownership

Job creation and updates use one cross-process metadata lock, compare-and-swap revisions, flushed temporary files, atomic replacement, and POSIX directory synchronization.
Windows replacement retries only the bounded sharing-violation race.
Readers therefore observe a complete authenticated record, and concurrent equivalent submissions publish one identity.

An execution attempt claims a unique fenced owner token with host, process, and process-start evidence.
Takeover requires proof that the prior local process stopped; elapsed time is not failure evidence, and an unverifiable remote owner remains unresolved.
Late progress or result publication from an old token cannot overwrite a replacement attempt.

The worker host reserves both local scheduler capacity and shared cross-process capacity before starting a fixed Node.js entry point.
A readiness handshake transfers the shared reservation from launcher PID to child PID.
If a launcher exits while its child remains alive, the child keeps the slot; only process-exit evidence permits reclamation.
If the lease disappears before that transfer, the host can retry admission at most twice for a queued job or one with a proven dead owner because no job request has reached the child; persistent loss fails without starting a worker.
This pre-dispatch retry is separate from checkpoint recovery and never replays an uncertain read or write.
Disconnecting an accepted native task is not a cancellation signal.

## Checkpoints and cancellation

Read operations stage the exact bounded tool result together with its source revision and result hash before terminal publication.
A replacement process can promote an authenticated `result-ready` checkpoint to completion without rerunning the domain operation.
Event and technology dependency traversal also retains a serializable DFS frontier with prefix-shared paths, completed evidence, visited nodes or paths, and an exact wide-adjacency cursor.
Its address binds the domain, source revision, complete edge inventory, roots, traversal policy, ordering, and work/depth bounds.
Restoration validates the version and state shape, lifecycle consistency, path continuity, root ownership, evidence indices, and adjacency bounds before advancing.
Cancellation and work-limit failure leave the last valid frontier unchanged.
Checkpoint envelopes and all their chunks remain pinned by the authenticated nonterminal job record under the artifact publication lock, as described in [ADR 0028](0028-incremental-source-segments.md).

The host may replace a proven stopped read worker only when its record commits to an intermediate frontier or complete result.
Each host invocation permits at most two replacement attempts and only one retry of any particular checkpoint identity.
The replacement uses normal authorization, capacity, fenced ownership, source scanning, and checkpoint validation; source changes discard the incompatible frontier rather than combining revisions.
Live or unverifiable owners are not reclaimed, cancelled jobs are not restarted, and rewrite recovery remains exclusively journal-driven.
Worker exit before the readiness handshake rejects initialization instead of leaving the host waiting indefinitely.
Worker exit before claiming an interrupted record is detected independently of that record's previous owner PID.
Event and technology scan routes also retain revision-addressed graph artifacts, allowing comparisons to recover an earlier graph after process or server restart.
Every public result retains its explicit depth, node, edge, render, helper, scenario, or candidate boundary and partial-coverage evidence.

Cancellation is durable and cooperative.
Queued work becomes cancelled without admission; running work observes the persisted request through an independent watcher.
Foreground-compatible calls propagate their request cancellation before admission or into the admitted job, while accepted native tasks remain independent of the originating connection.
The native task cancellation route and the ordinary `hoi4.job_inspect` and `hoi4.job_cancel` controls bypass occupied domain slots.
A cancellation cannot erase a result that already committed.

## Rewrite recovery

The job transaction coordinator binds the authenticated transaction and a bounded domain completion recipe before source application.
The transaction journal remains the authority for a write outcome.
A planned journal resumes its original validated plan; a committed journal reconstructs the original domain result without another prepare or apply call; an interrupted applying or rolling-back journal uses targeted exact-byte recovery.
Restored or unresolved outcomes remain failures and are never silently replayed.

Post-write validation artifacts are journaled separately from immutable planning artifacts.
They are authenticated with the manifest but excluded from the original plan hash, preserving plan integrity while making recovered results include the same validation evidence as uninterrupted execution.
Blocked and unchanged rewrites do not bind a transaction because they never apply source changes.

## Legacy MCP projection

The server advertises task list, cancel, and tool-call task capabilities.
All registered domain tools declare optional task support, so clients that do not negotiate or request tasks retain the ordinary synchronous result contract.
Native rewrite tasks require an explicit stable `requestKey`; ordinary synchronous rewrites remain source-compatible without it.

Task status maps queued, running, and reconciling jobs to `working`, and preserves completed, failed, and cancelled terminal states.
A domain tool error is a completed task containing the original `isError: true` tool result; worker or storage failure is a failed task.
Task listing and lookup are principal-isolated and bounded.
The public API never accepts transaction IDs, plan hashes, apply calls, or rollback commands.

The [modern Tasks extension adapter](0031-modern-mcp-task-adapter.md) uses the same core service and retry receipts with a different wire vocabulary and per-request negotiation.
Its authenticated wire references preserve identifier entropy even for retained earlier receipts; legacy handles and modern handles need not be textually identical.
Its status projection distinguishes ordinary stored job failures from JSON-RPC errors, and the modern protocol has no task-list or separate task-result method.
The operation factory is not yet the production transport factory.

## Validation boundary

Synthetic coverage includes authenticated store reopening and tamper rejection, concurrent publication, request-key conflict detection, principal isolation, bounded listing and retention, queued and running cancellation, stopped-owner takeover, launcher exit, result-checkpoint recovery, transaction crash points, post-validation rollback, completion-recipe recovery, and exact ordinary/native result parity.
Transport coverage includes stdio and authenticated HTTP reconnects, cross-principal denial, task reuse with changed polling hints, 64 mixed-domain requests across 16 clients, worker failure, and control responsiveness while capacity is occupied.
`tests/integration/dependency-worker-recovery.test.ts` passed four real-worker cases on 2026-09-13, covering 2,500-helper event and technology jobs with unchanged and changed sources.
`tests/unit/dependency-walk.test.ts` and `tests/unit/job-worker-recovery.test.ts` cover exact frontier continuation, corrupt-state rejection, finite retry policy, durable cancellation after owner death, and exclusion of writes from read recovery.
The event/technology MCP-job and worker-policy/startup matrix passed 35 tests across four files, including exact ordinary/task payload and artifact parity, comparison recovery in a fresh server, launcher exit, and both startup-death boundaries.
These checks exercise the persistent execution core, not the pending modern MCP protocol migration.

This ADR records the implemented architecture but does not by itself qualify version 3.1.0.
The complete test, platform, Node, Inspector, package, publication, and installed-package gates remain release evidence.

# Persistent jobs and MCP tasks

Long-running domain operations support optional MCP tasks while preserving the ordinary tool-call contract.
Clients that negotiate task support can request a task, disconnect, reconnect with the same authorized identity, inspect or cancel it, and retrieve the original tool result after completion.
Clients that do not request a task continue to receive the same synchronous tool result as before.

Version 3.1.0 routes 2025-era clients through the existing stateful adapter and 2026-07-28 clients through the [modern operation/task adapter](adr/0031-modern-mcp-task-adapter.md) on both stdio and HTTP.
Modern requests independently negotiate the Tasks extension, use authenticated flat handles, and receive terminal results in `tasks/get`.

Clients can request ordinary-call progress with a progress token.
Both protocol adapters share strictly increasing updates and bounded-frequency heartbeats, with cleanup when the request completes, fails, or is cancelled.
The modern route uses request-related notifications and automatically streams an HTTP response when a progress update is emitted, while silent calls retain JSON responses.
A modern native task handoff ends that request's heartbeat without declaring the underlying worker complete; clients retrieve ongoing status messages through `tasks/get`.

## Supported tools

Optional tasks are available for every read-only event, technology, probability, map, GUI, and focus operation, and for the three rewrite tools:

- `hoi4.event_inspect`, `hoi4.event_render`, and `hoi4.event_compare`
- `hoi4.tech_inspect`, `hoi4.tech_render`, and `hoi4.tech_compare`
- `hoi4.probability_inspect`, `hoi4.probability_evaluate`, `hoi4.probability_sweep`, `hoi4.probability_simulate`, `hoi4.probability_sequence`, `hoi4.probability_compare`, and `hoi4.probability_render`
- `hoi4.map_inspect`, `hoi4.map_render`, and `hoi4.map_rewrite`
- `hoi4.gui_inspect`, `hoi4.gui_render`, and `hoi4.gui_rewrite`
- `hoi4.focus_inspect`, `hoi4.focus_render`, `hoi4.focus_raster`, and `hoi4.focus_rewrite`

Task results are exact tool results, including linked artifacts, partial-analysis markers, validation evidence, and tool-level errors.
A completed tool-level error is therefore a completed task whose result has `isError: true`; an execution or storage failure is a failed task.

## Rewrite request keys

A native background rewrite must include a caller-generated `requestKey` between 1 and 256 characters.
Reuse the same key only for retries of the same rewrite request.
The key's receipt namespace is scoped to the authenticated principal, workspace identity, and workspace roots, and the receipt binds the original tool, inputs, and tool version.
Do not reuse a key for a different tool in the same namespace.
Repeating an identical request with the same key returns the same task and durable result even if task polling or retention hints changed; reusing the key with different rewrite inputs fails explicitly.
Ordinary synchronous rewrite calls do not require `requestKey`.
An exact keyed retry after task visibility expires renews the task's polling window and retrieves the saved outcome without applying the rewrite again.
This also preserves failed and cancelled outcomes; a retry key cannot restart a terminal operation.
Both native and ordinary calls use that same receipt, while a conflicting retry or status lookup cannot extend its visibility.

The server binds an applied rewrite to its authenticated transaction journal before source replacement starts.
If execution stops after a commit, recovery reads that journal and reconstructs the domain result without planning or applying the rewrite again.
Blocked and unchanged plans do not bind a transaction because they never mutate source.

## Cancellation and recovery

Cancellation is durable and cooperative.
A queued cancellation becomes terminal without starting source work.
A running cancellation is observed by the isolated worker; if a rewrite has already crossed the commit boundary, reconciliation reports the actual committed or restored outcome instead of inventing a cancellation or replaying the request.
Cancelling an ordinary synchronous call prevents admission when possible and otherwise requests cooperative cancellation of its durable job.
Closing the originating connection does not cancel an accepted native task.

Read-only jobs stage a source-revision-bound result checkpoint before terminal publication.
If a worker or server stops after that checkpoint, a later authorized process publishes the retained result without rerunning the operation.
Event and technology helper expansion also saves an authenticated intermediate frontier with its exact source revision and traversal contract.
A replacement validates the saved paths, adjacency cursor, graph identity, and checkpoint bytes before continuing.
Source changes before intermediate-frontier recovery cause a fresh analysis of the current revision; old and new graph evidence are never combined.
An active host allows at most two replacement attempts after proven worker death, and never retries the same unchanged frontier twice.
Checkpoint recovery never overrides cancellation or live/unverifiable ownership, and never replays a rewrite.
Event and technology scan artifacts retain revision-addressed graphs for later comparisons, and bounded responses state their requested depth, node, edge, render, helper-expansion, or candidate coverage.
Their opt-in `helper_expansion` mode also returns [bounded continuation pages](helper-expansion.md) through both ordinary calls and persistent jobs.
Unlike automatic recovery inside a single job, an explicit page resume after a source edit is rejected so a caller cannot combine old and new pages.

Workers use fixed registered operations in separate Node.js processes.
Job records contain validated JSON inputs and authenticated state; they cannot select modules, executables, or arbitrary commands.
Workspace and principal authorization is rechecked for every submission, lookup, list, result retrieval, and cancellation.

## Compatibility tools and retention

`hoi4.job_inspect` returns bounded status for an active, cancelled, or failed job and returns the original tool result for a completed job.
`hoi4.job_cancel` records an authorized cancellation request.
Both are control-plane operations and remain responsive while domain execution slots are occupied.
Both protocol adapters use the same control service, and these calls remain foreground operations even when a modern caller advertises the Tasks extension.
Job records are principal-private, including when another principal has access to the same workspace; this differs from artifacts shared within authorized workspace grants.

Native task identifiers include the workspace and persistent job identifier.
They are opaque client values; transaction identifiers and plan hashes are never public workflow inputs.
New persistent job IDs are derived from private server state, and earlier authenticated retry receipts remain usable without repeating their original operation.
The modern adapter adds an authenticated handle suffix, including when it references an earlier receipt, so clients must retain the complete task ID rather than reconstructing it from job metadata or reusing a handle from another protocol generation.
Read-only terminal jobs follow the negotiated task retention period, clamped between one minute and seven days with a 24-hour default.
Mutation receipts remain durable after task visibility expires so a retry cannot duplicate an uncertain write.
Renewed task responses report their total lifetime from the original creation time, including elapsed age, while the newly granted visibility window remains bounded.

Persistent tasks require an operator-owned `serverStateRoot`.
HTTP principals can see only jobs within their existing workspace grants, and rewrite submission or cancellation also requires `hoi4:write`.

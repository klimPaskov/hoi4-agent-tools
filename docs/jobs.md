# Persistent jobs and MCP tasks

Long-running domain operations support optional MCP tasks while preserving the ordinary tool-call contract.
Clients that negotiate task support can request a task, disconnect, reconnect with the same authorized identity, inspect or cancel it, and retrieve the original tool result after completion.
Clients that do not request a task continue to receive the same synchronous tool result as before.

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
The key is scoped to the authenticated principal, workspace identity, workspace roots, tool, inputs, and tool version.
Repeating an identical request with the same key returns the same task and durable result even if task polling or retention hints changed; reusing the key with different rewrite inputs fails explicitly.
Ordinary synchronous rewrite calls do not require `requestKey`.

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
Event and technology scan artifacts retain revision-addressed graphs for later comparisons, and bounded responses state their requested depth, node, edge, render, helper-expansion, or candidate coverage.

Workers use fixed registered operations in separate Node.js processes.
Job records contain validated JSON inputs and authenticated state; they cannot select modules, executables, or arbitrary commands.
Workspace and principal authorization is rechecked for every submission, lookup, list, result retrieval, and cancellation.

## Compatibility tools and retention

`hoi4.job_inspect` returns bounded status for an active, cancelled, or failed job and returns the original tool result for a completed job.
`hoi4.job_cancel` records an authorized cancellation request.
Both are control-plane operations and remain responsive while domain execution slots are occupied.

Native task identifiers include the workspace and persistent job identifier.
They are opaque client values; transaction identifiers and plan hashes are never public workflow inputs.
Read-only terminal jobs follow the negotiated task retention period, clamped between one minute and seven days with a 24-hour default.
Mutation receipts remain durable after task visibility expires so a retry cannot duplicate an uncertain write.

Persistent tasks require an operator-owned `serverStateRoot`.
HTTP principals can see only jobs within their existing workspace grants, and rewrite submission or cancellation also requires `hoi4:write`.

# 31. Modern MCP task adapter

Status: Stage 2 implementation and the Windows/Linux, Node 22/24 release matrix are qualified at commit `b34f042`; publication and installed-package verification are tracked in the [stage ledger](../specs/deeper-analysis-and-agent-integration.md).

## Protocol and SDK boundary

The current published protocol is [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).
The modern candidate pins the split `@modelcontextprotocol/server`, `core`, and `node` packages at 2.0.0 and tests ordinary clients with `@modelcontextprotocol/client` 2.0.0.
SDK 1.30.0 remains installed for the existing 2025-era entry points and compatibility tests.
SDK instances and transports do not cross generations; shared Zod definitions and JSON operation results are protocol-independent.
The [official migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md) permits this staged migration, but upgrading dependencies alone is not modern serving.

The modern operation factory is exercised through the official `serveStdio` connection entry and `createMcpHandler` HTTP request entry.
It registers the same 23 domain tool names, descriptions, annotations, input schemas, and output schemas as the legacy server.
The common catalog is the metadata source of truth; legacy task callbacks are installed only by the SDK-v1 adapter.
The modern task protocol has no `tasks/list` or `tasks/result`; those retired methods are not compatibility aliases on a modern connection.

## Shared execution

`core/operation-tasks.ts` owns operation validation, workspace selection, permissions, durable submission, worker ownership, recovery, retention, cancellation, and result retrieval.
`core/operation-context.ts` owns the protocol-independent principal, scope, and current-workspace boundary.
Both wire adapters use these services without duplicating domain execution.
Read-only credentials may inspect a retained rewrite but cannot resume a stopped rewrite or cancel it.
Cancellation and ignored task updates inspect without starting execution; they do not admit queued work before recording the control operation.

Client-root discovery uses the modern multi-round-trip `roots/list` exchange before task creation.
The returned root list is bounded, schema-validated, and mapped through the existing canonical workspace resolver and principal grants.
It never supplies authority or expands configured roots.
No job exists while the request is still waiting for roots.

## Tasks extension contract

The adapter follows the immutable [2026-07-28 Tasks extension specification](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md) and its [released schema](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts), not the legacy `TaskSchema` still exported by SDK 2.0.0.

- Every request independently declares `io.modelcontextprotocol/tasks` in its client capabilities.
- Tool calls without that declaration receive an ordinary completed result.
- The server backgrounds supported reads when the extension is declared; rewrites additionally need a valid stable `requestKey`.
- Merely advertising the extension does not turn an unkeyed rewrite into an error or force it into the background.
- Creation returns a flat `resultType: "task"` with `taskId`, timestamps, `ttlMs`, and `pollIntervalMs` only after the authenticated job is durably visible.
- `tasks/get` returns `resultType: "complete"` with current state and the original result when terminal.
- Job execution failures are ordinary tool errors, so their modern task projection is `completed` with `isError: true`, not a fabricated JSON-RPC failure.
- `tasks/cancel` returns an acknowledgement and preserves a terminal outcome.
- The registered offline operations do not request input during worker execution; `tasks/update` acknowledges unknown or already-satisfied keys without altering state.
- Missing, malformed, expired, or foreign task IDs produce an indistinguishable invalid-parameters error.
- Missing per-request extension capability produces `-32021` for task control methods.
- HTTP task control requests must match both `Mcp-Method` and `Mcp-Name` to the body method and task ID.

Task status subscriptions are not implemented or advertised.
The native extension tests use a schema-checked wire client because the published SDK 2.0.0 client rejects the extension's `task` result discriminator and era-gates historical task methods.
The official SDK client is separately tested with its actual ordinary-call capabilities; the server does not assume that installing SDK v2 means a client can consume native task results.

## Identifier entropy and retained receipts

New persistent job IDs use HMAC-SHA256 with the private 32-byte server-state key and the domain-separated `job-id.v2` payload containing the authorized scope and retry key or a fresh random nonce.
Identical scoped retry keys remain stable across server restarts, while independently initialized server states generate different IDs even when every public input is identical.
The caller's retry key and a plain scope/key hash are not treated as entropy.

Submission checks both the secret-derived ID and the earlier plain-hash ID under the existing cross-process publication lock.
Identifier migration reuses an authenticated earlier receipt without renaming, copying, or resetting its execution, including its committed result and transaction binding.
Changed inputs or tool versions remain conflicts; invalid authentication, malformed JSON, or a mismatched request hash fail closed rather than authorizing a fresh execution.
If both generations contain a record for one key, submission reports `JOB_REQUEST_KEY_AMBIGUOUS` instead of guessing which execution is authoritative.
This compatibility lookup does not claim that an older binary understands the new derivation; simultaneous writers must use the qualified implementation when sharing server state.

The modern adapter adds a separately authenticated task-reference suffix bound to the full authorized scope and persistent job ID.
This makes a modern handle unguessable even when the retained execution record has an older predictable ID, without moving the record or invalidating legacy receipt access.
The modern and legacy wire handles can differ while referring to exactly the same execution receipt.
Modern task controls reject unsigned, altered, and cross-job references before resuming or cancelling work, and continue to check workspace grants and principal ownership on every request.
The suffix is stable across reconnection and is independent of mutable progress, timestamps, and status.

## Expired rewrite retries

An exact authorized retry may find a durable rewrite receipt after its protocol visibility period has elapsed.
Returning its old expired task view would violate immediate pollability, while discarding the receipt could repeat the source edit.
The shared job store therefore renews only authenticated `taskVisibility` metadata under the same publication lock after verifying the complete request binding.
It advances the record revision but preserves the execution identity, original request and request hash, execution timestamps, terminal status, result, transaction, and completion recipe.
Concurrent identical retries renew once; a lookup, conflicting retry, generic record patch, or expired read-only job cannot renew visibility.
Failed and cancelled rewrites remain failed or cancelled and never restart.

Both protocol adapters project the renewed visibility into `lastUpdatedAt` and the lifetime measured from the original `createdAt`.
The task ID remains stable, native retries return a pollable terminal task, and ordinary retries return the original outcome through the same execution service.
The bounded renewal window is independent of the task's age, so the reported total lifetime can exceed the initial requested duration.
This metadata-only renewal replaces the earlier unimplemented proposal to return an ordinary result on modern retries, and also preserves the required native result shape for legacy clients.

## Shared artifact resources

`core/artifact-resource.ts` owns the artifact template, bounded URI and selector validation, principal-bound workspace resolution, exact byte ranges, UTF-8 handling, continuation metadata, and public manifest projection.
The two SDK registration modules delegate to that core without duplicating artifact reads or authorization.
The modern factory exposes resource discovery and reads with a private zero-duration cache policy; it does not enumerate stored artifacts or advertise subscriptions.
Artifacts are workspace-owned and can be read by other principals granted that workspace, unlike principal-private task execution records.
Ownership still uses the existing artifact manifests and workspace grants, and modern errors do not disclose internal storage paths.
Missing, ungranted, and tampered resources use the modern specification's `-32602` not-found response with the requested URI, not the historical `-32002` code.
The public SDK HTTP entry validates resource routing headers before dispatch; no duplicate resource-specific header implementation is required.

## Compatibility controls and prompt

`core/job-controls.ts` owns bounded persistent-job status, original-result retrieval, cancellation, workspace resolution, principal isolation, and mutation cancellation scopes for both adapters.
The common metadata catalog exposes the same 25 public tool definitions, including the two compatibility controls and their existing output-schema behavior.
Both protocol factories advertise the same server instructions through their respective discovery responses.
Controls always return ordinary results, never create another job, acquire worker capacity, or resume an execution as a side effect of inspection.
Cancellation cannot change an already terminal outcome, and read-only credentials cannot cancel a rewrite.

The probability-analysis prompt has one shared metadata definition, bounded argument schema, and body.
Modern prompt discovery advertises the prompt capability and returns the same arguments and generated message as the legacy registration.
Prompt retrieval does not read source files, submit jobs, or execute weighted analysis.

## Request progress

Both adapters share the same opt-in progress ordering, heartbeat ownership, cancellation signal, and best-effort delivery policy.
The modern adapter sends through the public `ctx.mcpReq.notify` API so the SDK associates notifications with the originating request and HTTP response stream.
Zero and empty-string progress tokens are retained, and separate request contexts do not share counters.
Nested stages share one heartbeat timer; success, failure, and cancellation clear it.

Ordinary calls report waiting and result-retrieval stages, with a final completed stage after the persistent result is available.
A native task handoff ends the request heartbeat without falsely declaring its worker complete; subsequent state and progress messages remain available through authenticated `tasks/get` polling.
Compatibility job controls continue to bypass domain admission and heartbeat work.

The official SDK HTTP-client tests use `createMcpHandler` with `responseMode: 'auto'`, which upgrades to SSE when a request-related notification is emitted.
They prove progress arrives while execution capacity is still occupied, before the tool result, and that aborting the stream durably cancels the queued ordinary operation.
Calls without a progress token emit no progress notifications and retain a JSON response in auto mode.
The existing JSON-mode wire tests remain useful for task and resource shapes but are not evidence of progress streaming.
The initial tests exercised SDK connection and Fetch transports; later production-entry regressions separately prove authenticated Node HTTP progress and bounded stdio negotiation.

## SDK routing seam

[Upstream issue 2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598) is reproducible with the published SDK 2.0.0: `server/discover`, modern task creation, and a custom `tasks/update` handler work, but `tasks/get` is rejected by the historical core-method era gate before its extension handler.
The candidate decorates the public `Transport` boundary on the advanced public `Server` API.
Only modern task-control method names are mapped to private dispatch names after the serving entry classifies the request.
Parameters, envelope, authentication/request metadata, request IDs, transport lifecycle, and cancellation remain under the SDK and shared core boundaries.
The SDK still checks the request envelope and connection era.
Direct client calls to those private names are rejected; the aliases are not advertised protocol methods.
This seam must be removed when an upstream release supports the extension routes directly and the same negative tests pass without it.

The ordinary-call cancellation regression also reproduced the SDK's falsy-ID guard ignoring request ID `0`.
Modern clients can use `0` for their first operational request because discovery uses a separate probe identity.
The same guard ignores an empty-string request ID.
The public transport seam maps those two active IDs to private truthy IDs internally, maps responses and related-request metadata back to their exact wire IDs, and routes validated cancellations to the active internal ID.
Active duplicate IDs are rejected, malformed cancellations do not discard the mapping, and completion, cancellation, and close release it.
The SDK's normal abort controller still performs cancellation; no private SDK state is changed.

The published SDK's `RequestMetaEnvelope` declaration is empty despite preserving reserved keys at runtime.
The adapter therefore parses that boundary as unknown data using the public capability schema instead of using an unchecked type assertion or importing private SDK modules.

## Qualification and remaining integration

The initial 13-case modern suite passed on 2026-09-13 through SDK connection and Fetch-based HTTP serving.
Its scenarios include durable visibility, reconnects, ordinary-result parity, same-workspace cross-principal isolation, per-request negotiation, alias and retired-method rejection, input validation, cancellation scopes, ignored updates, terminal state, expiry, root exchange, tool-catalog parity, official SDK client calls, and HTTP routing-header validation.
After correcting the zero-ID cancellation defect, the frozen 12-file matrix passed all 84 tests in 289.47 seconds on 2026-09-13.
It covers 16 modern integration cases, two focused ID/cancellation regressions, all six legacy domain job/task routes, authenticated legacy HTTP tasks, metadata/context/progress contracts, and package metadata.
Mixed-era retries retrieve the same committed rewrite receipt without overwriting an independent subsequent source edit.

The local production stdio entry now pins each bounded connection to either the existing 2025 adapter or the modern 2026 serving entry after its first message.
The local production HTTP entry uses the SDK's public era classifier after the existing authentication, Origin, Host, byte, and admission gates, then invokes the strict modern handler with a principal derived only from the authenticated request.
Legacy stateful sessions and their transport remain separate.
The optional ChaosX private tools share their underlying operations between protocol adapters and are enabled only by the existing stdio process flag; HTTP never advertises them.
At this 2026-09-19 development checkpoint, full transport, platform, Inspector, installation, and release qualification remained open.
No installed MCP process was restarted or replaced during development.
The candidate pins Sharp 0.35.4, Hono 4.13.8, and Vitest plus coverage 4.1.11 after the earlier versions were reported by npm as affected by advisories.
The installed dependency graph reported zero npm audit findings on 2026-09-19; this does not replace rendering, transport, platform, or release qualification.
The first identifier-hardening matrix passed 50 tests across five files in 86.20 seconds on 2026-09-13, including 20 modern wire cases over connection and Fetch-based HTTP serving.
It verifies earlier receipt retrieval after an independent source edit, distinct authenticated modern handles for those receipts, reconnection stability, and rejection of unsigned, altered, or cross-job handles before queued work changes state.
The expanded frozen matrix passed all 113 tests across 13 files in 203.80 seconds on 2026-09-13 using `npm test --`.
It includes 25 job-store tests, 20 modern integration cases, two zero/empty-ID cancellation regressions, the legacy domain/task transports, and metadata/context/progress contracts.
The initial direct-Node invocation passed 112 of 113 checks but omitted `npm_execpath`, which the real npm tarball-install regression requires; the supported npm invocation supplied it and passed the complete matrix without a source change.

The expired-mutation regression reproduced the defect on both modern transports before the fix.
The corrected three-file expiry matrix passed all 55 tests in 76.89 seconds on 2026-09-13, including concurrent/reopened storage, preserved completed/failed/cancelled outcomes, invalid visibility metadata, ordinary/native retries in both protocol generations, and authenticated legacy HTTP retries after an independent source edit.
The subsequent frozen 15-file resource and cross-domain matrix passed all 133 tests in 327.02 seconds on 2026-09-13.
It includes exact UTF-8 boundary reconstruction, public manifest parity, workspace-grant isolation, altered-file rejection, HTTP header mismatch rejection, and reconstruction of a 1,601-element GUI inspection through real worker-configured artifact limits.
The GUI fixture also asserts a complete source inventory, preventing an over-limit or skipped source from masquerading as a successful large-graph test.
Seven focused compatibility-control, prompt, and complete-catalog tests then passed in 9.67 seconds, including occupied domain and worker slots, completed native-task result retrieval, same-workspace foreign-principal denial, write-cancellation scopes, bounded prompt inputs, and legacy prompt parity.
The final post-extraction 17-file regression passed all 153 tests in 425.13 seconds on 2026-09-13, including the full modern suite, legacy domain tasks, discovery, weighted-analysis workflow, resource reconstruction, and package metadata/install checks.
The first expanded run passed 152 of 153 checks and exposed a stale official-client assertion expecting 23 tools instead of the complete 25-tool catalog.
The corrected official-client test also verifies prompt retrieval through the SDK's decoded result, while raw-wire tests independently enforce the required modern discriminator and cache policy.
This is local candidate evidence, not full project, platform, Inspector, release, or installation qualification.

The focused progress tranche passed all 19 selected tests in 30.81 seconds on 2026-09-13, including both official client transports, notification failures, missing/falsy tokens, per-request ordering, and nested timer cleanup after success, failure, and cancellation.
The expanded nine-file progress and legacy-compatibility regression passed all 73 tests in 121.78 seconds on 2026-09-19.
Production HTTP composition retains the existing authentication, Host, Origin, byte/admission budgets, and legacy sessions while routing modern claims and validation failures to the strict modern entry through the SDK's public classifier.
The production Node HTTP regression passed all 18 security and streaming cases, including modern official-client calls, mid-call SSE progress, silent JSON results, cross-principal task denial, and legacy sessions.
A separate raw-header regression rejects duplicate modern method, name, and parameter fields before SDK normalization.
The real stdio child-process test passed modern discovery, tool calls, task creation, and polling over the shared bounded stream.
The combined production HTTP security, streaming, limits, and stdio suite passed all 46 cases on 2026-09-19.
That run exposed a legacy malformed-request error-shape regression and absolute-form modern URL failure; explicit-claim routing and post-authority target normalization corrected both before the 46-case pass.
The opt-in modern stdio regression separately passed discovery of both private tools and execution of the country-asset operation with the flag enabled, while the unflagged modern catalog retained its 25 public tools.
After sharing the private implementations and keeping their import behind the stdio flag, the six-file cross-era transport and modern-task matrix passed all 83 tests in 154.31 seconds on 2026-09-19.
All eight test shards passed separately after two overloaded-shard safety deadlines and one worker-observation assertion were corrected: 1,135 passing tests and one skip on 2026-09-19.
The built package passed its 267-file dry run and Registry validation, and the official MCP Inspector passed its 25-tool workflow.
The subsequent committed candidate `b34f042` passed the complete Windows/Linux, Node 22/24 CI matrix, coverage, and official Inspector in run `35467092544`.
Publication and installed-package verification require separate release evidence.

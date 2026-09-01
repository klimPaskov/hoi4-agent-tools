# ADR 0025: Bounded cache lifetimes

## Decision

Every MCP process bounds retained source bytes as well as cache entry counts. The shared scanner keeps at most 128 MiB of unchanged source buffers and at most 128 MiB of immutable-game scan buffers. Event and technology services retain no more than two adjacent graph revisions, and the probability service retains no more than sixteen analysis results.

Focus, map, event, technology, probability, scripted-GUI, and private ChaosX GUI handlers hold a cache lease for the complete tool call. Adjacent calls reuse the same data, but thirty seconds after the last concurrent call finishes the domain releases parsed graphs, histories, source fragments, and shared completed-scan buffers. Lease activity is coordinated process-wide so one domain cannot clear or compact memory while another domain is active. After an idle release, the server asks V8 to reclaim the detached graphs; npm launchers need no additional Node flags. Cleanup timers are unreferenced, and cleanup or best-effort compaction failures cannot terminate either MCP transport.

The bounded stdio transport treats input end, input close, output error, and output close as transport closure. This invokes the MCP SDK close path, which aborts every in-flight request signal. A coding-agent timeout or task closure therefore cannot leave an orphaned scan consuming CPU and memory after the client has disconnected.

## Rationale

Coding-agent clients commonly keep one stdio server alive per task. Entry-only caches allowed several full vanilla-plus-mod scans and derived graphs to remain reachable in every process. Several idle tasks could therefore exhaust host memory and make otherwise valid calls appear as `Transport closed`.

Byte ceilings prevent large scan entries from being retained, short idle lifetimes reclaim full graph state, idle heap compaction returns unreachable graph memory instead of leaving it committed in every task process, disconnect propagation stops abandoned work, and leases preserve correctness for concurrent or long-running calls. Raising the V8 heap ceiling would multiply memory pressure across tasks and is not the solution.

## Consequences

Immediate inspect, render, and compare sequences retain their fast path. A call made after the idle interval rescans source or reads an explicit graph artifact instead of relying on old process memory. Content-addressed resources remain the durable handoff for comparisons that must outlive the short in-process cache window.

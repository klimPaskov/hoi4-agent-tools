# ADR 0024: Keep long MCP operations alive with progress heartbeats

## Decision

Long GUI inspection, rendering, and rewrite stages run behind a shared progress-heartbeat helper. The helper sends a repeated `notifications/progress` message every ten seconds without changing the reported work value, then clears its timer when the stage completes or fails. Existing monotonic progress reports remain unchanged.

## Rationale

GUI source graphs and deterministic state or resolution galleries can take longer than the idle request timeout used by a coding-agent MCP client. The MCP protocol lets a client reset that idle timer when it requested progress notifications. The server cannot override a client-supplied maximum total timeout, so the helper keeps the normal request alive without hiding cancellation or inventing an unbounded server-side timer.

## Consequences

The GUI MCP handlers cover opaque scanner, validator, rasterizer, artifact, and transaction stages even when those stages do not have a fine-grained callback. Heartbeats are best effort after a client disconnects; a failed notification does not corrupt or interrupt the underlying operation. The request `AbortSignal` remains authoritative, and clients that set a maximum total timeout must choose a value appropriate for their workload.

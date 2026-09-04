# Concurrent request execution

## Decision

Every MCP tool handler uses one shared request lifecycle. A bounded, fair queue schedules expensive work across sessions using the same engine, and host-specific leases in private server state coordinate separate local task processes. Defaults admit two operations per engine and four across processes sharing that state root. Queue entries reserve their serialized input bytes and are removed immediately on cancellation. Protocol control requests and artifact retrieval do not wait behind heavy tool work.

The public SDK request-handler registration boundary supplies this lifecycle to all domains and optional tools without introducing domain logic into transports. Domain services retain their typed interfaces. The lifecycle uses the request's cancellation signal and the same progress reporter as the domain handler.

Local capacity leases identify their owning PID and unique lease name. An active owner is never removed. Dead owners and abandoned empty slots can be reclaimed. Concurrent cleanup only removes the exact abandoned owner name and an empty directory, so it cannot delete a replacement owner's lease. Client cancellation releases a waiting request without stopping another task.

Progress pulses use strictly increasing floating-point values as required by the negotiated MCP protocol. They cover queue waits and execution for every tool, stop at completion, and are best-effort if the client disconnects. They require a client-provided progress token; clients must opt into resetting idle timeouts on progress and choose an appropriate maximum duration.

HTTP defaults allow 128 concurrent requests, 512 connections, and 6,000 requests per minute. The connection budget leaves room for control requests even when all request and event-stream slots are occupied. Actual body reservations retain the 128 MiB aggregate budget rather than multiplying the maximum individual body size by the connection count. Small control envelopes have additional request slots. Session inactivity expiration excludes active requests, while OAuth credential expiration remains authoritative.

Shared indexing yields between source files to service protocol traffic. Stdio output has one writer and a bounded byte queue; output failure rejects every pending send and cannot accumulate one drain listener per concurrent message.

GUI source graphs share an engine-scoped cache across sessions. Workspace authorization still precedes access, cache keys retain workspace and source identity, and the existing retention bound remains unchanged.

Artifact mutation holds an exclusive host lease rooted in the artifact store as well as its in-process queue. Admission, immutable publication, the commit callback, and failed-batch cleanup therefore cannot race a writer in another task process. Readers retry an unstable file identity with a fresh handle and full hash verification, at most three times; actual hash mismatches remain errors.

## Validation

The concurrent workload tests use project-owned fixtures across every domain, including 1,040 technologies. They submit 30 simultaneous domain requests over six HTTP sessions and four separate stdio processes, retrieve artifact resources, and check progress ordering and continued discovery. Focus and GUI rewrites, map geometry, probability evaluation and comparison, isolation, stale source rejection, and recovery remain covered by their end-to-end suites.

Targeted regressions cover queued cancellation, fairness, slow or disconnected stdout, session activity across the inactivity deadline, and shared lease contention and crash recovery.

## Limits

Queueing prevents a burst from multiplying expensive work without bound; it does not make finite hardware unlimited. Large jobs may wait longer under sustained load. Explicit request, input, body, authentication, artifact, and queue limits remain in effect. Separate state roots define separate local capacity pools; configurations sharing a pool must use the same `maxSharedTools` setting. Existing processes keep their loaded code until their client creates a new connection.

MCP references: [progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress), [timeouts](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts), and [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

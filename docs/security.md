# Security and threat model

## Protected assets

- external mod source and binary map data;
- installed game and dependency references;
- transaction approval intent and rollback blobs;
- generated artifacts that may reveal source details;
- HTTP credentials and principal/workspace grants.

## Trust boundaries

MCP input, file paths, manifest content, client annotations, session IDs, Origin/Host headers, and remote access tokens are untrusted. Tool annotations are descriptive hints. Prompts are guidance. Server-side policy is authoritative.

## Filesystem controls

- Only registered roots are visible.
- Public paths are relative and canonicalized.
- Traversal, absolute paths, UNC/device paths, NULs, alternate data streams, ambiguous trailing characters, and device names are rejected.
- Existing symlinks and junctions are resolved; an escape outside the root is rejected.
- Artifact shards, transaction journals, blobs, and lock descendants are re-canonicalized before access. A symlink or junction observed in artifact/journal enumeration is rejected.
- Transaction mode requires an absolute `serverStateRoot` whose existing components are non-linked
  and whose canonical target does not overlap any source, registration capability,
  generated-storage root, or runtime-nominated root. Harmless native path-spelling aliases are
  normalized only after the link check. Its random journal key and protected revision heads are
  never returned through MCP.
- Writes target the canonical mod root only. Game, dependency, fixture, and unrelated user files are never writable.
- Runtime mod registration requires a separate, default-empty `writableRegistrationRoots`
  capability. A caller cannot relabel a game/dependency path from the read-only
  `registrationRoots` allowlist as a mod.
- Artifact URIs are opaque and authorization-checked; filesystem paths are not placed in MCP responses.

These are application checks, not a kernel-enforced filesystem sandbox. The operator must prevent
hostile operating-system principals from concurrently replacing directories, symlinks, junctions,
mounts, or files inside registered and generated roots between validation and I/O. Such an actor
already has direct filesystem authority and is outside the application security boundary. The
server detects normal stale-source changes and observed link escapes, but does not claim
race-proof `openat`-style containment or operating-system transaction atomicity against hostile
concurrent mutation.

## Write controls

Read-only is the default. A write requires global and workspace enablement, a validated dry run, a persisted transaction, exact plan hash, separate apply call, unexpired principal/workspace binding, unchanged source hashes, and a workspace lock. There is no command execution field. Stale apply and rollback operations fail closed.

Runtime registration definitions and raw paths are not persisted. The canonical artifact root does
retain an atomically created ownership claim containing only domain-separated SHA-256 workspace and
owner bindings. Re-registration restores that binding only for the same canonical workspace and
runtime principal; malformed, linked, raced, aliased, cross-principal, and cross-workspace claims
fail closed. A failed journal recovery removes only the in-memory registration, never its persistent
claim or existing generated data. Statically configured workspaces do not use runtime claims and
remain shared according to their operator-reviewed principal grants.

Every artifact provenance manifest includes the resolved workspace identity and its configured or
runtime owner identity in the immutable provenance hash. List, describe, and resource-read paths
verify both values before returning metadata or bytes. Reusing a physical artifact store through a
different workspace or owner therefore cannot expose prior evidence; unbound legacy or malformed
manifests are rejected rather than migrated or deleted implicitly.

Transaction manifests are authenticated with HMAC-SHA-256 over the complete canonical manifest,
excluding only the authentication tag. The 256-bit random key lives beneath `serverStateRoot`, not
in a workspace or public configuration value. Protected revision heads prevent replay of an older
valid manifest. A cache-first crash may reconcile only an authenticated exact next revision; a
missing head, revision gap, altered expiry/state/failure/rollback field, or recomputed public hash
fails closed. No HMAC key is derived from public workspace data.

Read-only transaction operations never repair protected state. Cache-first successor promotion is
confined to startup recovery and authorized write paths. Artifact manifests are capped at 1 MiB and
transaction manifests at 16 MiB before parsing; transaction resource ranges use a bounded verified
byte cache instead of repeatedly rebuilding the authenticated object.

## HTTP controls

- Every POST, GET, and DELETE request to `/mcp` is authenticated; only standards-required OAuth discovery metadata is public.
- Present Origin and Host are checked before MCP dispatch. Security-sensitive singleton fields are counted from the raw HTTP header list before Node normalization, so duplicate Host, Authorization, Origin, content metadata, forwarding identity, or MCP session/protocol fields fail closed. Absolute-form request targets must use an allowlisted authority identical to Host.
- Session IDs are secure random routing identifiers bound to the authenticated principal, an explicit OAuth client when present, the exact bearer credential's SHA-256 identifier, and the non-downgraded scope set; they are not credentials. A token without `client_id` or `azp` is credential-bound rather than being aliased to the subject.
- Missing, expired, cross-principal, or unknown sessions fail.
- Connection count, requests per socket, header/request/keep-alive time, JSON body size, admitted concurrency, request rate, session count, event streams, event history, and session lifetime are bounded.
- Admitted request concurrency is fixed at no more than two; configured body bytes multiplied by
  concurrency cannot exceed 16 MiB.
- Static bearer tokens are loopback-only. A non-loopback listener or a non-loopback canonical `publicUrl` (including a loopback listener behind a public reverse proxy) requires HTTPS and OAuth/OIDC JWT signature, issuer, audience, algorithm, expiry, subject, and scope verification.
- Tokens are accepted only in the Authorization header and are never logged, forwarded, copied into a session, or exposed to MCP handlers. Only a one-way SHA-256 credential identifier is retained for session binding.
- Protected Resource Metadata is published for OAuth deployments and linked from OAuth `WWW-Authenticate` challenges.
- Initial 401 challenges identify the baseline scope. A write-scoped tool call made with a read token receives an HTTP 403 `insufficient_scope` challenge naming the baseline plus `hoi4:write`, before JSON-RPC dispatch.
- Streamable HTTP reserves concurrency before JSON parsing or token verification and applies a socket-address rate bucket before authentication, followed by an independent per-principal bucket after authentication. Host and any present Origin are rejected even earlier. Every `/mcp` POST must advertise unparameterized, positively weighted `application/json` and `text/event-stream` response media types, use the exact `application/json` request media type with an absent or `utf-8` charset, and use no content coding other than identity. GET requires an unparameterized, positively weighted `text/event-stream` range. Bodies are fatal-decoded as UTF-8 and parsed under the raw-wire `maxBodyBytes` ceiling; suffix types, malformed or ambiguous media parameters, encoded entities, replacement-decoded UTF-8, and parameter-only media-type mentions are rejected before SDK dispatch.
- `trustedProxyAddresses` contains exact IP addresses only and affects only derivation of the pre-auth rate-limit key; it does not enable general forwarded-header trust. `X-Forwarded-For` is ignored unless the direct socket peer exactly matches a configured address (IPv4-mapped IPv6 is normalized). For a trusted peer, a missing or invalid header is rejected and only the first comma-separated address is used.
- A reverse proxy must be the only network path to a proxied server, terminate TLS, overwrite client-supplied forwarding headers with a validated client IP, preserve Authorization/Origin/Host, and enforce edge connection, header, body, timeout, and rate limits. CIDR ranges, hostnames, and an unverified proxy chain are not inferred by the application.
- Every session request is reauthenticated and must present the exact credential that initialized the session; another token cannot take over merely because its subject or client claims match. OAuth refresh and scope step-up therefore initialize a new MCP session. Scope authority within a session remains monotonic, and handler-level write-scope checks remain in place as defense in depth.

Session admission counts both active sessions and initializations in progress, globally and per
principal. Static-token sessions use the configured sliding inactivity lifetime. OAuth session
expiry is the earlier of that lifetime and the access token's `exp`; an expired token cannot create
a session. Expiration timers remove sessions at that bound, with access checks, pre-admission
pruning, and periodic cleanup as fail-closed backstops.
Resumable GET streams have separate global/per-principal ceilings; once accepted, a long-lived
stream releases the ordinary short-request concurrency reservation and remains charged to the
stream ceilings.

Replay history is also bounded: at most 1,000 events per session, the configured per-session byte
budget, the configured process-wide event-store byte budget, and the session TTL. Per-session
overflow evicts the oldest history first. If one event cannot fit the per-session or shared byte
budget, it is not retained for replay; the store does not evict another session's history to make
room. Closing or expiring a session releases its shared budget.

## Stdio controls

Stdio accepts newline-delimited JSON-RPC frames of at most 16,777,216 bytes, excluding the line-feed
delimiter. The ceiling is fixed and matches the largest configurable Streamable HTTP JSON body.
Input is retained in a geometrically grown bounded byte buffer, keeping cumulative copy work
linear without per-chunk metadata growth. Completed frames use fatal UTF-8 decoding; malformed byte
sequences are never replaced with U+FFFD or dispatched as JSON-RPC. A malformed UTF-8 frame or a
frame that crosses the ceiling is refused immediately (for size, including when no newline or
end-of-input has arrived): the server writes a structured `STDIO_INVALID_UTF8` or
`STDIO_FRAME_TOO_LARGE` event to stderr, closes that transport, and exits unsuccessfully. The
rejected payload is never echoed. Protocol responses remain exclusively on stdout; transport and
startup diagnostics remain exclusively on stderr.

Well-formed UTF-8 frames that fail JSON or JSON-RPC schema validation are not dispatched. Their
stderr diagnostic has the fixed `STDIO_INVALID_MESSAGE` code and a generic message; it never
interpolates caller-controlled frame content. A later valid frame may continue on the local
connection.

## Source and artifact privacy

Stdio inherits the local process user's access but still applies the configured roots. A remote deployment can access only paths mounted and registered on the server; it cannot reach a client computer. Do not mount a home directory or an entire game library when one read-only game root and selected workspaces suffice.

On POSIX, the server enforces mode `0700` on the state root and `0600` on the journal key. Node does
not provide a portable Windows DACL authoring API, so Windows operators must provision the state
root ACL for the dedicated server account; the server still rejects a linked/non-regular key and
inherits that operator ACL. A hostile operating-system principal that can read the key or replace
state-root entries remains outside the documented filesystem trust boundary.

Raw installed-game or dependency sprite, font, and bitmap files are never registered as downloadable resources. Structured JSON evidence strips embedded raster and glyph payloads, retaining only source-linked hashes, paths, frame and dimension metadata. Composite SVG/PNG reviews may contain processed frames or glyphs required to inspect the requested render, but remain generated, authorization-checked workspace evidence rather than raw asset-file resources. Transaction evidence may contain authorized mod-source before/proposed text and diffs; every artifact remains bound to the workspace principal.

The runtime sends no telemetry or analytics. Its only outbound network request is OAuth JWT-key retrieval from the administrator-configured JWKS endpoint; stdio and static-token loopback deployments require no runtime network access.

The product never launches, automates, controls, or captures Hearts of Iron IV. Every preview is
an offline tool-generated render, not a game screenshot or evidence of in-engine behavior.

Vulnerabilities should be reported through GitHub private vulnerability reporting as described in the root [security policy](../SECURITY.md).

# Self-hosting Streamable HTTP

The server exposes one stateful MCP endpoint at `/mcp` for POST and GET, plus DELETE session termination. It does not provide legacy SSE-only transport.

## Loopback

Set a random token of at least 32 characters in the environment named by config:

```bash
export HOI4_AGENT_HTTP_TOKEN='replace-with-a-random-secret'
HOI4_AGENT_CONFIG=/srv/hoi4/config.json hoi4-agent-tools-http
```

Keep `host` as `127.0.0.1`. The client sends `Authorization: Bearer ...`. Present origins still need to match `allowedOrigins`.

The HTTP process refuses to start if a configured token environment variable is missing, shorter
than 32 characters, or has the same secret value as another configured token. Static tokens and
OAuth are mutually exclusive deployment modes.

## Public/team deployment

Public mode—either a non-loopback listener or a non-loopback `publicUrl` in front of a loopback/private listener—refuses to start unless:

- `publicUrl` is an HTTPS origin or exact `/mcp` endpoint and contains no credentials, path prefix, query, or fragment;
- OAuth/OIDC JWT validation is configured;
- the OAuth issuer, JWKS, and every authorization-server URL use HTTPS;
- at least one origin is allowlisted;
- principal/workspace grants are configured.

```json
{
  "http": {
    "host": "0.0.0.0",
    "port": 3210,
    "publicUrl": "https://mcp.example.test",
    "allowedOrigins": ["https://agent.example.test"],
    "trustedProxyAddresses": ["10.20.0.5"],
    "tokens": [],
    "principals": [
      { "principal": "user-subject", "workspaceIds": ["example"], "allowRegistration": false }
    ],
    "oauth": {
      "issuer": "https://issuer.example.test/",
      "jwksUri": "https://issuer.example.test/.well-known/jwks.json",
      "audience": "https://mcp.example.test/mcp",
      "authorizationServers": ["https://issuer.example.test/"],
      "requiredScopes": ["hoi4:read"],
      "algorithms": ["RS256"]
    }
  }
}
```

The server is an OAuth resource server, not an authorization server. Protected Resource Metadata is served at the standard well-known paths and its endpoint-specific URL is included in 401 and insufficient-scope 403 challenges. Baseline access uses the configured `requiredScopes`; transaction planning, registration, apply, and rollback additionally require `hoi4:write`. Each MCP session is bound to the exact bearer credential that initialized it, not only to mutable subject/client claims. A refreshed or step-up token must initialize a new MCP session; the previous session remains bound to its original credential and expires no later than that credential's `exp`. The server retains only a SHA-256 credential identifier, never the raw token. Static-token sessions keep the configured sliding inactivity lifetime. Terminate TLS at a trusted reverse proxy, preserve Authorization/Origin/Host headers, and do not make a session ID a bearer credential.

### Reverse-proxy boundary

`trustedProxyAddresses` is not a general proxy switch; it affects only the pre-auth rate-limit
address and does not trust forwarded host or protocol metadata. Each entry is one exact IPv4 or
IPv6 address as it appears for the direct socket peer; CIDR ranges and hostnames are rejected. An
IPv4-mapped IPv6 peer is normalized to IPv4 for matching. When the peer is not an exact match, the
application ignores `X-Forwarded-For` and rate-limits the socket address. When it is a match, the
application requires a valid `X-Forwarded-For` value and uses its first comma-separated IP.

The edge proxy must therefore:

- be the only network path to the server port, enforced by a private bind/network and firewall;
- terminate TLS for the HTTPS `publicUrl`;
- remove any client-supplied forwarding chain and set the first `X-Forwarded-For` value to a
  validated originating client IP;
- preserve the bearer `Authorization` header, the original `Origin`, and a `Host` accepted by the
  configured bind host or `publicUrl`;
- enforce its own connection, header-size, body-size, header/request/idle timeout, and pre-auth
  rate ceilings before forwarding.

Do not configure a load-balancer subnet and expect range matching, and do not allow clients to
bypass the named proxy. For multiple proxy hops, use an edge-controlled normalization point that
delivers one trustworthy first address to the directly connected trusted peer.

### Admission, sessions, and streams

Before authentication, the application enforces Node connection/request timeouts and socket
ceilings, then reserves one `maxConcurrentRequests` slot and applies a fixed-minute
`requestsPerMinute` bucket to the resolved client address. Every POST must advertise exact,
unparameterized positive-quality `application/json` and `text/event-stream` response ranges, use exact
`application/json` request media with an absent or `utf-8` charset, and use identity content
encoding. GET must advertise exact positive-quality `text/event-stream`. JSON is fatal-decoded as
UTF-8 and parsed under the raw-wire `maxBodyBytes` ceiling before SDK dispatch. Suffix types,
duplicate/malformed parameters, encoded entities, invalid UTF-8, and parameter-only media mentions
are rejected.

Before those checks, the server counts security-sensitive fields in the raw header list rather
than trusting Node's first-value normalization. Duplicate Host, Authorization, Origin,
Content-Type, Content-Encoding, forwarding identity, or MCP session/protocol fields are rejected.
For an absolute-form request target, its allowlisted authority must exactly match Host; an allowed
Host cannot conceal an untrusted request-target authority.
After authentication, a separate fixed-minute bucket is applied to the principal. Host and any
present Origin are checked before admission. These in-process controls complement, rather than
replace, the edge limits above.

`maxConcurrentRequests` cannot exceed two, and its product with `maxBodyBytes` cannot exceed
16 MiB. The fixed concurrency ceiling also bounds simultaneous offline render allocations; raise
edge capacity by running isolated server instances, not by removing the per-process safety bound.

Session initialization is refused when either the global `maxSessions` or
`maxSessionsPerPrincipal` count (including initializations in progress) is full. Resumable GET
streams use `maxEventStreams` and `maxEventStreamsPerPrincipal`; an accepted long-lived stream
releases the ordinary request-concurrency slot. Each session retains at most 1,000 replay events,
`maxSessionEventBytes`, and the shared `maxEventStoreBytes`, for no longer than
`sessionTtlSeconds`. Old per-session history is evicted first. A new event that cannot fit the
shared budget is not retained for replay and does not evict another session's history.

Principal grants isolate tool, resource, session, and transaction access within one deployment. Run separate least-privilege server instances or containers for mutually distrustful teams or operating-system trust domains; do not treat application-level grants as an OS sandbox.

Runtime registration has two operator capabilities. `registrationRoots` permits read-only source
selection. A caller-declared mod root additionally must be under the default-empty
`writableRegistrationRoots` list, even when source apply is disabled, because mod registration
creates generated storage. Never place a game or dependency directory under a writable
registration root. Granting `allowRegistration` exposes every otherwise-unclaimed source beneath
these capability roots to that principal; prefer static registrations or separate instances for
mutually distrustful users.

Runtime artifact storage must support same-volume hard links so the server can create persistent
owner claims without replacement races. Transaction deployments additionally require an isolated,
persistent `serverStateRoot` on a filesystem with hard-link and atomic-replacement support. Do not
place it beneath any source, capability, artifact, cache, fixture, or `storageRoots` directory.

## Container

```bash
docker build -t hoi4-agent-tools:0.1.3 .
docker run --read-only --rm -p 127.0.0.1:3210:3210 \
  -e HOI4_AGENT_CONFIG=/config/config.json \
  -v /srv/hoi4/config:/config:ro \
  -v /srv/hoi4/game:/srv/hoi4/game:ro \
  -v /srv/hoi4/workspaces:/srv/hoi4/workspaces \
  -v /var/lib/hoi4-agent-tools:/var/lib/hoi4-agent-tools \
  -v /var/lib/hoi4-agent-tools-state:/var/lib/hoi4-agent-tools-state \
  hoi4-agent-tools:0.1.3
```

Port publishing reaches the container through a non-loopback interface. The mounted configuration
for this form must therefore use the public/team OAuth policy above: bind `0.0.0.0`, declare the
canonical HTTPS `publicUrl`, allowlist the coding-agent origin, and validate OAuth access tokens.
Terminate TLS at the configured reverse proxy. Mapping the host port only to `127.0.0.1` limits host
exposure but does not turn the container-side listener into loopback, so it does not permit static
bearer tokens.

When writes are enabled, set `serverStateRoot` to `/var/lib/hoi4-agent-tools-state` in this example.
Keep that mount persistent across restarts and protect it for the dedicated server account. It is a
separate mount because a state root may not overlap `/var/lib/hoi4-agent-tools` when that path is a
configured generated-storage capability.

On Linux, a local-only static-token deployment may instead use `--network host` with the configured
listener kept at `127.0.0.1`; do not combine that mode with `-p`. Host networking changes the
container isolation boundary and is not portable to every Docker host, so review it explicitly
before use.

Do not mount a developer's home directory. A remote server sees only server-side mounts; the MCP client does not tunnel local files.

If a configured workspace has `kind: "game"` or `kind: "dependency"`, mount a separate writable
operator-owned generated-data directory, list its parent in `storageRoots`, and set both
`artifactRoot` and `cacheRoot` beneath it. Never make the installed-game or dependency source
mount writable merely to hold generated state. Mod workspaces may instead use their confined
`<mod>/.hoi4-agent/artifacts` and `<mod>/.hoi4-agent/cache` defaults.

The server does not launch or capture Hearts of Iron IV. A self-hosted deployment needs filesystem
access only; it does not need a desktop session, Steam automation, or game-process permissions.

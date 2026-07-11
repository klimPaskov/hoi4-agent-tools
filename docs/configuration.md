# Configuration and workspaces

Pass a config with `--config PATH` or `HOI4_AGENT_CONFIG`. Without either override, the server uses
`~/.config/hoi4-agent-tools/config.json` on every platform (for example,
`C:\\Users\\name\\.config\\hoi4-agent-tools\\config.json` on Windows). A different durable absolute
path is equally valid when the client registration sets `HOI4_AGENT_CONFIG`. Unknown fields are
rejected.
The read-only setup discovery command also checks `HOI4_GAME_ROOT` and the path-delimited `HOI4_MOD_ROOTS`; it reports candidates without registering or modifying them.

The stdio executable accepts newline-delimited JSON-RPC frames up to a fixed 16,777,216-byte
ceiling, excluding the line-feed delimiter. This transport safety limit is deliberately not a
configuration field; malformed UTF-8 and oversized terminated or unterminated frames close the
stdio connection with a stderr diagnostic and no protocol output. Streamable HTTP uses the
separately configured `http.maxBodyBytes`.

```json
{
  "version": 1,
  "writePolicy": "read-only",
  "serverStateRoot": "/var/lib/hoi4-agent-tools-state",
  "transactionTtlSeconds": 3600,
  "transactionMaxJournalBytes": 536870912,
  "transactionMaxJournals": 128,
  "scanMaxFiles": 20000,
  "scanMaxBytes": 134217728,
  "scanMaxFileBytes": 67108864,
  "artifactMaxBytes": 536870912,
  "artifactMaxEntries": 5000,
  "artifactMaxSingleBytes": 134217728,
  "registrationRoots": ["/srv/hoi4/workspaces", "/srv/hoi4/game", "/srv/hoi4/dependencies"],
  "writableRegistrationRoots": ["/srv/hoi4/workspaces"],
  "storageRoots": ["/var/lib/hoi4-agent-tools"],
  "workspaces": [
    {
      "id": "example",
      "name": "Example Mod",
      "kind": "mod",
      "root": "/srv/hoi4/workspaces/example",
      "gameRoot": "/srv/hoi4/game",
      "dependencyRoots": [],
      "dependencies": [
        {
          "root": "/srv/hoi4/dependencies/base",
          "replacePaths": ["common/ideas"]
        }
      ],
      "replacePaths": ["common/national_focus"],
      "artifactRoot": "/srv/hoi4/workspaces/example/.hoi4-agent/artifacts",
      "cacheRoot": "/srv/hoi4/workspaces/example/.hoi4-agent/cache",
      "writeEnabled": false
    }
  ]
}
```

## Server fields

All byte values are exact bytes. Defaults are applied when a field is omitted.

| Field                        |                 Default | Validation and behavior                                                                                                                                                                           |
| ---------------------------- | ----------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                    |                required | Must equal the current configuration version, `1`.                                                                                                                                                |
| `writePolicy`                |           `"read-only"` | `"read-only"` or `"transactions"`.                                                                                                                                                                |
| `serverStateRoot`            |                 omitted | Required for `"transactions"`; absolute canonical operator state used for the private journal key and replay-protection heads.                                                                    |
| `transactionTtlSeconds`      |                  `3600` | 60 through 86,400 seconds.                                                                                                                                                                        |
| `transactionMaxJournalBytes` |             `536870912` | At least 1 MiB; aggregate transaction-journal retention ceiling and per-plan work ceiling.                                                                                                        |
| `transactionMaxJournals`     |                   `128` | 1 through 10,000 journals per workspace cache.                                                                                                                                                    |
| `scanMaxFiles`               |                 `20000` | 1 through 1,000,000 enumerated files per scan.                                                                                                                                                    |
| `scanMaxBytes`               |             `134217728` | At least 1 MiB of file content per scan.                                                                                                                                                          |
| `scanMaxFileBytes`           |              `67108864` | At least 64 KiB and no greater than `scanMaxBytes`.                                                                                                                                               |
| `artifactMaxBytes`           |             `536870912` | At least 1 MiB across one workspace artifact store; a lower value also bounds logical chunk preparation, which has an independent fixed 536,870,912-byte ceiling.                                 |
| `artifactMaxEntries`         |                  `5000` | 1 through 100,000 provenance manifests.                                                                                                                                                           |
| `artifactMaxSingleBytes`     |             `134217728` | At least 1 MiB and no greater than `artifactMaxBytes`; applies to content. Provenance manifests have a separate fixed 1 MiB ceiling.                                                              |
| `registrationRoots`          |                    `[]` | Up to 16 operator-approved source parents for runtime `hoi4.project_register`; this alone never grants writable-mod registration.                                                                 |
| `writableRegistrationRoots`  |                    `[]` | Up to 16 narrow descendants of `registrationRoots` that may be runtime `kind: "mod"` roots. Empty fails closed.                                                                                   |
| `storageRoots`               |                    `[]` | Up to 16 operator-approved parents for artifact and cache directories; not a source-registration allowlist.                                                                                       |
| `workspaces`                 |                    `[]` | Up to 1,000 statically reviewed workspace registrations; configured plus runtime registrations may never exceed 1,000.                                                                            |
| `http`                       | loopback defaults below | Streamable HTTP policy. An omitted/default HTTP block has no credentials, so the HTTP executable refuses to start until authentication is configured. Stdio does not require HTTP authentication. |

The configuration also rejects unsafe combined budgets: `scanMaxBytes` multiplied by
`http.maxConcurrentRequests` must be at most 512 MiB, while `maxBodyBytes` multiplied by
`maxConcurrentRequests` must be at most 16 MiB. HTTP concurrency has a fixed maximum of two so two
simultaneous offline renders cannot exceed the supported process-safety model.

`serverStateRoot` is mandatory whenever `writePolicy` is `"transactions"`. It must be absolute,
resolve to a canonical directory through components that contain no symbolic links or junctions,
and it must not overlap any configured or runtime source, fixture, artifact, cache, registration,
writable-registration, or storage root. The server stores the native canonical spelling, including
expanding harmless Windows 8.3 names, only after checking every existing component for links.
The server creates one random 32-byte journal HMAC key there with mode `0600`; the surrounding
POSIX directory must exclude group/other access. Windows operators must grant only the dedicated
server account access through the directory DACL. Keep the same state root when restarting or
temporarily changing to read-only mode so existing journals remain verifiable and recoverable. Do
not copy a state root between unrelated deployments or expose it through a workspace mount.
The state filesystem and every runtime artifact filesystem must support same-volume hard links and
atomic rename/replacement. The server does not substitute a weaker ownership-claim or key-creation
protocol when those primitives are unavailable.

## Workspace fields

| Field             | Default                         | Validation and behavior                                                                                                                      |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | required                        | Lowercase identifier matching `[a-z][a-z0-9_-]{0,63}`; unique in the configuration.                                                          |
| `name`            | required                        | Display name, 1 through 200 characters.                                                                                                      |
| `root`            | required                        | Primary source root. Its root kind is selected by `kind`.                                                                                    |
| `kind`            | `"mod"`                         | `"mod"`, `"game"`, or `"dependency"`. Only a mod primary root can ever be writable.                                                          |
| `gameRoot`        | omitted                         | Optional additional read-only base-game source; it must not overlap another source in the workspace.                                         |
| `dependencyRoots` | `[]`                            | Up to 16 ordered read-only dependency roots without replacement metadata.                                                                    |
| `dependencies`    | `[]`                            | Up to 16 ordered objects with required `root` and up to 1,000 `replacePaths`; mutually exclusive with non-empty `dependencyRoots`.           |
| `replacePaths`    | `[]`                            | Up to 1,000 safe relative paths owned by the primary source root.                                                                            |
| `roots`           | conventional roots below        | Relative source-family search paths. Unknown root-family names are rejected.                                                                 |
| `artifactRoot`    | mod default; otherwise required | A mod defaults to `<root>/.hoi4-agent/artifacts`. A game/dependency primary workspace must name an operator-owned path under `storageRoots`. |
| `cacheRoot`       | mod default; otherwise required | A mod defaults to `<root>/.hoi4-agent/cache`. A game/dependency primary workspace must name an operator-owned path under `storageRoots`.     |
| `fixtureRoot`     | omitted                         | Optional read-only fixture source.                                                                                                           |
| `writeEnabled`    | `false`                         | Effective only for `kind: "mod"` when global `writePolicy` is `"transactions"`.                                                              |

`registrationRoots`, `writableRegistrationRoots`, and `storageRoots` grant different capabilities:

- `registrationRoots` is consulted for runtime registration. The requested primary root and every
  requested game, dependency, and fixture source must pass both lexical and canonical containment
  beneath one of these roots. Statically configured `workspaces` come from the operator-reviewed
  config file and are not required to be beneath `registrationRoots`.
- `writableRegistrationRoots` is a separate, default-empty capability. Every entry must remain
  lexically and canonically beneath `registrationRoots`. A runtime primary root declared as
  `kind: "mod"` must remain beneath one of these narrow roots even when `writeEnabled` is false,
  because mod registration creates generated artifact/cache storage. A game or dependency root
  listed only in `registrationRoots` cannot be relabelled as a writable mod by a caller.
- `storageRoots` permits generated files only. It never makes a directory eligible as a source.
  Explicit artifact/cache paths outside a writable mod must canonicalize beneath one of these
  roots.
- A mod may use its defaults or another descendant of the corresponding
  `<mod>/.hoi4-agent/artifacts` or `<mod>/.hoi4-agent/cache` subtree. It may also use an explicit
  path under `storageRoots`. Artifact and cache roots must be distinct, non-overlapping, and must
  not overlap source roots.
- A `game` or `dependency` primary workspace is read-only and cannot place generated files in its
  source tree. Both generated roots are therefore required and must be explicit operator-owned
  descendants of `storageRoots`.

Read-only source roots may be shared only where the workspace-isolation checks permit it; a
workspace's internal primary/game/dependency/fixture roots must themselves be distinct and
non-overlapping. Writable mod roots and generated roots are protected from overlap with other
workspace-owned roots. The server creates approved artifact/cache directories when needed;
approval comes from containment, not from the directory merely existing.

For example, a read-only primary game workspace needs separate generated storage:

```json
{
  "storageRoots": ["/var/lib/hoi4-agent-tools"],
  "workspaces": [
    {
      "id": "game-reference",
      "name": "Installed Game Reference",
      "kind": "game",
      "root": "/srv/hoi4/game",
      "artifactRoot": "/var/lib/hoi4-agent-tools/game-reference/artifacts",
      "cacheRoot": "/var/lib/hoi4-agent-tools/game-reference/cache"
    }
  ]
}
```

The same explicit-storage requirement applies when the primary `kind` is `"dependency"`.

`dependencyRoots` remains the concise form when dependencies declare no replacement ownership. Use `dependencies` instead when a dependency owns `replace_path` declarations; entries are ordered from lowest to highest precedence, and each replacement hides that subtree only in lower roots. The active mod's `replacePaths` remains the highest-precedence owner. The two dependency forms are mutually exclusive.

`hoi4.project_status` returns one authorized workspace per page when no `workspaceId` is supplied;
follow `nextCursor` until absent. Replacement ownership is summarized with exact counts and bounded
path samples, so a workspace with many `replace_path` entries cannot inflate a tool response.

## Read and write policy

`writePolicy` defaults to `read-only`. Source apply/rollback requires `transactions` globally and `writeEnabled: true` on that mod workspace. A dependency or game registration remains read-only even if misconfigured.

`registrationRoots` controls runtime `hoi4.project_register`. A requested root must canonicalize beneath one of these roots, and a runtime mod additionally requires `writableRegistrationRoots`. HTTP principals also need `allowRegistration`. Granting `allowRegistration` permits that principal to register unclaimed sources beneath the configured capability roots, so use narrow roots or static reviewed workspaces for multi-user deployments. Runtime registration does not edit a client configuration or persist raw paths. It atomically records a hash-only owner/workspace claim in the canonical artifact root; later registrations of that physical store must match it. Reassigning a claimed store is therefore an explicit operator operation: stop the server, review/archive the claim and existing evidence, and choose whether to preserve or separately migrate data. The server never deletes or silently rebinds it.

Transaction mode does not accept pre-upgrade unauthenticated journal manifests. Preserve their
cache directories for operator review, then explicitly archive or remove them together with the
corresponding protected state decision; the server never guesses a migration or treats a public
integrity hash as authorization.

## Conventional roots

Each workspace can override relative root lists:

- localisation: `localisation`, `localisation_synced`
- interface: `interface`
- GFX: `gfx`
- map: `map`
- focuses: `common/national_focus`
- scripted GUI: `common/scripted_guis`
- states: `history/states`

The exact default `roots` object is:

```json
{
  "localisation": ["localisation", "localisation_synced"],
  "interface": ["interface"],
  "gfx": ["gfx"],
  "map": ["map"],
  "focus": ["common/national_focus"],
  "scriptedGui": ["common/scripted_guis"],
  "states": ["history/states"]
}
```

Adapters can change these paths, not the safety model or source semantics.

## HTTP configuration

Loopback static token example:

```json
{
  "http": {
    "host": "127.0.0.1",
    "port": 3210,
    "allowedOrigins": ["https://agent.example.test"],
    "trustedProxyAddresses": [],
    "tokens": [
      {
        "principal": "developer",
        "tokenEnv": "HOI4_AGENT_HTTP_TOKEN",
        "workspaceIds": ["example"],
        "allowRegistration": false
      }
    ],
    "principals": [],
    "maxBodyBytes": 1048576,
    "headersTimeoutMs": 10000,
    "requestTimeoutMs": 30000,
    "keepAliveTimeoutMs": 5000,
    "maxConnections": 64,
    "maxRequestsPerSocket": 100,
    "maxConcurrentRequests": 2,
    "maxSessions": 128,
    "maxSessionsPerPrincipal": 32,
    "maxEventStreams": 32,
    "maxEventStreamsPerPrincipal": 4,
    "maxSessionEventBytes": 1048576,
    "maxEventStoreBytes": 16777216,
    "requestsPerMinute": 120,
    "sessionTtlSeconds": 3600
  }
}
```

Secrets are read from named environment variables and are not stored in config. A missing static
secret, a value shorter than 32 characters, or duplicate secret values make HTTP startup fail. See
[self-hosting](self-hosting.md) for OAuth configuration.

Every HTTP field is listed below. URLs are validated absolute URLs.

| Field                         | Default       | Validation and behavior                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                        | `"127.0.0.1"` | Listen address. Static tokens are permitted only on `127.0.0.1`, `localhost`, or `::1`.                                                                                                                                                                                     |
| `port`                        | `3210`        | 0 through 65,535; `0` requests an ephemeral port.                                                                                                                                                                                                                           |
| `publicUrl`                   | omitted       | Canonical HTTP(S) origin or exact `/mcp` endpoint. Required for OAuth. A non-loopback listener or URL requires HTTPS public OAuth policy, including when a public reverse proxy reaches a loopback listener. Credentials, path prefixes, query, and fragment are forbidden. |
| `allowedOrigins`              | `[]`          | Exact HTTP(S) origins (`scheme://host[:port]`) without credentials, paths, queries, or fragments; opaque origins such as `null` are rejected. A present `Origin` header must match. Non-loopback deployments require at least one.                                          |
| `trustedProxyAddresses`       | `[]`          | Exact IPv4/IPv6 socket-peer addresses allowed to supply `X-Forwarded-For` for the pre-auth rate key only; no CIDR, hostname, other forwarded-header trust, or implicit trust.                                                                                               |
| `tokens`                      | `[]`          | Static-token grants. Mutually exclusive with `oauth`.                                                                                                                                                                                                                       |
| `principals`                  | `[]`          | OAuth subject allowlist and workspace grants. OAuth startup requires at least one entry.                                                                                                                                                                                    |
| `oauth`                       | omitted       | OAuth/OIDC JWT verification settings.                                                                                                                                                                                                                                       |
| `maxBodyBytes`                | `1048576`     | 1,024 through 16,777,216 JSON bytes.                                                                                                                                                                                                                                        |
| `headersTimeoutMs`            | `10000`       | 1,000 through 120,000; cannot exceed `requestTimeoutMs`.                                                                                                                                                                                                                    |
| `requestTimeoutMs`            | `30000`       | 1,000 through 300,000 to receive the complete request.                                                                                                                                                                                                                      |
| `keepAliveTimeoutMs`          | `5000`        | 1,000 through 120,000 and strictly less than `headersTimeoutMs`.                                                                                                                                                                                                            |
| `maxConnections`              | `64`          | 1 through 100,000 accepted server connections.                                                                                                                                                                                                                              |
| `maxRequestsPerSocket`        | `100`         | 1 through 100,000 requests before a socket is retired.                                                                                                                                                                                                                      |
| `maxConcurrentRequests`       | `2`           | 1 through 2 admitted requests, enforced before JSON parsing and authentication. This fixed ceiling bounds concurrent offline render work.                                                                                                                                   |
| `maxSessions`                 | `128`         | 1 through 10,000 active plus pending MCP sessions globally.                                                                                                                                                                                                                 |
| `maxSessionsPerPrincipal`     | `32`          | 1 through 10,000 active plus pending sessions per principal, also capped by `maxSessions`.                                                                                                                                                                                  |
| `maxEventStreams`             | `32`          | 1 through 10,000 simultaneous resumable GET streams globally.                                                                                                                                                                                                               |
| `maxEventStreamsPerPrincipal` | `4`           | 1 through 10,000 simultaneous streams per principal.                                                                                                                                                                                                                        |
| `maxSessionEventBytes`        | `1048576`     | 64 KiB through 64 MiB of replay history per session; cannot exceed `maxEventStoreBytes`.                                                                                                                                                                                    |
| `maxEventStoreBytes`          | `16777216`    | 64 KiB through 256 MiB of replay history shared across sessions.                                                                                                                                                                                                            |
| `requestsPerMinute`           | `120`         | 1 through 100,000 in each fixed minute, independently before auth per client address and after auth per principal.                                                                                                                                                          |
| `sessionTtlSeconds`           | `3600`        | 60 through 86,400; renewed by an authorized request.                                                                                                                                                                                                                        |

Each `tokens` entry requires `principal`, `tokenEnv`, and at least one configured `workspaceId`;
`allowRegistration` defaults to `false`. Token principals and environment-variable names must be
unique. Each `principals` entry requires `principal`; `workspaceIds` defaults to `[]` and
`allowRegistration` to `false`. OAuth principals must be unique, and static-token/OAuth principal
namespaces must be disjoint. Every granted workspace ID must exist in the static configuration.

The `oauth` object requires `issuer`, `jwksUri`, `audience`, and at least one
`authorizationServers` URL. `requiredScopes` defaults to `["hoi4:read"]`. `algorithms` defaults to
`["RS256"]` and accepts only `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, or `EdDSA`.

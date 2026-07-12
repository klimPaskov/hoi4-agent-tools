# HTTP

Local MCP clients should use the default stdio registration. Use `hoi4-agent-tools-http` only when the server must be reached by another process or machine.

The HTTP server exposes the MCP endpoint at `/mcp`.

JSON request bodies default to and are capped at 64 MiB. This leaves transport-envelope headroom for the bounded 16 MiB GUI text package and a maximum canonical map mask while the two-request concurrency ceiling keeps aggregate body bytes at or below 128 MiB.

Resumable event history defaults to 2 MiB per session within the 16 MiB global store, enough to retain one framed 1 MiB artifact-resource chunk.

## Loopback

Keep the listener on `127.0.0.1`, configure a long random bearer token through an environment variable named by the HTTP config, and allow only the client origins you use. Do not place tokens in the config file or command line.

Add an HTTP section to a config created by setup:

```json
{
  "version": 1,
  "serverStateRoot": "/var/lib/hoi4-agent-tools/state",
  "modRoots": ["/projects/hoi4-mods"],
  "workspaceStorageRoot": "/var/lib/hoi4-agent-tools/workspaces",
  "http": {
    "host": "127.0.0.1",
    "port": 3210,
    "allowedOrigins": ["https://agent.example"],
    "tokens": [
      {
        "principal": "local-agent",
        "tokenEnv": "HOI4_AGENT_HTTP_TOKEN",
        "allowDiscoveredMods": true
      }
    ]
  }
}
```

Set `HOI4_AGENT_HTTP_TOKEN` to a random value of at least 32 characters, then run `hoi4-agent-tools-http --config PATH`. `allowDiscoveredMods` grants that principal only the mod IDs created by discovery beneath `modRoots`; it never grants unrelated explicit workspaces. For narrower remote access, define the permitted mods as explicit `workspaces`, list those IDs in `workspaceIds`, and omit `allowDiscoveredMods`.

## Shared or remote access

A non-loopback deployment needs:

- HTTPS at a trusted reverse proxy;
- OAuth/OIDC token validation;
- an exact origin allowlist;
- explicit user-to-mod grants;
- narrow mounted mod and game paths;
- request, connection, and session limits.

Do not expose a developer home directory or a whole game library. The installed game and dependencies should be mounted read-only. Use separate server instances for teams that should not share operating-system access.

The server never launches Hearts of Iron IV and does not need a desktop or Steam session. See the repository [Security Policy](../SECURITY.md) before exposing HTTP beyond loopback.

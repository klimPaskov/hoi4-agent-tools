# ADR 0011: Authenticated, origin-checked Streamable HTTP

- Status: accepted
- Date: 2026-07-10

## Decision

HTTP binds to `127.0.0.1` by default. Every request is authenticated. Loopback deployments may use long static bearer tokens loaded from environment variables. Non-loopback deployment requires an HTTPS public resource URL and JWT verification against configured OAuth/OIDC issuer, JWKS, audience, algorithms, and scopes. Protected-resource metadata is published, present origins are allowlisted, Host is validated, sessions use cryptographically secure IDs bound to principals, and body/rate/concurrency/session limits are enforced.

## Rationale

MCP sessions are routing state, not authentication. OAuth resource-server validation and principal-to-workspace grants prevent token passthrough, confused-deputy behavior, and cross-user workspace access. Origin and Host checks address DNS rebinding and browser-origin attacks.

## Consequences

The server does not implement an authorization server. Operators configure a compatible issuer or keep HTTP on loopback. Stdio does not use MCP OAuth and inherits local process permissions plus the same workspace policy.

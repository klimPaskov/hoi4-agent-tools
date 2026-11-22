# Provenance: hoi4-server

Sources this crate adapts, one row per adapted file. Every source is in this repository at commit 9b7dc80d.

| Rust file | Adapted from | Commit |
| --------- | ------------ | ------ |
| `src/error.rs` | `src/hoi4_agent_tools/core/result.ts` (`ServiceError`) | 9b7dc80d |
| `src/config.rs` | `src/hoi4_agent_tools/core/configuration.ts` (`tokenSchema`, `principalSchema`, `allowedOriginSchema`, the `http` object and its refinements, the grant checks of `loadConfiguration`) | 9b7dc80d |
| `src/auth.rs` | `src/hoi4_agent_tools/mcp/security/auth.ts` (whole file; the JWT signature check is behind the `JwtVerifier` trait) | 9b7dc80d |
| `src/headers.rs` | `src/hoi4_agent_tools/mcp/transports/http.ts` (`SINGLETON_SECURITY_HEADERS`, `splitHttpHeader`, `decodeHttpParameterValue`, `parseMediaType`, `acceptsExactMediaTypes`, `rejectAmbiguousSecurityHeaders`, `requireMcpJsonContentType`, `requireIdentityContentEncoding`) | 9b7dc80d |
| `src/limits.rs` | `src/hoi4_agent_tools/mcp/transports/http.ts` (`normalizeIpAddress`, `rateLimitClientAddress`, `admissionMiddleware`, the per-principal rate, the overflow gate) | 9b7dc80d |
| `src/grants.rs` | `src/hoi4_agent_tools/core/workspace.ts` (`allowedWorkspaceIds`, `discoveredModsAllowed`, the principal check of `get`); `src/hoi4_agent_tools/mcp/transports/http.ts` (`WRITE_SCOPED_TOOLS`, `requiredScopesForMcpRequest`) | 9b7dc80d |
| `src/event_store.rs` | `src/hoi4_agent_tools/mcp/transports/event-store.ts` (whole file) | 9b7dc80d |
| `src/session.rs` | `src/hoi4_agent_tools/mcp/transports/http.ts` (`Session`, `sessionAuthorizationMatches`, `boundedSessionExpiration`, `findSession`, the session and stream limits) | 9b7dc80d |
| `src/protocol.rs` | `src/hoi4_agent_tools/mcp/transports/protocol-gate.ts` (whole file); `rejectInvalidProtocolHeader` of `http.ts`; `SUPPORTED_PROTOCOL_VERSIONS` of `@modelcontextprotocol/sdk` | 9b7dc80d |
| `src/jsonrpc.rs` | the message checks of `@modelcontextprotocol/sdk` (`JSONRPCMessageSchema`, `isInitializeRequest`); the server identity of `src/hoi4_agent_tools/mcp/server/create.ts` | 9b7dc80d |
| `src/stdio.rs` | `src/hoi4_agent_tools/mcp/transports/bounded-stdio.ts` and `stdio-lifetime.ts` (whole files) | 9b7dc80d |
| `src/http.rs` | `src/hoi4_agent_tools/mcp/transports/http.ts` (`startHttpServer`, `httpUrlHost`, `httpAllowedHostname`, `validateRequestTargetAuthority`, `jsonRpcError`, `sendAuthError`); `hostHeaderValidation` and the stream rules of `StreamableHTTPServerTransport` of `@modelcontextprotocol/sdk` | 9b7dc80d |
| `src/random.rs` | new; replaces `randomUUID` of `node:crypto` | 9b7dc80d |
| `tests/http_security.rs` | `tests/integration/http-security.test.ts`, `http-authorization.test.ts`, `http-limits.test.ts`, `http-streaming.test.ts` | 9b7dc80d |

Unit tests ported beside their modules: `tests/unit/auth-edge-cases.test.ts` and `oauth-auth.test.ts` (claim rules) and `http-deployment.test.ts` in `auth.rs`; `http-client-address.test.ts` in `limits.rs`; `event-store.test.ts` in `event_store.rs`; `bounded-stdio.test.ts` and `stdio-lifetime.test.ts` in `stdio.rs`.

Not yet ported, and refused instead of guessed: the 2026-07-28 modern protocol of `routeModernRequest` and `create-modern-operations.ts`, JWT signature verification against a JWKS (an OAuth deployment without a verifier refuses to start), and tool schemas generated from Rust types (they come with the tool wiring, ADR 0089 step 8).

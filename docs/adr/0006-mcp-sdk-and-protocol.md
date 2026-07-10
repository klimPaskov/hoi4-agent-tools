# ADR 0006: Stable MCP 2025-11-25 and SDK 1.29.0

- Status: accepted
- Date: 2026-07-10

## Decision

Pin `@modelcontextprotocol/sdk` 1.29.0 and implement the final MCP revision `2025-11-25`. Use `McpServer`, `StdioServerTransport`, and stateful `StreamableHTTPServerTransport`. Register strict tools, opaque resources, resource templates, and prompts through the official SDK.

## Rationale

On 2026-07-10, `2025-11-25` remains the current final protocol. The breaking `2026-07-28` revision and split SDK v2 packages are release candidates, not the production line. The v1 SDK remains the upstream recommendation.

## Consequences

Capability negotiation is tested against the versions advertised by the pinned SDK. Features are gated by the negotiated revision. The project rechecks the final protocol and SDK before every release after 2026-07-28. Experimental MCP Tasks are not foundational; normal progress and cancellation are used.

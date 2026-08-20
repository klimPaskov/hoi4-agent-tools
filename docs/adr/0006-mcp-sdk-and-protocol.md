# ADR 0006: Stable MCP 2025-11-25 and SDK 1.30.0

> Tool-count, discovery-budget, and prompt decisions in this ADR are superseded by [ADR 0015](0015-ai-mtth-scenario-analyzer.md).

- Status: accepted
- Date: 2026-07-10
- Last reviewed: 2026-08-15

## Decision

Pin `@modelcontextprotocol/sdk` 1.30.0 and implement the final MCP revision `2025-11-25`. Use `McpServer`, SDK JSON-RPC stdio serialization/deserialization behind the product's bounded newline-frame transport, and stateful `StreamableHTTPServerTransport`. Register strict domain tools, the optional weighted-logic prompt, and the content-addressed artifact resource template through the official SDK. Local tool calls resolve the mod containing the MCP working directory. Domain ADRs own the current tool and prompt inventory.

## Rationale

Rechecked on 2026-08-09, `2025-11-25` remains the current final protocol. The breaking `2026-07-28` revision and split SDK v2 packages remain release candidates, not the production line. The stable v1 SDK remains the production recommendation. ADR 0014 adds the compact three-tool Technology Tree Viewer without changing this protocol baseline.

## Consequences

Capability negotiation is tested against every revision recognized by the pinned SDK, and the product transports let the SDK negotiate any revision it supports (as of SDK 1.30.0: `2024-10-07` through `2025-11-25`). Unknown revisions fall back to the latest supported revision via the documented sentinel rewrite. This keeps coding-agent clients that only implement older revisions (for example Qoder, capped at `2025-06-18`) connectable instead of rejecting them at initialization. The HTTP transport accepts any supported revision in the `MCP-Protocol-Version` header. The project rechecks the final protocol and SDK before every release after 2026-07-28. Experimental MCP Tasks are not foundational; normal progress and cancellation are used.

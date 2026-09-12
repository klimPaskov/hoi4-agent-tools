# ADR 0006: MCP 2025-11-25 compatibility baseline and SDK 1.30.0

> Tool-count, discovery-budget, and prompt decisions in this ADR are superseded by [ADR 0015](0015-ai-mtth-scenario-analyzer.md).

- Status: accepted
- Date: 2026-07-10
- Last reviewed: 2026-09-12

## Decision

Pin `@modelcontextprotocol/sdk` 1.30.0 and implement the final MCP revision `2025-11-25`. Use `McpServer`, SDK JSON-RPC stdio serialization/deserialization behind the product's bounded newline-frame transport, and stateful `StreamableHTTPServerTransport`. Register strict domain tools, the optional weighted-logic prompt, and the content-addressed artifact resource template through the official SDK. Local tool calls resolve the mod containing the MCP working directory. Domain ADRs own the current tool and prompt inventory.

## Rationale

The implementation retains the tested 2025-era transport baseline while using the pinned SDK's negotiated experimental task surface.
As verified on 2026-09-08, [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) is the current protocol and the [split TypeScript SDK 2.0.0 packages](https://github.com/modelcontextprotocol/typescript-sdk/releases) are released, not release candidates.
The accepted [incremental-analysis and persistent-jobs stage](../specs/deeper-analysis-and-agent-integration.md) owns their migration and negotiated task support, including regression tests for existing clients.
The [official migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) requires explicit modern serving entry points; upgrading package dependencies alone does not enable the new protocol.

## Consequences

Capability negotiation is tested against every revision recognized by the pinned SDK, and the product transports let the SDK negotiate supported 2025-era revisions.
Unknown initialization revisions fall back to the SDK's latest supported revision via the sentinel rewrite; this is not a claim of complete MCP 2026-07-28 protocol support.
The HTTP transport accepts supported revisions in the `MCP-Protocol-Version` header.
The server advertises optional tool-call tasks through the SDK extension for registered domain operations and retains ordinary progress, cancellation, and synchronous calls for existing clients.
Persistent jobs, reconnect behavior, retry identity, and task status mapping are owned by [ADR 0029](0029-persistent-jobs.md).
A future migration to the split 2.x SDK and complete 2026 protocol remains a separate compatibility project rather than a prerequisite for these negotiated adapters.

# MCP Protocol Research Notes

Reviewed on 2026-07-10. Implementation must verify the latest published specification and registry schema again before coding because MCP is still evolving.

## Current official direction used by this package

- The latest published protocol specification found during planning is `2025-11-25`.
- Standard deployment modes are stdio for local child-process integrations and Streamable HTTP for remote servers.
- Streamable HTTP uses one MCP endpoint supporting POST and GET, with optional server-sent streaming.
- Network servers must validate origins. Local HTTP should bind to localhost by default. Authenticated public deployments need proper authorization and secure, non-predictable session identifiers.
- Local stdio servers must keep protocol data on stdout and write logs to stderr.
- Tools support annotations such as read-only, destructive, idempotent, and open-world hints. These are descriptive hints and do not replace server-side enforcement.
- Large outputs can be returned through MCP resource links instead of embedding full artifacts in tool text.
- The official MCP Registry stores metadata and installation information. It does not host the server package itself.
- The Registry currently supports public package metadata for npm, PyPI, NuGet, OCI images, and MCPB packages. The actual supported package type should match the chosen implementation language and release workflow.
- Published registry versions are immutable. Package, `server.json`, and registry versions must remain synchronized.
- MCP Inspector is the required interactive protocol test surface.

## Primary sources

- MCP specification: https://modelcontextprotocol.io/specification/2025-11-25
- Transport specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Tools specification: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Schema reference: https://modelcontextprotocol.io/specification/2025-11-25/schema
- Security guidance: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- Debugging and MCP Inspector: https://modelcontextprotocol.io/docs/tools/debugging
- Registry overview: https://modelcontextprotocol.io/registry/about
- Registry publishing quickstart: https://modelcontextprotocol.io/registry/quickstart
- Registry package types: https://modelcontextprotocol.io/registry/package-types
- Registry versioning: https://modelcontextprotocol.io/registry/versioning
- Official TypeScript SDK server guide: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md

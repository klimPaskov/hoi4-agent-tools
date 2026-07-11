# Validation, Delivery, and Agent Integration

## Implementation order

Implement in this order:

1. standalone Git repository bootstrap
2. architecture research and decision records
3. workspace resolver and configuration
4. shared source parser and source map
5. symbol and dependency index
6. diagnostics, transaction, diff, artifact, and rollback engine
7. Focus Tree Workbench
8. Scripted GUI Studio scene graph and renderer
9. Scripted GUI Studio state, fidelity, and visual validation
10. Agent Nudger map operations and rendering
11. Agent Nudger static and engine-compatible validation
12. MCP server with stdio and Streamable HTTP transports
13. package publication, Registry metadata, installer, diagnostics, and coding-agent configuration examples
14. documentation, MCP prompts, and agent integration guides
15. final fixtures, audits, and completion report

Do not build separate parsers or transaction models for the three modules.

The Scripted GUI Studio remains fully offline. Do not add game launching, input automation, save loading, temporary gameplay hooks, or screenshot capture from Hearts of Iron IV.

## Testing

Add:

- unit tests
- parser round-trip tests
- source-preservation tests
- schema tests
- golden-output tests
- negative fixtures
- deterministic-output tests
- transaction rollback tests
- property-based tests where useful
- renderer image comparison tests
- GUI state-matrix tests
- font-metric and text-overflow tests
- bitmap pixel-diff tests
- local vanilla source integration tests
- external mod workspace integration tests
- MCP tool, resource, and prompt discovery tests
- MCP stdio and Streamable HTTP transport tests
- MCP security, workspace isolation, and stale-transaction tests
- clean-environment package installation tests
- Registry metadata tests

Offline CI uses standalone-project-owned synthetic fixtures. Local integration tests may read installed game files and external mod files for parsing and rendering, but must not copy proprietary or unrelated source into the server repository or launch the game.

Record performance on large trees, large GUI scene graphs, and full map scans. Cache only data that can be safely invalidated from file metadata or content hashes.

## Documentation

Create documentation for:

- standalone architecture and dependency decisions
- MCP installation and coding-agent connection
- workspace registration and permissions
- security and transaction approval
- focus-tree agent workflow
- GUI source graph and rendering workflow
- GUI preview scenarios and fidelity reports
- map agent workflow
- transaction manifests and rollback
- artifact resources
- troubleshooting
- unsupported constructs and blockers
- fixture and integration test instructions
- package release and Registry publication

Every GUI artifact identifies the preview scenario, source revision, resolution, UI scale, rendered state, modelled fields, approximated fields, and unsupported fields. Never label an offline render as an in-game screenshot.

## Agent integration

The server is designed for MCP-compatible coding agents. Provide:

- strict tool schemas
- concise tool descriptions
- MCP prompts for safe focus, GUI, and map workflows
- resource templates for generated artifacts
- example client configuration for common coding-agent hosts
- tool annotations for read-only, mutating, destructive, and idempotent behavior
- clear progress and cancellation behavior
- transaction approval patterns that work with client confirmation interfaces

Do not require Chaos Redux skills or subagents. The standalone repository may include generic agent guidance and MCP prompts, but it must not depend on another repository's `.agents` folder.

Operators may install the package, register workspaces, and define client permission policy. Coding agents decide when to use the registered MCP capabilities. The product does not expose a directly operated focus editor, GUI editor, map editor, or full tool CLI.

## Completion standard

The goal is complete only when:

- the standalone repository exists at the required path and has its own Git history
- all three modules are callable through the public MCP server
- local stdio and secured Streamable HTTP transports work
- the server is installable from a public package and has valid `server.json` Registry metadata
- MCP tools, resources, prompts, annotations, progress, cancellation, security gates, and artifact links pass acceptance tests
- all three modules use the shared parser, resolver, index, diagnostics, artifact, and transaction system
- dry-run, source diff, visual diff, apply, and rollback work
- large focus-tree rendering and linting pass the acceptance fixture
- GUI parsing, rendering, state galleries, fidelity reports, and visual validation pass the acceptance fixture
- the GUI module never launches or automates Hearts of Iron IV
- Agent Nudger safely edits state membership and province geometry
- map fixtures and required validation pass
- no proprietary vanilla assets are committed
- documentation and coding-agent integration are complete
- all known limitations are precise and reproducible
- every simplification, omission, and blocker is reported

If province geometry editing, atomic rollback, deterministic rendering, fidelity reporting, MCP publication, transport support, write safety, workspace isolation, or required validation remains unimplemented, report the goal as incomplete. Static diagrams, mock tools, and placeholder renders are not completion evidence.

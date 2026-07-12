# Public MCP Server and Distribution

## Purpose

Make the complete HOI4 agent workbench available through a public Model Context Protocol server. Coding agents connect to the server and call structured tools while working on registered HOI4 mod workspaces.

The MCP server is the product interface. There is no separate supported interactive focus, GUI, or map application. Internal service calls, launch entry points, test harnesses, and maintenance scripts may exist, but they cannot become a second behavior model.

## Architecture

Create the MCP implementation inside the standalone repository:

```text
src/hoi4_agent_tools/
  mcp/
    server/
    transports/
    tools/
    resources/
    prompts/
    security/
    registry/
```

MCP handlers call typed core services directly. They must not scrape command output or duplicate focus, GUI, map, parser, transaction, rendering, or validation logic.

Use the current official MCP SDK for the chosen implementation language. Pin compatible versions, record supported protocol versions, and test capability negotiation.

## Required transports

### Local stdio

Local stdio is mandatory for coding agents that run the server as a child process on the mod developer's machine.

Provide one stable server entry point suitable for MCP client configuration. Protocol messages use stdout. Logs and diagnostics use stderr.

### Streamable HTTP

Streamable HTTP is mandatory for controlled self-hosted, team, container, and hosted deployments. Do not build a legacy SSE-only server.

Local HTTP binds to `127.0.0.1` by default. Public binding requires explicit configuration, authentication, origin validation, request limits, secure session identifiers, and deployment documentation.

A remote server accesses only workspaces mounted or registered on that server. It cannot reach a developer's local mod or game installation through the MCP client.

## MCP tool surface

Expose a small, stable tool family. Tool names should be namespaced and versionable.

Required tool groups:

- `project_register`, `project_scan`, `project_status`
- `focus_scan`, `focus_lint`, `focus_layout`, `focus_render`, `focus_rewrite`
- `gui_scan`, `gui_lint`, `gui_render`, `gui_render_states`, `gui_compare`, `gui_rewrite`
- `map_scan`, `map_inspect`, `map_allocate`, `map_render`, `map_validate`, `map_rewrite`
- `artifact_list`, `artifact_describe`

The final schema may merge closely related read-only operations when that reduces context use without hiding behavior.

Every tool has strict input and output schemas, bounded defaults, deterministic error codes, source-linked diagnostics, and accurate annotations. Long operations support progress and cancellation where the protocol and SDK permit it.

## Resources and prompts

Use MCP resources for large or reusable outputs.

Provide stable resource URIs for:

- workspace summaries and capability reports
- diagnostics
- rewrite receipts, source/visual diffs, and validation evidence
- focus HTML, SVG, PNG, and JSON renders
- GUI renders, state galleries, hierarchy reports, and fidelity reports
- map previews, pixel diffs, and validation reports
- documentation and schema references

Tool calls return compact summaries plus resource links with MIME type and size when known.

Provide MCP prompts for focus-tree, scripted-GUI, and map-editing workflows. Prompts guide coding agents but never replace tool validation or operator-owned workspace policy. In an autonomous workspace, prompts direct the agent to the appropriate one-call domain rewrite and must not require a caller-managed transaction review, plan hash, separate apply, or rollback step.

## Write safety

The server starts read-only.

The primary write path requires:

1. explicit operator configuration whose effective policy for the mod workspace is `writePolicy: "autonomous"`
2. a canonical allowlisted mod workspace root; game, dependency, fixture, cache, artifact, and unrelated roots remain non-writable
3. an authenticated and authorized principal with access to that workspace and, for remote transports, the write scope
4. one `focus_rewrite`, `gui_rewrite`, or `map_rewrite` request containing the complete declarative edit input

Within that one request, the server calculates the complete affected-file set, validates the proposal in memory, creates relevant diff/render evidence, acquires the workspace lock, rechecks roots and every source hash, persists an authenticated journal with exact before bytes, performs recoverable atomic replacement, rebuilds the affected index, and runs post-write validation. A blocker returns before source mutation. A write or validation failure restores exact original bytes automatically before returning whenever safe recovery is possible. Stale, changed-root, cross-workspace, and cross-principal requests fail closed.

The autonomous caller never needs to receive or resubmit a transaction ID or plan hash, page through a transaction diff, call a separate apply operation, or invoke rollback. A manually staged `writePolicy: "transactions"` mode and its legacy tools may remain available as an explicitly enabled compatibility surface, but it is not required by discovery, prompts, examples, or primary acceptance.

Prevent path traversal, symlink escape, arbitrary command execution, unrestricted environment access, and access outside registered workspace, dependency, game, cache, and artifact roots. Never expose secrets, client configuration files, unrelated user files, or proprietary game assets as downloadable resources.

Remote deployments require per-user authorization and workspace isolation. Sessions cannot serve as authentication. Validate inbound requests and origins according to current MCP security guidance.

## Installation and discovery

Publish the server as an installable package for the chosen language. Provide a reproducible container image when practical.

Create and maintain:

- `server.json`
- package verification metadata required by the official MCP Registry
- public repository README
- license and security policy
- changelog
- supported-platform matrix
- one-command package installation examples
- coding-agent client configuration examples
- container and self-hosting examples

Publish metadata to the official MCP Registry after the package or image is publicly available.

Provide a minimal setup utility or installation flow that can discover paths, register a workspace, test permissions and rendering dependencies, and print reviewable MCP client configuration. This utility exists for installation and diagnostics. It does not expose the focus, GUI, or map tools for direct interactive use and must not silently edit another application's settings.

## Versioning and compatibility

Use semantic versioning. Keep package version, server version, registry metadata, schemas, and changelog synchronized.

Document supported MCP protocol versions, minimum runtime version, platform behavior, game-file access requirements, project configuration migration, renamed tools, deprecation periods, and compatibility guarantees.

Do not remove or change a public tool schema without a major version or documented compatibility path.

## Testing and acceptance

Test with the official MCP Inspector and automated protocol clients.

Required tests:

- tool, resource, and prompt discovery
- capability negotiation
- stdio framing and stderr-only logging
- Streamable HTTP request and streaming behavior
- origin rejection and authentication behavior
- concurrent users and isolated workspaces
- read-only default policy
- explicit autonomous workspace-policy enforcement
- one-call focus, GUI, and map rewrites with no caller transaction choreography
- stale-source and changed-root rejection inside the rewrite call
- exact automatic recovery after injected write and post-validation failures
- path traversal and symlink escape attempts
- cancellation and progress
- large artifact resource links
- deterministic schemas and responses
- clean installation from the published package
- registry metadata validation
- agent workflow tests covering focus, GUI, and map operations end to end

The MCP server is incomplete if it wraps mock tools, bypasses internal journal and recovery safety, requires caller-managed transaction IDs, hashes, diff/apply calls, or rollback for the primary workflow, requires hand-written client glue, exposes a separate interactive editor, or cannot be installed from its published package.

# Project Instructions

HOI4 Agent Tools is a public Model Context Protocol server for coding agents that work on allowlisted, external Hearts of Iron IV workspaces. The MCP server is the product surface; do not add a dashboard, interactive editor, or gameplay-tool CLI.

## Engineering boundaries

- Keep workspace resolution, Clausewitz parsing, indexing, diagnostics, transactions, artifacts, diffs, and rollback in `src/hoi4_agent_tools/core`.
- Focus, GUI, map, and MCP adapters must call the same typed core services. Transport handlers contain no domain logic.
- Preserve source bytes when no edit is requested. Preserve comments, ordering, unknown fields, raw blocks, newline style, and detected encoding during targeted edits.
- Refuse a rewrite when a construct cannot be represented safely.
- The server starts read-only. A write requires an allowlisted canonical workspace, enabled write policy, a completed dry run, transaction ID, expected plan hash, and a separate apply call.
- Reject traversal, symlink escape, cross-workspace access, stale plans, arbitrary commands, and access outside configured roots.
- Never launch, automate, control, or capture output from the game. Offline renders are tool-generated evidence, never game screenshots.
- Do not commit installed-game content or third-party mod content. CI fixtures must be synthetic and project-owned.

## Code and tests

- Use strict TypeScript and explicit public types. Validate every external input with schemas.
- Keep output deterministic: stable sorting, canonical JSON, seeded algorithms, fixed rendering inputs, and content-addressed artifacts.
- Add tests beside every behavior change. Security, preservation, transaction, rendering, and transport changes require negative tests.
- Use `npm run check` before committing. Run local integration tests only when their opt-in environment variables are configured.
- Write files through the transaction engine; test setup may create isolated temporary fixtures directly.
- Log only to stderr in stdio mode. Never log secrets, source contents, or unrelated paths.

## Documentation and releases

- Record architecture changes in `docs/adr`.
- Keep package version, server version, schemas, `server.json`, and changelog synchronized.
- Public tool schema changes require compatibility review and semantic versioning.
- Document unsupported constructs precisely; do not hide them behind guessed behavior.
- Release only from a clean, tested commit through the repository workflows.

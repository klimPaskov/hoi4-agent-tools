# Project Instructions

HOI4 Agent Tools is a public Model Context Protocol server for coding agents that analyze event chains and create or clean focus trees, scripted GUIs, and maps in external Hearts of Iron IV mods. The MCP server is the product surface; do not add a dashboard, interactive editor, or gameplay-tool CLI.

## Engineering boundaries

- Keep workspace resolution, Clausewitz parsing, indexing, diagnostics, atomic writes, artifacts, diffs, and failure recovery in `src/hoi4_agent_tools/core`.
- Focus, GUI, map, event, and MCP adapters must call the same typed core services. Transport handlers contain no domain logic.
- Preserve source bytes when no edit is requested. Preserve comments, ordering, unknown fields, raw blocks, newline style, and detected encoding during targeted edits.
- Refuse a rewrite when a construct cannot be represented safely.
- Every real mod directory directly beneath a configured mod root is discovered as a writable workspace. Explicit workspaces may add nonstandard locations, but they must not weaken canonical-path checks. Each domain rewrite is one MCP call; validation, stale-source checks, atomic replacement, and failure recovery stay internal. Never expose transaction IDs, plan hashes, separate apply calls, or rollback commands to coding agents.
- Remote rewrites retain authentication, Origin and Host validation, principal-to-workspace grants, request limits, and session isolation. Remote access never broadens a configured root or principal grant.
- Reject traversal, symlink escape, cross-workspace access, stale source or provenance, arbitrary commands, and access outside configured roots.
- Never launch, automate, control, or capture output from the game. Offline renders are tool-generated evidence, never game screenshots.
- Keep the Event Chain Viewer read-only. It statically analyzes definitions, calls, state, scope, timing, and routes; it is not an event writer or runtime simulator.
- Do not commit installed-game content or third-party mod content. CI fixtures must be synthetic and project-owned.

## Code and tests

- Use strict TypeScript and explicit public types. Validate every external input with schemas.
- Keep output deterministic: stable sorting, canonical JSON, seeded algorithms, fixed rendering inputs, and content-addressed artifacts.
- Add tests beside every behavior change. Security, parsing, write recovery, rendering, and transport changes require negative tests.
- Use `npm run check` before committing. Run local integration tests only when their opt-in environment variables are configured.
- Write files through the shared atomic rewrite engine; test setup may create isolated temporary fixtures directly.
- Log only to stderr in stdio mode. Never log secrets, source contents, or unrelated paths.

## Documentation and releases

- Record architecture changes in `docs/adr`.
- Keep package version, server version, schemas, `server.json`, and changelog synchronized.
- Public tool schema changes require compatibility review and semantic versioning.
- Document unsupported constructs precisely; do not hide them behind guessed behavior.
- Release only from a clean, tested commit through the repository workflows.

# ADR 0089: Agent Tools 5.0.0 is one Rust program

Status: accepted (maintainer decision D-102, 2026-11-21, which replaces D-101)

## Context

ADR 0074 started the shared Rust engine, and ADRs 0080 to 0085 moved routes onto it one at a time behind the same tool names. The engine is now about 23,600 lines in seven crates. The symbol index every tool reads is built by the engine, and the TypeScript index is retired (ADR 0085). Eight tools answer from the engine, and several more call it for one step. The TypeScript server is still about 178,500 lines. That count includes the core services that carry the security rules of the project instructions (about 24,700 lines) and the MCP transport with its schemas (about 15,500 lines).

Decision D-92 ties 5.0.0 to the end of the rewrite, but no record said whether the MCP server itself becomes Rust. D-101 first kept a thin TypeScript transport over an all-Rust core, so the package would still need Node. The same evening the maintainer replaced it with D-102: everything moves, the transport too.

The reason for the move is speed and a simpler install. Issue 137 (an edit plus an inspect under one second) and issue 69 (cold paths) are both bounded by work the TypeScript server does around the engine. A modder today needs Node 22 or 24 to run the server, and with one binary they would not.

## Decision

**One Rust program per platform.** Agent Tools 5.0.0 is a single Rust binary for each supported platform (Windows x64, macOS arm64, Linux x64 and arm64, as in the ADR 0074 amendment). Every tool, analyzer, writer and core service is in it, and so are the MCP transport (stdio and Streamable HTTP), remote access and schema validation. A modder installs that binary and needs no Node. The read-only `hoi4-engine check` command stays the one command-line tool of the engine. The server binary is the MCP surface and is not a gameplay-tool CLI.

**The npm package may stay, as a download channel only.** Users who install with `npm install -g hoi4-agent-tools` or `npx` may keep that path: the package carries or fetches the binary for the platform and starts it, checked against its SHA-256 as the engine bundle is today. Nothing of the server runs on Node in 5.0.0. A launcher that only finds, checks and starts the binary is allowed. Nothing else is.

**The remote rules are ported, not weakened.** Authentication, Origin and Host validation, principal-to-workspace grants, request and size limits and session isolation move with the transport. Their negative tests move with them and must fail against a server that drops a rule. Remote access never broadens a configured root or grant, as before. The same holds for every security rule of the core: traversal, symlink escape, cross-workspace access, stale source or provenance, and access outside configured roots are refused by the Rust code, with the negative tests ported.

**How each piece moves.** One piece at a time, behind the same tool names and wire shapes, as ADRs 0080 to 0085 did:

1. The piece is written in the engine, as a library module and, while TypeScript still calls it, as an operation of the resident engine (`hoi4-engine serve`, ADR 0077) or a one-shot command.
2. The TypeScript code calls the engine for it and keeps no fallback. A missing engine is `ENGINE_UNAVAILABLE`.
3. The piece's existing tests pass unchanged against the engine. Unit tests of the TypeScript module it replaces are ported to Rust tests in the same change, so the rule each one checks keeps a test.
4. A parity check compares the old and the new answer on the installed game and on the benchmark mods (`bench/corpus.json`) before the TypeScript path is removed, as `scripts/mod-index-parity.ts` and its siblings do. A difference is fixed or documented, never hidden.

A piece that cannot be represented safely is refused, as the project instructions require. A known defect is fixed in the port, not copied: the map issues 172, 182 and 260 are examples.

**The order.** It follows an estimate of the remaining work made from main b439018e:

1. Settle the end state. This ADR does that.
2. The core services: workspace resolution and canonical-path checks first, then the atomic rewrite engine and its journal, artifacts, jobs and diffs. These carry the security rules and are the largest single risk.
3. The analyzers, each behind its tests: technology and doctrines, events and the event graph (issue 69), decisions, probability, impact, mechanic and scenario tests, `mod_health`, `error_log` and `script_guard`.
4. The writers: `idea_write`, `character_write`, `event_write`, `decision_write`, `tech_write`, `doctrine_write` and `localisation_write`, then `focus_rewrite` (with its layout issues 243, 253 and 254).
5. GUI: the layout model and the renderer (issues 233 to 239, 245 to 250 and 255 to 257), then `gui_rewrite`.
6. The map, the largest module (issues 172, 182 and 260).
7. Reference search ranking and the remaining `reference_*` tools.
8. The MCP transport, remote access and schema validation, with their negative tests. The Rust program becomes the server, and the TypeScript server is reduced to the launcher described above.
9. Remove the TypeScript paths and the parity scripts. Run the full benchmark and the in-game checks the changelog has collected (run in the game by the maintainer), fix what they find, then release 5.0.0.

Steps 3 to 7 may run in parallel where they share no files. Step 2 comes first, because every later piece calls the core. Step 8 comes last, because until then the TypeScript transport is what calls the moved pieces.

**Tests after the transport moves.** The MCP-level tests drive the server over stdio and HTTP as an external client. They keep running against the Rust binary. A test client written in TypeScript is a development tool, not part of the server, so running it under Node in CI does not break the rule above. The release check runs them against the packaged binary.

**Releases.** The 4.x releases ship each moved piece as it lands, with its tests and parity numbers in the changelog. 5.0.0 ships only when no TypeScript of the server runs and the parity scripts are gone. If porting the transport shows a concrete risk, the maintainer decides before any other path is taken (D-102).

## Consequences

- The project instructions change with the code. "Use strict TypeScript and explicit public types" becomes the Rust rules of `engine/` (format, clippy with warnings denied, tests) for the server. The engineering boundaries keep their meaning: `core` becomes the engine's core modules. This is edited in the step-9 change, not before.
- The package version, server version, schemas, `server.json` and the changelog stay synchronized. The tool schemas are generated from the Rust types in step 8, and a public schema change still needs a compatibility review and a semantic version.
- The container image builds the one binary from source and no longer needs Node for the server.
- The estimate puts steps 2 to 7 at 20 to 30 weekly releases at the pace of the last three weeks, and step 8 at a few weeks more. That is a rough figure from code size and release pace, not a plan.
- HOI4 Factory links the engine as a library today (ADR 0074). After step 8 it can link the server's crates too, and its profile pins one binary instead of a package and an engine.

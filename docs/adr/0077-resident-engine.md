# ADR 0077: A resident engine process

Status: accepted

## Context

ADR 0074 runs the shared Rust engine as one process per call (`hoi4-engine focus-layout`). That is fine for a layout, but an in-app game preview (HOI4 Factory D-16) and the texture formats the TypeScript decoders lack (issue #76) call the engine many times per tool call and need what it loaded to stay loaded: parsed `.gfx` files, folder listings, decoded textures and fonts. Starting a process, reading the game's interface files and decoding the same textures again on every call is the kind of cost that made a focus render take 20 to 155 seconds (issue #74).

## Decision

The MCP server keeps one engine process for its whole life: `hoi4-engine serve`, started on first use (`src/hoi4_agent_tools/core/resident-engine.ts`). Requests and responses are frames on stdin and stdout: one JSON line, then the raw bytes its `payload` field counts, so pixels and PNGs travel without base64. Requests carry an id and run in parallel inside the engine; each response is written whole and matched by id. A malformed frame stops the engine with exit code 2.

The process is never evicted for being idle. It is unreferenced while no request waits, so it never keeps the server alive. A crash fails the requests in flight with `exit_status`, and the next request starts a fresh process; after three crashes in a row the engine is reported unavailable. Each request has a timeout (120 seconds by default) and honours cancellation.

Operations: `hello` (version and protocol), `texture.decode` (texture bytes in, RGBA pixels out). Later operations add renders on the same channel. The binary is found as for ADR 0074 (`HOI4_ENGINE`, then the packaged binary); without it the callers say what is missing and how to get it, and nothing falls back to guessed output.

## Consequences

- TypeScript keeps workspace resolution, path checks, budgets and artifacts. The engine only reads bytes the server hands it, or files under layer roots the server resolved.
- A cache can live as long as the server. Each cache entry must be keyed by what it was built from (path, size, modification time), so an edit is never served stale.
- One more child process per server. It is small when idle and shares nothing between servers.

# ADR 0091: Contracts for porting to Rust in parallel

Status: accepted (maintainer priority under D-125 and D-131, 2026-11-22; the packet plan was approved by the coordinator)

## Context

ADR 0089 moves the whole server to Rust, piece by piece, and allows steps 3 to 7 to run in parallel where they share no files. The maintainer asked to speed the rewrite up with many sessions at once. Until now every new engine piece edited the same few files:

- the workspace `engine/Cargo.toml`;
- the module list of `crates/engine/src/lib.rs`;
- the op match in `crates/cli/src/serve.rs`;
- `engine/PROVENANCE.md`;
- the engine client in TypeScript.

Branches that run in parallel would conflict on every one of them, and two of them carry the protocol every piece depends on.

## Decision

**One crate per packet, all made up front.** The workspace lists these crates from the start:

- `hoi4-core`;
- `hoi4-txn` (the atomic rewrite engine and journal);
- `hoi4-artifacts` (artifacts, diffs and managed outputs);
- `hoi4-jobs`;
- `hoi4-tech`, `hoi4-event`, `hoi4-decision`, `hoi4-probability`, `hoi4-impact` and `hoi4-health` (the analyzers);
- `hoi4-script-write` and `hoi4-focus-write` (the writers);
- `hoi4-gui`;
- `hoi4-map`;
- `hoi4-reference`;
- `hoi4-server` (the MCP transport).

Each crate also gets its `[workspace.dependencies]` alias and a dependency of the command-line crate. A packet edits only its own crate and its own TypeScript files, so no branch edits the workspace manifest.

**An operation registry.** `hoi4-core::ops` defines `Operation`, `OpResponse`, `OpContext` and `Registry`. Every crate has `pub fn register(registry: &mut Registry)`. `hoi4-engine serve` calls every crate's `register` once and dispatches every op it does not answer itself through the registry. It refuses to start when a name is registered twice or shadows a built-in op, and `hello` lists the registered ops. A packet adds an operation by filling its own `register`.

**The core contract.** Every packet builds against these types:

- `hoi4-core::diagnostics`: `Diagnostic`, `Severity`, `Category` and `SourceLocation`. They have the TypeScript wire shape and sort order.
- `hoi4-core::canonical`: canonical JSON and SHA-256. Its bytes equal the TypeScript ones: JavaScript key order, UTF-16 code-unit order, and `JSON.stringify` numbers.
- `hoi4-core::files`: `ScannedFile` and `RootKind`.
- `hoi4-core::plan`: `RewritePlan`, `FileChange`, `Applied`, `Refusal` and the `PlanApplier` trait.

**Writers never write.** A writer returns a `RewritePlan`: each changed path, the SHA-256 of the source it read, and the new bytes or a removal. One `PlanApplier` writes a plan whole or refuses it. `hoi4-txn` implements it with the stale-source checks, journal and recovery of the TypeScript transaction engine. Until then, writer tests use the in-memory `hoi4-core::testing::MemoryApplier`, which refuses an unsafe path, a duplicate change, a stale source and a plan with blocking diagnostics, and changes nothing when it refuses. Agents still see one call that writes or refuses. No transaction id, plan hash, apply step or rollback is exposed.

**The TypeScript side.** `callEngineOperation` in `core/engine-operation.ts` calls any registered op and checks its answer against the caller's schema. A piece that moves calls its op through it and adds no method to the engine client. A missing engine, an engine without the op, or an answer out of shape is `ENGINE_UNAVAILABLE`, as ADR 0089 requires. An operation's own upper-case refusal code, such as `TRANSACTION_STALE`, reaches the tool unchanged.

**Provenance per crate.** Each new crate keeps its own `PROVENANCE.md`, and the workspace `PROVENANCE.md` points to them.

**Contract changes go through the integrator.** A packet that needs a new core type, a new `OpContext` field, a schema change or a new diagnostic category asks the integrator, who lands the change on main for every packet. The schemas under `src/hoi4_agent_tools/schemas/` belong to the transport packet. A public schema change still needs a compatibility review and a semantic version.

**Builds.** This PC bears at most two Rust builds at once, or three when no Blender job runs. Each build takes a pool slot of `heavy-slot.sh` and runs with `CARGO_BUILD_JOBS=4`. Each packet builds into its own `CARGO_TARGET_DIR`, because a shared one serializes on Cargo's lock and lets branches replace each other's binaries. Each packet deletes its target dir after its pull request merges. Dependency builds are shared through `sccache`, which each packet sets in its own environment (`RUSTC_WRAPPER=sccache`, `SCCACHE_CACHE_SIZE=10G`), never in a global Cargo configuration (D-131).

## Consequences

- Packets can start the day this lands, and their branches conflict only where two packets break the ownership rule.
- Analyzers and writers can be ported and tested before the atomic rewrite engine lands. A writer is wired to real writes once `hoi4-txn` merges, without changing the writer.
- The ownership of every path is in the packet plan the integrator keeps. A file not listed there belongs to the integrator.
- The step-8 transport packet finally replaces the TypeScript server. Until then, the TypeScript transport calls the moved pieces through `callEngineOperation`.

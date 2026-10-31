# ADR 0074: The shared Rust HOI4 engine

## Context

HOI4 knowledge lived in three places that drift apart: this server's TypeScript core, the Agentic HOI4 Modding Kit's Python checks and Chaos Redux's own tools. None of them had a whole-mod reference closure, so Chaos Redux's live QA run B001 found unknown scripted triggers and an undefined effect only by launching the game. The kit's `check.py` also needs these checks without starting the MCP server.

The maintainer decided (HOI4 Factory expansion plan, decisions D-07 and C1, 2026-10-31) to build one shared engine in Rust, as a Cargo workspace in this repository under Apache-2.0. HOI4 Factory links it as a library, the kit and Chaos Redux call its command-line interface, and the MCP tools move onto it one at a time behind the same names until the TypeScript index is retired. Proposals P1 to P4 of the same plan define its first checks: reference closure, lints with vocabulary generated from the game's documentation, an override and load-order audit, and a findings baseline.

## Decision

**A workspace beside the TypeScript code.** `engine/` holds four crates: `hoi4-syntax` (lossless parser and localisation reader), `hoi4-engine` (layers, index, closure, lints, override audit, baseline, delta, repair plans), `hoi4-drawio` (draw.io focus sketch importer) and `hoi4-engine-cli` (the `hoi4-engine` command). It has its own `rust-toolchain.toml`, five dependencies and its own CI workflow (`engine.yml`) on Ubuntu, Windows and macOS. The npm package does not include it yet.

**Lossless by construction.** The lexer assigns every byte to one token; the tree stores token ranges, and rebuilding from the tree reproduces the input. A check that every non-trivia token belongs to exactly one node runs in the tests and in `hoi4-engine roundtrip`. All 7,717 vanilla 1.19.3.0 files and every file of Chaos Redux, ZIN and Ireland Total Overhaul round-trip byte for byte (`docs/research/engine-w4-evidence.md`).

**Three states, never a silent pass.** Each reference is resolved, unresolved or unknown. Unknown covers names built at run time, folders without a context model and checks without the game folder. The report lists counts per kind, including kinds with none, and its verdict is `incomplete` whenever anything is unknown.

**Vocabulary from the user's game.** Effects, triggers and modifiers are read at run time from `documentation/*.md`, including the templated modifiers with their "Modified types" lists. Words the documentation omits (control flow, scope links, iterator arguments, modifier families built from definitions) are short lists in the source, each with the reason it is there; they were found by checking vanilla as if it were a mod until every remaining finding was classified. No game text is stored in the repository.

**Load order as the game applies it.** Base game, DLC folders by ID, dependencies, then the mod. A later file at the same path replaces an earlier one, and a `replace_path` unloads files directly in the named folder but not in its subfolders, as the offline wiki's Modding page states. The TypeScript scanner treats `replace_path` as covering subfolders; the two differ until the scanner moves onto the engine.

**A read-only check command.** `hoi4-engine check` prints text or a JSON report (`hoi4-engine-report/1`) and exits 0, 1 for new findings at or above `--fail-on`, or 2 for usage errors. Baselines (`hoi4-engine-baseline/1`) store finding fingerprints, which do not include line numbers; `baseline update` only removes entries. Repair plans are data with the source hash and the exact replaced text; the command never writes to a mod. This is a static check tool for the kit and Chaos Redux, not the gameplay-tool CLI that the project instructions rule out; the MCP server stays the surface for agents.

**Harvested Hagane modules with provenance.** The span repair plan, the finding delta, the dead-flag and DLC rules and the draw.io importer are adapted from Hagane Studio under the written permission recorded as HOI4 Factory decision D-05. `engine/PROVENANCE.md` lists each file, its source path and commit, and what changed.

**CWTools MD Edition is not integrated.** The bounded spike (decision C2, `docs/research/cwtools-md-edition-spike.md`) found that it misses unknown triggers, has no override audit and reported about 15 false positives in a sample of 40 on the maintainer's mods. The engine keeps its own closure. The spike can be repeated later for argument type checks as an opt-in subprocess.

## Route moves

No MCP tool calls the engine yet. A route moves only when its existing tests pass unchanged against the engine, which needs a binary in the npm package for every supported platform. The plan:

1. The release workflow builds `hoi4-engine` for Windows x64, macOS arm64 and Linux x64 and arm64, and publishes each as an optional npm package with a checksum, as packages with native binaries do. Docker images build it from source.
2. `core` gets an engine client that runs the binary with a JSON request and validates the response with a schema, and that reports the engine as unavailable instead of falling back silently.
3. Routes move one at a time, starting with `hoi4.mod_index` (definition counts and `next_id`), then the new whole-mod closure as an option of `hoi4.script_validate`. The focus tools stay in TypeScript until the focus layout work (W3, W7) settles.

## Consequences

The kit and Chaos Redux can call `hoi4-engine check` with a baseline today. HOI4 Factory can link `hoi4-engine` as a library. Contributors need a Rust toolchain only to work on `engine/`; the npm build and tests are unchanged.

Limits: scopes and argument types are not checked; folders without a context model (technologies, AI strategies, history, GUI scripts and others) are counted as unchecked; sprites inside zipped DLC archives are not read.

Tests: the parser's unit tests, a valid and an invalid fixture for every rule, the B001 classes, a copied `00_on_actions.txt` that drops hooks, coverage including zero counts, the baseline flow, the delta, the draw.io parity fixtures and command-line exit codes (`cargo test` in `engine/`).

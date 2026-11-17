# Benchmark

One harness measures every tool surface against hand-checked answers (decisions Q-1, M-6, M-12). It drives the real stdio server the way a coding agent does, so it measures what agents see: the inline answer, its size, its status and how long it took.

## What it measures

Each case in `cases/` is one tool call on one corpus, with the answer a correct tool gives and the evidence for that answer. A case states the truth, not the current behaviour, so a case can fail until the fix it describes lands. Each case reports:

- **correct:** every assertion holds
- **inline:** it holds without reading an artifact, so an agent without artifact access gets the answer
- **latency:** wall-clock time; `cold` cases run first after the server starts, `warm` cases are repeated and judged on their p95
- **size:** the structured result in bytes

A **sweep** runs one call per file over a sample of known-good files and counts the false positives, such as validation errors on vanilla script that the game loads. A file with a real error that the game also reports is excluded, with the reason in the case's `evidence`.

The report groups the cases by surface: lookup, source lookup, index, validation, error log, events, decisions, technology, focus, GUI, map, probability, compatibility, impact, renders and rewrites.

## Corpora

`corpus.json` lists them:

- **synthetic:** the project's own fixtures plus the hand-written regression mod in `fixtures/synthetic`. It ships with the repository and runs in CI.
- **vanilla:** the installed game, through an empty mod.
- **chaos_redux, zin, ito:** the maintainer's mods, under the game's `mod` folder.
- **kaiserreich, owb:** Kaiserreich 1.7 and Old World Blues 5.1.12 from the Steam Workshop.

The real corpora are read where they are installed and never copied. Only identifiers and expected answers are recorded here, never their files. Every run pins what it measured: the game build, the Git commit of a mod repository, the Workshop manifest of a Workshop item and a SHA-256 over every script, interface and localisation file.

## Running it

```sh
npm run bench                                   # synthetic suite against bench/baselines/synthetic.json
npm run bench -- --suite real                   # installed game and mods
npm run bench -- --suite real --corpus chaos_redux --case event.
npm run bench -- --dump                         # also save each call's result under the output folder
npm run bench -- --update-baseline              # accept this run as the baseline
```

The game, mod and Workshop folders are found in the default Steam libraries and the game's user folder. `HOI4_GAME_ROOT`, `HOI4_MOD_ROOT`, `HOI4_USER_ROOT` and `HOI4_STEAM_ROOT` override them. A corpus that is not installed is reported as unavailable, not as a failure.

Each run names the machine it ran on (CPU, cores, memory, Node) and the SHA-256 of the `hoi4-engine` binary `HOI4_ENGINE` names. The local baseline keeps the machine with its latency, and the report says when a run is compared with a baseline from other hardware.

The synthetic suite writes to `.tmp/bench/`. The real suite keeps its results, reports and baseline on this machine only, in `HOI4_BENCH_DIR` or else `%LOCALAPPDATA%\hoi4-agent-tools\bench` (Windows), `~/Library/Application Support/hoi4-agent-tools/bench` (macOS) or `~/.local/share/hoi4-agent-tools/bench` (Linux). Each run writes `runs/<time>/results.json` and `report.md` there, `latest-report.md` holds the last report, and every accepted real baseline is also kept as `baseline-history/<time>.json`.

The one-time head-to-head with cpntodd/HOI4-MCP (decision M-7) has its own driver in `scripts/bench/hoi4-mcp/` and its result in [docs/research/hoi4-mcp-head-to-head-2026-11-01.md](../docs/research/hoi4-mcp-head-to-head-2026-11-01.md). That result predates the accuracy fixes.

## Gates

- **CI:** `tests/integration/bench-synthetic.test.ts` runs the synthetic suite on Linux, Windows and macOS. It fails when a case that passed in `baselines/synthetic.json` fails, an inline answer moves into an artifact, or a sweep finds more false positives. It also fails when a case newly passes but the baseline was not updated, so a fix cannot silently regress later. Latency is not gated in CI, because CI machines vary.
- **On demand:** the real suite runs by hand, not on a schedule (maintainer decision D-79): before every release and on pull requests that touch speed, in a quiet slot on the benchmark worktree. `scripts/bench/nightly.sh` moves that worktree to `origin/main`, runs the suite and accepts the run as the new baseline only when nothing regressed. It also flags a warm p95 above 1.5 times the baseline and at least 50 ms slower. When a corpus changed since the baseline, for example after a Workshop update, a game patch or new mod commits, cases that moved on it are listed for a look instead of failing the run. While it runs it logs the machine's CPU, free memory and busiest processes every two minutes (Windows), so a slow run shows what else was busy.
- **Cold disks:** a case timed after other work pushed the corpus out of memory measures the disk, not the tool. Before timing, the real suite therefore reads once every file the content hash covers, then `map/`, `gfx/flags/` and `gfx/interface/`, up to 2 GB per corpus. It skips the rest of `gfx`, `sound` and `dlc`, which come to several gigabytes for vanilla alone. `--no-warm-up` skips this pass. The report header gives the free memory at the start and what the warm-up read. A `cold` case times the first call after the server starts: after the warm-up, that is the cost of a user's first call on cached files. Process start makes it noisier, so it counts as slower only above twice the baseline and at least 500 ms more; a smaller slowdown is listed under cold starts without failing the run. A case still slower than its baseline is rerun once on a fresh server, and it counts as slower only when the rerun is slow too. A case slow on the first pass alone is listed with both numbers, and the baseline keeps the faster pass. `--no-rerun` skips the rerun.

Run it from a quiet machine, never as a scheduled task: on 2026-11-16 and 2026-11-17 the Task Scheduler runs (03:17, task priority 7) were 3 to 30 times slower on the same cases than the same command run by hand on the same machine, even with nothing else busy, so their regressions were not real. Set up the worktree once and run it:

```sh
git worktree add --detach ../hoi4-agent-tools-wt-bench origin/main
../hoi4-agent-tools-wt-bench/scripts/bench/nightly.sh >> "$LOCALAPPDATA/hoi4-agent-tools/bench/nightly.log" 2>&1
```

The benchmark worktree builds its own `hoi4-engine` in its `engine/target` unless `CARGO_TARGET_DIR` is set, so it never replaces a build another worktree is testing. Remove it with `git worktree remove ../hoi4-agent-tools-wt-bench`; the benchmark data folder stays until you delete it.

## Writing a case

Add it to the case file of its corpus. A case needs an `id`, a `surface`, a `title` that states the correct answer, `evidence` that says how the answer was checked (a file and line, the game documentation, or the game's `error.log`), the `tool` and `arguments`, and at least one assertion in `expect`. A case from the 2026-11-01 live test names its `problem` number from the improvement plan.

An assertion has a `path` and one operator: `equals`, `notEquals`, `includes`, `excludes`, `atLeast`, `atMost`, `exists` or `matches`. A path reads the structured result with dots, `[n]`, `[*]` for every array item and `**` for any depth. `$text`, `$bytes`, `$isError` and `$ms` read the text content, the structured size, the tool-error flag and the time. An assertion with `artifact` reads the named artifact instead, and the case then no longer counts as answered inline.

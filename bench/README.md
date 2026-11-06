# Benchmark

One harness measures every tool surface against hand-checked answers (decisions Q-1, M-6, M-12). It drives the real stdio server the way a coding agent does, so it measures what agents see: the inline answer, its size, its status and how long it took.

## What it measures

Each case in `cases/` is one tool call on one corpus, with the answer a correct tool gives and the evidence for that answer. A case states the truth, not the current behaviour, so a case can fail until the fix it describes lands. Each case reports:

- **correct:** every assertion holds
- **inline:** it holds without reading an artifact, so an agent without artifact access gets the answer
- **latency:** wall-clock time; `cold` cases run first after the server starts, `warm` cases are repeated and judged on their p95
- **size:** the structured result in bytes

A **sweep** runs one call per file over a sample of known-good files and counts the false positives, such as validation errors on vanilla script that the game loads. A file with a real error that the game also reports is excluded, with the reason in the case's `evidence`.

The report groups the cases by surface: lookup, source lookup, index, validation, error log, events, decisions, technology, focus, GUI, map, probability, impact, renders and rewrites.

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
- **Nightly:** `scripts/bench/nightly.sh` runs the real suite on a dedicated worktree at `origin/main`. It accepts the run as the new baseline only when nothing regressed. It also flags a warm p95 above 1.5 times the baseline and at least 50 ms slower. When a corpus changed since the baseline, for example after a Workshop update, a game patch or new mod commits, cases that moved on it are listed for a look instead of failing the run.

Register the nightly run once per machine. It starts at 03:17, off the hour when other scheduled jobs start. The benchmark worktree builds its own `hoi4-engine` in its `engine/target` unless `CARGO_TARGET_DIR` is set, so it never replaces a build another worktree is testing. On Windows (Task Scheduler), from Git Bash:

```sh
git worktree add --detach ../hoi4-agent-tools-wt-bench origin/main
MSYS_NO_PATHCONV=1 schtasks /Create /TN "hoi4-agent-tools nightly benchmark" /SC DAILY /ST 03:17 /TR "\"C:\Program Files\Git\bin\sh.exe\" -lc 'C:/Users/<you>/Documents/Projects/hoi4-agent-tools-wt-bench/scripts/bench/nightly.sh >> C:/Users/<you>/AppData/Local/hoi4-agent-tools/bench/nightly.log 2>&1'"
```

Check it with `schtasks /Query /TN "hoi4-agent-tools nightly benchmark" /V /FO LIST`, start it once by hand with `schtasks /Run /TN "hoi4-agent-tools nightly benchmark"`, and remove it with:

```sh
MSYS_NO_PATHCONV=1 schtasks /Delete /TN "hoi4-agent-tools nightly benchmark" /F
git worktree remove ../hoi4-agent-tools-wt-bench
```

The benchmark data folder stays until you delete it.

On macOS, add a `launchd` agent in `~/Library/LaunchAgents` whose `ProgramArguments` are `/bin/sh` and the path to `nightly.sh`, with `StartCalendarInterval` set to hour 3 and minute 17. Remove it with `launchctl bootout gui/$(id -u) <plist>` and by deleting the plist.

## Writing a case

Add it to the case file of its corpus. A case needs an `id`, a `surface`, a `title` that states the correct answer, `evidence` that says how the answer was checked (a file and line, the game documentation, or the game's `error.log`), the `tool` and `arguments`, and at least one assertion in `expect`. A case from the 2026-11-01 live test names its `problem` number from the improvement plan.

An assertion has a `path` and one operator: `equals`, `notEquals`, `includes`, `excludes`, `atLeast`, `atMost`, `exists` or `matches`. A path reads the structured result with dots, `[n]`, `[*]` for every array item and `**` for any depth. `$text`, `$bytes`, `$isError` and `$ms` read the text content, the structured size, the tool-error flag and the time. An assertion with `artifact` reads the named artifact instead, and the case then no longer counts as answered inline.

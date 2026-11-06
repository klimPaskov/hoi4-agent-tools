# Head-to-head with cpntodd/HOI4-MCP (2026-11-01)

A one-time comparison against [cpntodd/HOI4-MCP](https://github.com/cpntodd/HOI4-MCP), run under decision M-7 of the HOI4 Factory expansion plan.

**Read this with two caveats.**

- **It predates the accuracy fixes.** It measured hoi4-agent-tools at commit `08e085e`, a branch from before the accuracy work of 4.8.0 and 4.9.0 (selectors and not-found answers #59, event-target guards #60, misleading results #65, identifier arguments #68, game build pins #70). The numbers describe that commit, not a current release. The fresh real-game baseline (`bench/README.md`) is the current measure.
- **One seeded control was wrong ground truth.** The run seeded `owner = ROOT` as a known-good control, and hoi4-agent-tools flagged it, which was counted as a false error. `owner` is not a trigger: the game drops it at load ("Unknown trigger-type: owner"), and the condition then always passes. Flagging it was correct, so the false-error row below overstates our false errors by one, and HOI4-MCP missed a real error there.

## Setup

- Windows, Hearts of Iron IV 1.19.4.1, Chaos Redux from the game's user folder.
- Both servers ran in one Docker container with no network, the game and user folders mounted read-only, 4 CPUs and 8 GB of memory.
- HOI4-MCP pinned at `e7101f6bee5b6536c965e05935659af4a7220cc5`. It was cloned as data only and never ran on the host.
- hoi4-agent-tools at `08e085e`.
- Driver, tasks and image: `scripts/bench/hoi4-mcp/` (`run.sh <game folder> <game user folder> <work folder>` writes `<work folder>/out/results.json`).

The raw `results.json` of this run was kept only in a temporary worktree that has since been removed. The table below is the record. Rerun `run.sh` with the same pins to reproduce it.

## Results

| Task                                | hoi4-agent-tools                                               | HOI4-MCP                                                          |
| ----------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Cold Chaos Redux index              | 50.3 s                                                         | 61.5 s, plus an 86.7 s one-time vanilla index                     |
| Warm index, median                  | 9.1 s                                                          | 10 ms                                                             |
| Next free event ID, 5 namespaces    | 5 of 5 correct                                                 | 0 of 5 (no answer)                                                |
| Vanilla lookups, 4 IDs              | 4 of 4 correct, 8 to 49 s each                                 | 2 of 4 (missed `political.1` and `GER_mefo_bills_1`), 12 to 74 ms |
| Effect and trigger docs, 4 commands | 4 of 4                                                         | no such tool                                                      |
| Known-good vanilla, 90 files        | 4 files flagged, 9 errors                                      | 0 flagged                                                         |
| Known-good Chaos Redux, 50 files    | 0 flagged                                                      | 0 flagged                                                         |
| Seeded errors caught, 9             | 5 of 9                                                         | 0 of 9                                                            |
| False errors on 3 seeded controls   | 1 (`owner = ROOT`, a real error, see above)                    | 0                                                                 |
| Error log                           | 45 mod entries, but the text answer said only `ERROR_LOG_READ` | 63 entries, no file attribution                                   |

## What it showed

- hoi4-agent-tools gave correct answers where HOI4-MCP gave none or wrong ones: next free IDs, two vanilla lookups, seeded errors and command documentation.
- HOI4-MCP's validator flagged nothing at all, so its zero false errors came with zero catches.
- hoi4-agent-tools was slow: the warm index was about 900 times slower and lookups took seconds. This is issue #69 and the engine route work (M-8).
- hoi4-agent-tools reported 9 errors on known-good vanilla files. With `owner = ROOT` counted correctly, none of the seeded controls was a false error.
- hoi4-agent-tools missed misspelled effects, unknown triggers, invented effects and an invented `hide_window` field.
- The error-log text answer hid the entries in artifacts. #65 fixed this in 4.9.0.

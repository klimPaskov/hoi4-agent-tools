# Real-game benchmark baseline (2026-11-06)

The Q-1 baseline of the real suite (`bench/README.md`), recorded after the accuracy fixes #102 (#70), #103 (#60) and #106 (#66) merged. It replaces the baseline of 2026-11-02, which passed 33 of 54 cases.

The baseline itself stays on the machine that ran it (`baseline.json` and `baseline-history/` in the benchmark data folder). This page records what it holds, so the numbers can be cited.

## Pins

| What             | Value                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| hoi4-agent-tools | `291395014d0e`, main after #118                                                                        |
| hoi4-engine      | built from the same commit, SHA-256 `ead2d6c766ad9028231f2983d5b197a525ebc0769938e0dd097049133cf5a7c0` |
| Machine          | Windows 11, AMD Ryzen 5 7500F (6 cores, 12 threads), 32 GB, Node 24.15.0                               |
| Game             | Hearts of Iron IV 1.19.4.2 (`0bdb`), content hash `952f1df0300ad90e`                                   |
| Command          | `HOI4_ENGINE=<engine> npm run bench -- --suite real --watch-game --update-baseline`                    |
| Duration         | 10,169 s                                                                                               |

| Corpus                     | Version  | Pin                                               | Content hash       | Files |
| -------------------------- | -------- | ------------------------------------------------- | ------------------ | ----- |
| vanilla                    | 1.19.4.2 | installed game                                    | `952f1df0300ad90e` | 7,984 |
| Chaos Redux                | 0.1      | Git `074e5b39e525` with 18 uncommitted changes    | `5c59eb623679d055` | 3,682 |
| ZIN                        | 0.1.0    | Git `40ac4ca2ffc9` with 1,765 uncommitted changes | `2560e3d9f0fc7f34` | 5,392 |
| Ireland Total Overhaul     | 0.1      | Git `cb93e71a9844` with 377 uncommitted changes   | `66e491b8d165f45a` | 87    |
| Atlantis: The Seventh Ring | 1.0.0    | Git `0b4c5b9ca9ab` with 2 uncommitted changes     | `eac7ed795e2e7c33` | 93    |
| Kaiserreich                | 1.7      | Workshop manifest `5627406412597448048`           | `de26222ae2a3bb11` | 6,443 |
| Old World Blues            | 5.1.12c  | Workshop manifest `654354088233066370`            | `e22291670045b3a2` | 8,303 |

The mods are working copies, so the content hash, not the commit, identifies what was read.

## Results

93 of 100 cases passed, 6 failed and 1 errored. Validation found no false positives in 1,029 known-good files across all seven corpora.

| Surface       | Correct | Answered inline |
| ------------- | ------- | --------------- |
| lookup        | 3/3     | 3/3             |
| source_lookup | 5/5     | 5/5             |
| mod_index     | 4/5     | 4/5             |
| validation    | 31/32   | 31/32           |
| error_log     | 1/1     | 1/1             |
| event         | 7/8     | 6/8             |
| decision      | 3/3     | 3/3             |
| technology    | 0/1     | 0/1             |
| gui           | 1/1     | 1/1             |
| map           | 1/2     | 1/2             |
| probability   | 1/2     | 1/2             |
| localisation  | 5/6     | 5/6             |
| idea          | 5/5     | 5/5             |
| system        | 9/9     | 9/9             |
| unit          | 9/9     | 9/9             |
| asset         | 7/7     | 7/7             |
| impact        | 1/1     | 1/1             |

Against the 2026-11-02 baseline, 16 cases now pass that failed before, false positives fell to 0 on every sweep (vanilla events from 60, Old World Blues events from 28, Kaiserreich events from 9), and 46 cases are new.

### Cases that do not pass

| Case                                           | Outcome | Why                                                                                                                                                                                                        |
| ---------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vanilla.validation.timed-idea-wrong-id`       | failed  | The findings hold `unresolved`, `warning` and `supported` but no `error` for the wrong idea id.                                                                                                            |
| `vanilla.probability.verified-build`           | failed  | The call returned `INVALID_ARGUMENTS`, and the installed game moved to 1.19.4.2 while the probability adapters are pinned to 1.19.4.1 (#70). The game-update watcher found no changed documentation files. |
| `vanilla.technology.explain`                   | failed  | The result does not name `infantry_weapons1`.                                                                                                                                                              |
| `vanilla.map.state-lookup`                     | failed  | The result does not contain state 64.                                                                                                                                                                      |
| `owb.mod_index.cold-overview`                  | failed  | `data.complete` is false.                                                                                                                                                                                  |
| `zin.localisation.audit-undefined-desc`        | failed  | The audit counts no `LOC_KEY_UNDEFINED`. ZIN has 1,765 uncommitted changes since its pinned commit, so the case's ground truth needs a look as well as the tool.                                           |
| `chaos_redux.event.state-flow-unknown-subject` | error   | The call timed out.                                                                                                                                                                                        |

## Latency is not representative

This run measured latency while other sessions built Rust, ran test suites and rendered on the same machine, and it took 2.8 hours. Every latency target was missed, and many cases were several times slower than on 2026-11-02 (for example the Chaos Redux cold `mod_index`, 14 s then and 50 s now). The latency recorded in this baseline is an upper bound, not a measurement. The nightly run at 03:17, on an idle machine, accepts a run only when nothing regressed, so faster numbers from it replace these.

## What cannot run

- **CI.** No CI runner has a licensed copy of the game, so the real suite runs only on the maintainer's machines. CI runs the synthetic suite.
- **The New Order** is not installed on this machine and is not a corpus.
- **Rewrites, focus layouts and renders** have no real-suite cases yet. The synthetic suite covers them.
- **macOS.** The baseline is from Windows. The nightly `launchd` entry for the Mac is described in `bench/README.md` and is registered after the move.

## Nightly run

The nightly run is registered on this machine as the Windows scheduled task "hoi4-agent-tools nightly benchmark", daily at 03:17. It runs `scripts/bench/nightly.sh` in the dedicated worktree `hoi4-agent-tools-wt-bench` and appends its output to `nightly.log` in the benchmark data folder. `bench/README.md` says how to check, start and remove it.

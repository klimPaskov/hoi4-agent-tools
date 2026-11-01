# CWTools MD Edition spike (decision C2)

Date: 2026-10-31. HOI4 Factory decision C2 delegated the question "should the shared engine
integrate CWTools MD Edition as its rules-validation layer?" with the test: integrate only if it
measurably improves true findings, with acceptable false positives on vanilla and acceptable
startup time and memory on amd64 and arm64. Otherwise the engine keeps its own closure and lints.

**Verdict: do not integrate now.** The engine keeps its own reference closure and lints. Revisit
at a later pin as an optional, opt-in subprocess for argument type checks only, if its false
positive rate on the maintainer's mods falls. CWTools is never the write path.

## What was run

| Item    | Value                                                                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine  | [MillenniumDawn/cwtools-vscode](https://github.com/MillenniumDawn/cwtools-vscode) at `937a06ef905ea400d9a970a97c73959020db92bc` (engine crate 3.4.0, nearest tag `v4.0.6`, tags up to `v4.1.299-pre.1`), MIT                                                           |
| Rules   | [cwtools/cwtools-hoi4-config](https://github.com/cwtools/cwtools-hoi4-config) at `297dd69c42aabe10078a8b7ab7f2d07ee631d4ef`, MIT                                                                                                                                       |
| Build   | `cargo build --release -p cwtools_cli` with Rust 1.97.1 on Windows 11 x64, 5,512,192-byte binary. It built only after setting `INCLUDE` and `LIB` by hand for `cc-rs` and shortening the path (a `subst` drive) because `zstd-sys` failed on paths over 260 characters |
| Command | `cwtools validate -g hoi4 -d <mod> -r <Config> --vanilla <game> --report-type json`                                                                                                                                                                                    |
| Inputs  | HOI4 1.19.3.0, Chaos Redux, ZIN and Ireland Total Overhaul (revisions in [the engine evidence](engine-w4-evidence.md)), the engine's B001 fixtures                                                                                                                     |

The source and the build stayed in the session's scratch folder and were deleted after
measuring. Nothing from CWTools is in this repository.

## True findings

| Case                                                                                      | hoi4-engine                                | CWTools MD Edition                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| B001 fixture: undefined effect `b001_undefined_effect`                                    | Reported (`REF_UNKNOWN_EFFECT`)            | Reported (`CW263 Unexpected field`)        |
| B001 fixture: unknown scripted trigger `b001_unknown_scripted_trigger`                    | Reported (`REF_UNKNOWN_TRIGGER`)           | **Not reported**                           |
| B001 valid twin                                                                           | Quiet                                      | Quiet                                      |
| ZIN `clear_country_flag`, `reverse_remove_opinion_modifier` (not game effects)            | Reported                                   | Reported                                   |
| ZIN `has_global_event_target` (not a game trigger)                                        | Reported                                   | **Not reported**                           |
| Copy of the real `00_on_actions.txt` that drops `on_new_term_election` and `on_daily_SWE` | 19 dropped hooks and 2 dropped definitions | None (6 style hints about unchanged lines) |
| Argument types (for example a wrong value type for an effect parameter)                   | Not checked                                | Checked by its rules                       |

Unknown triggers are the exact B001 class ("unknown scripted triggers") that motivated P1, and
CWTools missed both cases tested. It has no load-order or override audit.

## False positives

| Target                         | Diagnostics | Errors | Warnings | Information |
| ------------------------------ | ----------- | ------ | -------- | ----------- |
| Vanilla as the target, no base | 19,418      | 954    | 2,896    | 15,568      |
| Vanilla with itself as base    | 27,061      | 8,573  | 2,920    | 15,568      |
| Chaos Redux                    | 21,636      | 19,688 | 900      | 1,048       |
| ZIN                            | 2,603       | 1,667  | 201      | 735         |
| Ireland Total Overhaul         | 495         | 139    | 350      | 6           |

A sample of 40 diagnostics (one from each of the ten most common codes per target, read against
the cited lines) gave about 15 false positives, 6 true defects, 14 cosmetic hints and 5
uncertain. The largest Chaos Redux code, `CW113` (15,203 diagnostics), flagged a `.dds` file that
exists in the mod; `CW263` flagged a scripted effect that is defined in the mod; `CW262` flagged
`activation` and `remove_trigger`, which vanilla decisions use. On the same inputs the engine
reports 513 errors on vanilla with no finding shown false (see the evidence document).

## Startup and memory (Windows x64)

| Run                                           | Time                    | Peak working set  |
| --------------------------------------------- | ----------------------- | ----------------- |
| `--version`                                   | 0.02 s                  | not captured      |
| B001 fixture, vanilla indexed in the same run | 7.7 s                   | 884 MB            |
| B001 fixture, cached vanilla index            | 0.7 to 0.9 s            | 230 to 241 MB     |
| Chaos Redux, first run / cached               | 58.5 s / 11.4 to 17.9 s | 1,181 MB / 519 MB |
| ZIN, first run / cached                       | 22.3 s / 2.7 s          | 885 MB / 245 MB   |

The vanilla cache is keyed per mod root, so alternating mods re-indexes vanilla. hoi4-engine
takes 4 to 6 s and 515 to 790 MB per check with no cache.

Linux amd64 and macOS arm64 were not measured: there was no disk space for Docker images on the
Windows machine and no Mac in the session. The verdict does not depend on them, because the
true-finding test already fails.

## Why not integrate

1. It misses unknown triggers, the B001 class P1 exists to catch, and has no override audit, so
   it adds no true findings in the areas P1 to P3 cover.
2. Its false-positive rate on the maintainer's mods (about 15 in 40 sampled) would bury real
   findings unless most codes were suppressed.
3. The project publishes several pre-release tags an hour, and its Windows build needs manual
   environment fixes, which makes a pinned dependency expensive to keep current.

Its strength, typed checking of command arguments from `.cwt` rules, is something the engine does
not do. That is the reason to repeat the spike at a later pin, behind the engine's interface as
an opt-in subprocess for argument checks, never for references or writes.

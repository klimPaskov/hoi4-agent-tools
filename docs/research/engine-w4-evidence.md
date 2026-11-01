# Rust engine: measured evidence (W4)

Measured on 2026-10-31 on the maintainer's Windows 11 x64 machine with `hoi4-engine 0.1.0`
(release build, Rust 1.97.1, binary SHA-256
`b9cf67a55bcbae30199e9f441729fd974e2f9d27aad2ae8619b833f376405a5e`). Evidence kinds follow
HOI4 Factory's rules: everything here is source parsing and static checking, not game behaviour.
No game file or mod file was copied into this repository.

## Inputs

| Input                  | Revision                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hearts of Iron IV      | 1.19.3.0 (`launcher-settings.json`). Documentation SHA-256: effects `2cdc93d2…09af` (553 commands), triggers `7d27ed77…de29` (596), modifiers `00a0eca6…be7e` (4,484 names after template expansion) |
| Chaos Redux            | `c8782e065e534f70e3ff4a9d80b58d63ecb7c431`, working tree with 1,450 uncommitted paths                                                                                                                |
| ZIN                    | `15c47b9c99def1e3e25e6acf69e37145f57f09b3`, working tree with 78 uncommitted paths                                                                                                                   |
| Ireland Total Overhaul | `f916534112adb74785906d77052c8d6eb9e901e6`, working tree with 377 uncommitted paths                                                                                                                  |

The runs read the working trees as they were, so the content hashes below identify the input.

## Byte-identical round trip

`hoi4-engine roundtrip` parses every script and localisation file under the game's and each
mod's content folders, rebuilds the bytes from the tree, compares them with the input and checks
that every token belongs to exactly one node.

| Root                   | Files                                    | Bytes       | Byte-identical | Mismatched | Structure errors | Input SHA-256                                                      | Time  |
| ---------------------- | ---------------------------------------- | ----------- | -------------- | ---------- | ---------------- | ------------------------------------------------------------------ | ----- |
| Vanilla                | 7,717 (5,634 script, 2,083 localisation) | 268,554,554 | 7,717          | 0          | 0                | `a12869ab001416451ebef9c024368d6c464cbd22662fdee819fc8d718d6fee5b` | 0.6 s |
| Chaos Redux            | 3,486 (3,094, 392)                       | 122,383,053 | 3,486          | 0          | 0                | `136da3420342218bfc3f522533f676ddbbb3e39da11b9dd4b001a07c5521004f` | 3.9 s |
| ZIN                    | 4,314 (4,051, 263)                       | 24,561,288  | 4,314          | 0          | 0                | `17200bbf60e47a0eb76ad8c784b3783b1083a0212a10edb7ad20735a32efcc69` | 4.2 s |
| Ireland Total Overhaul | 87 (84, 3)                               | 9,867,833   | 87             | 0          | 0                | `74ba1cbc4f4c430df3df9f5ee74792731d75b8b6c9635aa1ef7ba3941c8307e0` | 0.2 s |

Vanilla has 35 files with syntax diagnostics. They still round-trip. The 35 unclosed blocks are
real: an independent brace count that skips comments and strings gives the same net depth of one
for the four files checked by hand (`common/ideas/SOV.txt`, `common/ideas/persia.txt`,
`common/scripted_guis/AST_cabinet_trust_scripted_gui.txt`,
`common/doctrines/subdoctrines/sea/navy_submarine_doctrines.txt`).

## Acceptance fixtures

| Fixture                                                                                                        | Result                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/mods/b001`: the Chaos Redux B001 classes                                                             | `REF_UNKNOWN_TRIGGER b001_unknown_scripted_trigger` and `REF_UNKNOWN_EFFECT b001_undefined_effect`, verdict `fail`, exit 1. The same mod checked against the installed 1.19.3.0 game gives the same two findings            |
| `fixtures/mods/b001_valid`                                                                                     | No findings, verdict `pass`, exit 0                                                                                                                                                                                         |
| `fixtures/mods/b001` without a game folder                                                                     | No missing-name findings, both commands counted as unknown, verdict `incomplete`                                                                                                                                            |
| `fixtures/mods/on_actions_drop`: a copied `00_on_actions.txt`                                                  | `OVERRIDE_DROPS_ON_ACTION_HOOK` for `on_startup` event `vanilla.1`, the `on_startup` effect block and `on_new_term_election` event `vanilla.2`, and `OVERRIDE_DROPS_DEFINITION` for `on_new_term_election`                  |
| A scratch copy of the real `common/on_actions/00_on_actions.txt` with lines 215 to 291 removed (not committed) | 19 dropped hooks reported (`election.2` to `election.15`, `usa.6` to `usa.12`, `spain.9`, `lar_spain.1` and the `on_daily_SWE` effect) plus the two dropped on_action definitions. CWTools MD Edition reported none of them |
| One invalid and one valid fixture per rule (33 codes) in `crates/engine/tests/rules.rs`                        | Every invalid fixture reports its code; no valid fixture does                                                                                                                                                               |

## False alarms on vanilla

`hoi4-engine check --game <1.19.3.0>` checks the game as if it were a mod: 513 errors, 180
warnings and 353 infos in 3.5 s. Every finding was classified. A finding is a false alarm when
the game does define or accept what the engine reports missing.

| Code                                                                       | Count | Classification                                                                                                                                               |
| -------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYNTAX_*`                                                                 | 41    | True: unclosed blocks confirmed by an independent brace count                                                                                                |
| `LOC_MULTIPLE_LANGUAGE_HEADERS`, `LOC_MISSING_LANGUAGE_HEADER`             | 10    | True: the files have the reported header lines                                                                                                               |
| `REF_MISSING_LOCALISATION_KEY`                                             | 364   | True: an independent text search of every `.yml` file finds none of the keys                                                                                 |
| `REF_MISSING_SPRITE`                                                       | 65    | True: no `.gfx` file under `interface/`, `gfx/` or any DLC folder names them                                                                                 |
| `REF_MISSING_FOCUS`                                                        | 8     | True: for example `NOR_fascist_invasion_of_norway`, whose definition is commented out                                                                        |
| `REF_MISSING_EVENT`                                                        | 5     | True: for example `PER_SSB_events.8` (defined only as `PER_ssb_events.8`, so also a case mismatch) and `NSB_news.201`, which appears only in the reference   |
| `REF_MISSING_IDEA`                                                         | 1     | True: no idea or advisor token is named `CHI_claire_lee_chennault_air_chief`                                                                                 |
| `REF_CASE_MISMATCH`                                                        | 22    | True: each name is defined only with other letter case, for example `NSB_news.1` against `nsb_news.1`                                                        |
| `LINT_FLAG_NEVER_SET`                                                      | 131   | True: an independent search finds no `set_` or `modify_` for any of them, for example `BUL_AI_RANDOM_FASCIST` (only `BUL_AI_RANDOM_FASCIST_AXIS` is set)     |
| `LINT_EVENT_LOC_KEY_REUSED`                                                | 15    | True for the sample checked: `denmark_resistance_event.10` has a "Sure" and a "Nope" option, both named `denmark_resistance_event.10.a` and without triggers |
| `LINT_INERT_MTTH`                                                          | 2     | True: the two vanilla events Hagane's own audit found with both `is_triggered_only` and a timer                                                              |
| `LINT_DUPLICATE_DEFINITION`                                                | 2     | True: `has_soviet_tribute` in two scripted trigger files, `on_daily` in two scripted effect files                                                            |
| `REF_UNKNOWN_EFFECT` / `REF_UNKNOWN_TRIGGER`: character ids used as scopes | 4     | True: `PAR_jose_felix_estigarribia` and `SOV_Vasily_Kuznetsov` are not character ids (the first exists only as a portrait sprite name)                       |
| `REF_UNKNOWN_EFFECT` / `REF_UNKNOWN_TRIGGER`: `limit` inside `else`        | 15    | Unverified. `else` takes no `limit` in the documentation; the authors probably meant `else_if`. Whether the game logs it was not observed                    |
| `REF_UNKNOWN_TRIGGER`: `is_fighting_in_strategic_region`, `opponent`       | 8     | Unverified. Neither name is in any documentation file or `_documentation.md`; both are used only in `common/on_actions/14_sea_on_actions.txt`                |
| `LINT_FLAG_NEVER_CHECKED` (info)                                           | 353   | Information only, not counted                                                                                                                                |

No finding was shown to be false. 23 remain unverified because the game's own `error.log` for an
unmodded launch was not available: the only log on the machine comes from a ZIN session and
predates ZIN's current `replace_path` list. Unknown commands fell from 55,047 in the first
calibration run to these 27 by modelling `IF`/`OWNER`-style case-insensitive keys, iterator
arguments documented by the game, and character advisor tokens.

The independent search is a separate Python script that uses plain regular expressions over the
game's files, not the engine's parser (`verify_vanilla.py` in the session scratchpad, not
committed). It agreed with all 574 checked findings; its one disagreement was its own match of
the referencing line for `NSB_news.201`.

## Public mods

Each mod was checked three times in a row; the first run read the mod from OneDrive. Times and
memory were measured with the build just before the last two calibration changes (iterator
arguments for collections and modifier families of mod-defined types), which add lookups but no
passes; the finding counts are from the final build.

| Mod                            | Times (three runs)   | Peak memory | Errors | Warnings | Infos | Notable findings                                                                                                                                                                                                                                                                                   |
| ------------------------------ | -------------------- | ----------- | ------ | -------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vanilla (as the checked layer) | 12.9 s, 4.6 s, 4.3 s | 591 MB      | 513    | 180      | 353   | Above                                                                                                                                                                                                                                                                                              |
| Chaos Redux                    | 14.4 s, 5.0 s, 4.3 s | 790 MB      | 2,708  | 647      | 9,686 | 2,663 localisation keys missing, all from `localization_key` in scripted localisation (for example the debug texts `chaosx.event_name.70`); 30 `has_character` checks of `*_independence_wave_*` characters that no file defines and that are also used as scopes; 420 flags checked but never set |
| ZIN                            | 7.1 s, 5.7 s, 6.4 s  | 707 MB      | 12     | 215      | 302   | Real B001-class defects: `clear_country_flag` (the effect is `clr_country_flag`), `reverse_remove_opinion_modifier` and `has_global_event_target`, none of them a game command; one `replace_path` that loads an empty folder; 174 definitions removed by same-path copies                         |
| Ireland Total Overhaul         | 5.5 s, 5.5 s, 5.6 s  | 538 MB      | 1      | 848      | 2,864 | 848 flags checked but never set, for example `ireland_action_convene_a_cabinet_cohesion_review_locked`, which is only checked and cleared                                                                                                                                                          |

The large warning counts are what the baseline is for: `baseline init` records them once, and
later checks fail only on new ones.

## Performance

| Run                                               | Time                         | Peak memory  |
| ------------------------------------------------- | ---------------------------- | ------------ |
| `hoi4-engine --version`                           | 0.07 s                       | 4 MB         |
| `roundtrip` of vanilla (7,717 files)              | 0.6 s                        | not measured |
| `check` of vanilla                                | 4.3 s warm, 12.9 s first run | 591 MB       |
| `check` of the B001 fixture against the real game | 4.3 s                        | 515 MB       |

The first calibration build took 49 s for vanilla because every finding searched all 164,568
localisation keys for a suggestion; suggestions now use a linear one-edit test and skip
localisation keys and sprites.

## Not measured

- Linux amd64 and macOS arm64 runs. The workspace's CI job runs the tests on Ubuntu, Windows and
  macOS (arm64) runners, but timing and memory there were not measured.
- An unmodded game launch to confirm the 23 unverified vanilla findings against `error.log`.

# Provenance of adapted code

The engine is new code under Apache-2.0, except for the files below. They adapt modules of
Hagane Studio ([hagane-works/hagane-studio](https://github.com/hagane-works/hagane-studio) at
commit `1e831623ed162e1a64763c242c55b249376ba20c`, released under GPL-3.0-only). The copyright
holder gave the maintainer written permission to use Hagane Studio and
[haganeworks/hoi4-modmaking-skills](https://github.com/haganeworks/hoi4-modmaking-skills) in any
way, including under this repository's licence. The maintainer holds that permission (HOI4
Factory decision D-05, recorded 2026-10-31). Each adapted file names its source in its header.

| Engine file                                   | Hagane source                                                                        | What was kept                                                                                                                                                                                               | What changed                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/engine/src/repair.rs`                 | `internal/hoi4/clausewitz/crossref.go` (`PlanCrossRefRepair`, `ApplyCrossRefRepair`) | A repair plan records the source SHA-256 and the exact text it replaces. Applying refuses when either changed. Deleting an assignment under boolean logic (`NOT`, `OR`, `AND`, `count_triggers`) is refused | Byte offsets on the lossless parser instead of rune offsets. Plans are data for callers; the command-line interface never applies them                                                                                                                     |
| `crates/engine/src/delta.rs`                  | `internal/hoi4/savediagnostics/diagnostics.go` (`Compare`)                           | The change classes introduced, worsened, changed, improved, unchanged and resolved, matched by a stable key                                                                                                 | The key is the engine's finding fingerprint. "Improved" and "worsened" compare severity, because engine findings have one subject instead of Hagane's affected-entity sets                                                                                 |
| `crates/engine/src/lints.rs` (`flags`)        | `internal/domains/focus/lint.go` (dead-flag lint)                                    | Flags set but never checked, and checked but never set, with dynamic names (`@`, `$`) left out                                                                                                              | Read from the syntax tree of every loaded file instead of two regular expressions over JSON rows. Covers country, global, state, character, unit leader and MIO flags and `modify_*_flag`. A dynamic setter covers checks that start with its fixed prefix |
| `crates/engine/src/lints.rs` (`dlc`)          | `internal/hoi4/exportengine/dlc_conditional_lint.go`                                 | `has_dlc` with a name the game does not know, with a typo suggestion                                                                                                                                        | DLC names come from the installed game (`dlc_metadata/dlc_info/*.txt` and each `.dlc` descriptor) instead of a built-in list                                                                                                                               |
| `crates/drawio/src/lib.rs`                    | `internal/hoi4/drawio/drawio.go` and `drawio_test.go`                                | Output shape, limits (8 MiB, 200-character ids, 255-character names, 100 px per grid unit), collision handling and warning texts                                                                            | Rust with `roxmltree`, which refuses document type declarations                                                                                                                                                                                            |
| `crates/drawio/tests/data/hagane_parity.json` | `internal/hoi4/drawio/testdata/python_parity.json`                                   | Copied unchanged                                                                                                                                                                                            | None. The ported importer passes it unchanged                                                                                                                                                                                                              |

## Hagane finding codes used as fixtures

Hagane's finding codes were read as a checklist. Where the engine has the same check, a fixture
in `crates/engine/tests/rules.rs` or a unit test covers it under the engine's own code.

| Hagane code                                   | Engine code                                         | Test                                                               |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `clausewitz.unclosed_block`                   | `SYNTAX_UNCLOSED_BLOCK`                             | `rules.rs`, `ast.rs`                                               |
| `clausewitz.stray_closing_brace`              | `SYNTAX_STRAY_CLOSING_BRACE`                        | `rules.rs`, `ast.rs`                                               |
| `clausewitz.missing_assignment_value`         | `SYNTAX_MISSING_VALUE`                              | `rules.rs`, `ast.rs`                                               |
| `clausewitz.unterminated_quote`               | `SYNTAX_UNTERMINATED_STRING`                        | `rules.rs`, `ast.rs`                                               |
| `localisation.missing_utf8_bom`               | `LOC_MISSING_BOM`                                   | `rules.rs`, `localisation.rs`                                      |
| `localisation.missing_language_header`        | `LOC_MISSING_LANGUAGE_HEADER`                       | `rules.rs`, `localisation.rs`                                      |
| `localisation.multiple_language_headers`      | `LOC_MULTIPLE_LANGUAGE_HEADERS`                     | `localisation.rs`                                                  |
| `localisation.content_before_language_header` | `LOC_CONTENT_BEFORE_HEADER`                         | `localisation.rs`                                                  |
| `localisation.missing_open_quote`             | `LOC_MISSING_OPEN_QUOTE`                            | `localisation.rs`                                                  |
| `localisation.unterminated_value`             | `LOC_UNTERMINATED_VALUE`                            | `rules.rs`, `localisation.rs`                                      |
| `localisation.invalid_entry`                  | `LOC_INVALID_LINE`                                  | `localisation.rs`                                                  |
| `refs.focus_missing`                          | `REF_MISSING_FOCUS`                                 | `rules.rs`                                                         |
| `refs.focus_case`, `refs.completed_case`      | `REF_CASE_MISMATCH`                                 | `rules.rs`                                                         |
| `cross_ref.typo`                              | `suggestion` on `REF_MISSING_*` and `REF_UNKNOWN_*` | `index.rs`                                                         |
| `cross_ref.unknown`                           | `unknown` in the coverage tally, never a pass       | `rules.rs` (`b001_classes_are_caught_and_unknown_is_never_a_pass`) |
| `focus_*` mutual exclusion symmetry           | `LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL`            | `rules.rs`                                                         |

Hagane codes not carried over: the `politics_*` and `ideology_source_*` families depend on
Hagane's own data model, and the performance heuristics (`perf.*`) have thresholds no
measurement supports.

## Not copied

No game file and no third-party mod file is in this workspace. The fixtures under `fixtures/` are
synthetic. CWTools MD Edition and its rules were run as separate programs for the spike in
`docs/research/cwtools-md-edition-spike.md`; none of their code is here.

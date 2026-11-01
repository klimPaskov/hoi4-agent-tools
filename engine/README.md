# HOI4 engine

A Rust workspace with the one shared Hearts of Iron IV engine for hoi4-agent-tools, the Agentic
HOI4 Modding Kit, Chaos Redux and HOI4 Factory (ADR 0074). It reads a mod with the game and its
dependencies in load order, and reports what the game would reject or silently lose.

| Crate             | What it does                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hoi4-syntax`     | Lossless Clausewitz parser (`.txt`, `.gui`, `.gfx`, `.asset`, `descriptor.mod`) and localisation reader (`.yml`). Every byte belongs to one token, every node has a byte span, and the tree rebuilds the input byte for byte. UTF-8, UTF-8 with a byte order mark and Windows-1252 |
| `hoi4-engine`     | Layers and load order, symbol index, reference closure, lints, override audit, findings baseline, finding delta and hash-guarded repair plans                                                                                                                                      |
| `hoi4-drawio`     | Imports a draw.io sketch of a focus tree into focus ids, grid positions and prerequisite links                                                                                                                                                                                     |
| `hoi4-engine-cli` | The `hoi4-engine` command                                                                                                                                                                                                                                                          |

## Build

```sh
cd engine
cargo build --release -p hoi4-engine-cli
```

The binary is `target/release/hoi4-engine` (`.exe` on Windows). Rust is pinned by
`rust-toolchain.toml`. The workspace has five dependencies: `serde`, `serde_json`, `sha2`,
`rayon` and `roxmltree`.

## Commands

```sh
hoi4-engine check --game "<game>" --mod "<mod>" [--dependency "<mod>"]... [--baseline baseline.json] [--fail-on error|warning|never] [--format text|json] [--all]
hoi4-engine baseline init --game "<game>" --mod "<mod>" --baseline baseline.json
hoi4-engine baseline update --game "<game>" --mod "<mod>" --baseline baseline.json
hoi4-engine roundtrip <folder>...
hoi4-engine delta before.json after.json
hoi4-engine vocab --game "<game>"
hoi4-engine drawio sketch.drawio --prefix GER
```

`--game` defaults to the `HOI4_GAME_DIR` environment variable. Without `--mod` the game itself is
checked. `--dependency` adds a mod loaded before the checked one; repeat it in load order.

Exit codes: `0` when no new finding reaches `--fail-on` (default `warning`), `1` when one does,
`2` for a usage or input error.

### Verdicts

- `fail`: a new finding at or above `--fail-on`.
- `incomplete`: nothing fails, but something could not be checked: no game folder, names built at
  run time (`$PARAM$`, `@x`, `[?var]`), or script folders without a context model. They are listed
  in `coverage`. Unknown is never reported as a pass.
- `pass`: everything was checked and nothing fails.

### Calling it from `check.py`

```python
result = subprocess.run(
    [engine, "check", "--game", game, "--mod", mod_root, "--baseline", baseline, "--format", "json"],
    capture_output=True, text=True, encoding="utf-8",
)
report = json.loads(result.stdout)  # exit code 1 means new findings, 2 a usage error
```

The report (`schema: hoi4-engine-report/1`) has `verdict`, `summary` (counts by severity and
code), `baseline` (entries, still present, new, fixed), `coverage` (references by kind with
resolved, unresolved and unknown counts, including kinds with none; effect and trigger commands;
folders without a model), `overrides` (each replaced file and the layer that wins) and
`findings`. Each finding has `code`, `severity`, `message`, `path`, `layer`, `line`, `column`,
byte `start` and `end`, `subject`, `context` (such as `event:my.1`), `suggestion`, `fingerprint`
and `status` (`new` or `baselined`). `--repair-plans` adds a hash-guarded replacement plan to
findings that have a suggestion; the command never edits files.

### Baseline

`baseline init` records the current warnings and errors by fingerprint. A fingerprint is the
code, path, enclosing definition, subject and ordinal, not the line, so moving code does not make
an old finding new. `check --baseline` fails only on findings the baseline does not cover and
shows how many entries are fixed. `baseline update` removes fixed entries and never adds any.

## Checks

The documented vocabulary is read from the installed game's `documentation/effects_documentation.md`,
`triggers_documentation.md` and `modifiers_documentation.md` at run time (templated modifiers such
as `<Ideology>_drift` are expanded from their "Modified types" lists). Nothing from the game is
stored in this repository.

| Code                                        | Severity | Meaning                                                                                                                                                                                                    |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REF_UNKNOWN_EFFECT`, `REF_UNKNOWN_TRIGGER` | error    | A command that is neither documented, nor control flow, nor a scope, nor a scripted effect or trigger defined in a loaded file. The game reports these as "Unknown effect-type" and "Unknown trigger-type" |
| `REF_MISSING_<KIND>`                        | error    | A reference to an event, focus, idea, decision, character, sprite, localisation key, country tag, opinion or dynamic modifier, technology and other kinds that no loaded file defines                      |
| `REF_CASE_MISMATCH`                         | warning  | The name is defined only with other letter case                                                                                                                                                            |
| `LINT_MUTUALLY_EXCLUSIVE_NOT_RECIPROCAL`    | warning  | Focus A excludes B but B does not exclude A                                                                                                                                                                |
| `LINT_EVENT_NAMESPACE_COLLISION`            | warning  | The mod declares a namespace the game declares in another file                                                                                                                                             |
| `LINT_INERT_MTTH`                           | warning  | A triggered-only event has a `mean_time_to_happen` that never runs                                                                                                                                         |
| `LINT_EVENT_LOC_KEY_REUSED`                 | warning  | One event shows the same localisation key for two texts                                                                                                                                                    |
| `LINT_UNKNOWN_MODIFIER`                     | warning  | A modifier block uses a name the game does not document or derive                                                                                                                                          |
| `LINT_FLAG_NEVER_SET`                       | warning  | A flag is checked but nothing sets it, so the check is always false                                                                                                                                        |
| `LINT_FLAG_NEVER_CHECKED`                   | info     | A flag is set but nothing checks it                                                                                                                                                                        |
| `LINT_UNKNOWN_DLC`                          | error    | `has_dlc` names no DLC the game knows                                                                                                                                                                      |
| `LINT_DUPLICATE_DEFINITION`                 | error    | The mod defines the same event, scripted effect or scripted trigger twice                                                                                                                                  |
| `OVERRIDE_DROPS_DEFINITION`                 | warning  | A same-path copy of a game file lacks a definition the original had, and nothing else defines it                                                                                                           |
| `OVERRIDE_DROPS_ON_ACTION_HOOK`             | warning  | A copied `on_actions` file no longer hooks an event or effect the original hooked                                                                                                                          |
| `OVERRIDE_BREAKS_REFERENCE`                 | error    | A file that still loads calls a scripted effect or trigger whose only definition the mod unloaded                                                                                                          |
| `OVERRIDE_CASE_ONLY_SHADOW`                 | warning  | The override differs from the replaced path only in letter case, so it replaces it on Windows only                                                                                                         |
| `OVERRIDE_REPLACE_PATH_EMPTY`               | error    | `replace_path` unloads a folder and the mod puts nothing there                                                                                                                                             |
| `OVERRIDE_REPLACE_PATH_DROPS`               | info     | How many definitions a `replace_path` unloads that nothing else provides                                                                                                                                   |
| `OVERRIDE_REPLACES_FILE`                    | info     | The file replaces a game or dependency file entirely                                                                                                                                                       |
| `SYNTAX_*`                                  | error    | Unclosed block, stray `}`, missing value, stray operator, unterminated string, nesting deeper than 256                                                                                                     |
| `LOC_*`                                     | warning  | Missing byte order mark or language header, several headers, malformed lines                                                                                                                               |

`replace_path` unloads only files directly in the named folder, not its subfolders, as the
offline wiki's Modding page states.

### Folders with a context model

Effects, triggers and references are checked in `events/`, `common/scripted_effects/`,
`common/scripted_triggers/`, `common/decisions/` (and `categories/`), `common/national_focus/`,
`common/continuous_focus/`, `common/ideas/`, `common/on_actions/`, `common/characters/`,
`common/dynamic_modifiers/`, `common/scripted_localisation/` and `common/scripted_guis/`. Other
script folders are listed under `coverage.unmodelled_script_folders` and keep the verdict at
`incomplete`. Definitions are indexed from more folders (technologies, country tags and aliases,
states, ideologies, traits, opinion and static modifiers, units, equipment, buildings, terrain,
resources, combat tactics, sprites and localisation).

## Tests

```sh
cd engine
cargo test --no-fail-fast
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

`crates/engine/tests/rules.rs` has an invalid and a valid fixture for every rule, the Chaos Redux
B001 classes (an unknown scripted trigger and an undefined effect) and a copied `00_on_actions.txt`
that drops hooks. They run against the synthetic game in `fixtures/game`. Measurements on the
installed game and on public mods are in `docs/research/engine-w4-evidence.md`.

## Limits

- Scopes are not checked: a country effect used in a state scope is not reported.
- Arguments of documented commands are not type-checked, apart from the references listed above.
- Variables, event targets and other names built at run time are counted as unknown.
- Sprites inside zipped DLC archives are not read.

# HOI4 engine

A Rust workspace with the one shared Hearts of Iron IV engine for hoi4-agent-tools, the Agentic
HOI4 Modding Kit, Chaos Redux and HOI4 Factory (ADR 0074). It reads a mod with the game and its
dependencies in load order, and reports what the game would reject or silently lose.

| Crate               | What it does                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hoi4-syntax`       | Lossless Clausewitz parser (`.txt`, `.gui`, `.gfx`, `.asset`, `descriptor.mod`) and localisation reader (`.yml`). Every byte belongs to one token, every node has a byte span, and the tree rebuilds the input byte for byte. UTF-8, UTF-8 with a byte order mark and Windows-1252 |
| `hoi4-engine`       | Layers and load order, symbol index, reference closure, lints, override audit, findings baseline, finding delta and hash-guarded repair plans                                                                                                                                      |
| `hoi4-drawio`       | Imports a draw.io sketch of a focus tree into focus ids, grid positions and prerequisite links                                                                                                                                                                                     |
| `hoi4-focus-layout` | Lays out focus trees and inserts branches on the focus grid with an in-game connector model ([README](crates/focus/README.md))                                                                                                                                                     |
| `hoi4-engine-cli`   | The `hoi4-engine` command                                                                                                                                                                                                                                                          |

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
hoi4-engine sprites --game "<game>" [--mod "<mod>"] [--allowlist sprites-allow.json] [--all-layers] [--index] [--format text|json] [--fail-on error|warning|never]
hoi4-engine drawio sketch.drawio --prefix GER
hoi4-engine focus-layout --request request.json
hoi4-engine localisation --request request.json
```

`focus-layout` reads one JSON request (`hoi4-focus-layout-request/1`) from `--request` or stdin and
writes the layout (`hoi4-focus-layout/1`) to stdout; see [the crate README](crates/focus/README.md).

`localisation` reads one JSON request from `--request` or stdin, with `game`, `mod`,
`dependencies`, `includeDlc`, `mode` (`key`, `audit` or `coverage`), `key`, `language` and `limit`,
and writes its answer to stdout. It backs `hoi4.localisation_inspect`; see `crates/engine/src/localisation.rs`.

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

## Sprites

`hoi4-engine sprites` (library: `hoi4_engine::sprites`, `sprite_trace`, `sprite_audit`) is the one
implementation of the sprite index and the content-to-sprite trace. HOI4 Factory's image tools and
the planned GFX validation call it instead of keeping their own copies. The crates are
`publish = false` and build standalone, so another workspace can depend on them from Git:

```toml
hoi4-engine = { git = "https://github.com/klimPaskov/hoi4-agent-tools", package = "hoi4-engine" }
```

```rust
use hoi4_engine::sprite_audit::{Allowlist, SpriteReport};
use hoi4_engine::sprite_trace::TraceOptions;
use hoi4_engine::{Workspace, WorkspaceOptions};

let ws = Workspace::load(&WorkspaceOptions { game: Some(game), target: Some(mod_dir), include_dlc: true, ..Default::default() });
let (index, report) = SpriteReport::run(&ws, &Allowlist::default(), &TraceOptions::default());
let sprite = index.get("GFX_goal_unknown");                  // by name, without case
let sharing = index.by_texture("gfx/interface/goals/x.dds"); // by texture path
for u in &report.uses { println!("{} {:?} {}:{}", u.sprite, u.family, u.path, u.line); }
```

API summary:

- `SpriteIndex::build(&Workspace)`, `get(name)`, `definitions_of(name)`, `effective()`,
  `by_texture(path)`, `texture(path)` (resolves any texture path), `texture_of(&SpriteDef)`.
  `SpriteDef` has `name`, `kind` and `block_type`, `texturefile`, `frames`, `effect_file`,
  `legacy_lazy_load`, `load_type`, `animation_blocks`, the defining `layer`/`path`/`line` and
  `effective` (the last loaded definition of a name wins). `ResolvedTexture` has `exists`, the
  supplying `layer` and a `TextureHeader` (DDS size, mip count, fourcc or DXGI format, TGA bits and
  origin, PNG; headers only, no pixels are decoded).
- `sprite_trace::trace(&Workspace, &SpriteIndex, &TraceOptions)` returns `SpriteUse` values: sprite
  name, resolved texture, `content_type`, `family` (`Family`, serialised as the id string), file,
  line, column and the enclosing definition. `Family::ALL` lists the 41 ids.
- `sprite_audit::audit` and `SpriteReport::run` return findings and a summary.

A texture path is looked up in the layers from last to first without regard to case; a layer's file
is skipped when a later layer's `replace_path` unloads its folder. By default only the checked
layer's files are traced (the mod, or the game without `--mod`); `--all-layers` traces everything
loaded. `--index` adds every sprite definition to the JSON.

### Content to family rules

Each rule was checked against Hearts of Iron IV 1.19.4.1. The example is a vanilla `file:line`.

| Content key                                                                                                                                                  | Family                                                                                                                     | Prefix rule                                                                                                        | Vanilla example                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| focus `icon` (scalar, or conditional block `GFX_x = { trigger }`, `GFX_y = yes`)                                                                             | `focus`                                                                                                                    | none; every name in a conditional block is a use                                                                   | `common/national_focus/TSR_lingguang_incident_joint_branch.txt:4`; conditional `afghanistan.txt:335` |
| continuous focus `icon`                                                                                                                                      | `focus`                                                                                                                    | none                                                                                                               | `common/continuous_focus/generic.txt:16`                                                             |
| idea `picture = x`                                                                                                                                           | by slot, below                                                                                                             | `GFX_idea_<x>` unless `x` starts with `GFX_`; no picture means `GFX_idea_<idea key>` (implicit, only when defined) | `common/ideas/GER.txt:46` (`can_wartime_prices_and_trade_board`), `GER.txt:4` (explicit)             |
| ideas in `country`, laws and other slots                                                                                                                     | `idea_spirit`                                                                                                              | as above                                                                                                           | `common/ideas/GER.txt:4`                                                                             |
| `industrial_concern`, `*_manufacturer` slots                                                                                                                 | `idea_concern`                                                                                                             | as above                                                                                                           | `common/ideas/CSA.txt:8`, `GER.txt:4389`                                                             |
| `political_advisor`, `theorist`, `army_chief`, `navy_chief`, `air_chief`, `high_command` slots (and `character_slot` names from loaded `idea_tags`)          | `advisor_card`                                                                                                             | as above                                                                                                           | `common/ideas/andalusia.txt:9`                                                                       |
| `academy_spirit`, `army_spirit`, `division_command_spirit`, navy and air equivalents (slots of `type = army_spirit`, `navy_spirit`, `air_spirit` categories) | `officer_corps_spirit`                                                                                                     | as above                                                                                                           | `common/ideas/air_spirits.txt:3`, `army_spirits.txt:846`                                             |
| character `portraits = { civilian = { large } }`                                                                                                             | `leader_portrait` (`operative_portrait` for operatives, `scientist_portrait` for scientists without a country leader role) | none; a texture path is also allowed                                                                               | `common/characters/ABK.txt:6`, scientist `JAP.txt:1881`                                              |
| character `portraits = { army or navy = { large } }`                                                                                                         | `commander_portrait`                                                                                                       | none                                                                                                               | `common/characters/AFG.txt:93`, navy `CRO.txt:116`                                                   |
| character `portraits = { any = { small } }`                                                                                                                  | `advisor_card`                                                                                                             | none                                                                                                               | `common/characters/AFA.txt:9`                                                                        |
| advisor `idea_token`                                                                                                                                         | `advisor_card`                                                                                                             | `GFX_idea_<token>` only when the character has no `small` portrait and the sprite is defined (implicit)            | `common/characters/GER.txt` advisors                                                                 |
| decision `icon` (missions have `days_mission_timeout`; same family)                                                                                          | `decision`                                                                                                                 | `GFX_decision_<x>` unless `GFX_`                                                                                   | `common/decisions/ARG.txt:764` (`oil`), mission `ARG.txt:1026`, explicit `AFG.txt:5`                 |
| decision category `icon`                                                                                                                                     | `decision_category_icon`                                                                                                   | `GFX_decision_category_<x>` unless `GFX_`                                                                          | `common/decisions/categories/00_decision_categories.txt:16`                                          |
| decision category `picture`                                                                                                                                  | `decision_category_picture`                                                                                                | `GFX_decision_cat_picture_<x>`, then `GFX_<x>`; `GFX_` as written                                                  | `00_decision_categories.txt:23`, unprefixed `CHI_decision_categories.txt:166`                        |
| dynamic modifier `icon`                                                                                                                                      | `state_modifier`                                                                                                           | none                                                                                                               | `common/dynamic_modifiers/0_dynamic_modifiers.txt:36`                                                |
| MIO organization `icon`; `set_mio_icon`                                                                                                                      | `mio_department`                                                                                                           | none                                                                                                               | `.../organizations/00_generic_organization.txt:15`, `common/decisions/FRA.txt:1381`                  |
| MIO `add_trait`, `override_trait`, `initial_trait`, `trait` `icon`                                                                                           | `mio_trait`; `mio_department` when the sprite name contains `mio_department`                                               | none                                                                                                               | `00_generic_organization.txt:140`, department `:198`                                                 |
| MIO policy `icon`                                                                                                                                            | `mio_policy`                                                                                                               | none                                                                                                               | `.../policies/_air_policies.txt:2`                                                                   |
| balance of power `side = { icon }`; `set_power_balance_gfx = { gfx }`                                                                                        | `bop_side`                                                                                                                 | none (`[...]` names are dynamic and not resolved)                                                                  | `common/bop/BRA.txt:27`, `CZE.txt:143`                                                               |
| special project `icon`                                                                                                                                       | `special_project_icon`                                                                                                     | none                                                                                                               | `common/special_projects/projects/air_projects.txt:11`                                               |
| operation `icon`, `map_icon`; phase `icon`; token `icon`                                                                                                     | `operation_icon`                                                                                                           | none                                                                                                               | `common/operations/00_operations.txt:7`, `:8`                                                        |
| operation phase `picture`                                                                                                                                    | `operation_picture`                                                                                                        | none                                                                                                               | `common/operation_phases/00_operation_phases.txt:5`                                                  |
| intelligence agency upgrade `picture`                                                                                                                        | `agency_upgrade`                                                                                                           | none                                                                                                               | `common/intelligence_agency_upgrades/intelligence_agency_upgrades.txt:8`                             |
| intelligence agency `picture`                                                                                                                                | `agency_logo`                                                                                                              | none                                                                                                               | `common/intelligence_agencies/00_intelligence_agencies.txt:7`                                        |
| raid `target_icon`, `custom_map_icon`                                                                                                                        | `raid`                                                                                                                     | none                                                                                                               | `common/raids/air_raids.txt:67`, `:69`                                                               |
| unit medal `icon`                                                                                                                                            | `medal`                                                                                                                    | none                                                                                                               | `common/unit_medals/00_default.txt:41`                                                               |
| faction `icon`                                                                                                                                               | `faction_logo`                                                                                                             | none                                                                                                               | `common/factions/member_upgrades/member_groups/member_upgrade_groups.txt:16`                         |
| doctrine `icon`                                                                                                                                              | `doctrine`                                                                                                                 | none                                                                                                               | `common/doctrines/grand_doctrines/air_grand_doctrines.txt:6`                                         |
| technology `icon`; otherwise the tech key                                                                                                                    | `technology`                                                                                                               | `GFX_<tech key>_medium` (implicit, only when defined)                                                              | `common/technologies/MTG_naval.txt:10`                                                               |
| scientist trait `icon`                                                                                                                                       | `personal_trait`                                                                                                           | none                                                                                                               | `common/scientist_traits/00_traits.txt:27`                                                           |
| event `picture`                                                                                                                                              | `report_event`, or `news_event` for `news_event` blocks                                                                    | none                                                                                                               | `events/AAT_Denmark.txt:22`, news `AAT_NewsEvents.txt:15`                                            |
| `create_country_leader` `picture`; `create_corps_commander`, `create_field_marshal`, `create_navy_leader` `portrait_path`                                    | `leader_portrait`, `commander_portrait`                                                                                    | none                                                                                                               | `common/decisions/ENG.txt:3201`, `common/national_focus/portugal.txt:4367`                           |
| `technology_sharing` `picture`, `occupation_laws` `icon`, `abilities` `icon`                                                                                 | `unknown`                                                                                                                  | none                                                                                                               | `common/abilities/CHI_abilities.txt:5`                                                               |

Texture sizes on the installed game back the split: focus icons 100x88 (52%), decision icons
33x32 (69%), report events 210x176 (87%), news events 397x153 (91%), leader and commander portraits
156x210, advisor cards 65x67, idea spirits 60x68, concerns 64x64, officer corps spirits mostly 45x45.
Two caveats: an MIO organization icon is idea-sized (64x64) while department and trait icons are
48x48, and the engine-bound families (flags, counters, buildings, achievements, GUI textures,
super events, modifier stat icons, division emblems, commander traits) have no script slot, so the
trace never produces them. Many vanilla characters name `GFX_portrait_*` sprites that no file
defines; they are reported as `GFX-SPRITE-UNDEFINED`.

The implicit fallbacks (`GFX_idea_<idea key>`, `GFX_<key>_medium`, `GFX_idea_<idea_token>`) are
reported only when the sprite is defined, so a missing fallback is never a finding.

### Sprite findings

| Code                      | Severity | Meaning                                                                                                                                |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GFX-FAMILY-REUSE`        | warning  | A sprite name, or a resolved texture reached through two or more sprites, is used by two or more families. The message lists every use |
| `GFX-TEXTURE-MISSING`     | warning  | A sprite's `texturefile` (or a texture path a script names) resolves to no file in any layer                                           |
| `GFX-SPRITE-UNDEFINED`    | warning  | A script names a sprite that no loaded `.gfx` file defines                                                                             |
| `GFX-FOCUS-SHINE-MISSING` | error    | A focus sprite has no `<name>_shine` sprite; the game then draws a ? instead of the icon (seen in game on 1.19.4.1)                    |

`--allowlist file.json` records intentional aliases:

```json
{
  "aliases": [
    {
      "sprite": "GFX_idea_shared",
      "families": ["idea_spirit", "decision"],
      "reason": "same art on purpose"
    },
    { "texture": "gfx/interface/shared.dds" }
  ],
  "no_shine": ["GFX_goal_special"],
  "missing_textures": ["GFX_placeholder"]
}
```

An alias without `families` covers any combination; with `families` it covers reuse only when every
family involved is listed. Unknown family ids are an error (exit code 2).

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

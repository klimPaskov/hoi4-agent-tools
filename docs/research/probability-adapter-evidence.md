# Probability adapter evidence

The AI and MTTH Scenario Analyzer targets Hearts of Iron IV **Operation Postern 1.19.2.0 (checksum d245)**. Adapter behavior is versioned as `hoi4-1.19.2.v1`; results always include that adapter version and game build.

This review used the installed game's documentation, vanilla source examples, and an offline Paradox wiki snapshot. Paths below are relative to a Hearts of Iron IV installation or to the offline snapshot. SHA-256 values identify the exact files reviewed on 2026-07-22.

## Adapter semantics

| Adapter                                           | Proven interpretation                                                                                                                                                                                                                  | Exact probability conditions                                                                                                                                                     | Deliberate boundary                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `event_mean_time_to_happen`                       | Ordered `base`, `add`, and `factor` operations produce an effective duration. When the trigger is active, `M` days is the median of daily checks, so daily hazard is `1 - 2^(-1/M)`. Inactive event triggers are polled every 20 days. | A time-horizon chance is exact only while trigger state, every modifier input, scheduled change, and any inactive-to-active polling phase are declared.                          | It does not execute events or infer state changes. Missing poll phase produces a 0–20 day activation bound.                      |
| `event_option_ai_chance`                          | Options form one proportional categorical pool. An omitted block has weight 1. An all-zero pool selects the first option.                                                                                                              | Every option and eligibility result for the event must be present.                                                                                                               | The engine's d100 selection granularity is reported for effective shares below one percent.                                      |
| `decision_ai_will_do` and `mission_ai_will_do`    | Ordered source modifiers produce a raw desirability score after eligibility.                                                                                                                                                           | No normalized probability is claimed.                                                                                                                                            | Local documentation does not prove a complete categorical denominator or a universal selection formula.                          |
| `national_focus_ai_will_do`                       | Each eligible focus receives an independent uniform draw from zero to its evaluated score; the maximum wins. A just-completed prerequisite and AI strategy focus factors can change the score.                                         | The complete eligible candidate pool and every external focus factor must be declared. Exact probabilities use the independent-uniform maximum race, not `weight / sum(weight)`. | Ordered AI strategy plans can override weighted choice and are reported rather than simulated.                                   |
| `technology_ai_will_do` and `doctrine_ai_will_do` | Eligible candidates use the independent-uniform maximum-score race. Research factors, cost, date, bonuses, and forced strategy choices can alter or override ranking.                                                                  | The complete eligible pool and all external research factors must be declared.                                                                                                   | Research duration is not selection probability. Forced research strategies and wider research-slot scheduling are not simulated. |
| `direct_random`                                   | `chance` is an independent percentage in `[0,100]`.                                                                                                                                                                                    | The chance expression must resolve.                                                                                                                                              | It is never normalized against neighboring blocks.                                                                               |
| `random_list`                                     | Entries form the complete local proportional weight pool. Nested entries retain their immediate conditional share and multiply through enclosing lists for a full path probability.                                                    | Every entry, enclosing list, and modifier on the selected path must resolve.                                                                                                     | Dynamic entry identifiers, dynamic parent paths, or effect-derived values remain unresolved unless supplied explicitly.          |
| `ai_strategy_factor`                              | Supported strategy types modify a target score. `research_weight_factor` is a percentage factor; positive `research_tech` forces prioritization.                                                                                       | Raw factor evaluation is exact when the strategy and target are explicit.                                                                                                        | A strategy definition is not itself normalized into a probability pool.                                                          |
| `custom_weighted_pool`                            | The manifest declares categorical or independent selection plus recovery, caps, cooldowns, removals, resets, timer changes, and terminal states.                                                                                       | Exact finite-state analysis is used while the state space stays bounded; otherwise the result is explicitly beam-bounded or seeded Monte Carlo.                                  | Only declared state transitions run. Gameplay effects and campaign state are never inferred or executed.                         |

## Installed documentation reviewed

| Relative path                                   | SHA-256                                                            | Used for                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `launcher-settings.json`                        | `f99265973bba12f30906cc98629d8520218ff8cd90a5f9d1d82e7f00fb737b9e` | Installed game version and checksum                           |
| `common/decisions/_documentation.md`            | `5e7e686b5582f32c38d898d805e17171e88f3bfeee4a030deb1884f9726de019` | Decision scopes, eligibility surfaces, and evaluation cadence |
| `common/doctrines/_documentation.md`            | `f0d1b7ad1f1dc8afe59942a406784a2d72c0c73dd42963c2502f89961eea85d4` | Current doctrine definitions and AI fields                    |
| `common/script_constants/documentation.md`      | `e2812efbddc7961038e1f1f2b6dd6b059bdc70704ec87d1fe530835d9141be1c` | `constant:` schema and nested constant paths                  |
| `documentation/script_concept_documentation.md` | `884bfe9f9207ea4b25b36b5129d0f77d11d4b2f7eb0592587767ec58d24930c7` | Script constants and dynamic script concepts                  |
| `documentation/effects_documentation.md`        | `2cdc93d26775990468eed167442f7a416b13059fb8fe07d139b54250b79209af` | `random_list` and AI strategy effect syntax                   |
| `common/ai_strategy/_documentation.md`          | `70f5d755ae7ed4060e49cc64a393d1a0dc5611b3acc8abc6dfb4538781c915a1` | `research_tech` and `research_weight_factor` behavior         |

The offline wiki pages `AI modding`, `Data structures`, `Decision modding`, `Event modding`, `National focus modding`, `Scopes`, and `Technology modding` were reviewed in parallel. Their respective SHA-256 values were `f1fdb9fd…a14f`, `20a03385…a14f`, `500e8161…68c`, `b0186d9b…e00`, `b1c7f624…6faf`, `04866815…fdc`, and `48050261…fdc`.

## Vanilla examples reviewed

| Surface                       | Relative path and line                                         | SHA-256                                                            |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Event MTTH                    | `events/Yugoslavia.txt:49`                                     | `138279b294ef0d567e477efe2f0ebb72c5c0a7f2920ed3fd03d2792749624dbc` |
| Event option `ai_chance`      | `events/AAT_Generic_Events.txt:44`                             | `e718d19edba2d56c75a5bbf1fa0c51bbb6cda54e0919434c4490fec9dabcea69` |
| Decision `ai_will_do`         | `common/decisions/_generic_decisions.txt:56`                   | `83cd276f8fd2c0c90470225c996d7afee7b8c08437289dd23d819a4a29edb187` |
| Focus `ai_will_do`            | `common/national_focus/austria.txt:122`                        | `0f197e321cb9e0c267a11c78bccb570ef42d1fc251e7af05fb4f385de27a1059` |
| Technology `ai_will_do`       | `common/technologies/industry.txt:30`                          | `06d45f11a0bfdee35ef72b935b2bee3b0083a49eb771e5c6b9391c087ed7d94f` |
| Current doctrine `ai_will_do` | `common/doctrines/grand_doctrines/land_grand_doctrines.txt:14` | `cd81a877366c582f096422320cd7fcf9fb259afcc8d45d3dbb887b37792b329d` |
| `random_list`                 | `events/AAT_Sweden.txt:1760`                                   | `8fad5c10d147afab27eb42c78f3261c804cd6149f1c81927418ab0bbe3b8bf29` |
| Direct `random`               | `events/BBA_Switzerland.txt:1197`                              | `4331bbe2ea7d0844eb357ecd73f915c1ba3e5a0b115ae62ea5b95a8011e1145e` |
| AI research strategy factor   | `common/ai_strategy/ENG.txt:3206`                              | `f6fed5347c68ab2a3b79e4864dc5d72490c9cabe46a16e865932d2e5a37716d9` |

The installed vanilla inventory contained 71 event files with MTTH, 101 with `ai_chance`, 86 decision files with `ai_will_do`, 76 national-focus files, 13 technology files, 19 doctrine files, 38 event files with `random_list`, and 9 AI strategy files with `research_weight_factor`. These counts were used to select examples and to test discovery breadth; they are not runtime assumptions.

## Unsupported constructs

When a game root is configured, adapter execution verifies `launcher-settings.json` against the supported raw version and checksum and fails closed on a missing, unreadable, or different build. Without a configured game root, results identify the adapter target without claiming that an installed build was verified.

The analyzer reports, but does not guess or execute:

- arbitrary effects used to calculate later weights;
- unprovided scopes, event targets, game rules, DLC state, dynamic identifiers, meta effects, or scripted-localisation results;
- parameterized scripted triggers whose arguments cannot be resolved from the selected source;
- recursive MTTH variables or helper cycles;
- incomplete focus, technology, doctrine, event-option, or random-list candidate pools;
- categorical or discrete correlation requests; numeric ranges and numeric distributions are supported by the correlation sampler;
- invalid or non-positive-semidefinite correlation matrices;
- full strategic AI planning, research-slot scheduling, event-effect execution, or campaign simulation.

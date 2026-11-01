# Chaos Redux reference retrieval

Measured on 2026-09-26 against the local Chaos Redux `paradox_wiki/` snapshot and the installed Hearts of Iron IV documentation. The fixture script requested context bundles for six work surfaces, then searched and read the installed `save_event_target_as` effect documentation. These are local-source measurements, not a claim about response accuracy for every future task.

| Surface    | Citations | Missing required sources | Context JSON bytes | Elapsed milliseconds |
| ---------- | --------: | -----------------------: | -----------------: | -------------------: |
| Event      |        10 |                        0 |              5,536 |                  218 |
| Decision   |         7 |                        0 |              3,988 |                  115 |
| Focus      |         8 |                        0 |              4,537 |                  128 |
| Technology |         6 |                        0 |              3,525 |                  137 |
| GUI        |         6 |                        0 |              3,678 |                  109 |
| Map        |         7 |                        0 |              4,224 |                  113 |

The eleven full core wiki files alone total 1,167,186 bytes in this snapshot. The task-specific context responses above used 3,525–5,536 bytes, approximately 99.5–99.7% fewer bytes than loading those eleven whole pages. This measures retrieved bytes, not tokenizer-specific tokens or complete knowledge of every page. Follow-up section reads add context as needed. Each bundle selected the relevant wiki topics and installed documentation for its work surface; no selected source was missing in these six runs.

The `save_event_target_as` search returned the installed `effects_documentation.md` section at line 6,496 first. A 12-line read returned the command name and supported scopes from that file. The exact source revision and path were returned with the citation. The server did not invoke the game or access the wiki website.

## Natural-language discovery

Nine queries were chosen before ranking changes to cover focus OR prerequisites, technology icon sizing, event-target scope documentation, mission timeouts, scripted GUI click effects, dated state history, localisation BOM, AI focus weights, and event option weights. Each query has a manually checked answer-bearing file and section in the local sources. The original exact-phrase ranking found the expected page in the top five for 2 of 9 queries. Term-aware ranking found the expected page and section in the top five for all 9. Five answer-bearing sections ranked first; all nine ranked fourth or better. This is a small task-specific retrieval set, not a general precision guarantee.

The nine ranked result sets occupied 2,776–4,216 JSON bytes each. The dedicated run took 126–234 milliseconds per query, including source hash checks; earlier concurrent runs took up to about three seconds. `scripts/evaluate-reference.ts` reruns the page, section, context coverage, response-size, and latency checks against a supplied mod and game root. It exits with a failure when an expected answer-bearing section or required context source is missing.

Revision-bound section IDs stayed stable across unrelated retrieval calls in the fixture test, and a fresh reference-service instance reopened the same cited text without the previous cache. A changed source invalidated the old revision. This supports returning to an exact citation without keeping full pages in conversation context. It does not measure a model's memory or guarantee that every future question can be answered from one retrieved section.

The retrieval benchmark used the local service directly. A separate real-workspace stdio run identified the built server as 3.5.0 and completed documentation context in 306 ms, a cited section read in 162 ms, and a first exact source lookup in 58,851 ms. That lookup builds the broader game/mod symbol inventory; it should not be confused with the much narrower documentation lookup. MCP transport fixtures cover both protocol adapters, workspace authorization, read-scope denial, and source usage discovery. Individual task adequacy and actual engine behavior remain separate checks.

The four additional public tool definitions add approximately 6.5 KB to the one-time MCP tool discovery response. The complete list is about 72 KB in the discovery fixture and is tested against a 72 KiB ceiling. The context reduction above applies to reference retrieval after discovery.

## Held-out discovery questions

Measured on 2026-10-04 against the same local Chaos Redux wiki snapshot and installed documentation.
The nine questions above were assembled alongside the previous ranking, so they cannot show whether a ranking change generalizes.
Two further sets in `scripts/reference-discovery-cases.ts` phrase tasks the way an agent asks them, mostly without the script name.
Every expected answer was checked by hand in the local files, and a case may list several acceptable sections.
A result answers a question when its cited section contains an expected answer line; it lands when its cited line is within eight lines of that answer.

The discovery set has 32 plain-word questions, five exact identifiers, and two unrelated negative queries.
The validation set has 24 plain-word questions written before any ranking adjustment and was never used to tune it.

| Set and ranking                | Answer first | Within three | Within five | Lands within three | Mean reciprocal rank |
| ------------------------------ | -----------: | -----------: | ----------: | -----------------: | -------------------: |
| Discovery, previous ranking    |         7/37 |        19/37 |       22/37 |              18/37 |                0.342 |
| Discovery, field-weighted BM25 |        19/37 |        28/37 |       29/37 |              26/37 |                0.628 |
| Validation, previous ranking   |         4/24 |         7/24 |       12/24 |               7/24 |                0.272 |
| Validation, field-weighted     |        11/24 |        16/24 |       20/24 |              16/24 |                0.588 |

The previous ranking placed four of the five exact identifiers first and did not return the `on_startup` wiki entry at all; the current one places each first, with installed documentation ahead of the wiki.
Both returned no results for the two negative queries.
On the original nine questions, all nine stay within five results, three rank first rather than five, and one moves from fourth to fifth.

In three repeated runs, the first query after a source change took 370–386 ms to index about twelve thousand sections, compared with 147–159 ms with the previous ranking.
Later queries took a median of 37 ms, compared with 49–63 ms, and the median ranked reply was about 3.7 KB in both.

Twelve plain-word questions across both sets still miss the top five.
Most use vocabulary the documentation does not: "national spirit" where script says `ideas`, "give a state" for `transfer_state`, "repeat effects" for `for_loop_effect`, and "build a factory" for `add_building_construction`.
Search the script name when it is known; the ranking does not add synonyms for individual questions.
These are 61 task questions over one documentation snapshot, not a general precision guarantee.

Run the sets with:

```bash
npx tsx scripts/evaluate-reference-discovery.ts MOD_ROOT GAME_ROOT
npx tsx scripts/evaluate-reference-discovery.ts MOD_ROOT GAME_ROOT --validation
npx tsx scripts/evaluate-reference-discovery.ts MOD_ROOT GAME_ROOT --held-out
```

The script exits with a failure when a case has no expected answer in the supplied sources.

## Refreshed wiki snapshot and a player vocabulary trial

Measured on 2026-11-01 against the Chaos Redux wiki snapshot refreshed on 2026-10-31 (54 wiki pages and 10 kit pages, 11,340 sections) and the installed 1.19.3.0 documentation (50 files, 3,281 sections).
The refresh renamed pages to snake case (`event_modding.md`), and the benchmark still expected `Event modding - Hearts of Iron 4 Wiki.md`, so it scored every wiki answer as a miss: 10 of 37 discovery answers first and seven cases reported as unanswerable.
The cases now accept both names.

A third set, `--held-out`, has 24 new questions written by a separate agent that was not told about the change below.
The validation set was no longer a clean check: two of its misses, "remove a national spirit" and "repeat effects", had been named in ADR 0040 as the motivating examples.

The trial expanded a plain-word query with the script word the documentation uses, at 0.6 of a query word's weight and never more informative than the player words it replaces.
`scripts/derive-reference-vocabulary.ts` mined the vocabulary from the game's English localisation, where `EFFECT_`, `TRIGGER_` and `MODIFIER_` keys name script and their text is what the player reads: 128 tooltip phrases of two or three words for documented commands ("at war" for `has_war`, "moves capital to" for `set_capital`) and 11 of 25 mined word pairs that name the same thing (conference for `pc`, technology for `tech`, freedom for `autonomy`).
The other 14 pairs only appear together ("male" and "female").
Five hand-checked entries covered what the localisation names only indirectly: national spirit to idea, temporary and expire to timed, repeat to loop, and skip to bypass ("at war" was listed by hand as well).
The entries and the weight were chosen on the discovery set alone: a hand entry from build to construction moved one discovery answer from first to second and was dropped, and weights of 0.4, 0.8 and 1.0 each placed 21 rather than 22 discovery answers first.
The held-out baseline was measured before the entries were final, but no entry was chosen from it; validation and held-out were each scored once with the final entries.

| Set and ranking                    | Answer first | Within three | Within five | Lands within three | Mean reciprocal rank |
| ---------------------------------- | -----------: | -----------: | ----------: | -----------------: | -------------------: |
| Discovery, current ranking         |        19/37 |        27/37 |       28/37 |              25/37 |                0.595 |
| Discovery, with vocabulary (tuned) |        22/37 |        29/37 |       30/37 |              26/37 |                0.668 |
| Validation, current ranking        |        11/24 |        15/24 |       18/24 |              15/24 |                0.559 |
| Validation, with vocabulary        |        11/24 |        15/24 |       18/24 |              15/24 |                0.552 |
| Held-out, current ranking          |         7/24 |        12/24 |       15/24 |               9/24 |                0.402 |
| Held-out, with vocabulary          |         8/24 |        12/24 |       16/24 |               9/24 |                0.440 |

Both rankings placed all five exact identifiers first and returned nothing for the two negative queries.
The October discovery figures (19, 28 and 29 of 37) were measured on the previous snapshot and game documentation, so they are not a direct comparison.

The vocabulary lifted the set it was tuned on but not the questions it had never seen.
On validation, "is controlled by the AI" fell from second to third because "controlled by" also names `is_controlled_by`; on the held-out set "has researched" and "technology" found `has_tech`, "national spirit" moved `has_idea` no closer, and "does not own" pushed a claim question from third to fourth.
Across the 48 held-out and validation questions that is one more answer first and one more within five.
The trial was reverted and ADR 0040's rule against added synonyms stands; commit `ab56af1` reproduces it.

Two causes of the remaining misses are not vocabulary:

- The refreshed wiki documents some commands on more pages than the hand-checked answers name. `scopes.md` has a `for_loop_effect` row, `data_structures.md` a `check_variable` row, and `event_modding.md` a `news_event` row. The strict answers do not count them, before or after.
- When several sources have the same heading, later copies wait behind every distinct answer. For "remove a national spirit from a country" the console command `remove_ideas` ranks second, so the effect documentation and wiki copies of `remove_ideas` fall out of the first five.

## Game text, question intent and a blind test set

Measured on 2026-11-01 on the same sources (ADR 0076).
Two changes were developed on the discovery, validation and held-out sets together (85 plain-word questions): each command entry also carries the words of its in-game tooltip or modifier name from the game's English localisation, and a question that starts with a check or an action verb prefers triggers or effects over other commands, on actions and dynamic variables.
A fourth set, `--test`, was then written by a second agent that saw none of the other sets' results: 36 plain-word questions, four exact names and two negative queries. It was scored once, before and after.

| Set                       | Answer first | Within three | Within five | Lands within three | Mean reciprocal rank |
| ------------------------- | -----------: | -----------: | ----------: | -----------------: | -------------------: |
| Development, before       |        37/85 |        54/85 |       61/85 |              49/85 |                0.530 |
| Development, after        |        40/85 |        58/85 |       63/85 |              53/85 |                0.570 |
| Discovery, after          |        20/37 |        27/37 |       28/37 |              25/37 |                0.623 |
| Validation, after         |        14/24 |        17/24 |       19/24 |              17/24 |                0.660 |
| Held-out, after           |         6/24 |        14/24 |       16/24 |              11/24 |                0.401 |
| Blind test, before (once) |        16/40 |        25/40 |       31/40 |              22/40 |                0.547 |
| Blind test, after (once)  |        20/40 |        28/40 |       31/40 |              25/40 |                0.606 |

All exact names stayed first in every set.
One blind negative query ("how to fix my graphics card driver crashing in a shooter") returned one result before and after; the other negatives returned none.
Within the development sets the held-out set lost one first place (7 to 6) while the other two gained four.
On the blind set, four questions moved to first ("some command power", "the ruling party and elections", "at war with anyone", "a decision is currently active") and "extra manpower" entered the first five, while "make all buildings construct faster" fell out of the first five because the action intent lowers modifier rows, and "use less supply" fell from second to third.

On the development sets, the question intent alone placed three more answers first (40 of 85, with 61 within five). The in-game words alone placed one fewer first and one more within five, and on top of the intent they placed two more within five and none more first; they are kept for the questions they lift into reach of a first read.
Weights of 0.4 and 0.8 for the intent penalty scored within one question of 0.6.
Pooling the full text of every copy of a command into each entry placed fewer answers first (34 of 85) and was dropped. So was a rule that kept console-command copies from demoting the script entry with the same name, which changed nothing.
Following links between wiki pages was not tried: cross-page links mostly point at whole pages, and their text repeats the target heading ("Flags" for `data_structures.md#Flags`), so they add no words a section does not already have.

Half of the blind questions still miss first place, and nine miss the first five.
The remaining misses mostly need meaning rather than shared words: "access to the sea" for `is_coastal`, "share a border" for `is_neighbor_of`, "research faster" for `research_speed_factor`, "free a puppet" for `end_puppet`.

The maintainer updated the game to 1.19.4.1 the same day; its documentation adds the `stockpile_fuel` AI strategy, changes a token list and removes one console command.
Every expected answer in all four sets is still present. Rescored on 1.19.4.1, before and after:

| Set (1.19.4.1)     | Answer first | Within three | Within five | Lands within three | Mean reciprocal rank |
| ------------------ | -----------: | -----------: | ----------: | -----------------: | -------------------: |
| Discovery, before  |        19/37 |        27/37 |       28/37 |              25/37 |                0.595 |
| Discovery, after   |        20/37 |        27/37 |       28/37 |              25/37 |                0.623 |
| Validation, before |        11/24 |        15/24 |       18/24 |              15/24 |                0.559 |
| Validation, after  |        14/24 |        17/24 |       19/24 |              17/24 |                0.660 |
| Held-out, before   |         7/24 |        12/24 |       15/24 |               9/24 |                0.402 |
| Held-out, after    |         6/24 |        14/24 |       16/24 |              11/24 |                0.401 |
| Blind test, before |        16/40 |        25/40 |       31/40 |              22/40 |                0.547 |
| Blind test, after  |        21/40 |        27/40 |       31/40 |              24/40 |                0.613 |

The maintainer's target is the right answer first for at least 22 of 24 blind questions and within three for all of them. This ranking places about half first and two thirds within three, so the gap remains large.

### Optional meaning layer trial

With the maintainer's approval, a local sentence-embedding layer was tried on top of the word ranking (commit `bb3c019`, reverted in `b5c1a46`).
It ran only when `HOI4_REFERENCE_EMBEDDINGS` named a cache folder and `@huggingface/transformers` 4.3.1 was installed, fetched the pinned `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9` (the 22,972,370-byte quantized ONNX model and three tokenizer and config files, each checked against its pinned SHA-256), and embedded each section's page, heading and opening lines once into a 14 MB vector cache.
Meaning ranks were fused with word ranks by reciprocal rank (meaning weight 0.25, k = 10, cosine floor 0.35); exact names stayed with word ranking, and each result said which ranking ordered it.
Weights of 0.25 and 0.5 with k of 10 and 30, and embedding cleaned plain text instead of the Markdown excerpt, were compared on the development sets only.

| Set                                  | Answer first | Within three | Within five | Lands within three | Mean reciprocal rank |
| ------------------------------------ | -----------: | -----------: | ----------: | -----------------: | -------------------: |
| Development, words                   |        40/85 |        58/85 |       63/85 |              53/85 |                0.570 |
| Development, words and meaning       |        45/85 |        59/85 |       63/85 |              54/85 |                0.609 |
| Blind test, words (once)             |        20/40 |        28/40 |       31/40 |              25/40 |                0.606 |
| Blind test, words and meaning (once) |        20/40 |        26/40 |       32/40 |              23/40 |                0.602 |

The gain on the development sets did not carry over to the blind set: the same number of first answers, two fewer within three, and the nonsense query "how to fix my graphics card driver crashing in a shooter" returned five troubleshooting sections rather than one. Exact names stayed first.
Installing the runtime adds about 470 MB (`onnxruntime-node` 288 MB, `onnxruntime-web` 141 MB, `sharp` and its images 29 MB, the library 14 MB), the model download is 23 MB, loading the model took 2.1 seconds, embedding all 14,621 sections took about 53 seconds once, and a query embedding took about 25 milliseconds.
The layer did not clearly win, so it was reverted, and the default install and ranking carry no model.
A stronger model or embedding the game's own text per command may do better, but would need a new blind set, because this one has now been used for both comparisons.

### Speed

Before the change, every search reopened, reread and hashed all 114 documentation files. On a lightly loaded machine that inventory took a median of 70 ms of a 94 ms warm search, and with the file stamps reused it took 36 ms of 50 ms.
A warm read took 13 ms rather than 25–84 ms.
Later end-to-end runs shared the machine with other heavy work: three alternating rounds of the old and new code measured warm search medians of 145–183 ms and 84–583 ms, so no end-to-end speed gain is claimed from them.
The first `hoi4.source_lookup` still builds the whole game and mod symbol index: 53–66 seconds in three runs before this change on a lightly loaded machine, 108–192 seconds under the later load. This change does not touch it, and moving that index to the shared Rust engine is planned separately.

## Compact context budgets

A 2026-09-27 check of the installed 3.5.0 server found that eight GUI results could contain only wiki sections even though the installed GUI documentation was available. The 3.5.1 source qualifies limits of one, two, and eight citations across the same six work surfaces. All eighteen cases retained installed documentation; limits of two or more also retained wiki citations. Required sources excluded by the limit appeared in `omittedSources`, separately from files absent under `missing`. The nine search queries still found all expected answer-bearing sections.

For the GUI question “Where are scripted GUI click effects and triggers defined?”, the measured results were:

| Citation limit | Returned source kinds            | Required sources omitted | JSON bytes | Milliseconds |
| -------------- | -------------------------------- | -----------------------: | ---------: | -----------: |
| 1              | Installed documentation          |                        5 |        877 |          348 |
| 2              | Installed documentation and wiki |                        4 |      1,480 |          396 |
| 8              | Installed documentation and wiki |                        0 |      5,926 |          339 |

The default six-surface context bundles used 3,545–5,556 bytes including omission metadata. A smaller response is not sufficient evidence when `omittedSources` is nonempty: increase the limit or search and read those sources directly. The evaluation script fails when a compact budget drops a required source kind or silently omits its required-source pointers.

## Source navigation and scan measurements

On 2026-10-03, `scripts/evaluate-source-tools.ts --game-only` selected the installed `political.1` definition, listed its options, read exactly `add_political_power = -100` from its first option, and checked that command against installed documentation.
The country-scope check succeeded and the state-scope check reported the documented mismatch.
The evaluation retained source and documentation revisions and compared repeated reference results for equality.

| Operation                      | Initial cache-enabled run | Scoped-cache run | Reply bytes |
| ------------------------------ | ------------------------: | ---------------: | ----------: |
| Cold event structure           |                 55,550 ms |        24,723 ms |       2,258 |
| Repeated nested read           |                 20,936 ms |         3,565 ms |         862 |
| Installed command check        |                  1,471 ms |        10,804 ms |       1,152 |
| Event-consumer lookup          |   Timed out at 180,002 ms |       145,532 ms |       1,363 |
| Repeated event-consumer lookup | Not completed in that run |        16,233 ms |       1,363 |

A separate run with persistent caching disabled completed the broader lookup in 102,437 ms and its repeated lookup in 122,023 ms.
This helped identify filesystem and cache costs; it is not a causal comparison under identical machine load.
The candidate bounds optional cache writes, skips resident hydration, overlaps source verification, and scopes event queries to the analyser's supported owner sources.
Its persistent cache recorded 32 writes across two bounded batches, with no invalid entries or evictions.
The process recorded 616–625 MiB resident memory during the consumer lookups; these are sampled values, not peak-memory guarantees.

Other work was running on the host, and latency varied materially.
The command-document check was slower in the scoped-cache run, so these measurements must not be presented as an improvement for every operation or as a latency guarantee.
The selected source index was complete, while reference completeness remained false because 2,379 dynamic references were unresolved.
Static retrieval does not resolve those engine-dependent dispatches or establish runtime behavior.

These source timings preceded the subsequent batched reference reader and glob-library replacement.
A separate 2026-10-03 reference evaluation found all nine expected pages and answer-bearing sections and passed all eighteen compact-context cases, with no missing required sources or budget failures.
Its six context replies used 3,616–5,627 JSON bytes.
The candidate's complete MCP discovery list contains 35 tools and is tested against a 75 KiB ceiling.

## Worker startup

Five isolated readiness handshakes on 2026-10-03 averaged 2,163 ms with eager imports and 1,408 ms with authenticated domain loading.
The individual samples were 2,056/2,570/2,349/1,857/1,985 ms and 3,213/930/995/960/942 ms respectively.
The first changed-worker sample includes a cold TypeScript loader cache.
These samples measure the readiness handshake without running a job, and do not establish complete request latency or throughput.
Concurrent HTTP qualification keeps its original four-minute total request ceiling.
Two earlier 64-request runs exceeded that ceiling for 23 and five requests respectively.
The isolated run after domain loading passed all 64 requests in a 124.49-second test, including fixture setup and cleanup.
Shared-host load varied between runs, so these are qualification receipts rather than a controlled throughput comparison.

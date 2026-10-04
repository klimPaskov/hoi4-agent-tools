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

Run both sets with:

```bash
npx tsx scripts/evaluate-reference-discovery.ts MOD_ROOT GAME_ROOT
npx tsx scripts/evaluate-reference-discovery.ts MOD_ROOT GAME_ROOT --validation
```

The script exits with a failure when a case has no expected answer in the supplied sources.

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

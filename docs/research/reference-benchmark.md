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

## Compact context budgets

A 2026-09-27 check of the installed 3.5.0 server found that eight GUI results could contain only wiki sections even though the installed GUI documentation was available. The 3.5.1 source qualifies limits of one, two, and eight citations across the same six work surfaces. All eighteen cases retained installed documentation; limits of two or more also retained wiki citations. Required sources excluded by the limit appeared in `omittedSources`, separately from files absent under `missing`. The nine search queries still found all expected answer-bearing sections.

For the GUI question “Where are scripted GUI click effects and triggers defined?”, the measured results were:

| Citation limit | Returned source kinds            | Required sources omitted | JSON bytes | Milliseconds |
| -------------- | -------------------------------- | -----------------------: | ---------: | -----------: |
| 1              | Installed documentation          |                        5 |        877 |          348 |
| 2              | Installed documentation and wiki |                        4 |      1,480 |          396 |
| 8              | Installed documentation and wiki |                        0 |      5,926 |          339 |

The default six-surface context bundles used 3,545–5,556 bytes including omission metadata. A smaller response is not sufficient evidence when `omittedSources` is nonempty: increase the limit or search and read those sources directly. The evaluation script fails when a compact budget drops a required source kind or silently omits its required-source pointers.

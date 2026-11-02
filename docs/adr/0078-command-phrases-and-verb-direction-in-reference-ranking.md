# ADR 0078: Command phrasings and verb direction in reference ranking

Status: accepted

## Context

After ADR 0076 the reference search placed the right answer first for 21 of 40 blind test questions on HOI4 1.19.4.1. The maintainer's target is nearly every blind question first and all within three.
Most remaining misses need the meaning of a command, not a shared word. A modder asks for "share a border" and the documentation of `is_neighbor_of` says "check if neighbor ( controlled territory ) with specified country". A modder asks to "free a puppet" and `end_puppet` says "Stops specefied country being a puppet of current country".
ADR 0040 rules out synonyms written for individual questions. A vocabulary mined from localisation (ADR 0040 amendment) and a local embedding model (ADR 0076) both lifted the questions they were developed on, but not the blind set.

The maintainer asked for a new round on 2026-11-02 (decision P-1 in HOI4 Factory). Every change is developed on the discovery, validation and held-out sets (85 questions), measured on the same blind set, and kept only if it improves it.

## Decision

### Plain-word phrasings per command

`src/hoi4_agent_tools/reference/command-phrases.json` holds four short plain-word phrasings for each of the 1,848 effects, triggers and modifiers in the installed 1.19.4.1 documentation, for example "state on the coast" and "coastal state check" for `is_coastal`.
They were written once, in eight batches by Claude Haiku agents, from each command's documentation entry and in-game tooltip text, and from nothing else.
The agents saw no benchmark question, no search result and no ranking code. Their instruction gave no example concepts: describe what the command does, checks or grants in everyday words, vary the wording, and stay faithful to the documentation. `scripts/prepare-command-phrases.ts` writes the agents' input.
A first run whose instruction included example synonyms drawn from known misses was stopped and discarded, because those examples named concepts of benchmark questions.

The phrasings join the in-game text field of every entry with that command heading. Each word counts four times a game-text word, capped like the game text at three occurrences, so it weighs twice body text. They do not change document frequencies.
This is document expansion, written per command from the command's own text. It is not a synonym list for questions, so ADR 0040's rule still holds.
A command the file does not name, such as one a later game version adds, keeps only its documentation and game text. Wiki rows with the same command heading gain the same words.

### Verb direction

Command names open with a verb from a small closed set. When a question's first content word grants something ("add", "give", "grant", "create", "gain", "unlock", "start"), an `add_`, `give_`, `create_`, `unlock_`, `activate_`, `start_` or `spawn_` command counts its verb as named for the heading-coverage bonus. A `remove_`, `clear_`, `clr_`, `delete_`, `destroy_`, `cancel_`, `end_`, `deactivate_`, `retire_`, `kill_` or `subtract_` command keeps 60% of its score.
The same applies the other way round for a question that removes ("remove", "delete", "clear", "cancel", "end", "stop", "lose", "free", "revoke").

## Consequences

| Set                        | Answer first | Within three | Within five | Lands within three | Mean reciprocal rank |
| -------------------------- | -----------: | -----------: | ----------: | -----------------: | -------------------: |
| Development (85), before   |        40/85 |        58/85 |       63/85 |              54/85 |                0.572 |
| Development, after         |        53/85 |        64/85 |       72/85 |              61/85 |                0.702 |
| Blind test (40), before    |        21/40 |        27/40 |       31/40 |              24/40 |                0.611 |
| Blind test, verb direction |        22/40 |        27/40 |       31/40 |              24/40 |                0.628 |
| Blind test, after          |        25/40 |        31/40 |       32/40 |              27/40 |                0.694 |
| Fresh blind (38), before   |         9/38 |        12/38 |       16/38 |               9/38 |                0.294 |
| Fresh blind, after (once)  |        17/38 |        23/38 |       26/38 |              20/38 |                0.526 |

The fresh blind set was written for this round by an agent that saw no ranking code and no results, and was scored once, after every choice was final.
The verb rule alone changed nothing on it. The phrasings nearly doubled the answers ranked first.
Exact names stay first on every set, except `set_country_flag` on the fresh set, where the console command of the same name ranks first. That ordering is unchanged from before.
One fresh nonsense query, "how to fix a flat bicycle tire", now returns five results rather than two, because "flat" names the `special_forces_cap_flat` modifier. The other negatives return what they did before.
Some prose questions fell because command entries now score higher. On the development sets, "make two national focuses that cannot both be taken" left the first five, and "remember a scope to use later in another event" fell from first to fourth.

The target is still not met. Blind answers first are 25 of 40, and the fresh set is harder (17 of 38).
The phrase file adds 338 KB to the package and about 7,400 phrase entries to the ranking index. No warm-search slowdown was measurable on a heavily shared machine (median 59 ms, against 64 ms for the previous code in the same round).
A later game version can add commands without phrasings. Regenerate the file when the documented command set changes noticeably, with the same instruction and a check against a new blind set.

Measured and not kept: four word-level changes improved the development sets but left the blind set unchanged, so they were dropped. These were abbreviations in command names (`tech`, `temp`, `mio`), British and American spellings, a bonus for the page whose title is the question's topic, and singular localisation keys for plural commands (`EFFECT_REMOVE_IDEA` for `remove_ideas`).
Two cross-encoder rerankers (`Xenova/ms-marco-MiniLM-L-6-v2` and `Xenova/bge-reranker-base`) reordered the first twelve word results. On their own they ranked fewer answers first on the development sets (34 and 31 of 85, against 43). Fused with the word ranking they added up to 3, at 0.4 and 1.6 seconds per query, so neither was pursued.
See `docs/research/reference-benchmark.md` for the method and per-question changes.

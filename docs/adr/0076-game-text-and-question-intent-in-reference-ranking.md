# ADR 0076: Game text and question intent in reference ranking

Status: accepted

## Context

Modders ask for a command in the words the game shows them, while the installed documentation describes it in a few terse words: `is_coastal` is "check if state is coastal", and `supply_consumption_factor` has no description at all.
On 2026-11-01 the field-weighted ranking of ADR 0040 placed the right answer first for 37 of 85 development questions and 16 of 40 blind test questions.
Many misses were not vocabulary at all. A question that asks to do something ("increase the stability of a country") got a trigger or a read-only dynamic variable first, and an action question got the on action that fires afterwards ("declare war" found `on_declare_war`).
Every search also reread and hashed all 114 documentation files to check their revisions, about 70 ms of a warm query.

A trial of added player vocabulary, mined from localisation and a short hand list, lifted the questions it was tuned on but not held-out questions, and was reverted (amendment to ADR 0040).

## Decision

The game's English localisation names each command's tooltip after it (`TRIGGER_IS_COASTAL`, `TRIGGER_HAS_IDEA_COUNTRY` reads "Has national spirit") and each modifier after its key (`MODIFIER_SUPPLY_CONSUMPTION_FACTOR` reads "Supply Consumption").
The service reads `effects_l_english.yml`, `triggers_l_english.yml` and `modifiers_l_english.yml` from the workspace's game root, strips formatting and placeholders, and assigns each key to the longest documented command it names or extends.
Those words form a separate field of every entry with that command heading, weighted half of body text and capped at three occurrences per word, and they do not change term frequencies across the inventory.
Console commands, defines and link indexes receive none. The localisation revision is part of the ranking index key.
These are the game's own words for each command, not synonyms written for individual questions, so ADR 0040's rule still holds.

A command entry has a role: a trigger or effect by its page, an on action by its `on_` name, a dynamic variable, or another kind.
A question whose first content word is a check ("check", "whether", "is", "has") asks for a trigger, and one that starts with an action verb ("add", "give", "make", "increase", "declare") asks for an effect.
An entry of another role keeps 60% of its score. On actions keep 60% unless the question names a time ("when", "after", "once"), which also cancels the action intent, and dynamic variables keep 60% unless it names a variable.
Prose sections are unaffected.

A file whose size, modification and change times, inode and device match the copy that was hashed keeps its revision and sections without being reread; its path is still verified on every request.

## Consequences

On the 85 development questions, 40 rather than 37 rank first and 63 rather than 61 within five, with mean reciprocal rank 0.570 rather than 0.530.
Scored once on 40 blind test questions, 20 rather than 16 rank first, 28 rather than 25 within three, and 31 within five as before. Mean reciprocal rank rose from 0.547 to 0.606, and all exact names stay first.
Two test questions fell: "make all buildings construct faster" no longer finds the modifier within five, because the action intent lowers modifier rows, and "make my army use less supply" fell from second to third.
Half of the test questions still miss first place. Most remaining misses need meaning rather than shared words ("access to the sea" for `is_coastal`, "share a border" for `is_neighbor_of`).
An optional local embedding layer (pinned `Xenova/all-MiniLM-L6-v2`, fused by reciprocal rank) placed 45 rather than 40 development answers first but, scored once on the blind set, the same 20 of 40, two fewer within three, and five results for a nonsense query; with about 470 MB of runtime it was reverted.
Reusing file stamps cut the inventory part of a warm search from about 70 ms to 36 ms on a lightly loaded machine; end-to-end runs under heavy shared load were inconclusive.
Rescored on HOI4 1.19.4.1, the blind set places 21 rather than 16 of 40 first; the maintainer's target of nearly every blind question first is not met.
A file rewritten with the same size inside one timestamp tick keeps its previous revision until its times change; the documentation roots are read-only inputs, so this is accepted.
See `docs/research/reference-benchmark.md` for methods and per-question changes.

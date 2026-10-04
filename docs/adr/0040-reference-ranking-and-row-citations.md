# ADR 0040: Reference ranking and row citations

Status: accepted

## Context

Agents ask documentation questions in plain words: "check if a state is controlled by a country" rather than `is_controlled_by`.
The term-match ranking from ADR 0036 added fixed points for each query word found in a title, heading, or body, with no account of how common a word is or how long a section is.
On 37 held-out Chaos Redux questions it returned an answer-bearing section first for 7 and within five for 22.
A common word such as "state" or "country" counted as much as a rare one, so broad pages and link indexes often outranked the entry that answered the question.

The offline wiki documents most effects, triggers, modifiers, defines, and on actions as Markdown table rows inside sections of several hundred to several thousand lines.
A citation to such a section starts at its heading, and a read is limited to 80 lines, so the answering row could need many continuation reads.
The section splitter also toggled on any line that began with a fence marker, so a code block closed by a different fence could expose example comments as headings.

## Decision

Rank sections with a field-weighted BM25 model built from the indexed sections themselves.
Headings weigh four times body text and page titles half as much, rare terms weigh more than common ones, and long sections are length-normalized.
Clausewitz identifiers are indexed whole and by their underscore-separated words, and a conservative suffix folder joins inflected and derived forms.
A section whose every heading word the question names receives additional credit.
A query that names an identifier only matches sections containing that identifier.
An exact heading match outranks any partial match, and installed game documentation precedes the wiki when scores are equal.
Phrase adjacency reorders the leading sixty candidates, which keeps the costlier line scan bounded.

Two documented naming conventions connect plain words to script names: adjacent words may form one identifier word (`war goal` and `wargoal`), and counting words reach `num_` names at reduced weight.
Link indexes are demoted, and console commands and engine defines rank lower unless the question asks for them.
When several sources document the same heading, the first copy keeps its rank and later copies follow the distinct answers, except for an exact identifier query.
These rules are general; question-specific synonyms are not added.

A Markdown table row whose first cell is an identifier becomes an additional one-line section with that identifier as its heading.
Heading sections keep their order, so the first section of a page still names the page for context bundles.
A row ranked above its containing section replaces that section in the results.
Search and context results carry `matchLine`, the cited line that best matches the query, so a read can start there.
Fences follow CommonMark: a closing fence repeats the opening character at least as often and has no info string.

Statistics are computed per inventory and reused while the set of source revisions is unchanged.
Section identifiers keep their source, path, start line, and heading derivation, so existing citations still reopen.
`matchLine` is an additive optional output field.

## Consequences

On the 37 held-out questions, the answer-bearing section ranks first for 19 and within five for 29; mean reciprocal rank rose from 0.342 to 0.628.
On 24 validation questions written before any tuning, it ranks first for 11 and within five for 20; mean reciprocal rank rose from 0.272 to 0.588.
On the original nine-question set, which was assembled with the previous ranking, all nine remain within five, three rank first rather than five, and one moves to fifth.
In three repeated runs on the same machine, the first query after a source change took 370–386 milliseconds to index about twelve thousand sections, compared with 147–159 before; later queries took a median of 37 milliseconds, compared with 49–63, because term statistics are reused rather than rescanning each section body.
Vocabulary that the documentation never uses still misses, such as "national spirit" for `remove_ideas`, "give a state" for `transfer_state`, and "repeat effects" for `for_loop_effect`.
`scripts/evaluate-reference-discovery.ts` reruns both question sets against a supplied mod and game root; see `docs/research/reference-benchmark.md`.

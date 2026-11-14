# ADR 0085: What a result's completeness says

Status: accepted (technical default, decision D-18, recorded on issue 66)

## Context

Issue 66 found that nearly every large-workspace result came back `PARTIAL`, so an agent could not tell a real gap from a skipped whole-workspace pass. `hoi4.event_inspect` with `mode: "trace"` for one vanilla event returned `EVENT_INSPECTED_PARTIAL` with a complete 7-node trace, because the focused analysis defers the helper and lifecycle passes over the whole workspace and the code looked only at the whole-workspace flag. Two integration tests pinned that on a one-event fixture.

## Decision

A result describes whether the answer to the question that was asked is complete.

- **Complete.** The answer stands on its own. The code has no suffix (`EVENT_INSPECTED`). A narrower scope than the whole workspace does not make an answer incomplete, and it is named in its own field (`analysisMode: "focused"` for event results), not in the code.
- **Partial.** Something the answer needs is missing: a source was skipped, a limit cut the answer short, a node sits on the boundary, or an assumption could not be resolved. The code ends in `_PARTIAL`, and the result says what is missing (a diagnostic, `summary.trace.truncated` and `boundaryNodes`, the skipped sources).
- **Failed.** No usable answer. `status` is `error` with a blocker.

`status` stays `ok` or `error`. This adds no field and changes no schema, so it needs no version break: only the condition under which a code carries `_PARTIAL` changes.

## Applied so far

`hoi4.event_inspect`. A focused trace is complete when no source was skipped, nothing was truncated and no node is on its boundary. A focused path is complete when it was found without an unresolved assumption. A trace cut by `maxNodes` stays partial and says `truncated: true`. The other modes and the helper expansion keep their conditions.

## Not yet applied

The other tools tie `_PARTIAL` to a whole-workspace flag: `event_render` and `event_compare`, `tech_inspect`, `tech_render`, `tech_compare`, `gui_inspect`, `decision_inspect`, `impact_inspect`, the probability tools and `mod_index`. Each needs the same question asked of it: is the requested answer complete, and what is missing if not. They follow one at a time, each with a test that a focused complete answer is not partial and that a truncated one still is. `validation.passed` on the event tools still counts workspace-wide blocking diagnostics, so a clean trace in a workspace with unrelated blocking diagnostics reports `validation.passed: false`. Scoping that to the answer is the next change.

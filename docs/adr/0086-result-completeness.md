# ADR 0086: What a result's completeness says

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

On the event tools `validation.passed` for a focused trace or path counts only the blocking diagnostics located in the files of the events it covers. Those elsewhere in the workspace are counted apart, named in the check message and kept in the linked evidence, so a clean trace is not failed by an unrelated broken file. Every other event answer still counts the whole workspace.

A partial `event_inspect` result says what is missing, as inline information: `EVENT_TRACE_TRUNCATED` (a trace that stopped at its limits), `EVENT_SOURCES_SKIPPED` (with the count), `EVENT_HELPER_EXPANSION_INCOMPLETE`, or `EVENT_FOCUSED_ANALYSIS_DEFERRED` (a large workspace that defers the workspace-wide helper projections and state links, so callers and state links that exist only inside scripted effects may be missing). The `roots` and `state_flow` modes stay partial on a large workspace for that last reason, because their answers do depend on those passes.

## Not yet applied

The other tools tie `_PARTIAL` to a whole-workspace flag: `event_render` and `event_compare`, `tech_inspect`, `tech_render`, `tech_compare`, `gui_inspect`, `decision_inspect`, `impact_inspect`, the probability tools and `mod_index`. Each needs the same question asked of it: is the requested answer complete, and what is missing if not. They follow one at a time, each with a test that a focused complete answer is not partial and that a truncated one still is.

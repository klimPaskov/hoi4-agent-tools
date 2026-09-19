# Bounded helper expansion

`hoi4.event_inspect` and `hoi4.tech_inspect` accept `mode: "helper_expansion"`.
This is a read-only stream of source-linked helper paths, not a source rewrite or runtime simulation.
It avoids materializing the whole helper closure before returning its first page.

Start either tool with:

```json
{
  "mode": "helper_expansion",
  "helperExpansion": { "maxRecords": 250, "maxWork": 5000, "maxDepth": 64 }
}
```

If `data.helperExpansion.finished` is false, pass its opaque `continuationUri` to the same tool:

```json
{
  "mode": "helper_expansion",
  "helperExpansion": { "continuationUri": "<data.helperExpansion.continuationUri>" }
}
```

The server restores root selection and depth from the continuation.
Page size and work limit may change between calls; root selection and depth may not.
A continuation may be used by a fresh server process with the same configured workspace, authorized principal, tool version, and exact source revision.
Every resume re-enumerates and verifies source bytes, even if `refresh` is omitted.
Changed source, domain, root topology, principal, or query is rejected explicitly rather than merged into earlier evidence.
To analyze edited source or use a different depth, start a new request without the continuation.

## Bounds and evidence

`helperExpansion` has these optional fields:

| Field             | Contract                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rootIds`         | Up to 2,000 exact structural helper-call root IDs; omitted means all recognized non-helper callers. Obtain IDs from a page's `rootId` or the linked ordinary scan graph. |
| `maxDepth`        | 1–256 helper calls, default 64.                                                                                                                                          |
| `maxRecords`      | 1–5,000 records per page, default 250.                                                                                                                                   |
| `maxWork`         | 1–100,000 traversal transitions per page, default 5,000.                                                                                                                 |
| `continuationUri` | Opaque sibling resource returned in the prior tool result. Do not edit or construct it.                                                                                  |

Other inspection filters such as top-level `maxDepth`, `selector`, and `technologyId` are rejected in this mode rather than silently ignored.
The shared dependency inventory is limited to one million edges; source, parser, and artifact byte limits also remain enforced.
`maxWork` bounds dependency traversal, not the mandatory source scan or parsing.
An empty page can still advance work; continue when `finished` is false.

The linked JSON contains ordered `records` with `visit`, `terminal`, `cycle`, or `depth` kinds.
Each record links its root and exact edge-ID path to a page-local `edges` evidence table.
Event leaves include dispatches and helper-owned state accesses with their conditions, locations, and scope evidence.
Technology leaves include helper-owned grants, bonuses, and other technology references with source-linked call paths.
Different structural calls to the same helper remain distinct paths, including parallel calls under different conditions.
The technology call model links conditions through source locations; it does not evaluate or reconstruct runtime trigger outcomes.
Ordinary inspect modes remain the route for direct non-helper references and aggregate graph diagnostics.

`finished` means every selected root has been visited under the stated cycle and depth policy.
`complete` additionally requires complete source inventory and zero depth stops.
Cycles are reported and stopped at the repeated ancestor; completion describes finite simple-path coverage, not recursive execution.
Dynamic and missing source references remain unresolved findings, with exact counts and at most 100 samples in each page report.
Completion never establishes that those findings are resolved or that a runtime outcome is known.
The cumulative record, work, root, cycle, and depth counters describe the entire resumed traversal, while `records` and `work` in the tool summary describe the current page.

The page report and its continuation are published together through the shared atomic artifact store.
The continuation is also linked as a sibling artifact; its resource URI is in the compact tool result, not reconstructed from a filename.
Cursor storage retains the active ancestor stack rather than completed paths.
Artifacts follow configured retention and admission limits; an evicted or unavailable cursor fails explicitly and requires a fresh analysis.
This is not permanent storage of every historical page.

## Compatibility and boundaries

This opt-in mode and optional result summary are additive changes in the unreleased 3.1.0 candidate.
Existing inspection modes retain their own ordering, representative-path policy, and materialization limits.
A depth- or projection-truncated materialized graph reports incomplete coverage.
The paged edge-path stream must not be mistaken for the deduplicated projections in those graphs.
Ordinary calls and persisted jobs return the same page contract.
Within-page work is bounded; the existing durable result checkpoint handles interruption after a page result has been staged.
Broader materialized-graph memory refinement, modern negotiated MCP protocol migration, platform qualification, publication, and installation remain separate acceptance work.

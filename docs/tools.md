# Tool reference

Most users can ask their agent in ordinary language; the [examples guide](examples.md) is the best starting point.
This page lists exact tool names for agents and integrations.
Use the connected server's live schema for the fields accepted by each call.

The default server exposes 28 tools in nine areas.
The **Writes** column says what a call can change:

- **—** reads source and returns a result.
- **review files** writes images and reports to the server's own workspace storage, never to the mod.
- **mod files** changes mod source after validating the edit, with a recorded transaction that can be rolled back.

MCP clients see the review-file tools as not read-only, because they store artifacts, and may ask for approval before running them.
`hoi4.job_cancel` is marked destructive because it stops work in progress; it never edits source.

## References and source

| Tool                     | Purpose                                                                                                                                   | Writes |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `hoi4.reference_context` | Get compact, cited wiki and installed documentation pointers for a modding surface.                                                       | —      |
| `hoi4.reference_search`  | Search local documentation in plain words or script names; each result names its answering line.                                          | —      |
| `hoi4.reference_read`    | Read one revision-bound section: up to 80 lines (40 by default) and 8,000 bytes, with line continuation.                                  | —      |
| `hoi4.source_lookup`     | Find exact definitions, overrides and usages across game, DLC and mod, or the definition containing a file line.                          | —      |
| `hoi4.script_validate`   | Check a snippet or a whole mod file for syntax, command kinds, and scopes against local documentation.                                    | —      |
| `hoi4.error_log`         | Group the game's `error.log` from its last launch by category, with the source file, line and layer, and whether that file changed since. | —      |
| `hoi4.mod_index`         | Summarize the mod's descriptor and definitions, or find the next free numbered ID for an event namespace or prefix across every layer.    | —      |

## Focus trees

| Tool                 | Purpose                                                                                                                    | Writes       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `hoi4.focus_inspect` | Read focus trees, continuous-focus placement, and structural or reference problems.                                        | review files |
| `hoi4.focus_render`  | Render a tree or palette as a PNG with decoded icons plus HTML, SVG, JSON and source maps; `png: false` for vector only.   | review files |
| `hoi4.focus_rewrite` | Create a focus tree or continuous-focus palette from a complete plan, or compact an existing tree's layout without a plan. | mod files    |

## Scripted GUIs

| Tool               | Purpose                                                                                                     | Writes       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------ |
| `hoi4.gui_inspect` | Read a scripted GUI and its linked assets and logic.                                                        | review files |
| `hoi4.gui_render`  | Render generated and explicit GUI scenarios, states, resolutions, and layout diagnostics.                   | review files |
| `hoi4.gui_rewrite` | Apply one validated GUI change as full source, structured helpers, or exact patches, with extra text files. | mod files    |

## Maps

| Tool               | Purpose                                                                                                                                      | Writes       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `hoi4.map_inspect` | Validate, search and look up the map; render a layer, overlays, tile or area; check script references to map entities.                       | review files |
| `hoi4.map_rewrite` | Create a new world, or create, split, merge and renumber states and provinces, regenerate positions and supply, and remap script references. | mod files    |

## Events

| Tool                 | Purpose                                                                                                                             | Writes |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `hoi4.event_inspect` | Scan, trace, explain, lint, or assess event chains and their state flow; `mode: compare` diffs cached, artifact or proposed graphs. | —      |
| `hoi4.event_render`  | Render source-linked event routes, options, timing, state, scope, and unresolved edges.                                             | —      |

## Technology and doctrines

| Tool                | Purpose                                                                                                                   | Writes |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| `hoi4.tech_inspect` | Scan, trace, explain, lint, and assess technology and doctrine systems; `mode: compare` diffs graphs and source overlays. | —      |
| `hoi4.tech_render`  | Render source layouts with real item sizes and year guides, plus dependencies and assets.                                 | —      |

## AI weights and timing

| Tool                       | Purpose                                                                                                                  | Writes |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| `hoi4.probability_inspect` | Find weighted logic by path, ID or candidate IDs and evaluate it: weights, probabilities and the facts still missing.    | —      |
| `hoi4.probability_analyze` | Compare a proposed source, sweep ranges, simulate uncertainty, analyze a declared pool over time, or render an analysis. | —      |

## Decisions, impact and tests

| Tool                    | Purpose                                                                                   | Writes |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------ |
| `hoi4.impact_inspect`   | Trace symbol and changed-file consumers across source systems and compare proposals.      | —      |
| `hoi4.decision_inspect` | Inventory and evaluate decisions or missions under declared scenarios and source changes. | —      |
| `hoi4.mechanic_test`    | Interpret declared effect steps on a copied scenario state and check assertions.          | —      |
| `hoi4.package_check`    | Check declarative package definitions, calls, registrations, assets, and case links.      | —      |
| `hoi4.scenario_test`    | Run named source and domain cases in resumable, revision-bound batches.                   | —      |

## Background jobs

| Tool               | Purpose                                                                | Writes    |
| ------------------ | ---------------------------------------------------------------------- | --------- |
| `hoi4.job_inspect` | Inspect durable background work or retrieve its completed tool result. | —         |
| `hoi4.job_cancel`  | Durably request cancellation of authorized background work.            | job state |

## Prompts and resources

The server offers one MCP prompt, `hoi4.probability_analysis`.
It takes an `objective` and an optional `sourceHint` and returns a plan for one source-linked AI-weight, MTTH, random or declared-pool analysis; it does not run the analysis itself.

Large results are returned as links to the resource template `hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}`.
Clients can read a byte range with `?offset=<bytes>&length=<bytes>`.

Local stdio clients also see the fixed resource `hoi4-agent://server/status`, which lists the server processes sharing this server state, with memory use, last client activity and execution limits; see [server lifetime](setup.md#server-lifetime).
Authenticated HTTP sessions never see it.

## Arguments

Tools accept the shorthands agents most often send and read them as the canonical form: an event selector as a plain string, a namespace wildcard such as `chaosx.nr14.*`, or an object without `kind` or with `id` for its own field; a trace's event as `from`, `eventId` or `namespace`; a GUI scenario without `id`, or none for a window inspection; a decision inspection by `id` or `decisionId` without a scenario; a probability scenario set as a bare list or without ids and `state`; a script file check that also names a kind and scope, which the file already fixes, and a snippet check without a `kind`, which is read as the effect or trigger with fewer errors. A `limit`, `maxDepth`, `maxNodes` or `maxEdges` above its maximum is lowered to the maximum.
Anything still invalid comes back as a tool error, code `INVALID_ARGUMENTS`, that names each failing field with what it expected and shows a working call.
It is a tool error rather than a protocol error because clients show a tool error's text to the model, while some reduce a protocol error to a generic message.
Every error and blocked result also carries its blockers in the text content, so a client that shows only text still explains the failure.

## Example calls

Every tool description in `tools/list` ends with a call like these, and an invalid call returns the same example for its tool.
Fields not shown take their defaults; `workspaceId` is `"current"` unless you pass one.
The CI stdio smoke suite sends each of these shapes to a real server process.

| Tool                       | Example arguments                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hoi4.reference_context`   | `{"surface":"event","question":"fire an event after a delay"}`                                                                                                                                                          |
| `hoi4.reference_search`    | `{"query":"add_timed_idea"}`                                                                                                                                                                                            |
| `hoi4.reference_read`      | `{"id":"<hit id>","revision":"<hit revision>"}` from a search or context hit                                                                                                                                            |
| `hoi4.source_lookup`       | `{"symbol":"my_scripted_effect"}` or `{"path":"events/my_events.txt","line":42}`                                                                                                                                        |
| `hoi4.script_validate`     | `{"source":"add_political_power = 10","kind":"effect","scope":"country"}` or `{"path":"events/my_events.txt"}`                                                                                                          |
| `hoi4.error_log`           | `{"scope":"mod","category":"effect"}`                                                                                                                                                                                   |
| `hoi4.mod_index`           | `{"mode":"overview"}` or `{"mode":"next_id","kind":"event","namespace":"my_mod"}`                                                                                                                                       |
| `hoi4.focus_inspect`       | `{"treeId":"my_focus_tree"}`                                                                                                                                                                                            |
| `hoi4.focus_render`        | `{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree"}`                                                                                                                                         |
| `hoi4.focus_rewrite`       | `{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree","layoutMode":"compact"}`                                                                                                                  |
| `hoi4.gui_inspect`         | `{"windowName":"my_window"}`                                                                                                                                                                                            |
| `hoi4.gui_render`          | `{"windowName":"my_window","scenario":{"id":"normal"}}`                                                                                                                                                                 |
| `hoi4.gui_rewrite`         | `{"mode":"helpers","relativePath":"interface/my_window.gui","windowName":"my_window","scenario":{"id":"normal"},"helper":{…}}`                                                                                          |
| `hoi4.map_inspect`         | `{"query":"Brandenburg","lookupOnly":true}` or `{"layer":"state","tile":{"x":2600,"y":500,"width":256,"height":256}}`                                                                                                   |
| `hoi4.map_rewrite`         | `{"operations":[{"id":"s1","kind":"create_state","provinceIds":[120,121],"displayName":"New State"}]}`                                                                                                                  |
| `hoi4.event_inspect`       | `{"mode":"trace","selector":"my_mod.1","direction":"downstream"}`                                                                                                                                                       |
| `hoi4.event_render`        | `{"view":"overview","selector":"my_mod"}`                                                                                                                                                                               |
| `hoi4.tech_inspect`        | `{"mode":"explain","technologyId":"my_tech"}`                                                                                                                                                                           |
| `hoi4.tech_render`         | `{"view":"folder","folderId":"my_folder"}`                                                                                                                                                                              |
| `hoi4.probability_inspect` | `{"candidatePool":["my_decision"],"scenarioSet":[{"actor":"GER","state":{"has_war":false}}]}`                                                                                                                           |
| `hoi4.probability_analyze` | `{"analysis":"sweep","source":"common/decisions/my_decisions.txt","candidatePool":["my_decision"],"scenarioSet":[{"actor":"GER","state":{"variable.pressure":10}}],"sweep":{"paths":["variable.pressure"],"steps":10}}` |
| `hoi4.impact_inspect`      | `{"symbols":[{"kind":"scripted_effect","id":"my_effect"}]}`                                                                                                                                                             |
| `hoi4.decision_inspect`    | `{"mode":"inspect","id":"my_decision","scenarios":[{"id":"base","actor":"GER","state":{}}]}`                                                                                                                            |
| `hoi4.mechanic_test`       | `{"test":{"id":"t","scenario":{…},"steps":[…],"assertions":[…]}}`, see [Mechanic tests](mechanics.md)                                                                                                                   |
| `hoi4.package_check`       | `{"manifest":{"schemaVersion":"1.0","id":"my_package","definitions":[{"kind":"scripted_effect","id":"my_effect"}]}}`                                                                                                    |
| `hoi4.scenario_test`       | `{"suitePath":"tests/my_suite.json","maxCases":20}`                                                                                                                                                                     |
| `hoi4.job_inspect`         | `{"jobId":"job_<64 hex characters>"}` from a native task id                                                                                                                                                             |
| `hoi4.job_cancel`          | `{"jobId":"job_<64 hex characters>"}`                                                                                                                                                                                   |

## Result sizes

An inline result never exceeds 32 KB of structured content.
Typical answers are 1 to 5 KB: counts, the main findings, the strongest candidates and links.
Focus, GUI and map results are larger, up to about 20 KB, because they list trees, scenes or matches.
The text content of a successful call is a short JSON summary (status, code, workspace and artifact count), so a client that shows only text still sees how the call ended; an error or blocked result puts its blockers in the text.
Pictures are never inlined: renders, galleries, full graphs and per-candidate traces are linked artifacts that you read in ranges, and every inline list says how many items it omitted.
A reference read is limited to 80 lines and 8,000 bytes; a source lookup returns at most 3 definitions and 10 usages.

## Reading results

Inspect findings and missing inputs along with the image or result.
A rendered control does not by itself prove native availability, and a source simulation is not a game-engine receipt.
For reference searches, retain the cited file, lines and revision so you can reopen the same section.

Follow `continuationUri` until it is `null` to read a long result in pages.
Archive images you need to keep rather than relying on temporary server storage.

## Longer operations

All 19 domain tools accept negotiated MCP tasks, so a client that supports tasks can retrieve a long operation after reconnecting.
The 7 reference tools and the 2 job tools always answer in the foreground.
Other clients receive the ordinary synchronous result.
Use `hoi4.job_inspect` to inspect an authorized job or retrieve its result, and `hoi4.job_cancel` to request cancellation.
See [Background jobs](jobs.md) for request keys, cancellation and recovery.

## Optional ChaosX tools

On the stdio server (`hoi4-agent-tools`), setting `HOI4_AGENT_TOOLS_CHAOSX=1` exposes `chaosx.focus_country_assets` and `chaosx.visual_revision`.
These workflow-specific tools are absent from the default list, and the HTTP server never exposes them.

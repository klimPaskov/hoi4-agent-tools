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

Tools accept the shorthands agents most often send and read them as the canonical form: an event selector as a plain string or without `kind`, a GUI scenario without `id`, a decision inspection without a scenario, and a probability scenario set as a bare list or without ids and `state`.
Anything still invalid is refused with the failing fields named.

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

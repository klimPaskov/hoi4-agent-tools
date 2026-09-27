# Tool reference

Most users can ask their agent in ordinary language; the [examples guide](examples.md) is the best starting point.
This page lists exact tool names for agents and integrations.
Use the connected server's live schema for the fields accepted by each call.

| Tool                        | Purpose                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `hoi4.focus_inspect`        | Read focus trees, continuous-focus placement, and structural or reference problems.       |
| `hoi4.focus_render`         | Produce fast HTML, SVG, JSON, and source-linked layout artifacts.                         |
| `hoi4.focus_raster`         | Produce a PNG preview with decoded source icons.                                          |
| `hoi4.focus_rewrite`        | Create or update a focus tree.                                                            |
| `hoi4.gui_inspect`          | Read a scripted GUI and its linked assets and logic.                                      |
| `hoi4.gui_render`           | Render generated and explicit GUI scenarios, states, resolutions, and layout diagnostics. |
| `hoi4.gui_rewrite`          | Create or update a GUI source package.                                                    |
| `hoi4.map_inspect`          | Search, click, navigate, and inspect the complete rendered map and its linked data.       |
| `hoi4.map_render`           | Render full-map layers, overlays, names, IDs, coordinates, and source-linked catalogs.    |
| `hoi4.map_rewrite`          | Create or update states, provinces, IDs, networks, positions, and connected map data.     |
| `hoi4.reference_context`    | Get compact, cited wiki and installed documentation pointers for a modding surface.       |
| `hoi4.reference_search`     | Search bounded local documentation sections.                                              |
| `hoi4.reference_read`       | Read one revision-bound section, with line continuation.                                  |
| `hoi4.source_lookup`        | Find exact definitions, overrides, usages, and narrow source blocks.                      |
| `hoi4.event_inspect`        | Scan, trace, explain, lint, or assess event chains and their state flow.                  |
| `hoi4.event_render`         | Render source-linked event routes, options, timing, state, scope, and unresolved edges.   |
| `hoi4.event_compare`        | Compare event-chain topology and diagnostics between revisions.                           |
| `hoi4.impact_inspect`       | Trace symbol and changed-file consumers across source systems and compare proposals.      |
| `hoi4.decision_inspect`     | Inventory and evaluate decisions or missions under declared scenarios and source changes. |
| `hoi4.mechanic_test`        | Execute bounded source effects on a copied declared scenario and check assertions.        |
| `hoi4.package_check`        | Check declarative package definitions, calls, registrations, assets, and case links.      |
| `hoi4.scenario_test`        | Run named source and domain cases in resumable, revision-bound batches.                   |
| `hoi4.job_inspect`          | Inspect durable background work or retrieve its completed tool result.                    |
| `hoi4.job_cancel`           | Durably request cancellation of authorized background work.                               |
| `hoi4.tech_inspect`         | Scan, trace, explain, lint, and assess technology and doctrine systems.                   |
| `hoi4.tech_render`          | Render source layouts with real item sizes and year guides, plus dependencies and assets. |
| `hoi4.tech_compare`         | Compare technology graphs, placements, references, diagnostics, and source overlays.      |
| `hoi4.probability_inspect`  | Locate weighted logic and discover compatible adapters, candidates, and required inputs.  |
| `hoi4.probability_evaluate` | Evaluate supported weights, probability and timing models, and missing inputs.            |
| `hoi4.probability_sweep`    | Find sensitivity, breakpoints, cliffs, and rank reversals across declared ranges.         |
| `hoi4.probability_simulate` | Run deterministic sampled analysis with confidence and convergence data.                  |
| `hoi4.probability_sequence` | Analyze declared recovery, caps, cooldowns, resets, timers, and terminal states.          |
| `hoi4.probability_compare`  | Attribute AI-weight and MTTH changes between real or proposed source.                     |
| `hoi4.probability_render`   | Render cached rankings, matrices, timing, sensitivity, sequence, and comparisons.         |

## Reading results

Inspect findings and missing inputs along with the image or result.
A rendered control does not by itself prove native availability, and a source simulation is not a game-engine receipt.
For reference searches, retain the cited file, lines and revision so you can reopen the same section.

Large results are returned as linked `hoi4-agent://` resources.
Follow `continuationUri` until it is `null`; clients can also request byte ranges with `?offset=<bytes>&length=<bytes>`.
Archive images you need to keep rather than relying on temporary server storage.

## Longer operations

Clients that negotiate MCP tasks can retrieve a long operation after reconnecting.
Other clients receive the ordinary synchronous result.
Use `hoi4.job_inspect` to inspect an authorized job or retrieve its result, and `hoi4.job_cancel` to request cancellation.
See [Background jobs](jobs.md) for request keys, cancellation and recovery.

## Optional ChaosX tools

Setting `HOI4_AGENT_TOOLS_CHAOSX=1` on the server process exposes `chaosx.focus_country_assets` and `chaosx.visual_revision`.
These workflow-specific tools are absent from the default public list.

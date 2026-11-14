# Tool reference

Most users can ask their agent in ordinary language; the [examples guide](examples.md) is the best starting point.
This page lists exact tool names for agents and integrations.
Use the connected server's live schema for the fields accepted by each call.

The **Writes** column says what a call can change:

- **—** reads source and returns a result.
- **review files** writes images and reports to the server's own workspace storage, never to the mod.
- **mod files** changes mod source.

MCP clients may ask for approval to create review files.
`hoi4.job_cancel` is marked destructive because it stops work in progress; it never edits source.

The tables below and the example calls are generated from the server's `tools/list` by `npm run docs:tools`: each purpose is the tool description up to its example, and the Writes column comes from the tool annotations.
A test fails when this page differs from `tools/list`, so edit the tool description, not the table.

<!-- generated:tool-tables:start -->

## References and source

| Tool                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                 | Writes |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `hoi4.reference_context`    | Find documentation for the content you are building: events, decisions, ideas, focuses, technology, GUI, maps, localisation or AI.                                                                                                                                                                                                                                                                                                      | —      |
| `hoi4.reference_search`     | Find the right modding rule in the offline wiki and installed game docs using ordinary words or script names. Returns up to 10 short candidates (limit up to 12), each with its file, lines, revision and, for a command, a one-line meaning and the scopes it works in. Read the candidates and pick the one that fits the task, since several commands often sound alike; read it with hoi4.reference_read using its id and revision. | —      |
| `hoi4.reference_read`       | Read a documentation section returned by reference_search or reference_context. Pass its id and revision.                                                                                                                                                                                                                                                                                                                               | —      |
| `hoi4.source_lookup`        | Find where a script symbol is defined and used across the game, DLC and mod. Pass a symbol, or a file path and line.                                                                                                                                                                                                                                                                                                                    | —      |
| `hoi4.script_validate`      | Find broken syntax, commands and scopes in an effect, trigger or mod file using the installed docs. Unknown helpers and native argument blocks stay unresolved.                                                                                                                                                                                                                                                                         | —      |
| `hoi4.error_log`            | Find errors from the last game launch and group them by category, with source files, lines and fix hints. Show which files changed since the log and which errors appeared after a relaunch; mod entries come first.                                                                                                                                                                                                                    | —      |
| `hoi4.explain_error`        | Explain error.log lines: the rule each one breaks, its file and line with the lines around it, and the fix, from a reviewed catalogue of the game's messages. Says whether the game documents the command a line names, and the closest documented names.                                                                                                                                                                               | —      |
| `hoi4.mod_health`           | Check a whole mod in one call: the last error.log, the engine check (unknown effects, triggers and modifiers, duplicate ids, broken overrides), script validation, and the localisation and asset audits. Returns the 10 problems that matter most, each counted with 2 examples, its fix and the tool to use next, and which audits ran.                                                                                               | —      |
| `hoi4.script_guard`         | Check the files you wrote for invented commands: every effect, trigger and modifier that the installed game documentation does not list and no loaded file defines, with its file, line and the closest real name. Checks the named paths, or the mod script files changed in the last 120 minutes. Needs hoi4-engine.                                                                                                                  | —      |
| `hoi4.compat_check`         | mod: compare this mod with another in both load orders: files at the same path and who wins, duplicate ids, definitions and hooks dropped, replace_path losses, and which order loses less. patch: store the vanilla files the mod overrides and list those a game update changed.                                                                                                                                                      | —      |
| `hoi4.mod_index`            | Summarize the content in a mod or find a free event ID across the mod, game and dependencies. Use overview for descriptors, folders and definitions, or next_id with a namespace or prefix.                                                                                                                                                                                                                                             | —      |
| `hoi4.localisation_inspect` | Read localisation in every language the game and mod ship. key: one key per language with file, line and layer, the languages lacking it and the files mentioning it. audit: keys the mod uses that no language defines, keys missing from a supported language, keys defined twice in one language, and file problems. coverage: keys per language.                                                                                    | —      |
| `hoi4.idea_inspect`         | Read an idea or character across the game, DLC and mod. idea: category, picture sprite and texture, modifiers checked against the game docs, conditions, name in every language, the advisor it belongs to, and files mentioning it. character: name, roles with traits checked, portraits checked. audit: true checks every idea or character of the mod.                                                                              | —      |
| `hoi4.system_inspect`       | Read one definition of a newer system, or audit every one the mod makes: on_actions hooks, MIOs and policies, balance of power, special projects, operations and raids. Returns its parts, each reference with whether it exists, pictures, names in every language and problems.                                                                                                                                                       | —      |
| `hoi4.unit_inspect`         | Read one order of battle (history/units), sub-unit, equipment or module, or equipment variant, or audit every one the mod makes. Checks template grids, divisions, fleets, air wings, equipment slots and modules, and each name they use.                                                                                                                                                                                              | —      |
| `hoi4.asset_inspect`        | Read one sprite (texture size, format and frames), sound, sound effect or music track (audio file, sounds it plays), or flag (all three sizes), or audit every one the mod defines. Flags BC7 textures, missing files and wrong flag sizes.                                                                                                                                                                                             | —      |
| `hoi4.skill`                | List the modding skills installed in the mod, or load one by name, at the kit version HOI4 Mod Setup pinned, with its hash. A file edited since Setup installed it is refused unless acceptLocalEdits.                                                                                                                                                                                                                                  | —      |

## Localisation

| Tool                      | Purpose                                                                                                                                                                                                                                                                                                                               | Writes    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `hoi4.localisation_write` | Add localisation keys (mode add: key and text; language, file, replace) or repair localisation files (mode fix: BOM, broken quotes, keys missing from supported languages). Game keys are overridden from a replace folder. apply false returns the diff and writes nothing; apply true writes it. Returns up to 10 files with diffs. | mod files |

## Focus trees

| Tool                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                | Writes       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `hoi4.focus_inspect` | Check a focus tree's structure and layout. Returns blocking errors, a layout verdict (pass, review, revise, blocked) with the metrics behind it, a fix for each failing metric and next actions. Revise or blocked means the tree is not finished, however clean its structure; review is advisory, so look at hoi4.focus_render.                                                                      | review files |
| `hoi4.focus_render`  | Render a focus tree in the in-game style (right-angle connectors) and return it inline, with close-ups of the worst places; cropBranchIds and cropFocusIds add more. Look before you judge a layout: metrics cannot see composition. Also exports PNG with icons, HTML, SVG and JSON as linked artifacts.                                                                                              | review files |
| `hoi4.focus_rewrite` | Create or repair a focus tree or palette. New trees: lanes and position mode auto; x/y only for exact anchors. layoutMode compact repairs a layout (compactFocusIds picks a branch, pinnedFocusIds keeps neighbours); engine lays out with the Rust engine; placement adds focuses, moving no others; both need hoi4-engine. Keeps prerequisites and rewards. Returns files, layout verdict and delta. | mod files    |

## Scripted GUIs

| Tool               | Purpose                                                                                                                                                              | Writes       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `hoi4.gui_inspect` | Find the elements, assets and script behind a window, including layout problems, localisation and fonts.                                                             | review files |
| `hoi4.gui_render`  | Preview a window at different resolutions and states. Shows control regions, element hierarchy and layout problems; unknown visibility stays unresolved.             | review files |
| `hoi4.gui_rewrite` | Create or edit a window from complete source, structured helpers or exact patches. Add related text files in additionalFiles; binary art must already be in the mod. | mod files    |

## Maps

| Tool               | Purpose                                                                                                                                                                                                                                               | Writes       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `hoi4.map_inspect` | Explore and preview the map. Find provinces, states and regions by name, ID or coordinates, inspect map problems and script references, or render a layer, tile or area. Use lookupOnly for a quick lookup and references:true for script references. | review files |
| `hoi4.map_rewrite` | Build a world from a reference image or a geography model (geography, geographyPath), or edit provinces, states, regions and supply.                                                                                                                  | mod files    |

## Events

| Tool                 | Purpose                                                                                                                                                                 | Writes |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `hoi4.event_inspect` | Follow event chains and explain their options, conditions, timing and state changes. Find broken calls, inspect affected events or compare revisions with mode compare. | —      |
| `hoi4.event_render`  | Preview event routes, options, timing, state and scope as JSON, SVG and PNG.                                                                                            | —      |

## Technology and doctrines

| Tool                | Purpose                                                                                                                                                                           | Writes |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `hoi4.tech_inspect` | Explain technology and doctrine paths, unlocks, bonuses and dependencies. Find layout or reference problems and compare revisions with mode compare.                              | —      |
| `hoi4.tech_render`  | Preview technology folders and doctrines with their icons, item sizes and year guides. Show dependencies, bonuses, grants, unlocks or unresolved references as JSON, SVG and PNG. | —      |

## AI weights and timing

| Tool                       | Purpose                                                                                                                                                                                                                                                                  | Writes |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `hoi4.probability_inspect` | Explain why the AI favours an option, decision, focus or technology. Find ai_will_do, ai_chance, MTTH, random_list or strategy factors by path, ID or candidate IDs and evaluate them under declared scenarios. Show weights, supported probabilities and missing facts. | —      |
| `hoi4.probability_analyze` | Compare AI weights before and after an edit, find where a choice changes, or explore uncertain inputs and choices over time. Select compare, sweep, simulate, sequence or render with analysis.                                                                          | —      |

## Decisions, impact and tests

| Tool                    | Purpose                                                                                                                                                                        | Writes |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `hoi4.impact_inspect`   | Find what a script change affects across focuses, events, decisions, ideas, windows and helpers. Trace definitions and their uses, including proposed source.                  | —      |
| `hoi4.decision_inspect` | Explain why a decision or mission is hidden, unavailable or unaffordable. Inspect conditions, costs and lifecycle for declared actors and targets, or compare proposed source. | —      |
| `hoi4.mechanic_test`    | Test what an effect, option, decision or focus reward does to a declared state (docs/mechanics.md).                                                                            | —      |
| `hoi4.package_check`    | Find missing pieces of a feature by checking its package manifest against definitions, calls, registrations, localisation, assets and required test cases.                     | —      |
| `hoi4.scenario_test`    | Run named mechanic, package or inspection cases from a suite or workspace file. Continue unfinished batches and report failures and unresolved cases.                          | —      |

## Background jobs

| Tool               | Purpose                                                                                                | Writes    |
| ------------------ | ------------------------------------------------------------------------------------------------------ | --------- |
| `hoi4.job_inspect` | Check progress on a background task or retrieve its completed result. Pass jobId from the task handle. | —         |
| `hoi4.job_cancel`  | Stop a background task by jobId. A result that has already completed stays available.                  | job state |

<!-- generated:tool-tables:end -->

## Prompts and resources

The server offers one MCP prompt, `hoi4.probability_analysis`.
It takes an `objective` and an optional `sourceHint` and returns a plan for one source-linked AI-weight, MTTH, random or declared-pool analysis; it does not run the analysis itself.

The skills `hoi4.skill` serves are also resources, `hoi4-agent://workspace/{workspaceId}/skill/{name}`; see [Read the mod's skills](reference.md#read-the-mods-skills).

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

<!-- generated:tool-examples:start -->

| Tool                        | Example arguments                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hoi4.reference_context`    | `{"surface":"event","question":"fire an event after a delay"}`                                                                                                                                                                          |
| `hoi4.reference_search`     | `{"query":"add_timed_idea"}` or `{"query":"give a country a spirit that ends after some days"}`                                                                                                                                         |
| `hoi4.reference_read`       | `{"id":"<hit id>","revision":"<hit revision>"}`                                                                                                                                                                                         |
| `hoi4.source_lookup`        | `{"symbol":"my_scripted_effect"}`                                                                                                                                                                                                       |
| `hoi4.script_validate`      | `{"source":"add_political_power = 10","kind":"effect","scope":"country"}` or `{"path":"events/a.txt"}`                                                                                                                                  |
| `hoi4.error_log`            | `{"scope":"mod","category":"effect"}`                                                                                                                                                                                                   |
| `hoi4.explain_error`        | `{"line":"Invalid trigger 'stability' in events/my_events.txt line : 12"}`                                                                                                                                                              |
| `hoi4.mod_health`           | `{"limit":5}` or `{"checks":["error_log","engine_check"]}`                                                                                                                                                                              |
| `hoi4.script_guard`         | `{"paths":["events/my_events.txt"]}`                                                                                                                                                                                                    |
| `hoi4.compat_check`         | `{"mode":"mod","other":"my_other_mod"}` or `{"mode":"patch"}`                                                                                                                                                                           |
| `hoi4.mod_index`            | `{"mode":"next_id","kind":"event","namespace":"my_mod"}`                                                                                                                                                                                |
| `hoi4.localisation_inspect` | `{"mode":"key","key":"my_event.1.t"}` or `{"mode":"audit"}`                                                                                                                                                                             |
| `hoi4.idea_inspect`         | `{"kind":"idea","id":"GER_mefo_bills_1"}` or `{"kind":"character","audit":true}`                                                                                                                                                        |
| `hoi4.system_inspect`       | `{"kind":"mio","id":"my_organization"}` or `{"kind":"on_actions","audit":true}`                                                                                                                                                         |
| `hoi4.unit_inspect`         | `{"kind":"oob","id":"GER_1936"}` or `{"kind":"variant","audit":true}`                                                                                                                                                                   |
| `hoi4.asset_inspect`        | `{"kind":"sprite","id":"GFX_my_icon"}` or `{"kind":"flag","audit":true}`                                                                                                                                                                |
| `hoi4.skill`                | `{"name":"hoi4-events"}`                                                                                                                                                                                                                |
| `hoi4.localisation_write`   | `{"mode":"add","entries":[{"key":"my_focus","text":"My focus"}]}`                                                                                                                                                                       |
| `hoi4.focus_inspect`        | `{"treeId":"my_focus_tree"}`                                                                                                                                                                                                            |
| `hoi4.focus_render`         | `{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree"}`                                                                                                                                                         |
| `hoi4.focus_rewrite`        | `{"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree","layoutMode":"compact"}`                                                                                                                                  |
| `hoi4.gui_inspect`          | `{"windowName":"my_window"}`                                                                                                                                                                                                            |
| `hoi4.gui_render`           | `{"windowName":"my_window","scenario":{"id":"normal","flags":{"my_flag":true}}}`                                                                                                                                                        |
| `hoi4.gui_rewrite`          | `{"mode":"helpers","relativePath":"interface/my_window.gui","windowName":"my_window","scenario":{"id":"normal"},"helper":{"root":{"id":"w","kind":"column","name":"my_window"}}}`                                                       |
| `hoi4.map_inspect`          | `{"query":"Brandenburg","lookupOnly":true}`                                                                                                                                                                                             |
| `hoi4.map_rewrite`          | `{"preview":true,"operations":[{"kind":"create_world","reference":{"imagePath":"references/world.png"}}]}`                                                                                                                              |
| `hoi4.event_inspect`        | `{"mode":"trace","selector":"my_mod.1","direction":"downstream"}`                                                                                                                                                                       |
| `hoi4.event_render`         | `{"view":"overview","selector":"my_mod"}`                                                                                                                                                                                               |
| `hoi4.tech_inspect`         | `{"mode":"explain","technologyId":"my_tech"}`                                                                                                                                                                                           |
| `hoi4.tech_render`          | `{"view":"folder","folderId":"my_folder"}`                                                                                                                                                                                              |
| `hoi4.probability_inspect`  | `{"candidatePool":["my_decision"],"scenarioSet":[{"actor":"GER","state":{"has_war":false}}]}`                                                                                                                                           |
| `hoi4.probability_analyze`  | `{"analysis":"sweep","source":"common/decisions/my_decisions.txt","candidatePool":["my_decision"],"scenarioSet":[{"actor":"GER","state":{"variable.pressure":10}}],"sweep":{"paths":["variable.pressure"],"steps":10}}`                 |
| `hoi4.impact_inspect`       | `{"symbols":[{"kind":"scripted_effect","id":"my_effect"}]}`                                                                                                                                                                             |
| `hoi4.decision_inspect`     | `{"mode":"inspect","id":"my_decision","scenarios":[{"id":"base","actor":"GER","state":{}}]}`                                                                                                                                            |
| `hoi4.mechanic_test`        | `{"test":{"id":"t","scenario":{"schemaVersion":"1.0","id":"t","state":{}},"steps":[{"kind":"effect","source":{"kind":"scripted_effect","id":"e"}}],"assertions":[{"id":"a","kind":"conservation","paths":[{"key":"x"},{"key":"y"}]}]}}` |
| `hoi4.package_check`        | `{"manifest":{"schemaVersion":"1.0","id":"my_package","definitions":[{"kind":"scripted_effect","id":"my_effect"}]}}`                                                                                                                    |
| `hoi4.scenario_test`        | `{"suitePath":"tests/my_suite.json","maxCases":20}`                                                                                                                                                                                     |
| `hoi4.job_inspect`          | `{"jobId":"job_<64 hex characters>"}`                                                                                                                                                                                                   |
| `hoi4.job_cancel`           | `{"jobId":"job_<64 hex characters>"}`                                                                                                                                                                                                   |

<!-- generated:tool-examples:end -->

## Result sizes

An inline result never exceeds 32 KB of structured content.
Typical answers are 1 to 5 KB: counts, the main findings, the strongest candidates and links.
Focus, GUI and map results are larger, up to about 24 KB, because they list trees, scenes or matches.
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

All 20 domain tools accept negotiated MCP tasks, so a client that supports tasks can retrieve a long operation after reconnecting.
The 7 reference tools and the 2 job tools always answer in the foreground.
Other clients receive the ordinary synchronous result.
Use `hoi4.job_inspect` to inspect an authorized job or retrieve its result, and `hoi4.job_cancel` to request cancellation.
See [Background jobs](jobs.md) for request keys, cancellation and recovery.

## Plugins

A private extension can add tools to the stdio server (`hoi4-agent-tools`). List its module (`.mjs` or `.js`, absolute path) in the configuration key `plugins`; the server loads plugins only from those paths, never from a mod folder or the environment, and the HTTP server never loads them. A plugin tool is named `<plugin>.<tool>` and never starts with `hoi4.`, which this package reserves. A plugin exports a default function that receives a host (`importServerModule` to borrow the server's own modules, `dependency` for the shared `zod` and `sharp`) and returns a factory of tools; each tool has the same definition as a built-in one (name, title, description, input and optional output schema, annotations) and a `call` function. A plugin file that does not exist is skipped with a warning on stderr; a file that is a link, is not a `.mjs` or `.js` file, or exports no factory stops the server at startup.

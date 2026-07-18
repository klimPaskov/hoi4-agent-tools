# Event chains

The Event Chain Viewer analyzes event definitions and call sites across the active mod, configured dependencies, and vanilla sources. It is read-only: it does not rewrite event files or simulate the game.

Use the three event tools directly from the target mod.

## Inspect

`hoi4.event_inspect` provides seven focused modes:

- `scan`: inventory event definitions, namespaces, call sites, and unresolved references.
- `roots`: find likely entry points and explain why they are roots.
- `trace`: follow bounded incoming or outgoing routes from an event.
- `explain_path`: explain a selected route edge by edge with exact source locations.
- `state_flow`: report flags, variables, targets, scopes, and other tracked state read or changed along a route.
- `lint`: find missing targets, unreachable events, suspicious cycles, conflicting definitions, invalid timing, and unresolved dynamic calls.
- `impact`: identify callers, descendants, state dependencies, and files affected by a proposed event change.

Use narrow identifiers, direction, and depth limits when the task concerns one chain. Broad scans build the structural event graph without expanding every scripted helper into duplicate paths. Focused trace, path, state, impact, and render calls expand helper relationships when needed.

The compact response summarizes the result. Small scan resources contain the complete graph; very large scan resources contain exact totals, grouped inventories, representative diagnostics, and the revision needed for focused follow-up queries. This keeps an agent's prompt and artifact storage bounded without reducing the results of those focused queries.

Selectors use one of these forms:

```json
{ "kind": "event", "eventId": "namespace.1" }
{ "kind": "namespace", "namespace": "namespace" }
{ "kind": "file", "sourcePath": "events/example.txt" }
{ "kind": "source", "sourcePath": "events/example.txt", "line": 40 }
{ "kind": "node", "nodeId": "event:namespace.1" }
{ "kind": "manifest", "manifest": { "eventIds": ["namespace.1", "namespace.2"] } }
```

`trace` uses `selector`; `explain_path` uses `from` and `to`; and `state_flow` may add a `stateSubject` object with `kind` and `name`. Allowed state kinds are `country_flag`, `global_flag`, `state_flag`, `variable`, `global_variable`, `array`, `event_target`, `global_event_target`, and `saved_scope`.

`impact` requires an `impactSubject` object with `kind` and `name`. Allowed impact kinds are `event`, `helper`, `flag`, `variable`, `array`, `event_target`, and `saved_scope`. Set `refresh: true` after source changes when a prior graph may be cached.

Example `hoi4.event_inspect` arguments:

```json
{
  "mode": "trace",
  "selector": { "kind": "event", "eventId": "namespace.1" },
  "direction": "downstream",
  "maxDepth": 8,
  "maxNodes": 500,
  "maxEdges": 2000,
  "expandHelpers": false,
  "refresh": false
}
```

## Render

`hoi4.event_render` produces deterministic, source-linked views of a chain. The exact `view` values are `overview`, `neighborhood`, `options`, `entries`, `reachability`, `timing`, `state`, `targets`, `scope`, `terminals`, and `unresolved`. JSON is the authoritative graph; SVG and PNG provide visual review, with HTML available for bundled navigation when requested.

Large overview requests return a compact overview plus bounded branch JSON/SVG/PNG resources and a coverage manifest. The manifest indexes every generated data artifact by canonical MCP resource URI, including artifacts omitted from the compact tool response. Follow those links instead of asking the agent to reason from one unreadable all-node image.

Dynamic and meta-generated targets that cannot be resolved statically remain explicit unresolved edges. The renderer never invents a destination.

Example `hoi4.event_render` arguments:

```json
{
  "view": "neighborhood",
  "selector": { "kind": "event", "eventId": "namespace.1" },
  "direction": "both",
  "maxDepth": 4,
  "maxNodes": 120,
  "expandHelpers": false,
  "includeHtml": false,
  "refresh": false
}
```

## Compare

`hoi4.event_compare` compares whole workspace event graphs; it does not accept a chain selector. `before` and `after` each accept exactly one graph reference: `{ "revision": "<sha256>" }` or `{ "artifactUri": "hoi4-agent://..." }`. If no reference or overlay is supplied, the tool compares the previous cached revision with a fresh scan of the current source and reports an error when no prior revision is available. Comparisons refresh current source by default so normal agent file edits are detected; set `refresh: false` only when intentionally comparing cached graphs.

Alternatively, compare the current graph with `proposedSources`, an in-memory list of `{ relativePath, source, expectedSourceHash? }` overlays. Set `source` to a string to add or replace source, or to `null` to delete an existing mod source. `after` and `proposedSources` are mutually exclusive. Proposed sources are analyzed without being written. The result reports added, removed, and changed definitions, edges, options, state operations, diagnostics, and route reachability.

Example `hoi4.event_compare` arguments:

```json
{
  "proposedSources": [
    {
      "relativePath": "events/example.txt",
      "source": "add_namespace = namespace\ncountry_event = { id = namespace.1 }\n"
    },
    {
      "relativePath": "events/obsolete.txt",
      "source": null
    }
  ],
  "render": true,
  "maxRenderNodes": 120,
  "refresh": true
}
```

## Agent workflow

A coding agent can combine the viewer with repository instructions, skills, and other tools:

1. call `hoi4.event_inspect` with `scan` or `roots` to locate the chain;
2. use `trace`, `explain_path`, `state_flow`, or `impact` for the current task;
3. read linked JSON evidence only when the compact summary is insufficient;
4. edit event source with the agent's normal file-editing workflow;
5. call `hoi4.event_compare`, `lint`, and `hoi4.event_render` to review the result; comparison refreshes the edited source by default.

Static analysis cannot prove runtime conditions, random outcomes, delayed scheduling, or arbitrary meta-generated text. Those limits are reported in diagnostics and artifacts rather than hidden or guessed. The server never launches or captures Hearts of Iron IV.

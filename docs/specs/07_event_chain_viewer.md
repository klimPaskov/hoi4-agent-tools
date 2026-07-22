# Event Chain Viewer

## Purpose

Give coding agents a clear, source-linked model of large HOI4 event systems that are otherwise spread across event files, options, hidden events, delayed calls, on-actions, decisions, focuses, scripted effects, flags, variables, and event targets.

The viewer must solve a concrete implementation problem. A coding agent should be able to identify how an event can start, what each option can lead to, which conditions control each branch, what state is carried forward, where a chain ends, and which source block creates every connection.

This is a read-only MCP tool family. It does not provide a human-facing editor or dashboard. It does not launch, automate, or simulate Hearts of Iron IV.

## Core questions the tool must answer

The calling coding agent must be able to ask:

- How can this event fire?
- Which on-action, focus, decision, event, or scripted effect reaches it?
- What can happen after each option?
- Which events can eventually reach this event?
- Why is one branch unreachable?
- Which flags, variables, and event targets control this branch?
- Where is an event target created, read, replaced, and cleared?
- Which scope is expected at each transition?
- Which branches are immediate, delayed, random, conditional, or unresolved?
- Where can this chain terminate?
- What changed in the chain after a patch?
- What would become disconnected if an event or helper were removed?

The tool is incomplete if it only draws boxes and arrows without answering these questions.

## Source coverage

Use the shared parser and project index to inspect:

- all supported HOI4 event types and namespaces
- event `immediate`, option, hidden effect, and completion blocks
- direct event calls
- delayed calls, random delays, and random event selection
- weighted `random_list` and equivalent branching
- scripted effects that call events
- nested scripted-effect call chains
- on-actions
- focus completion effects
- decisions and missions
- country and state setup effects where they can start chains
- other indexed script surfaces that can invoke an event
- localisation for event titles and options
- flags, variables, arrays, and event targets used by the chain

Do not hardwire an external mod's event conventions into the generic engine. Allow workspace configuration or agent-supplied annotations to group events into a feature, stage, evolution, route, or incident family.

## Graph model

Represent at least:

- event nodes
- option ports or option nodes
- external entry-point nodes
- scripted-helper nodes
- unresolved dynamic-dispatch nodes
- terminal or exit nodes

Every edge must have provenance and a typed reason, such as:

- immediate event call
- option event call
- hidden event call
- delayed event call
- random or weighted branch
- scripted-effect expansion
- on-action entry
- focus entry
- decision or mission entry
- setup or initialization entry
- unresolved dynamic reference

Attach available conditions, delay values, weights, source scope, destination event type, helper call stack, and exact source location to each edge.

Never invent an edge. Dynamic or meta-generated event IDs that cannot be resolved must appear as unresolved dispatch with the source expression and confidence level.

## Chain reconstruction

Support two starting modes:

1. Automatic root discovery across the indexed workspace.
2. A bounded trace from an event ID, namespace, file, source location, or agent-provided feature manifest.

Build both downstream and upstream relationships.

Allow helper expansion to be collapsed by default and expanded on request. The compact view should show meaningful event flow without hiding the helper chain that proves the connection.

Handle cycles with a graph algorithm suited to cyclic control flow. Do not force event chains into a focus-tree layout. Detect strongly connected components and keep repeated renders stable after small source edits.

## Agent-readable views

Produce focused artifacts for coding-agent inspection:

- full chain overview
- selected event with callers and callees
- option-by-option branch view
- entry-point map
- upstream reachability view
- downstream consequence view
- delay and timing view
- flag and variable flow overlay
- event-target lifecycle overlay
- scope-transition overlay
- terminal and dead-end view
- before-and-after structural comparison
- unresolved-reference report

Return JSON as the authoritative graph representation. Also generate SVG, PNG, and optional HTML resources. HTML is an agent artifact, not a supported human application.

For large chains, generate an overview plus bounded branch renders and source-linked detail resources. Do not place hundreds of unreadable nodes into one image and call the chain clear.

## Path explanation

Provide an operation that explains a path from one entry point or event to another.

The result must list:

- ordered nodes and edges
- option taken at each branch
- required trigger summaries
- delay or random behavior
- helper expansion
- flags, variables, and event targets produced or required
- scope transitions
- unresolved assumptions
- exact source locations

When no path is found, explain whether the target is confirmed unreachable, outside the selected boundary, reachable only through unresolved dynamic dispatch, or blocked by unsupported analysis.

## State and scope flow

Track statically visible reads and writes for:

- country, global, and state flags
- variables and global variables
- arrays where supported
- regular and global event targets
- relevant saved scopes
- clears, replacements, and resets

Show producers and consumers. Warn when a target or value appears to be read before any visible producer, when a global event target has no visible cleanup, or when a delayed branch relies on context that may not persist.

Track known scope transitions through events and helper calls. Scope diagnostics must carry a confidence level. Unsupported or ambiguous scope behavior must be reported, not guessed.

This is static analysis. Do not claim to know runtime values or branch probability beyond what the source proves.

## Structural diagnostics

Detect at least:

- duplicate event IDs
- references to missing events
- events with no discovered caller or root
- unreachable events within a selected chain
- accidental immediate self-calls
- immediate cycles that can recurse without a visible gate
- cycles whose gate or delay cannot be established
- dangling option branches
- missing or invalid random weights
- missing event or option localisation
- event-type and known-scope mismatches
- scripted-effect calls that cannot be resolved
- unresolved dynamic event dispatch
- event targets read before a visible save
- persistent global event targets with no visible cleanup
- flags or variables used as gates but never visibly written
- delayed calls that depend on potentially invalid transient context
- source edges lost after a rename or deletion
- events removed while callers remain
- newly disconnected roots, branches, or terminals in comparisons

Separate confirmed errors, probable defects, design warnings, and unresolved analysis. Cycles, hidden events, terminal events, and events without normal options are not automatically defects.

## MCP operations

Expose exactly three namespaced tools:

- `hoi4.event_inspect`, with `scan`, `roots`, `trace`, `explain_path`, `state_flow`, `lint`, and `impact` modes
- `hoi4.event_render`
- `hoi4.event_compare`

Together they cover workspace scanning, root and entry-point discovery, bounded upstream and downstream traces, path explanation, state and scope flow, linting, deterministic rendering, revision or snapshot comparison, and impact analysis for events, helpers, flags, variables, and event targets. Complete evidence is retrieved through the existing content-addressed artifact resource template rather than additional tools.

All operations are read-only. Do not add event-writing or automatic chain-repair tools as part of this goal.

## Performance and reproducibility

Use incremental indexing and content hashes so repeated traces do not rescan an unchanged workspace.

Every result must record:

- workspace identity
- source revision or content hashes
- trace boundary and filters
- parser and schema version
- unresolved constructs
- generated resource paths

Repeated analysis of unchanged source must produce stable node IDs, edge IDs, ordering, and render layout.

## Acceptance fixture

Create a project-owned synthetic event system containing at least:

- 300 events
- several namespaces and files
- at least 25 external entry points
- direct, hidden, delayed, random, and weighted calls
- nested scripted-effect call chains
- option branches and convergences
- multiple intentional cycles
- regular and global event targets
- country, global, and state flags
- variables and arrays
- scope changes
- focuses, decisions, missions, and on-actions that start chains
- intentionally unresolved dynamic dispatch
- missing-reference, unreachable-event, scope, lifecycle, and localisation defect variants

Maintain an expected graph manifest for the fixture. Tests must prove that all expected nodes and edges are found, no unsupported edge is invented, every edge links to its source, path explanations are correct, state producers and consumers are connected, intentional defects are classified correctly, comparisons identify structural changes, and repeated renders remain stable.

Run read-only local integration tests against a large vanilla event family and at least one external mod event system. Do not copy external event source into the public repository.

## Completion standard

The Event Chain Viewer is complete only when a coding agent can take a large event system it did not write, locate every known entry path, inspect each meaningful branch, explain selected routes through the chain, trace important state and scope dependencies, identify unresolved analysis honestly, and compare the chain before and after changes without launching the game.

A generic graph export, a list of event references, or a renderer without path and state explanations does not satisfy this specification.

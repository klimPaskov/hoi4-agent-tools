# 32. Cross-system impact and decision inspection

Status: Cross-system impact and decision tools were released in 3.2.0; qualification, publication, installation, and external integration evidence is recorded in the [release ledger](../specs/deeper-analysis-and-agent-integration.md).

## Source and authority

The shared scanner and symbol index own source identity, active and overridden definitions, typed references, locations, and incomplete-source diagnostics.
Impact and decision services are read-only adapters over one revision-pinned graph; they do not maintain separate filesystem discovery, parse edited files into the workspace, or infer game execution from static source.
An optional proposed overlay is parsed in memory under an existing authorized workspace-relative path, then analyzed against the same root ordering and shadowing rules as the original source.
The scanner must verify bytes even when file size and timestamp are unchanged.
All responses expose the exact revision, source coverage, omitted-count bounds, and unresolved dynamic references.

## Impact graph

`hoi4.impact_inspect` accepts a bounded selection of symbol identifiers, scanned display paths for changed files, or proposed source overlays.
It reports definition locations, active and overridden variants, typed direct consumers, transitive affected files, and declared scenario-suite cases from bounded workspace-owned JSON references.
Edges retain source and target kind, access role, source location, root kind, and static or unresolved status.
Symbol and file identities include root and load order so a same-named vanilla or dependency definition is not confused with the mod's active definition.
Traversal is bounded by explicit node, edge, depth, and result limits; cycles and truncated frontiers are reported rather than omitted silently.

The first graph families are events, focuses, decisions, ideas, technologies, scripted helpers, variables, flags, event targets, localisation keys, GUI elements, sprites, and textures.
Variables, flags, and event targets are state keys with observed reads and writes, not global definitions with a single winning owner.
Typed syntax and known field contexts identify edges; a token that merely resembles a symbol is not an edge.
Dynamic helper names, variable-built targets, meta effects, scripted localisation, and unsupported scope forms remain explicit unresolved links.
The implementation must distinguish a direct consumer from a transitive consumer and a missing reference from an omitted source.

## Decision inspector

`hoi4.decision_inspect` inventories active categories, decisions, and missions with their source locations and overrides.
It reports category and decision `allowed`, `visible`, and `available` separately, including the actor country and any target country or state.
Target inventory distinguishes explicit `targets`, `target_array`, `state_trigger`, `target_root_trigger`, and `target_trigger`; `ROOT` is the actor and `FROM` is the target.
When a target catalog or scenario value is missing, eligibility is unresolved rather than inferred from another target.

Cost evidence distinguishes engine political-power `cost` from `custom_cost_trigger` and text, which do not themselves deduct resources.
The inspector traces supported payment effects in `complete_effect`, identifies absent or duplicate payment when provable, and leaves dynamic or helper-dependent payment unresolved until expanded.
It reports one-shot/repeatability, cooldowns, `days_remove`, `remove_trigger`/`remove_effect`, `cancel_trigger`/`cancel_effect`, `days_mission_timeout`/`timeout_effect`, `activation`, and `selectable_mission` without treating mission `visible` as an eligibility gate.
It reuses the probability service's `decision_ai_will_do` and `mission_ai_will_do` adapters for AI scores, including their exact candidate-pool and external-factor limits.
Comparisons bind before and after source revisions or validated in-memory overlays and attribute changed eligibility, target, cost, lifecycle, and AI evidence.

The installed game's `common/decisions/_documentation.md` is the primary syntax authority; the offline Decision modding wiki remains a parallel reference.
In particular, category and decision gates both apply, `allowed` is checked at game start or load, `target_root_trigger` and `target_trigger` are daily filters, and a custom cost requires a separate payment effect.

## Serving, artifacts, and tests

Both operations use the shared typed core and the existing ordinary-call and negotiated task execution service.
Large graphs, target catalogs, comparison rows, and traces are linked, content-addressed resources; compact tool results retain counts, boundaries, and diagnostics.
Every external input has a schema and workspace authorization check, including overlay paths and scenario-suite references.
Neither operation writes source or runs the game.

Synthetic tests must cover a broken event-to-decision-to-idea chain, a focus-to-technology unlock, helper and localisation links, active/overridden variants, source additions and removals, a same-size/same-timestamp edit, a cycle, and an unresolved dynamic link.
Decision cases must include two actors with distinct targets, country and state `FROM`, category gates, engine and custom costs, missing and duplicate payment, repeatability/cooldowns, each mission end path, and before/after comparisons.
The public wire tests must cover both transports, ordinary results, native tasks, cancellation, principal isolation, bounded resources, and package metadata.
Complete Stage 3 qualification additionally requires the repository's Windows/Linux and Node 22/24 matrix, coverage, official Inspector, exact published-package verification, and side-by-side installation.

## Implementation checkpoint

The decision service inventories active decisions, category fragments, overridden definitions, and target declarations through the shared symbol index, evaluates declared category/decision/mission gates with separate `ROOT` actor and `FROM` target bindings, reports engine and custom cost evidence, identifies missing or multiple direct payments, and evaluates removal, cancellation, visibility cancellation, cooldown, and mission outcome paths under each scenario.
The shared condition evaluator resolves a declared `ROOT`, `THIS`, `PREV`, or `FROM` operand as a scope identity and leaves an unbound operand unresolved.
The impact graph walks typed references already present in the shared index plus static script edges, retains active and overridden definitions, and reports direct/transitive consumers and cycles with explicit node, edge, depth, and source boundaries.
It records observed variable, flag, and event-target reads and writes as state-key references without inventing one active definition.
Explicit event text and art references connect to localisation, sprites, and textures; decision categories connect through scripted GUIs to GUI containers and through membership to decisions.
An in-memory proposed-source overlay can add, replace, or remove bounded text sources under the resolved mod root and rebuild active source precedence without touching the workspace.
Comparison functions report changed impact consumers and per-scenario decision gates, affordability, lifecycle, and probability-adapter AI scores between revision-pinned snapshots.
State target selection evaluates documented all, owned, controlled, and continent filters only from declared target scope facts; missing actor, target type, owner, controller, or continent remains unresolved.
The public tools share the existing ordinary-call and persistent-job paths across legacy and modern MCP transports; linked artifacts retain source hashes and full analysis.
Focused synthetic tests cover overlay authorization, decision actor and target gates, active and overridden definitions, cost and lifecycle comparisons, AI score changes, cycle detection, suite references, both protocol routes, cancellation, principal isolation, and read-only source preservation.
Release commit `24e80d5f8a4e6c641e73d7cc6c9c2bee34ba0132` passed the full repository check, public Windows/Linux and Node 22/24 matrix, coverage, official MCP Inspector, exact package publication verification, and side-by-side installation. The later external Chaos Redux profiles exercise the shared impact, decision, event, GUI, technology, and bounded mechanic surfaces without adding mod-specific behavior to the public package.

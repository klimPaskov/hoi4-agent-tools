# Mechanic scenarios, package checks, and scenario suites

Status: Accepted architecture.

## Authority and source boundary

The shared scanner and symbol index remain the authority for source bytes, winning definitions, load order, provenance, and incomplete coverage.
All execution is bounded interpretation of authorized source in an isolated, copied scenario state.
No tool launches the game, advances a campaign, invokes a command, or writes a mod source file.
The interpreter models only operations backed by the installed game's documentation and the offline wiki snapshot; unmodeled operations leave dependent state and assertions unresolved.

## One declared scenario state

The core owns a versioned scenario envelope with a stable case identifier, actor, date, named scope bindings, scalar variables, flags, event targets, and arrays.
Each scope has an explicit type and identity, so `ROOT`, `THIS`, `PREV`, and `FROM` resolve through the same declared bindings used by the shared condition evaluator.
Mutable mechanic state is a deep copy of this envelope; each step yields a new deterministic state projection and a trace of the source nodes that read or wrote it.
Unknown values are represented explicitly and propagate only to dependent operations and assertions.
The existing GUI scenario adapter and probability scenario adapter project their declared state into this core envelope without changing either public input contract or the probability service's uncertainty, pools, schedule, and scoring semantics.

## `hoi4.mechanic_test`

An input case selects source-backed, typed entry points and explicit steps; an entry point may be a scripted effect, event option, decision completion, focus reward, or another documented effect block indexed by the shared source model.
The caller supplies the initial scenario and any explicit day advance; no daily or monthly on action runs implicitly.
The interpreter evaluates trigger conditions with the shared condition engine and applies supported variables and arithmetic, flags, event targets, arrays, branch blocks, finite declared scope iteration, scripted helpers, documented balance effects, and supported dynamic substitutions.
Each helper invocation carries source provenance, argument bindings, depth, work, and cycle limits.
Iteration requires a finite scope catalog declared by the scenario or source; an absent or incomplete catalog is unresolved rather than inferred.
Effect, branch, and scope traces distinguish applied, skipped, and unresolved operations and retain before and after values.
Unsupported operations with an unknown write set conservatively taint the whole scenario; known values remain available only when the interpreter can prove they are unaffected.
An assertion has a typed operator and subject, never an executable expression.
The supported assertion families include conservation, aligned arrays, affordability and payment, repeated setup, single payment, exclusivity, cleanup, and required end state.
Every result is revision-bound, deterministic, and linked as a bounded artifact.

## `hoi4.package_check`

A package manifest is declarative JSON with bounded lists of expected definitions, calls, registrations, localisation keys, assets, and required scenario cases.
The checker resolves definitions and references through the shared index, reads assets only within authorized workspace roots, and links required test cases to declared suite files.
It reports present, absent, shadowed, and unresolved items with source locations, hashes, and coverage limits.
Manifest fields cannot embed code, shell commands, source patches, or a plugin module name.
Package checks never grant gameplay content or modify source.

## `hoi4.scenario_test`

A suite is workspace-relative or inline, versioned, and composed of named cases that declare typed domain service calls, source selectors, assertions, and requested views.
Domain calls reuse the existing focus, GUI, map, event, technology, probability, impact, decision, mechanic, and package services through their typed core entry points.
No suite step constructs an arbitrary MCP method name or command string.
The suite runner stores per-case content-addressed results and an authenticated, revision-bound continuation after a bounded batch.
Resume validates the workspace, principal, suite hash, source revision, selected cases, completed work, and requested views before returning further cases.
Every requested case is reported as completed, failed, unresolved, or pending with a continuation; no case is silently omitted.
Views retain their source and scenario identity so later visual comparison can match the same inputs exactly.

## Validation and release gate

Synthetic fixtures must include intentional failures, unknown values, unsupported effects, helper cycles, finite and incomplete scope catalogs, malformed manifests, suite tampering, cross-workspace access, and a large suite resumed across multiple batches.
State traces must be deterministic across runs and process recovery, and the source workspace must remain byte-for-byte unchanged.
The release requires the full local gate, Windows/Linux and Node 22/24 CI, coverage, official Inspector, exact public publication verification, and independent side-by-side installation.

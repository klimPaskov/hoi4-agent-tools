# Focus Tree Workbench

## Purpose

Give coding agents structured MCP tools for planning, generating, inspecting, arranging, and validating large focus trees while preserving full HOI4 complexity.

The module must support existing focus files and a structured planning model. The planning model compiles to ordinary readable HOI4 script and creates no runtime dependency.

## Structured tree model

Support:

- tree and country assignment
- branch and lane groups
- focus IDs and working labels
- explicit AND and OR prerequisite groups
- mutual exclusions
- route locks
- bypasses and availability
- fixed and relative positions
- pinned coordinates
- automatically placed coordinates
- hidden, crisis, and conditional branches
- convergence nodes
- shared support branches
- continuous focuses
- icons, localisation, AI weights, and filters
- decision, event, idea, leader, formable, and scripted-helper links
- raw passthrough fields

Import existing focus script into the model without losing unsupported content. Detect drift between a saved planning manifest and hand-edited script. Block destructive regeneration until the coding agent identifies the authoritative source.

## Constraint layout

Create a stable constraint-based layout system. It should keep parents above children, avoid duplicate coordinates and visible overlaps, separate route families, space mutual exclusions clearly, preserve pinned nodes, minimize avoidable crossing lines, and place convergence points cleanly.

A small edit must not rearrange the whole tree. Record layout decisions and explain unsatisfied constraints. Never solve an impossible layout by silently stacking nodes or changing prerequisite meaning.

## Agent visualization artifacts

Generate interactive HTML, SVG, PNG, and JSON graph artifacts for the calling coding agent.

The visualizer should show:

- focus icon when available
- focus title or working label
- focus ID and coordinates
- prerequisite type
- mutual exclusions
- branch family
- hidden or conditional status
- convergence and terminal nodes
- AI route metadata
- missing icons and localisation
- warnings linked to source locations

HTML artifacts may support search, zoom, branch hiding, route filters, and node inspection. They are review artifacts returned through MCP resources, not a separate human-operated editor.

## Linting

Detect at least:

- duplicate focus IDs
- duplicate coordinates
- prerequisite cycles
- missing prerequisite targets
- unreachable or isolated nodes
- malformed AND and OR logic
- contradictory mutual exclusions
- invalid relative-position targets
- hidden branches without a reveal path
- impossible route locks
- visible overlaps
- avoidable connector crossings
- weak dangling branches
- terminal nodes with no meaningful payoff
- missing icons, localisation, filters, or major-route AI
- broken references to decisions, events, ideas, leaders, formables, and helpers
- unsafe runtime tree replacement for an existing country
- repeated generic reward patterns when reliable static detection is possible

Separate script errors, reference errors, layout warnings, and design warnings. Do not rewrite gameplay meaning automatically.

## MCP operations

Expose agent tools for scan, import, lint, layout plan, render, transaction diff, transaction apply, and export. Exact public schemas belong in `06_public_mcp_server.md` and the shared schema package.

Every generated focus block needs a source map back to its plan node. Every applied change needs a transaction manifest and rollback record.

## Acceptance fixture

Create a standalone-project-owned synthetic tree with at least 250 focuses, ten route families, mutual-exclusion forks, convergence points, hidden branches, crisis branches, shared support branches, relative positions, pinned positions, continuous focuses, and cross-links to decisions and events.

The module must produce stable repeated layouts, no duplicate coordinates, no cycles, no overlaps, and complete HTML, SVG, PNG, JSON, and validation artifacts. Intentionally invalid variants must be detected.

Also run local integration tests against a large vanilla tree and at least one external mod workspace without copying external source into this repository.

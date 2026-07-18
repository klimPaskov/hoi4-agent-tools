# Technology Tree Viewer

## Purpose

Give coding agents a source-linked view of large HOI4 technology and doctrine systems that are difficult to understand from raw files alone.

The viewer must clarify prerequisite flow, folder placement, exclusive branches, unlocks, research bonus categories, external grants, icons, localisation, AI metadata, and cross-file dependencies. It is a read-only MCP tool family. It does not generate technologies, rewrite source, choose balance, launch HOI4, or simulate research.

The tool is useful only when it helps a coding agent answer concrete questions and find final defects. A graph with boxes and arrows is not enough.

## Questions the tool must answer

The calling coding agent must be able to ask:

- Which technologies must be researched before this technology?
- Which technologies can follow it?
- In which folders and coordinates does it appear?
- Why is a technology missing, disconnected, hidden, or shown in the wrong place?
- Which exclusive or doctrine choice blocks another branch?
- What equipment, modules, sub-units, buildings, abilities, modifiers, or other content does it unlock?
- Which technology categories and tags contain it?
- Which focuses, events, decisions, history files, startup effects, or scripted effects grant it or give a bonus for it?
- Which countries begin with it through visible source data?
- What references would break if a technology, category, folder, or unlock target were renamed or removed?
- What changed in the tree after a patch?
- Which findings are confirmed defects, likely defects, design warnings, or unsupported analysis?

## Source coverage

Use the shared parser, workspace resolver, source map, and project index. Inspect the current installed game documentation and vanilla files before finalising supported fields and paths.

Index the supported forms of:

- technology definitions
- technology folders and positions
- prerequisite and `leads_to` paths
- edge research-cost coefficients
- exclusive and doctrine choices
- technology categories and tags
- research bonuses and technology-specific bonuses
- technology-sharing references
- equipment, equipment modules, sub-units, unit categories, buildings, abilities, and other unlock targets
- country history and startup technology grants
- focus, event, decision, mission, on-action, and scripted-effect grants or research bonuses
- AI research metadata
- technology localisation
- technology sprites, icons, folder backgrounds, and referenced textures
- vanilla, active-mod, and dependency-mod overrides in load order

Do not assume that one HOI4 version or one mod uses every field. Unsupported fields must stay visible as raw source with an analysis status.

## Technology graph model

Represent at least:

- technology nodes
- folder-placement instances
- prerequisite edges
- exclusive-choice edges
- category and tag nodes
- external grant and research-bonus entry nodes
- unlock-target nodes
- unresolved dynamic-reference nodes
- branch roots and terminal nodes

A technology may appear in more than one folder. Keep the technology identity separate from each visual placement.

Every relationship must include exact source provenance. A prerequisite edge should include its source technology, destination technology, edge coefficient when present, file, source location, and load-order origin. External grants and bonuses should include the calling focus, event, decision, history block, helper call chain, and source location when resolvable.

Never invent a target for dynamic or meta-generated references. Preserve the expression, confidence, and unsupported reason.

## Tree reconstruction and layout

Build a semantic dependency graph and a folder-accurate presentation graph.

The folder view must use source folder assignments and coordinates. It should reveal overlaps, misplaced nodes, duplicate placements, missing positions, and disconnected visual branches. It must not silently auto-place missing technologies and present the result as source truth.

An optional analysis layout may arrange unresolved or unplaced nodes for inspection. Label that layout clearly as generated analysis.

Reuse stable graph and rendering primitives from Focus Tree Workbench where useful. Do not reuse focus-specific prerequisite, route, or layout semantics when technology behavior differs.

Handle cycles and exclusive branches explicitly. Repeated renders of unchanged source must keep stable node IDs, edge IDs, ordering, and positions.

## Agent-readable views

Return JSON as the authoritative representation. Generate SVG, PNG, and optional HTML MCP resources for:

- workspace technology summary
- per-folder source layout
- complete semantic dependency overview
- selected technology with prerequisites and descendants
- branch and doctrine view
- exclusive-choice view
- category and tag membership matrix
- research-bonus coverage matrix
- external grant and starting-technology map
- unlock-impact view
- year, cost, and AI metadata overlay
- icon and localisation coverage
- hidden, unplaced, orphaned, and unresolved technology view
- before-and-after structural comparison
- removal or rename impact report

Large trees must produce an overview plus focused folder and branch resources. Do not place every node and unlock target into one unreadable image.

## Technology explanation

Provide a structured explanation for a selected technology or path.

The result should include:

- technology ID and source definition
- localisation and icon status
- folder placements and coordinates
- direct and transitive prerequisites
- descendants
- exclusive choices
- start year and research cost
- edge coefficients
- categories and tags
- AI metadata
- modifiers and effect keys as source-linked summaries
- equipment, module, sub-unit, building, and other unlocks
- external grants
- matching research-bonus sources
- unresolved references and confidence limits

The viewer may summarise known effects. It must not assign a balance score or claim that one branch is stronger without a separate evidence-based balance analysis.

## Structural diagnostics

Detect at least:

- duplicate technology IDs after load-order resolution
- missing `leads_to` or prerequisite targets
- prerequisite cycles
- accidental self-links
- folder references that do not resolve
- duplicate or overlapping coordinates inside the same folder
- conflicting placements for the same technology
- visible technologies with no valid root path
- disconnected branch segments
- hidden or unplaced technologies with no discovered grant path
- invalid or unresolved exclusive-choice targets
- exclusive or doctrine branches whose visible path is structurally impossible
- child technologies dated earlier than all visible parents
- research-cost or edge-coefficient outliers relative to nearby branch peers
- technologies with no visible effect, modifier, unlock, or routing role
- terminal technologies with no visible effect or unlock
- missing technology localisation
- missing or invalid technology sprites and textures
- unlock references to missing equipment, modules, sub-units, buildings, or other indexed targets
- external grants or bonuses that reference missing technologies
- category and tag references that do not resolve
- research-bonus categories that match no indexed technology
- visible branches with missing or zero AI willingness where that appears unintended
- duplicate or suspiciously identical effect and unlock signatures
- removed or renamed technologies that retain callers, grants, bonuses, unlocks, localisation, or sprite references
- newly disconnected roots, branches, folders, or unlock targets in comparisons

Classify findings as confirmed errors, probable defects, design warnings, or unresolved analysis. A root technology, hidden grant-only technology, early-year child, zero AI weight, repeated effect, or empty-looking routing technology is not automatically wrong.

## Comparison and impact analysis

Compare two revisions, snapshots, transactions, or source states.

Report:

- technologies added, removed, renamed, or moved
- prerequisite and exclusivity edges added or removed
- folder and coordinate changes
- year, cost, AI, category, tag, effect, and unlock changes
- external grant and bonus changes
- localisation and icon changes
- new defects and resolved defects
- newly orphaned or newly reachable content
- references that would break from a proposed removal or rename

Separate regressions introduced by the comparison from issues that already existed in the baseline.

## MCP operations

Expose a compact read-only family using final project naming conventions. Required capabilities include:

- workspace technology scan
- folder and root discovery
- bounded prerequisite and descendant trace
- selected technology explanation
- unlock and external-grant inspection
- category and research-bonus coverage
- technology linting
- folder and semantic rendering
- structural comparison
- rename and removal impact analysis
- artifact description and retrieval

Suggested public names are:

- `tech_scan`
- `tech_folders`
- `tech_trace`
- `tech_explain`
- `tech_unlocks`
- `tech_bonus_coverage`
- `tech_lint`
- `tech_render`
- `tech_compare`
- `tech_impact`

Final names must follow the server's established namespace and versioning rules.

All operations are read-only. Do not add technology generation, automatic layout writing, balance correction, or source repair tools as part of this goal.

## Limits and confidence

This is static analysis. It must not claim to know:

- exact in-game research time after every modifier
- exact ahead-of-time behavior beyond documented static rules
- which technology the AI will choose at runtime
- whether a technology is balanced
- runtime results of unsupported scripted or dynamic grants
- exact visibility when required engine behavior is unsupported

Every result must record workspace identity, source revision or content hashes, analysis boundary, parser and schema version, load-order assumptions, unsupported constructs, confidence, and resource paths.

## Acceptance fixture

Create a project-owned synthetic technology system containing at least:

- 500 technologies
- at least 12 folders
- regular technologies and doctrine branches
- several exclusive branch families
- multiple folder placements
- visible and hidden grant-only technologies
- equipment, module, sub-unit, building, ability, and modifier unlocks
- categories, tags, research bonuses, technology sharing, and external grants
- country-history and startup grants
- focus, event, decision, mission, and scripted-effect bonus sources
- varied years, costs, edge coefficients, icons, localisation, and AI metadata
- intentional cycles, missing targets, overlaps, orphaned technologies, unresolved dynamic references, invalid bonus categories, missing unlock targets, and stale rename references

Maintain an expected graph and reference manifest. Tests must prove exact node and edge discovery, source provenance, folder placement, path explanations, unlock mapping, grant mapping, bonus coverage, diagnostic classification, comparison accuracy, stable renders, cancellation, resource retrieval, and incremental re-indexing.

Run read-only local integration tests against large vanilla technology and doctrine families and at least one external mod workspace. Do not copy external source or proprietary assets into the public repository.

## Completion standard

The Technology Tree Viewer is complete only when a coding agent can inspect an unfamiliar large technology system, understand its folders and prerequisite paths, explain what selected technologies unlock, find every discovered grant and bonus source, identify structural and reference flaws, and compare the tree before and after a patch without launching the game.

A generic dependency graph, raw technology list, folder screenshot, or missing-reference grep does not satisfy this specification.

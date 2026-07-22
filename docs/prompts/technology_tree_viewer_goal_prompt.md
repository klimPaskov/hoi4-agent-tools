# Goal: Add the Technology Tree Viewer

Add a fifth public MCP tool family for coding agents. Read architecture and MCP docs, and:

Inspect installed HOI4 documentation, offline technology references, vanilla technology and doctrine files, folder definitions, equipment and module files, localisation, sprites, and parser support.

## Purpose

Implement a read-only Technology Tree Viewer that makes large technology systems clear to coding agents. It must reconstruct prerequisites, source folder placements, exclusive and doctrine branches, categories, tags, unlocks, research bonuses, external grants, AI metadata, icons, localisation, and cross-file references.

Do not build a human editor, generator, automatic repair tool, balance scorer, runtime simulator, or game launcher. Coding agents remain responsible for writing and reviewing Clausewitz source.

## Required implementation

Reuse the shared workspace resolver, parser, source map, load-order model, symbol index, diagnostics, artifacts, caching, and MCP infrastructure. Do not create another technology parser or isolated index.

Keep technology identity separate from folder-placement instances. Build typed, source-linked relationships for prerequisites, `leads_to` paths, edge coefficients, exclusive choices, categories, tags, grants, bonuses, and indexed unlock targets. Preserve unresolved dynamic references with confidence and blocker data. Never invent a target.

Provide source-accurate folder views and semantic dependency views. Source views use real folder assignments and coordinates. Generated analysis layouts must be labelled.

Return authoritative JSON plus focused visual resources for folder layouts, dependency views, selected paths, doctrine branches, unlock impact, bonus coverage, external grants, metadata overlays, asset coverage, unresolved content, and structural comparison. Large trees require overview and bounded artifacts.

Expose read-only capabilities for scan, folder discovery, prerequisite and descendant trace, technology explanation, unlock inspection, bonus coverage, lint, render, compare, and impact analysis. Use established MCP schemas, annotations, progress, cancellation, and resource conventions.

Apply every diagnostic and confidence rule in `specs/08_technology_tree_viewer.md`. Separate confirmed errors, probable defects, design warnings, and unresolved analysis. Roots, grant-only technologies, zero AI weights, early dates, repeated effects, and routing nodes are not automatic defects.

## Integration and acceptance

Update indexing, MCP tools, resources, prompts, server instructions, package metadata, README, changelog, documentation, capability metadata, and Registry descriptions. Reuse shared graph and rendering primitives without importing focus-specific semantics.

Create the required fixture with at least 500 technologies, 12 folders, doctrine and exclusive branches, multiple placements, unlock targets, categories, bonuses, grants, and intentional defects. Maintain an expected graph and reference manifest. Prove path reconstruction, placement accuracy, unlock and grant mapping, bonus coverage, provenance, diagnostics, comparison, stable renders, incremental indexing, cancellation, and resource retrieval.

Run read-only tests against large vanilla technology and doctrine families and one external mod workspace without copying source or assets.

Keep iterating until the full specification is satisfied. Do not claim completion while any required view, diagnostic, fixture, resource, comparison, provenance record, or limitation report is missing. Report every unsupported construct, simplification, omission, and blocker.

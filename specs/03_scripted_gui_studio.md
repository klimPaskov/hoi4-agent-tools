# Scripted GUI Studio

## Purpose

Give coding agents MCP tools for building and verifying very large HOI4 interfaces and scripted GUI systems. The module should improve hierarchy, alignment, state coverage, reference tracking, and iteration speed without simplifying the intended interface.

The studio renders GUI artifacts for the coding agent. It must not launch, automate, control, or capture screenshots from Hearts of Iron IV. It must not provide an interactive GUI editor.

## Source graph

Parse and connect:

- `.gui`
- `.gfx`
- `common/scripted_guis`
- localisation and scripted localisation
- sprite and texture definitions
- frame-animated sprite definitions
- button effects and triggers
- parent windows and context types
- decision-category entry points
- fonts available in the installed game

Build a scene graph with source locations. Preserve unsupported properties as raw source blocks.

## Build-time layout helpers

Provide optional declarative helpers for anchors, rows, columns, stacks, grids, padding, margins, reusable cards, tabs, scroll lists, target rows, meters, status panels, modal windows, overlays, and UI states.

Compile helpers into normal explicit HOI4 GUI code. The final game must not depend on the tool. Always provide a raw HOI4 escape hatch so advanced UI is never limited by the helper schema.

## Offline renderer

Build a deterministic renderer that reads available sprites, fonts, positions, scales, clipping, parent offsets, localisation, scripted mock values, and selected animation frames.

Generate MCP artifacts for:

- full-window render
- cropped interface render
- annotated render with bounds and IDs
- click-region overlay
- hierarchy view
- source-location map
- state gallery
- resolution and UI-scale gallery
- before-and-after comparison
- JSON layout report

Support normal, hover, selected, locked, disabled, warning, active, completed, empty-list, full-list, minimum-value, maximum-value, long-text, and missing-localisation states.

Allow the coding agent to define preview scenarios with mock country, state, variable, flag, list, localisation, and scripted-GUI values. Store the scenario beside the generated artifacts so another agent can reproduce the render.

The images are the studio's own representation of the parsed GUI. Never describe them as screenshots from the game. Report unsupported or partially modelled fields instead of inventing their appearance.

## Rendering fidelity

Model:

- nested parent offsets
- clipping and container bounds
- element scale
- sprite dimensions
- frame selection
- text alignment and wrapping
- font metrics
- button and icon states
- z-order
- scroll-list row placement
- visibility state
- animation frame sampling

Keep the rendering model modular. Every render must include a fidelity report listing fully modelled fields, approximated fields, ignored fields, missing assets, and unresolved dynamic values.

## Visual and script validation

Detect at least:

- overlapping visible elements
- accidental clipping
- text overflow
- inconsistent alignment and spacing
- invalid sizes
- children outside clipped parents
- mismatched visible and clickable bounds
- invisible click blockers
- conflicting click regions
- missing sprites, textures, fonts, or localisation
- incorrect frame count or sheet dimensions
- missing static animation fallback
- invalid parent window or scripted GUI context
- z-order risks
- scroll rows cut off by the container
- resolution-dependent drift
- tab content visible in conflicting states
- buttons without matching triggers or effects
- GUI costs that disagree with script
- player actions with no AI equivalent when AI countries use the system
- fields the renderer cannot model reliably

Use actual font metrics and source values. Do not rely on OCR as the main text-layout validator.

## Animation

Integrate with frame-sheet rules. Verify source frames, identical processed dimensions, sheet dimensions, frame count, animation rate, loop behavior, `play_on_show`, stable anchors, transparency, and static fallbacks. A GIF is an optional review artifact only.

The renderer may produce selected-frame and animated review artifacts from the real frame sheet. It must not create fake motion from one still image.

## MCP operations

Expose agent tools for scan, lint, render, render-state matrix, compare, and one-call source rewrite. `gui_rewrite` performs proposal compilation, reparsing, rendering, validation, journaling, mutation, and post-write validation inside one authorized request. The primary workflow has no caller-managed transaction diff, transaction ID, plan hash, separate apply, or rollback call.

## Acceptance fixture

Build a synthetic interface with at least five tabs, a scrollable dynamic list, target cards, meters, scripted values, normal and alternate button states, tooltips, long localisation, animation, a modal confirmation window, and at least 150 visible or state-dependent elements.

Produce reproducible state galleries, annotated renders, comparisons, resolution and UI-scale matrices, hierarchy reports, source maps, reference validation, click-region validation, fidelity reports, and defect fixtures for overlap and clipping.

The fixture passes only when every intentional defect is detected, supported elements render consistently, repeated renders are deterministic, and unsupported fields are reported clearly. It must also prove that an autonomous `gui_rewrite` completes in one call, blockers leave source untouched, and a failed post-write check restores exact original bytes automatically. No part of the fixture may launch or automate the game.

# Scripted GUIs

Use `hoi4.gui_inspect`, `hoi4.gui_render`, and `hoi4.gui_rewrite` for `.gui`, `.gfx`, `common/scripted_guis`, localisation, sprites, fonts, and linked decision entry points. Omit `workspaceId` when the MCP working directory is inside the target mod.

## Create a GUI

`hoi4.gui_rewrite` can work from supported source, targeted patches, or structured helpers. Source and helper rewrites may include one bounded text package: the main `.gui` plus additional interface `.gui`/`.gfx`, configured GFX `.gfx`, `common/scripted_guis/*.txt`, and localisation `.yml` files. The package is path-checked, parsed, linked, rendered, validated, and applied together in one rewrite. Existing text encodings are retained, while localisation is always written as UTF-8 with BOM.

A package may contain at most 32 text files and 16 MiB of encoded source in total. Paths are compared portably, so aliases that differ only by letter case are rejected.

Helpers cover common layouts such as anchors, rows, columns, stacks, grids, cards, tabs, scroll lists, meters, status panels, modals, and overlays. They compile to ordinary HOI4 GUI source; the finished mod has no runtime dependency on this server. Binary textures, fonts, and other art are referenced from `.gfx`/GUI source and must already exist in the workspace; the rewrite input does not upload binary art.

Before writing:

- define the root window, parent/context, element IDs, and dimensions;
- register sprites, textures, fonts, and localisation used on screen;
- provide button triggers, effects, scripted-GUI properties, dynamic-list wiring, and AI behavior where required;
- render the important states and resolutions;
- keep click regions aligned with visible controls.

Rewrite once, then inspect and render the result.

## Clean an existing GUI

1. Inspect the root window and its linked GUI, GFX, scripted-GUI, and localisation source.
2. Render the normal state and the states relevant to the task, such as hover, selected, disabled, warning, empty list, full list, minimum value, maximum value, or long text.
3. Check common resolutions and UI scales when positioning or clipping can change.
4. Fix the existing mod-owned file with targeted patches, a complete supported source replacement, or a structured helper replacement.
5. Rewrite once, then inspect and render the result.

Inspection checks missing assets and localisation, invalid sizes, overlap, clipping, overflow, conflicting click regions, invisible blockers, broken parents or contexts, list-row cuts, state conflicts, trigger/effect gaps, and resolution drift.

## Offline preview limits

The renderer does not run the game engine. Each render includes a fidelity report that separates fields it models from fields it approximates, ignores, cannot resolve, or does not support. Treat that report as part of the review.

A rewrite stops if malformed or unsupported GUI script makes the requested change ambiguous. Runtime animation, masking, tiling, hardcoded controls, and dynamic values may require exact game precedents even when a useful offline preview is available.

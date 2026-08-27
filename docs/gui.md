# Scripted GUIs

Use `hoi4.gui_inspect`, `hoi4.gui_render`, and `hoi4.gui_rewrite` for `.gui`, `.gfx`, `common/scripted_guis`, localisation, sprites, fonts, and linked decision entry points.

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
3. Add `relatedScenarios` for every meaningful value-driven version of the window, such as open and closed panels, empty and populated lists, unlocked and locked actions, low and high values, and alternate scripted-GUI property results.
4. Check common resolutions and UI scales when positioning or clipping can change.
5. Fix the existing mod-owned file with targeted patches, a complete supported source replacement, or a structured helper replacement.
6. Rewrite once, then inspect and render the result.

Inspection checks missing assets and localisation, invalid sizes, overlap, clipping, overflow, button-label centering, content crossing a background boundary, conflicting click regions, invisible blockers, broken parents or contexts, list-row cuts, state conflicts, trigger/effect gaps, and resolution drift. `hoi4.gui_render` returns a scripted-scenario gallery and JSON delta report alongside the generic state and resolution galleries.

The renderer resolves sprites and fonts through the complete mod, dependency, and installed-game load order. Mod windows therefore render ordinary vanilla sprites, tiled vanilla panels, progress bars, masked shields, button frames, and localisation icons such as `£command_power` without copying game assets into the mod. Case differences in GFX and font identifiers do not prevent a valid asset from resolving.

Bitmap text uses the language-appropriate HOI4 font definition and its real glyph atlas. The default language uses the base font rather than an unrelated language override, and the renderer recognizes installed-game atlases whose filename omits a page suffix declared by the matching `.fnt` file.

Layout follows Clausewitz orientation and element-origin anchors, including `CENTER_LEFT`, `CENTER_RIGHT`, `CENTER_UP`, `CENTER_DOWN`, `origo`, `centerposition`, inherited container coordinate origins, local scale, and both `%` and `%%` relative dimensions. Text boxes use native font metrics together with `maxWidth`, `maxHeight`, alignment, wrapping, and `fixedsize` clipping. Cornered tile sprites use fixed nine-slice borders and optional center tiling; progress bars composite their filled and background textures; masked shields composite their background and mask textures.

Scripted-GUI composition follows `parent_scripted_gui` chains even when the linked child window is a top-level sibling in the `.gui` file. Literal `always = yes` and `always = no` visibility and click-enabled blocks are applied automatically. Scenario properties can select an element image or frame, move it with `.x` and `.y`, and control `.visible` or `.enabled` values. Dynamic lists instantiate their declared `entry_container` or `country_scope_entry_container`; each scenario row can select the country template with `countryScope`, choose an explicit `entryContainer`, and provide row-scoped text, image, frame, position, visibility, and enabled values.

Preview scenarios can include exact layout expectations:

```json
{
  "id": "populated-unlocked",
  "flags": { "panel_open": true },
  "lists": { "target_list": [{ "id": 1, "label": "First target" }] },
  "visibility": { "target_list": true, "confirm_button": true },
  "expectations": {
    "visible": ["target_list", "confirm_button"],
    "hidden": ["empty_message"],
    "containedBy": { "confirm_button": "main_panel" },
    "centeredOn": { "confirm_label": "confirm_button" }
  }
}
```

Selectors accept an element name, instance ID, or source ID. Visibility expectations diagnose elements that are missing or in the wrong scripted version. `containedBy` diagnoses text or controls that leave their intended background or panel. `centeredOn` uses rendered glyph bounds, so it catches labels that occupy the right text box but are visibly off-center on the button.

Broad inspection indexes localisation actually referenced by GUI source and returns a connected workspace projection when the complete source graph is very large. The resource records full and returned node and edge counts, so an agent can identify the relevant window without loading unrelated vanilla UI into its prompt. Rendering remains targeted to the selected root, state, and resolution.

GUI rewrites keep complete validation evidence in a linked JSON resource and retain the highest-priority findings in the transaction result. Large surrounding interface inventories therefore do not turn a small scalar patch into a transaction structure-limit error.

Large inspections, renders, and rewrites send periodic MCP progress heartbeats while a service stage is still running. Clients that request progress can reset their idle request timer from these notifications; there is no 180-second GUI operation limit in the server, and cancellation still follows the request signal.

## Offline preview limits

The renderer does not run the game engine. Each render includes a fidelity report that separates fields it models from fields it approximates, ignores, cannot resolve, or does not support. Treat that report as part of the review.

Unresolved numeric runtime values such as `[?variable|format]` render as `[X]`. Unresolved text-returning scripted or scoped localisation such as `[GetStatusText]`, `[FROM.GetName]`, and `[?leader_scope.GetName]` renders as `[dynamic_loc]`. Provide scenario values when the exact value matters. Supported HOI4 `§` localisation colour controls are applied to preview text and `§!` restores the default colour.

A rewrite stops if malformed or unsupported GUI script makes the requested change ambiguous. Frame-sheet animation, nine-slice tiling, progress composition, masking, and the primary and secondary textures referenced by vanilla GFX definitions render offline. Engine shader programs, hardcoded controls, and dynamic values that are not supplied by a scenario remain fidelity-report entries; an unexecuted shader never hides its resolved base texture.

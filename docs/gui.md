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

The renderer resolves sprites and fonts through the complete mod, dependency, and installed-game load order. Mod windows therefore render ordinary vanilla sprites, tiled vanilla panels, progress bars, masked shields, button frames, country flags, and localisation icons such as `£command_power` without copying game assets into the mod. Case differences in GFX and font identifiers do not prevent a valid asset from resolving.

Bitmap text uses the language-appropriate HOI4 font definition and its real glyph atlas. Header, serif, compact, typewriter, black, inverted, and other declared faces keep their own glyph shapes, native metrics, face colour, border colour, language override, and font-specific `textcolors` palette. The renderer reads BMFont channel roles, separates face and outline coverage, and recognizes both vanilla black-on-white masks and conventional white-on-transparent custom masks. HOI4 localisation colour runs such as `§Y` and `§R` therefore colour the glyph face while retaining its sharp antialiasing and declared border instead of flattening the glyph into a blurred monochrome mask or switching to the tool font. The default language uses the base font rather than an unrelated language override, and the renderer recognizes installed-game atlases whose filename omits a page suffix declared by the matching `.fnt` file.

`uiScale` is the in-game UI scale, not an image zoom. Use `1` for native pixel geometry at any screen resolution. Bitmap-font glyphs come directly from the real atlas without a sharpening, threshold, opacity-gain, or reconstructed-edge pass. Native-size coverage is unchanged. Enlarged coverage uses restrained Lanczos2 interpolation to avoid blocky pixel replication without running a sharpening filter. Downscaling uses nearest-neighbour sampling. Bitmap placement is snapped to the output pixel grid, and bitmap colours use alpha masks, so native, fractional-scale, local, and VPS renders remain deterministic.

Layout follows Clausewitz orientation and element-origin anchors, including `CENTER_LEFT`, `CENTER_RIGHT`, `CENTER_UP`, `CENTER_DOWN`, `origo`, `centerposition`, inherited container coordinate origins, local scale, and both `%` and `%%` relative dimensions. Text boxes use native font metrics together with `maxWidth`, `maxHeight`, alignment, wrapping, and `fixedsize` clipping. Cornered tile sprites use fixed nine-slice borders and optional center tiling; progress bars composite their filled and background textures; masked shields composite their background and mask textures.

A single-percent dimension is a proportional extent; a double-percent dimension names the far edge in the parent and subtracts the element's resolved anchor position.
For example, a centered root at y=423 with `height=85%%` in a 1440-pixel viewport ends at y=1224 and has height 801, rather than height 1224.
GUI element type matching is case-insensitive while source spelling and bytes are preserved.
A zero horizontal or vertical corner border produces the corresponding three-slice composition rather than stretching the entire texture.
Colour-only progress sprites use their declared size, `color` and `colortwo` without requiring a texture.
The supported source-backed progress shader selects a colour or texture on each side of its progress threshold; semi-transparent primary pixels do not blend over a second complete texture layer.
The scene records the selected shader source, hash and entry point.
Additional shader operations, including animated end-cap sampling, remain explicit unsupported findings rather than accepted pixel-parity evidence.

Container scrollbars use referenced or inline `extendedScrollbarType` templates, including their backgrounds, inline track, thumb and end-button artwork.
Each attachment has independent instance IDs and source provenance even when multiple containers reuse one template.
The renderer measures direct content bounds and populated grid/list rows, retaining declared list bounds as a minimum, clamps scroll offsets, and applies `autohide_scrollbars`.
A nested container contributes its declared bounds rather than the overflowing artwork of its descendants.
Margins inset both the scrolling clip and the attached scrollbar's axis span without adding layout padding; children wholly inside a fixed border remain stationary.
Clipping is resolved after scroll positioning, so off-screen content can scroll into view and nested scrolling retains the correct ancestor boundaries.
Visible orthogonal scrollbars reserve their anchored gutters to avoid overlapping end controls.
Native corner-space behavior still needs matching in-game reference qualification; synthetic non-overlap checks alone do not establish engine parity.

Supply `values["container.scrollX"]` and `values["container.scrollY"]` in native UI pixels; these keys also work inside list rows.
The existing `scrollOffsets` map remains a vertical-offset shorthand, including names with row-instance suffixes.
`minimum-value` and `maximum-value` scenarios sample content endpoints.
The scene element's `scroll` record exposes its viewport, measured content dimensions, applied offsets and maximum offsets in output pixels after UI scaling.
Missing, wrong-axis, duplicate or privately scoped scrollbar references and unclipped/background-less containers produce explicit findings rather than invented templates.

Scripted-GUI composition follows `parent_scripted_gui` chains even when the linked child window is a top-level sibling in the `.gui` file. Literal `always = yes` and `always = no` visibility and click-enabled blocks are applied automatically. A scenario's `values` object supplies concrete runtime values in one place: variable names resolve numeric text, scripted-localisation names resolve dynamic labels, a progress-bar element name sets its fill value, and element keys ending in `.image`, `.frame`, `.x`, `.y`, `.visible`, or `.enabled` update that visual property. Scripted-GUI property expressions such as `image = "[GetMeterSprite]"` or `x = meter_fill_width` consume matching scenario values automatically. Dynamic text is parsed after scenario and scripted-localisation substitution, so a runtime string containing `£command_power` or `£[GetResourceIcon]` renders the resolved inline HOI4 text icon instead of literal marker text. Dynamic lists instantiate their declared `entry_container` or `country_scope_entry_container`; each scenario row can select the country template with `countryScope`, choose an explicit `entryContainer`, provide `countryTag` and `ideology` for `GetFlag`, and supply row-scoped text, image, frame, position, visibility, and enabled values. Masked country sprites use the actual mask and overlay dimensions, so custom flag sizes are discovered from GFX assets rather than assumed by the renderer.

Native lists can also use an explicit `entryContainer` without fabricated scripted-GUI wiring.
Each expanded row instance includes its owning list identity, so two lists using the same template cannot overwrite one another's clipping or geometry.
For native country-flag controls, bind `element_name.countryTag` and `element_name.ideology` in scenario or row values.
Only valid bounded tag tokens enter asset discovery; an invalid tag is reported, not converted into a different country's identifier or a filesystem path.
An unrelated global country value does not turn every native icon into a flag.

`hoi4.gui_inspect` and `hoi4.gui_render` generate a seeded exploratory preview by default. The generator follows the complete `parent_scripted_gui` surface, discovers numeric and text tokens, fills meters within their declared ranges, and populates dynamic lists with coherent rows. Scripted-localisation text and sprite branches use the same structured condition evaluator as probability analysis, including compound conditions, inclusive comparisons, constants, declared scopes, and scripted triggers. An unknown earlier condition leaves the token unresolved instead of guessing a branch. The scenario's `conditionResults` records checked choices and missing inputs. Explicit values remain authoritative; generated inputs are not verified campaign state. Normal controls and animation frames remain stable unless variation is requested. Every explicit `relatedScenarios` entry is rendered beside the generated view.

Declare scoped facts with `scopes`, for example `"scopes": { "FROM": { "id": "target", "actor": "FRA", "state": { "support": 10 } } }`. Existing flat values such as `FROM.support` remain usable. Seeded pane and active/idle selection is exploratory layout sampling, not proof that every visibility branch is reachable.

Generation is reproducible. Set `generatedScenarios.seed` to any stable string for an exact rerun, use `count` for several plausible versions, or configure numeric bounds, integer or decimal values, list row bounds, text samples, visibility probability, and state variation. Generated numeric values favour ordinary mid-range states, obey literal limits such as `[?capacity]/10`, keep displayed current/limit pairs coherent, and remain inside progress-bar ranges. The generated view is the default. Set `enabled` to `false` when only the supplied placeholder scenario should render, or set `preservePlaceholder` to `true` to include the placeholder beside generated scenarios.

```json
{
  "generatedScenarios": {
    "seed": "chaos-meter-review",
    "count": 3,
    "numericMinimum": 0,
    "numericMaximum": 100,
    "listRowsMinimum": 2,
    "listRowsMaximum": 8,
    "trueProbability": 0.75,
    "textSamples": ["Stable", "Escalating", "Critical"]
  }
}
```

Preview scenarios can include exact layout expectations:

```json
{
  "id": "populated-unlocked",
  "values": {
    "threat": 73,
    "GetThreatLabel": "High",
    "GetCostLine": "Cost £command_power 20",
    "threat_meter": 73,
    "confirm_button.enabled": true
  },
  "flags": { "panel_open": true },
  "lists": {
    "target_list": [
      {
        "id": 1,
        "label": "France",
        "countryScope": true,
        "countryTag": "FRA",
        "ideology": "democratic"
      }
    ]
  },
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

## Source-backed button shading

The renderer reads referenced shader source, including legacy `.lua` references whose implementation is a `.shader` file.
For supported native sprite transforms and straight-alpha blending, a bounded interpreter derives affine RGBA colour operations from the selected normal, hover, pressed or disabled pixel program.
It supports scalar/vector arithmetic, swizzles, constant interpolation, dot products and clock-dependent constant expressions without executing shader code or arbitrary functions.
The scene records source identity, effect and entry point; unresolved features, nonlinear sampled-colour operations, additional texture samples and unsupported geometry or blend states remain fidelity findings.
Supported primary samplers retain point or linear filtering for magnification and minification and use clamped, non-mipmapped texture sampling.

Button shading is independent of explicit atlas frames and checkbox checked state.
Use `values["element.checked"]` for a checkbox's Boolean state, `values["element.pressed"]` for a held button, and `values["element.stateTimeSeconds"]` for elapsed time in the current button state.
These keys also work in list rows.
Without a per-element state clock, `animationTimeSeconds` supplies elapsed time; `0` represents entry into the state, not a settled hover.
Source or scenario `enabled = false` selects disabled appearance and removes the control from click regions.

## Scenario fidelity

The renderer does not run the game engine. Each render includes a fidelity report that separates fields it models from fields it approximates, ignores, cannot resolve, or does not support. Treat that report as part of the review.

The generated primary view replaces discovered numeric and text runtime tokens with plausible values. Set `generatedScenarios.preservePlaceholder` to `true`, or disable generation, when the same run should also show unresolved numeric values such as `[?variable|format]` as `[X]` and unresolved text-returning scripted or scoped localisation such as `[GetStatusText]`, `[FROM.GetName]`, and `[?leader_scope.GetName]` as `[dynamic_loc]`. Put `variable` or `GetStatusText` in the supplied scenario's `values` object when an exact value matters; explicit values always take precedence over generated ones and can drive the related meter or state-dependent controls. Supported HOI4 `§` localisation colour controls use the active font's palette and `§!` restores the face colour.

A rewrite stops if malformed or unsupported GUI script makes the requested change ambiguous. Frame-sheet animation, nine-slice tiling, progress composition, masking, and the primary and secondary textures referenced by vanilla GFX definitions render offline. Font selection follows mod/game load order and preview language, accepts Paradox hex and numeric color declarations, and uses the supplied HOI4 bitmap or outline font assets without requiring host font installation. Shader operations outside the supported colour subset, hardcoded controls, and dynamic values that are not supplied by a scenario remain fidelity-report entries; an unexecuted shader never hides its resolved base texture.

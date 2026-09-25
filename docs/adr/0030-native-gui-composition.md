# Native GUI composition and source-backed inlay states

Status: implementation in progress, not release-qualified.

## Evidence and decision

User-supplied game captures exposed native-layout errors in offline previews.
The renderer must model installed GUI definitions and assets; mod source and comparison screenshots must not be moved, stretched, sharpened, or rewritten to conceal renderer errors.
Game screenshots and installed assets remain private opt-in evidence and are never distributed as public fixtures.

Screen resolution changes the viewport and anchor locations, not the scale of authored pixel coordinates.
Only `uiScale` changes native pixel geometry.
In the installed focus-inlay example, a 504 by 468 logical container owns a 552 by 516 fixed background texture.
Fixed backgrounds retain texture dimensions, while cornered backgrounds use container dimensions and declared native borders.
Repeated backgrounds are independent ordered layers with their own positions and source-owner provenance.
Background-boundary validation uses those painted layers, and crop bounds use painted content rather than empty logical text-box space.

Text supports the native `centre` spelling and explicit vertical alignment.
Horizontal centering must not implicitly vertically center a text box.
The native 200-pixel default text-box width is calibrated from the supplied inlay capture and its installed definition; explicitly declared widths remain authoritative.
Negative container extents resolve as far-edge insets after the local position.
Literal `hide` and `visible` values participate in inherited visibility.
Source visibility is inherited separately from clip intersection, so a non-clipping off-screen ancestor does not hide a child that paints inside the viewport.
Sibling priorities remain inside the parent stacking context rather than lifting controls across unrelated rows.

Ordinary `scrollbarType` children are role templates.
Track, thumb, and end buttons are composed from control bounds, source borders, native sprite dimensions, and supplied values instead of drawing placeholder coordinates.
The installed settings arrow frames measure 23 by 21 pixels, while the control height is 16; native artwork must not be distorted to fit that logical height.
Pixel-level placement of these overhanging parts still requires screenshot comparison.

Focus inlays under `common/focus_inlay_windows` are retained as source-backed scripted interfaces in the GUI graph.
Ordered image choices, visibility, button availability, and variable-driven progress use the shared condition evaluator.
An unresolved earlier image predicate must not be skipped to claim that a later choice matched.
Click effects remain read-only graph evidence and are never executed by rendering.
Explicit scenario facts and property overrides remain authoritative.

Native grid rows can explicitly select `entryContainer` without fabricated scripted-GUI definitions.
Horizontal and vertical slot limits determine row placement.
A row may bind a nested list using `child_list_name.list` with a key in `scenario.lists`, preserving flat, bounded inputs and independent nested rows.
Referenced templates and external scrollbar definitions participate in layout and asset discovery.
Extended scrollbar attachments compose inline role definitions using their source positions, native dimensions, independently instanced provenance and container-sized scrolling axis.
Content bounds retain declared grid dimensions as a minimum, include overflowing populated rows, and stop at nested container boundaries.
Scenario offsets are clamped to measured ranges, margins keep fixed-border children stationary, attached scrollbars anchor to the outer window, and autohide does not reserve an absent scrollbar.
Clip chains retain references to owning geometry until final positioning so nested scrolling does not permanently hide previously off-screen descendants.
Simultaneous horizontal and vertical scrollbars reserve their actual anchored cross-axis gutters, including source insets.
This corner-space rule is an inferred composition contract supported by non-overlap regressions, not yet a verified match to an in-game two-axis capture.

## Validation and remaining work

`tests/unit/gui-native-layout.test.ts` contains synthetic regressions for native dimensions, repeated backgrounds, text alignment, visibility, row stacking, ordinary scrollbar roles, inlay selection, unknown predicates, progress, and nested native templates.
The opt-in `tests/local/gui-native-fidelity.test.ts` reads an explicitly configured installed game through the same core GUI services used by MCP and optionally writes private output under `HOI4_GUI_FIDELITY_OUTPUT`.
It does not launch the game or change its files.

The inlay render demonstrates correct panel dimensions, selected/unselected overlays, description wrapping, and tier text using installed sources.
This is not proof of universal native-interface parity.
Portrait and native runtime bindings, comprehensive screenshot measurements, full platform qualification, publication, and side-by-side installation remain open.
The two-interface installed-source fixture passed on 2026-09-13 in 107.6 seconds, and the settings and inlay outputs were visually compared with the supplied captures.
The targeted GUI suite passed 71 assertions across four files after the native-layout changes.
These are local development results, not immutable release evidence or a universal pixel-parity gate.
The settings comparison exposed orange disabled arrows because native button-state shader operations were missing.
Installed GFX definitions refer to `buttonstate.lua`, while the implementation resides in `gfx/FX/buttonstate.shader`; the disabled branch computes luminance before normal colour multiplication.
Both that shader and `buttonstate_nodowneffect.shader` were inspected, including their normal, hover, pressed, and disabled paths.
Shader effects must be modeled from source with explicit unsupported boundaries, not approximated by arbitrarily selecting atlas frames.
The renderer resolves referenced effect source, including the legacy `.lua` to `.shader` alias, and evaluates bounded affine RGBA expressions from the selected pixel program.
Supported expressions include scalar/vector arithmetic, swizzles, constant interpolation, dot products and clock-dependent constant calculations.
Native atlas-offset vertex transforms and straight-alpha blending are checked before accepting the colour result.
The primary sampler must bind texture slot zero with clamp addressing and no mip filtering; point and linear minification/magnification are retained separately.
Byte, token, statement, nesting and coefficient limits apply; the interpreter never executes JavaScript, HLSL, commands or user-defined functions.
Unknown feature branches, active sprite-animation or masking features, nonlinear sampled-colour operations, additional texture samples, unsupported geometry and unsupported blend states remain explicit fidelity findings.
The resulting SVG colour matrix uses sRGB channel arithmetic and affects only the sprite, not its label or adjacent controls.
The scene retains the shader source path, hash, selected effect and entry point.
Shader state selection is independent of explicit atlas frames and checkbox checked state.
`element.checked`, `element.pressed` and `element.stateTimeSeconds` values, including row values, provide concrete compound states without inferring them from unrelated animation frames.
Disabled source/scenario controls are also excluded from click regions.
The source-backed shader unit and existing GUI suites passed 94 tests across five files on 2026-09-13.
The installed-source checks compiled all eight normal/hover/pressed/disabled branches in the two inspected shader programs and re-rendered the Options and inlay examples in 107.7 seconds.
The Options render shows grayscale disabled arrows with checked boxes retained; this is still development evidence, not a full screenshot, native-control, release or installation acceptance pass.
The complete GUI suite passed 147 tests across 12 files after these changes, and a fresh installed-source run passed both tests in 118.0 seconds.
The project-owned stress fixture declares its compact 0.5 UI scale explicitly and uses cornered sprites for its stretchable panel, cards and modal.
Its 217 visible scene elements comprise the original 203 elements plus 14 independently tracked backgrounds.
The rendered fixture was visually reviewed before updating its deterministic PNG, SVG and layout baselines; the resolution matrix also retains a full native 1.0-scale case.
The user confirmed that all five in-game captures use 2560 by 1440 at UI scale 1.0, including the viewport-relative war overview.
Those values are the common comparison baseline; an unresolved native size discrepancy must not be hidden with a different viewport or forced output dimensions.
Other supplied captures cover the shared settings panel, scientist roster, portrait-heavy inlay, and paired war lists; those surfaces are not yet accepted as complete.

The first container-scrolling tranche passed 154 GUI tests across 13 files.
`tests/unit/gui-scrolling.test.ts` also covers both scrollbar axes, fractional UI scale, independent reused templates, nested scrolling, fixed margins, exact rendered pixels, invalid bindings, ambiguous inline role blocks, empty ranges and corner-space reservation.
The installed-template harness uses a project-owned temporary container and reads native `right_vertical_slider` and `bottom_horizontal_slider` definitions and their actual artwork/shaders from the opted-in installation.
Its initial minimum/maximum render exposed overlapping corner buttons.
After the corner-space change, the fresh installed-template endpoint check passed in 191.8 seconds and the minimum output was visually reviewed with separated end controls.
The complete GUI rerun passed 156 of 157 tests; one invalid-request test failed during temporary-directory cleanup because asynchronous cache initialization had not been awaited by its harness.
The harness waits for that initialization before returning.
The final fresh run passed all 159 GUI tests across 13 files in 100.9 seconds, including the short-list bounds and explicit scrollbar-visibility cases.
The installed-template minimum and maximum output images were both visually reviewed after gutter reservation.
These results remain development evidence, not a release or general in-game parity claim.

A read-only Chaos Redux source search found no override of the war window or its paired-list/background identifiers.
The live installed MCP inspection resolved the window to `game:interface/waroverview.gui` with complete source coverage and no changed files.
At the user-confirmed 2560 by 1440, scale 1.0 baseline, that installed renderer reported a 1556-pixel width for the authored 1167-pixel window, confirming the resolution-normalization defect corrected in the candidate.
The exact inspection request, source revision and resource identity are retained in the private fidelity workspace; no mod-owned source or proprietary output is distributed in public fixtures.
The user's subsequent uncropped 2560 by 1440 screenshot resolved the independent percentage-height discrepancy.
The installed root at x=697, y=423 has width 1167 and height 801: `85%%` supplies a far-edge coordinate, unlike the proportional extent supplied by `85%`.
Paired child containers consequently resolve to y=615 and height 576.96 using their own `96%%` extents.
Synthetic coverage includes nested percent dimensions, centered anchors, scaling, negative extents and collapsed double-percent bounds without automatic text/image expansion.
The native war harness passed in 69.5 seconds after case-insensitive element recognition, explicit country-flag bindings, independent row-instance identities, three-slice scrollbar backgrounds and margin-aware scrollbar spans were applied.
The public tests contain no game artwork or screenshot pixels.

Read-only pixel searches against the uncropped reference found exact RGB equality for sampled bottom-frame and close-button regions at zero displacement.
After the margin correction, sampled scrollbar up-arrow, down-arrow and thumb regions also have their best alignment at zero displacement, with mean absolute RGB differences of 0.015, 0.507 and 0.300 on a 0–255 scale respectively.
These are limited-region development measurements, not a whole-window or universal parity claim.
Both country rows are visible, but the current explicitly maximum-scroll scenario places their sampled border/text regions six pixels above the reference.
Removing or changing a scenario state merely to align pixels would not establish the native grid/scroll contract.
The scenario's zero surrender-bar fill also differs from the green primary fill visible in the capture; screenshot-matched runtime values must be separated from renderer defects.
Native grid placement, zero-range controller behavior, progress end-cap shaders, and remaining reference surfaces retain the explicit renderer boundaries described above; the release qualification is recorded below and does not convert those bounded comparisons into a whole-window parity claim.

The renderer additionally recognizes source-backed two-colour and two-texture threshold progress programs through their selected `Color` or `Texture` entry points, native vertex transform, sampler contracts and straight-alpha blend state.
It does not interpret arbitrary branches or execute shader code.
Pure-colour progress sprites retain declared dimensions without a texture, and filled/remainder regions are disjoint so alpha is not applied against a second complete texture layer.
Negative tests retain explicit unsupported findings for geometry changes, altered thresholds, extra sampled-colour operations, mismatched samplers, blend overrides, unbound features and excessive source bytes.
The targeted GUI run passed 111 existing/new checks while three progress-pixel fixtures initially used resolutions below the public schema minimum.
Those fixtures were corrected to valid 320 by 200 viewports without changing the tested pixel coordinates, and all 14 progress tests passed.
The subsequent complete GUI run passed 178 of 179 tests; only the expected row-identity SVG/layout baseline differed.
The reference PNG hash was unchanged, and an exact JSON comparison found 90 changes confined to row `id` and `parentId` fields.
The synthetic output was visually reviewed before accepting the two metadata-dependent hashes.
The fresh combined run passed all 179 GUI tests plus five checkpoint tests across 15 files in 191.1 seconds.
The concurrent opt-in war check passed in 149.6 seconds, including both installed `Color`/`Texture` threshold entry points and the scene's selected warscore shader.
The slower wall times include concurrently running installed-source scans and are not comparable performance benchmarks.
The combined local product check passed 1,215 tests with one skip across eight shards, then generated fixture and schema checks, build, package dry run, and Registry metadata validation on 2026-09-20.
After anchoring attached scrollbars to the outer container while keeping margins on the content viewport, the isolated installed-template test passed at both scroll endpoints in 109.3 seconds.
Both private endpoint images were visually reviewed; the native rail, thumb, and end buttons remain separated at the corner.
Release commit `ba598fa3a326f7e54bfce2b2b4069942887f9f84` passed the Windows/Linux and Node 22/24 matrix, both transports, coverage, the official MCP Inspector, container and publication checks. Version 3.4.0 was published to npm, GHCR, GitHub Releases and the MCP Registry and installed side-by-side for exact public-package verification.

# Native GUI composition and source-backed inlay states

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

## Shader and progress boundaries

Installed GFX definitions can name `buttonstate.lua` while the effect source is `gfx/FX/buttonstate.shader`. The renderer resolves that alias and evaluates bounded affine RGBA expressions from the selected pixel program, including the disabled-state luminance path. It checks the native atlas-offset transform, sampler contract, and straight-alpha blend before accepting a colour result. Unsupported feature branches, extra texture samples, nonlinear sampled-colour operations, geometry changes, or unsupported blend states remain explicit fidelity findings; source shader code is never executed.

Shader state follows the declared element state, including checked, pressed, and elapsed-state values, independently of atlas frames. Disabled controls are excluded from click regions. Two-colour and two-texture threshold progress programs use their selected entry points and preserve native dimensions. Filled and remainder regions are disjoint, so alpha is not applied against a second complete texture layer.

## Evidence boundary

Visibility and enablement carry three states: confirmed, rejected and unresolved under the declared scenario.
Unknown scripted triggers and dynamic boolean properties retain their reasons instead of contributing to confirmed branch coverage.
Preview appearance can remain visible or hovered while the corresponding interaction is unresolved; click overlays distinguish these potential regions from confirmed controls.
Explicit scenario overrides retain their meaning as declared inputs, not observations of the running game.

Immediate tooltip previews require an explicit target, viewport position, width and padding.
They resolve `pdx_tooltip` through the existing localisation, font and sprite pipeline using the source `ToolTip` sprite and `cg_16b` font.
Popup height follows measured text plus declared padding, independently of the background texture's intrinsic height.
Missing source data, assets, glyphs or unresolved engine-generated text prevent the popup and produce findings.
Caller-declared placement and approximate text-sprite composition do not establish native popup placement, padding or delayed timing.

Offline renders retain declared scenario, resolution, UI scale, source revision, and any unsupported fields. A user-supplied game capture is a comparison reference, not renderer output. The installed war-window comparison established that `85%%` supplies a far-edge coordinate while `85%` supplies a proportional extent. The sampled frame, close button, and scrollbar regions aligned at zero displacement, but the maximum-scroll scenario left sampled row regions six pixels above the capture. Native grid placement, zero-range controllers, progress end-cap shaders, and other reference surfaces still need case-specific comparison. None of these limited regions establishes whole-window parity or live gameplay behavior.

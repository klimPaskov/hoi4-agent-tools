# ADR 0023: Vanilla GUI composition and layout fidelity

- Status: accepted
- Date: 2026-08-24

## Decision

Model Clausewitz GUI anchors as two distinct concepts: `orientation` selects the reference point in the parent and `origo` or `centerposition` selects the reference point inside the element. Nested elements inherit the parent container's local coordinate origin. Parse both `%` and `%%` relative values, keep local scale out of parent-relative offsets, and use `maxWidth`, `maxHeight`, and `fixedsize` for text bounds and clipping.

Composite the vanilla sprite families that materially affect interface geometry. Cornered tile sprites use nine-slice borders and optional center tiling. Progress bars combine filled and background textures. Masked shields combine background and mask textures. Frame selection and primary texture rendering remain available when an engine shader cannot run offline.

Resolve ordinary GUI sprites, secondary textures, fonts, animation sheets, and localisation `£icon` tokens through the same mod, dependency, and installed-game load order. The narrowed render scan must include the binary assets referenced by localisation icons so a mod can use vanilla GFX without copying it.

## Rationale

Flattened tiled panels, missing progress backgrounds, incorrect anchor signs, text boxes sized only to their current string, and omitted localisation icons produce renders that are structurally valid but visibly unlike the game. Coding agents need the actual visual composition and bounds to diagnose alignment, containment, overlap, and state problems.

## Consequences

GUI scene data records primary and secondary sprite frames, sprite composition mode, nine-slice borders, progress direction, inline text-icon placement, and fixed text bounds. SVG and PNG renders use those fields deterministically. Fidelity reports still identify unexecuted engine shaders and runtime-only values, but a resolved vanilla texture is rendered instead of being suppressed by those limitations.

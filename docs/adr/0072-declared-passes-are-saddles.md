# ADR 0072: Declared passes are saddles

## Context

A range lowers its own crest inside a pass window with an envelope (`1 - depth * bump`). Other relief is added afterwards: the cone of a volcano, a plateau or a neighbouring range adds its own height on top of the range, so a pass that lies on or near such a feature is no longer lower than the crest beside it. The synthesis then stopped with `MAP_PASS_NOT_LOWER` (an error: a gate that is not a gap would block a route the model declares), and moving the pass along the spine changed nothing, because the cone covered all of it. One measured model failed this way (228 against 230 and 227) after its rivers had been fixed, and only a full write showed it: the river check did not run the pass test.

## Decision

A declared pass is authoritative over the other relief, as a declared river is (ADR 0071).

- After all features of the macro relief are composed, the heights in each pass's corridor are capped at the pass's own saddle level: the base under the range plus the crest above it times `1 - depth * bump`, with the same window and bump the range envelope uses. The corridor is the range's footprint at the pass (at least two cells) with a soft edge of two cells; only cells whose nearest point of the range line lies inside the pass window are touched.
- A cell on the body of another range (within that range's footprint) is not capped, so the passes of one range never lower the crest of a neighbouring range.
- The corridor is cut as a saddle in the surrounding relief: a volcano cone that overlaps a pass is cut down to the saddle level inside the corridor and stays untouched outside it.
- `MAP_PASS_NOT_LOWER` stays an error for the cases the cap cannot repair (the saddle depth is below 0.15, and the check skips those).
- `create_world.synthesisCheck` (ADR 0070) now also runs the pass test on the macro grid and reports `MAP_PASS_NOT_LOWER`, so a preview shows what the write would block on. Only that error is taken from the pass and crest checks; their warnings stay with the write.

## Consequences

Models whose passes were refused now write, and a pass is always a saddle with a margin below the crest on both sides. The cap changes only pass corridors, so worlds whose passes were not covered by other relief are unchanged except for the corridor's own heights where an overlapping feature added height. A volcano that stands on a pass loses its cone's top inside the corridor, and the pass wins over the volcano; move the volcano if the cone should be whole. The recorded hashes of the relief fixture world changed (heights, river bitmap and normals), because the fixture's passes overlap a volcano. The macro-grid test of the preview is an approximation of the full-resolution test: it catches the cases above and reports only the error.

Not covered: a pass through a feature that is not a range (a plateau edge), and a corridor wider than the footprint for a very wide gate.

Tests: a pass under a volcano cone with a margin of at least four height units, the pass reported in the river preview, a neighbouring range's crest unchanged by a pass beside it, and determinism. The first two fail without the cap.

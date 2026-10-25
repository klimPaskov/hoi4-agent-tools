# ADR 0071: Drawn rivers carve their valleys

## Context

The hydrology routes each river a geography model draws as a least-cost path over the synthesised relief and refused the world when the route would climb more than 22 height units over a divide (`MAP_RIVER_UNREACHABLE_MOUTH`). The refusal moved authority from the author's drawing to the generator's relief: a river passing near the cone of a volcano, a foothill or the tip of a range could not be written even though real rivers cross such rises as antecedent rivers and gorges, and the author had to move the river or the feature in the model. One measured model failed on three rivers in turn, each only after a 76 s write.

## Decision

A drawn river is authoritative over the synthesised relief.

- A route whose climb exceeds the limit is accepted. The bed is already burned to a monotone descent along the route before the second flood (`conditioned - 0.4`, never above the previous cell), and the valley carving never lets a bed rise downstream, so the cone, foothill or range slope across the route is cut down to the bed as a gorge. Nothing else in the relief changes.
- Each such crossing is reported as the warning `MAP_RIVER_CARVED_CROSSING`: river id, climb, limit, and the divide (world pixel, height, the nearest range with its distance, `range` when one runs within 0.06 map widths, `volcano` when the divide lies on a volcano's cone within 1.3 radii). The message names the river, the location and the feature.
- The world is refused only for a course that cannot exist: a mouth on another landmass or not reachable over land (for example a tributary of a river on another land), a source or via point that cannot be reached, a lake without a free shore, a mouth far from any land. These still raise `MAP_RIVER_UNREACHABLE_MOUTH`, now with every failing river in `details.rivers` (ADR 0070), and a river whose mouth is a failed river carries `blockedBy`.
- The limit of 22 stays as the threshold above which a crossing is reported; below it a river simply runs down its valley.
- `synthesisCheck` (ADR 0070) reports the crossings in `data.synthesisCheck.crossings` and `carvedCrossings`, and returns ready when only crossings remain.

## Consequences

A model whose drawn river passes a volcano or range tip writes, and the report says where its valley was cut so the author can move the river or the feature if the gorge is unwanted. Rivers no longer fail the world for relief that the generator itself synthesised. The bed of a carved river may sit well below the surrounding rock: the gorge is a single macro cell wide before the full-resolution detail and the valley widening of large rivers smooth it, and a very high divide gives a steep-sided cut. The relief and river bitmaps of a model that previously failed are new; models that previously wrote are unchanged, because their routes did not exceed the limit.

Not covered: widening a gorge across a divide for a small river (the cut stays narrow), choosing a pass instead of a cone when the route has a choice (the router already prefers low ground), and a per-river opt-out of carving.

Tests: a river through a wall (two warnings with the range and the pixel on the wall, beds that never rise downstream), a river through a volcano cone, and the impossible courses that still fail.

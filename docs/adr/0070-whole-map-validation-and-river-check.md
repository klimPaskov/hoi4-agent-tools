# ADR 0070: Validation of a replacement world and the river check

## Context

A `create_world` that cannot generate (a river cannot reach its mouth, a model is refused) rolls its operation back and leaves the workspace map unchanged. The write then validated that unchanged map, whose findings had nothing to do with the request: each one became a blocker `MAP_VALIDATION_OPERATION_UNOWNED`, either "pre-existing" (the finding also existed before the manifest) or "no owning operation", and the one real cause was buried among them. When generation succeeds, the same fingerprint rule marked a finding of the generated map "pre-existing" whenever the replaced map had the same finding, although a whole-map replacement has no baseline: every finding of the new map is the new map's.

Separately, the relief and river synthesis stopped at the first named river that cannot reach its mouth, so a model with several such rivers needed one 76 s write per river, and the error named only the river and the climb.

## Decision

**Validation of a replacement.** When a request contains `create_world`:

- the baseline validation of the existing map is not run, so no finding is classified as pre-existing and findings of the generated map are attributed like any other (to the world operation);
- if the world operation produced a blocker, the unchanged map is not validated at all. The plan's own blockers (`MAP_RIVER_UNREACHABLE_MOUTH`, `MAP_GEOGRAPHY_INVALID`, ...) are the result.

Other operations keep the earlier rule: errors that existed before the manifest and have no operation that could have caused them are reported with an explicit blocker rather than guessed.

**All unreachable rivers.** The named-river router collects every river that cannot reach its mouth instead of stopping at the first, releases the cells a failed route took, and treats a river whose mouth is a failed river as blocked by it. After routing, one `MAP_RIVER_UNREACHABLE_MOUTH` is raised: its message names the first river (or the count and up to twelve river ids), the fields of the first failure stay at the top of `details` as before (`riverId`), and `details.rivers` lists every failure with its reason (`blockedBy` for a tributary of a failed river). A climb over a divide is not a failure: ADR 0071 carves the river's valley through it and reports the crossing as a warning with the divide's location.

**River check.** `create_world.synthesisCheck: true`, used with `preview: true` and a geography, resolves the model, builds its surface, applies the edge policy, and runs the macro relief and the hydrology only: no full-resolution heights, river pixels, normals, partition or files. The result is `MAP_SYNTHESIS_CHECK_READY`, or `MAP_SYNTHESIS_CHECK_BLOCKED` with the blockers above and `data.synthesisCheck` (`passed`, `unreachableRivers`, `rivers`, up to 200). Nothing is written. Without `preview` the operation is refused (`MAP_SYNTHESIS_CHECK_REQUIRES_PREVIEW`); without a geography too (`MAP_SYNTHESIS_CHECK_REQUIRES_GEOGRAPHY`).

## Consequences

A failed world shows only its own blockers, and a successful replacement is judged on the map it produces. The check reports all impossible courses in a fraction of a write (relief at half resolution and the hydrology are the part that decides reachability). Carved crossings are listed with their locations. The field `synthesisCheck` is additive (minor version). The rule for non-world operations is unchanged.

Not covered: the check reports reachability only; the climate stage, the partition and the placement of countries are not run, so their findings still appear at the write. The divide of a carved crossing is the highest point of the route the router found, not necessarily the lowest pass.

Tests: several impossible courses and a blocked tributary, the single-river fields unchanged, the check through MCP (ready, blocked, refused without preview, nothing written), and a world that fails over an existing map with a defect of its own reporting only its generation blocker (the test fails without the change).

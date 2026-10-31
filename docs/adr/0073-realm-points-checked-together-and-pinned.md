# ADR 0073: Realm points are checked together and pinned to provinces

## Context

`create_world.countries` with `source: "workspace"` (ADR 0069) places each country from a capital and optional seeds. The points were resolved to provinces after the province partition, one at a time, and the first problem stopped the write (about 76 s on a large world): a point in water because the generated coast differs from a drawing's by a few pixels, or a capital that falls into a province that a point of another realm already names. A model with many realms whose capitals lie 20 to 40 px apart (the size of a province) needed one write per problem.

## Decision

**All problems at once, before any province exists.** `checkRealmPoints` runs on the generated surface, right after the coast and lakes are final and before the relief synthesis and the partition, and returns every problem:

- a point outside the frame (`MAP_WORLD_REALM_POINT_OUTSIDE`);
- a point in water (`MAP_WORLD_REALM_POINT_WATER`), with `nearestLand` (pixel and distance within 80 px) so the point can be moved;
- a point in the unowned area, in the realm's own exclusion or in another realm's claim polygon (`MAP_WORLD_REALM_POINT_CONFLICT`), tested on the pixel;
- points of different realms closer than `REALM_POINT_MIN_SEPARATION_PX` = 10 px (`MAP_WORLD_REALM_POINTS_TOO_CLOSE`), with the other realm and the distance.

One problem keeps its own code; several raise `MAP_WORLD_REALM_POINTS_INVALID` whose message lists the first six and whose `details.problems` lists up to 500 (`count` is the total). The check also runs in `create_world.synthesisCheck` (ADR 0070) next to the river and pass checks: the preview reports `data.synthesisCheck.realmPoints` and the failing rivers in the same run.

**Each capital gets its own province.** In the feature-aware partition every capital and every seed is a pin: a province seed at that pixel, and the generated land seeds within 0.6 of the smallest land province side of a pin are dropped. The watershed then cuts the province between two close capitals instead of leaving both in one province. Points of one realm within 6 px of an earlier pin share its province. The legacy partition ignores pins; there a close pair can still fail after the partition with the earlier province-level conflict.

The minimum separation is stated in the schema descriptions of `capital` and `seeds`: points of different realms must be at least 10 px apart. Below it two provinces would be a handful of pixels.

## Consequences

A model's realm points are fixed in one pass, and capitals that are 20 to 40 px apart write. The pins change the province partition of a feature-aware world that has workspace realms (a province seed per point, a few land seeds fewer); worlds without workspace realms, and the legacy partition, are unchanged. A pinned province next to another can be small, down to about the minimum province size; the border-quality metric and the existing province-size diagnostics report it.

Not covered: moving a point automatically (the nearest land is reported, the model decides), and pinning claims, which are polygons and still cover provinces by more than half their pixels.

Tests: capitals 12 px apart in a feature-aware world get a province and a state each (the test fails without the pins), all problems of a request reported together with the nearest land, a single problem under its own code, and the preview listing realm points and failing rivers together.

# ADR 0068: Province count budget for generated worlds

## Context

The map import campaign (request ZR-4 in `docs/plans/zin-requests.md`) ran `create_world` with only a reference picture on web maps. Defaults gave 17,000 to 23,000 provinces where the base game has about 13,400. Two causes:

- The legacy partition gives each sampling box of `landProvincePixels` up to two extra sites in elevated or wet land. Reference terrain carries moisture 0.45 to 0.96, so the extras added 50 to 95% to the requested count instead of redistributing it, and lakes were cut at the land size.
- A picture with much land (73% on one map) needs more than 21,000 provinces at the default 400 pixels even when the partition is right. The world then failed late, after generation, when `unitstacks.txt` (23 MB) exceeded the 16 MiB text-table limit, with an error that did not name the file.

The feature-aware partition (ADR 0058) already refuses a planned count above 21,000; the legacy partition had no budget.

## Decision

- The legacy partition's sampling box grows by the mean number of extra sites over the land, so elevated and wet land still gets smaller provinces while the land as a whole holds about its area divided by `landProvincePixels`. Lakes take `seaProvincePixels`.
- Before either partition runs, the count is estimated as land pixels over `landProvincePixels` plus water pixels over `seaProvincePixels`. When the caller gave neither size and the estimate exceeds 14,000 (the existing warning), both sizes are multiplied by the estimate over 13,000, so the world holds about the base game's count, and the info note `MAP_WORLD_PROVINCE_SIZE_RAISED` gives the new sizes. When the caller chose a size and the estimate exceeds 21,000, the request is refused with `MAP_PARTITION_PROVINCE_COUNT_HIGH` before generation.
- A coast that crosses the east-west seam is repaired by one pixel at the seam, before the synthesis of a geography world and after the drainage of any other, because province parts never join across the seam (`MAP_WORLD_SEAM_CORNER_REPAIRED`).
- `MAP_TEXT_FILE_LIMIT` and `MAP_TEXT_RECORD_LIMIT` name the file.

## Consequences

The province partition of every generated world changes for a given seed, and with it the states, regions and derived files; the changelog says so. Sizes a caller chose are never changed silently: they either fit or are refused with the estimate. The estimate ignores fragments the partition adds (about 5% on real maps), so the budget aims below the warning. Tests cover the count on uniformly wet land, lakes at the sea size, the seam repair in both partitions and the raised and refused budgets.

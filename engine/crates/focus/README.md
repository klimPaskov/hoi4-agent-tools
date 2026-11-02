# hoi4-focus-layout

Deterministic layout engine for Hearts of Iron IV focus trees. It places `auto` focuses on the
focus grid (`layout`) or fits a new branch among focuses that keep their coordinates exactly
(`insert`). It never edits prerequisites or exclusions; the response hashes let a caller check that.

```sh
hoi4-engine focus-layout --request request.json   # or the request on stdin
```

Exit code 0 with a response (its `status` is `ok` or `blocked`), 2 for an invalid request: the
message goes to stderr and stdout gets
`{"schema":"hoi4-focus-layout/1","status":"invalid","error":{"code":"…","message":"…"}}`.

JSON schemas: [`schemas/focus-layout-request.schema.json`](schemas/focus-layout-request.schema.json)
and [`schemas/focus-layout-response.schema.json`](schemas/focus-layout-response.schema.json).

## Request `hoi4-focus-layout-request/1`

| Field                         | Meaning                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`                      | `hoi4-focus-layout-request/1`                                                                                                                                                        |
| `operation`                   | `layout` or `insert`                                                                                                                                                                 |
| `treeId`                      | Optional, echoed                                                                                                                                                                     |
| `options.nodeSpacing`         | Smallest distance between two focuses of one row, 1 to 64 (default 2)                                                                                                                |
| `options.laneSpacing`         | Extra columns between two lane bands on top of `nodeSpacing`, 0 to 1000 (default 2)                                                                                                  |
| `lanes[]`                     | `id`, `order` (default 0), optional `minimumX` and `maximumX`. Lanes are placed by (`order`, `id`); lanes that focuses name but `lanes` does not list follow, by id                  |
| `focuses[].id`                | Unique, non-empty                                                                                                                                                                    |
| `focuses[].prerequisites`     | AND of OR groups, as in the game: `[["a"], ["b", "c"]]`. Ids outside the request are ignored with a warning                                                                          |
| `focuses[].mutuallyExclusive` | Ids                                                                                                                                                                                  |
| `focuses[].laneId`            | Resolved by the caller; default `default`                                                                                                                                            |
| `focuses[].position`          | `{"mode":"fixed","x","y"}`, `{"mode":"relative","x","y","relativeTo"}` (anchor position plus offset, applied recursively) or `{"mode":"auto","preferredX"?,"preferredY"?}` (default) |
| `focuses[].pinned`            | The focus must keep its coordinates. Fixed and relative focuses always do; a pinned `auto` focus is invalid, and a pinned focus cannot be in `insert.focusIds`                       |
| `insert.focusIds`             | `insert` only: the focuses to place. Every other focus must have coordinates (fixed, or relative to a focus outside the list) and keeps them                                         |
| `insert.anchorId`             | Optional: the focus written as the branch root (one of `focusIds`)                                                                                                                   |
| `insert.preferSide`           | `left`, `right` or `either` (default)                                                                                                                                                |
| `insert.allowShift`           | Default false. When no place is free, shift existing focuses to make room instead of answering `blocked`                                                                             |

Coordinates must lie within ±100,000; at most 20,000 focuses.

## Response `hoi4-focus-layout/1`

| Field                 | Meaning                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`              | `ok`, or `blocked` when the request cannot be placed without breaking a rule; `blocked` responses have empty `nodes` and `source`, `metrics: null` and `hashes.layout: null`                                                                                                                                                                   |
| `operation`, `treeId` | Echoed                                                                                                                                                                                                                                                                                                                                         |
| `nodes[]`             | Every focus, sorted by id (UTF-16 code units): `id`, `x`, `y`, `laneId`, `moved` (this call set the coordinates: placed, shifted, or relative to a placed focus)                                                                                                                                                                               |
| `source[]`            | How to write each focus, sorted by id: `{id, x, y}` (fixed) or `{id, relativeTo, x, y}`. See below                                                                                                                                                                                                                                             |
| `diagnostics[]`       | `code`, `severity` (`error`, `warning`, `info`), `focusIds`, `message`, `details`                                                                                                                                                                                                                                                              |
| `metrics`             | `columns`, `rows` (bounding box), `orthogonalCrossings`, `stemsThroughPlaques`, `mergedBars` of the whole result in the connector model, and `durationMicros`                                                                                                                                                                                  |
| `hashes`              | SHA-256 of canonical JSON (keys sorted, no whitespace, ids by UTF-16 code units): `layout` over `[{id,laneId,x,y}]` of every focus, `untouched` over `[{id,x,y}]` of the focuses with `moved: false`, `prerequisites` over `[{id,groups}]` (members and groups sorted), `exclusions` over sorted `[a,b]` pairs. `durationMicros` is in no hash |
| `needsRoom.shift[]`   | `insert` without `allowShift`, when no place is free: `{fromX, columns, direction, focusIds}`; every listed focus (`x >= fromX` for `right`, `x <= fromX` for `left`) moves `columns` columns that way                                                                                                                                         |
| `shifted[]`           | `insert` with `allowShift`: the shift that was applied, same shape                                                                                                                                                                                                                                                                             |

`source` encoding: in `layout`, the topmost placed focus of each lane (ties by id) is written fixed
and every other placed focus of the lane relative to it. In `insert`, the branch root (`anchorId`,
or the topmost new focus) is written relative to its first prerequisite outside the branch (fixed if
it has none) and the other new focuses relative to the root; shifted fixed focuses get their new
coordinates and relative focuses whose anchor moved differently get new offsets. Every other focus
is echoed unchanged.

### Diagnostics

| Code                                        | Severity | Meaning                                                                                      |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `FOCUS_ENGINE_PREREQUISITE_OUTSIDE_REQUEST` | warning  | A prerequisite names a focus that is not in the request; it is ignored                       |
| `FOCUS_ENGINE_EXCLUSION_OUTSIDE_REQUEST`    | warning  | `mutuallyExclusive` names a focus that is not in the request                                 |
| `FOCUS_ENGINE_LANE_BOUNDS_UNSATISFIED`      | warning  | A lane band does not fit inside `minimumX`/`maximumX`; it is placed as close as possible     |
| `FOCUS_ENGINE_EXISTING_CONFLICT`            | warning  | Focuses this call did not move already break spacing or sit above a prerequisite             |
| `FOCUS_ENGINE_SHIFTED`                      | info     | `allowShift` moved existing focuses                                                          |
| `FOCUS_ENGINE_SPACING_CONFLICT`             | error    | Blocked: a placed or relative-to-placed focus would be too close to another focus of its row |
| `FOCUS_ENGINE_PARENT_NOT_ABOVE`             | error    | Blocked: a placed focus cannot be below every prerequisite (fixed rows leave no room)        |
| `FOCUS_ENGINE_NO_CORRIDOR`                  | error    | Blocked: no free place within 64 columns; `needsRoom` proposes a shift                       |

Invalid requests (exit 2): `FOCUS_ENGINE_REQUEST_INVALID` (not JSON or wrong shape, unknown fields),
`FOCUS_ENGINE_SCHEMA_UNSUPPORTED`, `FOCUS_ENGINE_OPTION_INVALID`, `FOCUS_ENGINE_LIMIT_EXCEEDED`,
`FOCUS_ENGINE_DUPLICATE_FOCUS`, `FOCUS_ENGINE_LANE_INVALID`, `FOCUS_ENGINE_UNKNOWN_ANCHOR`,
`FOCUS_ENGINE_RELATIVE_CYCLE`, `FOCUS_ENGINE_PREREQUISITE_CYCLE`, `FOCUS_ENGINE_ANCHOR_CYCLE`,
`FOCUS_ENGINE_PINNED_AUTO`, `FOCUS_ENGINE_INSERT_INVALID`, `FOCUS_ENGINE_INSERT_UNPLACED_FOCUS`,
`FOCUS_ENGINE_INSERT_ANCHOR_INVALID`.

## Algorithm

1. **Rows.** Fixed and relative coordinates are resolved first. A placed focus sits one row below
   its lowest prerequisite (row 0 without one), or on its `preferredY` when that is lower down
   (longest-path layering). A relative focus whose anchor is placed keeps its offset from it.
2. **Band layout** (`band.rs`), per lane in `layout` and for the new branch in `insert`. Four
   passes, down, up, down, up. Down: a focus wants the median column of its parents (the midpoint
   of the two middle values for an even count, so a convergence focus is centred between its
   parents); focuses with the same parents form a cohort spread symmetrically around that median,
   `nodeSpacing` apart (two children at −1 and +1, three at −2, 0, +2). Rows are ordered by the
   median (barycenter heuristic), then cohort, then id. Up: a focus wants the median of its
   children, which centres parents over their subtrees. Each row is then projected onto the
   nearest order-preserving positions with the required gaps (least squares by
   pool-adjacent-violators on `x_i − i·spacing`) and rounded half toward +infinity; mutually
   exclusive focuses of a row form a rigid unit exactly `nodeSpacing` apart.
3. **Placing the band** (`place.rs`). A band with a placed parent outside it or a `preferredX` is
   anchored: its columns are absolute, and the engine searches horizontal offsets within ±64
   columns, rejecting any that put a plaque closer than `nodeSpacing` to another focus of its row,
   and keeps the cheapest by (new orthogonal crossings, new stems through plaques, side penalty for
   `insert.preferSide`, total horizontal connector length, distance, left before right unless
   `preferSide` is `right`). A free band is packed: lanes go left to right by (`order`, `id`), each
   starting `nodeSpacing + laneSpacing` columns right of everything placed so far. Lane bounds clamp
   the offset; when nothing fits inside them the band is placed outside with a warning. A tree that
   is all `auto` and has no lane bounds is finally centred on x = 0.
4. **Insert corridor.** When no offset within the window is free, the engine proposes one vertical
   cut: existing focuses on one side move away by the fewest columns that free the branch's place.
   Cuts that keep the branch with its existing parents (the branch moves with them) are preferred,
   then fewer columns, fewer moved focuses, `preferSide`, nearness.
5. **Checks.** Duplicate cells, row spacing below `nodeSpacing` and children not below a parent are
   never returned for focuses this call moved: the call is `blocked` with a diagnostic naming them.

All placement arithmetic is integer (half columns and exact rationals); the connector geometry
compares in hundredths of columns and rows. Outputs never depend on hash-map order or on the
order of `focuses` in the request.

### Connector model (`geometry.rs`)

Ported from `src/hoi4_agent_tools/focus/quality/orthogonal.ts`: a short stem leaves the bottom
of the parent plaque (plaques are centred on the focus, 1.61 columns wide and 0.28 rows high), a bar
runs 0.28 rows under the parent's row, and a vertical drops in the child's column to the top of the
child's icon, 0.66 rows above the child's row. A crossing is a child's vertical passing strictly
inside the bar of another connector whose parent row lies strictly between its ends; a stem through
a plaque is that vertical passing within 0.805 columns of another focus's centre on such a row;
merged bars share at least half a column under one row, or more than 0.3 rows of one column.
Connectors with the same parent or child, or inside one all-to-all bundle (two or more parents that
each lead to the same two or more children), are drawn as one bar and never counted against each
other. The plaque width and bar placement were confirmed by an in-game run on 2026-11-02 (game
1.19.4.1, default UI scale and zoom); other scales are unverified. `tests/fixtures/connector-parity.json`
holds hand-counted trees that this crate and the TypeScript model both check.

## Limits

- A band moves as one rigid block when it is placed among existing focuses, so a lane with several
  unrelated subtrees is offset together.
- A parent in a lane placed later does not pull its children in an earlier lane.
- Relative focuses anchored to a placed focus are not obstacles while the band is placed; a conflict
  they cause blocks the call.
- Lane bounds are ignored by `insert`.

## Tests

```sh
cd engine
cargo test --no-fail-fast -p hoi4-focus-layout
cargo test --release -p hoi4-focus-layout --test scale -- --ignored --nocapture
FOCUS_LAYOUT_BLESS=1 cargo test -p hoi4-focus-layout --test golden   # after an intended output change
```

Golden request/response pairs live in `tests/fixtures/`; the property tests use a seeded xorshift
generator.

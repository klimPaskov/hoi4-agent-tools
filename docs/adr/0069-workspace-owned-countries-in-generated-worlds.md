# ADR 0069: Workspace-owned countries in generated worlds

## Context

`create_world` writes a complete playable scenario: the map, states, strategic regions and, for every country it is given (at most 200) or invents, the tag file, country file, colour, history, order of battle, three flags, localisation and the bookmark (ADR 0052). Ownership comes from proportional growth: countries grow from spread-out capitals until their land matches their `share`, so where a country lies is the generator's choice.

A total conversion owns its countries. Its own build already writes their tags, files, histories, orders of battle, flags and names, and it needs the new map to carry those countries where its authors placed them. Today the two cannot meet: the world's managed outputs and the mod's files claim the same kinds of files, the mod's build refuses to touch managed outputs, loading both sets doubles the tag count (one measured mod reached 536 static tags against the roughly 439 its game build loads before the flag sheet overflows), and proportional growth cannot honour a capital or a drawn border.

Three capabilities are needed, all independent of any particular mod:

1. a `create_world` mode in which the workspace owns the countries and the world writes only geography and state ownership;
2. ownership from authored seeds (a capital point, optional claimed and excluded areas, a weight), with natural borders where the seeds leave freedom and an explicit rule for land no country claims;
3. retirement of the previous world's country outputs in the same transaction, visible in the report.

The third already exists: every `create_world` deletes recorded outputs the new write no longer produces (ADR 0052, `core/managed-outputs.ts`, `map/world-outputs.ts`) and blocks on a recorded file whose bytes changed (`MANAGED_OUTPUT_EDITED`). It is invisible except as deleted paths among thousands of changed files, and it blocks when the workspace has already replaced a recorded country file with its own.

The territory assignment service (ADR 0060, `assign_territory`) grows countries from seeds over the partition's province graph with natural-border costs, forced and blocked sets, island rules and size targets. It runs on an existing map. This decision reuses its growth (`growTerritory`) inside `create_world`, where no state exists yet.

## Decision

### 1. The `workspace` form of `create_world.countries`

`countries` accepts, besides today's array, an object:

```json
{
  "source": "workspace",
  "realms": [
    {
      "tag": "ABC",
      "capital": { "x": 1812, "y": 640 },
      "weight": 2,
      "claim": [
        [
          { "x": 1700, "y": 600 },
          { "x": 1900, "y": 600 },
          { "x": 1900, "y": 720 }
        ]
      ]
    }
  ],
  "unowned": [
    [
      { "x": 2400, "y": 300 },
      { "x": 2460, "y": 300 },
      { "x": 2460, "y": 360 }
    ]
  ],
  "islands": "nearest"
}
```

- `realms`: 1 to 512 entries, each a `tag` (an uppercase letter and two uppercase letters or digits), a `capital` world point, and optionally `seeds` (up to 256 further points that must belong to it), `claim` (up to 64 polygons that must belong to it), `exclude` (up to 64 polygons it must not own) and `weight` (0.05 to 100, default 1, its share of the land no claim fixes). A tag appears once.
- `unowned`: up to 256 polygons whose land no realm owns.
- `islands`: `nearest` (default), `one-owner` or `unowned`, for landmasses no realm starts on.

World points and polygon vertices are `{ x, y }` pixels of the world frame, top-left origin, the convention of `landPolygons`. A province belongs to a claim, an exclusion or the unowned area when more than half its pixels lie inside the polygon; a seed or capital names the province under its pixel and must be land (`MAP_WORLD_REALM_POINT_WATER`, naming the tag and the point).

When the request has an override file (`overridesPath`, ADR 0067 section 5), its `countries` entries are realms of the same schema with an `id`, and the inline `realms` and the file's entries are joined; a tag in both is an error naming the entry. The 200-entry limit of the array form does not apply to this form.

Validation before planning:

- every tag is declared by an active `common/country_tags` file of the workspace or its dependencies other than the world's own managed tag file (`MAP_WORLD_REALM_TAG_UNKNOWN`, naming the tag); a tag declared only in a dynamic-tag file is refused (`MAP_WORLD_REALM_TAG_DYNAMIC`);
- a point outside the frame (`MAP_WORLD_REALM_POINT_OUTSIDE`); a capital or seed in the unowned area, in the realm's own exclusion or on another realm's point (`MAP_WORLD_REALM_POINT_CONFLICT`); claims of two realms that overlap or a claim over the unowned area or the realm's own exclusion (`MAP_WORLD_REALM_CLAIM_OVERLAP`) are errors naming the tags and the point or province;
- a reference picture's inferred political regions (the colour path of the array form) are not used with this form; the colours of the countries are the workspace's.

### 2. Ownership

After the province partition and before strategic regions and states, capitals, seeds and claimed provinces are fixed to their realms, and the realms grow over the province graph from all their fixed provinces in proportion to their weights, never into their own exclusions or the unowned area (the same growth the array form uses for `share`). Land growth does not reach goes, on a landmass a realm already holds, to the nearest capital whose realm may own it, else stays unowned; a landmass no realm starts on follows `islands`. When the territory service (ADR 0060) is merged, feature-aware worlds grow realms with `growTerritory` over the partition's border costs instead, with the same constraints, so borders follow rivers and ranges where the seeds leave freedom.

States are cut afterwards within each strategic region and owner, as today, so no state straddles a border. Land in the unowned area and islands left by `islands: "unowned"` form states of their own; their history has no `owner`, `controller` or `add_core_of`. Every unowned state is listed (`MAP_WORLD_STATE_UNOWNED`, a note with the count and, in the artifact, each state with its provinces). Whether the game build accepts unowned land is the mod's to verify; the tool records it, never guesses it.

Each realm's capital province becomes the capital of its state, and that state is the realm's capital state. Default names of states and victory points use the tag (the mod's override names or localisation replace them).

### 3. What the world writes and does not write

With the `workspace` form the world writes the map files, `history/states`, strategic regions, continents, the managed localisation of states, victory points, strategic regions and continents, and, with `startingScenario`, the non-country scenario files (on-actions replacement, AI areas, AI strategy plans) as today. It writes no `common/country_tags`, `common/countries` file or `colors.txt`, `history/countries`, `history/units`, flags, country localisation keys, inactive-tag histories or bookmark.

The country histories' `capital` lines belong to the workspace. The result reports each realm's capital state, and the existing post-write validation warns when a country history names a capital its country does not own (`MAP_COUNTRY_CAPITAL_NOT_OWNED`), because the workspace's build normally rewrites those lines next. Stable ids (ADR 0067 section 4) keep the states and therefore those lines from moving on a re-import.

### 4. Retirement and release of earlier outputs

A write reconciles the previous world manifest as today, with two changes:

- **Report.** The note `MAP_WORLD_OUTPUTS_RECONCILED` and the result's `data.outputs` give `written`, `retired` and `released` counts and up to 200 retired and released paths, sorted; the artifact `map-world-outputs.json` lists them all.
- **Release.** With the `workspace` form, a recorded output of a country kind (country tag file, country file, `colors.txt`, country history, order of battle, flag, bookmark) whose bytes changed since the last write is released instead of blocking: it is dropped from the manifest and left in place, the workspace now owns it, and it is listed as `released` with the note `MAP_WORLD_OUTPUT_RELEASED`. Unchanged recorded files of those kinds are deleted (retired) as today. Every other recorded output still blocks on an edit (`MANAGED_OUTPUT_EDITED`, ADR 0052). The array form is unchanged: an edited recorded file of any kind blocks.

`core/managed-outputs.ts` gains `planManagedOutputs` with an optional `releasable(relativePath)` predicate, which returns the written, retired and released paths beside the planned changes; a releasable file the write produces again still blocks. The world adapter supplies the predicate only for the `workspace` form.

### 5. Tag budget

Every `create_world` reports `MAP_WORLD_TAG_COUNT`: the static tags declared by active country tag files after the write (those of the workspace and its dependencies, plus the tags the world writes), the dynamic tags (entries of tag files marked `dynamic_tags = yes`) and the total. Above 439 the write warns `MAP_WORLD_TAG_COUNT_HIGH`. The figure is the count at which one measured game build (1.19 on Windows) overflowed its flag sheet; it is an observation recorded as such, not a documented engine limit, and it never blocks.

### 6. Evidence

The note `MAP_WORLD_REALMS_PLACED` and the result's `data.realms` list, per realm, the capital state and province, the number of states and provinces and the land share against its weight's share. The artifact `map-world-realms.json` holds every realm's states and the unowned states. The world preview images draw the new countries as for any world; country borders are measured with `hoi4.map_inspect` `quality: true` (ADR 0059).

## Consequences

A mod that owns its countries can generate or import a map that carries them where its authors placed them, in one `create_world` call, and the previous world's country outputs disappear in the same transaction without hiding their removal. Tag files, country files, flags and histories have one owner again. The array form, the procedural world and the reference-colour path are unchanged, byte for byte.

The `countries` field becomes a union. Existing requests stay valid; the published schema gains the object form, so this is a minor version, reviewed for compatibility before it is merged. Ownership growth adds one territory pass to the world build (ADR 0060 measured 15 s for 305 countries on a 5,120 x 2,560 world by state; inside `create_world` it runs on provinces before states exist).

Not covered: writing or editing country files, histories or names for workspace realms; inferring realms from a drawn political map (the colour path stays with the array form); subjects grown inside an overlord; dated ownership changes; and unowned land beyond recording it.

Tests use synthetic fixtures only: a workspace with its own tag files and realms on a generated world (no country outputs, ownership by tag only, capitals in the named provinces), claims and exclusions honoured, unowned polygons and the three island rules, every refusal code above, the release of an edited recorded country file and the retirement of unchanged ones with the counts reported, the edited-file block for the array form unchanged, the tag count, determinism of two equal requests, and the legacy forms' pinned hashes unchanged.

## Order of implementation

1. Release and retirement report in the managed-output reconciler (independent; usable by every world write). Done.
2. The `workspace` form: schema, validation, outputs left out, tag count, ownership by weighted growth with the constraints. Done.
3. Growth with `growTerritory` on feature-aware worlds, after the territory service (ADR 0060) is merged.
4. The override file's `countries` section with ADR 0067 step 3.

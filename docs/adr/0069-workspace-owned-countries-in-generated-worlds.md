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
    { "tag": "ABC", "capital": [1812, 640], "weight": 2, "claim": [[[1700, 600], [1900, 600], [1900, 720]]], "exclude": [] }
  ],
  "unowned": [[[2400, 300], [2460, 300], [2460, 360]]],
  "islands": "nearest",
  "connectedMainland": true
}
```

- `realms`: 1 to 512 entries, each a `tag` (three capital letters or digits), a `capital` world point, and optionally `seeds` (further points that must belong to it), `claim` (polygons that must belong to it), `exclude` (polygons it must not own), `weight` (0.05 to 100, default 1, its share of the land no claim fixes) and `overlord` (another listed tag; the subject grows inside its overlord's territory, as in ADR 0060). A tag appears once.
- `unowned`: polygons whose land no realm owns.
- `islands`: `nearest` (default), `one-owner` or `unowned`, as in ADR 0060, for landmasses no seed is on.
- `connectedMainland`: as in ADR 0060, default true.

World points and polygon vertices are pixels of the world frame, top-left origin, the convention of `landPolygons`. A province belongs to a claim, an exclusion or the unowned area when more than half its pixels lie inside the polygon; a seed or capital names the province under its pixel and must be land (`MAP_WORLD_REALM_POINT_WATER`, naming the tag and the point).

When the request has an override file (`overridesPath`, ADR 0067 section 5), its `countries` entries are realms of the same schema with an `id`, and the inline `realms` and the file's entries are joined; a tag in both is an error naming the entry. The 200-entry limit of the array form does not apply to this form.

Validation before planning:

- every tag is declared by an active `common/country_tags` file of the workspace or its dependencies other than the world's own managed tag file (`MAP_WORLD_REALM_TAG_UNKNOWN`, naming the tag); a tag declared only in a dynamic-tag file is refused (`MAP_WORLD_REALM_TAG_DYNAMIC`);
- the `workspace` form needs the feature-aware partition, the default for geography worlds (`MAP_WORLD_REALMS_NEED_FEATURE_AWARE`), because the legacy partition has no border costs to grow on;
- a capital or seed inside another realm's claim, a realm's own exclusion or the unowned area, overlapping claims of two realms, and an `overlord` that is unknown or forms a cycle are errors naming both entries;
- a reference picture's inferred political regions (the colour path of the array form) are not used with this form; the colours of the countries are the workspace's.

### 2. Ownership

After the province partition and before strategic regions and states, the world builds the territory graph of ADR 0060 over its own provinces (border length, natural strength and natural length from the same edge table) and runs `growTerritory` with one country per realm: the capital first, then the seeds, claimed provinces forced to the realm, excluded and unowned provinces blocked from it, the weights as targets, the island and mainland rules, and the seeded jitter of the request's `seed`. A seed that its exclusions or other realms' claims cut off is refused before growth (`MAP_TERRITORY_FORCED_UNREACHABLE`, as there).

States are cut afterwards within each strategic region and owner, as today, so no state straddles a border. Land in the unowned area and islands left by `islands: "unowned"` form states of their own; their history has no `owner`, `controller` or `add_core_of`. Every unowned state is listed (`MAP_WORLD_STATE_UNOWNED`, a note with the count and, in the artifact, each state with its provinces). Whether the game build accepts unowned land is the mod's to verify; the tool records it, never guesses it.

Each realm's capital province becomes the capital of its state, and that state is the realm's capital state.

### 3. What the world writes and does not write

With the `workspace` form the world writes the map files, `history/states`, strategic regions, continents, the managed localisation of states, victory points, strategic regions and continents, and, with `startingScenario`, the non-country scenario files (on-actions replacement, AI areas, AI strategy plans) as today. It writes no `common/country_tags`, `common/countries` file or `colors.txt`, `history/countries`, `history/units`, flags, country localisation keys, inactive-tag histories or bookmark. Default state and victory-point names use the realm's localised name where the workspace's active localisation has the tag key, else the tag.

The country histories' `capital` lines belong to the workspace. The result reports each realm's capital state, and after the write the validation compares every realm's `history/countries` capital with the state it owns: a capital the realm does not own is a warning (`MAP_WORLD_REALM_CAPITAL_FOREIGN`, naming the tag, the file's state and the generated capital state), because the workspace's build normally rewrites those lines next. Stable ids (ADR 0067 section 4) keep the states and therefore those lines from moving on a re-import.

### 4. Retirement and release of earlier outputs

A write reconciles the previous world manifest as today, with two changes:

- **Report.** The result's `data.outputs` gives `written`, `retired` and `released` counts and up to 200 paths of each, sorted; the artifact `map-world-outputs.json` lists them all. The message names the counts.
- **Release.** With the `workspace` form, a recorded output of a country kind (country tag file, country file, `colors.txt`, country history, order of battle, flag, bookmark) whose bytes changed since the last write is released instead of blocking: it is dropped from the manifest and left in place, the workspace now owns it, and it is listed as `released` with the note `MAP_WORLD_OUTPUT_RELEASED`. Unchanged recorded files of those kinds are deleted (retired) as today. Every other recorded output still blocks on an edit (`MANAGED_OUTPUT_EDITED`, ADR 0052). The array form is unchanged: an edited recorded file of any kind blocks.

`core/managed-outputs.ts` gains an optional `releasable(relativePath)` predicate and returns the released and retired paths beside the planned changes; the world adapter supplies the predicate only for the `workspace` form.

### 5. Tag budget

Every `create_world` result reports `data.tags`: the static tags declared by active country tag files after the write, the dynamic tags (entries of tag files marked `dynamic_tags = yes`) and the total. Above 439 the write warns `MAP_WORLD_TAG_COUNT_HIGH`. The figure is the count at which one measured game build (1.19 on Windows) overflowed its flag sheet; it is an observation recorded as such, not a documented engine limit, and it never blocks.

### 6. Evidence

The result's `data.realms` lists, per realm, the capital state and province, the number of states and provinces, land share against target and the feasible target (ADR 0060 water filling), and the border-quality layer for countries (ADR 0059, `borderQuality` as on `assign_territory`, default `report`). The artifact `map-world-realms.json` holds the full assignment: per realm its states and provinces, every forced and blocked province with the entry that forced it, and the unowned states. The preview of a geography model draws realm borders and capitals over the model when realms are given.

## Consequences

A mod that owns its countries can generate or import a map that carries them where its authors placed them, in one `create_world` call, and the previous world's country outputs disappear in the same transaction without hiding their removal. Tag files, country files, flags and histories have one owner again. The array form, the procedural world and the reference-colour path are unchanged, byte for byte.

The `countries` field becomes a union. Existing requests stay valid; the published schema gains the object form, so this is a minor version, reviewed for compatibility before it is merged. Ownership growth adds one territory pass to the world build (ADR 0060 measured 15 s for 305 countries on a 5,120 x 2,560 world by state; inside `create_world` it runs on provinces before states exist).

Not covered: writing or editing country files, histories or names for workspace realms; inferring realms from a drawn political map (the colour path stays with the array form); dated ownership changes; and unowned land beyond recording it.

Tests use synthetic fixtures only: a workspace with its own tag files and realms on a generated geography world (no country outputs in the manifest, ownership by tag only, capitals in the named provinces), claims and exclusions honoured, unowned polygons and the three island rules, every diagnostic code above with a negative test, the override-file join and duplicate refusal, the release of an edited recorded country file and the retirement of unchanged ones with the counts reported, the edited-file block for the array form unchanged, the tag budget warning, determinism of two equal requests, and the legacy forms' pinned hashes unchanged.

## Order of implementation

1. Release and retirement report in the managed-output reconciler (independent; usable by every world write).
2. The `workspace` form: schema, validation, outputs left out, tag budget.
3. Seed ownership on `growTerritory`, after the territory service (ADR 0060) is merged.
4. The override file's `countries` section with ADR 0067 step 3.

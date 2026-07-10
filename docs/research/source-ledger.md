# HOI4 source research ledger

Reviewed 2026-07-10. These sources informed format support and tests; no installed-game or third-party-mod content is included in this repository.

## Offline wiki snapshot

The supplied offline Hearts of Iron IV wiki snapshot was consulted for:

- `Data structures - Hearts of Iron 4 Wiki.md`: ordered blocks, variables/tokens, event targets, and generic script structure.
- `National focus modding - Hearts of Iron 4 Wiki.md`: tree assignment, prerequisite grouping, relative positions, exclusions, continuous focuses, icons, AI, filters, and localisation.
- `Interface modding - Hearts of Iron 4 Wiki.md`: containers, element types, scrolling, positions, orientation, and fonts.
- `Scripted GUI modding - Hearts of Iron 4 Wiki.md`: contexts, parents, visibility, effects/triggers, dynamic lists, properties, AI, templates, and scripted localisation.
- `Graphical asset modding - Hearts of Iron 4 Wiki.md`: sprite, frame animation, progress, and bitmap-font declarations.
- `Map modding - Hearts of Iron 4 Wiki.md`: BMP headers/palettes, coordinates, definitions, terrain, buildings, unit positions, adjacency, and supply.
- `State modding - Hearts of Iron 4 Wiki.md`: state/history/province/building/resource/victory-point structure and strategic-region constraints.
- `Localisation - Hearts of Iron 4 Wiki.md`: UTF-8 BOM, language headers, key grammar, versions, escaping, and scripted localisation.
- `Triggers`, `Effects`, and `Scopes`: ordered raw trigger/effect preservation and source-reference indexing.

The wiki remains useful background, but current official files and installed examples take precedence when they differ.

## Installed official documentation

Under `<HOI4_ROOT>/documentation`:

- `script_concept_documentation.md`: collections, contextual/formatted localisation, math expressions, and script constants.
- `triggers_documentation.md`: current trigger names/scopes, state/province/focus/railway references, and dynamic argument support.
- `effects_documentation.md`: current effect names/scopes and state/province/focus references.
- `loc_objects_documentation.md` and `loc_formatter_documentation.md`: current province/state objects and font/layout-relevant localisation behavior.
- `dynamic_variables_documentation.md`, `modifiers_documentation.md`, collection input/operator documentation: tokens and raw constructs the CST must retain.

Official documentation found outside that folder was also consulted, especially:

- `common/scripted_guis/_documentation.md`: authoritative current contexts, parent attachment, dynamic lists, properties, dirty variables, effects/triggers, and AI fields.
- `common/focus_inlay_windows/documentation.md`: current inlay fields, including scripted buttons and progress bars absent from older summaries.

## Vanilla precedents

Representative read-only examples:

- `common/national_focus/generic.txt` and large country trees for repeated prerequisite blocks, OR groups, exclusions, relative positions, raw rewards, continuous focuses, and route AI.
- `interface/achievements.gui`, `interface/abilitylist.gui`, scripted-GUI interface files, and paired `.gfx` files for nested containers, lists, click regions, sprite states, and ordering.
- `common/scripted_guis/*.txt` for decision-category contexts, button effect/trigger naming, AI, dynamic lists, and parent/window connections.
- `interface/*.gfx`, `gfx/interface/**`, and `gfx/fonts/**` for horizontal frame strips, fractional animation rates, DDS/TGA/PNG textures, vector and bitmap font sources.
- `map/default.map`, `map/provinces.bmp`, `map/definition.csv`, `map/adjacencies.csv`, `map/supply_nodes.txt`, `map/railways.txt`, `map/buildings.txt`, `map/unitstacks.txt`, and `map/weatherpositions.txt` for current map formats.
- `history/states/*.txt` and `map/strategicregions/*.txt` for state/region membership and ordered history payloads.

## Current format conclusions

- The inspected installed build was HOI4 1.19.2 content dated 2026-06-12.
- `provinces.bmp` is a 5632×2048, uncompressed, bottom-up 24-bit BMP with a 40-byte DIB header.
- Other current map BMPs include indexed 8-bit DIB40 and DIB124 files; the codec must honor pixel offsets, row padding, palette size, orientation, and untouched bytes.
- Map CSV/text examples use UTF-8 without BOM and LF; localisation examples use UTF-8 BOM. The source model detects and preserves each file rather than normalizing it.
- Active placement data is in building/unit/weather files; `positions.txt` may exist but be empty. Model-local `.asset` locator blocks are a separate source family.
- `weatherpositions.txt` uses `small` and `big` tokens in the inspected build.
- Sprite textures include PNG, TGA, uncompressed DDS, DXT1/3/5, DX10 RGBA/BGRA, and RXGB variants. Frame counts divide a horizontal strip; animation rates may be fractional.
- Bitmap fonts use `.fnt` metrics/kerning and texture atlases. Locale overrides and additional script font files must remain connected in the source graph.
- Definition rows and state IDs are contiguous in the inspected build. Province ID allocation therefore records current contiguity and must not treat arbitrary gaps as universally safe.
- Only land provinces are required to belong to a state; sea provinces and some lakes legitimately do not. Every nonzero province is expected in one strategic region.
- State source does not expose a generic `capital` field. Map operations distinguish a country's capital-state reference from a state's chief victory-point/capital province and never guess between them.
- Clausewitz quoted strings decode only escaped quote and backslash. Literal newlines are invalid. Token expressions such as `variable?100` are scalar atoms; only `?=` is an operator.
- File replacement, duplicate keys, and ordering are database-specific. Same relative indexed filename shadows lower load-order sources; directly indexed files in a `replace_path` directory are removed without treating every descendant asset as removed.

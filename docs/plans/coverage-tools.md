# Coverage tools plan (issue #71, WP-8)

The maintainer chose the missing tools as one of the next improvements (P-1, 2026-11-02). This plan covers localisation, ideas, characters, the newer systems, units and assets. It closes the gaps logged as G-38, G-39 and G-40 in [the tool gaps log](tool-gaps.md). The order follows decision M-9: localisation in every language first, then ideas and characters, then the newer systems, then units and assets. Writers ship later, together with their visual editors (M-11).

## What agents need, from measurement

These come from the 2026-11-01 live test, the first real benchmark run and the head-to-head with cpntodd/HOI4-MCP (`bench/README.md`):

- **The answer inline.** The live test found answers hidden in artifacts of 5 KB to 116 MB. Every new tool returns its direct answer inline in at most 8 KB, with artifacts only for long lists and pictures.
- **Structured definitions in one call.** HOI4-MCP's `lookup_vanilla` returns an idea's or a focus's fields as data in milliseconds. Ours found the right file but returned only a location. An agent asking "what does this idea do" needs the modifiers, the conditions, the picture and the name in every language, with file and line.
- **Every language.** Today only English localisation is indexed. Mods ship up to 11 languages, and a key missing in one of them shows as the raw key in game.
- **Explicit not-found and partial.** An unknown id is a not-found with close names. A partial answer names what was skipped.
- **Speed.** Our cold paths are 6 to 54 s against targets of 2 to 3 s. New tools read only the folders they need, so they don't pay for a whole-workspace index. They will use the persistent index (#69) when it lands.

## How the tools are built

- **Rust for the analysis (D-07).** Each area is an engine command that reads the layers in load order (game, DLC, dependencies, mod) and answers one JSON request on stdin with JSON on stdout. The engine already parses script, localisation in every language and `.gfx` files, and already indexes ideas, characters, advisor tokens, sprites and localisation keys.
- **A thin TypeScript tool.** The MCP tool validates its arguments and calls the engine through `core/engine-client.ts`, as `focus_rewrite` does for the Rust layout. It has no TypeScript fallback: a missing engine is `ENGINE_UNAVAILABLE` with the reason.
- **One tool per area, with modes.** Modes are kept consistent with the existing inspect tools (`focus_inspect`, `event_inspect`), and the tool list stays short.
- **Ground truth for every tool.** Each tool gets benchmark cases with hand-checked answers on vanilla 1.19.4.1, Chaos Redux, ZIN, Ireland Total Overhaul, Kaiserreich 1.7 and Old World Blues 5.1.12. It also gets a known-good sweep that must report no false errors. Rules the files can't settle go to an in-game check.

## The tools, in order

### 1. `hoi4.localisation_inspect`

- **`key`:** one key's text in every language, with the file, line and layer of each definition and which one the game uses. It also lists where script and interface files use the key.
- **`audit`:** problems across the mod, with counts per language and a page of examples:
  - keys the mod's script or interface uses that no language defines
  - keys defined in one shipped language and missing in another
  - the same key twice in one language
  - placeholders (`$name$`, `[Root.GetName]`, `§Y` colour codes) that differ between the languages of one key
  - file problems: no UTF-8 byte order mark, a missing or second language header, or a file name that doesn't match its header
- **`coverage`:** per language, how many keys exist, how many are missing against the mod's main language, and how many are unused.

### 2. `hoi4.idea_inspect` and `hoi4.character_inspect`

- **Ideas:** the idea's category and slot, its modifiers checked against the game's modifier documentation, its `allowed`, `visible`, `available` and `cancel` conditions, its picture sprite and whether the file exists, and its name and description in every language. It also lists the script that adds, removes or swaps it. Advisor ideas defined through a character's `idea_token` are resolved to that character.
- **Characters:** the character's name in every language, and each role: country leader (ideology and traits), advisor (slot, token, cost and traits), and general, field marshal or admiral (skills and traits). It also returns the portraits per role, with sprite and file checks, the history files and effects that recruit the character, and traits checked against their definitions.

### 3. `hoi4.system_inspect`

One tool with a `kind` for each newer system: `on_actions`, `mio`, `balance_of_power`, `special_project`, `operation` and `raid`. Each kind lists the definitions and their hooks, the events and effects they fire, the localisation and pictures they need, and the references that point at nothing. `on_actions` also reports hooks that a mod's same-path file drops, reusing the engine's override audit.

### 4. `hoi4.unit_inspect` and `hoi4.asset_inspect`

- **Units:** division templates, order of battle files and equipment variants. It checks that their sub-units, equipment and modules exist and that history files load the order of battle they name.
- **Assets:** every `spriteType` and its file, with the DDS or TGA format and size checked through the engine's image header reader. Frame counts must match the texture, flag sheets need their sizes, and sound files must exist. The sprite check is shared with hoi4-imagegen-mcp.

## Delivery

Each tool lands as its own PR with the engine command, the MCP tool, the documentation, benchmark cases and the before and after numbers. It merges once every check is green (D-18). Issue #71 is split into one issue per tool when that tool's work starts.

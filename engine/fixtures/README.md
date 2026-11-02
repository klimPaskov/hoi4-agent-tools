# Engine fixtures

Everything here is synthetic and written for these tests. No file comes from the game or from a
third-party mod.

* `game/` is a miniature game installation: documentation files in the game's format with a few
  commands, a `launcher-settings.json`, DLC metadata, and a little "vanilla" content (an event
  namespace, `on_actions` hooks, a focus tree, scripted triggers and effects).
* `mods/b001/` reproduces the two defect classes Chaos Redux's live QA run B001 found only by
  launching the game: an unknown scripted trigger and an undefined effect.
  `mods/b001_valid/` is the same mod with both defined.
* `mods/on_actions_drop/` copies `common/on_actions/00_on_actions.txt` and drops two of its hooks.
* The per-rule valid and invalid fixtures are inline in `crates/engine/tests/rules.rs`.
* `sprites/game/` and `sprites/mod/` are the text of a miniature game and mod for the sprite index
  and trace tests (`crates/engine/tests/sprites.rs`). The test copies them and writes the DDS and
  TGA headers of the textures, so no image is committed.

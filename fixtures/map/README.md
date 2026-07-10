# Synthetic Agent Nudger acceptance fixture

Everything under this directory is project-owned and generated specifically for the HOI4 Agent
Tools test suite. It contains no installed-game or third-party mod content.

The active workspace intentionally resolves `default.map` from the mod root, `definition.csv` from
the dependency root, and `provinces.bmp` from the game root. States are spread across all three
roots with sparse IDs. The remaining files cover strategic regions, adjacency, supply, railways,
building/unit/weather positions, entity locators, localisation, coasts, and ports.

Run `npm run fixtures:generate:map` from the repository root to reproduce the checked-in 24-bit BMP,
source files, invalid-variant catalog, and hash manifest. Acceptance tests never run the generator;
they apply invalid mutations only to isolated temporary copies.

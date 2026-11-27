# Symbol index fixture

`expected.json` is the output of the retired TypeScript symbol index on a set of synthetic sources.
It was copied unchanged from the project's own `tests/fixtures/symbol-index/expected.json`.

Sources of the copy:

* `tests/fixtures/symbol-index/expected.json`: the expected index, diagnostics and coverage.
* `tests/helpers/symbol-index-fixture.ts`: the generator of the synthetic sources it describes
  (every definition family, localisation with and without a byte order mark, map tables, malformed
  syntax, non-ASCII text, CR LF, Windows-1252 bytes, game and shadowed files). The sources are
  written inline in that helper and are not copied here.

Everything is synthetic and project-owned. No game or mod file is included.

Used by the index parity tests that compare the engine's index with this file.

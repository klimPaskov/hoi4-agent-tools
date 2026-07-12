# Architecture

All external behavior enters through MCP and calls typed domain services. Transport code validates protocol and authorization; it does not parse source, lay out graphs, render images, or write files. The configured write policy selects the public MCP surface without changing the shared core implementation.

In this documentation, “read-only” scan, lint, layout, and render operations mean that registered HOI4 source bytes are never changed. MCP `readOnlyHint` follows the protocol's broader environmental-mutation meaning: an operation that creates content-addressed evidence under an allowlisted generated-artifact root advertises `readOnlyHint: false`, even though it cannot edit game or mod source.

```text
MCP tools/resources/prompts
          │
          ▼
focus / gui / map services
          │
          ▼
workspace resolver ─ source CST ─ symbol/reference index
          │                 │
          ├─ diagnostics ───┤
          ├─ artifact store ┤
          └─ transaction journal / diffs / rollback
```

## Workspace overlay

A workspace combines a mod root, an optional installed-game reference root, ordered dependency roots, owner-scoped `replace_path` declarations, conventional subsystem roots, an artifact root, cache root, and optional fixture root. File traversal is stable. Same-relative-path files are shadowed by higher load order; each mod or dependency replacement declaration hides its subtree only in lower-precedence roots.

Paths are canonicalized through existing ancestors. Public operations accept relative paths only and reject traversal, absolute/device/UNC paths, alternate data streams, Windows device names, and symlink or junction escapes. Game and dependency roots are immutable.

## Source model

The lexer retains original bytes and every token: whitespace, comments, strings, atoms, operators, braces, and invalid ranges. The CST retains duplicate keys and ordered blocks. Semantic readers build focus, GUI, or map views over CST ranges. Targeted replacements splice the original decoded text and encode with the original UTF-8 BOM, UTF-8, or Windows-1252 mode. No-change serialization returns original bytes.

Malformed or unrepresentable content blocks rewriting. Unknown constructs remain raw source, not guessed fields.

## Shared index

`CoreEngine.scan` creates the authoritative `SymbolIndex` for an exact file snapshot. Focus consumes it directly; Scripted GUI receives that same index when building its connected source graph; Agent Nudger attaches it as `MapWorkspaceIndex.sharedIndex` and layers raster/network semantics over it. Proposed-file graphs rebuild through the shared index service rather than a domain parser authority.

The index connects tree/focus IDs, sprites/textures, GUI elements, scripted GUI entries, localisation, state/province IDs and colors, strategic regions, adjacencies, supply nodes, railways, and cross-file references. Definitions retain load order, locations, collision state, and override evidence. Province definitions are resolved from each source root's own `default.map` selector, with lower partial roots inheriting the active selector name.

Large binary rasters and translation catalogs are selected lazily rather than retained wholesale. Agent Nudger follows the active `default.map` province-bitmap selector. The shared index uses `l_english`, while GUI scenario operations add every explicitly requested language. This narrows scan breadth without changing source precedence or the lossless representation of any selected file.

## Determinism

Canonical JSON sorts keys with a locale-independent total UTF-16 code-unit order, traversal uses stable path ordering, layout tie-breaking is fixed, and artifact names are content hashes. Render profiles include source/asset/font hashes and all scenario geometry. Timestamps, host paths, locale collation, random IDs, and time zones are excluded from hashed artifacts.

## Artifacts and write execution

Generated evidence is content-addressed below `.hoi4-agent/artifacts`. Artifact manifests bind their
immutable provenance address to a hash-only canonical workspace and configured/runtime owner
identity. Runtime-generated stores also carry an atomic persistent owner claim, while statically
configured workspaces retain one shared operator identity for their explicit grants.

The server has three configured source policies. `read-only` authorizes no source mutation.
`autonomous` registers `hoi4.focus_rewrite`, `hoi4.gui_rewrite`, and `hoi4.map_rewrite`, but not
transaction status, diff, apply, or rollback tools. `transactions` is a compatibility surface that
registers domain planning plus the separate transaction tools. MCP annotations remain truthful:
the autonomous rewrite tools advertise `readOnlyHint: false` and `destructiveHint: true`. Those
annotations do not mandate a client prompt, and the server cannot override its host's approval
policy.

Internally, both write policies call the same transaction core. A journal includes the complete affected-file set, before/after hashes and blobs, operation
provenance, validation, source/binary/visual diffs, expiry, principal, workspace/root fingerprint,
and plan hash. Its complete mutable journal is HMAC-authenticated by a random key beneath the
isolated `serverStateRoot`; a protected latest-revision head prevents replay and bounds state to one
head per admitted cache journal.

In autonomous mode, the domain tool plans and validates, admits the journal, applies, rebuilds the
index, and post-validates inside one call. Apply acquires one workspace write lock, rechecks
preconditions, stages files on the same volume, and journals deterministic replacements. Failure
and startup recovery restore original blobs automatically. This is recoverable logical atomicity;
another process can briefly observe a replacement sequence, but the server never reports success
for a partial result.

Git provides durable project history and collaboration. The internal journal is deliberately
independent of Git so failed multi-file writes recover even in an unversioned workspace.

Detailed decisions are recorded in [ADRs](adr/README.md).

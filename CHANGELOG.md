# Changelog

All notable changes are documented here. The project follows Semantic Versioning.

## [0.1.7] - 2026-07-12

### Added

- Shipped an agent-integration guide as package documentation and an MCP resource, with persistent stdio registration, autonomous capability-selection rules, ranged artifact reads, and complete large focus-tree repair and creation workflows.
- Added setup flags for stable workspace IDs and display names, plus both pinned `npx` and global-install client registration output.

### Changed

- Made MCP initialization instructions, prompts, metadata, and public documentation explicitly agent-first: coding agents proactively select HOI4 capabilities, while the separate hash-bound apply call remains governed by the coding-agent host's configured write policy.
- Documented and advertised the fixed-to-automatic position transition required to opt an imported authored tree into full deterministic layout cleanup without silently moving source coordinates.

### Fixed

- Indexed only top-level event definitions instead of treating nested event calls as definitions, eliminating false event collisions and preventing valid mod symbols from being crowded out by game references.
- Raised the bounded shared inventory to 500,000 symbols/references so a current game plus a feature-rich mod fits with safe headroom, and recorded the affected kind when a symbol ceiling drops a definition.
- Reported unresolved focus sprites, localisation, and gameplay links as partial warnings only when an intentionally skipped source family could define that exact symbol kind; genuinely missing references remain missing diagnostics.
- Made large-tree automatic layout reuse a coordinate occupancy index and incrementally cached connectors, bounded crossing optimization to a local 129-column window, and stopped evaluating a candidate as soon as it cannot beat the current crossing count. Complex 200+ focus plans now fit beneath the unchanged 500,000-operation safety ceiling instead of letting one unavoidable crossing exhaust the request.
- Allowed national `focus_render` and `focus_plan_changes` calls to choose a bounded uniform viewport/raster scale; transaction plans also accept review-only spacing and padding. The server applies transaction settings to both before and proposed renders, so unusually wide or deep trees can retain meaningful baseline, diff, and final evidence without crowding node geometry, changing source-grid coordinates, or weakening artifact limits.
- Modelled safe file-scoped focus-cost constants such as `cost = @focus_cost_standard` and preserved their exact source lexemes during layout-only updates. Unchanged numeric spellings and still-unmodelled cost tokens are also left byte-identical; deliberate supported cost edits remain targeted scalar replacements.
- Kept large focus transactions below fixed manifest limits by storing complete proposed and post-write validation diagnostics as source-linked MCP resources. Transaction manifests retain blocker-first bounded summaries and explicit resource links while validation decisions still evaluate every diagnostic.

## [0.1.6] - 2026-07-11

### Fixed

- Omitted the redundant explicit `isSecret: false` environment-variable value because the pinned official Registry schema defines the field's default as false and the Registry canonically omits that default from published metadata.
- Kept strict byte-structural equality between checked-in `server.json` and the official Registry response instead of weakening verification with a broad normalizer.
- Preserved the immutable complete `v0.1.5` npm, GHCR, GitHub Release, and MCP Registry publication whose final cross-surface verifier stopped only on the schema-default serialization difference, then advanced every synchronized release surface for the fix-forward release.

## [0.1.5] - 2026-07-11

### Fixed

- Accepted the live GitHub Releases API's empty-string representation for an omitted optional asset label while continuing to reject every non-empty alternate label.
- Added coverage for both canonical no-label representations and retained strict name, count, uploader, upload state, size, digest, API URL, and downloaded-byte verification for every release asset.
- Preserved the immutable `v0.1.4` npm package and GHCR image plus its exact unpublished GitHub draft after the draft verifier stopped before Release publication or MCP Registry publication, then advanced every synchronized release surface for the fix-forward release.

## [0.1.4] - 2026-07-11

### Fixed

- Verified BuildKit's commit-resolved Git context URI and digest while independently requiring the exact release tag, repository, release workflow ref, workflow SHA, push event, and `publish_image` job recorded in container provenance.
- Added refusal coverage for altered container source URIs, digests, Dockerfile entry points, event/job identities, tag refs, repository identities, workflow refs, and workflow SHAs.
- Preserved the immutable `v0.1.3` npm package and GHCR image whose post-push provenance verifier stopped before GitHub Release or MCP Registry publication, then advanced every synchronized release surface for the fix-forward release.

## [0.1.3] - 2026-07-11

### Fixed

- Centralized the canonical slash-terminated npm Registry URL used by both the pinned npm audit subprocess and the strict provenance verifier, preventing equivalent configuration serialization from blocking verified publication.
- Added refusal coverage for no-slash, insecure, credential-bearing, path-bearing, query-bearing, fragment-bearing, and lookalike npm Registry values.
- Preserved the immutable `v0.1.2` tag and public npm package whose downstream verification stopped before GHCR, GitHub Release, or MCP Registry publication, then advanced every synchronized release surface for the fix-forward release.

## [0.1.2] - 2026-07-11

### Fixed

- Canonicalized the downloaded release artifact to a contained absolute path before calling npm, preventing npm from interpreting a slash-containing relative tarball path as a GitHub repository shorthand.
- Preserved the immutable failed `v0.1.1` tag as audit evidence and advanced every synchronized release surface for the first public stable publication.

## [0.1.1] - 2026-07-11

### Fixed

- Allowed the first stable OIDC release only when npm reports the exact two-tag, one-version bootstrap state created by `0.0.0-bootstrap.1`; all additional, altered, stale, or ambiguous prerelease states still fail closed.
- Preserved the immutable failed `v0.1.0` tag as audit evidence and advanced the synchronized package, server, Registry, schema, documentation, and client surfaces for the first public stable release.

## [0.1.0] - 2026-07-11

### Added

- Lossless Clausewitz source model, cross-root symbol index, diagnostics, content-addressed artifacts, hash-bound transactions, crash recovery, and byte-exact rollback.
- Focus Tree Workbench with planning models, stable layouts, route linting, source maps, continuous-focus palettes, and HTML/SVG/PNG/JSON review artifacts.
- Scripted GUI Studio with connected GUI/GFX/script/localisation graphs, source-frame animation provenance, state and resolution galleries, comparisons, click and hierarchy reports, and per-render fidelity reports.
- Bounded declarative GUI templates with deterministic expansion, type-aware HOI4 element compilation, explicit state variants, anchored layouts, grid-backed scroll-list handoffs, frame-based meters, and a counted raw escape hatch.
- Agent Nudger declarative state, province geometry, strategic-region, adjacency, supply, railway, position, locator, ID, color, and map-rendering workflows.
- Namespaced MCP tools, prompts, opaque resources, stdio and secured Streamable HTTP transports, setup diagnostics, package metadata, container publishing, and official MCP Registry release automation.

### Fixed

- Hardened generated artifact and transaction storage against descendant symlink/junction and Windows device-path escapes, restored interrupted runtime registrations before reuse, bounded artifact chunk and aggregate HTTP memory, sanitized internal MCP errors, corrected IPv6 loopback endpoints, rejected aliased transaction targets and opaque origins, separated writable runtime-mod roots from read-only source registration, and serialized monotonic releases.
- Defined polygon edits with an explicit even-odd fill rule and integer raster-boundary coordinates, accepting the right/bottom edge while refusing overflow before raster work or allocation.
- Made interrupted GitHub release publication recover through authenticated paginated draft discovery, unique release-ID binding, canonical bot-authored title/body/asset metadata, exact uploaded-asset verification, and immutable completed-rerun checks.

### Security

- Persisted atomic hash-only runtime registration claims and bound every artifact manifest/read/list/describe operation to the canonical workspace and owner identity.
- Added an isolated operator `serverStateRoot`, random journal HMAC key, protected revision heads, exact-successor crash reconciliation, replay-safe bounded retention, strict journal schemas, and compact transaction structure limits.
- Replaced non-hash create/delete provenance sentinels with explicit state metadata and added cancellation to artifact verification and rollback preflight.
- Reserved the artifact-manifest filename namespace case-insensitively and made write-enabled setup require and diagnose an explicit isolated server-state root.
- Kept read-only transaction inspection side-effect free, added cancellable bounded manifest reads and range caching, and refused post-validation or manifest-byte growth before it could create an unloadable journal.

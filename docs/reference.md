# Local references and source lookup

The reference tools read only local, authorized sources. They do not fetch the Paradox Wiki or start Hearts of Iron IV. The installed game's documentation has the highest authority for current syntax; the offline wiki supplies broader modding guidance. A result identifies its source, path, exact lines, and SHA-256 revision so an agent can inspect only the relevant section.

The server discovers these directories for a workspace:

| Source                         | Default location                                                            | Optional workspace registration                        |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Installed game documentation   | `gameRoot/documentation/**/*.md` and `gameRoot/common/**/*documentation.md` | Configure `gameRoot`.                                  |
| Offline wiki                   | `modRoot/paradox_wiki/**/*.md`                                              | Set absolute `wikiRoot`.                               |
| Generated script documentation | `modRoot/script_docs/**/*.md` and `**/*.log`                                | Set absolute `scriptDocsRoot` to a user-supplied dump. |

Only Markdown headings and recognizable standalone names in generated `.log` files form sections. A dump that yields one section should be treated as insufficiently parsed; inspect its source format before relying on it. Source bytes are hashed on each request, while unchanged section indexes are reused. Missing roots are reported as unavailable. The public package contains none of these local source files.

## Tools

- `hoi4.reference_context`: request a surface such as `event`, `focus`, `technology`, `gui`, or `map`. It reserves citations for available installed documentation and offline wiki sources before adding further question matches. Supply `question` to select the best matching section within each required source. At a limit of two or more, both source kinds are represented when available; a one-result limit prioritizes installed documentation. `omittedSources` names required sources excluded by the result limit, while `missing` names sources absent from the configured roots. Increase the limit or search an omitted source directly before treating the bundle as sufficient. Citations are pointers and excerpts; read the pertinent sections before changing code.
- `hoi4.reference_search`: search page names, headings, exact script tokens, and matching body lines. The default limit is six results and the maximum is twelve. Filter `sources` to `game_doc`, `wiki`, or `script_doc` when appropriate.
- `hoi4.reference_read`: provide a search/context result's `id` and `revision`. Read up to 80 lines and 8,000 UTF-8 bytes. Continue with the returned `nextLine`, `nextColumn` as `startColumn`, and the same revision. Long source lines continue without losing characters. A changed source returns `REFERENCE_REVISION_STALE`.
- `hoi4.source_lookup`: find exact definitions and indexed usages in the installed game and configured mod source. The response includes load order, override status, up to three source blocks bounded to 2,000 bytes each, a scan revision, and explicit reference counts and truncation. Follow `nextLine` and `nextColumn` as `fromLine` and `fromColumn`, with `expectedRevision`, to read more of the active definition.

Example:

```json
{ "workspaceId": "current", "surface": "event", "question": "save_event_target_as" }
```

Call `hoi4.reference_context` with that input, then search `save_event_target_as` and pass the result's `id` and `revision` to `hoi4.reference_read`. Use `hoi4.source_lookup` for an exact event, effect, or other indexed symbol. Run `hoi4.event_inspect` and the relevant render/compare/scenario tools for the event itself; references do not validate a mod implementation.

The local index admits at most 512 files per source kind, 2 MB per file, 32 MB in total, and 20,000 sections. Search and read responses are bounded by the MCP result budget. `skipped` and per-source coverage expose incomplete ingestion instead of implying that an omitted source was checked. Registered external reference roots are operator configuration and remain private to the authorized workspace.

See [the measured Chaos Redux reference retrieval](research/reference-benchmark.md) for actual source coverage and response sizes.

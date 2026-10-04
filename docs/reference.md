# Local references and source lookup

The reference tools read only local, authorized sources. They do not fetch the Paradox Wiki or start Hearts of Iron IV. The installed game's documentation has the highest authority for current syntax; the offline wiki supplies broader modding guidance. A result identifies its source, path, exact lines, and SHA-256 revision so an agent can inspect only the relevant section.

The server discovers these directories for a workspace:

| Source                         | Default location                                                            | Optional workspace registration                        |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Installed game documentation   | `gameRoot/documentation/**/*.md` and `gameRoot/common/**/*documentation.md` | Configure `gameRoot`.                                  |
| Offline wiki                   | `modRoot/paradox_wiki/**/*.md`                                              | Set absolute `wikiRoot`.                               |
| Generated script documentation | `modRoot/script_docs/**/*.md` and `**/*.log`                                | Set absolute `scriptDocsRoot` to a user-supplied dump. |

Markdown headings and recognizable standalone names in generated `.log` files form sections. A Markdown table row whose first cell is an identifier, such as a wiki effect, trigger, modifier, define, or on action, is also its own one-line section, so a citation can name the exact entry inside a long table. A dump that yields one section should be treated as insufficiently parsed; inspect its source format before relying on it. Source bytes are hashed on each request, while unchanged section indexes are reused. Missing roots are reported as unavailable. The public package contains none of these local source files.

## Tools

- `hoi4.reference_context`: request a surface such as `event`, `focus`, `technology`, `gui`, or `map`. It reserves citations for available installed documentation and offline wiki sources before adding further question matches. Supply `question` to select the best matching section within each required source. At a limit of two or more, both source kinds are represented when available; a one-result limit prioritizes installed documentation. `omittedSources` names required sources excluded by the result limit, while `missing` names sources absent from the configured roots. Increase the limit or search an omitted source directly before treating the bundle as sufficient. Citations are pointers and excerpts; read the pertinent sections before changing code.
- `hoi4.reference_search`: search with plain words or exact script tokens. Ranking weighs headings above body text and rare words above common ones, and it matches identifiers both whole and by their words, so "check if a state is controlled by a country" can find `is_controlled_by`. A query that names an identifier only matches sections containing it, an exact heading ranks first, and installed documentation precedes the wiki when they rank equally. Each result's `matchLine` is the cited line that best matches the query; pass it as `startLine` to `hoi4.reference_read` to land on the answer inside a long section. When several sources document the same name, the first copy keeps its place and later copies follow other distinct answers. The default limit is six results and the maximum is twelve. Filter `sources` to `game_doc`, `wiki`, or `script_doc` when appropriate. Only selected authorities are scanned; `coverage.included = false` means that an authority was excluded from this query, not that it is missing.
- `hoi4.reference_read`: provide a search/context result's `id` and `revision`. Optionally pass its `source` for a focused authority read; resident citations provide this hint automatically. Read up to 80 lines and 8,000 UTF-8 bytes, with JSON escaping also bounded. Continue with the returned `nextLine`, `nextColumn` as `startColumn`, and the same revision. Long source lines continue without losing characters. A changed source returns `REFERENCE_REVISION_STALE`.
- `hoi4.source_lookup`: find exact definitions and indexed usages in the installed game and configured mod source. The response includes load order, override status, up to three source blocks bounded to 2,000 bytes each, a scan revision, and explicit reference counts and truncation. Follow `nextLine` and `nextColumn` as `fromLine` and `fromColumn`, with `expectedRevision`, to read more of the active definition.
- `hoi4.script_validate`: check a bounded effect or trigger body against installed native-command documentation. Supply the body in `source`, its `kind`, and its current `scope`. Results cover syntax, command kind, and declared scope, with exact documentation citations. They do not validate command parameters or prove game execution.

## Navigate a definition

Use `view: "structure"` to list the immediate children of the active definition, then pass `keyPath` to select a nested block or scalar assignment.
Keyed path steps have a `key` and an optional zero-based `occurrence`; repeated keys require an explicit occurrence.
Use an `{ "index": 1 }` step to select an unkeyed array entry or a child with an unusually long key.
For example, `[{"key":"option","occurrence":1},{"key":"hidden_effect"}]` selects the second option's hidden effects.
Navigation reads exact parser boundaries, including when several assignments share a line.
If an identifier has multiple symbol kinds, supply `kind` before navigating it.
Override counts remain visible, while navigation selects the active definition.

Structure replies have at most 40 children.
They also have a byte ceiling, with `keyTruncated` and `valueTruncated` identifying shortened previews.
Continue with `navigation.nextChildOffset` as `childOffset`, retaining the same `keyPath`, query settings, and `expectedRevision`.
Source replies continue with `nextLine` and `nextColumn` as before.
Use `includeReferences: false` with an exact `event`, `scripted_effect`, or `scripted_trigger` kind when only the definition is needed; this limits scanning to that source family.
Enable references when looking for consumers across the workspace.
Event-consumer queries scan the source families supported by event reference analysis rather than unrelated presentation files.
`sourceScope` labels the scanned surface, and `definitionsTruncated` and reference omission fields identify bounded output.
Revisions describe the selected scan, so keep the scan settings unchanged during continuation.

## Check native commands

`hoi4.script_validate` accepts a standalone effect or trigger body rather than an entire event or focus definition.
It recognizes documented control wrappers, conditional limits, country/state iterators, fixed country/state scopes, and the `ROOT`, `THIS`, and `PREV` traversal context.
Use `bindings` to declare external scope names such as `event_target:recipient` when their type is known.
Those bindings are supplied facts, not observed game state.

The default documentation authority is `game_doc`.
Use `documentation: "script_doc"` explicitly for a configured generated dump; the checker does not silently mix authorities or substitute wiki text for native signatures.
It reads supported scopes from `effects_documentation.md`, `triggers_documentation.md`, and corresponding `effect_docs.log`/`trigger_docs.log` files.

`valid: false` identifies a syntax, kind, or scope error.
`valid: null` identifies missing or conflicting documentation, an unresolved command/helper, an unchecked native argument block, or exhausted coverage.
`valid: true` applies only to `checksPerformed`; `parametersChecked` remains false.
Inspect the cited parameter syntax and use the relevant domain tools for broader validation.
Replies prioritize problems, bound `findings`, and report `omittedFindings`; execution is bounded to 256 visited entries and 64,000 UTF-8 source bytes.
Search and context replies also report `limitedByBytes` when metadata exceeds their reply budget.
Read omitted required sources with targeted calls rather than repeatedly requesting the same oversized bundle.
Reference text supports UTF-8, Windows-1252, and explicitly BOM-marked UTF-16; native engine source encoding rules remain separate.

Example:

```json
{ "workspaceId": "current", "surface": "event", "question": "save_event_target_as" }
```

Call `hoi4.reference_context` with that input, then search `save_event_target_as` and pass the result's `id` and `revision` to `hoi4.reference_read`. Use `hoi4.source_lookup` for an exact event, effect, or other indexed symbol. Run `hoi4.event_inspect` and the relevant render/compare/scenario tools for the event itself; references do not validate a mod implementation.

The local index admits at most 512 files per source kind, 2 MB per file, 32 MB in total, and 20,000 sections. Search and read responses are bounded by the MCP result budget. `skipped` and per-source coverage expose incomplete ingestion instead of implying that an omitted source was checked. Registered external reference roots are operator configuration and remain private to the authorized workspace.

See [the measured Chaos Redux reference retrieval](research/reference-benchmark.md) for actual source coverage, held-out discovery results, and response sizes. Plain-word questions still miss when the documentation uses different vocabulary, for example "national spirit" for `ideas`; search the script name directly when it is known.

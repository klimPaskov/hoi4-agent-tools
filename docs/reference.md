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

- `hoi4.reference_context`: request one surface: `general`, `event`, `decision`, `idea`, `focus`, `technology`, `gui`, `map`, `localisation`, or `ai`. The default limit is 16 citations and the maximum is 24. It reserves citations for available installed documentation and offline wiki sources before adding further question matches. Supply `question` to select the best matching section within each required source. At a limit of two or more, both source kinds are represented when available; a one-result limit prioritizes installed documentation. `omittedSources` names required sources excluded by the result limit, while `missing` names sources absent from the configured roots. Increase the limit or search an omitted source directly before treating the bundle as sufficient. Citations are pointers and excerpts; read the pertinent sections before changing code.
- `hoi4.reference_search`: search with plain words or exact script tokens. Ranking weighs headings above body text and rare words above common ones, and it matches identifiers both whole and by their words, so "check if a state is controlled by a country" can find `is_controlled_by`. A query that names an identifier only matches sections containing it, an exact heading ranks first, and installed documentation precedes the wiki when they rank equally. Each result's `matchLine` is the cited line that best matches the query; pass it as `startLine` to `hoi4.reference_read` to land on the answer inside a long section. When several sources document the same name, the first copy keeps its place and later copies follow other distinct answers. The default limit is six results and the maximum is twelve. Filter `sources` to `game_doc`, `wiki`, or `script_doc` when appropriate. Only selected authorities are scanned; `coverage.included = false` means that an authority was excluded from this query, not that it is missing.
- `hoi4.reference_read`: provide a search/context result's `id` and `revision`. Optionally pass its `source` for a focused authority read; resident citations provide this hint automatically. Read 40 lines by default, set `maxLines` up to 80, and at most 8,000 UTF-8 bytes, with JSON escaping also bounded. Continue with the returned `nextLine`, `nextColumn` as `startColumn`, and the same revision. Long source lines continue without losing characters. A changed source returns `REFERENCE_REVISION_STALE`.
- `hoi4.source_lookup`: find exact definitions and indexed usages in the installed game and configured mod source. The response includes load order, override status, up to three source blocks bounded to 2,000 bytes each, a scan revision, and explicit reference counts and truncation. Follow `nextLine` and `nextColumn` as `fromLine` and `fromColumn`, with `expectedRevision`, to read more of the active definition.
- When `hoi4.source_lookup` finds no definition, `suggestions` lists up to five indexed identifiers within three edits of the requested symbol, nearest first, which catches typos and near-miss names.
- `hoi4.source_lookup` with `path` and `line` instead of `symbol` locates a source position, such as a diagnostic or a changed line in a diff. `path` may be a result path such as `mod:events/example.txt`, a path relative to a source root, or an absolute path inside one. The result names the file's layer and whether a later layer shadows it, the indexed definitions that contain the line, innermost first, and the chain of enclosing assignments with zero-based occurrences for repeated keys. Its `keyPath` starts inside the innermost definition: pass that definition's `id` as `symbol`, its `kind`, and the `keyPath` to read or list that exact block. Without `column`, the first non-blank character of the line is used. A file with parse errors returns its definitions but no structural chain. Only the requested file's folder is scanned, in every layer.
- `hoi4.script_validate`: check a bounded effect or trigger body against installed native-command documentation. Supply the body in `source`, its `kind`, and its current `scope` (`country`, `state`, `character`, `combatant`, `ace`, `strategic_region`, `operation`, `industrial_org`, `purchase_contract`, `raid_instance`, `special_project`, or `faction`). `limit` (1–32, default 12) bounds the returned findings. Results cover syntax, command kind, and declared scope, with exact documentation citations. They do not validate command parameters or prove game execution.
- `hoi4.script_validate` with `path` instead of `source` checks a whole mod file: every effect and trigger body of an event, decision, national focus, scripted effect, scripted trigger, or on-action file, with the scope the file's structure fixes. It is meant to catch the game's own load errors before launch.

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

### Check a whole file

Pass `path` (a result path, a path relative to a source root, or an absolute path inside one) without `source`, `kind`, `scope`, or `bindings`.
The file's folder decides its family and root scopes: event `trigger`, `immediate`, `after`, and option bodies use the event type's scope; decision and focus triggers and effects use country scope; scripted effects, scripted triggers, on actions, and decision `target_trigger` bodies have no fixed scope, so their command kinds are checked and scope rules are skipped.
`file` reports the family, the number of checked bodies, and how many had no fixed scope; a body without a fixed scope keeps `valid` at `null`.
File mode lists only problems: matching commands are counted in `checkedCommands`, and unchecked native argument blocks are counted in `argumentBlocksUnchecked`.
It is bounded to 50,000 visited entries.

The mod's scripted effects and triggers count as known commands of their kind.
Building, ideology, and resource names count as the documented generic triggers that take them as keys (`arms_factory > 2`, `communism > 0.4`), from the documentation's supported lists and from the `common/buildings`, `common/ideologies`, and `common/resources` databases of every source layer.
`FROM`, chained keywords, `event_target:`, `var:`, `mio:`, and `sp:` blocks are checked for command kinds without scope rules.

Two checks predict load errors the game reports:

- `SCRIPT_DYNAMIC_VARIABLE_AS_TRIGGER`: a dynamic variable from `dynamic_variables_documentation.md` compared directly as a trigger, such as `num_owned_states > 1`; compare it with `check_variable` instead.
- `SCRIPT_SCOPE_LINK_WRONG_SCOPE`: a scope link used outside the scopes the wiki's Scopes page allows, such as `controller` in country scope.

The scope links `owner`, `controller`, `capital_scope`, `overlord`, and `faction_leader` are recognized in any letter case in both modes.

### Player-facing text

For event, decision, and national focus files, file mode also checks English text as the game resolves it, from the last loaded definition of each key, and adds `player_text` to `checksPerformed`.
These findings have `status: "warning"` and never change `valid`:

- `SCRIPT_NEWS_TEXT_COLOUR_CODE`: a news event, or an event with a `GFX_report_event` picture, whose title, description, or option text contains a `§` or `£` code, directly or through a `defined_text` branch it shows.
- `SCRIPT_TEXT_IMPLEMENTATION_WORDING`: event text, or a decision's or focus's name or description, containing development wording such as TODO, placeholder, hardcoded, newly added, or reworked.
- `SCRIPT_FLAG_TOOLTIP_UNLOCALISED`: a `has_country_flag`, `has_global_flag`, or `has_state_flag` check in a decision's `available` block or a focus's `available` or `bypass` block whose flag has no localisation key, so the requirement tooltip prints the raw flag name. Checks inside `hidden_trigger` and `custom_trigger_tooltip` are skipped, and scripted triggers called from those blocks are not expanded.

Each message names the localisation file and line that carries the text.

### Repeated event windows

File mode reports `SCRIPT_EVENT_POPUP_REPEATED` warnings for any family and adds `event_popups` to `checksPerformed`.
A visible event fired inside an `every_*` loop reaches one player once per loop member when it is sent to a fixed recipient (`ROOT`, `FROM`, `PREV`, `global`, a tag, an `event_target:` or a `var:` scope), or when it is `major = yes` without `fire_only_once`, because a major event is shown to every country.
An event sent to each loop member in turn, a hidden event, and an event the scanned sources do not define are not reported.
Scripted effects called inside a loop are checked in their own file, not followed from the caller.
Search and context replies also report `limitedByBytes` when metadata exceeds their reply budget.
Read omitted required sources with targeted calls rather than repeatedly requesting the same oversized bundle.
Reference text supports UTF-8, Windows-1252, and explicitly BOM-marked UTF-16; native engine source encoding rules remain separate.

## Read the game's error log

`hoi4.error_log` reads `logs/error.log` from the game's user folder, the folder that also holds `mod/` and `save games/`.
The server finds it from the configured `gameUserRoot`, then the user folder that contains the mod when the mod sits in its `mod/` folder, then the operating system's default user folder locations.
It reads the last 16 MiB of the log, joins continuation lines, and groups identical messages with a count.

Each entry has a `category`: `syntax`, `duplicate`, `localisation`, `effect`, `trigger`, `scope`, `graphics`, `interface`, `map`, `missing_reference`, or `other`.
When the message names a file, the entry gives the file, the line when known, and its layer (`mod`, `dependency`, `game`, or `unknown`).
`changedSinceLog` is `true` when that file was modified after the log was written, so the error may already be fixed; relaunch the game to confirm.
Mod entries are listed first.

Filter with `scope` (`all`, `mod` for entries in the mod's own files, or `unlocated` for entries naming no file), `category`, or a text `query`, and page with `limit` (1–50, default 20) and `offset`.

```json
{ "scope": "mod", "category": "scope", "limit": 10 }
```

The tool reads the log the game wrote at its last launch; it never starts the game.
Run `hoi4.script_validate` with `path` on the reported file to check the same body before the next launch.

## Index the mod and pick free IDs

`hoi4.mod_index` with `mode: "overview"` summarizes the mod without reading every file:

- `descriptor`: the `descriptor.mod` name, version, supported game version, tags, dependencies, `replace_path` entries and Workshop ID;
- `kinds`: how many definitions of each kind the mod contains, such as events, focuses, decisions and scripted effects;
- `folders`: file counts and sizes per top-level folder, and per `common/` subfolder;
- `namespaces`: each event namespace with its number of events, lowest and highest number, and file count.

Set `layer: "all"` to count active definitions across the game, DLC, dependencies and the mod instead of the mod alone.

`mode: "next_id"` finds the next free numbered identifier for an event `namespace` or any `prefix` of one `kind` (`event`, `focus`, `decision`, `idea`, `leader` or `technology`).
It checks every source layer, so a new ID never collides with a game or dependency definition.
The result gives `nextId` after the highest used number, and `firstGapId` when a lower number is unused.

```json
{ "mode": "next_id", "kind": "event", "namespace": "my_mod" }
```

## Example

```json
{ "workspaceId": "current", "surface": "event", "question": "save_event_target_as" }
```

Call `hoi4.reference_context` with that input, then search `save_event_target_as` and pass the result's `id` and `revision` to `hoi4.reference_read`. Use `hoi4.source_lookup` for an exact event, effect, or other indexed symbol. Run `hoi4.event_inspect` and the relevant render/compare/scenario tools for the event itself; references do not validate a mod implementation.

The local index admits at most 512 files per source kind, 2 MB per file, 32 MB in total, and 20,000 sections. Search and read responses are bounded by the MCP result budget. `skipped` and per-source coverage expose incomplete ingestion instead of implying that an omitted source was checked. Registered external reference roots are operator configuration and remain private to the authorized workspace.

See [the measured Chaos Redux reference retrieval](research/reference-benchmark.md) for actual source coverage, held-out discovery results, and response sizes. Plain-word questions still miss when the documentation uses different vocabulary, for example "national spirit" for `ideas`; search the script name directly when it is known.

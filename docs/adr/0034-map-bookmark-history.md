# 0034. Map state history uses the active bookmark basis

## Context

HOI4 state files may contain dated commands inside `history = { ... }`. The map index previously read only direct history assignments. An update could therefore change a direct owner, core, victory point, or building value while an earlier dated command continued to determine the effective value at the first bookmark. State splitting or merging could also copy or remove a state's direct values without carrying its dated behavior. The installed bookmark files and offline State/Bookmark modding references provide the date semantics; the reviewed HOI4 Map Editor also treats dated history as a separate save-planning concern.

## Decision

The map scan includes active `common/bookmarks/*.txt` files and records the earliest valid bookmark date. The state index projects supported owner, controller, core/claim add or removal, victory-point, and building commands in dated blocks strictly earlier than that date, in date and source order. If no bookmark date is available, the direct state values remain visible with an explicit warning.

The rewrite planner preserves every dated source block. It refuses changes to fields shadowed by applicable dated commands, refuses province-membership changes that would require remapping dated victory points or buildings, and refuses source-state split or merge when dated history cannot be distributed safely. Later dated commands remain after a direct edit and may change the field at a later start date. The blocker names the affected state, field, date, bookmark, source path, and operation.

## Consequences

Read-only owner and controller layers use the same first-bookmark basis as the state catalog where supported. Source-preserving direct edits remain available for unrelated values. Date-block mutation and distribution remain explicit unsupported cases instead of silently producing misleading map evidence. Tests cover an applicable date, later date, missing bookmark, unrelated direct edit, and split/merge refusal. The map tools still require real-workspace smoke evidence before a broad reliability claim.

# Native panel boundaries and default preview state

## Context

The division designer combined HQ and division branches, opened every native selector and shifted children by half the centered root's dimensions. Dropdown role blocks were flattened into their parent, losing the expanded panel's background, visibility and clipping. Explicitly clipped, background-free scroll containers were rejected.

## Decision

Child orientation defaults to the local upper left independently of parent `origo`. This corrects the inherited-origin rule in ADR 0023. A centered root controls its own placement, not the anchor of every child.

Recognize `expandButton` and `expandedWindow` as elements only inside `dropDownBoxType`. Preserve their source type, provenance and panel boundary. Expanded windows use settled `show_position` and default to closed; the existing scenario values dictionary binds `<dropdown>.expanded`. Direct visibility overrides remain authoritative. Expanded windows support the same clipping and extended scrollbars as containers.

Division/HQ branches and native selectors have an explicit documented preview convention through the existing values dictionary. Defaults choose the division branch and close selectors. Scope branch defaults to the intended root controls so reused names inside panels remain independent. Compose selector panels after ordinary root controls, matching their foreground role. Report the convention as an approximation and do not fabricate runtime rows, statistics or conditional icons.

An attached scrollbar establishes a clipped viewport by default; no decorative background is required. Explicit `clipping = no` remains unsupported for attached scrolling. Keep diagnostics for nonpositive bounds, wrong axes, duplicate bindings and missing/private templates. Resolve public scrollbar definitions independently of unrelated private namesakes.

## Validation

Synthetic tests cover centered roots, mutually exclusive branches, overrides by name and ID, unrelated windows, dropdown boundaries, settled positions, hidden descendants, scoped expansion, clipped containers without backgrounds, scroll endpoints and invalid bindings. Installed native definitions and the full external workspace are opt-in visual evidence, never committed fixtures. Public tool schemas are unchanged.

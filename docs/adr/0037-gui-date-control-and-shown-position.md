# ADR 0037: GUI date, controller facts, and shown position

Status: accepted

## Context

Explicit GUI fixtures could not express a date or state-controller map, even though source conditions depended on them. The shared evaluator supported dates but the GUI schema and adapter dropped that route. Native decisions and occupation windows also define an offscreen starting position and a visible `show_position`; static rendering used the former and could return a blank window.

## Decision

Accept a validated date and bounded state-ID-to-controller map in GUI scenarios. Forward both into the shared condition model. Resolve `controls_state` and `is_controlled_by` only from declared controller facts, with an unresolved result for missing state or country bindings. Permit the same controller map in probability and declared analysis scenarios so related evidence uses one contract.

Render a requested root window at its source-defined settled `show_position`, retaining ordinary local positions for descendants. This represents the visible static window and does not approximate transition animation curves.

Honor `multiline = no` by disabling automatic line wrapping while retaining overflow diagnostics. Installed `countryoccupationview.gui` uses this for its country-filter label. Its title also combines a 36-pixel bitmap font with `maxHeight = 20`; inferred text heights retain at least one font line, while explicit `size` rectangles and parent clips remain strict. The latter convention is reported as `text_minimum_line_height` in approximated fidelity because no matched engine capture establishes that behavior.

## Evidence boundary

These fields prove evaluation under explicit assumptions, not historical control or live engine receipts. Source-derived views, per-control hover states, click regions, and boundary scenarios remain distinct from actual game execution. Engine transfers and delayed-event scheduling require supplied runtime evidence.

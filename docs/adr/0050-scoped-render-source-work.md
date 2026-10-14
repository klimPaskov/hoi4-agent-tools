# ADR 0050: Scoped render source work

## Context

A full external mod timed out before GUI rasterization. A GUI preview built generic symbol indexes, rebuilt those indexes while constructing its domain graph, scanned thousands of unbound country flags, and searched the whole workspace for missing alternative texture extensions. Each state also rebuilt condition definitions from a newly allocated snapshot wrapper. Technology rendering indexed mod and game sources separately and then indexed their combined inventory again.

## Decision

GUI graphs collect parser coverage through the typed core index service during domain parsing. They retain skipped-source diagnostics without allocating an unrelated symbol inventory. Window previews retain linked decision references, select layout and sprite source files for their final graph, and restrict basename fallback to configured graphics/interface roots and fonts. A resolved texture or font stem satisfies its alternative extensions. Country flag reads follow scenario bindings. Full GUI inspection continues to include linked decisions.

Condition definitions are cached by the immutable scanned-file array, not a short-lived wrapper. Files without an `@` byte cannot declare a local constant and do not need a separate local-constant parse. Existing scanner byte limits, parser ceilings, graph ceilings, decoded-pixel reservations and worker recycling remain enforced. Scans still revalidate canonical paths and source bytes; no directory-age cache bypasses authority or freshness checks.

Technology sources use one core scan across layers, preserving incremental and authenticated persistent indexing. Folder renders omit inbound event, decision, focus and history references; their analysis assumptions identify that scope. Inspection and non-folder views retain those references. Asset decoding remains limited to the sprites selected by the requested view.

Service phase notifications identify scanning, graph construction, asset loading, layout and rasterization. Phase transitions yield and check cancellation. Existing worker supervision still stops synchronous work that exceeds its deadline; deadline errors now include the last reported phase.

Localisation retains the transitive `$KEY$` dependency closure across files. Text expansion is bounded by the existing text budget, a 16-level recursion limit and cycle detection. Missing tokens and engine-only values remain unresolved. Numeric flag declarations also satisfy scalar flag-presence checks, including numeric zero: the declaration represents a present flag with a stored value.

## Compatibility and validation

Public tool names, request fields and response schemas are unchanged. GUI inspection/render now preserve the supplied scenario by default; exploratory scenario generation requires an explicit `generatedScenarios` request. This corrects implicit visibility/value overrides. Existing explicit state and resolution matrices remain available. No rewrite, transport authentication, grants or path checks change.

Synthetic tests cover scoped scans, format fallback, unrelated assets, country bindings, transitive localisation, cycles, cancellation, condition-cache freshness and folder-versus-inspection scope. Existing negative DDS, font, animation, visibility, rendering-budget and worker-deadline suites remain regression gates. External-mod sources and renders are private evidence, never package fixtures.

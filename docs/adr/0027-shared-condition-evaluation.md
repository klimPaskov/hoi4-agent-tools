# Shared scenario condition evaluation

## Decision

GUI scripted-localisation selection and probability eligibility call the same Clausewitz AST evaluator in the core.
The probability module keeps its existing imports and public scenario contracts through compatibility exports.
The core depends on neutral condition subjects, source provenance, scenario bindings, and three-valued results, not probability services or GUI types.

The evaluator handles conjunction, disjunction, negation, inclusive and strict comparisons, variable operands, global script constants, file-local constants, declared scopes, and scripted-trigger calls with scalar parameters.
Helper expansion preserves definition provenance and rejects recursive calls and missing or unsupported arguments as unresolved.
Root, current, previous, and named scopes retain their actual context; an absent previous scope does not silently mean ROOT.

GUI scans include active scripted-trigger and script-constant definitions across authorized mod, dependency, and game sources.
Ordered scripted-localisation choices stop at the first true condition.
An earlier unresolved choice prevents a later fallback from being reported as the selected branch.
The renderer leaves that dynamic token unresolved and retains per-choice condition evidence in the reproducible scenario artifact.
Missing localisation or sprites never cause the selector to choose a different gameplay branch.

GUI inputs retain their existing values, variables, flags, placeholder mode, explicit overrides, and seeded exploratory generation.
Optional named scope bindings use the shared core shape.
Generated values are preview inputs, not evidence of campaign state.
Unknown GUI flags stay unresolved unless explicitly declared; the legacy probability contract retains its closed flag catalog behavior.

This stage does not turn heuristic preview pane selection into verified visibility coverage.
Boundary generation and visibility-branch coverage remain part of the accepted domain-refinement stage.
Unsupported engine predicates remain unresolved instead of being assigned heuristic truth values.

## Evidence

`tests/unit/condition-evaluator.test.ts` exercises the Boolean truth tables, inclusive boundaries, variable and constant operands, helper parameters and recursion, unknown inputs, scope nesting, and date ordering.
`tests/unit/gui-condition-pipeline.test.ts` runs generated scenarios through the production scanner, source graph, layout service, and SVG/PNG renderer, checking the three reported failures, helper and scope resolution, explicit overrides, unknown branches, colours, and repeatability.
The existing probability and GUI suites remain required release gates.

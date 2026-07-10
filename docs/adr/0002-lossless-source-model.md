# ADR 0002: Lossless token/CST source model

- Status: accepted
- Date: 2026-07-10

## Decision

Use a project-owned lossless lexer and concrete syntax tree over original bytes. Trivia, duplicate keys, ordering, unknown assignments, raw blocks, operators, and exact ranges remain in the token stream. Semantic module models reference CST ranges; edits are non-overlapping byte-preserving text replacements. A file with syntax errors or an unrepresentable target encoding is not rewritten. Each decoded file has one immutable line-start index so token, parser, localisation, and symbol locations use binary search instead of rescanning source prefixes.

## Rationale

Conventional AST parsers and serializers discard comments, duplicate blocks, layout, unknown constructs, and encoding details. Those losses violate the product safety contract. Existing public Clausewitz parsers were reviewed, but their normalized object models do not provide the required no-change byte identity and targeted rewrite guarantees.

## Consequences

The parser intentionally understands structure before it understands every game keyword. Modules may add semantic readers without replacing the shared CST. Unchanged files are returned from original bytes. Localisation uses its own BOM-aware line grammar because it is not Clausewitz script. Clausewitz block nesting is limited to 256 levels; an over-limit subtree is consumed iteratively and produces a blocking diagnostic rather than risking a runtime stack overflow. A file retains at most 100 source diagnostics, with the final slot replaced by an explicit truncation blocker when further lexer or parser findings exist. Recursive symbol traversal uses the same nesting boundary.

Consumers distinguish targeted source access from broad inventory. A targeted read or rewrite keeps parser-limit diagnostics blocking because it cannot safely answer for that source. A broad symbol or GUI inventory records the active source as skipped, does not traverse its partial CST, and exposes bounded completeness metadata. Missing-reference diagnostics may become partial-inventory warnings only when the skipped path family could supply the missing symbol kind; unrelated skipped sources do not weaken validation. A skipped active selector such as `default.map` blocks selection for its source family instead of silently falling back to a conventional filename.

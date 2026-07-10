# ADR 0002: Lossless token/CST source model

- Status: accepted
- Date: 2026-07-10

## Decision

Use a project-owned lossless lexer and concrete syntax tree over original bytes. Trivia, duplicate keys, ordering, unknown assignments, raw blocks, operators, and exact ranges remain in the token stream. Semantic module models reference CST ranges; edits are non-overlapping byte-preserving text replacements. A file with syntax errors or an unrepresentable target encoding is not rewritten.

## Rationale

Conventional AST parsers and serializers discard comments, duplicate blocks, layout, unknown constructs, and encoding details. Those losses violate the product safety contract. Existing public Clausewitz parsers were reviewed, but their normalized object models do not provide the required no-change byte identity and targeted rewrite guarantees.

## Consequences

The parser intentionally understands structure before it understands every game keyword. Modules may add semantic readers without replacing the shared CST. Unchanged files are returned from original bytes. Localisation uses its own BOM-aware line grammar because it is not Clausewitz script.

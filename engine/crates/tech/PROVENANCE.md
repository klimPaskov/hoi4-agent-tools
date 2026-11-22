# Provenance: hoi4-tech

Sources this crate adapts, one row per adapted file. All sources are this repository's own TypeScript at commit `9b7dc80d`.

| Rust file               | Adapted from                                                                                                                                   | Commit     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `src/pos.rs`            | `engine/crates/engine/src/symbol_index/records.rs` (`Positions`), which ports `core/source/lexer.ts` (`createSourceLineIndex`, `positionAt`)    | `9b7dc80d` |
| `src/source_analysis.rs` | `src/hoi4_agent_tools/technology/source-analysis.ts` (`analyzeTechnologySource`, its parsers, `technologySourceFiles`)                         | `9b7dc80d` |
| `src/graph.rs`          | `src/hoi4_agent_tools/technology/graph.ts` (`technologyGraphAnalysis`, `diagnose`, `enrichPlacements`, `expandHelperReferences`) and `core/dependency-walk.ts` (`DependencyWalk.advance`, path policy) | `9b7dc80d` |
| `src/queries.rs`        | `src/hoi4_agent_tools/technology/queries.ts` (every exported query and `technologyExplainSummary`)                                              | `9b7dc80d` |

## Differences from the TypeScript

- A technology without `force_use_small_tech_layout = yes` no longer gets an `unsupportedFields` entry with no expression. The entry is written only for a value that is not a yes or no literal.
- The helper-call walk runs without checkpoints; its records, depth ceiling (64) and work ceiling (10,000,000 steps) are the TypeScript ones.

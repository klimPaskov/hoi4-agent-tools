# Provenance: hoi4-script-write

Sources this crate adapts, one row per adapted file. All TypeScript sources are at commit `ef3d2215`.

| Rust file          | Adapted from                                                                                                                                                                                                                                                        | Commit     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `src/source.rs`    | `src/hoi4_agent_tools/core/block-edit.ts` (`lineIndent`, `indentedBody`); `core/source/rewrite.ts` (`applyReplacements`); `core/source/encoding.ts` (`encodeSource`, `assertSourceEncodingPreserved`); `core/source/parser.ts` (`assignments`, `assertRewriteSafe`) | `ef3d2215` |
| `src/idea.rs`      | `src/hoi4_agent_tools/ideas/write-plan.ts` (`planIdeaWrite`, `planNewIdeaFile`, `ideaCategories`)                                                                                                                                                                   | `ef3d2215` |
| `src/character.rs` | `src/hoi4_agent_tools/characters/write-plan.ts` (`planCharacterWrite`, `planNewCharacterFile`)                                                                                                                                                                      | `ef3d2215` |
| `src/decision.rs`  | `src/hoi4_agent_tools/decision/write-plan.ts` (`planDecisionWrite`, `planNewDecisionFile`, `decisionCategories`)                                                                                                                                                    | `ef3d2215` |
| `src/doctrine.rs`  | `src/hoi4_agent_tools/doctrine/write-plan.ts` (`planDoctrineWrite`, `planNewDoctrineFile`)                                                                                                                                                                          | `ef3d2215` |
| `src/tech.rs`      | `src/hoi4_agent_tools/technology/write-plan.ts` (`planTechWrite`, `planNewTechFile`)                                                                                                                                                                                | `ef3d2215` |
| `src/event.rs`     | `src/hoi4_agent_tools/event/write-plan.ts` (`planEventWrite`, `planNewEventFile`, `eventFileContents`)                                                                                                                                                              | `ef3d2215` |
| `src/common/`      | new in tutorial-path packet T3, adapted from no TypeScript file (`mod.rs` the descriptor-driven write path, `descriptor.rs` the kind table, `checks.rs` the per-kind checks)                                                                                    | n/a        |
| `src/ops.rs`       | new in the parallel port (engine operations `<writer>_write.plan`)                                                                                                                                                                                                  | n/a        |

Differences from the TypeScript code, on purpose:

- Reading is the engine's TypeScript-semantics reader (`hoi4_engine::symbol_index::reader`), so diagnostics and recovery are the TypeScript parser's. Offsets are byte offsets of the decoded text, not UTF-16 offsets. The edits are the same, and the result is encoded back into the file's own encoding.
- The unified diff stays with the TypeScript caller until the diff service moves (packet P3).
- The tech writer's closing-brace message said "technologynologies"; it now says "technologies".

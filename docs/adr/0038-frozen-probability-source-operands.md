# ADR 0038: Frozen probability source operands

Status: accepted

## Context

A preserved decision file under a documentation directory was readable but not recognized as a decision surface. Comparing that path directly returned an empty surface even though its bytes contained the original decision weights. Copying the baseline over current gameplay source would undermine a read-only comparison.

## Decision

A probability source selector may name `snapshotPath` together with its logical `path` and the exact frozen `expectedSourceHash`. The scan reads both through authorized workspace roots. The analyzer verifies the frozen file's raw hash, retains its physical path in provenance, and supplies the logical path only for domain classification. Source files are never edited. Missing, ambiguous, changed, or unsafe snapshot inputs fail explicitly.

The same operand works for inspection, evaluation, and source comparison. Current shared helpers and constants remain the dependency context; the result does not imply that the entire prior workspace was restored. Decision willingness scores remain score-only, without invented engine click probabilities.

## Validation

The regression case compares a preserved decision with a cap-dependent zero factor against its current constant score, checks the exact delta in the cap-breached scenario, rejects a changed snapshot hash and path traversal, and verifies that both source files remain byte-identical.

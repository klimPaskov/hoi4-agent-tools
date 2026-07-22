# References and Open Questions

Status: completed for adapter version `hoi4-1.19.2.v1`. The resolved selection, timing, version, evidence, and unsupported boundaries are recorded in [probability-adapter-evidence.md](probability-adapter-evidence.md) and enforced by adapter metadata and tests. Items below remain the re-verification checklist for a future adapter or HOI4 version; they are not open release blockers for 2.3.0.

## Required local research

Before implementation, read:

- standalone `hoi4-agent-tools` architecture, parser, index, MCP, artifact, and versioning documentation
- repository `AGENTS.md`
- the task's MTTH implementation guidance
- offline wiki pages for events, AI, decisions, focuses, technologies, effects, triggers, scopes, data structures, and random lists
- installed HOI4 documentation for triggers, effects, script values, script constants, AI, and every supported weighted surface
- current vanilla examples
- approved reference mods only when vanilla is insufficient

## Surface questions that must be answered

For each adapter, determine:

1. What creates the complete candidate pool?
2. Which candidates are excluded before weighting?
3. What is the default base value when a block is absent?
4. In what order are base, add, factor, and modifiers applied?
5. Are negative values clamped, rejected, or meaningful?
6. What happens when every eligible value is zero?
7. How often is the selection evaluated?
8. Does the engine sample one candidate, evaluate independent chances, or use the score as a gate?
9. Which AI strategies or game rules modify the result outside the local block?
10. Which scopes are active in each condition and modifier?
11. Which cached engine values cannot be reconstructed from source and scenario state?
12. Did the behavior change in the installed game version?

## MTTH questions

Verify:

- whether the declared value is a median, mean, or another parameter
- the exact per-check chance conversion
- check cadence
- trigger re-evaluation behavior
- whether chance memory exists between checks
- behavior when the trigger turns false and later true
- interaction with delayed events and explicit random delays
- supported units and modifier order

Do not publish cumulative probabilities until these are proven for the adapter version.

## AI surface questions

Verify separately for:

- event option selection
- decision evaluation and target choice
- national focus selection
- technology selection
- doctrine selection
- AI strategy factors
- scripted GUI AI actions

Do not assume that `ai_will_do` has the same probabilistic meaning in every surface.

## Custom pool questions

The custom-pool adapter is exact only to its manifest. The mod author must define every selection-state transition that matters.

Determine whether the manifest needs:

- order of transition application
- simultaneous category updates
- rounding rules
- weight caps and floors
- timer roll timing
- cooldown cadence
- reset ordering
- candidate removal timing
- terminal conditions

## Evidence records

Every adapter should ship with:

- source documentation citations in project docs
- vanilla fixture paths and hashes
- game version
- expected values
- empirical test note when documentation was insufficient
- known unsupported expressions
- last verification date

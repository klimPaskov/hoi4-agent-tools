# Goal: Add the AI and MTTH Scenario Analyzer

Add a read-only MCP tool family for coding agents. Read the repository architecture and MCP docs, the real repository copy of `hoi4-mtth`, and every file in this package. Verify each adapter against current local documentation and vanilla examples. Do not apply one formula to every `ai_will_do`, `ai_chance`, MTTH, and random block.

## Purpose

Implement an analyzer that accepts real or proposed weighted source plus explicit world-state scenarios. It must explain eligibility, applied modifiers, final values, dominant or starved outcomes, timing, and changes caused by a patch.

It does not write gameplay code, choose balance targets, simulate the full strategic AI, execute arbitrary effects, launch the game, or provide a human editor.

## Core model

Reuse the shared parser, workspace resolver, source map, symbol index, constants resolver, helper graph, cache, artifacts, and MCP infrastructure. Do not create another Clausewitz parser.

Build versioned adapters for event MTTH, event option `ai_chance`, decision and mission weights, focus weights, technology and doctrine weights, direct random chance, `random_list`, supported AI strategy factors, and declared custom weighted pools. Each adapter must state whether it supports eligibility, raw score, normalized probability, time distribution, or sequence analysis.

Accept exact values, alternatives, ranges, distributions, correlations, candidate pools, and scheduled state changes. Evaluate conditions as true, false, or unresolved. Propagate uncertainty into branches, bounds, or sampling. Never guess a missing value, scope, candidate, or denominator.

Keep eligibility, raw value, conditional selection probability, effective MTTH, cumulative time chance, sampled frequency, and scenario prevalence separate. Normalize only a complete categorical pool whose adapter proves that rule. Convert MTTH into a horizon chance only through a verified game-version timing model.

## Analysis and MCP

Implement exact evaluation, scenario matrices, parameter sweeps, breakpoint and rank-reversal discovery, time-horizon analysis, seeded Monte Carlo analysis, and before-and-after comparison.

Implement sequence analysis only for an explicit custom-pool manifest. It may model declared recovery, caps, cooldowns, removal, resets, timer changes, and terminal states. It must not execute event effects or infer wider campaign state.

Results must include traces, source provenance, confidence, and unsupported analysis. JSON is authoritative. Generate focused visual resources where useful.

Expose read-only MCP capabilities equivalent to inspect, evaluate, sweep, simulate, sequence, compare, and render. Follow the server's naming rules. Support progress, cancellation, stable hashes, deterministic seeds, caching, and resource retrieval. Do not add apply, rewrite, or source-editing operations.

## Integration and acceptance

Keep guidance inside existing owner skills. Do not create a central MCP skill, router, wrapper, or separate simulator skill. Update only workflows that own weighted logic.

Create the synthetic fixture from the validation spec with at least 150 weighted blocks, 250 scenarios, exact expected results, unresolved cases, and one stateful pool. Prove arithmetic identities, interval safety, timing monotonicity, exact-versus-sampled agreement, deterministic seeds, comparison attribution, cancellation, stale-result handling, read-only annotations, and workspace isolation.

Run read-only local integration tests without copying external source.

Complete the goal only when a coding agent can inspect unfamiliar weighted logic, explain rankings and timing under declared conditions, find dominance and edge-case flaws, compare a patch, and see every uncertainty without source edits or false runtime claims. Report every unsupported construct, assumption, omission, and blocker.

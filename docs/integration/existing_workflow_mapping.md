# Agent workflow integration

The AI and MTTH Scenario Analyzer is one domain tool family inside an existing coding-agent workflow. It does not become the task router, balance owner, or source editor.

Use the analyzer when a task needs evidence about event timing, event-option choice, focus selection, decision or mission ranking, research selection, random outcomes, AI strategy factors, or a declared stateful pool. Small changes can use one narrow inspection or exact evaluation. Broader balance work can add scenario sweeps, simulation, sequence analysis, or before-and-after comparison.

For example, if a decision's AI score seems too low, inspect that decision's `ai_will_do` modifiers, evaluate it with the country's declared flags and variables, then compare the same scenario before and after the source edit. A reported score explains the scripted ranking under those inputs; it does not prove that the decision is available or that the AI will click it.

The calling workflow remains responsible for design intent, source changes, game-specific review, and completion. Keep exact, bounded, sampled, score-only, and unsupported results distinct. Pass linked resources instead of copying large matrices or traces into the working prompt.

The optional MCP prompt scopes one weighted-logic analysis. It does not create or require a repository skill, host-specific rule, or separate simulation workflow.

## Local reference retrieval

A modding workflow can call `hoi4.reference_context` for its current surface, search with `hoi4.reference_search`, and read only the cited sections with `hoi4.reference_read`. `hoi4.source_lookup` locates exact installed-game or mod definitions and indexed usages. Keep source paths, line spans, and revisions in the task evidence, and retrieve further lines only when needed. The installed game documentation is the primary syntax reference; an offline wiki snapshot supplies broader guidance. A missing or skipped source remains visible and requires a targeted local read or a recorded coverage gap.

For a scripted GUI change, start with the relevant context bundle, open the installed control documentation and matching offline wiki section, and use `source_lookup` for one vanilla example. Then inspect and render the actual layout with the GUI tools. The references explain syntax; the render checks the selected window and scenario.

Reference retrieval supplies syntax and precedent. Focus, event, technology, weighted-logic, GUI, and map workflows still use their domain inspectors, renders, comparisons, and declared scenarios for implementation evidence. Repository skills remain responsible for design, source edits, validation, and acceptance.

When the live `hoi4.source_lookup` schema exposes `view` and `keyPath`, request bounded child structure and navigate directly to the relevant block.
Select repeated keys with their zero-based `occurrence`, follow `nextChildOffset` for more children, and retain the scan revision and query settings for continuation.
Disable references for a focused event or scripted-helper definition read; enable them when investigating consumers.

When exposed, `hoi4.script_validate` checks an effect or trigger body under its declared scope against one selected native documentation authority.
Treat `valid: null`, unresolved helpers, uninspected argument blocks, and omitted findings as remaining evidence gaps.
A true result covers only the returned checks; parameter semantics and in-game behavior still need their own evidence.

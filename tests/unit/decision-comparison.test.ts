import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ConditionScenario } from '../../src/hoi4_agent_tools/core/condition-model.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildProposedSourceOverlay } from '../../src/hoi4_agent_tools/core/source-overlay.js';
import type { ResolvedWorkspace } from '../../src/hoi4_agent_tools/core/workspace.js';
import { compareDecisionScenarios } from '../../src/hoi4_agent_tools/decision/comparison.js';

const relativePath = 'common/decisions/policy.txt';
const modRoot = '/fixture/mod';
const workspace = {
  id: 'fixture',
  modRoot,
  roots: [{ kind: 'mod', path: modRoot, loadOrder: 1 }],
} as ResolvedWorkspace;

function snapshot(source: string): ScanSnapshot {
  const bytes = Buffer.from(source);
  const files: ScannedFile[] = [
    {
      absolutePath: `${modRoot}/${relativePath}`,
      displayPath: `mod:${relativePath}`,
      relativePath,
      rootKind: 'mod',
      loadOrder: 1,
      size: bytes.length,
      modifiedMs: 0,
      sha256: sha256Bytes(bytes),
      bytes,
    },
  ];
  const index = SymbolIndex.build(files);
  return {
    workspaceId: 'fixture',
    revision: 'decision-baseline',
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
    skippedSources: index.skippedSources,
    diagnostics: index.diagnostics,
  };
}

const sourceBefore = `policy = { fund = {
  available = { has_country_flag = approved }
  cost = 10
  days_re_enable = 7
  complete_effect = { set_country_flag = funded }
} }`;
const sourceAfter = `policy = { fund = {
  available = { has_country_flag = ready }
  cost = 20
  days_re_enable = 14
  complete_effect = { set_country_flag = funded }
} }`;
const scenarios: ConditionScenario[] = [
  {
    id: 'approved_actor',
    actor: 'AAA',
    state: { political_power: 15 },
    flags: ['approved'],
    closedFlags: true,
  },
  {
    id: 'ready_actor',
    actor: 'BBB',
    state: { political_power: 25 },
    flags: ['ready'],
    closedFlags: true,
  },
];

describe('revision-bound decision source comparison', () => {
  it('attributes gate, affordability, and lifecycle changes per actor', () => {
    const before = snapshot(sourceBefore);
    const after = buildProposedSourceOverlay(before, workspace, [
      { relativePath, content: sourceAfter },
    ]).snapshot;
    const comparison = compareDecisionScenarios(before, after, 'fund', scenarios);
    expect(comparison.beforeRevision).toBe(before.revision);
    expect(comparison.afterRevision).toBe(after.revision);
    expect(comparison.cases[0]).toMatchObject({
      scenarioId: 'approved_actor',
      before: { gates: { available: 'true' }, cost: { affordable: 'true' } },
      after: { gates: { available: 'false' }, cost: { affordable: 'false' } },
    });
    expect(comparison.cases[0]?.changed).toEqual([
      'decision_available',
      'available',
      'cost_amount',
      'affordable',
      'lifecycle',
    ]);
    expect(comparison.cases[1]).toMatchObject({
      scenarioId: 'ready_actor',
      before: { gates: { available: 'false' } },
      after: { gates: { available: 'true' } },
    });
    expect(comparison.complete).toBe(true);
  });

  it('reports a removed decision as a definition change', () => {
    const before = snapshot(sourceBefore);
    const after = buildProposedSourceOverlay(before, workspace, [
      { relativePath, content: null },
    ]).snapshot;
    const comparison = compareDecisionScenarios(before, after, 'fund', scenarios.slice(0, 1));
    expect(comparison.cases[0]?.before).not.toBeNull();
    expect(comparison.cases[0]?.after).toBeNull();
    expect(comparison.cases[0]?.changed).toEqual(['definition']);
  });

  it('rejects a comparison across workspace boundaries', () => {
    expect(() =>
      compareDecisionScenarios(
        snapshot(sourceBefore),
        { ...snapshot(sourceAfter), workspaceId: 'other' },
        'fund',
        scenarios,
      ),
    ).toThrow('workspace');
  });
});

import { describe, expect, it } from 'vitest';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import {
  assertNoSemanticSourceDrift,
  detectContinuousFocusDrift,
  detectFocusDrift,
} from '../../src/hoi4_agent_tools/focus/drift.js';
import {
  importContinuousFocusPalettes,
  importFocusTrees,
} from '../../src/hoi4_agent_tools/focus/importer.js';

// Synthetic tree modelled on the HOI4 Factory S01 EXP-02 stale semantic edit case.
const treeSource = `# guard tree
focus_tree = {
\tid = guard_tree
\tfocus = {
\t\tid = guard_a
\t\tx = 0
\t\ty = 0
\t\tcost = 5
\t}
\tfocus = {
\t\tid = guard_b
\t\tx = 2
\t\ty = 0
\t\tcost = 8
\t}
}
`;

function parse(text: string) {
  return parseClausewitz(Buffer.from(text), 'mod:guard.txt');
}

describe('focus source drift guard', () => {
  it('refuses a plan write after another focus changed semantically (S01 EXP-02 stale edit)', () => {
    const saved = importFocusTrees(parse(treeSource)).plans[0]!;
    const plan = structuredClone(saved);
    plan.focuses.find(({ id }) => id === 'guard_a')!.cost = 6;
    const drift = detectFocusDrift(plan, parse(treeSource.replace('cost = 8', 'cost = 9')));
    expect(drift.status).toBe('conflict');
    expect(() =>
      assertNoSemanticSourceDrift(drift, 'common/national_focus/guard.txt'),
    ).toThrowError(
      expect.objectContaining({
        code: 'FOCUS_SOURCE_CHANGED_SINCE_PLAN',
        details: expect.objectContaining({
          status: 'conflict',
          relativePath: 'common/national_focus/guard.txt',
          savedSourceHash: saved.provenance.sourceHash,
          currentSourceHash: drift.currentSourceHash,
        }),
      }),
    );
  });

  it('refuses an unchanged plan over a semantically changed source and a removed tree', () => {
    const saved = importFocusTrees(parse(treeSource)).plans[0]!;
    const semantic = detectFocusDrift(saved, parse(treeSource.replace('cost = 5', 'cost = 6')));
    expect(semantic.status).toBe('source_changed_semantically');
    expect(() => assertNoSemanticSourceDrift(semantic, 'guard.txt')).toThrowError(
      expect.objectContaining({ code: 'FOCUS_SOURCE_CHANGED_SINCE_PLAN' }),
    );
    const removed = detectFocusDrift(saved, parse('# removed\n'));
    expect(removed.status).toBe('tree_removed');
    expect(() => assertNoSemanticSourceDrift(removed, 'guard.txt')).toThrowError(
      expect.objectContaining({ code: 'FOCUS_SOURCE_CHANGED_SINCE_PLAN' }),
    );
  });

  it('allows clean, plan-only, formatting-only and converged states', () => {
    const original = parse(treeSource);
    const saved = importFocusTrees(original).plans[0]!;
    const plan = structuredClone(saved);
    plan.focuses.find(({ id }) => id === 'guard_a')!.cost = 6;
    const cases = [
      [saved, original, 'clean'],
      [plan, original, 'plan_changed'],
      [
        saved,
        parse(treeSource.replace('# guard tree', '# guard tree edited externally')),
        'source_changed_formatting',
      ],
      [plan, parse(treeSource.replace('cost = 5', 'cost = 6')), 'converged'],
      // A plan edit plus an external comment-only change reports conflict but loses nothing.
      [
        plan,
        parse(treeSource.replace('# guard tree', '# guard tree edited externally')),
        'conflict',
      ],
    ] as const;
    for (const [candidate, document, status] of cases) {
      const drift = detectFocusDrift(candidate, document);
      expect(drift.status).toBe(status);
      expect(() => assertNoSemanticSourceDrift(drift, 'guard.txt')).not.toThrow();
    }
  });

  it('applies the same refusal to continuous focus palettes', () => {
    const paletteSource = `continuous_focus_palette = {
\tid = guard_palette
\tdefault = yes
\treset_on_civilwar = no
\tcontinuous_focus = {
\t\tid = guard_continuous
\t\tcost = 10
\t}
}
`;
    const saved = importContinuousFocusPalettes(parse(paletteSource)).continuousFocusPalettes[0]!;
    const plan = structuredClone(saved);
    plan.resetOnCivilWar = true;
    const drift = detectContinuousFocusDrift(
      plan,
      parse(paletteSource.replace('cost = 10', 'cost = 11')),
    );
    expect(drift.status).toBe('conflict');
    expect(() => assertNoSemanticSourceDrift(drift, 'palette.txt')).toThrowError(
      expect.objectContaining({ code: 'FOCUS_SOURCE_CHANGED_SINCE_PLAN' }),
    );
  });
});

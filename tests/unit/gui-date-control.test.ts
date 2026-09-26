import { describe, expect, it } from 'vitest';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';
import {
  evaluateGuiCondition,
  guiConditionScenario,
} from '../../src/hoi4_agent_tools/gui/scenario-conditions.js';

describe('declared GUI date and state controllers', () => {
  it('accepts a dated controller fixture and uses it for actual condition evaluation', () => {
    const preview = parsePreviewScenario({
      id: 'dated',
      country: { tag: 'GER' },
      date: '1944-10-01',
      controls: { '87': 'GER', '88': 'GER' },
    });
    expect(preview.date).toBe('1944.10.1');
    const scenario = guiConditionScenario(preview);
    expect(
      evaluateGuiCondition(
        'date > 1944.9.30 controls_state = 87 88 = { is_controlled_by = ROOT }',
        scenario,
        { id: 'gate', provenance: [] },
      ).state,
    ).toBe('true');
    expect(
      evaluateGuiCondition('date < 1944.10.1', scenario, { id: 'gate', provenance: [] }).state,
    ).toBe('false');
    expect(
      evaluateGuiCondition('controls_state = 89', scenario, { id: 'gate', provenance: [] }).state,
    ).toBe('unresolved');
  });

  it('rejects impossible dates and malformed state-controller records', () => {
    expect(() => parsePreviewScenario({ id: 'invalid', date: '1944-02-30' })).toThrow();
    expect(() => parsePreviewScenario({ id: 'invalid', controls: { '../87': 'GER' } })).toThrow();
    expect(() => parsePreviewScenario({ id: 'invalid', controls: { '87': true } })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { eventInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/event.js';
import { decisionInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/analysis.js';
import { guiRenderRequestSchema } from '../../src/hoi4_agent_tools/schemas/gui-requests.js';
import {
  normalizeEventSelector,
  normalizeToolArguments,
} from '../../src/hoi4_agent_tools/schemas/lenient-arguments.js';
import { probabilityInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/probability-requests.js';

describe('argument shorthands agents send', () => {
  it.each([
    ['my_mod.12', { kind: 'event', eventId: 'my_mod.12' }],
    ['chaosx.fallout.904', { kind: 'event', eventId: 'chaosx.fallout.904' }],
    ['my_mod', { kind: 'namespace', namespace: 'my_mod' }],
    ['events/my_events.txt', { kind: 'file', sourcePath: 'events/my_events.txt' }],
    [{ namespace: 'my_mod' }, { kind: 'namespace', namespace: 'my_mod' }],
    [{ id: 'my_mod.3' }, { kind: 'event', eventId: 'my_mod.3' }],
    [
      { path: 'events/a.txt', line: 7 },
      { kind: 'source', sourcePath: 'events/a.txt', line: 7 },
    ],
  ] as const)('reads the event selector %j', (shorthand, canonical) => {
    expect(normalizeEventSelector(shorthand)).toEqual(canonical);
  });

  it('leaves an ambiguous selector for validation to name', () => {
    const ambiguous = { namespace: 'a', eventId: 'a.1' };
    expect(normalizeEventSelector(ambiguous)).toBe(ambiguous);
  });

  it('turns every shorthand into a request the canonical schema accepts', () => {
    expect(
      eventInspectRequestSchema.safeParse(
        normalizeToolArguments('hoi4.event_inspect', {
          mode: 'lint',
          selector: { namespace: 'chaosx.nr42' },
        }),
      ).success,
    ).toBe(true);
    expect(
      guiRenderRequestSchema.safeParse(
        normalizeToolArguments('hoi4.gui_render', {
          windowName: 'settings_window',
          scenario: { date: '1936.1.1' },
        }),
      ).success,
    ).toBe(true);
    expect(
      decisionInspectRequestSchema.safeParse(
        normalizeToolArguments('hoi4.decision_inspect', { id: 'my_decision', mode: 'inspect' }),
      ).success,
    ).toBe(true);
    const probability = normalizeToolArguments('hoi4.probability_inspect', {
      source: 'common/decisions/a.txt',
      scenarioSet: [{ actor: 'GER' }, { name: 'at_war', state: { has_war: true } }],
    });
    expect(probability).toMatchObject({
      source: { path: 'common/decisions/a.txt' },
      scenarioSet: {
        id: 'scenarios',
        scenarios: [
          { id: 'scenario-1', actor: 'GER', state: {} },
          { id: 'at_war', state: { has_war: true } },
        ],
      },
    });
    expect(probabilityInspectRequestSchema.safeParse(probability).success).toBe(true);
  });

  it('passes other tools and malformed arguments through unchanged', () => {
    const args = { query: 'x' };
    expect(normalizeToolArguments('hoi4.reference_search', args)).toBe(args);
    expect(normalizeToolArguments('hoi4.event_inspect', 'nonsense')).toBe('nonsense');
  });
});

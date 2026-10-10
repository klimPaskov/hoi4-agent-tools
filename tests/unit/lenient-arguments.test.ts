import { describe, expect, it } from 'vitest';
import { eventInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/event.js';
import { decisionInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/analysis.js';
import { guiRenderRequestSchema } from '../../src/hoi4_agent_tools/schemas/gui-requests.js';
import {
  normalizeEventSelector,
  normalizeToolArguments,
} from '../../src/hoi4_agent_tools/schemas/lenient-arguments.js';
import { probabilityInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/probability-requests.js';
import { scriptValidateRequestSchema } from '../../src/hoi4_agent_tools/schemas/script-validation.js';
import { invalidArgumentsResult } from '../../src/hoi4_agent_tools/mcp/server/argument-errors.js';
import { referenceTools } from '../../src/hoi4_agent_tools/mcp/tools/reference.js';
import { taskToolCatalog } from '../../src/hoi4_agent_tools/mcp/server/task-tool-catalog.js';

describe('argument shorthands agents send', () => {
  it.each([
    ['my_mod.12', { kind: 'event', eventId: 'my_mod.12' }],
    ['chaosx.fallout.904', { kind: 'event', eventId: 'chaosx.fallout.904' }],
    ['my_mod', { kind: 'namespace', namespace: 'my_mod' }],
    ['events/my_events.txt', { kind: 'file', sourcePath: 'events/my_events.txt' }],
    [{ namespace: 'my_mod' }, { kind: 'namespace', namespace: 'my_mod' }],
    [{ id: 'my_mod.3' }, { kind: 'event', eventId: 'my_mod.3' }],
    ['chaosx.nr14.*', { kind: 'namespace', namespace: 'chaosx.nr14' }],
    [
      { kind: 'event', id: 'chaosx.nr42.1' },
      { kind: 'event', eventId: 'chaosx.nr42.1' },
    ],
    [
      { kind: 'namespace', id: 'chaosx.nr42.*' },
      { kind: 'namespace', namespace: 'chaosx.nr42' },
    ],
    [
      { kind: 'file', path: 'events/a.txt' },
      { kind: 'file', sourcePath: 'events/a.txt' },
    ],
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

  // Calls observed failing in agent sessions; each must reach the operation.
  it.each([
    ['hoi4.event_inspect', { mode: 'lint', selector: 'chaosx.nr14.*' }],
    [
      'hoi4.event_inspect',
      { mode: 'lint', selector: 'chaosx.nr13.2', refresh: true, maxNodes: 200 },
    ],
    [
      'hoi4.event_inspect',
      { mode: 'trace', from: { id: 'chaosx.fallout.904' }, direction: 'upstream', maxDepth: 4 },
    ],
    [
      'hoi4.event_inspect',
      { mode: 'trace', selector: { kind: 'event', id: 'chaosx.nr42.1' }, direction: 'both' },
    ],
    ['hoi4.event_inspect', { mode: 'lint', eventId: 'chaosx.nr42.1' }],
    ['hoi4.script_validate', { path: 'events/024_hearts_of_iron.txt' }],
    [
      'hoi4.script_validate',
      { path: 'common/scripted_effects/a.txt', kind: 'effect', scope: 'country', limit: 12 },
    ],
    ['hoi4.script_validate', { file: 'common/scripted_triggers/a.txt' }],
    ['hoi4.script_validate', { source: 'add_political_power = 10', kind: 'effect' }],
    ['hoi4.decision_inspect', { decisionId: 'my_decision' }],
  ] as const)('accepts the observed call %s %j', (name, args) => {
    const schema = [...taskToolCatalog, ...referenceTools].find(
      (definition) => definition.name === name,
    )!.inputSchema;
    const parsed = schema.safeParse(normalizeToolArguments(name, args));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('keeps a file check free of a scope its file fixes', () => {
    const request = scriptValidateRequestSchema.parse(
      normalizeToolArguments('hoi4.script_validate', {
        path: 'events/a.txt',
        kind: 'trigger',
        scope: 'state',
      }),
    );
    expect([request.path, request.kind, request.scope]).toEqual([
      'events/a.txt',
      undefined,
      undefined,
    ]);
  });

  it('answers invalid arguments with a tool error naming the field and a working call', () => {
    const schema = referenceTools.find(({ name }) => name === 'hoi4.script_validate')!.inputSchema;
    const parsed = schema.safeParse({ source: 'x = 1', kind: 'effect', scope: 'planet' });
    expect(parsed.success).toBe(false);
    const result = invalidArgumentsResult('hoi4.script_validate', parsed.error!, undefined);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('INVALID_ARGUMENTS');
    expect(text).toMatch(/scope: expected one of/u);
    expect(text).toContain('Example:');
  });

  it('publishes examples that the tools accept', async () => {
    const { ARGUMENT_EXAMPLES } =
      await import('../../src/hoi4_agent_tools/mcp/server/argument-errors.js');
    const definitions = [...taskToolCatalog, ...referenceTools];
    for (const [name, examples] of Object.entries(ARGUMENT_EXAMPLES))
      for (const example of (examples as string).split(' or ')) {
        const schema = definitions.find((definition) => definition.name === name)!.inputSchema;
        const parsed = schema.safeParse(normalizeToolArguments(name, JSON.parse(example)));
        expect({ name, example, issues: parsed.error?.issues ?? [] }).toEqual({
          name,
          example,
          issues: [],
        });
      }
  });
});

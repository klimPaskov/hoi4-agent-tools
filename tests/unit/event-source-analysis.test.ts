import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { analyzeEventSource } from '../../src/hoi4_agent_tools/event/source-analysis.js';

type Fragment = ReturnType<typeof analyzeEventSource>;

const knownEventIds = new Set(['stable.1', 'stable.2', 'stable.3', 'stable.4', 'stable.9']);

function sourceFile(source: string, relativePath = 'events/stable.txt'): ScannedFile {
  const bytes = Buffer.from(source, 'utf8');
  return {
    absolutePath: `/fixture/${relativePath}`,
    displayPath: `fixture:${relativePath}`,
    relativePath,
    rootKind: 'fixture',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function eventSource(extraEffect = ''): string {
  return `country_event = {
	id = stable.1
	is_triggered_only = yes
	option = {
		name = stable.1.a
${extraEffect}		country_event = stable.2
	}
}

country_event = {
	id = stable.2
	is_triggered_only = yes
	option = { name = stable.2.a }
}
`;
}

function analyze(source: string): Fragment {
  return analyzeEventSource(sourceFile(source), {
    knownEventIds,
    knownEventTypes: new Map([...knownEventIds].map((id) => [id, 'country_event'] as const)),
  });
}

function edgeId(fragment: Fragment, targetEventId: string): string | undefined {
  return fragment.edges.find(({ metadata }) => metadata.targetEventId === targetEventId)?.id;
}

function stateId(fragment: Fragment, name: string): string | undefined {
  return fragment.stateAccesses.find((state) => state.name === name)?.id;
}

function conditionId(fragment: Fragment, expressionPart: string): string | undefined {
  return fragment.edges
    .flatMap(({ conditions }) => conditions)
    .find(({ expression }) => expression.includes(expressionPart))?.id;
}

function containingEvent(body: string): string {
  return `country_event = {
	id = stable.1
	is_triggered_only = yes
${body}}
`;
}

describe('event source semantic identity', () => {
  it('keeps a downstream edge ID stable when an unrelated earlier effect is inserted', () => {
    const before = analyze(eventSource());
    const after = analyze(eventSource('\t\tadd_political_power = 5\n'));

    expect(edgeId(before, 'stable.2')).toBeDefined();
    expect(edgeId(after, 'stable.2')).toBe(edgeId(before, 'stable.2'));
  });

  it('keeps a later direct-call edge stable when a different call is inserted first', () => {
    const before = analyze(
      containingEvent(`\timmediate = {
\t\tcountry_event = stable.2
\t\tcountry_event = stable.3
\t}
`),
    );
    const after = analyze(
      containingEvent(`\timmediate = {
\t\tcountry_event = stable.2
\t\tcountry_event = stable.9
\t\tcountry_event = stable.3
\t}
`),
    );

    expect(edgeId(before, 'stable.3')).toBeDefined();
    expect(edgeId(after, 'stable.3')).toBe(edgeId(before, 'stable.3'));
  });

  it('keeps a weighted event edge stable when a different random_events member is inserted', () => {
    const before = analyze(
      containingEvent(`\timmediate = {
\t\trandom_events = {
\t\t\t25 = stable.2
\t\t\t75 = stable.3
\t\t}
\t}
`),
    );
    const after = analyze(
      containingEvent(`\timmediate = {
\t\trandom_events = {
\t\t\t25 = stable.2
\t\t\t10 = stable.9
\t\t\t75 = stable.3
\t\t}
\t}
`),
    );

    expect(edgeId(before, 'stable.3')).toBeDefined();
    expect(edgeId(after, 'stable.3')).toBe(edgeId(before, 'stable.3'));
  });

  it('keeps an unnamed option and its call edge stable when a different option is inserted first', () => {
    const before = analyze(
      containingEvent(`\toption = { country_event = stable.2 }
\toption = { country_event = stable.3 }
`),
    );
    const after = analyze(
      containingEvent(`\toption = { country_event = stable.9 }
\toption = { country_event = stable.2 }
\toption = { country_event = stable.3 }
`),
    );
    const optionFor = (fragment: Fragment, targetEventId: string): string | undefined =>
      fragment.edges.find(({ metadata }) => metadata.targetEventId === targetEventId)?.from;

    expect(optionFor(before, 'stable.3')).toBeDefined();
    expect(optionFor(after, 'stable.3')).toBe(optionFor(before, 'stable.3'));
    expect(edgeId(after, 'stable.3')).toBe(edgeId(before, 'stable.3'));
  });

  it('keeps later sibling edge, state, and condition IDs stable after a different block insertion', () => {
    const laterBlock = `\t\tif = {
\t\t\tlimit = { has_country_flag = stable_later_guard }
\t\t\tset_country_flag = stable_later_state
\t\t\tcountry_event = stable.3
\t\t}
`;
    const earlierBlock = `\t\tif = {
\t\t\tlimit = { has_country_flag = stable_earlier_guard }
\t\t\tset_country_flag = stable_earlier_state
\t\t\tcountry_event = stable.9
\t\t}
`;
    const before = analyze(
      containingEvent(`\timmediate = {
${laterBlock}\t}
`),
    );
    const after = analyze(
      containingEvent(`\timmediate = {
${earlierBlock}${laterBlock}\t}
`),
    );

    expect(edgeId(before, 'stable.3')).toBeDefined();
    expect(stateId(before, 'stable_later_state')).toBeDefined();
    expect(conditionId(before, 'stable_later_guard')).toBeDefined();
    expect(edgeId(after, 'stable.3')).toBe(edgeId(before, 'stable.3'));
    expect(stateId(after, 'stable_later_state')).toBe(stateId(before, 'stable_later_state'));
    expect(conditionId(after, 'stable_later_guard')).toBe(
      conditionId(before, 'stable_later_guard'),
    );
  });

  it('distinguishes local and global saved-scope storage with the same name', () => {
    const fragment = analyze(
      containingEvent(`\timmediate = {
\t\tsave_scope_as = shared_scope
\t\tsave_global_scope_as = shared_scope
\t}
`),
    );
    const accesses = fragment.stateAccesses.filter(
      ({ kind, name }) => kind === 'saved_scope' && name === 'shared_scope',
    );

    expect(accesses).toHaveLength(2);
    expect(accesses.map(({ metadata }) => metadata.storage).sort()).toEqual(['global', 'local']);
  });
});

describe('event source protocol semantics', () => {
  const eventTypes = new Map([
    ['stable.1', 'country_event'],
    ['stable.2', 'country_event'],
    ['stable.3', 'state_event'],
    ['stable.4', 'unit_leader_event'],
    ['stable.9', 'operative_leader_event'],
  ] as const);

  it('records each on-action random_events member exactly once', () => {
    const fragment = analyzeEventSource(
      sourceFile(
        `on_actions = {
	on_startup = { random_events = { 100 = stable.2 } }
}
`,
        'common/on_actions/stable.txt',
      ),
      { knownEventIds, knownEventTypes: eventTypes },
    );

    expect(fragment.edges.filter(({ metadata }) => metadata.targetEventId === 'stable.2')).toEqual([
      expect.objectContaining({
        reason: 'random_event_call',
        weight: expect.objectContaining({ value: '100' }),
      }),
    ]);
  });

  it('parses the official legacy random delay as random hours', () => {
    const fragment = analyze(
      containingEvent(`\timmediate = {
\t\tcountry_event = { id = stable.2 random = 6 }
\t}
`),
    );
    const edge = fragment.edges.find(({ metadata }) => metadata.targetEventId === 'stable.2');

    expect(edge).toMatchObject({
      reason: 'delayed_event_call',
      timing: { mode: 'random', randomHours: '6' },
    });
  });

  it('treats symbolic delay fields as unresolved timing evidence', () => {
    const fragment = analyze(
      containingEvent(`\timmediate = {
\t\tcountry_event = { id = stable.2 days = delay_days random_days = @delay_jitter }
\t}
`),
    );
    const edge = fragment.edges.find(({ metadata }) => metadata.targetEventId === 'stable.2');

    expect(edge).toMatchObject({
      reason: 'delayed_event_call',
      confidence: 'low',
      timing: {
        mode: 'unknown',
        days: 'delay_days',
        randomDays: '@delay_jitter',
        expression: expect.stringContaining('delay_days'),
      },
      metadata: { blocker: 'Event timing could not be resolved statically.' },
    });
  });

  it('tracks uppercase scope blocks and state iterators without guessing', () => {
    const fragment = analyzeEventSource(
      sourceFile(
        containingEvent(`\timmediate = {
\t\tFROM = { state_event = stable.3 }
\t\tevery_state = { state_event = stable.3 }
\t}
`),
      ),
      { knownEventIds, knownEventTypes: eventTypes },
    );
    const edges = fragment.edges.filter(({ metadata }) => metadata.targetEventId === 'stable.3');

    expect(edges).toContainEqual(
      expect.objectContaining({
        scope: expect.objectContaining({
          source: 'unknown',
          destination: 'state',
          expression: 'FROM',
          confidence: 'low',
        }),
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        scope: expect.objectContaining({ source: 'state', destination: 'state' }),
      }),
    );
  });

  it('keeps qualified and chained scope provenance unresolved while recognizing literal tags', () => {
    const fragment = analyzeEventSource(
      sourceFile(
        containingEvent(`\timmediate = {
\t\tevent_target:event_owner = { country_event = stable.2 }
\t\tglobal_event_target:global_owner = { country_event = stable.2 }
\t\tscope:saved_owner = { country_event = stable.2 }
\t\tvar:dynamic_owner = { country_event = stable.2 }
\t\ttemp_var:temporary_owner = { country_event = stable.2 }
\t\tFROM.FROM = { country_event = stable.2 }
\t\tGER = { country_event = stable.2 }
\t}
`),
      ),
      { knownEventIds, knownEventTypes: eventTypes },
    );
    const edges = fragment.edges.filter(({ metadata }) => metadata.targetEventId === 'stable.2');
    const byExpression = new Map(edges.map((edge) => [edge.scope?.expression, edge.scope]));

    for (const expression of [
      'event_target:event_owner',
      'global_event_target:global_owner',
      'scope:saved_owner',
      'var:dynamic_owner',
      'temp_var:temporary_owner',
      'FROM.FROM',
    ]) {
      expect(byExpression.get(expression)).toMatchObject({
        source: 'unknown',
        destination: 'country',
        confidence: 'low',
      });
    }
    expect(byExpression.get('GER')).toMatchObject({
      source: 'country',
      destination: 'country',
      confidence: 'high',
    });
  });

  it('uses only documented iterator result scopes', () => {
    const fragment = analyzeEventSource(
      sourceFile(
        containingEvent(`\timmediate = {
\t\tevery_controlled_state = { state_event = stable.3 }
\t\trandom_enemy_country = { country_event = stable.2 }
\t\tevery_unit_leader = { unit_leader_event = stable.4 }
\t\trandom_operative = { operative_leader_event = stable.9 }
\t}
`),
      ),
      { knownEventIds, knownEventTypes: eventTypes },
    );
    const scopeFor = (target: string) =>
      fragment.edges.find(({ metadata }) => metadata.targetEventId === target)?.scope;

    expect(scopeFor('stable.3')).toMatchObject({ source: 'state', destination: 'state' });
    expect(scopeFor('stable.2')).toMatchObject({ source: 'country', destination: 'country' });
    expect(scopeFor('stable.4')).toMatchObject({ source: 'character', destination: 'unit_leader' });
    expect(scopeFor('stable.9')).toMatchObject({ source: 'operative', destination: 'operative' });
  });

  it('keeps symbolic random-list weights and their modifiers as unresolved-valid evidence', () => {
    const fragment = analyze(
      containingEvent(`\timmediate = {
\t\trandom_list = {
\t\t\ttemp_var:branch_weight = {
\t\t\t\tmodifier = { factor = 0.5 has_country_flag = weight_gate }
\t\t\t\tcountry_event = stable.2
\t\t\t}
\t\t}
\t}
`),
    );
    const edge = fragment.edges.find(({ metadata }) => metadata.targetEventId === 'stable.2');

    expect(edge?.weight).toMatchObject({
      value: 'temp_var:branch_weight',
      valid: 'unknown',
      modifiers: [
        expect.objectContaining({
          kind: 'weight_modifier',
          expression: expect.stringContaining('weight_gate'),
        }),
      ],
    });
    expect(fragment.stateAccesses).toContainEqual(expect.objectContaining({ name: 'weight_gate' }));
  });

  it('does not invent executing calls from effect_tooltip blocks', () => {
    const fragment = analyze(
      containingEvent(`\toption = {
\t\tname = stable.1.a
\t\teffect_tooltip = {
\t\t\tset_country_flag = tooltip_only_flag
\t\t\tcountry_event = stable.2
\t\t}
\t}
`),
    );

    expect(fragment.edges.some(({ metadata }) => metadata.targetEventId === 'stable.2')).toBe(
      false,
    );
    expect(fragment.stateAccesses.some(({ name }) => name === 'tooltip_only_flag')).toBe(false);
  });

  it('reports arbitrary absent scripted effects without flagging native effects', () => {
    const fragment = analyze(
      containingEvent(`\timmediate = {
\t\tremoved_custom_effect = yes
\t\tadd_political_power = 5
\t}
`),
    );

    expect(fragment.unresolved).toContainEqual(
      expect.objectContaining({ kind: 'missing_helper', expression: 'removed_custom_effect' }),
    );
    expect(fragment.unresolved.map(({ expression }) => expression)).not.toContain(
      'add_political_power',
    );
  });

  it('extracts dynamic title and description keys and indexes their gate state', () => {
    const fragment = analyze(
      `country_event = {
\tid = stable.1
\tis_triggered_only = yes
\ttitle = { text = stable.dynamic.title trigger = { has_country_flag = title_gate } }
\tdesc = { text = stable.dynamic.desc trigger = { has_country_flag = desc_gate } }
\toption = { name = stable.1.a }
}
`,
    );
    const event = fragment.nodes.find(({ kind }) => kind === 'event');

    expect(event?.metadata.localisationKeys).toEqual([
      'stable.dynamic.desc',
      'stable.dynamic.title',
    ]);
    expect(fragment.stateAccesses.map(({ name }) => name).sort()).toEqual([
      'desc_gate',
      'title_gate',
    ]);
  });

  it('parses MTTH base time and modifier gates on the implicit entry', () => {
    const fragment = analyze(
      `country_event = {
\tid = stable.1
\ttitle = stable.1.t
\tdesc = stable.1.d
\tis_triggered_only = no
\ttrigger = { has_country_flag = can_fire }
\tmean_time_to_happen = {
\t\tdays = 30
\t\tmodifier = { factor = 0.5 has_country_flag = faster }
\t}
\toption = { name = stable.1.a }
}
`,
    );
    const edge = fragment.edges.find(({ reason }) => reason === 'implicit_event_entry');

    expect(edge?.timing).toMatchObject({ mode: 'mean_time_to_happen', days: '30' });
    expect(edge?.conditions.map(({ kind }) => kind)).toEqual(['event_trigger', 'weight_modifier']);
    expect(fragment.stateAccesses.map(({ name }) => name).sort()).toEqual(['can_fire', 'faster']);
  });
});

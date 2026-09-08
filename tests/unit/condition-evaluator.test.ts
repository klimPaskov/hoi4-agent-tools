import { describe, expect, it } from 'vitest';
import { ClausewitzEvaluationDefinitions } from '../../src/hoi4_agent_tools/core/clausewitz-evaluation.js';
import { evaluateTriggerBlock } from '../../src/hoi4_agent_tools/core/condition-evaluator.js';
import type {
  ConditionScenario,
  TriState,
} from '../../src/hoi4_agent_tools/core/condition-model.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { assignments, parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';

function file(relativePath: string, text: string): ScannedFile {
  const bytes = Buffer.from(text);
  return {
    relativePath,
    displayPath: `fixture:${relativePath}`,
    absolutePath: `/fixture/${relativePath}`,
    bytes,
    sha256: sha256Bytes(bytes),
    size: bytes.length,
    modifiedMs: 0,
    rootKind: 'fixture',
    loadOrder: 0,
  };
}

const definitions = ClausewitzEvaluationDefinitions.build({
  files: [
    file(
      'common/script_constants/test.txt',
      'thresholds = { limit = 10 next = constant:thresholds.limit }',
    ),
    file(
      'common/scripted_triggers/test.txt',
      '@local = 10\n gate = { check_variable = { var = a value = @local compare = greater_than_or_equals } } nested = { gate = yes NOT = { b > 5 } } recursive = { recursive = yes } parameterized = { check_variable = { var = $variable$ value = $limit$ compare = greater_than_or_equals } }',
    ),
  ],
});

function evaluate(text: string, scenario: Partial<ConditionScenario> = {}) {
  const document = parseClausewitz(Buffer.from(`test = { ${text} }`), 'fixture:conditions.txt');
  const assignment = assignments(document.root, 'test')[0]!;
  if (assignment.value.type !== 'block') throw new Error('Expected block');
  return evaluateTriggerBlock(
    assignment.value,
    { id: 'test', state: { a: 10, b: 0 }, ...scenario },
    { id: 'test', document, provenance: [] },
    definitions,
  );
}

describe('shared structured condition evaluation', () => {
  it.each([
    ['check_variable = { var = a value = 10 compare = greater_than_or_equals }', 'true'],
    ['AND = { a > 5 b > 5 }', 'false'],
    ['NOT = { a > 5 }', 'false'],
    ['check_variable = { var = a value = 10 compare = less_than_or_equals }', 'true'],
    ['check_variable = { var = a value = 10 compare = greater_than }', 'false'],
    ['check_variable = { var = a value = 10 compare = less_than }', 'false'],
    ['check_variable = { var = a value = 10 compare = not_equals }', 'false'],
    ['check_variable = { a > b }', 'true'],
    ['check_variable = { a = 10 }', 'true'],
    ['check_variable = { a < 11 }', 'true'],
    ['check_variable = { var = a value = constant:thresholds.next compare = equals }', 'true'],
    ['a = constant:thresholds.limit', 'true'],
    ['gate = yes', 'true'],
    ['gate = no', 'false'],
    ['gate = { }', 'true'],
    ['parameterized = { variable = a limit = 10 }', 'true'],
    ['parameterized = { variable = a limit = 11 }', 'false'],
    ['parameterized = { variable = a }', 'unresolved'],
    ['parameterized = { variable = { a = yes } limit = 10 }', 'unresolved'],
    ['nested = yes', 'true'],
    ['recursive = yes', 'unresolved'],
    ['check_variable = { var = a value = missing }', 'unresolved'],
    ['check_variable = { var = a value = 10 compare = imaginary }', 'unresolved'],
    ['unknown_engine_trigger = yes', 'unresolved'],
    ['FROM = { a > 5 }', 'unresolved'],
    ['PREV = { a > 5 }', 'unresolved'],
    ['unrecognised_bare_value', 'unresolved'],
    ['OR = { unrecognised_bare_value }', 'unresolved'],
    ['NOT = { { always = yes } }', 'unresolved'],
  ])('%s => %s', (text, state) => expect(evaluate(text).state).toBe(state));

  const states: TriState[] = ['true', 'false', 'unresolved'];
  const expression = (state: TriState) =>
    state === 'unresolved' ? 'unknown = yes' : `always = ${state === 'true' ? 'yes' : 'no'}`;
  const inverse = (state: TriState): TriState =>
    state === 'unresolved' ? state : state === 'true' ? 'false' : 'true';
  for (const left of states)
    for (const right of states) {
      const and: TriState = [left, right].includes('false')
        ? 'false'
        : [left, right].includes('unresolved')
          ? 'unresolved'
          : 'true';
      const or: TriState = [left, right].includes('true')
        ? 'true'
        : [left, right].includes('unresolved')
          ? 'unresolved'
          : 'false';
      for (const [operator, expected] of [
        ['AND', and],
        ['OR', or],
        ['NOT', inverse(or)],
        ['NOR', inverse(or)],
        ['NAND', inverse(and)],
      ])
        it(`${operator} ${left}/${right}`, () =>
          expect(evaluate(`${operator} = { ${expression(left)} ${expression(right)} }`).state).toBe(
            expected,
          ));
    }

  it('uses current, root, previous, and named scopes without borrowing missing target values', () => {
    const scopes = {
      FROM: { id: 'target', state: { a: 2 } },
      'FROM.owner': { id: 'owner', state: { a: 3 } },
    };
    expect(
      evaluate('FROM = { a < ROOT.a owner = { a = 3 PREV = { a = 2 } ROOT = { a = 10 } } }', {
        scopes,
      }).state,
    ).toBe('true');
    expect(evaluate('FROM = { b = 0 }', { scopes }).state).toBe('unresolved');
    expect(
      evaluate('check_variable = { var = FROM.a value = a compare = less_than }', { scopes }).state,
    ).toBe('true');
    expect(evaluate('FROM = { ROOT = { PREV = { a = 2 } } }', { scopes }).state).toBe('true');
  });

  it('retains helper source provenance and unknown flag evidence', () => {
    expect(evaluate('gate = yes').helperProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'fixture:common/scripted_triggers/test.txt',
          symbol: 'gate',
        }),
      ]),
    );
    expect(evaluate('has_country_flag = missing', { closedFlags: false }).state).toBe('unresolved');
    expect(
      evaluate('has_country_flag = declared', {
        closedFlags: false,
        state: { 'flag.declared': false },
      }).state,
    ).toBe('false');
  });

  it('orders dates by components instead of variable-width digit concatenation', () => {
    expect(evaluate('date < 1936.10.1', { date: '1936.9.30' }).state).toBe('true');
    expect(evaluate('date > 1936.9.30', { date: '1936.10.1' }).state).toBe('true');
  });
});

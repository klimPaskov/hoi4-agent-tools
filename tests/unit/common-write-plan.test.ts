import { describe, expect, it } from 'vitest';
import {
  planCommonWrite,
  planNewCommonFile,
  type CommonWritePlanInput,
} from '../../src/hoi4_agent_tools/common-write/write-plan.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';

const FILE = '# strategies\ntst_one = {\n\tabort_when_not_enabled = yes\n}\n';
const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: CommonWritePlanInput, text = FILE, path = 'common/ai_strategy/t.txt') =>
  planCommonWrite({ bytes: bytes(text), path }, input);
const codeOf = async (action: () => unknown): Promise<string> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('common_write plan', () => {
  it('adds after a blank line, removes back to the original bytes, and reports warnings', async () => {
    const added = await plan({
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_two',
      body: 'ai_strategy = { type = nope id = "AAA" value = 1 }',
      knownTokens: ['conquer'],
    });
    expect(added.text).toBe(
      `${FILE}\ntst_two = {\n\tai_strategy = { type = nope id = "AAA" value = 1 }\n}\n`,
    );
    expect(added.findings.map(({ code }) => code)).toEqual([
      'AI_STRATEGY_TYPE_UNKNOWN',
      'AI_STRATEGY_NO_ABORT',
    ]);
    expect(added.untouchedDefinitions).toBe(1);
    const removed = await planCommonWrite(
      { bytes: added.bytes, path: 'common/ai_strategy/t.txt' },
      { kind: 'ai_strategy', operation: 'remove', id: 'tst_two' },
    );
    expect(removed.text).toBe(FILE);
  });

  it('creates an on_actions file with its wrapper', async () => {
    const made = await planNewCommonFile('common/on_actions/t.txt', {
      kind: 'on_action',
      operation: 'add',
      id: 'on_daily_TST',
      body: 'effect = { log = "x" }',
    });
    expect(made.text).toBe(
      'on_actions = {\n\ton_daily_TST = {\n\t\teffect = { log = "x" }\n\t}\n}\n',
    );
  });

  it('refuses with the engine code and details', async () => {
    expect(
      await codeOf(() =>
        plan({ kind: 'ai_strategy', operation: 'add', id: 'tst_one', body: 'a = b' }),
      ),
    ).toBe('COMMON_WRITE_DUPLICATE_ID');
    expect(
      await codeOf(() =>
        plan(
          { kind: 'bop', operation: 'add', id: 'tst_bop', body: 'initial_value = 0' },
          '',
          'common/bop/t.txt',
        ),
      ),
    ).toBe('COMMON_WRITE_CHECK_FAILED');
    expect(
      await codeOf(() =>
        plan(
          { kind: 'on_action', operation: 'add', id: 'on_made_up', body: 'effect = { }' },
          '',
          'common/on_actions/t.txt',
        ),
      ),
    ).toBe('COMMON_WRITE_NAME_UNKNOWN');
    expect(
      await codeOf(() =>
        plan(
          { kind: 'ai_strategy', operation: 'add', id: 'tst_x', body: 'a = b' },
          FILE,
          'common/bop/t.txt',
        ),
      ),
    ).toBe('COMMON_WRITE_PATH_OUTSIDE_FOLDER');
  });
});

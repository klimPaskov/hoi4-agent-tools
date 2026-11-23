import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { callEngineOperation } from '../../src/hoi4_agent_tools/core/engine-operation.js';
import type {
  ResidentEngine,
  ResidentEngineOutcome,
} from '../../src/hoi4_agent_tools/core/resident-engine.js';

function stub(
  outcome: ResidentEngineOutcome,
): Pick<ResidentEngine, 'request'> & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    request: (op, body, payload) => {
      seen.push({ op, body, payload });
      return Promise.resolve(outcome);
    },
  };
}

const answer = z.object({ count: z.number().int() });

describe('callEngineOperation', () => {
  it('sends the op, body and payload and returns the checked result', async () => {
    const engine = stub({
      ok: true,
      response: { result: { count: 3 }, payload: Buffer.from('raw') },
    });
    const result = await callEngineOperation({
      op: 'event.graph',
      body: { root: 'a.1' },
      payload: Buffer.from('in'),
      result: answer,
      engine,
    });
    expect(result.result).toEqual({ count: 3 });
    expect(result.payload.toString()).toBe('raw');
    expect(engine.seen).toEqual([
      { op: 'event.graph', body: { root: 'a.1' }, payload: Buffer.from('in') },
    ]);
  });

  it('refuses an answer out of shape as ENGINE_UNAVAILABLE', async () => {
    const engine = stub({
      ok: true,
      response: { result: { count: 'x' }, payload: Buffer.alloc(0) },
    });
    await expect(callEngineOperation({ op: 'a.b', result: answer, engine })).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      details: { op: 'a.b', reason: 'invalid_response' },
    });
  });

  it("keeps an operation's own refusal code and details", async () => {
    const engine = stub({
      ok: false,
      kind: 'error',
      code: 'TRANSACTION_STALE',
      message: 'changed since read',
      details: { path: 'events/a.txt' },
    });
    await expect(
      callEngineOperation({ op: 'txn.apply', result: answer, engine }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_STALE',
      message: 'changed since read',
      details: { path: 'events/a.txt' },
    });
  });

  it('turns a protocol error or a missing engine into ENGINE_UNAVAILABLE', async () => {
    const unknown = stub({
      ok: false,
      kind: 'error',
      code: 'unknown_op',
      message: 'unknown op a.b',
      details: {},
    });
    await expect(
      callEngineOperation({ op: 'a.b', result: answer, engine: unknown }),
    ).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      details: { op: 'a.b', reason: 'unknown_op' },
    });
    const missing = stub({
      ok: false,
      kind: 'unavailable',
      reason: 'binary_not_found',
      message: 'no binary',
    });
    await expect(
      callEngineOperation({ op: 'a.b', result: answer, engine: missing }),
    ).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      details: { op: 'a.b', reason: 'binary_not_found' },
    });
  });
});

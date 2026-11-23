import type { z } from 'zod/v4';
import {
  sharedResidentEngine,
  type ResidentEngine,
  type ResidentEngineRequestOptions,
} from './resident-engine.js';
import { ServiceError } from './result.js';

/**
 * One call of a registered engine operation (ADR 0091). Each ported piece calls its operations
 * through here, so a packet of the parallel port adds no method to the engine client.
 *
 * The result is checked against the caller's schema. A missing engine, an engine without the
 * operation, or a protocol failure is `ENGINE_UNAVAILABLE`, with no fallback (ADR 0089). An
 * operation's own refusal keeps its code: an upper-case code such as `TRANSACTION_STALE` reaches
 * the caller unchanged, with the engine's details.
 */
export interface EngineOperationCall<T> {
  op: string;
  body?: Record<string, unknown>;
  payload?: Buffer;
  result: z.ZodType<T>;
  engine?: Pick<ResidentEngine, 'request'>;
  options?: ResidentEngineRequestOptions;
}

export interface EngineOperationAnswer<T> {
  result: T;
  payload: Buffer;
}

const TOOL_CODE = /^[A-Z][A-Z0-9_]*$/u;

export async function callEngineOperation<T>(
  call: EngineOperationCall<T>,
): Promise<EngineOperationAnswer<T>> {
  const engine = call.engine ?? sharedResidentEngine();
  const outcome = await engine.request(call.op, call.body ?? {}, call.payload, call.options ?? {});
  if (outcome.ok) {
    const parsed = call.result.safeParse(outcome.response.result);
    if (!parsed.success)
      throw new ServiceError('ENGINE_UNAVAILABLE', `hoi4-engine ${call.op} answered out of shape`, {
        op: call.op,
        reason: 'invalid_response',
      });
    return { result: parsed.data, payload: outcome.response.payload };
  }
  if (outcome.kind === 'error' && TOOL_CODE.test(outcome.code))
    throw new ServiceError(outcome.code, outcome.message, outcome.details);
  if (outcome.kind === 'error')
    throw new ServiceError('ENGINE_UNAVAILABLE', outcome.message, {
      op: call.op,
      reason: outcome.code,
    });
  throw new ServiceError('ENGINE_UNAVAILABLE', outcome.message, {
    op: call.op,
    reason: outcome.reason,
  });
}

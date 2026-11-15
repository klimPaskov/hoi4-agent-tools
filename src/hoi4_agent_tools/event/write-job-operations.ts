import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import type { JobOperations } from '../core/job-executor.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import { toolResult } from '../core/operation-result.js';
import { ServiceError } from '../core/result.js';
import { eventWriteRequestSchema } from '../schemas/event-write.js';
import {
  completeEventWrite,
  prepareEventWrite,
  previewEventWrite,
  type EventWriteOperationContext,
} from './write-operations.js';
import { EventChainViewer } from './service.js';

const wireResult = z.record(z.string(), z.json());

function wire(result: Parameters<typeof toolResult>[0]): z.infer<typeof wireResult> {
  return wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
}

/** Registers `hoi4.event_write`: a read-only preview, or one journaled transaction. */
export function registerEventWriteJobs(operations: JobOperations, engine: CoreEngine): void {
  const viewer = new EventChainViewer(engine);
  const lifetime = new IdleCacheLifetime(() => viewer.clearCaches());
  operations.registerWrite(
    'hoi4.event_write',
    eventWriteRequestSchema,
    async (input, context) => {
      if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
        throw new ServiceError(
          'JOB_ARGUMENT_SCOPE_MISMATCH',
          'The request workspace does not match the authorized job workspace',
        );
      const operationContext: EventWriteOperationContext = {
        workspaceId: context.workspaceId,
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        signal: context.signal,
        chainViewer: viewer,
        progress: (completed, total, message) => context.progress({ completed, total, message }),
      };
      // The chain report's graph stays cached while jobs follow one another, then is released.
      const release = lifetime.begin();
      try {
        if (!input.apply)
          return {
            readOnlyPreview: wire(await previewEventWrite(engine, input, operationContext)),
          };
        const prepared = await prepareEventWrite(engine, input, operationContext);
        if ('readOnlyPreview' in prepared)
          return { readOnlyPreview: wire(prepared.readOnlyPreview) };
        return { transaction: prepared.transaction, recipe: { ...prepared.recipe } };
      } finally {
        release();
      }
    },
    async (_input, execution, _reconciled, recipe, context) => {
      const result = completeEventWrite(context.workspaceId, execution, recipe);
      await context.progress({
        completed: 3,
        total: 3,
        message:
          execution.outcome === 'applied'
            ? 'Event change complete'
            : execution.outcome === 'unchanged'
              ? 'The event already matched the request'
              : 'Event change blocked',
      });
      return wire(result);
    },
  );
}

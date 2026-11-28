import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import type { JobOperations } from '../core/job-executor.js';
import { toolResult } from '../core/operation-result.js';
import { ServiceError } from '../core/result.js';
import { commonWriteRequestSchema } from '../schemas/common-write.js';
import {
  completeCommonWrite,
  prepareCommonWrite,
  previewCommonWrite,
  type CommonWriteOperationContext,
} from './write-operations.js';

const wireResult = z.record(z.string(), z.json());

function wire(result: Parameters<typeof toolResult>[0]): z.infer<typeof wireResult> {
  return wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
}

/** Registers `hoi4.common_write`: a read-only preview, or one journaled transaction. */
export function registerCommonWriteJobs(operations: JobOperations, engine: CoreEngine): void {
  operations.registerWrite(
    'hoi4.common_write',
    commonWriteRequestSchema,
    async (input, context) => {
      if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
        throw new ServiceError(
          'JOB_ARGUMENT_SCOPE_MISMATCH',
          'The request workspace does not match the authorized job workspace',
        );
      const operationContext: CommonWriteOperationContext = {
        workspaceId: context.workspaceId,
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        signal: context.signal,
        progress: (completed, total, message) => context.progress({ completed, total, message }),
      };
      if (!input.apply)
        return {
          readOnlyPreview: wire(await previewCommonWrite(engine, input, operationContext)),
        };
      const prepared = await prepareCommonWrite(engine, input, operationContext);
      if ('readOnlyPreview' in prepared) return { readOnlyPreview: wire(prepared.readOnlyPreview) };
      return { transaction: prepared.transaction, recipe: { ...prepared.recipe } };
    },
    async (_input, execution, _reconciled, recipe, context) => {
      const result = completeCommonWrite(context.workspaceId, execution, recipe);
      await context.progress({
        completed: 3,
        total: 3,
        message:
          execution.outcome === 'applied'
            ? 'Definition change complete'
            : execution.outcome === 'unchanged'
              ? 'The definition already matched the request'
              : 'Definition change blocked',
      });
      return wire(result);
    },
  );
}

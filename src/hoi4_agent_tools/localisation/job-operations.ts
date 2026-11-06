import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import type { JobOperations } from '../core/job-executor.js';
import { toolResult } from '../core/operation-result.js';
import { ServiceError } from '../core/result.js';
import { localisationWriteRequestSchema } from '../schemas/localisation-write.js';
import {
  completeLocalisationWrite,
  prepareLocalisationWrite,
  previewLocalisationWrite,
  type LocalisationOperationContext,
} from './write-operations.js';

const wireResult = z.record(z.string(), z.json());

function wire(result: Parameters<typeof toolResult>[0]): z.infer<typeof wireResult> {
  return wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
}

/** Registers `hoi4.localisation_write`: a read-only preview, or one journaled transaction. */
export function registerLocalisationJobs(operations: JobOperations, engine: CoreEngine): void {
  operations.registerWrite(
    'hoi4.localisation_write',
    localisationWriteRequestSchema,
    async (input, context) => {
      if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
        throw new ServiceError(
          'JOB_ARGUMENT_SCOPE_MISMATCH',
          'The request workspace does not match the authorized job workspace',
        );
      const operationContext: LocalisationOperationContext = {
        workspaceId: context.workspaceId,
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        signal: context.signal,
        progress: (completed, total, message) => context.progress({ completed, total, message }),
      };
      if (!input.apply)
        return {
          readOnlyPreview: wire(await previewLocalisationWrite(engine, input, operationContext)),
        };
      const prepared = await prepareLocalisationWrite(engine, input, operationContext);
      if ('readOnlyPreview' in prepared) return { readOnlyPreview: wire(prepared.readOnlyPreview) };
      return { transaction: prepared.transaction, recipe: { ...prepared.recipe } };
    },
    async (_input, execution, _reconciled, recipe, context) => {
      const result = completeLocalisationWrite(context.workspaceId, execution, recipe);
      await context.progress({
        completed: 3,
        total: 3,
        message:
          execution.outcome === 'applied'
            ? 'Localisation change complete'
            : execution.outcome === 'unchanged'
              ? 'Localisation already satisfied the request'
              : 'Localisation change blocked',
      });
      return wire(result);
    },
  );
}

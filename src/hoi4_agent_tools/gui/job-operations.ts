import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import type { JobOperations } from '../core/job-executor.js';
import { errorResult, toolResult } from '../core/operation-result.js';
import { ServiceError, type ServiceResult } from '../core/result.js';
import {
  guiInspectRequestSchema,
  guiRenderRequestSchema,
  guiRewriteRequestSchema,
} from '../schemas/gui-requests.js';
import { ScriptedGuiStudio } from './studio.js';
import {
  inspectGui,
  completeGuiRewrite,
  normalizeGuiInspectRequest,
  normalizeGuiRenderRequest,
  normalizeGuiRewriteRequest,
  prepareGuiRewrite,
  renderGui,
  type GuiOperationContext,
} from './tool-operations.js';

const wireResult = z.record(z.string(), z.json());

/** Registers read-only GUI operations without invoking transport handlers. */
export function registerGuiJobs(operations: JobOperations, engine: CoreEngine): void {
  const studio = new ScriptedGuiStudio(engine);
  const lifetime = new IdleCacheLifetime(() => studio.clearCaches());
  function register<Input extends { workspaceId: string }, Request extends { workspaceId: string }>(
    name: string,
    schema: z.ZodType<Input>,
    normalize: (input: unknown) => Request,
    execute: (
      studio: ScriptedGuiStudio,
      input: Request,
      context: GuiOperationContext,
    ) => Promise<ServiceResult<unknown>>,
  ): void {
    operations.registerRead(name, schema, async (input, context) => {
      const release = lifetime.begin();
      try {
        if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
          throw new ServiceError(
            'JOB_ARGUMENT_SCOPE_MISMATCH',
            'The request workspace does not match the authorized job workspace',
          );
        const result = await execute(studio, normalize(input), {
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
          progress: (completed, total, message) => context.progress({ completed, total, message }),
        });
        const wire = wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
        const revision =
          result.data !== null &&
          typeof result.data === 'object' &&
          'sourceRevision' in result.data &&
          typeof result.data.sourceRevision === 'string'
            ? result.data.sourceRevision
            : result.data !== null &&
                typeof result.data === 'object' &&
                'sharedRevision' in result.data &&
                typeof result.data.sharedRevision === 'string'
              ? result.data.sharedRevision
              : undefined;
        if (revision !== undefined) await context.stageResult(wire, { sourceRevision: revision });
        return wire;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return wireResult.parse(
          JSON.parse(JSON.stringify(errorResult(error, context.workspaceId))) as unknown,
        );
      } finally {
        release();
      }
    });
  }
  register(
    'hoi4.gui_inspect',
    guiInspectRequestSchema,
    normalizeGuiInspectRequest,
    (studio, input, context) => inspectGui(engine, studio, input, context),
  );
  register('hoi4.gui_render', guiRenderRequestSchema, normalizeGuiRenderRequest, renderGui);
  operations.registerWrite(
    'hoi4.gui_rewrite',
    guiRewriteRequestSchema,
    async (input, context) => {
      if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
        throw new ServiceError(
          'JOB_ARGUMENT_SCOPE_MISMATCH',
          'The request workspace does not match the authorized job workspace',
        );
      const release = lifetime.begin();
      try {
        return await prepareGuiRewrite(studio, normalizeGuiRewriteRequest(input), {
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
          progress: (completed, total, message) => context.progress({ completed, total, message }),
        });
      } finally {
        release();
      }
    },
    async (_input, execution, _reconciled, recipe, context) => {
      const result = completeGuiRewrite(context.workspaceId, execution, recipe);
      await context.progress({
        completed: 3,
        total: 3,
        message:
          execution.outcome === 'applied'
            ? 'GUI rewrite complete'
            : execution.outcome === 'unchanged'
              ? 'GUI content already satisfied the rewrite'
              : 'GUI rewrite blocked',
      });
      return wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
    },
  );
}

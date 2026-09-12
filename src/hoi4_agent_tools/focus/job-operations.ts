import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import type { JobOperations } from '../core/job-executor.js';
import { errorResult, toolResult } from '../core/operation-result.js';
import { ServiceError, type ServiceResult } from '../core/result.js';
import {
  focusInspectRequestSchema,
  focusRenderRequestSchema,
  focusRewriteRequestSchema,
} from '../schemas/focus-requests.js';
import { FocusWorkbench } from './index.js';
import {
  inspectFocus,
  completeFocusRewrite,
  normalizeFocusInspectRequest,
  normalizeFocusRenderRequest,
  normalizeFocusRewriteRequest,
  prepareFocusRewrite,
  renderFocus,
  type FocusOperationContext,
} from './tool-operations.js';

const wireResult = z.record(z.string(), z.json());

interface FocusExecution {
  result: ServiceResult<unknown>;
  sourceRevision: string;
}

/** Registers read-only focus operations without invoking transport handlers. */
export function registerFocusJobs(operations: JobOperations, engine: CoreEngine): void {
  const workbench = new FocusWorkbench(engine.resolver, engine.transactions, engine.artifacts);
  const lifetime = new IdleCacheLifetime(() => engine.releaseScanCaches());
  function register<Input extends { workspaceId: string }, Request extends { workspaceId: string }>(
    name: string,
    schema: z.ZodType<Input>,
    normalize: (input: unknown) => Request,
    execute: (input: Request, context: FocusOperationContext) => Promise<FocusExecution>,
  ): void {
    operations.registerRead(name, schema, async (input, context) => {
      const release = lifetime.begin();
      try {
        if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
          throw new ServiceError(
            'JOB_ARGUMENT_SCOPE_MISMATCH',
            'The request workspace does not match the authorized job workspace',
          );
        const execution = await execute(normalize(input), {
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
          progress: (completed, total, message) => context.progress({ completed, total, message }),
        });
        const wire = wireResult.parse(
          JSON.parse(JSON.stringify(toolResult(execution.result))) as unknown,
        );
        await context.stageResult(wire, { sourceRevision: execution.sourceRevision });
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
    'hoi4.focus_inspect',
    focusInspectRequestSchema,
    normalizeFocusInspectRequest,
    (input, context) => inspectFocus(engine, workbench, input, context),
  );
  register(
    'hoi4.focus_render',
    focusRenderRequestSchema,
    normalizeFocusRenderRequest,
    (input, context) => renderFocus(engine, workbench, input, context, false),
  );
  register(
    'hoi4.focus_raster',
    focusRenderRequestSchema,
    normalizeFocusRenderRequest,
    (input, context) => renderFocus(engine, workbench, input, context, true),
  );
  operations.registerWrite(
    'hoi4.focus_rewrite',
    focusRewriteRequestSchema,
    async (input, context) => {
      if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
        throw new ServiceError(
          'JOB_ARGUMENT_SCOPE_MISMATCH',
          'The request workspace does not match the authorized job workspace',
        );
      const release = lifetime.begin();
      try {
        return await prepareFocusRewrite(engine, workbench, normalizeFocusRewriteRequest(input), {
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
          progress: (completed, total, message) => context.progress({ completed, total, message }),
        });
      } finally {
        release();
      }
    },
    async (input, execution, _reconciled, recipe, context) => {
      const result = completeFocusRewrite(context.workspaceId, execution, recipe);
      const continuous = input.mode === 'continuous';
      await context.progress({
        completed: 5,
        total: 5,
        message:
          execution.outcome === 'applied'
            ? continuous
              ? 'Continuous focus rewrite complete'
              : 'Focus rewrite complete'
            : execution.outcome === 'unchanged'
              ? continuous
                ? 'Continuous focus content already satisfied the plan'
                : 'Focus content already satisfied the plan'
              : continuous
                ? 'Continuous focus rewrite blocked'
                : 'Focus rewrite blocked',
      });
      return wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
    },
  );
}

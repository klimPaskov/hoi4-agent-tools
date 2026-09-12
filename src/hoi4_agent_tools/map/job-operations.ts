import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import type { JobOperations } from '../core/job-executor.js';
import { errorResult, toolResult } from '../core/operation-result.js';
import { ServiceError, type ServiceResult } from '../core/result.js';
import {
  mapInspectRequestSchema,
  mapRenderRequestSchema,
  mapRewriteRequestSchema,
} from '../schemas/map-requests.js';
import { AgentNudger } from './service.js';
import {
  inspectMap,
  completeMapRewrite,
  normalizeMapInspectRequest,
  normalizeMapRenderRequest,
  normalizeMapRewriteRequest,
  prepareMapRewrite,
  renderMapView,
  type MapOperationContext,
} from './tool-operations.js';

const wireResult = z.record(z.string(), z.json());

/** Registers read-only map operations without invoking transport handlers. */
export function registerMapJobs(operations: JobOperations, engine: CoreEngine): void {
  const nudger = new AgentNudger(engine);
  const lifetime = new IdleCacheLifetime(() => engine.releaseScanCaches());
  function register<Input extends { workspaceId: string }, Request extends { workspaceId: string }>(
    name: string,
    schema: z.ZodType<Input>,
    normalize: (input: unknown) => Request,
    execute: (
      nudger: AgentNudger,
      input: Request,
      context: MapOperationContext,
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
        const result = await execute(nudger, normalize(input), {
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
          progress: (completed, total, message) => context.progress({ completed, total, message }),
        });
        const wire = wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
        const revision =
          result.data !== null &&
          typeof result.data === 'object' &&
          'revision' in result.data &&
          typeof result.data.revision === 'string'
            ? result.data.revision
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
    'hoi4.map_inspect',
    mapInspectRequestSchema,
    normalizeMapInspectRequest,
    (nudger, input, context) => inspectMap(engine, nudger, input, context),
  );
  register('hoi4.map_render', mapRenderRequestSchema, normalizeMapRenderRequest, renderMapView);
  operations.registerWrite(
    'hoi4.map_rewrite',
    mapRewriteRequestSchema,
    async (input, context) => {
      if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
        throw new ServiceError(
          'JOB_ARGUMENT_SCOPE_MISMATCH',
          'The request workspace does not match the authorized job workspace',
        );
      const release = lifetime.begin();
      try {
        return await prepareMapRewrite(nudger, normalizeMapRewriteRequest(input), {
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
      const result = completeMapRewrite(context.workspaceId, execution, recipe);
      await context.progress({
        completed: 5,
        total: 5,
        message:
          execution.outcome === 'applied'
            ? 'Map rewrite complete'
            : execution.outcome === 'unchanged'
              ? 'Map content already satisfied the operations'
              : 'Map rewrite blocked',
      });
      return wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
    },
  );
}

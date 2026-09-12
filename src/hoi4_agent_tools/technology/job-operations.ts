import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import type { JobOperations } from '../core/job-executor.js';
import { errorResult, toolResult } from '../core/operation-result.js';
import { ServiceError, type ServiceResult } from '../core/result.js';
import {
  technologyCompareRequestSchema,
  technologyInspectRequestSchema,
  technologyRenderRequestSchema,
} from '../schemas/technology.js';
import {
  compareTechnologies,
  inspectTechnologies,
  normalizeTechnologyCompareRequest,
  normalizeTechnologyInspectionRequest,
  normalizeTechnologyRenderRequest,
  renderTechnologies,
} from './operations.js';
import { TechnologyTreeViewer } from './service.js';

const wireResult = z.record(z.string(), z.json());

/** Registers typed technology operations without invoking transport handlers. */
export function registerTechnologyJobs(operations: JobOperations, engine: CoreEngine): void {
  const viewer = new TechnologyTreeViewer(engine);
  const lifetime = new IdleCacheLifetime(() => viewer.clearCaches());
  function register<Input extends { workspaceId: string }, Request extends { workspaceId: string }>(
    name: string,
    schema: z.ZodType<Input>,
    normalize: (input: unknown) => Request,
    execute: (viewer: TechnologyTreeViewer, input: Request) => Promise<ServiceResult<unknown>>,
    message: string,
  ): void {
    operations.registerRead(name, schema, async (input, context) => {
      const release = lifetime.begin();
      try {
        if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
          throw new ServiceError(
            'JOB_ARGUMENT_SCOPE_MISMATCH',
            'The request workspace does not match the authorized job workspace',
          );
        await context.progress({ completed: 0, total: 3, message });
        const result = await execute(viewer, {
          ...normalize(input),
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
        });
        await context.progress({
          completed: 3,
          total: 3,
          message: 'Technology operation complete',
        });
        const wire = wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
        const revision =
          result.data !== null &&
          typeof result.data === 'object' &&
          'revision' in result.data &&
          typeof result.data.revision === 'string'
            ? result.data.revision
            : result.data !== null &&
                typeof result.data === 'object' &&
                'afterRevision' in result.data &&
                typeof result.data.afterRevision === 'string'
              ? result.data.afterRevision
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
    'hoi4.tech_inspect',
    technologyInspectRequestSchema,
    normalizeTechnologyInspectionRequest,
    inspectTechnologies,
    'Analyzing technology trees',
  );
  register(
    'hoi4.tech_render',
    technologyRenderRequestSchema,
    normalizeTechnologyRenderRequest,
    renderTechnologies,
    'Rendering technology-tree view',
  );
  register(
    'hoi4.tech_compare',
    technologyCompareRequestSchema,
    normalizeTechnologyCompareRequest,
    compareTechnologies,
    'Comparing technology-tree graphs',
  );
}

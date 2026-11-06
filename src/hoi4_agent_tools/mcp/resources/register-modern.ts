import { ReadResourceResultSchema } from '@modelcontextprotocol/core';
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from '@modelcontextprotocol/server';
import { artifactResourceDefinition, readArtifactResource } from '../../core/artifact-resource.js';
import type { CoreEngine } from '../../core/engine.js';
import { readServerStatus, serverStatusResource } from '../../core/server-status-resource.js';
import type { OperationContext } from '../../core/operation-context.js';
import { ServiceError } from '../../core/result.js';
import {
  listSkillResources,
  readSkillResource,
  skillResourceDefinition,
} from '../../reference/skill-resource.js';
import type { ModernTaskRoutingServer } from '../transports/modern-task-routing.js';

/** Modern wire projection of the same non-enumerating, authorization-bound resource reader. */
export function registerModernResources(
  server: ModernTaskRoutingServer,
  engine: CoreEngine,
  context: OperationContext,
): void {
  // Process details are offered to the local client only, never to authenticated remote ones.
  const local = context.principal === undefined;
  server.setRequestHandler('resources/list', async (_request, extra) => ({
    resources: [
      ...(local ? [serverStatusResource] : []),
      ...(await listSkillResources(engine, context, extra.mcpReq.signal)),
    ],
  }));
  server.setRequestHandler('resources/templates/list', () => ({
    resourceTemplates: [artifactResourceDefinition, skillResourceDefinition],
  }));
  server.setRequestHandler('resources/read', async (request, extra) => {
    if (local && request.params.uri === serverStatusResource.uri)
      return ReadResourceResultSchema.parse({
        ...(await readServerStatus(engine)),
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
      });
    try {
      return ReadResourceResultSchema.parse({
        ...(/^hoi4-agent:\/\/workspace\/[^/]+\/skill\//u.test(request.params.uri)
          ? await readSkillResource(engine, request.params.uri, context, extra.mcpReq.signal)
          : await readArtifactResource(engine, request.params.uri, context, extra.mcpReq.signal)),
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
      });
    } catch (error) {
      if (extra.mcpReq.signal.aborted) throw error;
      if (error instanceof ServiceError) {
        if (
          error.code.startsWith('RESOURCE_') ||
          error.code === 'SKILL_TEXT_DRIFTED' ||
          ['ARTIFACT_URI_INVALID', 'ARTIFACT_RANGE_INVALID', 'ARTIFACT_METADATA_INVALID'].includes(
            error.code,
          )
        )
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, {
            code: error.code,
          });
        throw new ResourceNotFoundError(request.params.uri);
      }
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'The resource could not be read');
    }
  });
}

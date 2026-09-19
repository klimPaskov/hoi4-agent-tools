import { ReadResourceResultSchema } from '@modelcontextprotocol/core';
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from '@modelcontextprotocol/server';
import { artifactResourceDefinition, readArtifactResource } from '../../core/artifact-resource.js';
import type { CoreEngine } from '../../core/engine.js';
import type { OperationContext } from '../../core/operation-context.js';
import { ServiceError } from '../../core/result.js';
import type { ModernTaskRoutingServer } from '../transports/modern-task-routing.js';

/** Modern wire projection of the same non-enumerating, authorization-bound resource reader. */
export function registerModernResources(
  server: ModernTaskRoutingServer,
  engine: CoreEngine,
  context: OperationContext,
): void {
  server.setRequestHandler('resources/list', () => ({ resources: [] }));
  server.setRequestHandler('resources/templates/list', () => ({
    resourceTemplates: [artifactResourceDefinition],
  }));
  server.setRequestHandler('resources/read', async (request, extra) => {
    try {
      return ReadResourceResultSchema.parse({
        ...(await readArtifactResource(engine, request.params.uri, context, extra.mcpReq.signal)),
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
      });
    } catch (error) {
      if (extra.mcpReq.signal.aborted) throw error;
      if (error instanceof ServiceError) {
        if (
          error.code.startsWith('RESOURCE_') ||
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

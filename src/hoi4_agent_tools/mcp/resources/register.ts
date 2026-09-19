import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { artifactResourceDefinition, readArtifactResource } from '../../core/artifact-resource.js';
import type { CoreEngine } from '../../core/engine.js';
import type { ServerContext } from '../server/base-tools.js';

/** SDK-v1 registration only; ownership and byte-range behavior live in the shared core. */
export function registerMcpResources(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const { name, uriTemplate, ...metadata } = artifactResourceDefinition;
  server.registerResource(
    name,
    new ResourceTemplate(uriTemplate, { list: undefined }),
    metadata,
    (uri, _variables, extra) => readArtifactResource(engine, uri.href, context, extra.signal),
  );
}

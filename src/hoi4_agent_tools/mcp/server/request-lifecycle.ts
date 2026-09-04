import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { progressReporter, withProgressHeartbeat } from './progress.js';

/** Wrap the public SDK handler registration so optional tools receive the same lifecycle. */
export function installRequestLifecycle(server: McpServer, engine: CoreEngine): void {
  const register = server.server.setRequestHandler.bind(server.server);
  const owner = {};
  server.server.setRequestHandler = (schema, handler) => {
    register(schema, (request, extra) => {
      if (request.method !== 'tools/call') return handler(request, extra);
      const progress = progressReporter(extra);
      return withProgressHeartbeat(
        () =>
          engine.requests.run(owner, Buffer.byteLength(JSON.stringify(request)), extra.signal, () =>
            engine.sharedRequests.run(extra.signal, async () => handler(request, extra)),
          ),
        progress,
      );
    });
  };
}

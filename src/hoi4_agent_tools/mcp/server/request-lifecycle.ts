import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CoreEngine } from '../../core/engine.js';
import { DOMAIN_TOOL_NAMES } from '../../core/domain-tools.js';
import { normalizeToolArguments } from '../../schemas/lenient-arguments.js';
import { progressReporter, withProgressHeartbeat } from './progress.js';
import { withTaskRequestSignal } from './task-request-context.js';
import { slimToolList } from './tool-listing.js';

// Durable task compatibility and cancellation are control traffic. They must
// remain responsive while every domain-execution slot is occupied.
const controlTools = new Set(['hoi4.job_inspect', 'hoi4.job_cancel']);

const backgroundTools: ReadonlySet<string> = new Set(DOMAIN_TOOL_NAMES);

/** Wrap the public SDK handler registration so optional tools receive the same lifecycle. */
export function installRequestLifecycle(server: McpServer, engine: CoreEngine): void {
  const register = server.server.setRequestHandler.bind(server.server);
  const owner = {};
  server.server.setRequestHandler = (schema, handler) => {
    register(schema, (request, extra) => {
      if (request.method === 'tools/list')
        return Promise.resolve(handler(request, extra)).then(slimToolList);
      if (request.method !== 'tools/call') return handler(request, extra);
      const params = (request as { params?: { name?: unknown; arguments?: unknown } }).params;
      if (params !== undefined && typeof params.name === 'string')
        params.arguments = normalizeToolArguments(params.name, params.arguments);
      const progress = progressReporter(extra);
      const taskCall = CallToolRequestSchema.safeParse(request);
      if (taskCall.success && controlTools.has(taskCall.data.params.name))
        return handler(request, extra);
      if (taskCall.success && backgroundTools.has(taskCall.data.params.name)) {
        return withProgressHeartbeat(async () => {
          const result = await withTaskRequestSignal(extra.signal, () => handler(request, extra));
          if (taskCall.data.params.task === undefined) {
            await progress.report(2, 3, 'Retrieving persistent operation result');
            await progress.report(3, 3, 'Persistent operation complete');
          }
          return result;
        }, progress);
      }
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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CoreEngine } from '../../core/engine.js';
import { progressReporter, withProgressHeartbeat } from './progress.js';
import { withTaskRequestSignal } from './task-request-context.js';

// Durable task compatibility and cancellation are control traffic. They must
// remain responsive while every domain-execution slot is occupied.
const controlTools = new Set(['hoi4.job_inspect', 'hoi4.job_cancel']);

const backgroundTools = new Set([
  'hoi4.impact_inspect',
  'hoi4.decision_inspect',
  'hoi4.mechanic_test',
  'hoi4.package_check',
  'hoi4.scenario_test',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.event_compare',
  'hoi4.tech_inspect',
  'hoi4.tech_render',
  'hoi4.tech_compare',
  'hoi4.probability_inspect',
  'hoi4.probability_evaluate',
  'hoi4.probability_sweep',
  'hoi4.probability_simulate',
  'hoi4.probability_sequence',
  'hoi4.probability_compare',
  'hoi4.probability_render',
  'hoi4.map_inspect',
  'hoi4.map_render',
  'hoi4.map_rewrite',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.gui_rewrite',
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_raster',
  'hoi4.focus_rewrite',
]);

/** Wrap the public SDK handler registration so optional tools receive the same lifecycle. */
export function installRequestLifecycle(server: McpServer, engine: CoreEngine): void {
  const register = server.server.setRequestHandler.bind(server.server);
  const owner = {};
  server.server.setRequestHandler = (schema, handler) => {
    register(schema, (request, extra) => {
      if (request.method !== 'tools/call') return handler(request, extra);
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

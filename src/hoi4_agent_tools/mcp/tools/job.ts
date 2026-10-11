import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CoreEngine } from '../../core/engine.js';
import type { JobService } from '../../core/job-service.js';
import {
  JobControlService,
  jobReferenceSchema,
  jobStatusOutputSchema,
} from '../../core/job-controls.js';
import { errorResult } from '../../core/operation-result.js';
import type { ServerContext } from '../server/base-tools.js';
import type { ToolDefinition } from '../server/task-tool-definition.js';

export const jobControlTools = [
  {
    name: 'hoi4.job_inspect',
    title: 'Check a background task',
    description:
      'Check progress on a background task or retrieve its completed result. Pass jobId from the task handle. Example: {"jobId":"job_<64 hex characters>"}. Returns task status or the completed result.',
    inputSchema: jobReferenceSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'hoi4.job_cancel',
    title: 'Stop a background task',
    description:
      'Stop a background task by jobId. A result that has already completed stays available. Example: {"jobId":"job_<64 hex characters>"}.',
    inputSchema: jobReferenceSchema,
    outputSchema: jobStatusOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const satisfies readonly ToolDefinition[];

/** SDK-v1 projection of the shared, principal-private persistent-job controls. */
export function registerJobTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
  service?: Promise<JobService>,
): void {
  const controls = new JobControlService(engine, service);
  for (const { name, ...definition } of jobControlTools) {
    server.registerTool(name, definition, async (input, extra) => {
      try {
        return CallToolResultSchema.parse(await controls.call(name, input, context, extra.signal));
      } catch (error) {
        if (extra.signal.aborted) throw error;
        return errorResult(error, input.workspaceId);
      }
    });
  }
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  ToolTaskHandler,
} from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod/v4';
import type { TaskToolDefinition } from './task-tool-definition.js';

/** SDK-v1-only registration boundary for the 2025 task protocol. */
export function registerLegacyTaskTools(
  server: McpServer,
  definitions: readonly TaskToolDefinition[],
): void {
  for (const { name, ...configuration } of definitions) {
    const handler = {
      createTask: async (input: unknown, extra: CreateTaskRequestHandlerExtra) => {
        configuration.inputSchema.parse(input);
        return CreateTaskResultSchema.parse({
          task: await extra.taskStore.createTask({
            ttl: extra.taskRequestedTtl ?? null,
            pollInterval: 250,
          }),
        });
      },
      getTask: async (_input: unknown, extra: TaskRequestHandlerExtra) =>
        GetTaskResultSchema.parse(await extra.taskStore.getTask(extra.taskId)),
      getTaskResult: async (_input: unknown, extra: TaskRequestHandlerExtra) =>
        CallToolResultSchema.parse(await extra.taskStore.getTaskResult(extra.taskId)),
    };
    server.experimental.tasks.registerToolTask(
      name,
      { ...configuration, execution: { taskSupport: 'optional' } },
      handler as unknown as ToolTaskHandler<z.ZodType>,
    );
  }
}

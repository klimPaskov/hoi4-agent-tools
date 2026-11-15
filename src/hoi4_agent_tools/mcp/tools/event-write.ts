import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import { eventWriteDataSchema, eventWriteRequestSchema } from '../../schemas/event-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const eventWriteTaskTools = [
  {
    name: 'hoi4.event_write',
    title: 'Add, replace or remove an event',
    description:
      'Add, replace or remove one event (country_event, news_event, state_event and so on) in a mod events file, touching only that block. add needs body (the text between the braces, without id); replace and remove find the event by id. apply false returns the diff; true writes it. createNamespace and createFile (add only) make a missing add_namespace line or file. Warns about missing localisation or picture. Example: {"operation":"add","id":"my_events.1","createNamespace":true,"body":"title = my_events.1.t"}',
    inputSchema: eventWriteRequestSchema,
    outputSchema: strictOperationResultSchema(eventWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerEventWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, eventWriteTaskTools);
}

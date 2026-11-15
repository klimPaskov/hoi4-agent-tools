import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import {
  doctrineWriteDataSchema,
  doctrineWriteRequestSchema,
} from '../../schemas/doctrine-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const doctrineWriteTaskTools = [
  {
    name: 'hoi4.doctrine_write',
    title: 'Add, replace or remove a doctrine',
    description:
      'Add, replace or remove one grand doctrine, track or subdoctrine in a mod common/doctrines file, touching only that block. add needs kind (grand_doctrine, track or subdoctrine) unless file says where, and body (the text between the braces); replace and remove find the doctrine by id. apply false returns the diff; true writes it. createFile (add only) makes a missing file. Warns about a missing name, icon, folder or track. Example: {"operation":"add","kind":"track","id":"my_track","body":"name = my_track"}',
    inputSchema: doctrineWriteRequestSchema,
    outputSchema: strictOperationResultSchema(doctrineWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerDoctrineWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, doctrineWriteTaskTools);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import { techWriteDataSchema, techWriteRequestSchema } from '../../schemas/tech-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const techWriteTaskTools = [
  {
    name: 'hoi4.tech_write',
    title: 'Add, replace or remove a technology',
    description:
      'Add, replace or remove one technology in a mod common/technologies file, touching only that block. add needs body (the text between the braces); replace (also a move in the tree) and remove find the technology by id. apply false returns the diff; true writes it. createFile (add only) makes a missing file. Warns about missing localisation, icon, folder or unlock; apply refuses an undefined folder. Example: {"operation":"add","id":"my_tech","body":"research_cost = 1.5 start_year = 1936"}',
    inputSchema: techWriteRequestSchema,
    outputSchema: strictOperationResultSchema(techWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerTechWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, techWriteTaskTools);
}

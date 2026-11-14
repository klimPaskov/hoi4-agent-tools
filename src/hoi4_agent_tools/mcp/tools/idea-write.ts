import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import { ideaWriteDataSchema, ideaWriteRequestSchema } from '../../schemas/idea-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const ideaWriteTaskTools = [
  {
    name: 'hoi4.idea_write',
    title: 'Add, replace or remove an idea',
    description:
      'Add, replace or remove one idea (national spirit, law, advisor) in a mod common/ideas file, touching only that block. add needs category and body (the text between the braces); replace and remove find the idea. apply false returns the diff; true writes it. createCategory and createFile (add only) make a missing category or file; without them a typo is refused. Warns about a missing localisation key or picture sprite. Example: {"operation":"add","id":"my_spirit","category":"country","body":"picture = my_spirit"}',
    inputSchema: ideaWriteRequestSchema,
    outputSchema: strictOperationResultSchema(ideaWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerIdeaWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, ideaWriteTaskTools);
}

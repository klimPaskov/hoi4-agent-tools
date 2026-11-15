import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import {
  characterWriteDataSchema,
  characterWriteRequestSchema,
} from '../../schemas/character-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const characterWriteTaskTools = [
  {
    name: 'hoi4.character_write',
    title: 'Add, replace or remove a character',
    description:
      'Add, replace or remove one character in a mod common/characters file, touching only that block. add needs body (the text between the braces: name, portraits, country_leader, advisor, unit leaders); replace and remove find the character. apply false returns the diff; true writes it. createFile (add only) makes a missing file. Warns about a missing name localisation key or portrait sprite. Example: {"operation":"add","id":"TAG_jane_doe","body":"name = TAG_jane_doe"}',
    inputSchema: characterWriteRequestSchema,
    outputSchema: strictOperationResultSchema(characterWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerCharacterWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, characterWriteTaskTools);
}

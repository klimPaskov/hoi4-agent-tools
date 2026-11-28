import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import { commonWriteDataSchema, commonWriteRequestSchema } from '../../schemas/common-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const commonWriteTaskTools = [
  {
    name: 'hoi4.common_write',
    title: 'Add, replace or remove a balance of power, AI strategy, AI strategy plan or on_action',
    description:
      'Add, replace or remove one definition in a mod common file, touching only that block. kind is bop (common/bop), ai_strategy (common/ai_strategy), ai_strategy_plan (common/ai_strategy_plans) or on_action (common/on_actions, inside on_actions = { }). body is raw script, the text between the braces: it must parse and is written as given. replace and remove find the id; on_action add appends to the key, and blockIndex picks one child block of it. apply false returns the diff; true writes it. createFile (add only, with file) makes a missing file. A balance of power whose ranges do not cover -1 to 1 once, or whose sides do not match, is refused; an unknown strategy type, a missing abort, or a missing localisation key, sprite, category or focus is a warning. An unknown on_action name is refused with the documented names. Example: {"kind":"on_action","operation":"add","id":"on_startup","file":"common/on_actions/my_mod.txt","createFile":true,"body":"effect = { add_political_power = 10 }"}',
    inputSchema: commonWriteRequestSchema,
    outputSchema: strictOperationResultSchema(commonWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerCommonWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, commonWriteTaskTools);
}

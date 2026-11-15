import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import {
  decisionWriteDataSchema,
  decisionWriteRequestSchema,
} from '../../schemas/decision-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const decisionWriteTaskTools = [
  {
    name: 'hoi4.decision_write',
    title: 'Add, replace or remove a decision',
    description:
      'Add, replace or remove one decision in a mod common/decisions file, touching only that block. add needs category and body (the text between the braces); replace and remove find the decision by id. apply false returns the diff; true writes it. createCategory and createFile (add only) make a missing category block or file. Warns about a missing localisation key, icon sprite or category. Example: {"operation":"add","id":"my_decision","category":"my_category","body":"icon = generic_research"}',
    inputSchema: decisionWriteRequestSchema,
    outputSchema: strictOperationResultSchema(decisionWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerDecisionWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, decisionWriteTaskTools);
}

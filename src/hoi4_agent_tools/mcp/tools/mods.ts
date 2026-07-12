import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { compareCodeUnits } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import { emptyServiceResult } from '../../core/result.js';
import { nonNegativeIntegerSchema } from '../server/output-schemas.js';
import { errorResult, strictOperationResultSchema, toolResult } from '../server/result.js';
import type { ServerContext } from '../server/base-tools.js';

const modsOutputSchema = strictOperationResultSchema(
  z
    .object({
      count: nonNegativeIntegerSchema,
      mods: z
        .array(
          z
            .object({
              id: z.string().min(1).max(64),
              name: z.string().min(1).max(256),
              writable: z.boolean(),
            })
            .strict(),
        )
        .max(1_000),
    })
    .strict(),
);

export function registerModsTool(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  server.registerTool(
    'hoi4.mods',
    {
      title: 'List available HOI4 mods',
      description: 'List configured HOI4 mod workspaces, optionally selecting one by ID.',
      inputSchema: z.object({ workspaceId: z.string().min(1).max(64).optional() }).strict(),
      outputSchema: modsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ workspaceId }) => {
      try {
        const mods = (
          workspaceId === undefined
            ? engine.list(context.principal)
            : [engine.status(workspaceId, context.principal)]
        )
          .filter(({ kind }) => kind === 'mod')
          .sort((left, right) => compareCodeUnits(left.id, right.id));
        const result = emptyServiceResult(workspaceId ?? '', {
          count: mods.length,
          mods: mods.map(({ id, name, writable }) => ({
            id,
            name,
            writable,
          })),
        });
        result.code = 'MODS_LISTED';
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId ?? '');
      }
    },
  );
}

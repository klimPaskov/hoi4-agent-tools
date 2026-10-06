import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import type { OperationContext } from '../../core/operation-context.js';
import { errorResult, strictOperationResultSchema } from '../../core/operation-result.js';
import { ReferenceToolService } from '../../reference/operations.js';
import {
  referenceContextRequestSchema,
  referenceReadRequestSchema,
  referenceSearchRequestSchema,
  sourceLookupRequestSchema,
  referenceContextDataSchema,
  referenceReadDataSchema,
  referenceSearchDataSchema,
  sourceLookupDataSchema,
} from '../../schemas/reference.js';
import type { ToolDefinition } from '../server/task-tool-definition.js';
import {
  errorLogDataSchema,
  errorLogRequestSchema,
  modIndexDataSchema,
  modIndexRequestSchema,
} from '../../schemas/mod-tools.js';
import {
  scriptValidateDataSchema,
  scriptValidateRequestSchema,
} from '../../schemas/script-validation.js';

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const referenceTools = [
  {
    name: 'hoi4.reference_search',
    title: 'Search local HOI4 references',
    description:
      'Search bounded, cited sections of the configured offline wiki and installed game documentation.',
    inputSchema: referenceSearchRequestSchema,
    outputSchema: strictOperationResultSchema(referenceSearchDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.reference_read',
    title: 'Read cited HOI4 reference section',
    description: 'Read at most 80 lines from one revision-bound local documentation section.',
    inputSchema: referenceReadRequestSchema,
    outputSchema: strictOperationResultSchema(referenceReadDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.reference_context',
    title: 'Get HOI4 task references',
    description:
      'Return a compact bundle of offline wiki and installed game documentation citations for a modding surface.',
    inputSchema: referenceContextRequestSchema,
    outputSchema: strictOperationResultSchema(referenceContextDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.source_lookup',
    title: 'Look up HOI4 source symbol',
    description:
      'Find exact Clausewitz definitions and usages; navigate nested keyPath blocks or list bounded child structure with view=structure. Or pass path and line to get the definitions and keyPath containing that line.',
    inputSchema: sourceLookupRequestSchema,
    outputSchema: strictOperationResultSchema(sourceLookupDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.script_validate',
    title: 'Check HOI4 script commands and scopes',
    description:
      'Check an effect or trigger snippet (source, kind, scope) or a whole mod file (path) for syntax, native command kinds and scopes against cited installed documentation. Unknown helpers and native argument blocks remain explicit.',
    inputSchema: scriptValidateRequestSchema,
    outputSchema: strictOperationResultSchema(scriptValidateDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.error_log',
    title: 'Read the game error log',
    description:
      'Group logs/error.log from the last game launch by category, with the source file, line and layer of each entry and whether that file changed since. Filter by scope, category or text.',
    inputSchema: errorLogRequestSchema,
    outputSchema: strictOperationResultSchema(errorLogDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.mod_index',
    title: 'Index mod definitions and free IDs',
    description:
      'overview: definition counts by kind, folders and event namespace ranges of the mod; next_id: the next free numbered ID for a prefix or namespace across every layer.',
    inputSchema: modIndexRequestSchema,
    outputSchema: strictOperationResultSchema(modIndexDataSchema),
    annotations: readOnly,
  },
] as const satisfies readonly ToolDefinition[];

export function registerReferenceTools(
  server: McpServer,
  engine: CoreEngine,
  context: OperationContext,
): void {
  const service = new ReferenceToolService(engine);
  for (const entry of referenceTools) {
    const { name: _name, ...definition }: ToolDefinition = entry;
    const name = entry.name;
    server.registerTool(name, definition, async (input, extra) => {
      try {
        return await service.call(name, input, context, extra.signal);
      } catch (error) {
        if (extra.signal.aborted) throw error;
        return errorResult(error);
      }
    });
  }
}

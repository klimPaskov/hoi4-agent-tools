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
      'Search the offline wiki and installed game documentation by words or script names; each hit gives its file, lines, revision and answering line. Example: {"query":"add_timed_idea"}. Returns 6 hits by default (up to 12); read one with hoi4.reference_read using its id and revision.',
    inputSchema: referenceSearchRequestSchema,
    outputSchema: strictOperationResultSchema(referenceSearchDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.reference_read',
    title: 'Read cited HOI4 reference section',
    description:
      'Read one cited documentation section: pass the id and revision of a reference_search or reference_context hit. Example: {"id":"<hit id>","revision":"<hit revision>"}. Returns at most 80 lines (40 by default) and 8,000 bytes, with a line to continue from.',
    inputSchema: referenceReadRequestSchema,
    outputSchema: strictOperationResultSchema(referenceReadDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.reference_context',
    title: 'Get HOI4 task references',
    description:
      'Cited wiki and installed-documentation sections for one modding surface (event, decision, idea, focus, technology, gui, map, localisation, ai, general). Example: {"surface":"event","question":"fire an event after a delay"}. Returns up to 16 short sections; read more with hoi4.reference_read.',
    inputSchema: referenceContextRequestSchema,
    outputSchema: strictOperationResultSchema(referenceContextDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.source_lookup',
    title: 'Look up HOI4 source symbol',
    description:
      'Find where a script symbol is defined across game, DLC and mod, and where it is used; or pass path and line for the definition containing that line. Example: {"symbol":"my_scripted_effect"}. Returns up to 3 definitions with source text and 10 usages; keyPath and view=structure navigate nested blocks.',
    inputSchema: sourceLookupRequestSchema,
    outputSchema: strictOperationResultSchema(sourceLookupDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.script_validate',
    title: 'Check HOI4 script commands and scopes',
    description:
      'Check an effect or trigger snippet, or a whole mod file, against the installed documentation: syntax, command kinds and scopes. Unknown helpers and native argument blocks stay marked unresolved, never valid. Example: {"source":"add_political_power = 10","kind":"effect","scope":"country"} or {"path":"events/a.txt"}. Returns up to 12 findings.',
    inputSchema: scriptValidateRequestSchema,
    outputSchema: strictOperationResultSchema(scriptValidateDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.error_log',
    title: 'Read the game error log',
    description:
      'Group the game\'s logs/error.log from its last launch by category, with each entry\'s source file, line, layer and whether that file changed since; mod entries first. Example: {"scope":"mod","category":"effect"}. Returns at most 20 entries (limit 50) with fix hints and which entries are new since the previous launch.',
    inputSchema: errorLogRequestSchema,
    outputSchema: strictOperationResultSchema(errorLogDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.mod_index',
    title: 'Index mod definitions and free IDs',
    description:
      'overview: the mod descriptor, definition counts by kind, folders and event namespace ranges. next_id: the next free numbered ID for an event namespace or prefix across every layer. Example: {"mode":"next_id","kind":"event","namespace":"my_mod"}. Returns a compact summary; the first call indexes the mod, which takes seconds on a large one.',
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

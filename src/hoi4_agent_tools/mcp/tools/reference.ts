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
    title: 'Find a modding rule',
    description:
      'Find the right modding rule in the offline wiki and installed game docs using ordinary words or script names. Each hit includes its file, lines, revision and answering line. Example: {"query":"add_timed_idea"}. Returns 6 hits by default (up to 12); read one with hoi4.reference_read using its id and revision.',
    inputSchema: referenceSearchRequestSchema,
    outputSchema: strictOperationResultSchema(referenceSearchDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.reference_read',
    title: 'Read a modding rule',
    description:
      'Read a documentation section returned by reference_search or reference_context. Pass its id and revision. Example: {"id":"<hit id>","revision":"<hit revision>"}. Returns at most 80 lines (40 by default) and 8,000 bytes, with a line to continue from.',
    inputSchema: referenceReadRequestSchema,
    outputSchema: strictOperationResultSchema(referenceReadDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.reference_context',
    title: 'Find docs for a modding task',
    description:
      'Find documentation for the content you are building: events, decisions, ideas, focuses, technology, GUI, maps, localisation or AI. Example: {"surface":"event","question":"fire an event after a delay"}. Returns up to 16 short sections; read more with hoi4.reference_read.',
    inputSchema: referenceContextRequestSchema,
    outputSchema: strictOperationResultSchema(referenceContextDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.source_lookup',
    title: 'Find definitions and usages',
    description:
      'Find where a script symbol is defined and used across the game, DLC and mod. Pass a symbol, or a file path and line. Example: {"symbol":"my_scripted_effect"}. Returns up to 3 definitions with source text and 10 usages; keyPath and view=structure navigate nested blocks.',
    inputSchema: sourceLookupRequestSchema,
    outputSchema: strictOperationResultSchema(sourceLookupDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.script_validate',
    title: 'Check HOI4 script commands and scopes',
    description:
      'Find broken syntax, commands and scopes in an effect, trigger or mod file using the installed docs. Unknown helpers and native argument blocks stay unresolved. Example: {"source":"add_political_power = 10","kind":"effect","scope":"country"} or {"path":"events/a.txt"}. Returns up to 12 findings.',
    inputSchema: scriptValidateRequestSchema,
    outputSchema: strictOperationResultSchema(scriptValidateDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.error_log',
    title: 'Read the game error log',
    description:
      'Find errors from the last game launch and group them by category, with source files, lines and fix hints. Show which files changed since the log and which errors appeared after a relaunch; mod entries come first. Example: {"scope":"mod","category":"effect"}. Returns at most 20 entries (limit 50) with fix hints and which entries are new since the previous launch.',
    inputSchema: errorLogRequestSchema,
    outputSchema: strictOperationResultSchema(errorLogDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.mod_index',
    title: 'Explore mod content and find free IDs',
    description:
      'Summarize the content in a mod or find a free event ID across the mod, game and dependencies. Use overview for descriptors, folders and definitions, or next_id with a namespace or prefix. Example: {"mode":"next_id","kind":"event","namespace":"my_mod"}. Returns a compact summary; the first call indexes the mod, which takes seconds on a large one.',
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

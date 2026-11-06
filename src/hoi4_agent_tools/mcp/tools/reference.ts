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
  referenceContextToolDataSchema,
  referenceReadDataSchema,
  referenceSearchToolDataSchema,
  sourceLookupDataSchema,
} from '../../schemas/reference.js';
import type { ToolDefinition } from '../server/task-tool-definition.js';
import {
  localisationInspectDataSchema,
  localisationInspectRequestSchema,
} from '../../schemas/localisation.js';
import {
  systemInspectDataSchema,
  systemInspectRequestSchema,
  unitInspectDataSchema,
  unitInspectRequestSchema,
  assetInspectDataSchema,
  assetInspectRequestSchema,
} from '../../schemas/system.js';
import { ideaInspectDataSchema, ideaInspectRequestSchema } from '../../schemas/ideas.js';
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
    outputSchema: strictOperationResultSchema(referenceSearchToolDataSchema),
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
    outputSchema: strictOperationResultSchema(referenceContextToolDataSchema),
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
  {
    name: 'hoi4.localisation_inspect',
    title: 'Check localisation in every language',
    description:
      'Read localisation in every language the game and mod ship. key: one key per language with file, line and layer, the languages lacking it and the files mentioning it. audit: keys the mod uses that no language defines, keys missing from a supported language, keys defined twice in one language, and file problems. coverage: keys per language. Example: {"mode":"key","key":"my_event.1.t"} or {"mode":"audit"}. Returns counts per problem and a few examples of each.',
    inputSchema: localisationInspectRequestSchema,
    outputSchema: strictOperationResultSchema(localisationInspectDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.idea_inspect',
    title: 'Inspect ideas and characters',
    description:
      'Read an idea or character across the game, DLC and mod. idea: category, picture sprite and texture, modifiers checked against the game docs, conditions, name in every language, the advisor it belongs to, and files mentioning it. character: name, roles with traits checked, portraits checked. audit: true checks every idea or character of the mod. Example: {"kind":"idea","id":"GER_mefo_bills_1"} or {"kind":"character","audit":true}.',
    inputSchema: ideaInspectRequestSchema,
    outputSchema: strictOperationResultSchema(ideaInspectDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.system_inspect',
    title: 'Check newer game systems',
    description:
      'Read one definition of a newer system, or audit every one the mod makes: on_actions hooks, MIOs and policies, balance of power, special projects, operations and raids. Returns its parts, each reference with whether it exists, pictures, names in every language and problems. Example: {"kind":"mio","id":"my_organization"} or {"kind":"on_actions","audit":true}.',
    inputSchema: systemInspectRequestSchema,
    outputSchema: strictOperationResultSchema(systemInspectDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.unit_inspect',
    title: 'Check units and equipment',
    description:
      'Read one order of battle (history/units), sub-unit, equipment or module, or equipment variant, or audit every one the mod makes. Checks template grids, divisions, fleets, air wings, equipment slots and modules, and each name they use. Example: {"kind":"oob","id":"GER_1936"} or {"kind":"variant","audit":true}.',
    inputSchema: unitInspectRequestSchema,
    outputSchema: strictOperationResultSchema(unitInspectDataSchema),
    annotations: readOnly,
  },
  {
    name: 'hoi4.asset_inspect',
    title: 'Check sprites, sounds and flags',
    description:
      'Read one sprite (texture size, format and frames), sound, sound effect or music track (audio file, sounds it plays), or flag (all three sizes), or audit every one the mod defines. Flags BC7 textures, missing files and wrong flag sizes. Example: {"kind":"sprite","id":"GFX_my_icon"} or {"kind":"flag","audit":true}.',
    inputSchema: assetInspectRequestSchema,
    outputSchema: strictOperationResultSchema(assetInspectDataSchema),
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

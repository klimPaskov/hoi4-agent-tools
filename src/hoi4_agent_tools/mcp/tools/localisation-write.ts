import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoreEngine } from '../../core/engine.js';
import { strictOperationResultSchema } from '../server/result.js';
import {
  localisationWriteDataSchema,
  localisationWriteRequestSchema,
} from '../../schemas/localisation-write.js';
import type { ServerContext } from '../server/base-tools.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

export const localisationTaskTools = [
  {
    name: 'hoi4.localisation_write',
    title: 'Add or fix localisation',
    description:
      'Add localisation keys (mode add: key and text; language, file, replace) or repair localisation files (mode fix: BOM, broken quotes, keys missing from supported languages). Game keys are overridden from a replace folder. apply false returns the diff and writes nothing; apply true writes it. Returns up to 10 files with diffs. Example: {"mode":"add","entries":[{"key":"my_focus","text":"My focus"}]}',
    inputSchema: localisationWriteRequestSchema,
    outputSchema: strictOperationResultSchema(localisationWriteDataSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerLocalisationWriteTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, localisationTaskTools);
}

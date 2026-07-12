import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { operationResultSchema } from '../src/hoi4_agent_tools/mcp/server/result.js';
import {
  GuiAnimationSourceManifestSchema,
  GuiHelperDocumentSchema,
  GuiPreviewScenarioSchema,
} from '../src/hoi4_agent_tools/gui/index.js';
import {
  continuousFocusPaletteSchema,
  focusPlanningSidecarSchema,
  focusTreePlanSchema,
} from '../src/hoi4_agent_tools/schemas/focus.js';
import { mapOperationSchema } from '../src/hoi4_agent_tools/schemas/map.js';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'schemas');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
};
await mkdir(output, { recursive: true });

const schemas: (readonly [string, z.ZodType])[] = [
  ['configuration.schema.json', serverConfigurationSchema],
  ['focus-plan.schema.json', focusTreePlanSchema],
  ['focus-planning-sidecar.schema.json', focusPlanningSidecarSchema],
  ['continuous-focus-palette.schema.json', continuousFocusPaletteSchema],
  ['gui-helper.schema.json', GuiHelperDocumentSchema],
  ['gui-animation-source.schema.json', GuiAnimationSourceManifestSchema],
  ['gui-scenario.schema.json', GuiPreviewScenarioSchema],
  ['map-operation.schema.json', mapOperationSchema],
  ['operation-result.schema.json', operationResultSchema],
];

for (const [name, schema] of schemas) {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  });
  await writeFile(
    path.join(output, name),
    `${JSON.stringify(
      {
        $id: `https://github.com/klimPaskov/hoi4-agent-tools/blob/v${packageJson.version}/schemas/${name}`,
        ...jsonSchema,
      },
      null,
      2,
    )}\n`,
  );
}

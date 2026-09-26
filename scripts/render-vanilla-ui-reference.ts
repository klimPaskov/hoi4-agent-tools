import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { sha256Bytes } from '../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { parsePreviewScenario, ScriptedGuiStudio } from '../src/hoi4_agent_tools/gui/index.js';
import { PACKAGE_VERSION } from '../src/hoi4_agent_tools/version.js';

const [gameRoot, windowName, scenarioPath, output, modRoot] = process.argv.slice(2);
if (
  gameRoot === undefined ||
  windowName === undefined ||
  scenarioPath === undefined ||
  output === undefined
) {
  throw new Error(
    'Usage: tsx scripts/render-vanilla-ui-reference.ts GAME_ROOT WINDOW SCENARIO_JSON OUTPUT_DIRECTORY [MOD_ROOT]',
  );
}
const runtime = await mkdtemp(path.join(tmpdir(), 'hoi4-native-reference-'));
try {
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(runtime, 'state'),
    storageRoots: [path.join(runtime, 'output')],
    workspaces: [
      {
        id: 'vanilla',
        name: modRoot === undefined ? 'Installed vanilla reference' : 'Mod source reference',
        kind: modRoot === undefined ? 'game' : 'mod',
        root: modRoot ?? gameRoot,
        ...(modRoot === undefined ? {} : { gameRoot }),
        artifactRoot: path.join(runtime, 'output', 'artifacts'),
        cacheRoot: path.join(runtime, 'output', 'cache'),
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  const scenario = parsePreviewScenario(JSON.parse(await readFile(scenarioPath, 'utf8')));
  const result = await new ScriptedGuiStudio(engine).renderAndStore({
    workspaceId: 'vanilla',
    windowName,
    scenario,
    states: ['normal'],
    resolutions: [{ ...scenario.resolution, uiScale: scenario.uiScale }],
    generatedScenarios: { enabled: false },
  });
  await mkdir(output, { recursive: true });
  const images = [];
  for (const image of result.render.images) {
    const filename = `${windowName}-${image.variant}.png`;
    await writeFile(path.join(output, filename), image.png);
    images.push({
      filename,
      width: image.width,
      height: image.height,
      sha256: sha256Bytes(image.png),
    });
  }
  const full = result.render.images.find(({ variant }) => variant === 'full')!;
  const bounds = result.render.scene.bounds;
  const left = Math.max(0, Math.floor(bounds.x));
  const top = Math.max(0, Math.floor(bounds.y));
  const width = Math.min(full.width - left, Math.ceil(bounds.x + bounds.width) - left);
  const height = Math.min(full.height - top, Math.ceil(bounds.y + bounds.height) - top);
  const windowBytes = await sharp(full.png).extract({ left, top, width, height }).png().toBuffer();
  const windowFile = `${windowName}-window.png`;
  await writeFile(path.join(output, windowFile), windowBytes);
  images.push({ filename: windowFile, width, height, sha256: sha256Bytes(windowBytes) });
  const rendererImplementation = sha256Bytes(
    Buffer.concat(
      await Promise.all(
        ['layout.ts', 'studio.ts', 'source-graph.ts', 'renderer.ts'].map((name) =>
          readFile(path.resolve(import.meta.dirname, '..', 'src/hoi4_agent_tools/gui', name)),
        ),
      ),
    ),
  );
  const manifest = {
    toolVersion: PACKAGE_VERSION,
    rendererImplementation,
    windowName,
    offline: true,
    sourceRevision: result.render.scene.sourceRevision,
    scenario: result.render.scene.scenario,
    bounds: result.render.scene.bounds,
    images,
    diagnostics: result.validation.diagnostics,
    fidelity: result.render.scene.fidelity,
    controls: result.render.scene.elements.map(
      ({ name, rect, visible, clickable, disabledReason, text }) => ({
        name,
        rect,
        visible,
        clickable,
        disabledReason,
        text: text?.text,
      }),
    ),
  };
  await writeFile(
    path.join(output, `${windowName}-manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ windowName, sourceRevision: manifest.sourceRevision, bounds: manifest.bounds, images, diagnostics: manifest.diagnostics.length })}\n`,
  );
} finally {
  await rm(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

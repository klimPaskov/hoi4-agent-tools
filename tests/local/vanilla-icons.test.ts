import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { TechnologyTreeViewer } from '../../src/hoi4_agent_tools/technology/index.js';

const gameRoot = process.env.HOI4_GAME_ROOT;
const enabled = gameRoot !== undefined && gameRoot.length > 0;
let temporaryRoot: string | undefined;
let viewer: TechnologyTreeViewer;

beforeAll(async () => {
  if (!enabled) return;
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-vanilla-icon-render-'));
  const modRoot = path.join(temporaryRoot, 'mod');
  await mkdir(modRoot);
  await writeFile(path.join(modRoot, 'descriptor.mod'), 'name="Vanilla icon fixture"\n');
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    gameRoot,
    serverStateRoot: path.join(temporaryRoot, 'server-state'),
    workspaceStorageRoot: path.join(temporaryRoot, 'storage'),
    workspaces: [{ id: 'vanilla-icons', name: 'Vanilla icons', root: modRoot, kind: 'mod' }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  viewer = new TechnologyTreeViewer(engine);
});

afterAll(async () => {
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('installed vanilla icon rendering', () => {
  it('decodes and embeds an installed-game technology DDS without copying it', async () => {
    const graph = await viewer.scan('vanilla-icons', { refresh: true });
    expect(graph.technologies.find(({ id }) => id === 'infantry_weapons2')?.icon).toMatchObject({
      sprite: 'GFX_infantry_weapons2_medium',
      status: 'resolved',
      spritePath: 'game:interface/Technologies.gfx',
      texturePath: 'gfx/interface/technologies/infantry_weapons.dds',
    });
    const rendered = await viewer.renderAndStore({
      workspaceId: 'vanilla-icons',
      view: 'technology',
      technologyId: 'infantry_weapons2',
      maxNodes: 64,
    });
    expect(rendered.render.renderedIconCount).toBeGreaterThan(0);
    expect(rendered.render.svg).toContain('data-icon-sprite="GFX_infantry_weapons2_medium"');
    expect(rendered.render.svg).toContain('href="data:image/png;base64,');
  }, 600_000);
});

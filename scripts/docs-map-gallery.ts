/**
 * Builds the map gallery of the documentation from a synthetic, project-owned geography model: a
 * temporary mod, one `create_world` write with workspace countries, and the offline renders of
 * the result. Nothing here uses a third-party mod or the game's artwork, and the renders are
 * tool-generated evidence, never game screenshots.
 *
 *   npx tsx scripts/docs-map-gallery.ts <server stdio.js> <game root> <output folder>
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [server, gameRoot, outputFolder] = process.argv.slice(2) as [string?, string?, string?];
if (server === undefined || gameRoot === undefined || outputFolder === undefined)
  throw new Error('usage: docs-map-gallery.ts <server stdio.js> <game root> <output folder>');

interface Result {
  status: string;
  code: string;
  artifacts: Array<{ name: string; uri: string; mimeType: string }>;
  blockers?: unknown;
  data?: { synthesisCheck?: unknown };
}

const WIDTH = 2048;
const HEIGHT = 1024;
const box = (l: number, t: number, r: number, b: number) => [
  [l, t],
  [r, t],
  [r, b],
  [l, b],
];

/** Two lands split by a gulf, a wall with a gate, a volcano and three rivers, one through a cone. */
const geography = {
  version: 1,
  name: 'Documentation world',
  seas: [
    { id: 'ocean', name: 'The Wide Ocean', depthClass: 'abyss', polygons: [box(0, 0, 1, 1)] },
    { id: 'gulf', name: 'The Gulf', kind: 'gulf', polygons: [box(0.46, 0.56, 0.56, 0.66)] },
  ],
  lands: [
    {
      id: 'north',
      name: 'North Land',
      kind: 'continent',
      polygons: [
        [
          [0.12, 0.22],
          [0.45, 0.14],
          [0.82, 0.2],
          [0.88, 0.5],
          [0.7, 0.62],
          [0.56, 0.56],
          [0.46, 0.56],
          [0.3, 0.64],
          [0.14, 0.52],
        ],
      ],
    },
    {
      id: 'south',
      name: 'South Land',
      kind: 'continent',
      polygons: [
        [
          [0.2, 0.74],
          [0.46, 0.66],
          [0.56, 0.66],
          [0.8, 0.7],
          [0.84, 0.86],
          [0.5, 0.9],
          [0.22, 0.88],
        ],
      ],
    },
  ],
  ranges: [
    {
      id: 'wall',
      name: 'The Wall',
      profile: 'wall',
      barrier: 'impassable',
      path: [
        [0.5, 0.18],
        [0.5, 0.4],
        [0.52, 0.54],
      ],
      halfWidth: 0.008,
      peak: 0.9,
    },
    {
      id: 'ridge',
      name: 'Eastern Ridge',
      path: [
        [0.68, 0.3],
        [0.74, 0.42],
        [0.78, 0.52],
      ],
      halfWidth: 0.008,
      peak: 0.8,
    },
  ],
  passes: [{ id: 'gate', name: 'The Gate', range: 'wall', position: [0.5, 0.3], fort: 1 }],
  volcanoes: [{ id: 'cone', name: 'Mount Ember', at: [0.74, 0.36], peak: 0.9 }],
  rivers: [
    // Crosses the Eastern Ridge and the cone: its valley is carved through them.
    {
      id: 'long_river',
      name: 'The Long River',
      source: [0.84, 0.44],
      mouth: { sea: 'ocean' },
      size: 3,
    },
    { id: 'west_water', name: 'West Water', source: [0.2, 0.32], mouth: { sea: 'ocean' }, size: 2 },
    { id: 'south_run', name: 'South Run', source: [0.6, 0.8], mouth: { sea: 'ocean' }, size: 2 },
  ],
  straits: [
    {
      id: 'gulf_mouth',
      name: 'The Narrows',
      between: [
        [0.5, 0.5],
        [0.5, 0.78],
      ],
    },
  ],
};

const realms = [
  { tag: 'DAA', capital: { x: 400, y: 330 }, weight: 1.5 },
  { tag: 'DBB', capital: { x: 1300, y: 330 }, weight: 1 },
  { tag: 'DCC', capital: { x: 760, y: 840 }, weight: 1 },
  { tag: 'DDD', capital: { x: 1500, y: 800 }, weight: 1 },
];

const root = await mkdtemp(path.join(tmpdir(), 'hoi4-docs-gallery-'));
try {
  const mods = path.join(root, 'mods');
  const mod = path.join(mods, 'docs_world');
  await mkdir(path.join(mod, 'common', 'country_tags'), { recursive: true });
  await mkdir(path.join(mod, 'geography'), { recursive: true });
  await writeFile(
    path.join(mod, 'descriptor.mod'),
    'name="Documentation world"\nversion="1.0"\nsupported_version="*"\n',
  );
  await writeFile(
    path.join(mod, 'common', 'country_tags', '00_docs_countries.txt'),
    realms.map(({ tag }) => `${tag} = "countries/${tag}.txt"`).join('\n') + '\n',
  );
  await writeFile(path.join(mod, 'geography', 'world.json'), JSON.stringify(geography, null, 2));
  const config = path.join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      modRoots: [mods],
      gameRoot,
      workspaceStorageRoot: path.join(root, 'workspaces'),
    }),
  );
  const client = new Client({ name: 'docs-gallery', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, HOI4_AGENT_CONFIG: config },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>, timeout = 1_500_000) =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout }))
      .structuredContent as Result;
  const workspaceId = 'docs_world';
  await mkdir(outputFolder, { recursive: true });
  const save = async (result: Result, artifactName: string, fileName: string) => {
    const artifact = result.artifacts.find(({ name }) => name === artifactName);
    if (artifact === undefined)
      throw new Error(
        `${artifactName} missing in ${result.artifacts.map(({ name }) => name).join(', ')}`,
      );
    const resource = await client.readResource({ uri: artifact.uri });
    const content = resource.contents[0] as { blob: string };
    await writeFile(path.join(outputFolder, fileName), Buffer.from(content.blob, 'base64'));
    console.log('saved', fileName);
  };

  const world = {
    id: 'world',
    kind: 'create_world',
    width: WIDTH,
    height: HEIGHT,
    seed: 11,
    geographyPath: 'geography/world.json',
    edge: { mode: 'sea-band' },
    landProvincePixels: 1800,
    seaProvincePixels: 12000,
    countries: { source: 'workspace', realms, islands: 'nearest' },
  };

  // Before: the model, drawn as its overlay (no map is written).
  const preview = await call('hoi4.map_rewrite', {
    workspaceId,
    preview: true,
    operations: [world],
  });
  console.log('preview', preview.status, preview.code);
  await save(preview, 'map-geography-overlay.png', 'model-overlay.png');

  // The river check: what the synthesis would carve, without a write.
  const check = await call('hoi4.map_rewrite', {
    workspaceId,
    preview: true,
    operations: [{ ...world, synthesisCheck: true }],
  });
  console.log(
    'check',
    check.status,
    check.code,
    JSON.stringify(check.data?.synthesisCheck ?? {}).slice(0, 600),
  );

  // After: the written world.
  const written = await call('hoi4.map_rewrite', { workspaceId, operations: [world] });
  console.log('write', written.status, written.code);
  if (written.status !== 'ok')
    throw new Error(JSON.stringify(written.blockers ?? written).slice(0, 1500));
  const views: Array<[string, string[], string]> = [
    ['province', ['coastlines'], 'world-provinces.png'],
    ['state', ['victory-points'], 'world-states.png'],
    ['owner', ['coastlines'], 'world-owners.png'],
    ['terrain', ['coastlines', 'adjacencies', 'ports'], 'world-terrain-crossings.png'],
  ];
  for (const [layer, overlays, fileName] of views) {
    const view = await call('hoi4.map_inspect', {
      workspaceId,
      layer,
      ...(overlays.length === 0 ? {} : { overlays }),
      scale: 1,
    });
    const png = view.artifacts.find(({ mimeType }) => mimeType === 'image/png');
    if (png === undefined) {
      console.log(
        layer,
        'no png',
        view.status,
        view.code,
        JSON.stringify(view.blockers ?? '').slice(0, 300),
      );
      continue;
    }
    await save(view, png.name, fileName);
  }
  await client.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

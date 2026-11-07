import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { BmpImage, createBmp } from '../../src/hoi4_agent_tools/map/bmp.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import {
  planMapOperations,
  type CreateWorldOperation,
} from '../../src/hoi4_agent_tools/map/operations.js';
import { REFERENCE_TERRAIN } from '../../src/hoi4_agent_tools/map/reference-world.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { resolveEdge } from '../../src/hoi4_agent_tools/map/world-edge.js';
import {
  generateWorld,
  type GeneratedWorld,
  type WorldContext,
} from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import {
  filesOf,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';

/** Province ids by pixel, the continent of each province, and each province's mean x. */
function readWorld(world: GeneratedWorld) {
  const files = filesOf(world);
  const byColor = new Map<string, number>();
  const continentOf = new Map<number, number>();
  for (const line of files.get('map/definition.csv')!.toString().trim().split(/\r?\n/u)) {
    const cells = line.split(';');
    byColor.set(`${cells[1]},${cells[2]},${cells[3]}`, Number(cells[0]));
    continentOf.set(Number(cells[0]), Number(cells[7]));
  }
  const bitmap = BmpImage.decode(files.get('map/provinces.bmp')!);
  const sums = new Map<number, { x: number; n: number }>();
  for (let y = 0; y < bitmap.height; y += 1)
    for (let x = 0; x < bitmap.width; x += 1) {
      const { r, g, b } = bitmap.rgbAt(x, y);
      const id = byColor.get(`${r},${g},${b}`)!;
      const sum = sums.get(id) ?? { x: 0, n: 0 };
      sum.x += x;
      sum.n += 1;
      sums.set(id, sum);
    }
  const provinceAt = (x: number, y: number) => {
    const { r, g, b } = bitmap.rgbAt(x, y);
    return byColor.get(`${r},${g},${b}`)!;
  };
  const meanX = (id: number) => sums.get(id)!.x / sums.get(id)!.n;
  const groups = (prefix: string) =>
    [...files]
      .filter(([file]) => file.startsWith(prefix))
      .map(([, content]) => {
        const block = /provinces\s*=\s*\{([^}]*)\}/u.exec(content.toString());
        return (block?.[1] ?? '').trim().split(/\s+/u).filter(Boolean).map(Number);
      })
      .filter((ids) => ids.length > 0);
  return { files, continentOf, provinceAt, meanX, groups };
}

describe('continents of a world with impassable land', () => {
  const width = 256;
  const height = 256;
  // Two landmasses, each running into the wall at its own edge, with open sea between them.
  const surface = syntheticRaster(width, height, {
    at: (x, y) => ((x < 110 || x > 146) && y > 40 && y < 216 ? 1 : 0),
  });
  const edge = resolveEdge({ mode: 'wall', rimPx: 48, polarPx: 0 }, width, height);
  const world = generateWorld(worldSpec(surface, { edge, continents: 2 }), plainContext);
  const { files, continentOf, provinceAt, meanX, groups } = readWorld(world);

  it('gives the east and west landmasses separate continents across the wall', () => {
    const west = continentOf.get(provinceAt(80, 128))!;
    const east = continentOf.get(provinceAt(176, 128))!;
    expect(west).toBeGreaterThan(0);
    expect(east).toBeGreaterThan(0);
    expect(west).not.toBe(east);
    expect(files.get('map/continent.txt')!.toString()).toBe(
      'continents = {\n\tworld_continent_1\n\tworld_continent_2\n}\n',
    );
  });

  it('gives every wall province the continent of the land on its own side', () => {
    const west = continentOf.get(provinceAt(80, 128))!;
    const east = continentOf.get(provinceAt(176, 128))!;
    for (let y = 0; y < height; y += 8) {
      expect(continentOf.get(provinceAt(0, y))).toBe(west);
      expect(continentOf.get(provinceAt(width - 1, y))).toBe(east);
    }
  });

  it('keeps every strategic region and state on one side of the seam', () => {
    const regions = groups('map/strategicregions/');
    const states = groups('history/states/');
    expect(regions.length).toBeGreaterThan(1);
    expect(states.length).toBeGreaterThan(1);
    for (const members of [...regions, ...states]) {
      const land = members.filter((id) => continentOf.get(id)! > 0);
      if (land.length === 0) continue;
      const sides = new Set(land.map((id) => meanX(id) < width / 2));
      expect(sides.size).toBe(1);
    }
  });

  it('splits one landmass that only an impassable strip joins', () => {
    // One block of land cut in two by a full-height impassable strip, no wall.
    const strip = (x: number) => x >= 108 && x < 148;
    const picture = syntheticRaster(width, height, {
      at: (x, y) => (x > 40 && x < 216 && y > 40 && y < 216 ? 1 : 0),
      terrain: (x) => (strip(x) ? REFERENCE_TERRAIN.mountain : 0),
    });
    picture.impassable = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) if (strip(x)) picture.impassable[y * width + x] = 1;
    const split = readWorld(generateWorld(worldSpec(picture, { continents: 2 }), plainContext));
    const west = split.continentOf.get(split.provinceAt(70, 128))!;
    const east = split.continentOf.get(split.provinceAt(186, 128))!;
    expect(west).not.toBe(east);
    expect([west, east]).toContain(split.continentOf.get(split.provinceAt(128, 128)));
  });

  it('keeps land joined around an impassable massif as one continent', () => {
    // Negative case: the massif does not reach the coast, so the land around it is connected.
    const massif = (x: number, y: number) => x >= 110 && x < 150 && y >= 80 && y < 180;
    const picture = syntheticRaster(width, height, {
      at: (x, y) => (x > 30 && x < 226 && y > 30 && y < 226 ? 1 : 0),
      terrain: (x, y) => (massif(x, y) ? REFERENCE_TERRAIN.mountain : 0),
    });
    picture.impassable = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) if (massif(x, y)) picture.impassable[y * width + x] = 1;
    const whole = readWorld(generateWorld(worldSpec(picture, { continents: 2 }), plainContext));
    expect(whole.files.get('map/continent.txt')!.toString()).toBe(
      'continents = {\n\tworld_continent_1\n}\n',
    );
    for (const [x, y] of [
      [60, 128],
      [200, 128],
      [130, 130],
    ] as const)
      expect(whole.continentOf.get(whole.provinceAt(x, y))).toBe(1);
  });
});

describe('inherited continents', () => {
  const surface = syntheticRaster(256, 256, {
    at: (x, y) => (x > 60 && x < 196 && y > 60 && y < 196 ? 1 : 0),
  });
  const context: WorldContext = { ...plainContext, continentKeys: ['africa', 'europe'] };

  it('keeps the active continents by default and with keep', () => {
    for (const inheritedContinents of [undefined, 'keep'] as const) {
      const world = generateWorld(
        worldSpec(surface, inheritedContinents === undefined ? {} : { inheritedContinents }),
        context,
      );
      expect(filesOf(world).get('map/continent.txt')!.toString()).toBe(
        'continents = {\n\tworld_continent_1\n\tafrica\n\teurope\n}\n',
      );
      expect(world.droppedContinents).toBeUndefined();
    }
  });

  it('writes only the generated continents with drop', () => {
    const world = generateWorld(worldSpec(surface, { inheritedContinents: 'drop' }), context);
    expect(filesOf(world).get('map/continent.txt')!.toString()).toBe(
      'continents = {\n\tworld_continent_1\n}\n',
    );
    expect(world.droppedContinents).toEqual(['africa', 'europe']);
  });

  it('accepts keep and drop in the schema and refuses anything else', () => {
    const parse = (inheritedContinents: unknown) =>
      mapOperationSchema.safeParse({ kind: 'create_world', id: 'w', inheritedContinents }).success;
    expect(parse('keep')).toBe(true);
    expect(parse('drop')).toBe(true);
    expect(parse('remove')).toBe(false);
    expect(parse(true)).toBe(false);
  });
});

describe('scripts that name a dropped continent', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  async function workspace(): Promise<AgentNudger> {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-continents-'));
    roots.push(base);
    const mod = path.join(base, 'mod');
    const game = path.join(base, 'game');
    const put = async (root: string, file: string, text: string) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    };
    await mkdir(mod);
    await put(
      game,
      'map/default.map',
      'definitions = "definition.csv"\nprovinces = "provinces.bmp"\n',
    );
    await put(
      game,
      'map/definition.csv',
      '0;0;0;0;sea;false;ocean;0\n1;0;0;200;sea;false;ocean;0\n',
    );
    await mkdir(path.join(game, 'map'), { recursive: true });
    await writeFile(
      path.join(game, 'map/provinces.bmp'),
      createBmp({
        width: 256,
        height: 256,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: 256 * 256 }, () => ({ r: 0, g: 0, b: 200 })),
      }),
    );
    await put(game, 'map/continent.txt', 'continents = {\n\teurope\n\tafrica\n}\n');
    await put(
      game,
      'common/scripted_triggers/probe_triggers.txt',
      'probe_in_europe = {\n\tcapital_scope = { is_on_continent = europe }\n}\n',
    );
    await put(
      game,
      'common/ai_areas/default.txt',
      'areas = {\n\tafrica = {\n\t\tcontinents = { africa }\n\t}\n}\n',
    );
    await put(
      game,
      'portraits/00_portraits.txt',
      'continent = {\n\tname = europe\n\tarmy = { male = { } }\n}\n',
    );
    // A mod event: the state set of any_state_in, plus names that are not dropped continents.
    await put(
      mod,
      'events/probe.txt',
      [
        'country_event = {',
        '\tid = probe.1',
        '\ttrigger = {',
        '\t\tany_state_in = { continent = africa }',
        '\t\tcapital_scope = { is_on_continent = world_continent_1 }',
        '\t}',
        '\tai_chance = { area = europe }',
        '}',
        '',
      ].join('\n'),
    );
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'state'),
        workspaces: [
          { id: 'probe', name: 'Probe', root: mod, gameRoot: game, includeGameDlc: false },
        ],
      }),
    );
    return new AgentNudger(resolver);
  }

  const createWorld = (inheritedContinents?: 'keep' | 'drop') => ({
    id: 'world',
    kind: 'create_world' as const,
    width: 256,
    height: 256,
    seed: 2,
    rivers: 0,
    continents: 1,
    countries: [{ tag: 'AAA', name: 'Aster' }],
    ...(inheritedContinents === undefined ? {} : { inheritedContinents }),
  });

  it('warns about each script reference to a dropped continent, by file and line', async () => {
    const nudger = await workspace();
    const preview = await nudger.previewRewriteWithDiff({
      workspaceId: 'probe',
      operations: [createWorld('drop')],
    });
    expect(preview.plan.blockers).toEqual([]);
    const continentFile = preview.plan.changes.find(
      ({ relativePath }) => relativePath === 'map/continent.txt',
    );
    expect(Buffer.from(continentFile!.content!).toString()).toBe(
      'continents = {\n\tworld_continent_1\n}\n',
    );
    const warnings = preview.plan.diagnostics
      .filter(({ code }) => code === 'MAP_CONTINENT_DROPPED_REFERENCED')
      .map(({ severity, location, details }) => ({
        severity,
        path: location?.path,
        line: location?.start.line,
        continent: details?.continent,
        kind: details?.kind,
      }))
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));
    expect(warnings).toEqual([
      {
        severity: 'warning',
        path: 'game:common/ai_areas/default.txt',
        line: 3,
        continent: 'africa',
        kind: 'ai_area',
      },
      {
        severity: 'warning',
        path: 'game:common/scripted_triggers/probe_triggers.txt',
        line: 2,
        continent: 'europe',
        kind: 'is_on_continent',
      },
      {
        severity: 'warning',
        path: 'game:portraits/00_portraits.txt',
        line: 2,
        continent: 'europe',
        kind: 'portrait',
      },
      {
        severity: 'warning',
        path: 'mod:events/probe.txt',
        line: 4,
        continent: 'africa',
        kind: 'continent',
      },
    ]);
    expect(
      preview.plan.diagnostics.find(({ code }) => code === 'MAP_CONTINENTS_DROPPED'),
    ).toMatchObject({ details: { dropped: ['africa', 'europe'], references: 4 } });
  });

  it('keeps the inherited continents and reports nothing without drop', async () => {
    const nudger = await workspace();
    const preview = await nudger.previewRewriteWithDiff({
      workspaceId: 'probe',
      operations: [createWorld()],
    });
    const continentFile = preview.plan.changes.find(
      ({ relativePath }) => relativePath === 'map/continent.txt',
    );
    expect(Buffer.from(continentFile!.content!).toString()).toBe(
      'continents = {\n\tworld_continent_1\n\tafrica\n\teurope\n}\n',
    );
    expect(preview.plan.diagnostics.filter(({ code }) => code.startsWith('MAP_CONTINENT'))).toEqual(
      [],
    );
    expect(preview.filesScanned).not.toContain('game:common/scripted_triggers/probe_triggers.txt');
  });
});

describe('countries of a wall world', () => {
  const tags = Buffer.from('AAA = "countries/AAA.txt"\nBBB = "countries/BBB.txt"\n');
  const tagFile: ScannedFile = {
    relativePath: 'common/country_tags/00_realms.txt',
    absolutePath: '/synthetic/common/country_tags/00_realms.txt',
    displayPath: 'mod:common/country_tags/00_realms.txt',
    rootKind: 'mod',
    loadOrder: 1,
    modifiedMs: 0,
    size: tags.length,
    bytes: tags,
    sha256: sha256Bytes(tags),
  };
  const box = (left: number, top: number, right: number, bottom: number) => [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  // Two landmasses, each running into the wall at its own edge of the map.
  const world = (
    countries: NonNullable<CreateWorldOperation['countries']>,
  ): CreateWorldOperation => ({
    id: 'world',
    kind: 'create_world',
    width: 512,
    height: 256,
    seed: 3,
    rivers: 0,
    landPolygons: [box(4, 72, 200, 184), box(312, 72, 508, 184)],
    provincesPerState: 4,
    edge: { mode: 'wall' },
    countries,
  });
  const plan = (operation: CreateWorldOperation) => {
    const result = planMapOperations(MapWorkspaceIndex.build([tagFile]), [operation]);
    expect(result.blockers).toEqual([]);
    return result;
  };
  const ownersOf = (result: ReturnType<typeof plan>, x0: number, x1: number) => {
    const index = result.finalIndex;
    const raster = index.raster!;
    const owners = new Set<string>();
    for (let y = 88; y <= 168; y += 8)
      for (let x = x0; x <= x1; x += 8) {
        const province = raster.provinceIds[y * raster.width + x]!;
        owners.add(index.stateForProvince(province)[0]?.owner ?? '-');
      }
    return owners;
  };

  it('keeps a realm seeded on the east edge off the land at the west edge', () => {
    const result = plan(
      world({
        source: 'workspace',
        realms: [{ tag: 'AAA', capital: { x: 440, y: 128 } }],
        islands: 'unowned',
      }),
    );
    expect(ownersOf(result, 336, 480)).toEqual(new Set(['AAA']));
    // The west landmass is reached only over the wall across the seam, so nobody grows into it.
    expect(ownersOf(result, 64, 192)).toEqual(new Set(['-']));
  });

  it('grows each realm on its own side and gives the wall to the realm beside it', () => {
    const result = plan(
      world({
        source: 'workspace',
        realms: [
          { tag: 'AAA', capital: { x: 440, y: 128 }, weight: 20 },
          { tag: 'BBB', capital: { x: 120, y: 128 } },
        ],
      }),
    );
    expect(ownersOf(result, 336, 480)).toEqual(new Set(['AAA']));
    expect(ownersOf(result, 64, 192)).toEqual(new Set(['BBB']));
    const index = result.finalIndex;
    const walls = index.states.filter((state) =>
      Buffer.from(state.file.bytes).toString().includes('\timpassable = yes'),
    );
    expect(walls.length).toBeGreaterThan(0);
    for (const state of walls) {
      const link = /force_link_ownership_to = (\d+)/u.exec(
        Buffer.from(state.file.bytes).toString(),
      );
      expect(link).not.toBeNull();
      expect(state.owner).toBe(index.statesById.get(Number(link![1]))!.owner);
    }
  });
});

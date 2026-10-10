import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import {
  indexWithProposedChanges,
  planMapOperations,
  type MapOperation,
} from '../../src/hoi4_agent_tools/map/operations.js';
import {
  collectMapScriptReferences,
  missingMapReferenceDiagnostics,
} from '../../src/hoi4_agent_tools/map/references.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const colors: Record<number, RgbColor> = {
  1: { r: 10, g: 0, b: 0 },
  2: { r: 0, g: 0, b: 200 },
  3: { r: 0, g: 160, b: 220 },
  4: { r: 0, g: 180, b: 0 },
};

/** Four vertical strips: land 1, land 4, land 2 (coastal), sea 3. */
function provinces(): Buffer {
  const pixels: RgbColor[] = [];
  for (let y = 0; y < 256; y += 1)
    for (let x = 0; x < 256; x += 1)
      pixels.push(colors[x < 64 ? 1 : x < 128 ? 4 : x < 192 ? 2 : 3]!);
  return createBmp({ width: 256, height: 256, bitsPerPixel: 24, rgbPixels: pixels });
}

async function workspace(
  mod: Record<string, string | Buffer>,
  game: Record<string, string | Buffer> = {},
) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-map-derived-'));
  roots.push(base);
  const write = async (root: string, files: Record<string, string | Buffer>) => {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(base, root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  };
  await mkdir(path.join(base, 'game'), { recursive: true });
  await write('mod', mod);
  await write('game', game);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'state'),
      workspaces: [
        {
          id: 'derived',
          name: 'Derived map data',
          root: path.join(base, 'mod'),
          gameRoot: path.join(base, 'game'),
          includeGameDlc: false,
        },
      ],
    }),
  );
  const nudger = new AgentNudger(resolver, new TransactionManager(resolver));
  return {
    nudger,
    scan: (scripts = false) => nudger.scan('derived', undefined, undefined, scripts),
  };
}

function baseMap(): Record<string, string | Buffer> {
  return {
    'map/default.map': 'definitions = "definition.csv"\nprovinces = "provinces.bmp"\n',
    'map/definition.csv': [
      '0;0;0;0;sea;false;ocean;0',
      '1;10;0;0;land;false;plains;1',
      '2;0;0;200;land;true;plains;1',
      '3;0;160;220;sea;true;ocean;0',
      '4;0;180;0;land;false;forest;1',
      '',
    ].join('\n'),
    'map/provinces.bmp': provinces(),
    'map/adjacencies.csv':
      'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment\n-1;-1;;-1;-1;-1;-1;-1;;\n',
    'map/supply_nodes.txt': '1 1\n',
    'map/railways.txt': '',
    'map/buildings.txt': '1;arms_factory;10;0;245;0;0\n',
    'map/unitstacks.txt': '1;0;10;0;245;0;0\n',
    'map/weatherpositions.txt': '',
    'map/strategicregions/1-REGION.txt':
      'strategic_region = {\n\tid = 1\n\tname = "STRATEGICREGION_1"\n\tprovinces = { 1 2 3 4 }\n}\n',
    'history/states/1-ONE.txt':
      'state = {\n\tid = 1\n\tname = "STATE_1"\n\tmanpower = 1000\n\tstate_category = town\n\tresources = { steel = 9 }\n\tprovinces = { 1 4 }\n\thistory = {\n\t\towner = AAA\n\t\tadd_core_of = AAA\n\t\tvictory_points = { 1 5 }\n\t\tbuildings = { infrastructure = 3 arms_factory = 4 }\n\t}\n}\n',
    'history/states/2-TWO.txt':
      'state = {\n\tid = 2\n\tname = "STATE_2"\n\tmanpower = 500\n\tstate_category = town\n\tprovinces = { 2 }\n\thistory = { owner = AAA add_core_of = AAA }\n}\n',
    'localisation/english/map_l_english.yml': Buffer.from(
      '﻿l_english:\nSTATE_1: "One"\nSTATE_2: "Two"\nSTRATEGICREGION_1: "Region"\n',
      'utf8',
    ),
  };
}

function plan(index: Parameters<typeof planMapOperations>[0], operations: unknown[]) {
  return planMapOperations(
    index,
    operations.map((operation) => mapOperationSchema.parse(operation) as MapOperation),
  );
}

function text(result: ReturnType<typeof plan>, relativePath: string): string {
  const change = result.changes.find((candidate) => candidate.relativePath === relativePath);
  if (change?.content === undefined || change.content === null)
    throw new Error(`No change for ${relativePath}`);
  return Buffer.from(change.content).toString('utf8');
}

describe('state split and merge keep building levels whole', () => {
  it('copies levels into both parts, divides slot buildings and keeps units whole', async () => {
    const { scan } = await workspace(baseMap());
    const { index } = await scan();
    const result = plan(index, [
      { id: 'split', kind: 'create_state', provinceIds: [4], displayName: 'Four' },
    ]);
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    const source = final.statesById.get(1)!;
    const created = final.states.find(({ provinces }) => provinces.includes(4))!;
    expect(source.stateBuildings.get('infrastructure')).toBe(3);
    expect(created.stateBuildings.get('infrastructure')).toBe(3);
    // Four factories split by land area, two each, without fractions.
    expect(
      source.stateBuildings.get('arms_factory')! + created.stateBuildings.get('arms_factory')!,
    ).toBe(4);
    expect(Number.isInteger(created.stateBuildings.get('arms_factory'))).toBe(true);
    expect(Number.isInteger(created.resources.get('steel'))).toBe(true);
    // Merging them back keeps the level and sums the factories.
    const merged = plan(final, [
      {
        id: 'merge',
        kind: 'merge_states',
        targetStateId: 1,
        sourceStateIds: [created.id],
      },
    ]);
    expect(merged.blockers).toEqual([]);
    const target = merged.finalIndex.statesById.get(1);
    expect(target?.stateBuildings.get('infrastructure')).toBe(3);
    expect(target?.stateBuildings.get('arms_factory')).toBe(4);
  });
});

describe('script references to map entities', () => {
  const events = [
    'add_namespace = refs',
    'country_event = {',
    '\tid = refs.1',
    '\toption = {',
    '\t\tname = refs.1.a',
    '\t\t2 = { add_core_of = ROOT }',
    '\t\ttransfer_state = 2',
    '\t\trandom_list = { 50 = { add_political_power = 1 } }',
    '\t\tadd_state_claim = 7',
    '\t}',
    '}',
    '',
  ].join('\n');

  it('finds references by field, scope and folder, and reports the missing ones', async () => {
    const { scan } = await workspace({ ...baseMap(), 'events/refs.txt': events });
    const { index } = await scan(true);
    const { references } = collectMapScriptReferences(index.sourceFiles);
    expect(references.map(({ entity, id, form, key }) => [entity, id, form, key])).toEqual([
      ['state', 2, 'scope', '2'],
      ['state', 2, 'field', 'transfer_state'],
      ['state', 7, 'field', 'add_state_claim'],
    ]);
    const missing = missingMapReferenceDiagnostics(references, {
      state: (id) => index.statesById.has(id),
      province: (id) => index.definitionsById.has(id),
      'strategic-region': (id) => index.regionsById.has(id),
    });
    expect(missing).toMatchObject([
      { code: 'MAP_SCRIPT_REFERENCE_MISSING', severity: 'error', details: { id: 7 } },
    ]);
  });

  it('copies a reference for each successor state and removes references to removed ones', async () => {
    const { scan } = await workspace({ ...baseMap(), 'events/refs.txt': events });
    const { index } = await scan(true);
    const result = plan(index, [
      {
        id: 'remap',
        kind: 'remap_map_references',
        entity: 'state',
        mapping: [
          { from: 2, to: [2, 5] },
          { from: 7, to: null },
        ],
      },
    ]);
    expect(result.blockers).toEqual([]);
    const rewritten = text(result, 'events/refs.txt');
    expect(rewritten).toContain('\t\t2 = { add_core_of = ROOT }\n\t\t5 = { add_core_of = ROOT }');
    expect(rewritten).toContain('\t\ttransfer_state = 2\n\t\ttransfer_state = 5');
    expect(rewritten).not.toContain('add_state_claim');
    // Weights in a random_list are not states.
    expect(rewritten).toContain('random_list = { 50 = {');
  });

  it('refuses to edit game files unless told to override them in the mod', async () => {
    const { scan } = await workspace(baseMap(), { 'events/vanilla.txt': events });
    const { index } = await scan(true);
    const refused = plan(index, [
      { id: 'remap', kind: 'remap_map_references', entity: 'state', mapping: [{ from: 2, to: 5 }] },
    ]);
    expect(refused.blockers).toMatchObject([{ code: 'MAP_EXTERNAL_REFERENCE_READ_ONLY' }]);
    const overridden = plan(index, [
      {
        id: 'remap',
        kind: 'remap_map_references',
        entity: 'state',
        mapping: [{ from: 2, to: 5 }],
        readOnlySources: 'override',
      },
    ]);
    expect(overridden.blockers).toEqual([]);
    expect(text(overridden, 'events/vanilla.txt')).toContain('5 = { add_core_of = ROOT }');
  });
});

describe('derived positions and supply', () => {
  it('adds only the missing building, unit and weather positions', async () => {
    const { scan } = await workspace(baseMap());
    const { index } = await scan();
    const result = plan(index, [{ id: 'positions', kind: 'regenerate_map_positions' }]);
    expect(result.blockers).toEqual([]);
    const units = text(result, 'map/unitstacks.txt').trim().split('\n');
    // Province 1 kept its single hand-placed row; 2, 3 and 4 gained full sets.
    expect(units.filter((line) => line.startsWith('1;'))).toEqual(['1;0;10;0;245;0;0']);
    for (const id of [2, 3, 4]) {
      const types = units
        .filter((line) => line.startsWith(`${id};`))
        .map((line) => Number(line.split(';')[1]));
      expect(types).toContain(0);
      expect(types).toContain(38);
    }
    const buildings = text(result, 'map/buildings.txt');
    // A coastal state gets a naval base facing the sea province it borders.
    expect(buildings).toMatch(/^2;naval_base_spawn;[\d.]+;[\d.]+;[\d.]+;[-\d.]+;3$/mu);
    expect(buildings).toMatch(/^2;floating_harbor;[\d.]+;9\.50;[\d.]+;[-\d.]+;2$/mu);
    const weather = text(result, 'map/weatherpositions.txt');
    expect(weather).toMatch(/^1;.*;small$/mu);
    expect(weather).toMatch(/^1;.*;big$/mu);
    // The generated files are valid map data: positions sit inside their provinces.
    const final = indexWithProposedChanges(index, result.changes);
    for (const record of final.unitPositions) {
      const pixelY = 255 - Math.floor(record.z);
      expect(final.raster!.provinceIds[pixelY * 256 + Math.floor(record.x)]).toBe(
        record.provinceId,
      );
    }
  });

  it('gives each owned state a supply node and joins it to the country hub by railway', async () => {
    const { scan } = await workspace(baseMap());
    const { index } = await scan();
    // State 2 lies within supply reach of the node in province 1, so it has no gap.
    const gaps = plan(index, [{ id: 'supply', kind: 'rebuild_supply' }]);
    expect(text(gaps, 'map/supply_nodes.txt').trim().split('\n')).toEqual(['1 1']);
    // Named states always get their own node.
    const result = plan(index, [{ id: 'supply', kind: 'rebuild_supply', stateIds: [2] }]);
    expect(result.blockers).toEqual([]);
    expect(text(result, 'map/supply_nodes.txt').trim().split('\n')).toEqual(['1 1', '1 2']);
    // The hub (state 1, province 1) reaches state 2 through province 4.
    expect(text(result, 'map/railways.txt').trim()).toBe('3 3 1 4 2');
  });
});

describe('a new world', () => {
  const world = {
    id: 'world',
    kind: 'create_world',
    width: 512,
    height: 256,
    seed: 3,
    countries: [
      { tag: 'AUR', name: 'Aurelia' },
      { tag: 'BOR', name: 'Borea', share: 2 },
      { tag: 'CAL', name: 'Calder', ideology: 'democratic' },
    ],
    continentNames: ['Aster', 'Brum', 'Corvel'],
  };

  it('generates a complete, valid map with countries, history and derived data', async () => {
    const { scan } = await workspace({
      'descriptor.mod': 'name="World"' + String.fromCharCode(10),
    });
    const { index } = await scan();
    const result = plan(index, [world]);
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    const errors = validateMap(final).diagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    expect(errors).toEqual([]);
    expect(final.raster).toMatchObject({ width: 512, height: 256 });
    expect(final.states.length).toBeGreaterThan(3);
    expect(new Set(final.states.map(({ owner }) => owner))).toEqual(new Set(['AUR', 'BOR', 'CAL']));
    // Every owned state has a supply node, and every land and sea province has unit models.
    for (const state of final.states)
      expect(
        state.provinces.some((id) => final.supplyNodes.some(({ provinceId }) => provinceId === id)),
      ).toBe(true);
    const placed = new Set(final.unitPositions.map(({ provinceId }) => provinceId));
    for (const definition of final.definitions)
      if (definition.id > 0 && definition.type !== 'lake')
        expect(placed.has(definition.id)).toBe(true);
    const paths = result.changes.map(({ relativePath }) => relativePath);
    for (const expected of [
      'map/provinces.bmp',
      'map/heightmap.bmp',
      'map/terrain.bmp',
      'map/rivers.bmp',
      'map/trees.bmp',
      'map/world_normal.bmp',
      'map/terrain/colormap_rgb_cityemissivemask_a.dds',
      'common/country_tags/zz_world_countries.txt',
      'history/countries/AUR - Aurelia.txt',
      'gfx/flags/small/BOR.tga',
      'common/bookmarks/world.txt',
      'localisation/english/world_l_english.yml',
    ])
      expect(paths).toContain(expected);
    expect(text(result, 'descriptor.mod')).toContain('replace_path="history/states"');
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['MAP_WORLD_CREATED', 'MAP_WORLD_LAUNCHER_REPLACE_PATHS']),
    );
    // Same seed, same world.
    const again = plan(index, [world]);
    const hash = (changes: typeof result.changes) =>
      sha256Bytes(Buffer.concat(changes.map(({ content }) => Buffer.from(content ?? []))));
    expect(hash(again.changes)).toBe(hash(result.changes));
  });

  it('replaces the lower layers it overrides and passes the rewrite pipeline', async () => {
    const { nudger } = await workspace(
      { 'descriptor.mod': 'name="World"' + String.fromCharCode(10) },
      baseMap(),
    );
    const prepared = await nudger.planRewriteWithDiff({
      workspaceId: 'derived',
      operations: [mapOperationSchema.parse(world) as MapOperation],
    });
    // The base map's two states are replaced, not merged with the new world.
    expect(prepared.plan.finalIndex.states.every(({ owner }) => owner !== 'AAA')).toBe(true);
    expect(prepared.validation.passed).toBe(true);
    expect(prepared.artifacts.map(({ name }) => name)).toContain('map-diff.png');
  });
});

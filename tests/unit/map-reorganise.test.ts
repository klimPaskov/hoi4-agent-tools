import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import { planMapOperations, type MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';
import {
  collectMapScriptReferences,
  missingMapReferenceDiagnostics,
} from '../../src/hoi4_agent_tools/map/references.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

/**
 * Reorganising states: provinces move between states, states split and merge, and the numbers
 * the scripts use for states follow. Manpower (a state's population), resources and buildings
 * are carried with the land, never lost or duplicated.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const colors: Record<number, RgbColor> = {
  1: { r: 10, g: 0, b: 0 },
  2: { r: 0, g: 0, b: 200 },
  3: { r: 0, g: 160, b: 220 },
  4: { r: 0, g: 180, b: 0 },
  5: { r: 200, g: 200, b: 0 },
};

/** Land provinces 1, 4, 5, 2 as 64-pixel strips (province 5 is 32 wide) and sea 3. */
function provinces(): Buffer {
  const pixels: RgbColor[] = [];
  for (let y = 0; y < 256; y += 1)
    for (let x = 0; x < 256; x += 1)
      pixels.push(colors[x < 64 ? 1 : x < 128 ? 4 : x < 160 ? 5 : x < 192 ? 2 : 3]!);
  return createBmp({ width: 256, height: 256, bitsPerPixel: 24, rgbPixels: pixels });
}

async function workspace(mod: Record<string, string | Buffer>, game: Record<string, string> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-map-reorganise-'));
  roots.push(base);
  for (const [root, files] of [
    ['mod', mod],
    ['game', game],
  ] as const) {
    await mkdir(path.join(base, root), { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(base, root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'state'),
      workspaces: [
        {
          id: 'reorganise',
          name: 'Reorganise',
          root: path.join(base, 'mod'),
          gameRoot: path.join(base, 'game'),
          includeGameDlc: false,
        },
      ],
    }),
  );
  const nudger = new AgentNudger(resolver, new TransactionManager(resolver));
  return {
    scan: async () => (await nudger.scan('reorganise', undefined, undefined, true)).index,
  };
}

const flags = (level: number) => `infrastructure = ${level} arms_factory = 4`;

function map(): Record<string, string | Buffer> {
  return {
    'map/default.map': 'definitions = "definition.csv"\nprovinces = "provinces.bmp"\n',
    'map/definition.csv': [
      '0;0;0;0;sea;false;ocean;0',
      '1;10;0;0;land;false;plains;1',
      '2;0;0;200;land;true;plains;1',
      '3;0;160;220;sea;true;ocean;0',
      '4;0;180;0;land;false;forest;1',
      '5;200;200;0;land;false;hills;1',
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
      'strategic_region = {\n\tid = 1\n\tname = "STRATEGICREGION_1"\n\tprovinces = { 1 2 3 4 5 }\n}\n',
    'history/states/1-ONE.txt': `state = {\n\tid = 1\n\tname = "STATE_1"\n\tmanpower = 1000\n\tstate_category = town\n\tresources = { steel = 9 aluminium = 4 }\n\tprovinces = { 1 4 5 }\n\thistory = {\n\t\towner = AAA\n\t\tadd_core_of = AAA\n\t\tvictory_points = { 1 5 }\n\t\tbuildings = { ${flags(3)} }\n\t}\n}\n`,
    'history/states/2-TWO.txt':
      'state = {\n\tid = 2\n\tname = "STATE_2"\n\tmanpower = 500\n\tstate_category = town\n\tresources = { steel = 2 }\n\tprovinces = { 2 }\n\thistory = {\n\t\towner = AAA\n\t\tadd_core_of = AAA\n\t\tadd_claim_by = BBB\n\t\tbuildings = { infrastructure = 1 }\n\t}\n}\n',
    'common/country_tags/00_tags.txt': 'AAA = "countries/Aaa.txt"\nBBB = "countries/Bbb.txt"\n',
    'history/countries/AAA - Aaa.txt': 'capital = 1\n',
    'localisation/english/map_l_english.yml': Buffer.from(
      '﻿l_english:\nSTATE_1: "One"\nSTATE_2: "Two"\nSTRATEGICREGION_1: "Region"\n',
      'utf8',
    ),
  };
}

function region(id: number, provinces: string): string {
  return `strategic_region = {\n\tid = ${id}\n\tname = "STRATEGICREGION_${id}"\n\tprovinces = { ${provinces} }\n}\n`;
}

function plan(index: Parameters<typeof planMapOperations>[0], operations: unknown[]) {
  return planMapOperations(
    index,
    operations.map((operation) => mapOperationSchema.parse(operation) as MapOperation),
  );
}

function scriptText(result: ReturnType<typeof plan>, relativePath: string): string {
  const change = result.changes.find((candidate) => candidate.relativePath === relativePath);
  if (change?.content === undefined || change.content === null)
    throw new Error(`No change for ${relativePath}`);
  return Buffer.from(change.content).toString('utf8');
}

const total = (...values: Array<number | undefined>) =>
  values.reduce<number>((sum, value) => sum + (value ?? 0), 0);

describe('moving provinces between states', () => {
  it('carries a land share of population, resources and slot buildings, and keeps levels', async () => {
    const { scan } = await workspace(map());
    const index = await scan();
    // Province 4 is 64 of the 160 land pixels of state 1: 40%.
    const result = plan(index, [
      {
        id: 'move',
        kind: 'move_state_provinces',
        sourceStateId: 1,
        targetStateId: 2,
        provinceIds: [4],
      },
    ]);
    expect(result.blockers).toEqual([]);
    const source = result.finalIndex.statesById.get(1)!;
    const target = result.finalIndex.statesById.get(2)!;
    expect(source.provinces).toEqual([1, 5]);
    expect(target.provinces).toEqual([2, 4]);
    // Nothing is lost or duplicated.
    expect(total(source.manpower, target.manpower)).toBe(1500);
    expect(source.manpower).toBe(600);
    expect(target.manpower).toBe(900);
    expect(total(source.resources.get('steel'), target.resources.get('steel'))).toBe(11);
    expect(total(source.resources.get('aluminium'), target.resources.get('aluminium'))).toBe(4);
    expect(target.resources.get('aluminium')).toBe(2);
    expect(
      total(source.stateBuildings.get('arms_factory'), target.stateBuildings.get('arms_factory')),
    ).toBe(4);
    expect(Number.isInteger(target.stateBuildings.get('arms_factory'))).toBe(true);
    // Infrastructure is a level: the source keeps its level and the target takes the higher.
    expect(source.stateBuildings.get('infrastructure')).toBe(3);
    expect(target.stateBuildings.get('infrastructure')).toBe(3);
    expect(scriptText(result, 'history/states/1-ONE.txt')).toContain('manpower = 600');
  });

  it('accepts the proportional keyword and keeps the old explicit policy available', async () => {
    const { scan } = await workspace(map());
    const index = await scan();
    const explicit = {
      stateValues: 'retain-in-current-states',
      ownership: 'retain-in-current-states',
      provinceBuildings: 'follow-province',
      victoryPoints: 'follow-province',
      ports: 'follow-province',
      supplyNodes: 'follow-province',
      railways: 'follow-province',
      positions: 'follow-province',
      strategicRegion: 'require-same',
    };
    const move = {
      id: 'move',
      kind: 'move_state_provinces',
      sourceStateId: 1,
      targetStateId: 2,
      provinceIds: [4],
    };
    const retained = plan(index, [{ ...move, distribution: explicit }]);
    expect(retained.blockers).toEqual([]);
    expect(retained.finalIndex.statesById.get(1)!.manpower).toBe(1000);
    expect(retained.finalIndex.statesById.get(2)!.manpower).toBe(500);
    const keyword = plan(index, [{ ...move, distribution: 'proportional' }]);
    expect(keyword.finalIndex.statesById.get(2)!.manpower).toBe(900);
    const automatic = plan(index, [
      { ...move, distribution: { ...explicit, stateValues: 'proportional-by-land-pixels' } },
    ]);
    expect(automatic.finalIndex.statesById.get(2)!.manpower).toBe(900);
  });

  it('rejects an incomplete explicit policy instead of guessing', () => {
    expect(() =>
      mapOperationSchema.parse({
        id: 'move',
        kind: 'move_state_provinces',
        sourceStateId: 1,
        targetStateId: 2,
        provinceIds: [4],
        distribution: { stateValues: 'retain-in-current-states' },
      }),
    ).toThrow();
  });

  it('refuses provinces that lie in another strategic region unless told to move them', async () => {
    const files = map();
    files['map/strategicregions/1-REGION.txt'] = region(1, '1 2 3 5');
    files['map/strategicregions/2-REGION.txt'] = region(2, '4');
    files['localisation/english/map_l_english.yml'] = Buffer.from(
      `\uFEFFl_english:\nSTATE_1: "One"\nSTATE_2: "Two"\nSTRATEGICREGION_1: "A"\nSTRATEGICREGION_2: "B"\n`,
      'utf8',
    );
    const { scan } = await workspace(files);
    const index = await scan();
    const move = {
      id: 'move',
      kind: 'move_state_provinces',
      sourceStateId: 1,
      targetStateId: 2,
      provinceIds: [4],
    };
    expect(plan(index, [move]).blockers).toMatchObject([
      { code: 'MAP_STATE_REGION_DISTRIBUTION_CONFLICT' },
    ]);
    const explicit = plan(index, [
      {
        ...move,
        distribution: {
          stateValues: 'proportional-by-land-pixels',
          ownership: 'retain-in-current-states',
          provinceBuildings: 'follow-province',
          victoryPoints: 'follow-province',
          ports: 'follow-province',
          supplyNodes: 'follow-province',
          railways: 'follow-province',
          positions: 'follow-province',
          strategicRegion: 'move-to-target-region',
        },
      },
    ]);
    expect(explicit.blockers).toEqual([]);
    expect(explicit.finalIndex.regionsById.get(1)!.provinces).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('history follows the land', () => {
  it('splits a state with its owner, cores and victory point, and merges cores and claims', async () => {
    const { scan } = await workspace(map());
    const index = await scan();
    const split = plan(index, [
      { id: 'split', kind: 'create_state', provinceIds: [1], displayName: 'Capital Region' },
    ]);
    expect(split.blockers).toEqual([]);
    const created = split.finalIndex.states.find(({ provinces }) => provinces.includes(1))!;
    const rest = split.finalIndex.statesById.get(1)!;
    expect(created.id).not.toBe(1);
    expect([created.owner, rest.owner]).toEqual(['AAA', 'AAA']);
    expect(created.cores).toEqual(['AAA']);
    expect(created.victoryPoints.map(({ provinceId, value }) => [provinceId, value])).toEqual([
      [1, 5],
    ]);
    expect(rest.victoryPoints).toEqual([]);
    expect(rest.provinces).toEqual([4, 5]);

    const merged = plan(index, [
      { id: 'merge', kind: 'merge_states', targetStateId: 1, sourceStateIds: [2] },
    ]);
    expect(merged.blockers).toEqual([]);
    const survivor = merged.finalIndex.statesById.get(1)!;
    expect(survivor.owner).toBe('AAA');
    expect(survivor.cores).toEqual(['AAA']);
    expect(survivor.claims).toEqual(['BBB']);
    expect(survivor.victoryPoints.map(({ provinceId, value }) => [provinceId, value])).toEqual([
      [1, 5],
    ]);
    // The merged-away state file is emptied rather than left defining a second state 2.
    expect(merged.finalIndex.statesById.has(2)).toBe(false);
  });
});

describe('script references follow a merge or a split', () => {
  const scripts = {
    'events/geography.txt': [
      'add_namespace = geo',
      'country_event = {',
      '\tid = geo.1',
      '\tis_triggered_only = yes',
      '\ttrigger = {',
      '\t\thas_full_control_of_state = 2',
      '\t\tcapital = 2',
      '\t}',
      '\timmediate = {',
      '\t\trandom_state = { prioritize = { 1 2 } limit = { always = yes } }',
      '\t\tset_state_controller = 2',
      '\t\tadd_province_modifier = { static_modifiers = { m } province = { id = 4 id = 5 } }',
      '\t\t2 = { add_core_of = ROOT }',
      '\t}',
      '\toption = { name = geo.1.a }',
      '}',
      '',
    ].join('\n'),
  };

  it('finds the state and province references scripts make through the commands vanilla uses', async () => {
    const { scan } = await workspace({ ...map(), ...scripts });
    const index = await scan();
    const { references } = collectMapScriptReferences(index.sourceFiles);
    expect(
      references
        .map(({ entity, id, key }) => `${entity}:${id}:${key}`)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        'state:2:has_full_control_of_state',
        'state:2:capital',
        'state:1:prioritize',
        'state:2:prioritize',
        'state:2:set_state_controller',
        'province:4:province.id',
        'province:5:province.id',
        'state:2:2',
        'state:1:capital',
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('merges states and remaps every reference to the survivor in the same plan', async () => {
    const { scan } = await workspace({ ...map(), ...scripts });
    const index = await scan();
    const result = plan(index, [
      {
        id: 'merge',
        kind: 'merge_states',
        targetStateId: 1,
        sourceStateIds: [2],
        remapReferences: 'refuse',
      },
    ]);
    expect(result.blockers).toEqual([]);
    const merged = result.finalIndex.statesById.get(1)!;
    expect(merged.provinces).toEqual([1, 2, 4, 5]);
    expect(merged.manpower).toBe(1500);
    expect(merged.resources.get('steel')).toBe(11);
    expect(result.finalIndex.statesById.has(2)).toBe(false);
    const events = scriptText(result, 'events/geography.txt');
    expect(events).toContain('has_full_control_of_state = 1');
    expect(events).toContain('capital = 1');
    expect(events).toContain('prioritize = { 1 1 }');
    expect(events).toContain('set_state_controller = 1');
    expect(events).toContain('1 = { add_core_of = ROOT }');
    expect(events).not.toMatch(/=\s*2\b/u);
    // Nothing the scripts name is left undefined.
    const after = collectMapScriptReferences(result.finalIndex.sourceFiles).references;
    expect(
      missingMapReferenceDiagnostics(after, {
        state: (id) => result.finalIndex.statesById.has(id),
        province: (id) => result.finalIndex.definitionsById.has(id),
        'strategic-region': (id) => result.finalIndex.regionsById.has(id),
      }),
    ).toEqual([]);
  });

  it('splits a state and extends the references to cover the new part', async () => {
    const { scan } = await workspace({ ...map(), ...scripts });
    const index = await scan();
    const result = plan(index, [
      {
        id: 'split',
        kind: 'create_state',
        provinceIds: [5],
        displayName: 'Hillside',
        remapReferences: 'refuse',
      },
    ]);
    expect(result.blockers).toEqual([]);
    const created = result.finalIndex.states.find(({ provinces }) => provinces.includes(5))!;
    expect(created.id).not.toBe(1);
    expect(created.manpower).toBe(200);
    expect(result.finalIndex.statesById.get(1)!.manpower).toBe(800);
    const events = scriptText(result, 'events/geography.txt');
    expect(events).toContain(`prioritize = { 1 ${created.id} 2 }`);
    expect(events).toContain('capital = 2');
    const countries = result.changes.find(({ relativePath }) =>
      relativePath.startsWith('history/countries/'),
    );
    expect(Buffer.from(countries!.content!).toString('utf8')).toContain('capital = 1');
  });

  it('refuses to edit base-game scripts unless told to copy them into the mod', async () => {
    const { scan } = await workspace(map(), {
      'events/vanilla.txt': scripts['events/geography.txt'],
    });
    const index = await scan();
    const merge = {
      id: 'merge',
      kind: 'merge_states',
      targetStateId: 1,
      sourceStateIds: [2],
    };
    const refused = plan(index, [{ ...merge, remapReferences: 'refuse' }]);
    expect(refused.blockers).toMatchObject([{ code: 'MAP_EXTERNAL_REFERENCE_READ_ONLY' }]);
    const copied = plan(index, [{ ...merge, remapReferences: 'override' }]);
    expect(copied.blockers).toEqual([]);
    expect(scriptText(copied, 'events/vanilla.txt')).toContain('has_full_control_of_state = 1');
  });
});

describe('a new world can be reshaped without losing people, resources or references', () => {
  const world = {
    id: 'world',
    kind: 'create_world',
    width: 512,
    height: 256,
    seed: 11,
    countries: [
      { tag: 'AUR', name: 'Aurelia' },
      { tag: 'BOR', name: 'Borea', share: 2 },
    ],
  };

  it('owns every state, gives it infrastructure and supply, then merges and moves states consistently', async () => {
    const { scan } = await workspace({ 'descriptor.mod': 'name="World"\n' });
    const empty = await scan();
    const created = plan(empty, [world]);
    expect(created.blockers).toEqual([]);
    const index = created.finalIndex;
    // Ownership, infrastructure and supply.
    for (const state of index.states) {
      expect(['AUR', 'BOR'], `state ${state.id} owner`).toContain(state.owner);
      expect(state.controller ?? state.owner).toBe(state.owner);
      expect(state.stateBuildings.get('infrastructure') ?? 0, `state ${state.id}`).toBeGreaterThan(
        0,
      );
      expect(state.manpower, `state ${state.id}`).toBeGreaterThan(0);
      expect(
        state.provinces.some((id) => index.supplyNodes.some(({ provinceId }) => provinceId === id)),
      ).toBe(true);
    }
    // Every province of a state lies in one strategic region.
    for (const state of index.states)
      expect(new Set(state.provinces.map((id) => index.regionForProvince(id)[0]?.id)).size).toBe(1);

    // Two states of one owner in one strategic region.
    const regionOf = (stateId: number) =>
      index.regionForProvince(index.statesById.get(stateId)!.provinces[0]!)[0]!.id;
    const pair = index.states
      .flatMap((left) =>
        index.states
          .filter(
            (right) =>
              right.id > left.id &&
              right.owner === left.owner &&
              regionOf(right.id) === regionOf(left.id),
          )
          .map((right) => [left, right] as const),
      )
      .at(0);
    expect(pair, 'the world has two states of one owner in one region').toBeDefined();
    const [target, absorbed] = pair!;
    const totals = (statesList: typeof index.states) => ({
      manpower: statesList.reduce((sum, state) => sum + state.manpower, 0),
      steel: statesList.reduce((sum, state) => sum + (state.resources.get('steel') ?? 0), 0),
      oil: statesList.reduce((sum, state) => sum + (state.resources.get('oil') ?? 0), 0),
      factories: statesList.reduce(
        (sum, state) => sum + (state.stateBuildings.get('arms_factory') ?? 0),
        0,
      ),
    });
    const before = totals(index.states);

    // Reshape: merge one state into another, then give the survivor's first province to a third state.
    const merged = plan(index, [
      {
        id: 'merge',
        kind: 'merge_states',
        targetStateId: target.id,
        sourceStateIds: [absorbed.id],
      },
    ]);
    expect(merged.blockers).toEqual([]);
    expect(merged.finalIndex.states).toHaveLength(index.states.length - 1);
    expect(totals(merged.finalIndex.states)).toEqual(before);

    const donor = merged.finalIndex.statesById.get(target.id)!;
    const receiver = merged.finalIndex.states.find(
      (state) =>
        state.id !== donor.id &&
        state.owner === donor.owner &&
        regionOf(state.id) === regionOf(donor.id),
    );
    if (receiver !== undefined && donor.provinces.length > 1) {
      const moved = plan(merged.finalIndex, [
        {
          id: 'move',
          kind: 'move_state_provinces',
          sourceStateId: donor.id,
          targetStateId: receiver.id,
          provinceIds: [donor.provinces[0]],
        },
      ]);
      expect(moved.blockers).toEqual([]);
      expect(totals(moved.finalIndex.states)).toEqual(before);
    }
  }, 600_000);
});

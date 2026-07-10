import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { SOURCE_TOKEN_LIMIT } from '../../src/hoi4_agent_tools/core/source/index.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import {
  MAP_TEXT_MAX_BYTES,
  MAP_TEXT_MAX_RECORDS,
  MapWorkspaceIndex,
  parseTextDocument,
} from '../../src/hoi4_agent_tools/map/model.js';
import { MAP_DIAGNOSTIC_LIMIT } from '../../src/hoi4_agent_tools/map/diagnostic-limit.js';
import { MAP_SELECTED_PIXEL_LIMIT } from '../../src/hoi4_agent_tools/map/limits.js';
import {
  indexWithProposedChanges,
  planMapOperations,
  planMapOperationsAsync,
  type MoveStateDistributionPolicy,
  type ProvinceTypeDistributionPolicy,
  type SplitProvinceDistributionPolicy,
  type SplitStateDistributionPolicy,
} from '../../src/hoi4_agent_tools/map/operations.js';
import { renderMap, renderMapDiff } from '../../src/hoi4_agent_tools/map/render.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { validateMap, validateMapAsync } from '../../src/hoi4_agent_tools/map/validation.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

const postValidate = () =>
  Promise.resolve({
    diagnostics: [],
    checks: [{ id: 'map-test-post-write', passed: true, message: 'Fixture revalidated' }],
  });

const provinceColors: Record<number, RgbColor> = {
  0: { r: 0, g: 0, b: 0 },
  1: { r: 10, g: 0, b: 0 },
  2: { r: 0, g: 0, b: 200 },
  3: { r: 0, g: 160, b: 220 },
  4: { r: 0, g: 180, b: 0 },
};

function colorFor(id: number): RgbColor {
  const color = provinceColors[id];
  if (color === undefined) throw new Error(`Fixture color ${id} is missing`);
  return color;
}

const movePolicy: MoveStateDistributionPolicy = {
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

const splitStatePolicy: SplitStateDistributionPolicy = {
  manpower: { method: 'proportional-by-land-pixels' },
  resources: { method: 'proportional-by-land-pixels' },
  stateBuildings: { method: 'proportional-by-land-pixels' },
  owner: { method: 'copy-source' },
  controller: { method: 'copy-source' },
  cores: { method: 'copy-source' },
  claims: { method: 'copy-source' },
  victoryPoints: 'follow-province',
  provinceBuildings: 'follow-province',
  ports: 'follow-province',
  supplyNodes: 'follow-province',
  railways: 'follow-province',
  positions: 'follow-province',
};

const splitProvincePolicy: SplitProvinceDistributionPolicy = {
  state: 'inherit-source',
  strategicRegion: 'inherit-source',
  victoryPoints: 'retain-source',
  provinceBuildings: 'retain-source',
  ports: 'retain-source',
  supplyNodes: 'retain-source',
  railways: 'retain-source',
  adjacencies: 'retain-source',
  positions: 'retain-source',
  entityLocators: 'retain-source',
};

const mergeProvincePolicy = {
  membership: 'require-same',
  victoryPoints: 'sum-into-target',
  provinceBuildings: 'sum-into-target',
  references: 'remap-to-target-and-deduplicate',
} as const;

const removeLandDependenciesPolicy: ProvinceTypeDistributionPolicy = {
  stateMembership: { method: 'remove', stateId: 1 },
  stateValues: 'retain-in-current-states',
  strategicRegion: 'retain-membership',
  victoryPoints: 'remove',
  provinceBuildings: 'remove',
  ports: 'remove',
  supplyNodes: 'remove',
  railways: 'remove-containing',
  buildingPositions: 'remove',
  unitPositions: 'remove',
  entityLocators: 'retain-at-coordinate',
  adjacencies: 'remove-referencing',
};

const assignLandDependenciesPolicy: ProvinceTypeDistributionPolicy = {
  stateMembership: { method: 'assign', stateId: 2 },
  stateValues: 'retain-in-current-states',
  strategicRegion: 'retain-membership',
  victoryPoints: 'remove',
  provinceBuildings: 'remove',
  ports: 'remove',
  supplyNodes: 'remove',
  railways: 'remove-containing',
  buildingPositions: 'remove',
  unitPositions: 'remove',
  entityLocators: 'retain-at-coordinate',
  adjacencies: 'remove-referencing',
};

function provinceBitmap(width = 256, height = 256): Buffer {
  const pixels: RgbColor[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = x < width / 4 ? 1 : x < width / 2 ? 4 : x < (width * 3) / 4 ? 2 : 3;
      pixels.push(colorFor(id));
    }
  }
  return createBmp({ width, height, bitsPerPixel: 24, dibSize: 124, rgbPixels: pixels });
}

function fixtureFiles(): Record<string, string | Buffer> {
  return {
    'map/default.map':
      'definitions = "definition.csv"\nprovinces = "provinces.bmp"\nadjacencies = "adjacencies.csv"\npositions = "positions.txt"\n',
    'map/definition.csv': [
      '0;0;0;0;sea;false;ocean;0',
      '1;10;0;0;land;true;plains;1',
      '2;0;0;200;land;true;plains;1',
      '3;0;160;220;sea;true;ocean;0',
      '4;0;180;0;land;false;forest;1',
      '',
    ].join('\n'),
    'map/provinces.bmp': provinceBitmap(),
    'map/adjacencies.csv':
      'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment\n-1;-1;;-1;-1;-1;-1;-1;;\n',
    'map/supply_nodes.txt': '1 1\n',
    'map/railways.txt': '1 3 1 4 2\n',
    'map/buildings.txt':
      '1;bunker;10;0;245;0;0\n1;naval_base_spawn;10;0;245;0;3\n2;bunker;140;0;245;0;0\n',
    'map/unitstacks.txt': '1;0;10;0;245;0;0\n',
    'map/weatherpositions.txt': '1;10;0;245;small\n1;140;0;245;big\n',
    'history/states/1-ONE.txt': [
      '# source comment must survive',
      'state = {',
      '\tid = 1',
      '\tname = "STATE_1"',
      '\tcapital = 999',
      '\tmanpower = 1000',
      '\tstate_category = town',
      '\tresources = { steel = 10 }',
      '\tprovinces = { 1 4 }',
      '\tunknown = { keep = yes }',
      '\thistory = {',
      '\t\towner = AAA',
      '\t\tadd_core_of = AAA',
      '\t\tvictory_points = { 1 5 }',
      '\t\tbuildings = {',
      '\t\t\tinfrastructure = 3',
      '\t\t\t1 = { arms_factory = 1 naval_base = 1 }',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
    'history/states/2-TWO.txt': [
      'state = {',
      '\tid = 2',
      '\tname = "STATE_2"',
      '\tmanpower = 500',
      '\tstate_category = town',
      '\tprovinces = { 2 }',
      '\thistory = { owner = BBB add_core_of = BBB }',
      '}',
      '',
    ].join('\n'),
    'map/strategicregions/1-REGION.txt':
      'strategic_region = {\n\tid = 1\n\tname = "STRATEGICREGION_1"\n\tprovinces = { 1 2 3 4 }\n}\n',
    'localisation/english/map_l_english.yml': Buffer.from(
      '\ufeffl_english:\nSTATE_1: "One"\nSTATE_2: "Two"\nSTATE_3: "Three"\nSTATE_4: "Four"\nSTATE_10: "Ten"\nSTRATEGICREGION_1: "Region"\n',
      'utf8',
    ),
    'gfx/entities/map.asset':
      'entity = { name = test_entity locator = { name = test_locator position = { 1 2 3 } } }\n',
  };
}

function provinceRenumberFixtureFiles(): Readonly<Record<string, string | Buffer | null>> {
  return {
    'map/definition.csv': Buffer.from(
      [
        '\ufeff# definition comments and row order must survive',
        '0;0;0;0;sea;false;ocean;0;# zero row',
        '1;10;0;0;land;true;plains;1;# lower land row',
        '2;0;0;200;land;true;plains;1;# merge source row',
        '3;0;160;220;sea;true;ocean;0;# shifted sea row',
        '4;0;180;0;land;false;forest;1;# merge target row',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    'history/states/1-ONE.txt': [
      '# state comment must survive',
      'state = {',
      '\tid = 1',
      '\tname = "STATE_1"',
      '\tmanpower = 1000',
      '\tstate_category = town',
      '\tprovinces = { 1 2 4 }',
      '\thistory = {',
      '\t\towner = AAA',
      '\t\tadd_core_of = AAA',
      '\t\tvictory_points = { 1 5 }',
      '\t\tvictory_points = { 2 3 }',
      '\t\tvictory_points = { 4 7 }',
      '\t\tbuildings = {',
      '\t\t\tinfrastructure = 3',
      '\t\t\t1 = { arms_factory = 1 }',
      '\t\t\t2 = { arms_factory = 2 naval_base = 1 }',
      '\t\t\t4 = { arms_factory = 4 }',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\r\n'),
    'history/states/2-TWO.txt': null,
    'map/strategicregions/1-REGION.txt':
      '# region comment must survive\r\nstrategic_region = {\r\n\tid = 1\r\n\tname = "STRATEGICREGION_1"\r\n\tprovinces = { 1 2 3 4 }\r\n}\r\n',
    'map/adjacencies.csv': [
      'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment',
      '1;4;sea;3;0;0;1;1;test_rule;keep-first-comment',
      '2;1;sea;3;2;2;3;3;test_rule;remove-second-comment',
      '-1;-1;;-1;-1;-1;-1;-1;;',
      '',
    ].join('\r\n'),
    'map/supply_nodes.txt':
      '1 2 # source-node-comment\r\n1 4 # target-node-comment\r\n1 1 # lower-node-comment\r\n',
    'map/railways.txt': '1 3 1 4 2 # trunk-comment\r\n1 2 4 2 # collapsed-comment\r\n',
    'map/buildings.txt':
      '1;naval_base_spawn;140;0;245;0;3;# port-comment\r\n1;bunker;70;0;245;0;0;# target-building-comment\r\n',
    'map/unitstacks.txt':
      '2;0;140;0;245;0;0;# source-unit-comment\r\n4;0;70;0;245;0;0;# target-unit-comment\r\n1;0;10;0;245;0;0;# lower-unit-comment\r\n',
  };
}

async function setup(overrides: Readonly<Record<string, string | Buffer | null>> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-map-'));
  const mod = path.join(base, 'mod');
  const files = new Map(Object.entries(fixtureFiles()));
  for (const [relativePath, content] of Object.entries(overrides)) {
    if (content === null) files.delete(relativePath);
    else files.set(relativePath, content);
  }
  for (const [relativePath, content] of files) {
    const target = path.join(mod, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const config = serverConfigurationSchema.parse({
    version: 1,
    writePolicy: 'transactions',
    serverStateRoot: path.join(base, 'server-state'),
    transactionTtlSeconds: 3600,
    workspaces: [{ id: 'map-test', name: 'Map Test', root: mod, writeEnabled: true }],
  });
  const resolver = await WorkspaceResolver.create(config);
  const transactions = new TransactionManager(resolver);
  const nudger = new AgentNudger(resolver, transactions);
  const snapshot = await nudger.scan('map-test');
  return { base, mod, resolver, transactions, nudger, snapshot };
}

function scannedState(
  relativePath: string,
  id: number,
  loadOrder: number,
  rootKind: 'game' | 'dependency' | 'mod',
): ScannedFile {
  const bytes = Buffer.from(
    `state = { id = ${id} name = "STATE_${id}" manpower = 0 state_category = town provinces = { } history = { owner = AAA } }\n`,
  );
  return {
    absolutePath: `${rootKind}:/${relativePath}`,
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function scannedText(
  relativePath: string,
  text: string,
  loadOrder: number,
  rootKind: 'game' | 'dependency' | 'mod',
): ScannedFile {
  const bytes = Buffer.from(text, 'utf8');
  return {
    absolutePath: `${rootKind}:/${relativePath}`,
    displayPath: `${rootKind}:${relativePath}`,
    relativePath,
    rootKind,
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function abortSignalInside(stackFrame: string): {
  signal: AbortSignal;
  matched: () => boolean;
} {
  const controller = new AbortController();
  let matched = false;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'throwIfAborted') {
        return () => {
          if (!matched && new Error().stack?.includes(stackFrame) === true) {
            matched = true;
            controller.abort();
          }
          target.throwIfAborted();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { signal, matched: () => matched };
}

describe('Agent Nudger map model and operations', () => {
  it('admits current vanilla-scale map text tables and blocks larger inputs', () => {
    const measuredVanillaBytes = 10_335_662;
    const measuredVanillaRecords = 265_355;
    expect(MAP_TEXT_MAX_BYTES).toBeGreaterThanOrEqual(measuredVanillaBytes);
    expect(MAP_TEXT_MAX_RECORDS).toBeGreaterThanOrEqual(measuredVanillaRecords);
    expect(
      parseTextDocument(
        scannedText(
          'map/vanilla-scale.txt',
          '1;0;0;0;0;0\n'.repeat(measuredVanillaRecords),
          0,
          'game',
        ),
      ).lines,
    ).toHaveLength(measuredVanillaRecords);
    expect(() =>
      parseTextDocument(
        scannedText('map/too-large.txt', 'x'.repeat(MAP_TEXT_MAX_BYTES + 1), 0, 'game'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MAP_TEXT_FILE_LIMIT' }));
    expect(() =>
      parseTextDocument(
        scannedText('map/too-many-records.txt', 'x\n'.repeat(MAP_TEXT_MAX_RECORDS + 1), 0, 'game'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MAP_TEXT_RECORD_LIMIT' }));
  });
  it('yields during real map validation and planning so timer aborts are delivered', async () => {
    const { mod, nudger } = await setup();
    await writeFile(path.join(mod, 'map/provinces.bmp'), provinceBitmap(512, 512));
    const { index } = await nudger.scan('map-test');

    const validationController = new AbortController();
    const validationTimer = setTimeout(() => validationController.abort(), 0);
    try {
      await expect(
        validateMapAsync(index, { signal: validationController.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(validationTimer);
    }

    const planningController = new AbortController();
    const planningTimer = setTimeout(() => planningController.abort(), 0);
    try {
      await expect(
        planMapOperationsAsync(
          index,
          [
            {
              id: 'timer-merge-province-4',
              kind: 'merge_provinces',
              sourceProvinceIds: [4],
              targetProvinceId: 1,
              distribution: {
                membership: 'require-same',
                victoryPoints: 'sum-into-target',
                provinceBuildings: 'sum-into-target',
                references: 'remap-to-target-and-deduplicate',
              },
            },
          ],
          planningController.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(planningTimer);
    }
  });

  it('scans only the default-map-selected province bitmap and preserves custom names', async () => {
    const { mod, nudger } = await setup();
    await writeFile(
      path.join(mod, 'map/default.map'),
      'definitions = "definition.csv"\nprovinces = "custom-provinces.bmp"\nadjacencies = "adjacencies.csv"\npositions = "positions.txt"\n',
    );
    await writeFile(path.join(mod, 'map/custom-provinces.bmp'), provinceBitmap());
    await writeFile(path.join(mod, 'map/unrelated-large.bmp'), Buffer.alloc(8 * 1024 * 1024, 0x5a));

    const snapshot = await nudger.scan('map-test');
    const scanned = snapshot.files.map(({ relativePath }) => relativePath.replaceAll('\\', '/'));
    expect(scanned).toContain('map/custom-provinces.bmp');
    expect(scanned).not.toContain('map/provinces.bmp');
    expect(scanned).not.toContain('map/unrelated-large.bmp');
    expect(snapshot.index.provinceBitmapFile?.relativePath).toBe('map/custom-provinces.bmp');
  });

  it('blocks malformed active default.map selectors before bitmap admission can fall back', async () => {
    const { mod, nudger } = await setup();
    await writeFile(
      path.join(mod, 'map/default.map'),
      'definitions = "hidden-definitions.csv"\nprovinces = {\n',
    );

    await expect(nudger.scan('map-test')).rejects.toMatchObject({
      code: 'MAP_DEFAULT_MAP_SELECTOR_BLOCKED',
      details: {
        path: 'mod:map/default.map',
        relativePath: 'map/default.map',
        rootKind: 'mod',
        reasonCodes: ['SOURCE_UNCLOSED_BLOCK'],
      },
    });
  });

  it('does not follow a province-bitmap selector outside the configured map root', async () => {
    const { mod, nudger } = await setup();
    await writeFile(
      path.join(mod, 'map/default.map'),
      'definitions = "definition.csv"\nprovinces = "../outside.bmp"\nadjacencies = "adjacencies.csv"\npositions = "positions.txt"\n',
    );
    await writeFile(path.join(mod, 'outside.bmp'), provinceBitmap());

    const snapshot = await nudger.scan('map-test');
    expect(snapshot.files.map(({ relativePath }) => relativePath)).not.toContain('outside.bmp');
    expect(snapshot.index.provinceBitmapFile).toBeUndefined();
  });

  it('cancels cooperatively from inside province-component geometry validation', async () => {
    const { snapshot } = await setup();
    const probe = abortSignalInside('provinceComponents');

    expect(() => validateMap(snapshot.index, { signal: probe.signal })).toThrow(/abort/i);
    expect(probe.matched()).toBe(true);
  });

  it('cancels cooperatively from inside merge-province raster planning', async () => {
    const { snapshot } = await setup();
    const probe = abortSignalInside('applyMergeProvinces');

    expect(() =>
      planMapOperations(
        snapshot.index,
        [
          {
            id: 'cancel-merge-province-4',
            kind: 'merge_provinces',
            sourceProvinceIds: [4],
            targetProvinceId: 1,
            distribution: {
              membership: 'require-same',
              victoryPoints: 'sum-into-target',
              provinceBuildings: 'sum-into-target',
              references: 'remap-to-target-and-deduplicate',
            },
          },
        ],
        probe.signal,
      ),
    ).toThrow(/abort/i);
    expect(probe.matched()).toBe(true);
  });

  it('indexes definitions, raster geometry, states, regions, networks, positions, ownership, coast, ports, and locators', async () => {
    const { snapshot } = await setup();
    const index = snapshot.index;
    expect(index.provinceBitmap).toMatchObject({
      width: 256,
      height: 256,
      dibSize: 124,
      bitsPerPixel: 24,
    });
    expect(index.definitionsById.size).toBe(5);
    expect(index.raster?.geometry.get(4)).toMatchObject({
      pixelCount: 16_384,
      minX: 64,
      maxX: 127,
    });
    expect(index.raster?.adjacency.get(4)).toEqual(new Set([1, 2]));
    expect(index.raster?.coastalProvinceIds).toEqual(new Set([1, 2, 3]));
    expect(index.statesById.get(1)).toMatchObject({
      owner: 'AAA',
      capital: 1,
      cores: ['AAA'],
      provinces: [1, 4],
    });
    expect(index.statesByProvince.get(4)?.map(({ id }) => id)).toEqual([1]);
    expect(index.ownersByState.get(1)).toBe('AAA');
    expect(index.capitalsByState.get(1)).toBe(1);
    expect(index.coresByState.get(1)).toEqual(['AAA']);
    expect(index.statesById.get(1)?.victoryPoints).toMatchObject([{ provinceId: 1, value: 5 }]);
    expect(index.victoryPointsByProvince.get(1)).toMatchObject([{ stateId: 1, value: 5 }]);
    expect(index.regionsById.get(1)?.provinces).toEqual([1, 2, 3, 4]);
    expect(index.supplyNodes).toMatchObject([{ level: 1, provinceId: 1 }]);
    expect(index.railways).toMatchObject([{ level: 1, provinces: [1, 4, 2] }]);
    expect(index.buildingPositions).toHaveLength(3);
    expect(index.unitPositions).toHaveLength(1);
    expect(index.weatherPositions.map(({ size }) => size)).toEqual(['small', 'big']);
    expect(index.entityLocators).toMatchObject([
      { entity: 'test_entity', name: 'test_locator', position: [1, 2, 3] },
    ]);
    expect(index.coastalProvinceIds).toEqual(new Set([1, 2, 3]));
    expect(index.ports).toMatchObject([
      { stateId: 1, provinceId: 1, level: 1, coastal: true, adjacentSeaProvinceIds: [3] },
    ]);
    const validation = validateMap(index);
    expect(
      validation.diagnostics.filter(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    ).toEqual([]);
  });

  it('bounds hostile numeric IDs and sparse maximum-ID allocation without range-sized work', async () => {
    const hugeDigits = '9'.repeat(400);
    const malformed = MapWorkspaceIndex.build([
      scannedText(
        'map/default.map',
        'definitions = "definition.csv"\nprovinces = "provinces.bmp"\n',
        0,
        'mod',
      ),
      scannedText('map/definition.csv', `${hugeDigits};1;2;3;land;false;plains;0\n`, 0, 'mod'),
      scannedText(
        'history/states/2147483648-BAD.txt',
        'state = { id = 2147483648 provinces = { } }\n',
        0,
        'mod',
      ),
      scannedText(
        'map/strategicregions/-1-BAD.txt',
        'strategic_region = { id = -1 provinces = { } }\n',
        0,
        'mod',
      ),
    ]);
    expect(malformed.definitions).toEqual([]);
    expect(malformed.states).toEqual([]);
    expect(malformed.regions).toEqual([]);
    expect(new Set(malformed.diagnostics.map(({ code }) => code))).toEqual(
      new Set(['MAP_DEFINITION_VALUE_INVALID', 'MAP_STATE_ID_INVALID', 'MAP_REGION_ID_INVALID']),
    );

    const definition = [
      '0;0;0;0;sea;false;ocean;0',
      '1;10;0;0;land;true;plains;1',
      '2;0;0;200;land;true;plains;1',
      '3;0;160;220;sea;true;ocean;0',
      '4;0;180;0;land;false;forest;1',
      '2147483647;17;18;19;land;false;plains;1',
      '',
    ].join('\n');
    const { snapshot } = await setup({ 'map/definition.csv': definition });
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'sparse-maximum-id',
        kind: 'create_province',
        sourceProvinceId: 4,
        geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(plan.blockers).toEqual([expect.objectContaining({ code: 'MAP_PROVINCE_ID_GAP' })]);
  });

  it('caps undefined bitmap colors and reports the true distinct total', async () => {
    const pixels = Array.from({ length: 300 }, (_, value) => ({
      r: (value >>> 16) & 0xff,
      g: (value >>> 8) & 0xff,
      b: value & 0xff,
    }));
    const bitmap = createBmp({
      width: 20,
      height: 15,
      bitsPerPixel: 24,
      dibSize: 124,
      rgbPixels: pixels,
    });
    const { snapshot } = await setup({
      'map/definition.csv': '0;0;0;0;sea;false;ocean;0\n',
      'map/provinces.bmp': bitmap,
    });
    expect(snapshot.index.raster?.unknownColors).toHaveLength(256);
    expect(snapshot.index.raster?.unknownColorCount).toBe(299);
    expect(validateMap(snapshot.index).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MAP_BITMAP_COLOR_SAMPLE_LIMIT',
          severity: 'blocker',
          details: { distinctColors: 299, retainedSamples: 256 },
        }),
      ]),
    );
  });

  it('caps map diagnostics with one deterministic truncation blocker', () => {
    const index = MapWorkspaceIndex.build([
      scannedText('map/default.map', 'definitions = "definition.csv"\n', 0, 'mod'),
      scannedText('map/definition.csv', 'malformed\n'.repeat(2_100), 0, 'mod'),
    ]);
    expect(index.diagnostics).toHaveLength(MAP_DIAGNOSTIC_LIMIT);
    expect(index.diagnostics.at(-1)).toMatchObject({
      code: 'MAP_DIAGNOSTICS_TRUNCATED',
      severity: 'blocker',
      details: { limit: MAP_DIAGNOSTIC_LIMIT, retained: MAP_DIAGNOSTIC_LIMIT - 1 },
    });
  });

  it('blocks aggregate map script models before parsing more than 5,000 files', () => {
    const files = Array.from({ length: 5_001 }, (_unused, index) =>
      scannedState(`history/states/${index + 1}-STATE.txt`, index + 1, 0, 'mod'),
    );
    expect(() =>
      MapWorkspaceIndex.build(
        files,
        {
          map: ['map'],
          states: ['history/states'],
          localisation: ['localisation', 'localisation_synced'],
        },
        SymbolIndex.build([]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MAP_MODEL_BUDGET_BLOCKED' }));
  });

  it('indexes port positions once instead of rescanning every position for every port', async () => {
    const positions = Array.from({ length: 100 }, (_unused, index) => {
      const x = [10, 70, 140, 210][index % 4]!;
      return `1;naval_base_spawn;${x};0;245;0;0`;
    }).join('\n');
    const state = [
      'state = {',
      '\tid = 1',
      '\tname = "STATE_1"',
      '\tmanpower = 1000',
      '\tstate_category = town',
      '\tprovinces = { 1 2 3 4 }',
      '\thistory = {',
      '\t\towner = AAA',
      '\t\tbuildings = {',
      '\t\t\t1 = { naval_base = 1 }',
      '\t\t\t2 = { naval_base = 1 }',
      '\t\t\t3 = { naval_base = 1 }',
      '\t\t\t4 = { naval_base = 1 }',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n');
    const lookup = vi.spyOn(MapWorkspaceIndex.prototype, 'provinceAtMapCoordinate');
    try {
      const { snapshot } = await setup({
        'history/states/1-ONE.txt': state,
        'map/buildings.txt': `${positions}\n`,
      });
      expect(lookup).toHaveBeenCalledTimes(100);
      expect(snapshot.index.ports).toHaveLength(4);
    } finally {
      lookup.mockRestore();
    }
  });

  it('diagnoses every baseline province-bitmap format change explicitly', async () => {
    const { snapshot } = await setup();
    const palette = [0, 1, 2, 3, 4].map(colorFor);
    const indexedPixels = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1)
        indexedPixels[y * 256 + x] = x < 64 ? 1 : x < 128 ? 4 : x < 192 ? 2 : 3;
    }
    const reformatted = createBmp({
      width: 256,
      height: 256,
      bitsPerPixel: 8,
      dibSize: 40,
      topDown: true,
      palette,
      indexedPixels,
    });
    const proposed = indexWithProposedChanges(snapshot.index, [
      { relativePath: 'map/provinces.bmp', content: reformatted },
    ]);
    const codes = new Set(
      validateMap(proposed, { baseline: snapshot.index }).diagnostics.map(({ code }) => code),
    );
    for (const code of [
      'MAP_BMP_DIB_CHANGED',
      'MAP_BMP_ORIENTATION_CHANGED',
      'MAP_BMP_PIXEL_OFFSET_CHANGED',
      'MAP_BMP_BIT_DEPTH_CHANGED',
      'MAP_BMP_PALETTE_CHANGED',
      'MAP_BMP_HEADER_CHANGED',
    ])
      expect(codes).toContain(code);
  });

  it('moves state provinces with explicit policies while preserving unrelated source text', async () => {
    const { snapshot } = await setup();
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'move-4',
        kind: 'move_state_provinces',
        sourceStateId: 1,
        targetStateId: 2,
        provinceIds: [4],
        distribution: movePolicy,
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.finalIndex.statesById.get(1)?.provinces).toEqual([1]);
    expect(plan.finalIndex.statesById.get(2)?.provinces).toEqual([2, 4]);
    const sourceChange = plan.changes.find(
      ({ relativePath }) => relativePath === 'history/states/1-ONE.txt',
    );
    if (sourceChange?.content === undefined || sourceChange.content === null)
      throw new Error('Expected source-state change is missing');
    const sourceText = Buffer.from(sourceChange.content).toString('utf8');
    expect(sourceText).toContain('# source comment must survive');
    expect(sourceText).toContain('unknown = { keep = yes }');
  });

  it('blocks unresolved state distribution choices instead of guessing', async () => {
    const { snapshot } = await setup();
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'ambiguous-move',
        kind: 'move_state_provinces',
        sourceStateId: 1,
        targetStateId: 2,
        provinceIds: [4],
        distribution: {
          stateValues: 'retain-in-current-states',
          ownership: 'retain-in-current-states',
          provinceBuildings: 'follow-province',
          victoryPoints: 'follow-province',
          strategicRegion: 'require-same',
        },
      } as never,
    ]);
    expect(plan.blockers).toMatchObject([
      { code: 'MAP_STATE_DISTRIBUTION_REQUIRED', operationId: 'ambiguous-move' },
    ]);
    expect(plan.diagnostics[0]).toMatchObject({
      severity: 'blocker',
      code: 'MAP_STATE_DISTRIBUTION_REQUIRED',
    });
  });

  it('asserts the VP-derived state capital while updating exact state values without writing a capital field', async () => {
    const { snapshot } = await setup();
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'update-state-1',
        kind: 'update_state',
        stateId: 1,
        changes: {
          capital: 4,
          manpower: 1234,
          category: 'large_town',
          resources: { steel: 12, aluminium: 3 },
          stateBuildings: { infrastructure: 4 },
          owner: 'CCC',
          controller: 'DDD',
          cores: ['AAA', 'CCC'],
          claims: ['EEE'],
          victoryPoints: [{ provinceId: 4, value: 9 }],
          provinceBuildings: {
            '1': { arms_factory: 2, naval_base: 2 },
            '4': { bunker: 1 },
          },
        },
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.finalIndex.statesById.get(1)).toMatchObject({
      capital: 4,
      manpower: 1234,
      category: 'large_town',
      owner: 'CCC',
      controller: 'DDD',
      cores: ['AAA', 'CCC'],
      claims: ['EEE'],
    });
    expect(plan.finalIndex.victoryPointsByProvince.get(4)).toMatchObject([{ value: 9 }]);
    expect(plan.finalIndex.ports).toMatchObject([{ provinceId: 1, level: 2 }]);
    const stateChange = plan.changes.find(
      ({ relativePath }) => relativePath === 'history/states/1-ONE.txt',
    );
    const text =
      stateChange?.content === null ? '' : Buffer.from(stateChange?.content ?? []).toString();
    expect(text).toContain('# source comment must survive');
    expect(text).toContain('unknown = { keep = yes }');
    expect(text).toContain('capital = 999');
    expect(text).not.toContain('capital = 4');

    const missingVictoryPoints = planMapOperations(snapshot.index, [
      {
        id: 'capital-without-vps',
        kind: 'update_state',
        stateId: 1,
        changes: { capital: 4 },
      },
    ]);
    expect(missingVictoryPoints.blockers).toMatchObject([
      { code: 'MAP_STATE_CAPITAL_ASSERTION_REQUIRES_VICTORY_POINTS' },
    ]);
    const mismatchedCapital = planMapOperations(snapshot.index, [
      {
        id: 'capital-mismatch',
        kind: 'update_state',
        stateId: 1,
        changes: { capital: 4, victoryPoints: [{ provinceId: 1, value: 10 }] },
      },
    ]);
    expect(mismatchedCapital.blockers).toMatchObject([
      { code: 'MAP_STATE_CAPITAL_ASSERTION_MISMATCH' },
    ]);
    const tiedCapital = planMapOperations(snapshot.index, [
      {
        id: 'capital-tie',
        kind: 'update_state',
        stateId: 1,
        changes: {
          capital: 1,
          victoryPoints: [
            { provinceId: 4, value: 9 },
            { provinceId: 1, value: 9 },
          ],
        },
      },
    ]);
    expect(tiedCapital.blockers).toEqual([]);
    expect(tiedCapital.finalIndex.statesById.get(1)?.capital).toBe(1);
  });

  it('migrates land, sea, and lake definitions only with complete dependency policies', async () => {
    const { snapshot } = await setup();
    const unresolved = planMapOperations(snapshot.index, [
      {
        id: 'type-policy-missing',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
      } as never,
    ]);
    expect(unresolved.blockers).toMatchObject([
      { code: 'MAP_PROVINCE_TYPE_DISTRIBUTION_REQUIRED', operationId: 'type-policy-missing' },
    ]);
    expect(unresolved.changes).toEqual([]);

    const inconsistent = planMapOperations(snapshot.index, [
      {
        id: 'type-policy-inconsistent',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
        distribution: {
          ...removeLandDependenciesPolicy,
          stateMembership: { method: 'retain' },
        },
      },
    ]);
    expect(inconsistent.blockers).toMatchObject([
      {
        code: 'MAP_PROVINCE_TYPE_DISTRIBUTION_INCONSISTENT',
        operationId: 'type-policy-inconsistent',
        details: { field: 'stateMembership' },
      },
    ]);
    expect(inconsistent.changes).toEqual([]);

    for (const [targetType, terrain, coastal] of [
      ['sea', 'ocean', true],
      ['lake', 'lakes', false],
    ] as const) {
      const plan = planMapOperations(snapshot.index, [
        {
          id: `land-to-${targetType}`,
          kind: 'update_province_definition',
          provinceId: 4,
          changes: { type: targetType, coastal, terrain, continent: 0 },
          distribution: removeLandDependenciesPolicy,
        },
      ]);
      expect(plan.blockers).toEqual([]);
      expect(plan.finalIndex.definitionsById.get(4)).toMatchObject({
        type: targetType,
        terrain,
        continent: 0,
      });
      expect(plan.finalIndex.statesById.get(1)?.provinces).toEqual([1]);
      expect(plan.finalIndex.statesById.get(1)?.provinceBuildings.has(4)).toBe(false);
      expect(plan.finalIndex.buildingPositions.some(({ x }) => x === 70)).toBe(false);
      expect(plan.finalIndex.railways).toEqual([]);
      expect(
        validateMap(plan.finalIndex).diagnostics.filter(
          ({ severity }) => severity === 'error' || severity === 'blocker',
        ),
      ).toEqual([]);
    }

    const waterToLand = planMapOperations(snapshot.index, [
      {
        id: 'coast-one-after-water-removal',
        kind: 'update_province_definition',
        provinceId: 1,
        changes: { coastal: false },
      },
      {
        id: 'coast-two-after-water-removal',
        kind: 'update_province_definition',
        provinceId: 2,
        changes: { coastal: false },
      },
      {
        id: 'sea-to-land',
        kind: 'update_province_definition',
        provinceId: 3,
        changes: { type: 'land', coastal: false, terrain: 'plains', continent: 1 },
        distribution: assignLandDependenciesPolicy,
      },
    ]);
    expect(waterToLand.blockers).toEqual([]);
    expect(waterToLand.finalIndex.statesById.get(2)?.provinces).toEqual([2, 3]);
    expect(waterToLand.finalIndex.ports).toEqual([]);
    expect(
      validateMap(waterToLand.finalIndex).diagnostics.filter(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    ).toEqual([]);

    const strictPayload = {
      id: 'strict-type-policy',
      kind: 'update_province_definition',
      provinceId: 4,
      changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
      distribution: removeLandDependenciesPolicy,
    } as const;
    expect(mapOperationSchema.safeParse(strictPayload).success).toBe(true);
    expect(
      mapOperationSchema.safeParse({
        ...strictPayload,
        distribution: { stateMembership: { method: 'remove', stateId: 1 } },
      }).success,
    ).toBe(false);
    expect(
      mapOperationSchema.safeParse({
        ...strictPayload,
        distribution: { ...removeLandDependenciesPolicy, guessed: true },
      }).success,
    ).toBe(false);
  });

  it('splits exact province pixels, allocates a contiguous ID and unused color, and changes no outside pixels', async () => {
    const { snapshot } = await setup();
    const mask = [];
    for (let y = 0; y < 256; y += 1) for (let x = 96; x < 128; x += 1) mask.push({ x, y });
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'split-province-4',
        kind: 'split_province',
        sourceProvinceId: 4,
        provinceId: 5,
        geometry: { kind: 'pixels', pixels: mask },
        definition: {
          method: 'inherit-source',
          overrides: { color: { r: 120, g: 121, b: 122 } },
        },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.allocations).toMatchObject([
      { kind: 'province-id', allocated: 5, contiguousBefore: true },
      {
        kind: 'province-color',
        strategy: 'sha256-seeded-linear-probe-excluding-definition-and-bitmap-colors',
      },
    ]);
    expect(plan.expectedChangedBounds).toEqual({
      minX: 96,
      minY: 0,
      maxX: 127,
      maxY: 255,
      count: 8192,
    });
    expect(plan.finalIndex.statesById.get(1)?.provinces).toEqual([1, 4, 5]);
    expect(plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 2, 3, 4, 5]);
    const finalBitmap = plan.finalIndex.provinceBitmap;
    if (finalBitmap === undefined) throw new Error('Expected proposed province bitmap');
    expect(snapshot.index.provinceBitmap?.diffBounds(finalBitmap)).toEqual(
      plan.expectedChangedBounds,
    );
    expect(plan.finalIndex.provinceBitmap?.rgbAt(95, 10)).toEqual(provinceColors[4]);
    expect(plan.finalIndex.provinceBitmap?.rgbAt(96, 10)).toEqual(
      plan.finalIndex.definitionsById.get(5)?.color,
    );
    expect(plan.allocations[0]?.strategy).toBe('explicit-request-after-full-scan');
    const collision = planMapOperations(snapshot.index, [
      {
        id: 'colliding-province-id',
        kind: 'create_province',
        sourceProvinceId: 4,
        provinceId: 4,
        geometry: { kind: 'pixels', pixels: mask },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(collision.blockers).toMatchObject([{ code: 'MAP_PROVINCE_ID_COLLISION' }]);
  });

  it('bounds polygon and raster-mask geometry before expensive selection work', async () => {
    const baseOperation = {
      id: 'bounded-polygon',
      kind: 'split_province' as const,
      sourceProvinceId: 4,
      definition: { method: 'inherit-source' as const },
      distribution: splitProvincePolicy,
    };
    expect(
      mapOperationSchema.safeParse({
        ...baseOperation,
        geometry: {
          kind: 'polygon',
          points: Array.from({ length: 4_097 }, (_, index) => ({ x: index, y: index })),
        },
      }).success,
    ).toBe(false);
    expect(
      mapOperationSchema.safeParse({
        ...baseOperation,
        geometry: {
          kind: 'mask',
          width: 10_000,
          height: 10_000,
          origin: { x: 0, y: 0 },
          selectedPixelCount: 1,
          sha256: '0'.repeat(64),
          data: 'AAAA',
        },
      }).success,
    ).toBe(false);
    expect(
      mapOperationSchema.safeParse({
        ...baseOperation,
        geometry: {
          kind: 'mask',
          width: 1_000,
          height: 1_000,
          origin: { x: 0, y: 0 },
          selectedPixelCount: MAP_SELECTED_PIXEL_LIMIT,
          sha256: '0'.repeat(64),
          data: 'AAAA',
        },
      }).success,
    ).toBe(true);
    expect(
      mapOperationSchema.safeParse({
        ...baseOperation,
        geometry: {
          kind: 'mask',
          width: 1_001,
          height: 1_000,
          origin: { x: 0, y: 0 },
          selectedPixelCount: MAP_SELECTED_PIXEL_LIMIT + 1,
          sha256: '0'.repeat(64),
          data: 'AAAA',
        },
      }).success,
    ).toBe(false);

    const { snapshot } = await setup();
    const oversizedMask = planMapOperations(snapshot.index, [
      {
        ...baseOperation,
        id: 'oversized-selected-mask',
        geometry: {
          kind: 'mask',
          width: 1,
          height: 1,
          origin: { x: 96, y: 0 },
          selectedPixelCount: MAP_SELECTED_PIXEL_LIMIT + 1,
          sha256: '0'.repeat(64),
          data: 'AAAA',
        },
      },
    ]);
    expect(oversizedMask.blockers).toMatchObject([
      {
        code: 'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
        details: {
          selectedPixels: MAP_SELECTED_PIXEL_LIMIT + 1,
          maximumSelectedPixels: MAP_SELECTED_PIXEL_LIMIT,
        },
      },
    ]);
    expect(oversizedMask.changes).toEqual([]);
    const points = Array.from({ length: 1_000 }, (_, index) =>
      index % 4 === 0
        ? { x: 0, y: 0 }
        : index % 4 === 1
          ? { x: 255, y: 0 }
          : index % 4 === 2
            ? { x: 255, y: 255 }
            : { x: 0, y: 255 },
    );
    expect(
      mapOperationSchema.safeParse({ ...baseOperation, geometry: { kind: 'polygon', points } })
        .success,
    ).toBe(true);
    const plan = planMapOperations(snapshot.index, [
      { ...baseOperation, geometry: { kind: 'polygon', points } },
    ]);
    expect(plan.blockers).toMatchObject([{ code: 'MAP_POLYGON_WORK_LIMIT' }]);
  });

  it('blocks province recolor materialization from indexed counts before scanning the raster', async () => {
    const oversizedPixelCount = 1_001 * 1_000;
    const oversizedBitmap = createBmp({
      width: 1_001,
      height: 1_000,
      bitsPerPixel: 24,
      rgbPixels: Array(oversizedPixelCount).fill(colorFor(4)) as RgbColor[],
    });
    const { snapshot } = await setup({ 'map/provinces.bmp': oversizedBitmap });
    const raster = snapshot.index.raster;
    const sourceGeometry = raster?.geometry.get(4);
    if (raster === undefined || sourceGeometry === undefined) {
      throw new Error('Expected fixture raster geometry');
    }
    expect(sourceGeometry.pixelCount).toBe(oversizedPixelCount);

    const update = planMapOperations(snapshot.index, [
      {
        id: 'oversized-province-recolor',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { color: { r: 90, g: 91, b: 92 } },
      },
    ]);
    expect(update.blockers).toMatchObject([
      {
        code: 'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
        details: { selectedPixels: oversizedPixelCount },
      },
    ]);
    expect(update.changes).toEqual([]);

    const merge = planMapOperations(snapshot.index, [
      {
        id: 'oversized-merge-recolor',
        kind: 'merge_provinces',
        sourceProvinceIds: [4],
        targetProvinceId: 1,
        distribution: mergeProvincePolicy,
      },
    ]);
    expect(merge.blockers).toMatchObject([
      {
        code: 'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
        details: { selectedPixels: oversizedPixelCount },
      },
    ]);
    expect(merge.changes).toEqual([]);
  });

  it('accepts a hash-bound raster-mask manifest and rejects altered dimensions, counts, or payload hashes', async () => {
    const { snapshot } = await setup();
    const bytes = Buffer.alloc(32 * 256, 1);
    const geometry = {
      kind: 'mask' as const,
      width: 32,
      height: 256,
      origin: { x: 96, y: 0 },
      selectedPixelCount: bytes.length,
      sha256: sha256Bytes(bytes),
      data: bytes.toString('base64'),
    };
    expect(
      mapOperationSchema.safeParse({
        id: 'schema-raster-mask',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry,
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      }).success,
    ).toBe(true);
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'split-raster-mask',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry,
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.expectedChangedBounds).toEqual({
      minX: 96,
      minY: 0,
      maxX: 127,
      maxY: 255,
      count: 8192,
    });
    const wrongDimensions = planMapOperations(snapshot.index, [
      {
        id: 'wrong-mask-dimensions',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { ...geometry, width: 31 },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(wrongDimensions.blockers).toMatchObject([
      { code: 'MAP_RASTER_MASK_DIMENSIONS_MISMATCH' },
    ]);
    const wrongCount = planMapOperations(snapshot.index, [
      {
        id: 'wrong-mask-count',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { ...geometry, selectedPixelCount: bytes.length - 1 },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(wrongCount.blockers).toMatchObject([{ code: 'MAP_RASTER_MASK_COUNT_MISMATCH' }]);
    const wrongHash = planMapOperations(snapshot.index, [
      {
        id: 'wrong-mask-hash',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { ...geometry, sha256: '0'.repeat(64) },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(wrongHash.blockers).toMatchObject([{ code: 'MAP_RASTER_MASK_HASH_MISMATCH' }]);
    const wrongOrigin = planMapOperations(snapshot.index, [
      {
        id: 'wrong-mask-origin',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { ...geometry, origin: { x: 240, y: 0 } },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(wrongOrigin.blockers).toMatchObject([{ code: 'MAP_RASTER_MASK_DIMENSIONS_MISMATCH' }]);
    const wrongSource = planMapOperations(snapshot.index, [
      {
        id: 'wrong-mask-source',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { ...geometry, origin: { x: 32, y: 0 } },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(wrongSource.blockers).toMatchObject([{ code: 'MAP_GEOMETRY_OUTSIDE_SOURCE' }]);
    const nonBinaryBytes = Buffer.from(bytes);
    nonBinaryBytes[0] = 2;
    const wrongEncoding = planMapOperations(snapshot.index, [
      {
        id: 'wrong-mask-encoding',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: {
          ...geometry,
          sha256: sha256Bytes(nonBinaryBytes),
          data: nonBinaryBytes.toString('base64'),
        },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(wrongEncoding.blockers).toMatchObject([{ code: 'MAP_RASTER_MASK_ENCODING_INVALID' }]);
    expect(wrongDimensions.changes).toEqual([]);
    expect(wrongCount.changes).toEqual([]);
    expect(wrongHash.changes).toEqual([]);
    expect(wrongOrigin.changes).toEqual([]);
    expect(wrongSource.changes).toEqual([]);
    expect(wrongEncoding.changes).toEqual([]);
  });

  it('allocates the lowest unused positive state ID across active roots', async () => {
    const { snapshot } = await setup();
    const index = MapWorkspaceIndex.build([
      ...snapshot.index.sourceFiles,
      scannedState('history/states/3-GAME.txt', 3, 0, 'game'),
    ]);
    const plan = planMapOperations(index, [
      {
        id: 'split-across-roots',
        kind: 'split_state',
        sourceStateId: 1,
        provinceIds: [4],
        name: 'STATE_4',
        localisation: { method: 'existing', language: 'l_english' },
        distribution: splitStatePolicy,
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.allocations[0]).toMatchObject({
      kind: 'state-id',
      allocated: 4,
      highestObserved: 3,
      contiguousBefore: true,
      strategy: 'lowest-positive-unused-active-id-across-roots',
    });
    expect(plan.allocations[0]?.roots.map(({ rootKind }) => rootKind)).toContain('game');
    expect(plan.allocations[0]?.roots.map(({ rootKind }) => rootKind)).toContain('mod');
  });

  it('upserts state localisation without disturbing BOM, comments, versions, spacing, or unrelated entries and blocks ambiguous or unsafe sources', async () => {
    const { snapshot } = await setup();
    const localisedStatePayload = {
      id: 'schema-localised-state',
      kind: 'create_state',
      sourceStateId: 1,
      stateId: 3,
      provinceIds: [4],
      name: 'STATE_SCHEMA',
      localisation: {
        method: 'upsert',
        language: 'l_english',
        value: 'Schema State',
        file: 'localisation/english/schema_l_english.yml',
      },
      distribution: splitStatePolicy,
    } as const;
    expect(mapOperationSchema.safeParse(localisedStatePayload).success).toBe(true);
    expect(
      mapOperationSchema.safeParse({
        ...localisedStatePayload,
        localisation: { ...localisedStatePayload.localisation, guessed: true },
      }).success,
    ).toBe(false);
    const localisation = snapshot.index.sourceFiles.find(
      ({ relativePath }) => relativePath === 'localisation/english/map_l_english.yml',
    );
    if (localisation === undefined) throw new Error('Expected localisation fixture');
    const customBytes = Buffer.from(
      '\ufeffl_english:\n# keep this comment\nSTATE_1: "One"\nSTATE_2: "Two"\nSTATE_3:7   "Three" # keep tail\nSTATE_4: "Four"\n',
      'utf8',
    );
    const customFile = {
      ...localisation,
      bytes: customBytes,
      size: customBytes.length,
      sha256: sha256Bytes(customBytes),
    };
    const customIndex = MapWorkspaceIndex.build(
      snapshot.index.sourceFiles.map((file) =>
        file.displayPath === localisation.displayPath ? customFile : file,
      ),
    );
    const updated = planMapOperations(customIndex, [
      {
        id: 'update-state-localisation',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 3,
        provinceIds: [4],
        name: 'STATE_3',
        localisation: {
          method: 'upsert',
          language: 'l_english',
          value: 'Three "quoted" \\ path\nSecond line',
          file: 'localisation/english/map_l_english.yml',
        },
        distribution: splitStatePolicy,
      },
    ]);
    expect(updated.blockers).toEqual([]);
    const changed = updated.changes.find(
      ({ relativePath }) => relativePath === 'localisation/english/map_l_english.yml',
    )?.content;
    expect(changed?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const changedText =
      changed === null || changed === undefined
        ? ''
        : Buffer.from(changed).subarray(3).toString('utf8');
    expect(changedText).toContain('# keep this comment');
    expect(changedText).toContain(
      'STATE_3:7   "Three \\"quoted\\" \\\\ path\\nSecond line" # keep tail',
    );
    expect(changedText).toContain('STATE_4: "Four"');
    expect(updated.finalIndex.localisationByKey.get('l_english:STATE_3')?.[0]?.entry.value).toBe(
      'Three "quoted" \\ path\nSecond line',
    );

    const appended = planMapOperations(customIndex, [
      {
        id: 'append-state-localisation',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 3,
        provinceIds: [4],
        name: 'STATE_APPENDED',
        localisation: {
          method: 'upsert',
          language: 'l_english',
          value: 'Appended State',
          file: 'localisation/english/map_l_english.yml',
        },
        distribution: splitStatePolicy,
      },
    ]);
    expect(appended.blockers).toEqual([]);
    expect(
      appended.finalIndex.localisationByKey.get('l_english:STATE_APPENDED')?.[0]?.entry.value,
    ).toBe('Appended State');

    const missingTarget = planMapOperations(customIndex, [
      {
        id: 'missing-state-localisation-target',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 3,
        provinceIds: [4],
        name: 'STATE_TARGET_REQUIRED',
        localisation: {
          method: 'upsert',
          language: 'l_english',
          value: 'Target Required',
        },
        distribution: splitStatePolicy,
      },
    ]);
    expect(missingTarget.blockers).toMatchObject([
      { code: 'MAP_STATE_LOCALISATION_TARGET_REQUIRED' },
    ]);
    const missingExisting = planMapOperations(customIndex, [
      {
        id: 'missing-existing-state-localisation',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 3,
        provinceIds: [4],
        name: 'STATE_DOES_NOT_EXIST',
        localisation: { method: 'existing', language: 'l_english' },
        distribution: splitStatePolicy,
      },
    ]);
    expect(missingExisting.blockers).toMatchObject([{ code: 'MAP_STATE_LOCALISATION_MISSING' }]);
    const unsafeTarget = planMapOperations(customIndex, [
      {
        id: 'unsafe-state-localisation-target',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 3,
        provinceIds: [4],
        name: 'STATE_UNSAFE_TARGET',
        localisation: {
          method: 'upsert',
          language: 'l_english',
          value: 'Unsafe Target',
          file: '../outside_l_english.yml',
        },
        distribution: splitStatePolicy,
      },
    ]);
    expect(unsafeTarget.blockers).toMatchObject([
      { code: 'MAP_STATE_LOCALISATION_TARGET_INVALID' },
    ]);

    const duplicateBytes = Buffer.from('\ufeffl_english:\nSTATE_3: "Duplicate"\n', 'utf8');
    const duplicate: ScannedFile = {
      absolutePath: 'mod:/localisation/english/duplicate_l_english.yml',
      displayPath: 'mod:localisation/english/duplicate_l_english.yml',
      relativePath: 'localisation/english/duplicate_l_english.yml',
      rootKind: 'mod',
      loadOrder: localisation.loadOrder,
      size: duplicateBytes.length,
      modifiedMs: 0,
      sha256: sha256Bytes(duplicateBytes),
      bytes: duplicateBytes,
    };
    const ambiguous = planMapOperations(
      MapWorkspaceIndex.build([...customIndex.sourceFiles, duplicate]),
      [
        {
          id: 'ambiguous-state-localisation',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 3,
          provinceIds: [4],
          name: 'STATE_3',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: splitStatePolicy,
        },
      ],
    );
    expect(ambiguous.blockers).toMatchObject([{ code: 'MAP_STATE_LOCALISATION_AMBIGUOUS' }]);
    expect(ambiguous.changes).toEqual([]);

    const noBom = Buffer.from(customBytes.subarray(3));
    const unsafeIndex = MapWorkspaceIndex.build(
      customIndex.sourceFiles.map((file) =>
        file.displayPath === localisation.displayPath
          ? {
              ...file,
              bytes: noBom,
              size: noBom.length,
              sha256: sha256Bytes(noBom),
            }
          : file,
      ),
    );
    const unsafe = planMapOperations(unsafeIndex, [
      {
        id: 'unsafe-state-localisation',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 3,
        provinceIds: [4],
        name: 'STATE_3',
        localisation: { method: 'upsert', language: 'l_english', value: 'Unsafe' },
        distribution: splitStatePolicy,
      },
    ]);
    expect(unsafe.blockers).toMatchObject([{ code: 'MAP_STATE_LOCALISATION_ENCODING_INVALID' }]);
  });

  it('maps lower-root province ID conflicts to the allocating operation', async () => {
    const { snapshot } = await setup();
    const lowerBytes = Buffer.from(
      `${Buffer.from(snapshot.index.definitionFile?.bytes ?? Buffer.alloc(0)).toString(
        'utf8',
      )}5;90;91;92;land;false;plains;1\n`,
    );
    const lowerDefinition: ScannedFile = {
      absolutePath: 'game:/map/definition.csv',
      displayPath: 'game:map/definition.csv',
      relativePath: 'map/definition.csv',
      rootKind: 'game',
      loadOrder: -1,
      size: lowerBytes.length,
      modifiedMs: 0,
      sha256: sha256Bytes(lowerBytes),
      bytes: lowerBytes,
    };
    const index = MapWorkspaceIndex.build([...snapshot.index.sourceFiles, lowerDefinition]);
    const plan = planMapOperations(index, [
      {
        id: 'dependency-id-conflict',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(plan.blockers).toMatchObject([
      {
        code: 'MAP_DEPENDENCY_PROVINCE_ID_CONFLICT',
        operationId: 'dependency-id-conflict',
        details: { provinceId: 5, source: 'game:map/definition.csv' },
      },
    ]);

    const lowerColorBytes = Buffer.from(
      Buffer.from(snapshot.index.definitionFile?.bytes ?? Buffer.alloc(0))
        .toString('utf8')
        .replace('4;0;180;0;', '4;90;91;92;'),
    );
    const lowerColorDefinition: ScannedFile = {
      ...lowerDefinition,
      size: lowerColorBytes.length,
      sha256: sha256Bytes(lowerColorBytes),
      bytes: lowerColorBytes,
    };
    const colorIndex = MapWorkspaceIndex.build([
      ...snapshot.index.sourceFiles,
      lowerColorDefinition,
    ]);
    const colorPlan = planMapOperations(colorIndex, [
      {
        id: 'dependency-color-conflict',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
        definition: {
          method: 'inherit-source',
          overrides: { color: { r: 90, g: 91, b: 92 } },
        },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(colorPlan.blockers).toMatchObject([
      {
        code: 'MAP_DEPENDENCY_PROVINCE_COLOR_CONFLICT',
        operationId: 'dependency-color-conflict',
        details: { source: 'game:map/definition.csv' },
      },
    ]);
  });

  it("aggregates allocation and collision evidence from every root's own default.map definition filename", async () => {
    const { snapshot } = await setup();
    const gameDefault = scannedText(
      'map/default.map',
      'definitions = "game_definitions.csv"\n',
      -2,
      'game',
    );
    const gameDefinitions = scannedText(
      'map/game_definitions.csv',
      '20;90;91;92;land;false;plains;1\n',
      -2,
      'game',
    );
    const dependencyDefault = scannedText(
      'map/default.map',
      'definitions = "dependency_definitions.csv"\n',
      -1,
      'dependency',
    );
    const dependencyDefinitions = scannedText(
      'map/dependency_definitions.csv',
      '21;93;94;95;land;false;forest;1\n',
      -1,
      'dependency',
    );
    const index = MapWorkspaceIndex.build([
      ...snapshot.index.sourceFiles,
      gameDefault,
      gameDefinitions,
      dependencyDefault,
      dependencyDefinitions,
    ]);
    expect(
      index.definitionsAcrossRoots.map(({ id, document }) => ({
        id,
        file: document.file.displayPath,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: 20, file: 'game:map/game_definitions.csv' },
        { id: 21, file: 'dependency:map/dependency_definitions.csv' },
      ]),
    );
    const automatic = planMapOperations(index, [
      {
        id: 'allocate-after-root-selected-definitions',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(automatic.blockers).toEqual([]);
    expect(automatic.allocations[0]).toMatchObject({
      kind: 'province-id',
      allocated: 5,
      highestObserved: 4,
    });
    expect(automatic.allocations[0]?.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ samplePath: 'game:map/game_definitions.csv', maximumId: 20 }),
        expect.objectContaining({
          samplePath: 'dependency:map/dependency_definitions.csv',
          maximumId: 21,
        }),
      ]),
    );
    const idCollision = planMapOperations(index, [
      {
        id: 'root-selected-id-collision',
        kind: 'create_province',
        sourceProvinceId: 4,
        provinceId: 20,
        geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
        definition: { method: 'inherit-source' },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(idCollision.blockers).toMatchObject([
      {
        code: 'MAP_DEPENDENCY_PROVINCE_ID_CONFLICT',
        details: { sources: ['game:map/game_definitions.csv'] },
      },
    ]);
    const colorCollision = planMapOperations(index, [
      {
        id: 'root-selected-color-collision',
        kind: 'create_province',
        sourceProvinceId: 4,
        provinceId: 5,
        geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
        definition: {
          method: 'inherit-source',
          overrides: { color: { r: 93, g: 94, b: 95 } },
        },
        distribution: splitProvincePolicy,
      },
    ]);
    expect(colorCollision.blockers).toMatchObject([
      {
        code: 'MAP_DEPENDENCY_PROVINCE_COLOR_CONFLICT',
        details: { source: 'dependency:map/dependency_definitions.csv' },
      },
    ]);
  });

  it('blocks a capped dependency default.map before allocation can miss its selected collisions', async () => {
    const { snapshot } = await setup();
    const dependencyDefault = scannedText(
      'map/default.map',
      `${'value = yes '.repeat(Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1)}\ndefinitions = "dependency_definitions.csv"\n`,
      -1,
      'dependency',
    );
    const hiddenDependencyDefinitions = scannedText(
      'map/dependency_definitions.csv',
      '5;93;94;95;land;false;forest;1\n',
      -1,
      'dependency',
    );

    expect(() =>
      MapWorkspaceIndex.build([
        ...snapshot.index.sourceFiles,
        dependencyDefault,
        hiddenDependencyDefinitions,
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'MAP_DEFAULT_MAP_SELECTOR_BLOCKED',
        details: expect.objectContaining({
          path: 'dependency:map/default.map',
          rootKind: 'dependency',
          reasonCodes: ['SOURCE_MISSING_VALUE', 'SOURCE_TOKEN_LIMIT'],
        }),
      }),
    );
  });

  it('fills sparse state-ID holes and accepts explicit free IDs while refusing cross-root collisions', async () => {
    const { snapshot } = await setup();
    const sparse = MapWorkspaceIndex.build([
      ...snapshot.index.sourceFiles,
      scannedState('history/states/5-GAME.txt', 5, 0, 'game'),
    ]);
    const automatic = planMapOperations(sparse, [
      {
        id: 'fill-state-hole',
        kind: 'split_state',
        sourceStateId: 1,
        provinceIds: [4],
        name: 'STATE_3',
        localisation: { method: 'existing', language: 'l_english' },
        distribution: splitStatePolicy,
      },
    ]);
    expect(automatic.allocations[0]).toMatchObject({
      allocated: 3,
      strategy: 'lowest-positive-unused-active-id-across-roots',
      contiguousBefore: false,
    });
    const explicit = planMapOperations(sparse, [
      {
        id: 'explicit-state-id',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 10,
        provinceIds: [4],
        name: 'STATE_10',
        localisation: { method: 'existing', language: 'l_english' },
        distribution: splitStatePolicy,
      },
    ]);
    expect(explicit.blockers).toEqual([]);
    expect(explicit.allocations[0]).toMatchObject({
      allocated: 10,
      strategy: 'explicit-request-after-full-scan',
    });
    const collision = planMapOperations(sparse, [
      {
        id: 'colliding-state-id',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: 5,
        provinceIds: [4],
        distribution: splitStatePolicy,
      },
    ]);
    expect(collision.blockers).toMatchObject([{ code: 'MAP_STATE_ID_COLLISION' }]);
  });

  it('merges top province IDs and remaps network references deterministically', async () => {
    const { snapshot } = await setup();
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'merge-province-4',
        kind: 'merge_provinces',
        sourceProvinceIds: [4],
        targetProvinceId: 1,
        distribution: {
          membership: 'require-same',
          victoryPoints: 'sum-into-target',
          provinceBuildings: 'sum-into-target',
          references: 'remap-to-target-and-deduplicate',
        },
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.finalIndex.definitionsById.has(4)).toBe(false);
    expect(plan.finalIndex.statesById.get(1)?.provinces).toEqual([1]);
    expect(plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 2, 3]);
    expect(plan.finalIndex.railways).toMatchObject([{ provinces: [1, 2] }]);
    expect(plan.finalIndex.provinceBitmap?.rgbAt(70, 20)).toEqual(provinceColors[1]);
    expect(
      validateMap(plan.finalIndex).diagnostics.filter(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    ).toEqual([]);
  });

  it('removes a middle province ID, compacts a higher target, and remaps every connected province reference', async () => {
    const { snapshot } = await setup(provinceRenumberFixtureFiles());
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'merge-middle-province-2',
        kind: 'remove_province',
        provinceId: 2,
        mergeIntoProvinceId: 4,
        distribution: mergeProvincePolicy,
      },
    ]);

    expect(plan.blockers).toEqual([]);
    expect([...plan.finalIndex.definitionsById.keys()].sort((left, right) => left - right)).toEqual(
      [0, 1, 2, 3],
    );
    expect(plan.finalIndex.definitionsById.get(2)).toMatchObject({
      color: provinceColors[3],
      type: 'sea',
    });
    expect(plan.finalIndex.definitionsById.get(3)).toMatchObject({
      color: provinceColors[4],
      type: 'land',
      coastal: true,
    });
    expect(plan.finalIndex.statesById.get(1)).toMatchObject({
      provinces: [1, 3],
      capital: 3,
      victoryPoints: [
        { provinceId: 1, value: 5 },
        { provinceId: 3, value: 10 },
      ],
    });
    expect(plan.finalIndex.statesById.get(1)?.provinceBuildings).toEqual(
      new Map([
        [1, new Map([['arms_factory', 1]])],
        [
          3,
          new Map([
            ['arms_factory', 6],
            ['naval_base', 1],
          ]),
        ],
      ]),
    );
    expect(plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 2, 3]);
    expect(plan.finalIndex.adjacencies).toMatchObject([
      { from: 1, to: 3, through: 2, comment: 'keep-first-comment' },
    ]);
    expect(plan.finalIndex.supplyNodes).toMatchObject([
      { level: 1, provinceId: 3 },
      { level: 1, provinceId: 1 },
    ]);
    expect(plan.finalIndex.railways).toMatchObject([{ level: 1, provinces: [1, 3] }]);
    expect(plan.finalIndex.unitPositions.map(({ provinceId }) => provinceId)).toEqual([3, 3, 1]);
    expect(
      plan.finalIndex.buildingPositions.map(({ adjacentSeaProvince }) => adjacentSeaProvince),
    ).toEqual([2, 0]);
    expect(plan.finalIndex.provinceBitmap?.rgbAt(140, 20)).toEqual(provinceColors[4]);

    const definition = plan.finalIndex.definitionFile?.bytes;
    expect(definition?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const definitionText = definition?.toString('utf8') ?? '';
    expect(definitionText).toContain('# definition comments and row order must survive\r\n');
    expect(definitionText).toContain('2;0;160;220;sea;true;ocean;0;# shifted sea row\r\n');
    expect(definitionText).toContain('3;0;180;0;land;true;forest;1;# merge target row\r\n');
    const activeText = (relativePath: string): string =>
      plan.finalIndex.activeFiles.byRelativePath.get(relativePath)?.bytes.toString('utf8') ?? '';
    expect(activeText('history/states/1-one.txt')).toContain('# state comment must survive\r\n');
    expect(activeText('map/strategicregions/1-region.txt')).toContain(
      '# region comment must survive\r\n',
    );
    expect(activeText('map/adjacencies.csv')).toContain('keep-first-comment\r\n');
    expect(activeText('map/adjacencies.csv')).not.toContain('remove-second-comment');
    expect(activeText('map/supply_nodes.txt')).toContain('1 3 # source-node-comment\r\n');
    expect(activeText('map/supply_nodes.txt')).not.toContain('target-node-comment');
    expect(activeText('map/railways.txt')).toContain('1 2 1 3 # trunk-comment\r\n');
    expect(activeText('map/railways.txt')).not.toContain('collapsed-comment');
    expect(activeText('map/unitstacks.txt')).toContain(
      '3;0;140;0;245;0;0;# source-unit-comment\r\n',
    );
    expect(activeText('map/buildings.txt')).toContain(
      '1;naval_base_spawn;140;0;245;0;2;# port-comment\r\n',
    );
    expect(
      validateMap(plan.finalIndex).diagnostics.filter(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    ).toEqual([]);
  });

  it('applies and rolls back a multi-source arbitrary-ID merge byte-for-byte', async () => {
    const { mod, nudger, transactions } = await setup(provinceRenumberFixtureFiles());
    const result = await nudger.plan({
      workspaceId: 'map-test',
      operations: [
        {
          id: 'merge-multiple-provinces-into-higher-target',
          kind: 'merge_provinces',
          sourceProvinceIds: [1, 2],
          targetProvinceId: 4,
          distribution: mergeProvincePolicy,
        },
      ],
    });

    expect(result.plan.blockers).toEqual([]);
    expect(result.transaction.validation.passed).toBe(true);
    expect(
      [...result.plan.finalIndex.definitionsById.keys()].sort((left, right) => left - right),
    ).toEqual([0, 1, 2]);
    expect(result.plan.finalIndex.definitionsById.get(1)).toMatchObject({
      color: provinceColors[3],
      type: 'sea',
    });
    expect(result.plan.finalIndex.definitionsById.get(2)).toMatchObject({
      color: provinceColors[4],
      type: 'land',
      coastal: true,
    });
    expect(result.plan.finalIndex.statesById.get(1)).toMatchObject({
      provinces: [2],
      capital: 2,
      victoryPoints: [{ provinceId: 2, value: 15 }],
    });
    expect(result.plan.finalIndex.statesById.get(1)?.provinceBuildings).toEqual(
      new Map([
        [
          2,
          new Map([
            ['arms_factory', 7],
            ['naval_base', 1],
          ]),
        ],
      ]),
    );
    expect(result.plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 2]);
    expect(result.plan.finalIndex.adjacencies).toEqual([]);
    expect(result.plan.finalIndex.supplyNodes).toMatchObject([{ level: 1, provinceId: 2 }]);
    expect(result.plan.finalIndex.railways).toEqual([]);
    expect(result.plan.finalIndex.unitPositions.map(({ provinceId }) => provinceId)).toEqual([
      2, 2, 2,
    ]);
    expect(
      result.plan.finalIndex.buildingPositions.map(
        ({ adjacentSeaProvince }) => adjacentSeaProvince,
      ),
    ).toEqual([1, 0]);

    const originals = new Map(
      await Promise.all(
        result.transaction.files.map(
          async ({ relativePath }) =>
            [relativePath, await readFile(path.join(mod, relativePath))] as const,
        ),
      ),
    );
    const applied = await transactions.apply(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    const appliedSnapshot = await nudger.scan('map-test');
    expect(
      [...appliedSnapshot.index.definitionsById.keys()].sort((left, right) => left - right),
    ).toEqual([0, 1, 2]);
    expect(appliedSnapshot.index.statesById.get(1)?.provinces).toEqual([2]);

    const rolledBack = await transactions.rollback(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
    );
    expect(rolledBack.state).toBe('rolled_back');
    for (const [relativePath, original] of originals)
      expect(await readFile(path.join(mod, relativePath))).toEqual(original);
  });

  it('merges state IDs with explicit sum/union/follow policies', async () => {
    const { snapshot } = await setup();
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'merge-state-2',
        kind: 'merge_states',
        sourceStateIds: [2],
        targetStateId: 1,
        distribution: {
          stateValues: 'sum-into-target',
          ownership: 'retain-target',
          controller: 'retain-target',
          cores: 'union',
          claims: 'union',
          victoryPoints: 'follow-province',
          provinceBuildings: 'follow-province',
          ports: 'follow-province',
          supplyNodes: 'follow-province',
          railways: 'follow-province',
          positions: 'follow-province',
          strategicRegion: 'require-same',
        },
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.finalIndex.statesById.has(2)).toBe(false);
    expect(plan.finalIndex.statesById.get(1)).toMatchObject({
      manpower: 1500,
      owner: 'AAA',
      provinces: [1, 2, 4],
      cores: ['AAA', 'BBB'],
    });
    expect(
      plan.changes.find(({ relativePath }) => relativePath === 'history/states/2-TWO.txt'),
    ).toMatchObject({
      content: null,
    });
    expect(plan.finalIndex.buildingPositions.find(({ x }) => x === 140)).toMatchObject({
      stateId: 1,
    });
  });

  it('adds and removes bitmap-derived normal adjacency through exact validated pixel transfers', async () => {
    const { snapshot } = await setup();
    const addNormal = {
      id: 'schema-add-normal-adjacency',
      kind: 'add_normal_adjacency',
      from: 1,
      to: 2,
      pixelTransfers: [{ x: 127, y: 10, sourceProvinceId: 4, targetProvinceId: 1 }],
    } as const;
    expect(mapOperationSchema.safeParse(addNormal).success).toBe(true);
    expect(mapOperationSchema.safeParse({ ...addNormal, inferredCorridor: true }).success).toBe(
      false,
    );
    const removeBoundary = Array.from({ length: 256 }, (_, y) => ({
      x: 191,
      y,
      sourceProvinceId: 2,
      targetProvinceId: 1,
    }));
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'add-normal-1-2',
        kind: 'add_normal_adjacency',
        from: 1,
        to: 2,
        pixelTransfers: [{ x: 127, y: 10, sourceProvinceId: 4, targetProvinceId: 1 }],
      },
      {
        id: 'remove-normal-2-3',
        kind: 'remove_normal_adjacency',
        from: 2,
        to: 3,
        pixelTransfers: removeBoundary,
      },
      {
        id: 'update-coast-after-normal-removal',
        kind: 'update_province_definition',
        provinceId: 2,
        changes: { coastal: false },
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.expectedChangedBounds).toEqual({
      minX: 127,
      minY: 0,
      maxX: 191,
      maxY: 255,
      count: 257,
    });
    expect(plan.finalIndex.raster?.adjacency.get(1)?.has(2)).toBe(true);
    expect(plan.finalIndex.raster?.adjacency.get(2)?.has(3)).toBe(false);
    expect(plan.finalIndex.provinceBitmap?.rgbAt(127, 10)).toEqual(provinceColors[1]);
    expect(plan.finalIndex.provinceBitmap?.rgbAt(191, 10)).toEqual(provinceColors[1]);
    expect(
      validateMap(plan.finalIndex).diagnostics.filter(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    ).toEqual([]);
    const diff = await renderMapDiff(snapshot.index, plan.finalIndex);
    expect(diff.semantic.normalAdjacencies).toEqual([
      {
        key: '1:2',
        before: null,
        after: JSON.stringify({ from: 1, to: 2 }),
      },
      {
        key: '2:3',
        before: JSON.stringify({ from: 2, to: 3 }),
        after: null,
      },
    ]);
    expect(diff.semantic.normalAdjacenciesChanged).toBe(true);

    const mismatch = planMapOperations(snapshot.index, [
      {
        id: 'incomplete-normal-removal',
        kind: 'remove_normal_adjacency',
        from: 2,
        to: 3,
        pixelTransfers: [{ x: 191, y: 10, sourceProvinceId: 2, targetProvinceId: 1 }],
      },
    ]);
    expect(mismatch.blockers).toMatchObject([{ code: 'MAP_NORMAL_ADJACENCY_RESULT_MISMATCH' }]);
    expect(mismatch.changes).toEqual([]);
    expect(mismatch.expectedChangedBounds).toBeUndefined();

    const duplicate = planMapOperations(snapshot.index, [
      {
        id: 'duplicate-normal-transfer',
        kind: 'add_normal_adjacency',
        from: 1,
        to: 2,
        pixelTransfers: [
          { x: 127, y: 10, sourceProvinceId: 4, targetProvinceId: 1 },
          { x: 127, y: 10, sourceProvinceId: 4, targetProvinceId: 1 },
        ],
      },
    ]);
    expect(duplicate.blockers).toMatchObject([{ code: 'MAP_NORMAL_ADJACENCY_TRANSFER_DUPLICATE' }]);
    expect(duplicate.changes).toEqual([]);
  });

  it('edits adjacency, supply, rail, map positions, and entity locators through declarative rows', async () => {
    const { snapshot } = await setup();
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'add-impassable',
        kind: 'add_adjacency',
        adjacency: {
          from: 1,
          to: 4,
          type: 'impassable',
          through: -1,
          startX: -1,
          startY: -1,
          stopX: -1,
          stopY: -1,
          rule: '',
          comment: 'ridge',
        },
      },
      { id: 'add-supply', kind: 'add_supply_node', level: 1, provinceId: 2 },
      { id: 'add-rail', kind: 'add_railway', level: 2, provinces: [4, 2] },
      {
        id: 'move-building-position',
        kind: 'upsert_building_position',
        match: { stateId: 1, building: 'bunker' },
        value: {
          stateId: 1,
          building: 'bunker',
          x: 20,
          y: 0,
          z: 245,
          rotation: 0.5,
          adjacentSeaProvince: 0,
        },
      },
      {
        id: 'move-unit-position',
        kind: 'upsert_unit_position',
        match: { provinceId: 1, type: 0 },
        value: { provinceId: 1, type: 0, x: 20, y: 0, z: 245, rotation: 0.25, offset: 0 },
      },
      {
        id: 'move-weather-position',
        kind: 'upsert_weather_position',
        match: { strategicRegionId: 1, size: 'small' },
        value: { strategicRegionId: 1, x: 20, y: 0, z: 245, size: 'small' },
      },
      {
        id: 'move-entity-locator',
        kind: 'update_entity_locator',
        entity: 'test_entity',
        name: 'test_locator',
        position: [4, 5, 6],
      },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.finalIndex.adjacencies).toMatchObject([
      { from: 1, to: 4, type: 'impassable', comment: 'ridge' },
    ]);
    expect(plan.finalIndex.supplyNodes.map(({ provinceId }) => provinceId)).toEqual([1, 2]);
    expect(plan.finalIndex.railways).toMatchObject([
      { level: 1, provinces: [1, 4, 2] },
      { level: 2, provinces: [4, 2] },
    ]);
    expect(plan.finalIndex.buildingPositions[0]).toMatchObject({ x: 20, rotation: 0.5 });
    expect(plan.finalIndex.unitPositions[0]).toMatchObject({ x: 20, rotation: 0.25 });
    expect(plan.finalIndex.weatherPositions[0]).toMatchObject({ x: 20, size: 'small' });
    expect(plan.finalIndex.entityLocators[0]?.position).toEqual([4, 5, 6]);
  });

  it('chains every row removal through dry-run, apply, and byte-exact rollback', async () => {
    const sources = {
      'map/adjacencies.csv': [
        'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment',
        '1;4;sea;3;10;10;70;10;test_rule;remove-adjacency-comment',
        '4;2;impassable;-1;-1;-1;-1;-1;;keep-adjacency-comment',
        '-1;-1;;-1;-1;-1;-1;-1;;',
        '',
      ].join('\r\n'),
      'map/supply_nodes.txt': ['1 1 # remove-supply-comment', '1 2 # keep-supply-comment', ''].join(
        '\r\n',
      ),
      'map/railways.txt': [
        '1 3 1 4 2 # remove-railway-zero',
        '2 2 4 2 # remove-reindexed-railway-zero',
        '3 2 1 4 # keep-railway-comment',
        '',
      ].join('\r\n'),
      'map/buildings.txt': [
        '1;bunker;10;0;245;0;0;# keep-building-occurrence-zero',
        '1;bunker;20;0;245;0;0;# remove-building-occurrence-one',
        '1;bunker;30;0;245;0;0;# remove-reindexed-building-occurrence-one',
        '1;naval_base_spawn;10;0;245;0;3;# keep-port-position',
        '2;bunker;140;0;245;0;0;# keep-unrelated-building',
        '',
      ].join('\r\n'),
      'map/unitstacks.txt': [
        '1;0;10;0;245;0;0;# keep-unit-occurrence-zero',
        '1;0;20;0;245;0;0;# remove-unit-occurrence-one',
        '2;0;140;0;245;0;0;# keep-unrelated-unit',
        '',
      ].join('\r\n'),
      'map/weatherpositions.txt': [
        '1;10;0;245;small;# keep-weather-occurrence-zero',
        '1;20;0;245;small;# remove-weather-occurrence-one',
        '1;30;0;245;big;# keep-unrelated-weather',
        '',
      ].join('\r\n'),
    } as const;
    const expected = {
      'map/adjacencies.csv': [
        'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment',
        '4;2;impassable;-1;-1;-1;-1;-1;;keep-adjacency-comment',
        '-1;-1;;-1;-1;-1;-1;-1;;',
        '',
      ].join('\r\n'),
      'map/supply_nodes.txt': ['1 2 # keep-supply-comment', ''].join('\r\n'),
      'map/railways.txt': ['3 2 1 4 # keep-railway-comment', ''].join('\r\n'),
      'map/buildings.txt': [
        '1;bunker;10;0;245;0;0;# keep-building-occurrence-zero',
        '1;naval_base_spawn;10;0;245;0;3;# keep-port-position',
        '2;bunker;140;0;245;0;0;# keep-unrelated-building',
        '',
      ].join('\r\n'),
      'map/unitstacks.txt': [
        '1;0;10;0;245;0;0;# keep-unit-occurrence-zero',
        '2;0;140;0;245;0;0;# keep-unrelated-unit',
        '',
      ].join('\r\n'),
      'map/weatherpositions.txt': [
        '1;10;0;245;small;# keep-weather-occurrence-zero',
        '1;30;0;245;big;# keep-unrelated-weather',
        '',
      ].join('\r\n'),
    } as const;
    const { mod, nudger, transactions } = await setup(sources);
    const originals = new Map(
      await Promise.all(
        Object.keys(sources).map(
          async (relativePath) =>
            [relativePath, await readFile(path.join(mod, relativePath))] as const,
        ),
      ),
    );
    const result = await nudger.plan({
      workspaceId: 'map-test',
      operations: [
        {
          id: 'remove-adjacency-row',
          kind: 'remove_adjacency',
          from: 1,
          to: 4,
          type: 'sea',
        },
        { id: 'remove-supply-row', kind: 'remove_supply_node', provinceId: 1 },
        { id: 'remove-first-railway', kind: 'remove_railway', index: 0 },
        { id: 'remove-reindexed-first-railway', kind: 'remove_railway', index: 0 },
        {
          id: 'remove-second-building-occurrence',
          kind: 'remove_building_position',
          match: { stateId: 1, building: 'bunker', occurrence: 1 },
        },
        {
          id: 'remove-reindexed-second-building-occurrence',
          kind: 'remove_building_position',
          match: { stateId: 1, building: 'bunker', occurrence: 1 },
        },
        {
          id: 'remove-second-unit-occurrence',
          kind: 'remove_unit_position',
          match: { provinceId: 1, type: 0, occurrence: 1 },
        },
        {
          id: 'remove-second-weather-occurrence',
          kind: 'remove_weather_position',
          match: { strategicRegionId: 1, size: 'small', occurrence: 1 },
        },
      ],
    });

    expect(result.plan.blockers).toEqual([]);
    expect(
      result.validation.diagnostics.filter(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    ).toEqual([]);
    expect(result.transaction.validation.passed).toBe(true);
    expect(result.transaction.files.map(({ relativePath }) => relativePath)).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [relativePath, exactText] of Object.entries(expected)) {
      expect(
        result.plan.finalIndex.activeFiles.byRelativePath
          .get(relativePath.toLowerCase())
          ?.bytes.toString('utf8'),
      ).toBe(exactText);
      expect(await readFile(path.join(mod, relativePath))).toEqual(originals.get(relativePath));
    }
    expect(result.plan.finalIndex.railways).toMatchObject([{ level: 3, provinces: [1, 4] }]);
    expect(result.plan.finalIndex.buildingPositions).toMatchObject([
      { stateId: 1, building: 'bunker', x: 10 },
      { stateId: 1, building: 'naval_base_spawn', x: 10 },
      { stateId: 2, building: 'bunker', x: 140 },
    ]);

    const applied = await transactions.apply(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    for (const [relativePath, exactText] of Object.entries(expected)) {
      expect(await readFile(path.join(mod, relativePath), 'utf8')).toBe(exactText);
    }

    const rolledBack = await transactions.rollback(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
    );
    expect(rolledBack.state).toBe('rolled_back');
    for (const [relativePath, original] of originals) {
      expect(await readFile(path.join(mod, relativePath))).toEqual(original);
    }
  });

  it('returns operation-specific blockers when each removable row is absent', async () => {
    const { snapshot } = await setup();
    const cases = [
      {
        operation: {
          id: 'missing-adjacency',
          kind: 'remove_adjacency',
          from: 1,
          to: 2,
          type: 'sea',
        } as const,
        code: 'MAP_ADJACENCY_NOT_FOUND',
      },
      {
        operation: {
          id: 'missing-supply-node',
          kind: 'remove_supply_node',
          provinceId: 99,
        } as const,
        code: 'MAP_SUPPLY_NODE_NOT_FOUND',
      },
      {
        operation: { id: 'missing-railway', kind: 'remove_railway', index: 99 } as const,
        code: 'MAP_RAILWAY_NOT_FOUND',
      },
      {
        operation: {
          id: 'missing-building-position',
          kind: 'remove_building_position',
          match: { stateId: 1, building: 'missing' },
        } as const,
        code: 'MAP_BUILDING_POSITION_NOT_FOUND',
      },
      {
        operation: {
          id: 'missing-unit-position',
          kind: 'remove_unit_position',
          match: { provinceId: 1, type: 99 },
        } as const,
        code: 'MAP_UNIT_POSITION_NOT_FOUND',
      },
      {
        operation: {
          id: 'missing-weather-position',
          kind: 'remove_weather_position',
          match: { strategicRegionId: 99, size: 'small' },
        } as const,
        code: 'MAP_WEATHER_POSITION_NOT_FOUND',
      },
    ] as const;

    for (const { operation, code } of cases) {
      const plan = planMapOperations(snapshot.index, [operation]);
      expect(plan.blockers).toMatchObject([{ code, operationId: operation.id }]);
      expect(plan.changes).toEqual([]);
    }
  });

  it('honors configured source roots and default.map filenames for scan and additive operations', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-custom-map-'));
    const mod = path.join(base, 'mod');
    for (const [originalPath, originalContent] of Object.entries(fixtureFiles())) {
      let relativePath = originalPath
        .replace(/^map\//u, 'geography/')
        .replace(/^history\/states\//u, 'data/states/')
        .replace(/^localisation\//u, 'text/');
      if (relativePath === 'geography/adjacencies.csv') relativePath = 'geography/connections.csv';
      if (relativePath === 'geography/supply_nodes.txt') relativePath = 'geography/nodes.txt';
      if (relativePath === 'geography/railways.txt') relativePath = 'geography/tracks.txt';
      const content =
        relativePath === 'geography/default.map'
          ? [
              'definitions = "definition.csv"',
              'provinces = "provinces.bmp"',
              'adjacencies = "connections.csv"',
              'supply_nodes = "nodes.txt"',
              'railways = "tracks.txt"',
              'positions = "positions.txt"',
              '',
            ].join('\n')
          : originalContent;
      const target = path.join(mod, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const config = serverConfigurationSchema.parse({
      version: 1,
      writePolicy: 'transactions',
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        {
          id: 'custom-map',
          name: 'Custom Map',
          root: mod,
          writeEnabled: true,
          roots: {
            map: ['geography'],
            states: ['data/states'],
            localisation: ['text'],
          },
        },
      ],
    });
    const resolver = await WorkspaceResolver.create(config);
    const nudger = new AgentNudger(resolver);
    const snapshot = await nudger.scan('custom-map');
    expect(snapshot.index.definitionFile?.relativePath).toBe('geography/definition.csv');
    expect(snapshot.index.statesById.has(1)).toBe(true);
    expect(snapshot.index.localisationKeys.has('l_english:STATE_1')).toBe(true);
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'custom-adjacency',
        kind: 'add_adjacency',
        adjacency: {
          from: 1,
          to: 4,
          type: 'impassable',
          through: -1,
          startX: -1,
          startY: -1,
          stopX: -1,
          stopY: -1,
          rule: '',
          comment: 'custom root',
        },
      },
      { id: 'custom-supply', kind: 'add_supply_node', level: 1, provinceId: 2 },
      { id: 'custom-rail', kind: 'add_railway', level: 2, provinces: [4, 2] },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.changes.map(({ relativePath }) => relativePath)).toEqual([
      'geography/connections.csv',
      'geography/nodes.txt',
      'geography/tracks.txt',
    ]);
  });

  it('produces deterministic layer renders and pixel/semantic diffs', async () => {
    const { snapshot } = await setup();
    const first = await renderMap(snapshot.index, {
      layer: 'continent',
      overlays: ['railways', 'supply-nodes', 'resources', 'state-buildings', 'province-buildings'],
      scale: 1,
    });
    const second = await renderMap(snapshot.index, {
      layer: 'continent',
      overlays: ['province-buildings', 'state-buildings', 'resources', 'supply-nodes', 'railways'],
      scale: 1,
    });
    expect(first.hashes).toEqual(second.hashes);
    expect(first.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const metadata = JSON.parse(first.json) as {
      layer: string;
      overlays: string[];
      states: {
        id: number;
        resources: Record<string, number>;
        stateBuildings: Record<string, number>;
        provinceBuildings: Record<string, Record<string, number>>;
      }[];
    };
    expect(metadata).toMatchObject({
      layer: 'continent',
      overlays: ['province-buildings', 'railways', 'resources', 'state-buildings', 'supply-nodes'],
    });
    expect(metadata.states.find(({ id }) => id === 1)).toMatchObject({
      resources: { steel: 10 },
      stateBuildings: { infrastructure: 3 },
      provinceBuildings: {
        '1': { arms_factory: 1, naval_base: 1 },
      },
    });
    expect(first.html).toContain('Agent Nudger map - continent');
    expect(first.html).not.toContain('Â');
    const withoutValueOverlays = await renderMap(snapshot.index, { layer: 'continent' });
    expect(withoutValueOverlays.hashes.png).not.toBe(first.hashes.png);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(renderMap(snapshot.index, { signal: cancelled.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const plan = planMapOperations(snapshot.index, [
      {
        id: 'recolor-4',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { color: { r: 222, g: 111, b: 33 } },
      },
    ]);
    const diff = await renderMapDiff(snapshot.index, plan.finalIndex);
    expect(diff.changedBounds).toEqual({ minX: 64, minY: 0, maxX: 127, maxY: 255, count: 16_384 });
    expect(diff.changedProvinceIds).toEqual([4]);
    expect(diff.semantic.definitions).toMatchObject([{ id: 4 }]);
  });

  it('plans only through the shared transaction manager, applies hash-bound changes, and rolls back exact bytes', async () => {
    const { mod, nudger, transactions } = await setup();
    const sourcePath = path.join(mod, 'history', 'states', '1-ONE.txt');
    const original = await readFile(sourcePath);
    const result = await nudger.plan({
      workspaceId: 'map-test',
      operations: [
        {
          id: 'split-state-1',
          kind: 'split_state',
          sourceStateId: 1,
          provinceIds: [4],
          name: 'STATE_3',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: splitStatePolicy,
        },
      ],
    });
    expect(result.plan.blockers).toEqual([]);
    expect(result.transaction.validation.passed).toBe(true);
    expect(result.transaction.files.map(({ relativePath }) => relativePath)).toEqual([
      'history/states/1-ONE.txt',
      'history/states/3-AGENT_STATE.txt',
    ]);
    expect(await readFile(sourcePath)).toEqual(original);
    await expect(
      transactions.apply('map-test', result.transaction.transactionId, 'wrong-hash', {
        postValidate,
      }),
    ).rejects.toThrow();
    const applied = await transactions.apply(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    expect(await readFile(sourcePath, 'utf8')).toContain('provinces = {\n\t\t1\n\t}');
    const createdStateSource = await readFile(
      path.join(mod, 'history', 'states', '3-AGENT_STATE.txt'),
      'utf8',
    );
    expect(createdStateSource).toContain('id = 3');
    expect(createdStateSource).not.toContain('capital =');
    const rolledBack = await transactions.rollback(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
    );
    expect(rolledBack.state).toBe('rolled_back');
    expect(await readFile(sourcePath)).toEqual(original);
    await expect(
      readFile(path.join(mod, 'history', 'states', '3-AGENT_STATE.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies and rolls back a multi-file province type migration byte-for-byte', async () => {
    const { mod, nudger, transactions } = await setup();
    const relativePaths = ['history/states/1-ONE.txt', 'map/definition.csv', 'map/railways.txt'];
    const originals = new Map(
      await Promise.all(
        relativePaths.map(
          async (relativePath) =>
            [relativePath, await readFile(path.join(mod, relativePath))] as const,
        ),
      ),
    );
    const result = await nudger.plan({
      workspaceId: 'map-test',
      operations: [
        {
          id: 'transaction-land-to-sea',
          kind: 'update_province_definition',
          provinceId: 4,
          changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
          distribution: removeLandDependenciesPolicy,
        },
      ],
    });
    expect(result.plan.blockers).toEqual([]);
    expect(result.transaction.validation.passed).toBe(true);
    expect(result.transaction.files.map(({ relativePath }) => relativePath)).toEqual(relativePaths);
    const applied = await transactions.apply(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    const appliedSnapshot = await nudger.scan('map-test');
    expect(appliedSnapshot.index.definitionsById.get(4)).toMatchObject({
      type: 'sea',
      terrain: 'ocean',
      continent: 0,
    });
    expect(appliedSnapshot.index.statesById.get(1)?.provinces).toEqual([1]);
    expect(appliedSnapshot.index.railways).toEqual([]);

    const rolledBack = await transactions.rollback(
      'map-test',
      result.transaction.transactionId,
      result.transaction.planHash,
    );
    expect(rolledBack.state).toBe('rolled_back');
    for (const [relativePath, original] of originals)
      expect(await readFile(path.join(mod, relativePath))).toEqual(original);
  });

  it('attributes a post-plan validation error to the manifest operation that owns its source', async () => {
    const { nudger } = await setup();
    const result = await nudger.plan({
      workspaceId: 'map-test',
      operations: [
        {
          id: 'remove-owner-keep-controller',
          kind: 'update_state',
          stateId: 2,
          changes: { owner: null, controller: 'BBB' },
        },
      ],
    });
    const diagnostic = result.validation.diagnostics.find(
      ({ code }) => code === 'MAP_STATE_CONTROLLER_WITHOUT_OWNER',
    );
    expect(diagnostic).toMatchObject({
      severity: 'error',
      operationId: 'remove-owner-keep-controller',
      details: {
        attributionStrategy: 'last-operation-owning-diagnostic-source',
        attributionCandidateOperationIds: ['remove-owner-keep-controller'],
      },
    });
    expect(result.transaction.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MAP_STATE_CONTROLLER_WITHOUT_OWNER',
        operationId: 'remove-owner-keep-controller',
      }),
    );
    expect(result.transaction.validation.passed).toBe(false);
    expect(
      result.validation.diagnostics.some(({ code }) => code === 'MAP_VALIDATION_OPERATION_UNOWNED'),
    ).toBe(false);
  });

  it('adds a deterministic explicit blocker for a pre-existing validation error with no owner', async () => {
    const { mod, nudger } = await setup();
    const statePath = path.join(mod, 'history', 'states', '2-TWO.txt');
    const source = await readFile(statePath, 'utf8');
    const invalid = source.replace(
      'history = { owner = BBB add_core_of = BBB }',
      'history = { controller = BBB add_core_of = BBB }',
    );
    expect(invalid).not.toBe(source);
    await writeFile(statePath, invalid, 'utf8');

    const result = await nudger.plan({
      workspaceId: 'map-test',
      operations: [
        {
          id: 'unrelated-locator-update',
          kind: 'update_entity_locator',
          entity: 'test_entity',
          name: 'test_locator',
          position: [4, 5, 6],
        },
      ],
    });
    expect(result.validation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MAP_STATE_CONTROLLER_WITHOUT_OWNER',
        details: expect.objectContaining({ attributionStatus: 'pre-existing-baseline' }),
      }),
    );
    expect(result.validation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MAP_VALIDATION_OPERATION_UNOWNED',
        severity: 'blocker',
        details: expect.objectContaining({
          sourceDiagnosticCode: 'MAP_STATE_CONTROLLER_WITHOUT_OWNER',
          attributionStatus: 'pre-existing-baseline',
        }),
      }),
    );
    for (const diagnostic of result.validation.diagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    )) {
      expect(
        diagnostic.operationId !== undefined ||
          diagnostic.code === 'MAP_VALIDATION_OPERATION_UNOWNED' ||
          diagnostic.details?.attributionStatus === 'pre-existing-baseline',
      ).toBe(true);
    }
    expect(result.transaction.validation.passed).toBe(false);
  });

  it('blocks adversarial scale-derived map dimensions before raw rendering work', async () => {
    const index = {
      raster: {
        width: 5_632,
        height: 2_048,
        provinceIds: new Int32Array(0),
      },
    } as unknown as MapWorkspaceIndex;
    await expect(renderMap(index, { scale: 16 })).rejects.toMatchObject({
      code: 'RENDER_DIMENSIONS_BLOCKED',
    });
  });
});

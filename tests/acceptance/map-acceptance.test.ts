import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { compareCodeUnits, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  BmpImage,
  rgbKey,
  type PixelPoint,
  type RgbColor,
} from '../../src/hoi4_agent_tools/map/bmp.js';
import type {
  MapOperation,
  MergeProvinceDistributionPolicy,
  MergeStateDistributionPolicy,
  MoveStateDistributionPolicy,
  ProvinceTypeDistributionPolicy,
  SplitProvinceDistributionPolicy,
  SplitStateDistributionPolicy,
} from '../../src/hoi4_agent_tools/map/operations.js';
import type { MapBaseLayer, MapOverlay } from '../../src/hoi4_agent_tools/map/render.js';
import {
  AgentNudger,
  type MapPlanResult,
  type MapScanSnapshot,
} from '../../src/hoi4_agent_tools/map/service.js';
import { validateMapAsync } from '../../src/hoi4_agent_tools/map/validation.js';

const postValidate = () =>
  Promise.resolve({
    diagnostics: [],
    checks: [{ id: 'map-acceptance-post-write', passed: true, message: 'Fixture revalidated' }],
  });

type FixtureRoot = 'game' | 'dependency' | 'mod';

interface FixtureSourceFile {
  root: FixtureRoot;
  relativePath: string;
  sha256: string;
  size: number;
}

interface MapFixtureManifest {
  schemaVersion: number;
  dimensions: { width: number; height: number; bitsPerPixel: number; dibSize: number };
  definitionIds: number[];
  stateIds: number[];
  strategicRegionIds: number[];
  provincePixelCounts: Record<string, number>;
  activeSourceRoots: {
    defaultMap: FixtureRoot;
    definitions: FixtureRoot;
    provinceBitmap: FixtureRoot;
  };
  provinceBitmapSha256: string;
  sourceFiles: FixtureSourceFile[];
  invalidVariants: { id: string; expectedDiagnosticCodes: string[] }[];
}

interface TextReplacePatch {
  kind: 'text_replace';
  root: FixtureRoot;
  relativePath: string;
  search: string;
  replacement: string;
}

interface BitmapRectanglePatch {
  kind: 'bitmap_rectangle';
  root: FixtureRoot;
  relativePath: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  color: RgbColor;
}

interface BitmapReplaceColorPatch {
  kind: 'bitmap_replace_color';
  root: FixtureRoot;
  relativePath: string;
  from: RgbColor;
  to: RgbColor;
}

type InvalidPatch = TextReplacePatch | BitmapRectanglePatch | BitmapReplaceColorPatch;

interface InvalidVariantFile {
  schemaVersion: number;
  variants: {
    id: string;
    patches: InvalidPatch[];
    expectedDiagnosticCodes: string[];
  }[];
}

interface FixtureRoots {
  game: string;
  dependency: string;
  mod: string;
}

interface Harness {
  workspaceId: string;
  roots: FixtureRoots;
  resolver: WorkspaceResolver;
  scanner: WorkspaceScanner;
  artifacts: ArtifactStore;
  transactions: TransactionManager;
  nudger: AgentNudger;
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'map');
const checkedInRoots: FixtureRoots = {
  game: path.join(fixtureRoot, 'roots', 'game'),
  dependency: path.join(fixtureRoot, 'roots', 'dependency'),
  mod: path.join(fixtureRoot, 'roots', 'mod'),
};
const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
const invalidVariantsPath = path.join(fixtureRoot, 'invalid', 'invalid-variants.json');

const moveStatePolicy: MoveStateDistributionPolicy = {
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

const proportionalStatePolicy: SplitStateDistributionPolicy = {
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

const exactStatePolicy: SplitStateDistributionPolicy = {
  manpower: { method: 'exact', source: 700, destination: 300 },
  resources: { method: 'exact', source: { steel: 7 }, destination: { steel: 3 } },
  stateBuildings: {
    method: 'exact',
    source: { infrastructure: 2 },
    destination: { infrastructure: 1 },
  },
  owner: { method: 'exact', source: 'AAA', destination: 'DDD' },
  controller: { method: 'exact', source: null, destination: 'DDD' },
  cores: { method: 'exact', source: ['AAA'], destination: ['DDD'] },
  claims: { method: 'exact', source: [], destination: ['EEE'] },
  victoryPoints: 'follow-province',
  provinceBuildings: 'follow-province',
  ports: 'follow-province',
  supplyNodes: 'follow-province',
  railways: 'follow-province',
  positions: 'follow-province',
};

const mergeStatePolicy: MergeStateDistributionPolicy = {
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

const mergeProvincePolicy: MergeProvinceDistributionPolicy = {
  membership: 'require-same',
  victoryPoints: 'sum-into-target',
  provinceBuildings: 'sum-into-target',
  references: 'remap-to-target-and-deduplicate',
};

const mapLayers: MapBaseLayer[] = [
  'province',
  'state',
  'strategic-region',
  'terrain',
  'continent',
  'owner',
  'controller',
  'cores',
  'claims',
  'coast',
];

const mapOverlays: MapOverlay[] = [
  'coastlines',
  'ports',
  'victory-points',
  'resources',
  'state-buildings',
  'province-buildings',
  'supply-nodes',
  'railways',
  'adjacencies',
  'building-positions',
  'unit-positions',
  'weather-positions',
];

let temporaryRoot: string;
let manifest: MapFixtureManifest;
let invalidFixture: InvalidVariantFile;
let baseline: Harness;
let baselineSnapshot: MapScanSnapshot;

function hardDiagnostics<T extends { severity: string }>(diagnostics: readonly T[]): T[] {
  return diagnostics.filter(({ severity }) => severity === 'error' || severity === 'blocker');
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Acceptance fixture is missing ${label}`);
  return value;
}

function mask(minX: number, maxX: number, minY = 0, maxY = 255): PixelPoint[] {
  const points: PixelPoint[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) points.push({ x, y });
  }
  return points;
}

function changedPaths(
  before: ReadonlyMap<string, Buffer>,
  after: ReadonlyMap<string, Buffer>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((relativePath) => {
      const left = before.get(relativePath);
      const right = after.get(relativePath);
      return left === undefined || right === undefined || !left.equals(right);
    })
    .sort(compareCodeUnits);
}

async function treeSnapshot(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).replaceAll('\\', '/');
        files.set(relative, await readFile(absolute));
      }
    }
  };
  await walk(root);
  return files;
}

async function createHarness(
  roots: FixtureRoots,
  storageRoot: string,
  workspaceId: string,
): Promise<Harness> {
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(storageRoot, 'server-state'),
    storageRoots: [path.join(storageRoot, 'artifacts'), path.join(storageRoot, 'cache')],
    workspaces: [
      {
        id: workspaceId,
        name: 'Project-owned Agent Nudger acceptance fixture',
        root: roots.mod,
        gameRoot: roots.game,
        dependencyRoots: [roots.dependency],
        artifactRoot: path.join(storageRoot, 'artifacts'),
        cacheRoot: path.join(storageRoot, 'cache'),
      },
    ],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const scanner = new WorkspaceScanner();
  const artifacts = new ArtifactStore();
  const transactions = new TransactionManager(resolver, artifacts, 3600);
  const nudger = new AgentNudger(resolver, transactions, artifacts, scanner);
  return { workspaceId, roots, resolver, scanner, artifacts, transactions, nudger };
}

async function copyFixtureRoots(target: string): Promise<FixtureRoots> {
  const roots = {
    game: path.join(target, 'game'),
    dependency: path.join(target, 'dependency'),
    mod: path.join(target, 'mod'),
  } satisfies FixtureRoots;
  await Promise.all(
    (Object.keys(roots) as FixtureRoot[]).map((root) =>
      cp(checkedInRoots[root], roots[root], { recursive: true }),
    ),
  );
  return roots;
}

async function applyInvalidPatch(roots: FixtureRoots, patch: InvalidPatch): Promise<void> {
  const target = path.join(roots[patch.root], ...patch.relativePath.split('/'));
  if (patch.kind === 'text_replace') {
    const bytes = await readFile(target);
    const text = bytes.toString('utf8');
    const offset = text.indexOf(patch.search);
    if (offset < 0)
      throw new Error(`Invalid-fixture search text is missing in ${patch.relativePath}`);
    const next = `${text.slice(0, offset)}${patch.replacement}${text.slice(offset + patch.search.length)}`;
    await writeFile(target, Buffer.from(next, 'utf8'));
    return;
  }
  const bitmap = BmpImage.decode(await readFile(target));
  const changes: (PixelPoint & { color: RgbColor })[] = [];
  if (patch.kind === 'bitmap_rectangle') {
    for (let y = patch.minY; y <= patch.maxY; y += 1) {
      for (let x = patch.minX; x <= patch.maxX; x += 1) changes.push({ x, y, color: patch.color });
    }
  } else {
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        if (rgbKey(bitmap.rgbAt(x, y)) === rgbKey(patch.from))
          changes.push({ x, y, color: patch.to });
      }
    }
  }
  if (changes.length === 0)
    throw new Error(`Invalid bitmap patch selected no pixels: ${patch.kind}`);
  await writeFile(target, bitmap.withRgbChanges(changes).encode());
}

function expectValidPlan(result: MapPlanResult): void {
  expect(result.plan.blockers).toEqual([]);
  expect(
    result.validation.passed,
    JSON.stringify(hardDiagnostics(result.validation.diagnostics), null, 2),
  ).toBe(true);
  expect(result.transaction.validation.passed).toBe(true);
  expect(hardDiagnostics(result.validation.diagnostics)).toEqual([]);
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-map-acceptance-'));
  [manifest, invalidFixture] = await Promise.all([
    readFile(manifestPath, 'utf8').then((value) => JSON.parse(value) as MapFixtureManifest),
    readFile(invalidVariantsPath, 'utf8').then((value) => JSON.parse(value) as InvalidVariantFile),
  ]);
  baseline = await createHarness(
    checkedInRoots,
    path.join(temporaryRoot, 'baseline'),
    'map_acceptance',
  );
  baselineSnapshot = await baseline.nudger.scan(baseline.workspaceId);
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('Agent Nudger project-owned map acceptance fixture', () => {
  it('scans and validates the complete cross-root synthetic map through shared services', async () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.dimensions).toEqual({
      width: 256,
      height: 256,
      bitsPerPixel: 24,
      dibSize: 124,
    });
    for (const source of manifest.sourceFiles) {
      const bytes = await readFile(
        path.join(checkedInRoots[source.root], ...source.relativePath.split('/')),
      );
      expect(bytes).toHaveLength(source.size);
      expect(sha256Bytes(bytes), `${source.root}:${source.relativePath}`).toBe(source.sha256);
    }

    const second = await baseline.nudger.scan(baseline.workspaceId);
    expect(second.revision).toBe(baselineSnapshot.revision);
    expect(second.files.map(({ displayPath, sha256 }) => ({ displayPath, sha256 }))).toEqual(
      baselineSnapshot.files.map(({ displayPath, sha256 }) => ({ displayPath, sha256 })),
    );
    expect(new Set(baselineSnapshot.files.map(({ rootKind }) => rootKind))).toEqual(
      new Set(['game', 'dependency', 'mod']),
    );
    expect(baselineSnapshot.index.defaultMapFile?.rootKind).toBe(
      manifest.activeSourceRoots.defaultMap,
    );
    expect(baselineSnapshot.index.definitionFile?.rootKind).toBe(
      manifest.activeSourceRoots.definitions,
    );
    expect(baselineSnapshot.index.provinceBitmapFile?.rootKind).toBe(
      manifest.activeSourceRoots.provinceBitmap,
    );
    expect(baselineSnapshot.index.provinceBitmapFile?.sha256).toBe(manifest.provinceBitmapSha256);
    expect(baseline.nudger.scanner).toBe(baseline.scanner);
    expect(baseline.nudger.transactions).toBe(baseline.transactions);
    expect(baseline.nudger.artifacts).toBe(baseline.artifacts);

    const index = baselineSnapshot.index;
    expect(index.provinceBitmap).toMatchObject(manifest.dimensions);
    expect([...index.definitionsById.keys()].sort((left, right) => left - right)).toEqual(
      manifest.definitionIds,
    );
    expect([...index.statesById.keys()].sort((left, right) => left - right)).toEqual(
      manifest.stateIds,
    );
    expect([...index.regionsById.keys()].sort((left, right) => left - right)).toEqual(
      manifest.strategicRegionIds,
    );
    expect(index.statesById.get(1)).toMatchObject({
      owner: 'AAA',
      capital: 1,
      cores: ['AAA'],
      provinces: [1, 4],
    });
    expect(index.statesById.get(1)?.file.rootKind).toBe('game');
    expect(index.statesById.get(2)?.file.rootKind).toBe('dependency');
    expect(index.statesById.get(5)?.file.rootKind).toBe('mod');
    expect(index.raster?.geometry.get(4)).toMatchObject({
      pixelCount: manifest.provincePixelCounts['4'],
      minX: 64,
      maxX: 127,
    });
    expect(index.raster?.adjacency.get(4)).toEqual(new Set([1, 2]));
    expect(index.coastalProvinceIds).toEqual(new Set([1, 2, 3]));
    expect(index.regionsById.get(1)?.provinces).toEqual([1, 2, 3, 4]);
    expect(index.regionsById.get(2)?.provinces).toEqual([]);
    expect(index.supplyNodes).toMatchObject([{ level: 1, provinceId: 1 }]);
    expect(index.railways).toMatchObject([{ level: 1, provinces: [1, 4, 2] }]);
    expect(index.buildingPositions).toHaveLength(4);
    expect(index.unitPositions).toMatchObject([{ provinceId: 1, type: 0 }]);
    expect(index.weatherPositions.map(({ size }) => size)).toEqual(['small', 'big']);
    expect(index.entityLocators).toMatchObject([
      {
        entity: 'synthetic_map_entity',
        name: 'synthetic_map_locator',
        position: [1, 2, 3],
      },
    ]);
    expect(index.ports).toMatchObject([
      { stateId: 1, provinceId: 1, level: 1, coastal: true, adjacentSeaProvinceIds: [3] },
    ]);

    const validated = await baseline.nudger.validate(baseline.workspaceId);
    expect(validated.validation.passed).toBe(true);
    expect(hardDiagnostics(validated.validation.diagnostics)).toEqual([]);
    expect(validated.validation.checks.every(({ passed }) => passed)).toBe(true);
  });

  it('plans exact state create, update, move, split, and merge operations across root overlays', async () => {
    const created = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'create-state-exact',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 3,
          provinceIds: [4],
          name: 'STATE_3',
          fileName: '3-CREATED.txt',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: exactStatePolicy,
        },
      ],
    });
    expectValidPlan(created);
    expect(created.plan.allocations).toMatchObject([
      { kind: 'state-id', allocated: 3, strategy: 'explicit-request-after-full-scan' },
    ]);
    expect(new Set(created.plan.allocations[0]?.roots.map(({ rootKind }) => rootKind))).toEqual(
      new Set(['game', 'dependency', 'mod']),
    );
    expect(created.plan.finalIndex.statesById.get(1)).toMatchObject({
      manpower: 700,
      owner: 'AAA',
      provinces: [1],
    });
    expect(created.plan.finalIndex.statesById.get(3)).toMatchObject({
      manpower: 300,
      owner: 'DDD',
      controller: 'DDD',
      cores: ['DDD'],
      claims: ['EEE'],
      provinces: [4],
    });
    expect(created.plan.finalIndex.statesById.get(3)?.resources).toEqual(new Map([['steel', 3]]));
    expect(created.plan.finalIndex.statesById.get(3)?.stateBuildings).toEqual(
      new Map([['infrastructure', 1]]),
    );
    expect(created.plan.finalIndex.buildingPositions.find(({ x }) => x === 70)).toMatchObject({
      stateId: 3,
    });

    const missingName = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'create-state-without-name-key',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 3,
          provinceIds: [4],
          distribution: exactStatePolicy,
        },
      ],
    });
    expect(missingName.plan.blockers).toMatchObject([{ code: 'MAP_STATE_NAME_REQUIRED' }]);
    const missingLocalisationPolicy = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'create-state-without-localisation-policy',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 3,
          provinceIds: [4],
          name: 'STATE_UNTRANSLATED',
          distribution: exactStatePolicy,
        },
      ],
    });
    expect(missingLocalisationPolicy.plan.blockers).toMatchObject([
      { code: 'MAP_STATE_LOCALISATION_POLICY_REQUIRED' },
    ]);

    const localised = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'create-state-and-localisation',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 3,
          provinceIds: [4],
          name: 'STATE_AGENT_CREATED',
          localisation: {
            method: 'upsert',
            language: 'l_english',
            value: 'Agent Created State',
            file: 'localisation/english/agent_states_l_english.yml',
          },
          distribution: exactStatePolicy,
        },
      ],
    });
    expectValidPlan(localised);
    const localisationChange = localised.plan.changes.find(
      ({ relativePath }) => relativePath === 'localisation/english/agent_states_l_english.yml',
    );
    expect(localisationChange?.content?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(
      localised.plan.finalIndex.localisationByKey.get('l_english:STATE_AGENT_CREATED'),
    ).toHaveLength(1);

    const split = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'split-state-automatic',
          kind: 'split_state',
          sourceStateId: 1,
          provinceIds: [4],
          name: 'STATE_3',
          fileName: '3-SPLIT.txt',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: exactStatePolicy,
        },
      ],
    });
    expectValidPlan(split);
    expect(split.plan.allocations[0]).toMatchObject({
      kind: 'state-id',
      allocated: 3,
      highestObserved: 5,
      contiguousBefore: false,
      strategy: 'lowest-positive-unused-active-id-across-roots',
    });
    expect(split.plan.finalIndex.statesById.get(1)?.manpower).toBe(700);
    expect(split.plan.finalIndex.statesById.get(3)?.manpower).toBe(300);

    const updated = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'update-state-exact',
          kind: 'update_state',
          stateId: 1,
          changes: {
            capital: 4,
            manpower: 1234,
            category: 'large_town',
            resources: { steel: 12, aluminium: 3 },
            stateBuildings: { infrastructure: 4 },
            owner: 'DDD',
            controller: 'EEE',
            cores: ['AAA', 'DDD'],
            claims: ['EEE'],
            victoryPoints: [{ provinceId: 4, value: 9 }],
            provinceBuildings: {
              '1': { arms_factory: 2, naval_base: 1 },
              '4': { bunker: 2 },
            },
          },
        },
      ],
    });
    expectValidPlan(updated);
    expect(updated.plan.finalIndex.statesById.get(1)).toMatchObject({
      capital: 4,
      manpower: 1234,
      category: 'large_town',
      owner: 'DDD',
      controller: 'EEE',
      cores: ['AAA', 'DDD'],
      claims: ['EEE'],
    });
    expect(updated.plan.finalIndex.victoryPointsByProvince.get(4)).toMatchObject([{ value: 9 }]);
    const updatedState = updated.plan.changes.find(
      ({ relativePath }) => relativePath === 'history/states/1-GAME.txt',
    );
    expect(Buffer.from(updatedState?.content ?? []).toString('utf8')).toContain(
      '# Project-owned game-root state; comments and unknown blocks must survive targeted edits.',
    );
    expect(Buffer.from(updatedState?.content ?? []).toString('utf8')).toContain(
      'unknown_fixture_block = { preserve = yes }',
    );

    const moved = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'move-state-province',
          kind: 'move_state_provinces',
          sourceStateId: 1,
          targetStateId: 2,
          provinceIds: [4],
          distribution: moveStatePolicy,
        },
      ],
    });
    expectValidPlan(moved);
    expect(moved.plan.finalIndex.statesById.get(1)?.provinces).toEqual([1]);
    expect(moved.plan.finalIndex.statesById.get(2)?.provinces).toEqual([2, 4]);
    expect(moved.plan.finalIndex.buildingPositions.find(({ x }) => x === 70)).toMatchObject({
      stateId: 2,
    });

    const merged = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'merge-state-exact',
          kind: 'merge_states',
          sourceStateIds: [2],
          targetStateId: 1,
          distribution: mergeStatePolicy,
        },
      ],
    });
    expectValidPlan(merged);
    expect(merged.plan.finalIndex.statesById.has(2)).toBe(false);
    expect(merged.plan.finalIndex.statesById.get(1)).toMatchObject({
      manpower: 1500,
      owner: 'AAA',
      provinces: [1, 2, 4],
      cores: ['AAA', 'BBB'],
    });
    expect(merged.plan.finalIndex.buildingPositions.find(({ x }) => x === 140)).toMatchObject({
      stateId: 1,
    });
    expect(
      merged.plan.changes.find(
        ({ relativePath }) => relativePath === 'history/states/2-DEPENDENCY.txt',
      )?.content,
    ).not.toBeNull();
  }, 120_000);

  it('plans exact-pixel and polygon province creation plus exact update, merge, and remove semantics', async () => {
    const selectedMask = mask(80, 95, 64, 191);
    const split = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'split-province-mask',
          kind: 'split_province',
          sourceProvinceId: 4,
          geometry: { kind: 'pixels', pixels: selectedMask },
          definition: { method: 'inherit-source' },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expectValidPlan(split);
    expect(split.plan.allocations).toMatchObject([
      {
        kind: 'province-id',
        allocated: 5,
        highestObserved: 4,
        contiguousBefore: true,
        strategy: 'maximum-active-id-plus-one-across-roots',
      },
      {
        kind: 'province-color',
        strategy: 'sha256-seeded-linear-probe-excluding-definition-and-bitmap-colors',
      },
    ]);
    expect(new Set(split.plan.allocations[0]?.roots.map(({ rootKind }) => rootKind))).toEqual(
      new Set(['game', 'dependency']),
    );
    expect(split.plan.allocations[0]?.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootKind: 'game',
          samplePath: 'game:map/game_definitions.csv',
          sourceCount: 1,
          maximumId: 20,
        }),
        expect.objectContaining({
          rootKind: 'dependency',
          samplePath: 'dependency-1:map/definition.csv',
          sourceCount: 1,
          maximumId: 4,
        }),
      ]),
    );
    expect(split.plan.expectedChangedBounds).toEqual({
      minX: 80,
      minY: 64,
      maxX: 95,
      maxY: 191,
      count: selectedMask.length,
    });
    expect(split.plan.finalIndex.statesById.get(1)?.provinces).toEqual([1, 4, 5]);
    expect(split.plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 2, 3, 4, 5]);
    expect(
      baselineSnapshot.index.provinceBitmap?.diffBounds(
        required(split.plan.finalIndex.provinceBitmap, 'the proposed province bitmap'),
      ),
    ).toEqual(split.plan.expectedChangedBounds);
    expect(split.plan.finalIndex.provinceBitmap?.rgbAt(79, 100)).toEqual({ r: 0, g: 180, b: 0 });
    expect(split.plan.finalIndex.provinceBitmap?.rgbAt(80, 100)).toEqual(
      split.plan.finalIndex.definitionsById.get(5)?.color,
    );

    const created = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'create-province-polygon',
          kind: 'create_province',
          sourceProvinceId: 4,
          provinceId: 5,
          geometry: {
            kind: 'polygon',
            fillRule: 'even-odd',
            points: [
              { x: 80, y: 64 },
              { x: 96, y: 64 },
              { x: 96, y: 192 },
              { x: 80, y: 192 },
            ],
          },
          definition: {
            method: 'exact',
            value: {
              color: { r: 120, g: 121, b: 122 },
              type: 'land',
              coastal: false,
              terrain: 'hills',
              continent: 1,
            },
          },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expectValidPlan(created);
    expect(created.plan.allocations).toMatchObject([
      { kind: 'province-id', allocated: 5, strategy: 'explicit-request-after-full-scan' },
      { kind: 'province-color', allocated: '120,121,122' },
    ]);
    expect(created.plan.finalIndex.definitionsById.get(5)).toMatchObject({
      color: { r: 120, g: 121, b: 122 },
      terrain: 'hills',
    });

    const updated = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'update-province-definition',
          kind: 'update_province_definition',
          provinceId: 4,
          changes: { color: { r: 222, g: 111, b: 33 }, terrain: 'hills', continent: 2 },
        },
      ],
    });
    expectValidPlan(updated);
    expect(updated.plan.expectedChangedBounds).toEqual({
      minX: 64,
      minY: 0,
      maxX: 127,
      maxY: 255,
      count: 16_384,
    });
    expect(updated.plan.finalIndex.definitionsById.get(4)).toMatchObject({
      color: { r: 222, g: 111, b: 33 },
      terrain: 'hills',
      continent: 2,
    });

    const merged = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'merge-province',
          kind: 'merge_provinces',
          sourceProvinceIds: [4],
          targetProvinceId: 1,
          distribution: mergeProvincePolicy,
        },
      ],
    });
    expectValidPlan(merged);
    expect(merged.plan.finalIndex.definitionsById.has(4)).toBe(false);
    expect(merged.plan.finalIndex.statesById.get(1)?.provinces).toEqual([1]);
    expect(merged.plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 2, 3]);
    expect(merged.plan.finalIndex.railways).toMatchObject([{ provinces: [1, 2] }]);
    expect(merged.plan.finalIndex.provinceBitmap?.rgbAt(70, 20)).toEqual({ r: 10, g: 0, b: 0 });

    const removed = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'remove-province',
          kind: 'remove_province',
          provinceId: 4,
          mergeIntoProvinceId: 1,
          distribution: mergeProvincePolicy,
        },
      ],
    });
    expectValidPlan(removed);
    expect(removed.plan.finalIndex.definitionsById.has(4)).toBe(false);
    expect(removed.plan.finalIndex.railways).toMatchObject([{ provinces: [1, 2] }]);
    expect(removed.plan.expectedChangedBounds).toEqual(merged.plan.expectedChangedBounds);
  }, 120_000);

  it('allocates sparse and explicit identifiers/colors and blocks collisions found in every root', async () => {
    const automaticState = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'allocate-state-hole',
          kind: 'split_state',
          sourceStateId: 1,
          provinceIds: [4],
          name: 'STATE_3',
          fileName: '3-AUTOMATIC.txt',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: proportionalStatePolicy,
        },
      ],
    });
    expectValidPlan(automaticState);
    expect(automaticState.plan.allocations[0]).toMatchObject({
      allocated: 3,
      contiguousBefore: false,
      strategy: 'lowest-positive-unused-active-id-across-roots',
    });
    expect(
      new Set(automaticState.plan.allocations[0]?.roots.map(({ rootKind }) => rootKind)),
    ).toEqual(new Set(['game', 'dependency', 'mod']));

    const explicitState = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'allocate-explicit-state',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 4,
          provinceIds: [4],
          name: 'STATE_4',
          fileName: '4-EXPLICIT.txt',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: exactStatePolicy,
        },
      ],
    });
    expectValidPlan(explicitState);
    expect(explicitState.plan.allocations[0]).toMatchObject({
      allocated: 4,
      strategy: 'explicit-request-after-full-scan',
    });

    for (const [stateId, rootKind] of [
      [1, 'game'],
      [2, 'dependency'],
      [5, 'mod'],
    ] as const) {
      const collision = await baseline.nudger.plan({
        workspaceId: baseline.workspaceId,
        operations: [
          {
            id: `collide-state-${rootKind}`,
            kind: 'create_state',
            sourceStateId: 1,
            stateId,
            provinceIds: [4],
            fileName: `${stateId}-COLLISION.txt`,
            distribution: exactStatePolicy,
          },
        ],
      });
      expect(collision.plan.blockers).toMatchObject([
        { code: 'MAP_STATE_ID_COLLISION', operationId: `collide-state-${rootKind}` },
      ]);
      expect(collision.transaction.validation.passed).toBe(false);
    }

    const explicitProvince = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'explicit-province-id-color',
          kind: 'create_province',
          sourceProvinceId: 4,
          provinceId: 5,
          geometry: { kind: 'pixels', pixels: mask(80, 95, 64, 191) },
          definition: {
            method: 'inherit-source',
            overrides: { color: { r: 120, g: 121, b: 122 } },
          },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expectValidPlan(explicitProvince);
    expect(explicitProvince.plan.allocations).toMatchObject([
      { kind: 'province-id', allocated: 5, strategy: 'explicit-request-after-full-scan' },
      { kind: 'province-color', allocated: '120,121,122' },
    ]);

    const idCollision = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'collide-province-id',
          kind: 'create_province',
          sourceProvinceId: 4,
          provinceId: 4,
          geometry: { kind: 'pixels', pixels: mask(80, 95, 64, 191) },
          definition: { method: 'inherit-source' },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expect(idCollision.plan.blockers).toMatchObject([{ code: 'MAP_PROVINCE_ID_COLLISION' }]);

    const colorCollision = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'collide-province-color',
          kind: 'create_province',
          sourceProvinceId: 4,
          provinceId: 5,
          geometry: { kind: 'pixels', pixels: mask(80, 95, 64, 191) },
          definition: {
            method: 'inherit-source',
            overrides: { color: { r: 10, g: 0, b: 0 } },
          },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expect(colorCollision.plan.blockers).toMatchObject([{ code: 'MAP_PROVINCE_COLOR_DUPLICATE' }]);

    const rootSelectedIdCollision = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'collide-root-selected-province-id',
          kind: 'create_province',
          sourceProvinceId: 4,
          provinceId: 20,
          geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
          definition: { method: 'inherit-source' },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expect(rootSelectedIdCollision.plan.blockers).toMatchObject([
      {
        code: 'MAP_DEPENDENCY_PROVINCE_ID_CONFLICT',
        details: { sources: ['game:map/game_definitions.csv'] },
      },
    ]);

    const rootSelectedColorCollision = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'collide-root-selected-province-color',
          kind: 'create_province',
          sourceProvinceId: 4,
          provinceId: 5,
          geometry: { kind: 'pixels', pixels: [{ x: 96, y: 1 }] },
          definition: {
            method: 'inherit-source',
            overrides: { color: { r: 90, g: 91, b: 92 } },
          },
          distribution: splitProvincePolicy,
        },
      ],
    });
    expect(rootSelectedColorCollision.plan.blockers).toMatchObject([
      {
        code: 'MAP_DEPENDENCY_PROVINCE_COLOR_CONFLICT',
        details: { source: 'game:map/game_definitions.csv' },
      },
    ]);
  }, 120_000);

  it('edits regions, adjacency, supply, rail, positions, and locators as one validated plan', async () => {
    const result = await baseline.nudger.plan({
      workspaceId: baseline.workspaceId,
      operations: [
        {
          id: 'move-region-province',
          kind: 'move_region_provinces',
          sourceRegionId: 1,
          targetRegionId: 2,
          provinceIds: [2],
          distribution: 'move-membership',
        },
        {
          id: 'add-impassable-adjacency',
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
            comment: 'synthetic ridge',
          },
        },
        { id: 'add-supply-node', kind: 'add_supply_node', level: 1, provinceId: 2 },
        { id: 'add-railway', kind: 'add_railway', level: 2, provinces: [4, 2] },
        {
          id: 'update-building-position',
          kind: 'upsert_building_position',
          match: { stateId: 1, building: 'bunker', occurrence: 0 },
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
          id: 'update-unit-position',
          kind: 'upsert_unit_position',
          match: { provinceId: 1, type: 0 },
          value: { provinceId: 1, type: 0, x: 20, y: 0, z: 245, rotation: 0.25, offset: 0 },
        },
        {
          id: 'update-weather-position',
          kind: 'upsert_weather_position',
          match: { strategicRegionId: 1, size: 'small' },
          value: { strategicRegionId: 1, x: 20, y: 0, z: 245, size: 'small' },
        },
        {
          id: 'update-entity-locator',
          kind: 'update_entity_locator',
          entity: 'synthetic_map_entity',
          name: 'synthetic_map_locator',
          position: [4, 5, 6],
        },
      ],
    });
    expectValidPlan(result);
    expect(result.plan.finalIndex.regionsById.get(1)?.provinces).toEqual([1, 3, 4]);
    expect(result.plan.finalIndex.regionsById.get(2)?.provinces).toEqual([2]);
    expect(result.plan.finalIndex.adjacencies).toMatchObject([
      { from: 1, to: 4, type: 'impassable', comment: 'synthetic ridge' },
    ]);
    expect(result.plan.finalIndex.supplyNodes.map(({ provinceId }) => provinceId)).toEqual([1, 2]);
    expect(result.plan.finalIndex.railways).toMatchObject([
      { level: 1, provinces: [1, 4, 2] },
      { level: 2, provinces: [4, 2] },
    ]);
    expect(result.plan.finalIndex.buildingPositions[0]).toMatchObject({ x: 20, rotation: 0.5 });
    expect(result.plan.finalIndex.unitPositions[0]).toMatchObject({ x: 20, rotation: 0.25 });
    expect(result.plan.finalIndex.weatherPositions[0]).toMatchObject({ x: 20, size: 'small' });
    expect(result.plan.finalIndex.entityLocators[0]?.position).toEqual([4, 5, 6]);
    expect(result.transaction.files.map(({ relativePath }) => relativePath)).toEqual([
      'gfx/entities/synthetic_map.asset',
      'map/adjacencies.csv',
      'map/buildings.txt',
      'map/railways.txt',
      'map/strategicregions/1-REGION.txt',
      'map/strategicregions/2-REGION.txt',
      'map/supply_nodes.txt',
      'map/unitstacks.txt',
      'map/weatherpositions.txt',
    ]);
  }, 120_000);

  it('keeps transactions blocked until every state and province distribution choice is explicit', async () => {
    const operations = [
      {
        id: 'state-policy-unresolved',
        kind: 'move_state_provinces',
        sourceStateId: 1,
        targetStateId: 2,
        provinceIds: [4],
      },
      {
        id: 'province-policy-unresolved',
        kind: 'split_province',
        sourceProvinceId: 4,
        geometry: { kind: 'pixels', pixels: mask(96, 127) },
        definition: { method: 'inherit-source' },
        distribution: {
          state: 'inherit-source',
          strategicRegion: 'inherit-source',
          victoryPoints: 'retain-source',
          provinceBuildings: 'retain-source',
          positions: 'retain-source',
        },
      },
      {
        id: 'province-type-policy-unresolved',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
      },
      {
        id: 'province-type-policy-inconsistent',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
        distribution: {
          ...removeLandDependenciesPolicy,
          stateMembership: { method: 'retain' },
        },
      },
    ] as unknown as MapOperation[];
    const blocked = await baseline.nudger.plan({ workspaceId: baseline.workspaceId, operations });
    expect(blocked.plan.blockers).toMatchObject([
      { code: 'MAP_STATE_DISTRIBUTION_REQUIRED', operationId: 'state-policy-unresolved' },
      { code: 'MAP_PROVINCE_DISTRIBUTION_REQUIRED', operationId: 'province-policy-unresolved' },
      {
        code: 'MAP_PROVINCE_TYPE_DISTRIBUTION_REQUIRED',
        operationId: 'province-type-policy-unresolved',
      },
      {
        code: 'MAP_PROVINCE_TYPE_DISTRIBUTION_INCONSISTENT',
        operationId: 'province-type-policy-inconsistent',
      },
    ]);
    expect(blocked.validation.passed).toBe(false);
    expect(blocked.transaction.validation.passed).toBe(false);
    await expect(
      baseline.transactions.apply(
        baseline.workspaceId,
        blocked.transaction.transactionId,
        blocked.transaction.planHash,
        { postValidate },
      ),
    ).rejects.toMatchObject({ code: 'TRANSACTION_VALIDATION_BLOCKED' });
  });

  it('detects every checked-in invalid geometry, reference, localisation, coast, and port variant', async () => {
    expect(invalidFixture.schemaVersion).toBe(1);
    expect(
      invalidFixture.variants.map(({ id, expectedDiagnosticCodes }) => ({
        id,
        expectedDiagnosticCodes,
      })),
    ).toEqual(manifest.invalidVariants);

    for (const [index, variant] of invalidFixture.variants.entries()) {
      const variantRoot = path.join(temporaryRoot, `invalid-${index}-${variant.id}`);
      const roots = await copyFixtureRoots(variantRoot);
      for (const patch of variant.patches) await applyInvalidPatch(roots, patch);
      const harness = await createHarness(
        roots,
        path.join(variantRoot, 'runtime'),
        `map_invalid_${index}`,
      );
      const snapshot = await harness.nudger.scan(harness.workspaceId);
      const validation = await validateMapAsync(snapshot.index, {
        includeBaselineDiagnostics: true,
      });
      const codes = new Set(validation.diagnostics.map(({ code }) => code));
      for (const expectedCode of variant.expectedDiagnosticCodes) {
        expect(codes, `${variant.id} should report ${expectedCode}`).toContain(expectedCode);
      }
    }
  }, 120_000);

  it('stores deterministic map layers plus pixel and semantic diffs through the shared artifact store', async () => {
    for (const layer of mapLayers) {
      const first = await baseline.nudger.renderAndStore(baseline.workspaceId, {
        layer,
        overlays: mapOverlays,
      });
      const second = await baseline.nudger.renderAndStore(baseline.workspaceId, {
        layer,
        overlays: [...mapOverlays].reverse(),
      });
      expect(second.bundle.hashes).toEqual(first.bundle.hashes);
      expect(second.bundle.png.equals(first.bundle.png)).toBe(true);
      expect(second.bundle.json).toBe(first.bundle.json);
      expect(second.bundle.html).toBe(first.bundle.html);
      expect(first.bundle.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      const metadata = await sharp(first.bundle.png).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 256, height: 256 });
      if (layer === 'province') {
        const evidence = JSON.parse(first.bundle.json) as {
          states: { id: number; manpower: number; category: string }[];
          victoryPoints: unknown[];
          ports: unknown[];
          supplyNodes: unknown[];
          railways: unknown[];
          adjacencies: unknown[];
          normalAdjacencies: unknown[];
          buildingPositions: unknown[];
          unitPositions: unknown[];
          weatherPositions: unknown[];
          entityLocators: unknown[];
          validation: { passed: boolean; diagnostics: unknown[]; checks: unknown[] };
        };
        expect(evidence.states).toContainEqual(
          expect.objectContaining({ id: 1, manpower: 1_000, category: 'town' }),
        );
        expect(evidence.victoryPoints.length).toBeGreaterThan(0);
        expect(evidence.ports.length).toBeGreaterThan(0);
        expect(evidence.supplyNodes.length).toBeGreaterThan(0);
        expect(evidence.railways.length).toBeGreaterThan(0);
        expect(evidence.adjacencies).toEqual([]);
        expect(evidence.normalAdjacencies.length).toBeGreaterThan(0);
        expect(evidence.buildingPositions.length).toBeGreaterThan(0);
        expect(evidence.unitPositions.length).toBeGreaterThan(0);
        expect(evidence.weatherPositions.length).toBeGreaterThan(0);
        expect(evidence.entityLocators.length).toBeGreaterThan(0);
        expect(evidence.validation).toEqual(
          expect.objectContaining({
            passed: true,
            diagnostics: expect.any(Array),
            checks: expect.any(Array),
          }),
        );
      }
      expect(first.artifacts.map(({ mimeType }) => mimeType).sort()).toEqual([
        'application/json',
        'image/png',
        'text/html',
      ]);
      for (const artifact of first.artifacts) {
        const stored = await baseline.artifacts.read(
          baseline.resolver.get(baseline.workspaceId),
          artifact.uri,
        );
        expect(sha256Bytes(stored.bytes)).toBe(artifact.sha256);
      }
    }

    const diffOperations: MapOperation[] = [
      {
        id: 'diff-state-values',
        kind: 'update_state',
        stateId: 1,
        changes: {
          resources: { steel: 11 },
          victoryPoints: [{ provinceId: 1, value: 6 }],
          stateBuildings: { infrastructure: 4 },
          provinceBuildings: {
            '1': { arms_factory: 1, naval_base: 2 },
            '4': { bunker: 2 },
          },
        },
      },
      {
        id: 'diff-recolor',
        kind: 'update_province_definition',
        provinceId: 4,
        changes: { color: { r: 222, g: 111, b: 33 } },
      },
      {
        id: 'diff-region',
        kind: 'move_region_provinces',
        sourceRegionId: 1,
        targetRegionId: 2,
        provinceIds: [2],
        distribution: 'move-membership',
      },
      { id: 'diff-supply', kind: 'add_supply_node', level: 1, provinceId: 2 },
      { id: 'diff-railway', kind: 'add_railway', level: 2, provinces: [4, 2] },
      {
        id: 'diff-adjacency',
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
          comment: 'diff ridge',
        },
      },
      {
        id: 'diff-building-position',
        kind: 'upsert_building_position',
        match: { stateId: 1, building: 'bunker', occurrence: 0 },
        value: {
          stateId: 1,
          building: 'bunker',
          x: 20,
          y: 0,
          z: 245,
          rotation: 0,
          adjacentSeaProvince: 0,
        },
      },
      {
        id: 'diff-locator',
        kind: 'update_entity_locator',
        entity: 'synthetic_map_entity',
        name: 'synthetic_map_locator',
        position: [7, 8, 9],
      },
    ];
    const firstDiff = await baseline.nudger.renderDiffAndStore(
      baseline.workspaceId,
      diffOperations,
    );
    const secondDiff = await baseline.nudger.renderDiffAndStore(
      baseline.workspaceId,
      diffOperations,
    );
    expect(secondDiff.bundle.hashes).toEqual(firstDiff.bundle.hashes);
    expect(secondDiff.bundle.png.equals(firstDiff.bundle.png)).toBe(true);
    expect(firstDiff.bundle.changedBounds).toEqual({
      minX: 64,
      minY: 0,
      maxX: 127,
      maxY: 255,
      count: 16_384,
    });
    expect(firstDiff.bundle.changedProvinceIds).toEqual([4]);
    expect(firstDiff.bundle.semantic.definitions).toMatchObject([{ id: 4 }]);
    expect(firstDiff.bundle.semantic.regionMembership).toContainEqual({
      provinceId: 2,
      before: [1],
      after: [2],
    });
    expect(firstDiff.bundle.semantic).toMatchObject({
      supplyNodesChanged: true,
      railwaysChanged: true,
      adjacenciesChanged: true,
    });
    expect(firstDiff.bundle.semantic.states).toMatchObject([{ key: '1' }]);
    expect(firstDiff.bundle.semantic.ports).toMatchObject([{ key: '1:1' }]);
    expect(firstDiff.bundle.semantic.buildingPositions).toHaveLength(1);
    expect(firstDiff.bundle.semantic.entityLocators).toHaveLength(1);
    expect(firstDiff.bundle.semantic.supplyNodes.length).toBeGreaterThan(0);
    expect(firstDiff.bundle.semantic.railways.length).toBeGreaterThan(0);
    expect(firstDiff.bundle.semantic.adjacencies.length).toBeGreaterThan(0);
    expect(firstDiff.beforeBundle.hashes).not.toEqual(firstDiff.proposedBundle.hashes);
    const diffEvidence = JSON.parse(firstDiff.bundle.json) as {
      review: {
        operationIds: string[];
        affectedFiles: { relativePath: string; operationIds: string[]; deletion: boolean }[];
        unresolvedChoices: unknown[];
        allocations: unknown[];
        validation: { passed: boolean; diagnostics: { operationId?: string }[] };
      };
    };
    expect(diffEvidence.review.operationIds).toEqual(diffOperations.map(({ id }) => id));
    expect(diffEvidence.review.affectedFiles.map(({ relativePath }) => relativePath)).toEqual(
      firstDiff.plan.changes.map(({ relativePath }) => relativePath),
    );
    expect(
      diffEvidence.review.affectedFiles.every(
        ({ operationIds, deletion }) => operationIds.length > 0 && !deletion,
      ),
    ).toBe(true);
    expect(diffEvidence.review.unresolvedChoices).toEqual([]);
    expect(diffEvidence.review.allocations).toEqual([]);
    expect(diffEvidence.review.validation.passed).toBe(true);
    expect(firstDiff.artifacts.map(({ mimeType }) => mimeType).sort()).toEqual([
      'application/json',
      'application/json',
      'application/json',
      'image/png',
      'image/png',
      'image/png',
      'text/html',
      'text/html',
      'text/html',
    ]);
    expect(firstDiff.artifacts.map(({ name }) => name).sort()).toEqual([
      'map-before.html',
      'map-before.json',
      'map-before.png',
      'map-diff.html',
      'map-diff.json',
      'map-diff.png',
      'map-proposed.html',
      'map-proposed.json',
      'map-proposed.png',
    ]);

    const allocationHarness = await createHarness(
      baseline.roots,
      path.join(temporaryRoot, 'runtime-diff-allocation'),
      'map_diff_allocation',
    );
    const allocationDiff = await allocationHarness.nudger.renderDiffAndStore(
      allocationHarness.workspaceId,
      [
        {
          id: 'diff-allocate-state',
          kind: 'split_state',
          sourceStateId: 1,
          provinceIds: [4],
          name: 'STATE_3',
          fileName: '3-DIFF-ALLOCATION.txt',
          localisation: { method: 'existing', language: 'l_english' },
          distribution: proportionalStatePolicy,
        },
      ],
    );
    const allocationEvidence = JSON.parse(allocationDiff.bundle.json) as {
      review: { allocations: { kind: string; allocated: number }[] };
    };
    expect(allocationEvidence.review.allocations).toContainEqual(
      expect.objectContaining({ kind: 'state-id', allocated: 3 }),
    );

    const blockedHarness = await createHarness(
      baseline.roots,
      path.join(temporaryRoot, 'runtime-diff-blocked'),
      'map_diff_blocked',
    );
    const blockedDiff = await blockedHarness.nudger.renderDiffAndStore(blockedHarness.workspaceId, [
      {
        id: 'diff-state-id-collision',
        kind: 'split_state',
        sourceStateId: 1,
        stateId: 1,
        provinceIds: [4],
        name: 'STATE_3',
        localisation: { method: 'existing', language: 'l_english' },
        distribution: proportionalStatePolicy,
      },
    ]);
    const blockedEvidence = JSON.parse(blockedDiff.bundle.json) as {
      review: {
        affectedFiles: unknown[];
        unresolvedChoices: { code: string; operationId?: string }[];
        validation: { passed: boolean };
      };
    };
    expect(blockedEvidence.review.affectedFiles).toEqual([]);
    expect(blockedEvidence.review.unresolvedChoices).toContainEqual(
      expect.objectContaining({
        code: 'MAP_STATE_ID_COLLISION',
        operationId: 'diff-state-id-collision',
      }),
    );
    expect(blockedEvidence.review.validation.passed).toBe(false);
  }, 120_000);

  it('applies only the hash-bound affected files byte-for-byte', async () => {
    const transactionRoot = path.join(temporaryRoot, 'transaction');
    const roots = await copyFixtureRoots(transactionRoot);
    const harness = await createHarness(
      roots,
      path.join(transactionRoot, 'runtime'),
      'map_transaction',
    );
    const beforeScan = await harness.nudger.scan(harness.workspaceId);
    const beforeTree = await treeSnapshot(roots.mod);
    const selectedMask = mask(80, 95, 64, 191);
    const selectedMaskBytes = Buffer.alloc(16 * 128, 1);
    const result = await harness.nudger.plan({
      workspaceId: harness.workspaceId,
      operations: [
        {
          id: 'transaction-split-province',
          kind: 'split_province',
          sourceProvinceId: 4,
          geometry: {
            kind: 'mask',
            width: 16,
            height: 128,
            origin: { x: 80, y: 64 },
            selectedPixelCount: selectedMask.length,
            sha256: sha256Bytes(selectedMaskBytes),
            data: selectedMaskBytes.toString('base64'),
          },
          definition: { method: 'inherit-source' },
          distribution: splitProvincePolicy,
        },
        {
          id: 'transaction-update-locator',
          kind: 'update_entity_locator',
          entity: 'synthetic_map_entity',
          name: 'synthetic_map_locator',
          position: [7, 8, 9],
        },
      ],
    });
    expectValidPlan(result);
    expect(result.transaction.readDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootKind: 'game',
          relativePath: 'map/provinces.bmp',
          sha256: beforeScan.files.find(
            ({ rootKind, relativePath }) =>
              rootKind === 'game' && relativePath === 'map/provinces.bmp',
          )?.sha256,
        }),
        expect.objectContaining({
          rootKind: 'dependency',
          relativePath: 'map/definition.csv',
        }),
      ]),
    );
    const affected = result.transaction.files.map(({ relativePath }) => relativePath);
    expect(affected).toEqual([
      'gfx/entities/synthetic_map.asset',
      'history/states/1-GAME.txt',
      'map/definition.csv',
      'map/provinces.bmp',
      'map/strategicregions/1-REGION.txt',
    ]);
    expect(
      result.transaction.files.find(
        ({ relativePath }) => relativePath === 'gfx/entities/synthetic_map.asset',
      )?.beforeSha256,
    ).toBe(
      sha256Bytes(
        required(beforeTree.get('gfx/entities/synthetic_map.asset'), 'the original entity locator'),
      ),
    );
    expect(
      result.transaction.files
        .filter(({ relativePath }) => relativePath !== 'gfx/entities/synthetic_map.asset')
        .every(({ beforeSha256 }) => beforeSha256 === null),
    ).toBe(true);
    expect(await treeSnapshot(roots.mod)).toEqual(beforeTree);

    await expect(
      harness.transactions.apply(
        harness.workspaceId,
        result.transaction.transactionId,
        '0'.repeat(64),
        { postValidate },
      ),
    ).rejects.toMatchObject({ code: 'TRANSACTION_PLAN_HASH_MISMATCH' });
    expect(await treeSnapshot(roots.mod)).toEqual(beforeTree);

    const applied = await harness.transactions.apply(
      harness.workspaceId,
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    expect(applied.appliedFiles).toEqual(affected);
    const afterTree = await treeSnapshot(roots.mod);
    expect(changedPaths(beforeTree, afterTree)).toEqual(affected);
    expect(afterTree.get('notes/untouched.txt')).toEqual(beforeTree.get('notes/untouched.txt'));

    const afterScan = await harness.nudger.scan(harness.workspaceId);
    expect(afterScan.index.definitionsById.has(5)).toBe(true);
    expect(afterScan.index.entityLocators[0]?.position).toEqual([7, 8, 9]);
    const beforeBitmap = required(beforeScan.index.provinceBitmap, 'the baseline province bitmap');
    const afterBitmap = required(afterScan.index.provinceBitmap, 'the applied province bitmap');
    expect(beforeBitmap.diffBounds(afterBitmap)).toEqual({
      minX: 80,
      minY: 64,
      maxX: 95,
      maxY: 191,
      count: selectedMask.length,
    });
    let unexpectedPixelChanges = 0;
    let changedPixelCount = 0;
    for (let y = 0; y < beforeBitmap.height; y += 1) {
      for (let x = 0; x < beforeBitmap.width; x += 1) {
        const changed = rgbKey(beforeBitmap.rgbAt(x, y)) !== rgbKey(afterBitmap.rgbAt(x, y));
        const selected = x >= 80 && x <= 95 && y >= 64 && y <= 191;
        if (changed) changedPixelCount += 1;
        if (changed !== selected) unexpectedPixelChanges += 1;
      }
    }
    expect(changedPixelCount).toBe(selectedMask.length);
    expect(unexpectedPixelChanges).toBe(0);
  }, 120_000);

  it('applies exact normal-adjacency geometry with declarative state localisation in one transaction', async () => {
    const transactionRoot = path.join(temporaryRoot, 'normal-adjacency-localisation-transaction');
    const roots = await copyFixtureRoots(transactionRoot);
    const harness = await createHarness(
      roots,
      path.join(transactionRoot, 'runtime'),
      'map_normal_adjacency_localisation',
    );
    const beforeTree = await treeSnapshot(roots.mod);
    const removeBoundary = Array.from({ length: 256 }, (_, y) => ({
      x: 191,
      y,
      sourceProvinceId: 2,
      targetProvinceId: 1,
    }));
    const result = await harness.nudger.plan({
      workspaceId: harness.workspaceId,
      operations: [
        {
          id: 'transaction-add-normal-adjacency',
          kind: 'add_normal_adjacency',
          from: 1,
          to: 2,
          pixelTransfers: [{ x: 127, y: 10, sourceProvinceId: 4, targetProvinceId: 1 }],
        },
        {
          id: 'transaction-remove-normal-adjacency',
          kind: 'remove_normal_adjacency',
          from: 2,
          to: 3,
          pixelTransfers: removeBoundary,
        },
        {
          id: 'transaction-update-normal-adjacency-coast',
          kind: 'update_province_definition',
          provinceId: 2,
          changes: { coastal: false },
        },
        {
          id: 'transaction-create-localised-state',
          kind: 'create_state',
          sourceStateId: 1,
          stateId: 3,
          provinceIds: [4],
          name: 'STATE_AGENT_TRANSACTION',
          fileName: '3-AGENT-TRANSACTION.txt',
          localisation: {
            method: 'upsert',
            language: 'l_english',
            value: 'Agent Transaction State',
            file: 'localisation/english/agent_transaction_l_english.yml',
          },
          distribution: exactStatePolicy,
        },
      ],
    });
    expectValidPlan(result);
    expect(result.plan.expectedChangedBounds).toEqual({
      minX: 127,
      minY: 0,
      maxX: 191,
      maxY: 255,
      count: 257,
    });
    expect(result.plan.finalIndex.raster?.adjacency.get(1)?.has(2)).toBe(true);
    expect(result.plan.finalIndex.raster?.adjacency.get(2)?.has(3)).toBe(false);
    const localisationPath = 'localisation/english/agent_transaction_l_english.yml';
    expect(result.transaction.files.map(({ relativePath }) => relativePath)).toContain(
      localisationPath,
    );
    const localisationChange = result.plan.changes.find(
      ({ relativePath }) => relativePath === localisationPath,
    )?.content;
    expect(localisationChange?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(await treeSnapshot(roots.mod)).toEqual(beforeTree);

    const applied = await harness.transactions.apply(
      harness.workspaceId,
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    const after = await harness.nudger.scan(harness.workspaceId);
    expect(after.index.raster?.adjacency.get(1)?.has(2)).toBe(true);
    expect(after.index.raster?.adjacency.get(2)?.has(3)).toBe(false);
    expect(after.index.statesById.get(3)?.name).toBe('STATE_AGENT_TRANSACTION');
    expect(
      after.index.localisationByKey.get('l_english:STATE_AGENT_TRANSACTION')?.[0]?.entry.value,
    ).toBe('Agent Transaction State');
    expect(
      (await readFile(path.join(roots.mod, ...localisationPath.split('/')))).subarray(0, 3),
    ).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  }, 120_000);

  it('applies a complete land-to-sea dependency migration', async () => {
    const transactionRoot = path.join(temporaryRoot, 'type-migration-transaction');
    const roots = await copyFixtureRoots(transactionRoot);
    const harness = await createHarness(
      roots,
      path.join(transactionRoot, 'runtime'),
      'map_type_migration',
    );
    const result = await harness.nudger.plan({
      workspaceId: harness.workspaceId,
      operations: [
        {
          id: 'migrate-land-four-to-sea',
          kind: 'update_province_definition',
          provinceId: 4,
          changes: { type: 'sea', coastal: true, terrain: 'ocean', continent: 0 },
          distribution: removeLandDependenciesPolicy,
        },
      ],
    });
    expectValidPlan(result);
    expect(result.transaction.files.map(({ relativePath }) => relativePath)).toEqual([
      'history/states/1-GAME.txt',
      'map/buildings.txt',
      'map/definition.csv',
      'map/railways.txt',
    ]);
    const applied = await harness.transactions.apply(
      harness.workspaceId,
      result.transaction.transactionId,
      result.transaction.planHash,
      { postValidate },
    );
    expect(applied.state).toBe('applied');
    const after = await harness.nudger.scan(harness.workspaceId);
    expect(after.index.definitionsById.get(4)).toMatchObject({
      type: 'sea',
      terrain: 'ocean',
      continent: 0,
    });
    expect(after.index.statesById.get(1)?.provinces).toEqual([1]);
    expect(after.index.statesById.get(1)?.provinceBuildings.has(4)).toBe(false);
    expect(after.index.buildingPositions.some(({ x }) => x === 70)).toBe(false);
    expect(after.index.railways).toEqual([]);
    const migratedStateSource = await readFile(
      path.join(roots.mod, 'history', 'states', '1-GAME.txt'),
      'utf8',
    );
    expect(migratedStateSource).toContain(
      '# Project-owned game-root state; comments and unknown blocks must survive targeted edits.',
    );
    expect(migratedStateSource).toContain('unknown_fixture_block = { preserve = yes }');
  }, 120_000);
});

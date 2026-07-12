import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import sharp from 'sharp';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { hashCanonical } from '../src/hoi4_agent_tools/core/canonical.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import {
  FocusWorkbench,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from '../src/hoi4_agent_tools/focus/index.js';
import {
  ScriptedGuiStudio,
  parsePreviewScenario,
  type GuiPreviewState,
} from '../src/hoi4_agent_tools/gui/index.js';
import {
  AgentNudger,
  renderMap,
  type MapBaseLayer,
  type MapOverlay,
} from '../src/hoi4_agent_tools/map/index.js';

interface FocusManifest {
  focusCount: number;
  layoutOptions: { laneSpacing: number; nodeSpacing: number };
}

interface GuiManifest {
  windowName: string;
  minimumVisibleElements: number;
  expected: {
    sourceElements: number;
    visibleElements: number;
    states: number;
    resolutions: number;
  };
}

interface MapManifest {
  dimensions: { width: number; height: number };
  definitionIds: number[];
  stateIds: number[];
  strategicRegionIds: number[];
}

interface MemorySample {
  rssMiB: number;
  heapUsedMiB: number;
  externalMiB: number;
}

interface RunMemory {
  before: MemorySample;
  after: MemorySample;
  rssDeltaMiB: number;
  heapUsedDeltaMiB: number;
}

interface TimedValue<T> {
  value: T;
  elapsedMs: number;
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const focusFixtureRoot = path.join(repositoryRoot, 'fixtures', 'focus');
const guiFixtureRoot = path.join(repositoryRoot, 'fixtures', 'gui');
const mapFixtureRoot = path.join(repositoryRoot, 'fixtures', 'map');
const oneMiB = 1024 * 1024;
const iconDataUri =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const guiStates: readonly GuiPreviewState[] = [
  'normal',
  'hover',
  'selected',
  'locked',
  'disabled',
  'warning',
  'active',
  'completed',
  'empty-list',
  'full-list',
  'minimum-value',
  'maximum-value',
  'long-text',
  'missing-localisation',
];

const guiResolutions = [
  { width: 640, height: 360, uiScale: 1 },
  { width: 960, height: 540, uiScale: 1 },
  { width: 1280, height: 720, uiScale: 0.9 },
];

const mapLayerCoverage = {
  province: true,
  state: true,
  'strategic-region': true,
  terrain: true,
  continent: true,
  owner: true,
  controller: true,
  cores: true,
  claims: true,
  coast: true,
} as const satisfies Record<MapBaseLayer, true>;
const mapLayers = Object.keys(mapLayerCoverage) as MapBaseLayer[];

const mapOverlayCoverage = {
  coastlines: true,
  ports: true,
  'victory-points': true,
  resources: true,
  'state-buildings': true,
  'province-buildings': true,
  'supply-nodes': true,
  railways: true,
  adjacencies: true,
  'building-positions': true,
  'unit-positions': true,
  'weather-positions': true,
} as const satisfies Record<MapOverlay, true>;
const mapOverlays = Object.keys(mapOverlayCoverage) as MapOverlay[];

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function memorySample(): MemorySample {
  const usage = process.memoryUsage();
  return {
    rssMiB: round(usage.rss / oneMiB),
    heapUsedMiB: round(usage.heapUsed / oneMiB),
    externalMiB: round(usage.external / oneMiB),
  };
}

function startMemory(): MemorySample {
  global.gc?.();
  return memorySample();
}

function finishMemory(before: MemorySample): RunMemory {
  const after = memorySample();
  return {
    before,
    after,
    rssDeltaMiB: round(after.rssMiB - before.rssMiB),
    heapUsedDeltaMiB: round(after.heapUsedMiB - before.heapUsedMiB),
  };
}

async function timed<T>(operation: () => T | Promise<T>): Promise<TimedValue<T>> {
  const started = performance.now();
  const value = await operation();
  return { value, elapsedMs: round(performance.now() - started) };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function createEngine(
  id: string,
  name: string,
  root: string,
  runtimeRoot: string,
  extra: { gameRoot?: string; dependencyRoots?: string[] } = {},
): Promise<{ resolver: WorkspaceResolver; engine: CoreEngine }> {
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(runtimeRoot, 'server-state'),
    storageRoots: [runtimeRoot],
    workspaces: [
      {
        id,
        name,
        root,
        kind: 'mod',
        ...(extra.gameRoot === undefined ? {} : { gameRoot: extra.gameRoot }),
        ...(extra.dependencyRoots === undefined ? {} : { dependencyRoots: extra.dependencyRoots }),
        artifactRoot: path.join(runtimeRoot, 'artifacts'),
        cacheRoot: path.join(runtimeRoot, 'cache'),
      },
    ],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  await engine.initialize();
  return { resolver, engine };
}

async function benchmarkFocus(runtimeRoot: string): Promise<Record<string, unknown>> {
  const [manifest, plan] = await Promise.all([
    readJson<FocusManifest>(path.join(focusFixtureRoot, 'fixture-manifest.json')),
    readJson<FocusTreePlan>(path.join(focusFixtureRoot, 'plans', 'synthetic_acceptance.plan.json')),
  ]);
  assert.equal(plan.focuses.length, manifest.focusCount);
  assert.ok(
    plan.focuses.length >= 250,
    'focus benchmark fixture must contain at least 250 focuses',
  );

  const workspaceId = 'benchmark_focus';
  const { resolver, engine } = await createEngine(
    workspaceId,
    'Project-owned focus benchmark fixture',
    path.join(focusFixtureRoot, 'workspace'),
    runtimeRoot,
  );
  const workbench = new FocusWorkbench(resolver, engine.transactions, engine.artifacts);

  const run = async (): Promise<{
    report: Record<string, unknown>;
    fingerprint: string;
    revision: string;
  }> => {
    const before = startMemory();
    const totalStarted = performance.now();
    const scan = await timed(() => engine.scan(workspaceId));
    const references: FocusReferenceCatalog = {
      decision: scan.value.index.findAll('decision').map(({ id }) => id),
      event: scan.value.index.findAll('event').map(({ id }) => id),
    };
    const layout = await timed(() => workbench.layout(plan, manifest.layoutOptions));
    const rendered = await timed(() =>
      workbench.renderAndStore(workspaceId, plan, {
        layout: layout.value,
        index: scan.value.index,
        references,
        horizontalSpacing: 144,
        verticalSpacing: 76,
        padding: 24,
        iconDataUris: { GFX_synthetic_focus: iconDataUri },
        renderProfile: { fixture: 'focus-acceptance-v1', benchmark: true },
      }),
    );
    const totalMs = round(performance.now() - totalStarted);
    assert.equal(layout.value.nodes.length, manifest.focusCount);
    assert.equal(rendered.value.artifacts.length, 6);
    return {
      report: {
        elapsedMs: {
          total: totalMs,
          sharedScanAndIndex: scan.elapsedMs,
          layout: layout.elapsedMs,
          lintRenderAndStore: rendered.elapsedMs,
        },
        memoryMiB: finishMemory(before),
      },
      fingerprint: hashCanonical({
        layoutHash: layout.value.layoutHash,
        hashes: rendered.value.bundle.hashes,
      }),
      revision: scan.value.revision,
    };
  };

  const cold = await run();
  const warm = await run();
  assert.equal(warm.revision, cold.revision);
  assert.equal(warm.fingerprint, cold.fingerprint);

  return {
    fixture: 'fixtures/focus',
    counts: {
      focuses: manifest.focusCount,
      routeFamilies: plan.branchGroups.length,
      sourceFiles: (await engine.scan(workspaceId)).files.length,
      outputArtifacts: 6,
    },
    cold: cold.report,
    warm: warm.report,
    deterministicOutput: true,
  };
}

async function benchmarkGui(runtimeRoot: string): Promise<Record<string, unknown>> {
  const [manifest, baselineScenario, comparisonScenario] = await Promise.all([
    readJson<GuiManifest>(path.join(guiFixtureRoot, 'fixture-manifest.json')),
    readJson<unknown>(path.join(guiFixtureRoot, 'scenarios', 'baseline.json')).then(
      parsePreviewScenario,
    ),
    readJson<unknown>(path.join(guiFixtureRoot, 'scenarios', 'comparison.json')).then(
      parsePreviewScenario,
    ),
  ]);
  assert.ok(
    manifest.expected.sourceElements >= 150,
    'GUI benchmark fixture must contain at least 150 source elements',
  );
  assert.equal(guiStates.length, manifest.expected.states);
  assert.equal(guiResolutions.length, manifest.expected.resolutions);

  const workspaceId = 'benchmark_gui';
  const { resolver, engine } = await createEngine(
    workspaceId,
    'Project-owned GUI benchmark fixture',
    path.join(guiFixtureRoot, 'workspace'),
    runtimeRoot,
  );
  const studio = new ScriptedGuiStudio(
    resolver,
    engine.transactions,
    engine.scanner,
    engine.artifacts,
  );

  const run = async (): Promise<{
    report: Record<string, unknown>;
    fingerprint: string;
    counts: Record<string, number>;
  }> => {
    const before = startMemory();
    const totalStarted = performance.now();
    const scan = await timed(() => studio.scan(workspaceId));
    const rendered = await timed(() =>
      studio.renderAndStore({
        workspaceId,
        windowName: manifest.windowName,
        scenario: baselineScenario,
        states: [...guiStates],
        resolutions: guiResolutions.map((resolution) => ({ ...resolution })),
        comparisonScenario,
      }),
    );
    const totalMs = round(performance.now() - totalStarted);
    const visibleElements = rendered.value.render.scene.elements.filter(
      ({ visible }) => visible,
    ).length;
    assert.equal(scan.value.graph.elements.length, manifest.expected.sourceElements);
    assert.equal(visibleElements, manifest.expected.visibleElements);
    assert.ok(visibleElements >= manifest.minimumVisibleElements);
    assert.equal(rendered.value.stateScenes.length, manifest.expected.states);
    assert.equal(rendered.value.resolutionScenes.length, manifest.expected.resolutions);
    return {
      report: {
        elapsedMs: {
          total: totalMs,
          explicitSourceScan: scan.elapsedMs,
          galleryRenderAndStoreIncludingOwnScan: rendered.elapsedMs,
        },
        memoryMiB: finishMemory(before),
      },
      fingerprint: hashCanonical(
        rendered.value.artifacts.map(({ name, sha256 }) => ({ name, sha256 })),
      ),
      counts: {
        sourceFiles: scan.value.files.length,
        sourceElements: scan.value.graph.elements.length,
        visibleElements,
        stateScenes: rendered.value.stateScenes.length,
        resolutionScenes: rendered.value.resolutionScenes.length,
        renderedVariants: rendered.value.render.images.length,
        outputArtifacts: rendered.value.artifacts.length,
        outputBytes: rendered.value.artifacts.reduce(
          (total, artifact) => total + (artifact.size ?? 0),
          0,
        ),
      },
    };
  };

  const cold = await run();
  const warm = await run();
  assert.deepEqual(warm.counts, cold.counts);
  assert.equal(warm.fingerprint, cold.fingerprint);

  return {
    fixture: 'fixtures/gui',
    counts: cold.counts,
    cold: cold.report,
    warm: warm.report,
    deterministicOutput: true,
  };
}

async function benchmarkMap(runtimeRoot: string): Promise<Record<string, unknown>> {
  const manifest = await readJson<MapManifest>(path.join(mapFixtureRoot, 'fixture-manifest.json'));
  const roots = {
    game: path.join(mapFixtureRoot, 'roots', 'game'),
    dependency: path.join(mapFixtureRoot, 'roots', 'dependency'),
    mod: path.join(mapFixtureRoot, 'roots', 'mod'),
  };
  const workspaceId = 'benchmark_map';
  const { resolver, engine } = await createEngine(
    workspaceId,
    'Project-owned full synthetic map benchmark fixture',
    roots.mod,
    runtimeRoot,
    { gameRoot: roots.game, dependencyRoots: [roots.dependency] },
  );
  const nudger = new AgentNudger(resolver, engine.transactions, engine.artifacts, engine.scanner);

  const run = async (): Promise<{
    report: Record<string, unknown>;
    fingerprint: string;
    counts: Record<string, number>;
    revision: string;
  }> => {
    const before = startMemory();
    const totalStarted = performance.now();
    const scan = await timed(() => nudger.scan(workspaceId));
    const rendered = await timed(() =>
      Promise.all(
        mapLayers.map((layer) =>
          renderMap(scan.value.index, { layer, overlays: [...mapOverlays], scale: 1 }),
        ),
      ),
    );
    const totalMs = round(performance.now() - totalStarted);
    const raster = scan.value.index.raster;
    assert.ok(raster, 'map benchmark fixture must resolve a province raster');
    assert.equal(raster.width, manifest.dimensions.width);
    assert.equal(raster.height, manifest.dimensions.height);
    assert.deepEqual(
      [...scan.value.index.definitionsById.keys()].sort((left, right) => left - right),
      manifest.definitionIds,
    );
    assert.deepEqual(
      [...scan.value.index.statesById.keys()].sort((left, right) => left - right),
      manifest.stateIds,
    );
    assert.deepEqual(
      [...scan.value.index.regionsById.keys()].sort((left, right) => left - right),
      manifest.strategicRegionIds,
    );
    assert.equal(mapLayers.length, 10, 'benchmark must render every current MapBaseLayer');
    assert.equal(mapOverlays.length, 12, 'benchmark must enable every current MapOverlay');
    assert.equal(rendered.value.length, mapLayers.length);
    const counts = {
      sourceFiles: scan.value.files.length,
      sourceBytes: scan.value.files.reduce((total, file) => total + file.size, 0),
      pixels: raster.width * raster.height,
      provinceDefinitions: scan.value.index.definitionsById.size,
      provincesWithGeometry: raster.geometry.size,
      states: scan.value.index.statesById.size,
      strategicRegions: scan.value.index.regionsById.size,
      baseLayersRendered: rendered.value.length,
      overlaysPerLayer: mapOverlays.length,
      outputPngBytes: rendered.value.reduce((total, bundle) => total + bundle.png.length, 0),
    };
    return {
      report: {
        elapsedMs: {
          total: totalMs,
          fullCrossRootScanAndIndex: scan.elapsedMs,
          allBaseLayersWithAllOverlays: rendered.elapsedMs,
        },
        memoryMiB: finishMemory(before),
      },
      fingerprint: hashCanonical(rendered.value.map(({ hashes }) => hashes)),
      counts,
      revision: scan.value.revision,
    };
  };

  const cold = await run();
  const warm = await run();
  assert.deepEqual(warm.counts, cold.counts);
  assert.equal(warm.revision, cold.revision);
  assert.equal(warm.fingerprint, cold.fingerprint);

  return {
    fixture: 'fixtures/map',
    counts: cold.counts,
    cold: cold.report,
    warm: warm.report,
    deterministicOutput: true,
  };
}

async function benchmarkCacheInvalidation(runtimeRoot: string): Promise<Record<string, unknown>> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace');
  await cp(path.join(focusFixtureRoot, 'workspace'), workspaceRoot, { recursive: true });
  const sourcePath = path.join(
    workspaceRoot,
    'common',
    'national_focus',
    'synthetic_acceptance.txt',
  );
  const initialTime = new Date('2020-01-01T00:00:00.000Z');
  const changedMetadataTime = new Date('2021-01-01T00:00:00.000Z');
  await utimes(sourcePath, initialTime, initialTime);
  const { engine } = await createEngine(
    'benchmark_cache',
    'Project-owned cache invalidation fixture copy',
    workspaceRoot,
    path.join(runtimeRoot, 'runtime'),
  );

  const baseline = await timed(() => engine.scan('benchmark_cache'));
  await utimes(sourcePath, changedMetadataTime, changedMetadataTime);
  const metadataOnly = await timed(() => engine.scan('benchmark_cache'));
  assert.equal(metadataOnly.value.revision, baseline.value.revision);
  assert.equal(metadataOnly.value, baseline.value);

  const original = await readFile(sourcePath);
  const marker = Buffer.from('synthetic_acceptance_tree', 'utf8');
  const markerOffset = original.indexOf(marker);
  assert.notEqual(markerOffset, -1, 'focus cache fixture mutation marker must exist');
  const mutated = Buffer.from(original);
  mutated[markerOffset] = 'x'.charCodeAt(0);
  const metadataBeforeContentChange = await stat(sourcePath);
  await writeFile(sourcePath, mutated);
  await utimes(sourcePath, changedMetadataTime, changedMetadataTime);
  const metadataAfterContentChange = await stat(sourcePath);
  assert.equal(metadataAfterContentChange.size, metadataBeforeContentChange.size);
  assert.equal(metadataAfterContentChange.mtimeMs, metadataBeforeContentChange.mtimeMs);

  const contentChanged = await timed(() => engine.scan('benchmark_cache'));
  assert.notEqual(contentChanged.value.revision, metadataOnly.value.revision);
  assert.notEqual(contentChanged.value, metadataOnly.value);

  return {
    fixture: 'temporary copy of fixtures/focus/workspace',
    baselineScanMs: baseline.elapsedMs,
    metadataOnlyChange: {
      scanMs: metadataOnly.elapsedMs,
      revisionUnchanged: true,
      inMemorySnapshotReused: true,
    },
    sameSizeAndMtimeContentChange: {
      scanMs: contentChanged.elapsedMs,
      sizeUnchanged: true,
      modifiedTimeUnchanged: true,
      revisionChanged: true,
      inMemorySnapshotInvalidated: true,
    },
  };
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-tools-benchmark-'));
  try {
    const focus = await benchmarkFocus(path.join(temporaryRoot, 'focus'));
    const gui = await benchmarkGui(path.join(temporaryRoot, 'gui'));
    const map = await benchmarkMap(path.join(temporaryRoot, 'map'));
    const cacheInvalidation = await benchmarkCacheInvalidation(
      path.join(temporaryRoot, 'cache-invalidation'),
    );
    const cpu = os.cpus()[0];
    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      command: 'npm run benchmark',
      methodology: {
        cold: 'first invocation in a fresh service with empty temporary artifact/cache roots',
        warm: 'immediate repeat in the same Node process; operating-system caches are not evicted',
        repetitions: 1,
        timingThresholds: 'none',
        garbageCollection: global.gc === undefined ? 'not exposed' : 'requested before each run',
      },
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        sharp: sharp.versions.sharp,
        libvips: sharp.versions.vips,
      },
      platform: {
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        cpu: cpu?.model.trim() ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        totalMemoryMiB: round(os.totalmem() / oneMiB),
      },
      fixtures: {
        ownership: 'project-owned synthetic inputs only',
        externalPathsRead: false,
      },
      focus,
      gui,
      map,
      cacheInvalidation,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

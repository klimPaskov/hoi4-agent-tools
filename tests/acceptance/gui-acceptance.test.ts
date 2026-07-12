import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredArtifact } from '../../src/hoi4_agent_tools/core/artifacts.js';
import {
  compareCodeUnits,
  hashCanonical,
  sha256Bytes,
} from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  ScriptedGuiStudio,
  fidelityCategories,
  parsePreviewScenario,
  type FidelityReport,
  type GuiPreviewScenario,
  type GuiPreviewState,
  type GuiScene,
} from '../../src/hoi4_agent_tools/gui/index.js';

interface GuiFixtureManifest {
  schemaVersion: number;
  windowName: string;
  minimumVisibleElements: number;
  expected: {
    sourceElements: number;
    visibleElements: number;
    tabs: number;
    cards: number;
    listRows: number;
    animationFrames: number;
    states: number;
    resolutions: number;
  };
  goldens: {
    guiSourceSha256: string;
    animationStripPngSha256: string;
    fullSvgSha256: string;
    layoutJsonSha256: string;
  };
  defectVariantIds: string[];
}

interface SourceReplacement {
  relativePath: string;
  search: string;
  replacement: string;
}

interface DefectScenarioPatch {
  elementStates?: Record<string, GuiPreviewState>;
  guiCosts?: Record<string, number>;
  scriptCosts?: Record<string, number>;
  listRowCount?: number;
}

interface DefectVariant {
  id: string;
  scenario?: DefectScenarioPatch;
  sourceReplacements?: SourceReplacement[];
  expectedDiagnosticCodes: string[];
}

interface DefectFixture {
  schemaVersion: number;
  variants: DefectVariant[];
}

interface AssetManifest {
  schemaVersion: number;
  projectOwned: boolean;
  outputSha256: Record<string, string>;
}

interface Harness {
  resolver: WorkspaceResolver;
  engine: CoreEngine;
  studio: ScriptedGuiStudio;
}

const allStates: readonly GuiPreviewState[] = [
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

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'gui');
const workspaceRoot = path.join(fixtureRoot, 'workspace');
const guiSourcePath = path.join(workspaceRoot, 'interface', 'synthetic_acceptance.gui');
const animationStripPath = path.join(
  workspaceRoot,
  'gfx',
  'interface',
  'synthetic_gui',
  'pulse_animation.png',
);
const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
const assetManifestPath = path.join(fixtureRoot, 'asset-manifest.json');
const baselineScenarioPath = path.join(fixtureRoot, 'scenarios', 'baseline.json');
const comparisonScenarioPath = path.join(fixtureRoot, 'scenarios', 'comparison.json');
const defectVariantsPath = path.join(fixtureRoot, 'invalid', 'defect-variants.json');
const workspaceId = 'gui_acceptance';

let temporaryRoot: string;
let manifest: GuiFixtureManifest;
let baselineScenario: GuiPreviewScenario;
let comparisonScenario: GuiPreviewScenario;
let defectFixture: DefectFixture;
let assetManifest: AssetManifest;
let harness: Harness;

async function createHarness(root: string, id: string, runtimeRoot: string): Promise<Harness> {
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(runtimeRoot, 'server-state'),
    storageRoots: [path.join(runtimeRoot, 'artifacts'), path.join(runtimeRoot, 'cache')],
    workspaces: [
      {
        id,
        name: 'Project-owned GUI acceptance fixture',
        root,
        kind: 'mod',
        artifactRoot: path.join(runtimeRoot, 'artifacts'),
        cacheRoot: path.join(runtimeRoot, 'cache'),
      },
    ],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  await engine.initialize();
  const studio = new ScriptedGuiStudio(
    resolver,
    engine.transactions,
    engine.scanner,
    engine.artifacts,
  );
  return { resolver, engine, studio };
}

function scenarioForVariant(variant: DefectVariant): GuiPreviewScenario {
  const raw = JSON.parse(JSON.stringify(baselineScenario)) as Record<string, unknown>;
  raw.id = `synthetic-defect-${variant.id}`;
  const patch = variant.scenario;
  if (patch?.elementStates !== undefined) {
    raw.elementStates = {
      ...(raw.elementStates as Record<string, GuiPreviewState>),
      ...patch.elementStates,
    };
  }
  if (patch?.guiCosts !== undefined) {
    raw.guiCosts = {
      ...(raw.guiCosts as Record<string, number>),
      ...patch.guiCosts,
    };
  }
  if (patch?.scriptCosts !== undefined) {
    raw.scriptCosts = {
      ...(raw.scriptCosts as Record<string, number>),
      ...patch.scriptCosts,
    };
  }
  if (patch?.listRowCount !== undefined) {
    raw.lists = {
      ...(raw.lists as Record<string, unknown>),
      objective_list: Array.from({ length: patch.listRowCount }, (_unused, index) => ({
        id: index + 1,
        label: `Defect objective ${String(index + 1).padStart(2, '0')}`,
        value: (index + 1) * 5,
        progress: Math.min(100, (index + 1) * 7),
      })),
    };
  }
  return parsePreviewScenario(raw);
}

async function applySourceReplacements(
  root: string,
  replacements: readonly SourceReplacement[],
): Promise<void> {
  for (const replacement of replacements) {
    const target = path.join(root, ...replacement.relativePath.split('/'));
    const source = await readFile(target, 'utf8');
    const occurrences = source.split(replacement.search).length - 1;
    expect(occurrences, `${replacement.relativePath} mutation must match exactly once`).toBe(1);
    await writeFile(target, source.replace(replacement.search, replacement.replacement), 'utf8');
  }
}

async function recursiveFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await recursiveFiles(candidate)));
    else if (entry.isFile()) output.push(candidate);
  }
  return output.sort(compareCodeUnits);
}

interface GuiArtifactScenarioEvidence {
  scenario: Pick<
    GuiPreviewScenario,
    'id' | 'resolution' | 'uiScale' | 'state' | 'animationTimeSeconds'
  >;
  sourceRevision: string;
  fidelity: Record<string, { count: number; fields: string[]; fieldsTruncated: boolean }>;
}

function fidelitySummary(report: FidelityReport): GuiArtifactScenarioEvidence['fidelity'] {
  return Object.fromEntries(
    Object.entries(report).map(([category, items]) => {
      const fields = [...new Set(items.map(({ field }) => field))].sort(compareCodeUnits);
      return [
        category,
        { count: items.length, fields: fields.slice(0, 256), fieldsTruncated: fields.length > 256 },
      ];
    }),
  );
}

function expectGuiArtifactProvenance(
  artifact: StoredArtifact,
  expectedScenes: readonly GuiScene[],
): void {
  const primary = expectedScenes[0];
  expect(primary).toBeDefined();
  if (primary === undefined) return;
  const profile = artifact.provenance.renderProfile as
    | {
        scenarioId: string;
        sourceRevision: string;
        fidelity: GuiArtifactScenarioEvidence['fidelity'];
        scenarios: GuiArtifactScenarioEvidence[];
      }
    | undefined;
  expect(profile).toBeDefined();
  if (profile === undefined) return;
  const expectedEvidence = expectedScenes.map((scene) => ({
    scenario: {
      id: scene.scenario.id,
      resolution: scene.scenario.resolution,
      uiScale: scene.scenario.uiScale,
      state: scene.scenario.state,
      animationTimeSeconds: scene.scenario.animationTimeSeconds,
    },
    sourceRevision: scene.sourceRevision,
    fidelity: fidelitySummary(scene.fidelity),
  }));

  expect(profile.scenarioId).toBe(primary.scenario.id);
  expect(profile.sourceRevision).toBe(primary.sourceRevision);
  expect(profile.sourceRevision).toBe(hashCanonical(artifact.provenance.sourceHashes));
  expect(profile.fidelity).toEqual(fidelitySummary(primary.fidelity));
  expect(Object.keys(profile.fidelity).sort()).toEqual([...fidelityCategories].sort());
  expect(profile.scenarios).toEqual(expectedEvidence);
  for (const evidence of profile.scenarios) {
    expect(Object.keys(evidence.fidelity).sort()).toEqual([...fidelityCategories].sort());
  }
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-gui-acceptance-'));
  const [manifestRaw, assetManifestRaw, baselineRaw, comparisonRaw, defectsRaw] = await Promise.all(
    [
      readFile(manifestPath, 'utf8'),
      readFile(assetManifestPath, 'utf8'),
      readFile(baselineScenarioPath, 'utf8'),
      readFile(comparisonScenarioPath, 'utf8'),
      readFile(defectVariantsPath, 'utf8'),
    ],
  );
  manifest = JSON.parse(manifestRaw) as GuiFixtureManifest;
  assetManifest = JSON.parse(assetManifestRaw) as AssetManifest;
  baselineScenario = parsePreviewScenario(JSON.parse(baselineRaw));
  comparisonScenario = parsePreviewScenario(JSON.parse(comparisonRaw));
  defectFixture = JSON.parse(defectsRaw) as DefectFixture;
  harness = await createHarness(workspaceRoot, workspaceId, path.join(temporaryRoot, 'baseline'));
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('Scripted GUI Studio project-owned acceptance fixture', () => {
  it('resolves a 150+ element stateful GUI through the real scanner, source graph, layout, fonts, and validators', async () => {
    const scanned = await harness.studio.scan(workspaceId);
    const linted = await harness.studio.lint({
      workspaceId,
      windowName: manifest.windowName,
      scenario: baselineScenario,
    });
    const { graph, scene, validation } = linted;
    const visible = scene.elements.filter(({ visible: isVisible }) => isVisible);
    const hardGraphDiagnostics = graph.diagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(assetManifest).toEqual(
      expect.objectContaining({ schemaVersion: 1, projectOwned: true }),
    );
    for (const [relativePath, expectedHash] of Object.entries(assetManifest.outputSha256)) {
      expect(sha256Bytes(await readFile(path.join(fixtureRoot, ...relativePath.split('/'))))).toBe(
        expectedHash,
      );
    }
    expect(hardGraphDiagnostics).toEqual([]);
    expect(
      scanned.files.some(({ relativePath }) => /\.(?:png|bmp|tga|dds|svg)$/iu.test(relativePath)),
    ).toBe(false);
    expect(graph.animationSources).toHaveLength(1);
    expect(graph.animationSources[0]?.sprite).toBe('GFX_syn_pulse');
    expect(graph.animationSources[0]?.projectOwned).toBe(true);
    expect(
      graph.animationSources[0]?.sourceFrames.some(
        ({ anchor }) => anchor.x === 24 && anchor.y === 24,
      ),
    ).toBe(true);
    expect(graph.elements).toHaveLength(manifest.expected.sourceElements);
    expect(visible).toHaveLength(manifest.expected.visibleElements);
    expect(visible.length).toBeGreaterThanOrEqual(manifest.minimumVisibleElements);
    expect(scene.elements.filter(({ name }) => name.startsWith('tab_'))).toHaveLength(
      manifest.expected.tabs,
    );
    expect(scene.elements.filter(({ name }) => /^status_card_\d+$/u.test(name))).toHaveLength(
      manifest.expected.cards,
    );
    expect(scene.elements.filter(({ name }) => name === 'objective_row')).toHaveLength(
      manifest.expected.listRows,
    );
    expect(
      scene.elements.find(({ name, rowIndex }) => name === 'objective_row_label' && rowIndex === 2)
        ?.text?.text,
    ).toBe('Objective 03');
    expect(
      scene.elements.find(({ name }) => name === 'readiness_meter')?.progressRatio,
    ).toBeCloseTo(0.72, 5);

    const states = new Map(scene.elements.map(({ name, state }) => [name, state]));
    expect(states.get('tab_overview')).toBe('selected');
    expect(states.get('tab_operations')).toBe('hover');
    expect(states.get('tab_intelligence')).toBe('locked');
    expect(states.get('tab_diplomacy')).toBe('disabled');
    expect(states.get('risk_meter')).toBe('warning');
    expect(states.get('card_action_01')).toBe('completed');
    expect(states.get('modal_confirm')).toBe('active');

    const scripted = graph.scriptedGuis.find(({ name }) => name === 'synthetic_gui_controller');
    expect(scripted?.dynamicLists).toContain('objective_list');
    expect(scripted?.properties).toHaveLength(14);
    expect(scripted?.effects).toHaveLength(20);
    expect(scripted?.triggers).toHaveLength(20);
    expect(
      graph.edges.some(({ kind, resolved }) => kind === 'decision_category_entry' && resolved),
    ).toBe(true);
    const tooltipEdges = graph.edges.filter(
      ({ kind, metadata }) => kind === 'uses_localisation' && metadata.field === 'pdx_tooltip',
    );
    expect(tooltipEdges).toHaveLength(20);
    expect(tooltipEdges.every(({ resolved }) => resolved)).toBe(true);

    const animation = graph.sprites.find(({ name }) => name === 'GFX_syn_pulse');
    expect(animation).toEqual(
      expect.objectContaining({
        frameAnimated: true,
        frameCount: manifest.expected.animationFrames,
        animationRateFps: 4,
        looping: true,
        playOnShow: true,
        staticFallback: 'GFX_syn_pulse_static',
      }),
    );
    const animated = scene.elements.find(({ name }) => name === 'animated_status');
    expect(animated?.sprite?.frame).toBe(2);
    const early = await harness.studio.lint({
      workspaceId,
      windowName: manifest.windowName,
      scenario: {
        ...baselineScenario,
        id: 'synthetic-animation-frame-zero',
        animationTimeSeconds: 0.1,
      },
    });
    const earlyAnimated = early.scene.elements.find(({ name }) => name === 'animated_status');
    expect(earlyAnimated?.sprite?.frame).toBe(0);
    expect(earlyAnimated?.sprite?.dataUri).not.toBe(animated?.sprite?.dataUri);
    const validationCodes = new Set(validation.diagnostics.map(({ code }) => code));
    expect(validationCodes.has('GUI_ANIMATION_SOURCE_PROVENANCE_UNAVAILABLE')).toBe(false);
    expect([...validationCodes].filter((code) => code.startsWith('GUI_ANIMATION_SOURCE_'))).toEqual(
      [],
    );
    expect(validationCodes.has('GUI_COST_MISMATCH')).toBe(false);
    const confirmEffect = graph.scriptedGuis
      .find(({ name }) => name === 'synthetic_gui_controller')
      ?.effectDefinitions.find(({ name }) => name === 'modal_confirm_click');
    expect(confirmEffect?.elementName).toBe('modal_confirm');
    expect(confirmEffect?.costs).toEqual({ pol_power: 12 });
    expect(confirmEffect?.location?.path).toContain('synthetic_acceptance.txt');
    const longText = scene.elements.find(({ name }) => name === 'long_localisation_probe')?.text;
    expect(longText?.metricSource).toBe('bmfont');
    expect(longText?.lines.length).toBeGreaterThan(1);
    expect(longText?.overflowY).toBe(true);
    expect(validation.diagnostics.map(({ code }) => code)).toContain('GUI_TEXT_OVERFLOW');

    expect(Object.keys(scene.fidelity).sort()).toEqual([...fidelityCategories].sort());
    expect(scene.fidelity.modelled.length).toBeGreaterThan(0);
    expect(scene.fidelity.approximated.length).toBeGreaterThan(0);
    expect(scene.fidelity.ignored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'fixedsize' }),
        expect.objectContaining({ field: 'pdx_tooltip' }),
      ]),
    );
    expect(scene.fidelity.missing.some(({ field }) => field === 'font_glyphs')).toBe(true);
    expect(scene.fidelity.unsupported.some(({ field }) => field === 'rotation')).toBe(true);
    expect(scene.fidelity.unresolved.some(({ field }) => field === 'dynamic_text')).toBe(true);
  }, 60_000);

  it('stores deterministic render, hierarchy, source-map, state, resolution, and bitmap-comparison evidence', async () => {
    const renderInput = {
      workspaceId,
      windowName: manifest.windowName,
      scenario: baselineScenario,
      states: [...allStates],
      resolutions: [
        { width: 640, height: 360, uiScale: 1 },
        { width: 960, height: 540, uiScale: 1 },
        { width: 1280, height: 720, uiScale: 0.9 },
      ],
      comparisonScenario,
    };
    const first = await harness.studio.renderAndStore(renderInput);
    const second = await harness.studio.renderAndStore(renderInput);

    expect(first.render.images.map(({ variant }) => variant)).toEqual([
      'full',
      'cropped',
      'annotated',
      'click-regions',
      'source-map',
    ]);
    expect(first.stateScenes).toHaveLength(manifest.expected.states);
    expect(new Set(first.stateScenes.map(({ scenario }) => scenario.state))).toEqual(
      new Set(allStates),
    );
    expect(first.resolutionScenes).toHaveLength(manifest.expected.resolutions);
    expect(
      first.resolutionScenes.map(({ scenario }) => ({
        resolution: scenario.resolution,
        uiScale: scenario.uiScale,
      })),
    ).toEqual([
      { resolution: { width: 640, height: 360 }, uiScale: 1 },
      { resolution: { width: 960, height: 540 }, uiScale: 1 },
      { resolution: { width: 1280, height: 720 }, uiScale: 0.9 },
    ]);

    const byVariant = new Map(first.render.images.map((image) => [image.variant, image]));
    const full = byVariant.get('full');
    const cropped = byVariant.get('cropped');
    expect(full).toBeDefined();
    expect(cropped?.width).toBeLessThan(full?.width ?? 0);
    expect(byVariant.get('annotated')?.svg).toContain('long_localisation_probe');
    expect(byVariant.get('click-regions')?.svg).toContain('modal_confirm');
    expect(byVariant.get('source-map')?.svg).toContain('synthetic_acceptance.gui');
    expect(first.render.hierarchySvg).toContain('confirmation_modal');
    expect(first.render.layoutJson).toContain('"metricSource":"bmfont"');
    expect(first.render.layoutJson).not.toContain('data:image');
    expect(first.render.scenarioJson).toContain('"id":"synthetic-acceptance"');
    expect(full?.svg).toContain('<image id="gui-font-bitmap-');
    expect(full?.svg).toContain('<use href="#gui-font-bitmap-');
    expect(full?.svg).toContain('data-font-sha256=');
    expect(full?.svg).not.toMatch(/<text\b|font-family=/u);
    const bitmapGlyphs = first.render.scene.elements.flatMap(
      ({ text }) =>
        text?.glyphLines.flatMap(({ glyphs, source }) =>
          source === 'bmfont-atlas' ? glyphs.filter((glyph) => glyph.kind === 'bitmap') : [],
        ) ?? [],
    );
    expect(bitmapGlyphs.length).toBeGreaterThan(100);
    expect(new Set(bitmapGlyphs.map(({ dataUri }) => dataUri)).size).toBeGreaterThan(20);
    expect(
      first.render.scene.fidelity.modelled.some(({ field }) => field === 'font_glyph_rendering'),
    ).toBe(true);

    const requiredNames = [
      'synthetic_gui_window-full.png',
      'synthetic_gui_window-full.svg',
      'synthetic_gui_window-cropped.png',
      'synthetic_gui_window-annotated.png',
      'synthetic_gui_window-click-regions.png',
      'synthetic_gui_window-source-map.png',
      'synthetic_gui_window-hierarchy.svg',
      'synthetic_gui_window-layout.json',
      'synthetic_gui_window-state-matrix.png',
      'synthetic_gui_window-state-matrix.json',
      'synthetic_gui_window-resolution-scale.png',
      'synthetic_gui_window-resolution-scale.json',
      'synthetic_gui_window-comparison.png',
      'synthetic_gui_window-comparison.json',
    ];
    const artifactNames = new Set(first.artifacts.map(({ name }) => name));
    for (const required of requiredNames) expect(artifactNames).toContain(required);
    expect(first.artifacts).toHaveLength(24);
    expect(second.artifacts.map(({ name, sha256, uri }) => ({ name, sha256, uri }))).toEqual(
      first.artifacts.map(({ name, sha256, uri }) => ({ name, sha256, uri })),
    );
    for (const firstImage of first.render.images) {
      const secondImage = second.render.images.find(
        ({ variant }) => variant === firstImage.variant,
      );
      expect(secondImage?.svg).toBe(firstImage.svg);
      expect(secondImage?.png.equals(firstImage.png)).toBe(true);
      expect(firstImage.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      const metadata = await sharp(firstImage.png).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(firstImage.width);
      expect(metadata.height).toBe(firstImage.height);
    }

    expect(first.comparison.changedPixels).toBeGreaterThan(0);
    expect(first.comparison.changedRatio).toBeGreaterThan(0);
    expect(first.comparison.changedRatio).toBeLessThan(1);
    expect(first.comparison.png.equals(second.comparison.png)).toBe(true);
    expect(JSON.parse(first.comparison.json)).toEqual(
      expect.objectContaining({ offline: true, threshold: 8 }),
    );

    expect({
      guiSourceSha256: sha256Bytes(await readFile(guiSourcePath)),
      animationStripPngSha256: sha256Bytes(await readFile(animationStripPath)),
      fontAtlasPngSha256: sha256Bytes(
        await readFile(path.join(workspaceRoot, 'fonts', 'synthetic_fixture_font.png')),
      ),
      fullSvgSha256: sha256Bytes(Buffer.from(full?.svg ?? '', 'utf8')),
      fullPngSha256: sha256Bytes(full?.png ?? Buffer.alloc(0)),
      layoutJsonSha256: sha256Bytes(Buffer.from(first.render.layoutJson, 'utf8')),
    }).toEqual(manifest.goldens);

    const comparisonScene = (
      await harness.studio.lint({
        workspaceId,
        windowName: manifest.windowName,
        scenario: comparisonScenario,
      })
    ).scene;
    const workspace = harness.resolver.get(workspaceId);
    for (const artifact of first.artifacts) {
      const stored = await harness.engine.artifacts.read(workspace, artifact.uri);
      const described = await harness.engine.artifacts.describe(workspace, artifact.uri);
      expect(stored.name).toBe(artifact.name);
      expect(stored.mimeType).toBe(artifact.mimeType);
      expect(sha256Bytes(stored.bytes)).toBe(artifact.sha256);
      expect(stored.bytes).toEqual(await readFile(artifact.path));
      expect(described).toMatchObject({
        name: artifact.name,
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        provenanceHash: artifact.provenanceHash,
      });
      const expectedScenes = artifact.name.includes('-state-matrix.')
        ? first.stateScenes
        : artifact.name.includes('-resolution-scale.')
          ? first.resolutionScenes
          : artifact.name.includes('-comparison.')
            ? [first.render.scene, comparisonScene]
            : artifact.name.endsWith('-validation.json')
              ? [first.render.scene, ...first.stateScenes, ...first.resolutionScenes]
              : [first.render.scene];
      expectGuiArtifactProvenance(described, expectedScenes);
    }
    expect(await harness.engine.artifacts.list(workspace)).toHaveLength(24);
  }, 180_000);

  it('detects every checked-in scenario and source defect through fresh real Studio workspaces', async () => {
    expect(defectFixture.schemaVersion).toBe(1);
    expect(defectFixture.variants.map(({ id }) => id)).toEqual(manifest.defectVariantIds);

    for (const variant of defectFixture.variants) {
      const variantRoot = path.join(temporaryRoot, 'defects', variant.id, 'workspace');
      await mkdir(path.dirname(variantRoot), { recursive: true });
      await cp(workspaceRoot, variantRoot, { recursive: true });
      await applySourceReplacements(variantRoot, variant.sourceReplacements ?? []);
      const id = `gui_defect_${variant.id.replaceAll('-', '_')}`;
      const variantHarness = await createHarness(
        variantRoot,
        id,
        path.join(temporaryRoot, 'defects', variant.id, 'runtime'),
      );
      const result = await variantHarness.studio.lint({
        workspaceId: id,
        windowName: manifest.windowName,
        scenario: scenarioForVariant(variant),
      });
      const codes = new Set(result.validation.diagnostics.map(({ code }) => code));
      for (const expectedCode of variant.expectedDiagnosticCodes) {
        expect(codes, `${variant.id} should report ${expectedCode}`).toContain(expectedCode);
      }
    }
  }, 120_000);

  it('contains no child-process or game-automation path in the accepted GUI surface', async () => {
    const targets = [
      ...(await recursiveFiles(path.join(repositoryRoot, 'src', 'hoi4_agent_tools', 'gui'))),
      ...(await recursiveFiles(fixtureRoot)),
      path.join(repositoryRoot, 'scripts', 'generate-gui-fixture.ts'),
      path.join(repositoryRoot, 'tests', 'acceptance', 'gui-acceptance.test.ts'),
    ];
    const inspected = (
      await Promise.all(
        targets.map(async (target) => `${target}\n${await readFile(target, 'utf8')}`),
      )
    ).join('\n');
    const childProcessModule = ['node:', 'child', '_process'].join('');
    const gameExecutable = ['hoi4', '.exe'].join('');
    const installedGameExecutable = ['Hearts of Iron IV', '.exe'].join('');

    expect(inspected).not.toContain(childProcessModule);
    expect(inspected.toLowerCase()).not.toContain(gameExecutable);
    expect(inspected).not.toContain(installedGameExecutable);
    expect(inspected).not.toMatch(/\b(?:spawn|execFile|execSync)\s*\(/u);
  });
});

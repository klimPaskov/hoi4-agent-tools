import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { renderTechnologies } from '../../src/hoi4_agent_tools/technology/operations.js';
import {
  TechnologyTreeViewer,
  analyzeTechnologyImpact,
  compareTechnologyGraphs,
  discoverTechnologyFolders,
  explainTechnology,
  inspectTechnologyUnlocks,
  lintTechnologyGraph,
  renderTechnologyGraph,
  technologyBonusCoverage,
  technologyScanReport,
  traceTechnology,
  buildTechnologyGraph,
  type TechnologyGraphSnapshot,
} from '../../src/hoi4_agent_tools/technology/index.js';

interface GraphManifest {
  technologyIds: string[];
  folderIds: string[];
  counts: {
    technologies: number;
    legacyDoctrines: number;
    totalTechnologyDefinitions: number;
    folders: number;
    placements: number;
    gridboxes: number;
    prerequisites: number;
    exclusiveEdges: number;
    subTechnologyEdges: number;
    categoriesAndTags: number;
  };
  prerequisiteEdges: Array<{ from: string; to: string }>;
  multiplePlacements: string[];
  intentionalIssueCodes: string[];
}

interface ReferenceManifest {
  unlocks: Array<{ technologyId: string; kind: string; targetId: string }>;
  externalSources: Array<{
    sourceKind: string;
    sourceId: string;
    technologyId?: string;
    categoryId?: string;
    kind: string;
    helperStack?: string[];
  }>;
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'technology');
const fixtureWorkspace = path.join(fixtureRoot, 'workspace');
const workspaceId = 'technology_acceptance';
let temporaryRoot: string;
let workspaceRoot: string;
let engine: CoreEngine;
let viewer: TechnologyTreeViewer;
let graph: TechnologyGraphSnapshot;
let graphManifest: GraphManifest;
let referenceManifest: ReferenceManifest;

function externalKey(value: {
  sourceKind: string;
  sourceId: string;
  technologyId?: string;
  categoryId?: string;
  kind: string;
  helperStack?: string[];
}): string {
  return [
    value.sourceKind,
    value.sourceId,
    value.technologyId ?? '',
    value.categoryId ?? '',
    value.kind,
    ...(value.helperStack ?? []),
  ].join(':');
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-technology-acceptance-'));
  workspaceRoot = path.join(temporaryRoot, 'workspace');
  await cp(fixtureWorkspace, workspaceRoot, { recursive: true });
  [graphManifest, referenceManifest] = await Promise.all([
    readFile(path.join(fixtureRoot, 'expected', 'graph-manifest.json'), 'utf8').then(
      (value) => JSON.parse(value) as GraphManifest,
    ),
    readFile(path.join(fixtureRoot, 'expected', 'reference-manifest.json'), 'utf8').then(
      (value) => JSON.parse(value) as ReferenceManifest,
    ),
  ]);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporaryRoot, 'server-state'),
    storageRoots: [path.join(temporaryRoot, 'artifacts'), path.join(temporaryRoot, 'cache')],
    workspaces: [
      {
        id: workspaceId,
        name: 'Project-owned technology acceptance fixture',
        root: workspaceRoot,
        kind: 'mod',
        artifactRoot: path.join(temporaryRoot, 'artifacts'),
        cacheRoot: path.join(temporaryRoot, 'cache'),
      },
    ],
  });
  engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  viewer = new TechnologyTreeViewer(engine);
  graph = await viewer.scan(workspaceId, { refresh: true });
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('Technology Tree Viewer project-owned acceptance fixture', () => {
  it('indexes every definition, source placement, edge family, category, tag, and doctrine form', async () => {
    const snapshot = await engine.scan(workspaceId);
    expect(snapshot.index.findAll('technology')).toHaveLength(
      graphManifest.counts.totalTechnologyDefinitions,
    );
    expect(snapshot.index.findAll('technology_folder')).toHaveLength(graphManifest.counts.folders);
    expect(snapshot.index.findAll('technology_category')).toHaveLength(
      graphManifest.counts.folders + 1,
    );
    expect(snapshot.index.findAll('technology_tag')).toHaveLength(4);
    expect(snapshot.index.findAll('grand_doctrine')).toHaveLength(1);
    expect(snapshot.index.findAll('doctrine_track')).toHaveLength(2);
    expect(snapshot.index.findAll('subdoctrine')).toHaveLength(2);
    expect(
      snapshot.index.references.filter(
        ({ toKind, to }) => toKind === 'technology_tag' && to === 'synthetic_tag_00',
      ).length,
    ).toBeGreaterThan(0);
    const unknownFieldTechnology = graph.technologies.find(
      ({ id }) => id === 'synthetic_tech_0019',
    );
    expect(unknownFieldTechnology?.rawSource).toContain(
      '# Unknown fixture fields remain visible in the authoritative source record.',
    );
    expect(unknownFieldTechnology?.effectKeys).toContain('synthetic_unknown_field');
    expect(graph.technologies.find(({ id }) => id === 'synthetic_tech_0000')?.layoutSize).toBe(
      'small',
    );
    expect(graph.technologies.find(({ id }) => id === 'synthetic_tech_0001')?.layoutSize).toBe(
      'unknown',
    );
    expect(graph.technologies).toHaveLength(graphManifest.counts.totalTechnologyDefinitions);
    expect(graph.statistics.technologyCount).toBe(graphManifest.counts.technologies);
    expect(graph.statistics.legacyDoctrineCount).toBe(graphManifest.counts.legacyDoctrines);
    expect(graph.technologies.map(({ id }) => id)).toEqual(graphManifest.technologyIds);
    expect(graph.folders.map(({ id }) => id)).toEqual(graphManifest.folderIds);
    expect(graph.placements).toHaveLength(graphManifest.counts.placements);
    expect(graph.gridboxes).toHaveLength(graphManifest.counts.gridboxes);
    expect(graph.backgrounds).toEqual([
      expect.objectContaining({
        folderId: 'synthetic_folder_01',
        name: 'synthetic_techtree_bg',
        sprite: 'GFX_synthetic_techtree_bg',
        size: { width: 144, height: 96 },
      }),
    ]);
    expect(
      graph.itemLayouts.find(({ name }) => name === 'techtree_synthetic_folder_00_item')
        ?.subTechnologySlots,
    ).toEqual([
      {
        index: 0,
        position: { x: 139, y: 2 },
        size: { width: 35, height: 26 },
        sprite: 'GFX_synthetic_subtech_slot',
      },
    ]);
    expect(graph.edges.filter(({ kind }) => kind === 'prerequisite')).toHaveLength(
      graphManifest.counts.prerequisites,
    );
    expect(graph.edges.filter(({ kind }) => kind === 'exclusive')).toHaveLength(
      graphManifest.counts.exclusiveEdges,
    );
    expect(graph.edges.filter(({ kind }) => kind === 'sub_technology')).toHaveLength(
      graphManifest.counts.subTechnologyEdges,
    );
    expect(graph.categories).toHaveLength(graphManifest.counts.categoriesAndTags);
    expect(graph.doctrineDefinitions.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['folder', 'grand_doctrine', 'track', 'subdoctrine', 'reward']),
    );
    expect(
      graph.placements.filter(({ geometryStatus }) => geometryStatus === 'source_pixel').length,
    ).toBe(graph.placements.length);
    for (const expected of graphManifest.prerequisiteEdges) {
      const edge = graph.edges.find(
        ({ kind, from, to }) =>
          kind === 'prerequisite' && from === expected.from && to === expected.to,
      );
      expect(edge, `${expected.from} -> ${expected.to}`).toBeDefined();
      expect(edge?.location.path).toMatch(/^mod:common\/technologies\//u);
    }
    for (const technologyId of graphManifest.multiplePlacements) {
      expect(
        graph.placements.filter(({ technologyId: candidate }) => candidate === technologyId),
      ).toHaveLength(2);
    }
    const grantOnly = graph.technologies.at(-2)!;
    expect(grantOnly.hidden).toBe(true);
    expect(graph.placements.some(({ technologyId }) => technologyId === grantOnly.id)).toBe(false);
    expect(
      graph.externalReferences.some(
        ({ technologyId, kind }) => technologyId === grantOnly.id && kind === 'grant',
      ),
    ).toBe(true);
    expect(
      graph.issues.some(
        ({ code, details }) =>
          code === 'TECH_HIDDEN_OR_UNPLACED_WITHOUT_GRANT' && details.technologyId === grantOnly.id,
      ),
    ).toBe(false);
  });

  it('answers path, explanation, folder, unlock, bonus, and impact questions with provenance', () => {
    const trace = traceTechnology(graph, {
      technologyId: 'synthetic_tech_0039',
      direction: 'prerequisites',
      maxDepth: 100,
      maxNodes: 1_000,
    });
    expect(trace.nodes).toContain('synthetic_tech_0000');
    expect(trace.edges.every(({ location }) => location.path.startsWith('mod:'))).toBe(true);
    const explanation = explainTechnology(graph, 'synthetic_tech_0003') as {
      placements: unknown[];
      unlocks: Array<{ kind: string; targetId: string }>;
      transitivePrerequisites: { nodes: string[] };
    };
    expect(explanation.placements).toHaveLength(2);
    expect(explanation.unlocks).toContainEqual(
      expect.objectContaining({ kind: 'building', targetId: 'synthetic_building' }),
    );
    expect(explanation.transitivePrerequisites.nodes).toContain('synthetic_tech_0000');
    const folders = discoverTechnologyFolders(graph, 'synthetic_folder_01') as {
      folders: Array<{ roots: string[]; placements: unknown[] }>;
    };
    expect(folders.folders[0]?.roots).toEqual(
      expect.arrayContaining(['synthetic_tech_0000', 'synthetic_tech_0080']),
    );
    const unlocks = inspectTechnologyUnlocks(graph, {}) as { unlocks: typeof graph.unlocks };
    for (const expected of referenceManifest.unlocks) {
      expect(unlocks.unlocks).toContainEqual(expect.objectContaining(expected));
    }
    const coverage = technologyBonusCoverage(graph, { categoryId: 'synthetic_category_04' }) as {
      rows: Array<{ covered: boolean }>;
    };
    expect(coverage.rows[0]?.covered).toBe(true);
    const impact = analyzeTechnologyImpact(graph, {
      kind: 'technology',
      id: 'synthetic_tech_0004',
      operation: 'rename',
      replacementId: 'synthetic_tech_renamed',
    }) as { referenceCount: number; sourceLocations: Array<{ path: string }> };
    expect(impact.referenceCount).toBeGreaterThan(2);
    expect(
      impact.sourceLocations.every(({ path: sourcePath }) => sourcePath.startsWith('mod:')),
    ).toBe(true);
  });

  it('maps direct and scripted-effect-projected grants and bonuses to their owning source', () => {
    const actual = new Set(graph.externalReferences.map(externalKey));
    for (const expected of referenceManifest.externalSources) {
      expect(actual, externalKey(expected)).toContain(externalKey(expected));
    }
    expect(
      graph.externalReferences.find(
        ({ sourceKind, sourceId, technologyId }) =>
          sourceKind === 'focus' &&
          sourceId === 'synthetic_focus' &&
          technologyId === 'synthetic_tech_0001',
      )?.location.path,
    ).toBe('mod:common/scripted_effects/synthetic_technology_effects.txt');
  });

  it('keeps a focused large-workspace graph bounded without losing direct evidence', async () => {
    const snapshot = await engine.scan(workspaceId);
    const workspace = engine.resolver.get(workspaceId);
    const first = buildTechnologyGraph(snapshot, {
      workspaceIdentity: workspace.workspaceIdentity,
      analysisMode: 'focused',
    });
    const second = buildTechnologyGraph(snapshot, {
      workspaceIdentity: workspace.workspaceIdentity,
      analysisMode: 'focused',
    });
    expect(first.analysisMode).toBe('focused');
    expect(first.complete).toBe(false);
    expect(first.unresolved).toContainEqual(
      expect.objectContaining({
        id: 'tech-unresolved-helper-expansion-deferred',
        blockers: [expect.objectContaining({ code: 'TECH_HELPER_EXPANSION_DEFERRED' })],
      }),
    );
    expect(first.externalReferences.length).toBeLessThan(graph.externalReferences.length);
    expect(first.externalReferences).toEqual(second.externalReferences);
    expect(first.revision).toBe(second.revision);
  });

  it('classifies every intentional defect and keeps unsupported dynamic analysis explicit', () => {
    const issueCodes = new Set(graph.issues.map(({ code }) => code));
    for (const code of graphManifest.intentionalIssueCodes)
      expect(issueCodes, code).toContain(code);
    const lint = lintTechnologyGraph(graph) as {
      issueCount: number;
      byClassification: Record<string, number>;
      issues: Array<{ code: string; location?: { path: string } }>;
    };
    expect(lint.issueCount).toBe(graph.issues.length);
    expect(lint.byClassification.confirmed_error).toBeGreaterThan(0);
    expect(lint.byClassification.probable_defect).toBeGreaterThan(0);
    expect(lint.byClassification.design_warning).toBeGreaterThan(0);
    expect(lint.byClassification.unresolved_analysis).toBeGreaterThan(0);
    expect(graph.unresolved).toContainEqual(
      expect.objectContaining({ expression: '[SyntheticDynamicTarget]', confidence: 'unresolved' }),
    );
    expect(
      lint.issues
        .filter(({ location }) => location !== undefined)
        .every(({ location }) => location!.path.startsWith('mod:')),
    ).toBe(true);
  });

  it('renders a bounded deterministic overview and complete focused resources for the full 1,000+ graph', async () => {
    const first = await viewer.renderAndStore({
      workspaceId,
      view: 'dependencies',
      maxNodes: 500,
      includeHtml: true,
    });
    const second = await viewer.renderAndStore({
      workspaceId,
      view: 'dependencies',
      maxNodes: 500,
      includeHtml: true,
    });
    expect(graph.technologies.length).toBeGreaterThan(1_000);
    expect(first.render.selectedIds).toHaveLength(500);
    expect(first.render.omittedNodeCount).toBe(graph.technologies.length - 500);
    expect(first.render.renderedIconCount).toBe(500);
    expect(first.render.unresolvedIconSprites).toEqual([]);
    expect(first.render.svg.match(/<image /gu)).toHaveLength(500);
    expect(first.render.hashes).toEqual(second.render.hashes);
    expect(first.render.generatedAnalysisLayout).toBe(true);
    expect(first.focused).toHaveLength(graph.folders.length);
    expect(first.focused.every(({ sourceAccurate }) => sourceAccurate)).toBe(true);
    const backgroundFolderIndex = graph.folders.findIndex(({ id }) => id === 'synthetic_folder_01');
    const backgroundReport = JSON.parse(first.focused[backgroundFolderIndex]!.json) as {
      backgrounds: Array<{ status: string }>;
    };
    expect(backgroundReport.backgrounds.map(({ status }) => status)).toEqual(['rendered']);
    expect(first.focused[backgroundFolderIndex]?.svg).toContain(
      'data-tech-background="synthetic_techtree_bg"',
    );
    const subTechnologyFolderIndex = graph.folders.findIndex(
      ({ id }) => id === 'synthetic_folder_00',
    );
    expect(first.focused[subTechnologyFolderIndex]?.svg).toContain(
      'data-subtechnology-id="synthetic_tech_0008" data-slot-index="0"',
    );
    expect(first.focused[subTechnologyFolderIndex]?.svg).toContain(
      'data-icon-sprite="GFX_synthetic_subtech_slot"',
    );
    expect(new Set(first.focused.flatMap(({ selectedIds }) => selectedIds)).size).toBe(
      graph.technologies.length - 2,
    );
    expect(first.render.svg).toContain('data-source-path=');
    expect(first.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['application/json', 'image/svg+xml', 'image/png', 'text/html']),
    );

    const folderRender = first.focused[backgroundFolderIndex]!;
    const focusedResult = await renderTechnologies(
      {
        renderAndStore: () =>
          Promise.resolve({
            ...first,
            graph: {
              ...first.graph,
              complete: false,
              analysisMode: 'focused',
              diagnostics: [
                {
                  code: 'TECH_UNRELATED_GRAPH_DIAGNOSTIC',
                  severity: 'error',
                  category: 'reference',
                  message: 'An unrelated technology outside the requested folder is invalid',
                },
              ],
              issues: [],
            },
            render: folderRender,
            focused: [],
          }),
      } as unknown as TechnologyTreeViewer,
      { workspaceId, view: 'folder', folderId: 'synthetic_folder_01' },
    );
    expect(focusedResult.code).toBe('TECH_RENDERED_PARTIAL');
    expect(focusedResult.validation).toMatchObject({
      passed: true,
      checks: [
        { id: 'technology-render', passed: true },
        { id: 'technology-analysis-boundary', passed: true },
      ],
    });

    const skippedSourceResult = await renderTechnologies(
      {
        renderAndStore: () =>
          Promise.resolve({
            ...first,
            graph: {
              ...first.graph,
              complete: false,
              analysisMode: 'focused',
              skippedSourceCount: 1,
              diagnostics: [],
              issues: [],
            },
            render: folderRender,
            focused: [],
          }),
      } as unknown as TechnologyTreeViewer,
      { workspaceId, view: 'folder', folderId: 'synthetic_folder_01' },
    );
    expect(skippedSourceResult.validation).toMatchObject({
      passed: false,
      checks: [
        { id: 'technology-render', passed: true },
        { id: 'technology-analysis-boundary', passed: false },
      ],
    });

    const workspaceRegistration = engine.resolver.get(workspaceId);
    const manifest = await engine.artifacts.read(workspaceRegistration, first.artifacts[0]!.uri);
    expect(JSON.parse(manifest.bytes.toString('utf8'))).toMatchObject({
      schemaVersion: 'technology-render-manifest.v1',
      graphRevision: graph.revision,
      focusedFolderCoverage: { rendered: graph.folders.length },
    });

    const scanned = await viewer.analyze({ workspaceId, mode: 'scan' });
    const compared = await viewer.compareAndStore({
      workspaceId,
      before: { artifactUri: scanned.artifacts[0]!.uri },
    });
    expect(compared.comparison.technologies.added).toEqual([]);
    expect(compared.comparison.technologies.removed).toEqual([]);
  }, 120_000);

  it('resolves and renders every selected technology icon from the read-only game root', async () => {
    const layeredRoot = path.join(temporaryRoot, 'layered-icons');
    const gameRoot = path.join(layeredRoot, 'game');
    const modRoot = path.join(layeredRoot, 'mod');
    const put = async (root: string, relativePath: string, content: string | Buffer) => {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    };
    const texturePath = 'gfx/interface/technologies/vanilla_shared.png';
    const wideTexturePath = 'gfx/interface/technologies/vanilla_wide.png';
    const designTeamTexturePath = 'gfx/interface/technologies/design_team.png';
    await put(
      gameRoot,
      'interface/vanilla_technology_icons.gfx',
      [
        'spriteTypes = {',
        `\tSpriteType = { name = GFX_layered_small_medium texturefile = "${texturePath}" }`,
        `\tSpriteType = { name = GFX_layered_large_medium texturefile = "${wideTexturePath}" }`,
        `\tSpriteType = { name = GFX_layered_techtree_bg texturefile = "${texturePath}" }`,
        `\tSpriteType = { name = GFX_design_team_icon texturefile = "${designTeamTexturePath}" }`,
        `\tcorneredTileSpriteType = { name = GFX_layered_panel texturefile = "${texturePath}" borderSize = { x = 16 y = 16 } tilingCenter = yes }`,
        ...['small', 'large'].flatMap((size) =>
          ['unavailable', 'available', 'researched'].map(
            (status) =>
              `\tSpriteType = { name = GFX_layered_${size}_${status}_item_bg texturefile = "${texturePath}" }`,
          ),
        ),
        '}',
        '',
      ].join('\n'),
    );
    await put(
      gameRoot,
      texturePath,
      await sharp({ create: { width: 64, height: 64, channels: 4, background: '#d89a43' } })
        .png()
        .toBuffer(),
    );
    await put(
      gameRoot,
      wideTexturePath,
      await sharp({ create: { width: 131, height: 52, channels: 4, background: '#a36827' } })
        .png()
        .toBuffer(),
    );
    await put(
      gameRoot,
      designTeamTexturePath,
      await sharp({ create: { width: 20, height: 20, channels: 4, background: '#8b62bc' } })
        .png()
        .toBuffer(),
    );
    await put(
      modRoot,
      'common/technologies/layered_technologies.txt',
      [
        'technologies = {',
        '\tlayered_small = {',
        '\t\tstart_year = 1936',
        '\t\tresearch_cost = 1',
        '\t\tforce_use_small_tech_layout = yes',
        '\t\tfolder = { name = layered_folder position = { x = 0 y = 0 } }',
        '\t\tpath = { leads_to_tech = layered_large }',
        '\t}',
        '\tlayered_large = {',
        '\t\tstart_year = 1936',
        '\t\tresearch_cost = 1',
        '\t\tfolder = { name = layered_folder position = { x = 1 y = 0 } }',
        '\t\tenable_equipments = { layered_equipment }',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    await put(
      modRoot,
      'interface/layered_technology_view.gui',
      [
        'guiTypes = {',
        '\tcontainerWindowType = {',
        '\t\tname = layered_folder',
        '\t\tbackground = { quadTextureSprite = GFX_layered_panel }',
        '\t\ticonType = { name = layered_techtree_bg spriteType = GFX_layered_techtree_bg position = { x = 0 y = 0 } }',
        '\t\tinstantTextBoxType = { name = layered_year_1936 position = { x = -110 y = 0 } text = "1936" }',
        '\t\tinstantTextBoxType = { name = layered_year_1940 position = { x = -110 y = 96 } text = "1940" }',
        '\t\tgridBoxType = {',
        '\t\t\tname = layered_small_tree',
        '\t\t\tposition = { x = 0 y = 0 }',
        '\t\t\tslotsize = { width = 90 height = 96 }',
        '\t\t\tformat = LEFT',
        '\t\t}',
        '\t}',
        '\tcontainerWindowType = { name = techtree_layered_folder_small_item position = { x = 0 y = 0 } size = { width = 72 height = 72 } background = { quadTextureSprite = GFX_layered_small_unavailable_item_bg } iconType = { name = Icon position = { x = 36 y = 36 } centerposition = yes } iconType = { name = can_assign_design_team_icon position = { x = 0 y = 42 } spriteType = GFX_design_team_icon } }',
        '\tcontainerWindowType = { name = techtree_layered_folder_item position = { x = -56 y = -7 } size = { width = 183 height = 84 } background = { quadTextureSprite = GFX_layered_large_unavailable_item_bg } iconType = { name = Icon position = { x = 91 y = 46 } centerposition = yes } instantTextBoxType = { name = name position = { x = 3 y = -3 } maxWidth = 160 } }',
        '}',
        '',
      ].join('\n'),
    );
    await put(
      modRoot,
      'localisation/english/layered_l_english.yml',
      '\ufeffl_english:\nlayered_small: "Layered Small"\nlayered_small_desc: "Small icon."\nlayered_large: "Layered Large"\nlayered_large_desc: "Large icon."\n',
    );
    const layeredConfiguration = serverConfigurationSchema.parse({
      version: 1,
      gameRoot,
      serverStateRoot: path.join(layeredRoot, 'server-state'),
      workspaceStorageRoot: path.join(layeredRoot, 'storage'),
      workspaces: [{ id: 'layered-icons', name: 'Layered icons', root: modRoot, kind: 'mod' }],
    });
    const layeredEngine = new CoreEngine(await WorkspaceResolver.create(layeredConfiguration));
    await layeredEngine.initialize();
    const layeredViewer = new TechnologyTreeViewer(layeredEngine);
    const layeredGraph = await layeredViewer.scan('layered-icons', { refresh: true });
    expect(layeredGraph.itemLayouts).toHaveLength(2);
    expect(layeredGraph.itemLayouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layoutSize: 'small',
          backgroundSprite: 'GFX_layered_small_unavailable_item_bg',
          iconPosition: { x: 36, y: 36, centered: true },
        }),
        expect.objectContaining({
          layoutSize: 'large',
          backgroundSprite: 'GFX_layered_large_unavailable_item_bg',
          namePosition: { x: 3, y: -3, maxWidth: 160 },
        }),
      ]),
    );
    expect(layeredGraph.yearMarkers.map(({ year }) => year)).toEqual([1936, 1940]);
    expect(
      layeredGraph.placements.map(({ technologyId, layoutSize, layoutWidth, layoutHeight }) => ({
        technologyId,
        layoutSize,
        layoutWidth,
        layoutHeight,
      })),
    ).toEqual(
      expect.arrayContaining([
        { technologyId: 'layered_large', layoutSize: 'large', layoutWidth: 183, layoutHeight: 84 },
        { technologyId: 'layered_small', layoutSize: 'small', layoutWidth: 72, layoutHeight: 72 },
      ]),
    );
    expect(layeredGraph.itemLayouts.find(({ layoutSize }) => layoutSize === 'small')).toMatchObject(
      {
        designTeamIcon: { sprite: 'GFX_design_team_icon', x: 0, y: 42 },
      },
    );
    expect(
      layeredGraph.technologies.map(({ icon }) => ({
        sprite: icon.sprite,
        status: icon.status,
        spritePath: icon.spritePath,
        texturePath: icon.texturePath,
      })),
    ).toEqual([
      {
        sprite: 'GFX_layered_large_medium',
        status: 'resolved',
        spritePath: 'game:interface/vanilla_technology_icons.gfx',
        texturePath: wideTexturePath,
      },
      {
        sprite: 'GFX_layered_small_medium',
        status: 'resolved',
        spritePath: 'game:interface/vanilla_technology_icons.gfx',
        texturePath,
      },
    ]);
    const rendered = await layeredViewer.renderAndStore({
      workspaceId: 'layered-icons',
      view: 'folder',
      folderId: 'layered_folder',
    });
    expect(rendered.render.unresolvedIconSprites).toEqual([]);
    expect(rendered.render.renderedIconCount).toBe(11);
    expect(rendered.render.svg.match(/<image /gu)).toHaveLength(7);
    expect(rendered.render.svg).toMatch(
      /data-design-team-icon="GFX_design_team_icon"[^>]+width="20" height="20"/u,
    );
    expect(rendered.render.svg).toContain('pattern id="tech-folder-panel"');
    expect(rendered.render.svg).toContain('data-tech-background="layered_techtree_bg"');
    expect(rendered.render.svg).toContain(
      'data-item-background-sprite="GFX_layered_small_unavailable_item_bg"',
    );
    expect(rendered.render.svg).toContain(
      'data-icon-sprite="GFX_layered_small_medium" data-source-path="mod:common/technologies/layered_technologies.txt"',
    );
    expect(rendered.render.svg).toMatch(
      /data-tech-icon-sprite="GFX_layered_small_medium"[^>]+width="62" height="62"/u,
    );
    expect(rendered.render.svg).toMatch(
      /data-tech-icon-sprite="GFX_layered_large_medium"[^>]+width="131" height="52"/u,
    );
    expect(rendered.render.svg).toContain('href="data:image/png;base64,');
    expect(rendered.render.svg).toContain('data-tech-year="1936"');
    expect(rendered.render.svg).toContain('data-tech-year="1940"');
    expect(rendered.render.svg).toContain('data-year-axis="vertical"');
    expect(rendered.render.svg).toContain('data-layout-size="small"');
    expect(rendered.render.svg).toContain('width="72" height="72"');
    expect(rendered.render.svg).toContain('data-layout-size="large"');
    expect(rendered.render.svg).toContain('width="183" height="84"');
    expect(rendered.render.json).not.toContain('data:image/png;base64,');
    const unavailableAssets = await renderTechnologyGraph(layeredGraph, {
      view: 'folder',
      folderId: 'layered_folder',
    });
    expect(unavailableAssets.unresolvedIconSprites).toContain('GFX_layered_techtree_bg');
    expect(unavailableAssets.svg).not.toContain('data-tech-background="layered_techtree_bg"');
    expect(
      (JSON.parse(unavailableAssets.json) as { backgrounds: Array<{ status: string }> })
        .backgrounds[0]?.status,
    ).toBe('unresolved');
    const scenario = await renderTechnologyGraph(layeredGraph, {
      view: 'folder',
      folderId: 'layered_folder',
      scenario: { year: 1935, researchedTechnologyIds: [] },
    });
    const scenarioNodes = (
      JSON.parse(scenario.json) as {
        nodes: Array<{
          id: string;
          scenarioStatus: string;
          missingPrerequisiteIds: string[];
          aheadOfTimeYears: number;
        }>;
      }
    ).nodes;
    expect(scenarioNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'layered_small', scenarioStatus: 'structural_candidate' }),
        expect.objectContaining({
          id: 'layered_large',
          scenarioStatus: 'missing_prerequisite',
          missingPrerequisiteIds: ['layered_small'],
          aheadOfTimeYears: 1,
        }),
      ]),
    );
    expect(scenario.svg).toContain('data-scenario-status="missing_prerequisite"');
    const afterResearch = await renderTechnologyGraph(layeredGraph, {
      view: 'folder',
      folderId: 'layered_folder',
      scenario: { year: 1936, researchedTechnologyIds: ['layered_small'] },
    });
    expect(afterResearch.json).toContain('"scenarioStatus":"researched"');
    expect(afterResearch.json).toContain('"scenarioStatus":"structural_candidate"');
    await expect(
      renderTechnologyGraph(layeredGraph, {
        view: 'folder',
        folderId: 'layered_folder',
        scenario: { year: 1936, researchedTechnologyIds: ['unknown_technology'] },
      }),
    ).rejects.toThrow('unknown researched technology');
  });

  it('projects an oversized scan report without serializing the full graph', () => {
    const projected = technologyScanReport(graph, 1) as {
      graph?: unknown;
      authoritativeGraphIncluded: boolean;
      graphSummary: { revision: string; recordCounts: { externalReferences: number } };
      artifactProjection: { mode: string; fullGraphRecordCount: number };
    };
    expect(projected.graph).toBeUndefined();
    expect(projected.authoritativeGraphIncluded).toBe(false);
    expect(projected.graphSummary).toMatchObject({
      revision: graph.revision,
      recordCounts: { externalReferences: graph.externalReferences.length },
    });
    expect(projected.artifactProjection).toMatchObject({
      mode: 'large-scan-summary',
      fullGraphRecordCount: expect.any(Number),
    });
  });

  it('renders every required agent view with authoritative JSON and source links', async () => {
    const requests = [
      { view: 'summary' as const },
      { view: 'folder' as const, folderId: 'synthetic_folder_01' },
      { view: 'dependencies' as const },
      { view: 'technology' as const, technologyId: 'synthetic_tech_0003' },
      { view: 'doctrine' as const },
      { view: 'exclusive' as const },
      { view: 'memberships' as const, categoryId: 'synthetic_category_04' },
      { view: 'bonuses' as const, categoryId: 'synthetic_category_04' },
      { view: 'grants' as const, technologyId: 'synthetic_tech_0004' },
      { view: 'unlocks' as const, technologyId: 'synthetic_tech_0003' },
      { view: 'metadata' as const },
      { view: 'assets' as const },
      { view: 'unresolved' as const },
    ];
    for (const request of requests) {
      const rendered = await renderTechnologyGraph(graph, { ...request, maxNodes: 60 });
      const authoritative = JSON.parse(rendered.json) as {
        view: string;
        graphRevision: string;
        nodes: unknown[];
      };
      expect(authoritative.view, request.view).toBe(request.view);
      expect(authoritative.graphRevision, request.view).toBe(graph.revision);
      expect(authoritative.nodes.length, request.view).toBeGreaterThan(0);
      expect(rendered.svg, request.view).toContain('data-source-path=');
      expect(rendered.png.length, request.view).toBeGreaterThan(100);
      expect(rendered.sourceAccurate, request.view).toBe(request.view === 'folder');
      if (request.view === 'folder') {
        expect(rendered.svg).toContain('data-layout-size="small"');
        expect(rendered.svg).toContain('width="64" height="64"');
        expect(rendered.svg).toContain('data-layout-size="large"');
        expect(rendered.svg).toContain('width="176" height="82"');
        expect(rendered.svg).toContain('data-tech-year="1936"');
        expect(rendered.svg).toContain('data-tech-year="1940"');
        expect(rendered.svg).toContain('data-year-axis="horizontal"');
        expect(authoritative.nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'synthetic_tech_0000', layoutSize: 'small' }),
            expect.objectContaining({ id: 'synthetic_tech_0001', layoutSize: 'large' }),
          ]),
        );
      }
    }
  }, 120_000);

  it('uses a declared gridbox for a technology with two prerequisite roots', async () => {
    const isolatedRoot = path.join(temporaryRoot, 'multiple-roots');
    const modRoot = path.join(isolatedRoot, 'mod');
    const technologyPath = path.join(modRoot, 'common/technologies/multiple_roots.txt');
    const guiPath = path.join(modRoot, 'interface/multiple_roots.gui');
    await mkdir(path.dirname(technologyPath), { recursive: true });
    await mkdir(path.dirname(guiPath), { recursive: true });
    await writeFile(
      technologyPath,
      [
        'technologies = {',
        '\talpha = { folder = { name = multiple_roots_folder position = { x = 0 y = 0 } } }',
        '\tbeta = { folder = { name = multiple_roots_folder position = { x = 1 y = 0 } } }',
        '\tmerged = { dependencies = { alpha = 1 beta = 1 } folder = { name = multiple_roots_folder position = { x = 2 y = 0 } } }',
        '}',
      ].join('\n'),
    );
    const gui = (includeOwnGridbox: boolean) =>
      [
        'guiTypes = {',
        '\tcontainerWindowType = {',
        '\t\tname = multiple_roots_folder',
        '\t\tgridBoxType = { name = alpha_tree position = { x = 0 y = 0 } slotsize = { width = 70 height = 70 } }',
        '\t\tgridBoxType = { name = beta_tree position = { x = 70 y = 0 } slotsize = { width = 70 height = 70 } }',
        ...(includeOwnGridbox
          ? [
              '\t\tgridBoxType = { name = merged_tree position = { x = 140 y = 0 } slotsize = { width = 70 height = 70 } }',
            ]
          : []),
        '\t}',
        '\tcontainerWindowType = { name = techtree_multiple_roots_folder_small_item position = { x = 0 y = 0 } size = { width = 72 height = 72 } }',
        '}',
      ].join('\n');
    await writeFile(guiPath, gui(false));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(isolatedRoot, 'server-state'),
      workspaceStorageRoot: path.join(isolatedRoot, 'storage'),
      workspaces: [{ id: 'multiple_roots', name: 'Multiple roots', root: modRoot, kind: 'mod' }],
    });
    const isolatedEngine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await isolatedEngine.initialize();
    const isolatedViewer = new TechnologyTreeViewer(isolatedEngine);
    const before = await isolatedViewer.scan('multiple_roots', { refresh: true });
    expect(before.placements.find(({ technologyId }) => technologyId === 'merged')).toMatchObject({
      geometryStatus: 'source_coordinate',
    });
    await writeFile(guiPath, gui(true));
    const after = await isolatedViewer.scan('multiple_roots', { refresh: true });
    expect(after.placements.find(({ technologyId }) => technologyId === 'merged')).toMatchObject({
      geometryStatus: 'source_pixel',
      pixelX: 280,
      pixelY: 0,
    });
  });

  it('resolves file-level technology constants and reports incomplete folder geometry', async () => {
    const technology = graph.technologies.find(({ id }) => id === 'synthetic_tech_0000');
    expect(technology).toMatchObject({ startYear: '1936', researchCost: '1' });
    const placement = graph.placements.find(
      ({ technologyId, folderId }) =>
        technologyId === 'synthetic_tech_0000' && folderId === 'synthetic_folder_00',
    );
    expect(placement).toMatchObject({ x: 0, y: 0, geometryStatus: 'source_pixel' });

    const unresolvedPlacement = { ...placement!, geometryStatus: 'unresolved' as const };
    delete unresolvedPlacement.pixelX;
    delete unresolvedPlacement.pixelY;
    delete unresolvedPlacement.x;
    delete unresolvedPlacement.y;
    const incompleteGraph = {
      ...graph,
      placements: graph.placements.map((candidate) =>
        candidate.id === placement!.id ? unresolvedPlacement : candidate,
      ),
    };
    const rendered = await renderTechnologyGraph(incompleteGraph, {
      view: 'folder',
      folderId: 'synthetic_folder_00',
    });
    expect(rendered.sourceAccurate).toBe(false);
    expect(JSON.parse(rendered.json)).toMatchObject({
      sourceAccurate: false,
      generatedAnalysisLayout: true,
    });
  });

  it('compares a proposed rename without writing source and separates regressions', async () => {
    const relativePath = 'common/technologies/synthetic_technologies_01.txt';
    const original = await readFile(path.join(workspaceRoot, relativePath), 'utf8');
    const proposed = original.replace('synthetic_tech_0008 = {', 'synthetic_tech_renamed = {');
    const compared = await viewer.compareAndStore({
      workspaceId,
      proposedSources: [{ relativePath, source: proposed }],
      render: true,
    });
    expect(compared.comparison.technologies.removed).toContain('synthetic_tech_0008');
    expect(compared.comparison.technologies.added).toContain('synthetic_tech_renamed');
    expect(compared.comparison.technologies.renamed).toContainEqual(
      expect.objectContaining({
        beforeId: 'synthetic_tech_0008',
        afterId: 'synthetic_tech_renamed',
      }),
    );
    expect(compared.comparison.regressions.map(({ code }) => code)).toContain(
      'TECH_TARGET_MISSING',
    );
    expect(compared.render?.view).toBe('comparison');
    expect(compared.render?.png.length).toBeGreaterThan(100);
    expect(await readFile(path.join(workspaceRoot, relativePath), 'utf8')).toBe(original);
  }, 60_000);

  it('supports cancellation and incremental re-indexing without stale derived graphs', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      viewer.scan(workspaceId, { refresh: true, signal: controller.signal }),
    ).rejects.toThrow();

    const relativePath = 'common/technologies/synthetic_technologies_04.txt';
    const absolutePath = path.join(workspaceRoot, relativePath);
    const original = await readFile(absolutePath, 'utf8');
    const changed = original.replace('research_cost = 1.00', 'research_cost = 1.10');
    await writeFile(absolutePath, changed);
    try {
      const updated = await viewer.scan(workspaceId);
      expect(updated.revision).not.toBe(graph.revision);
      expect(
        updated.technologies.find(({ id }) => id === 'synthetic_tech_0392')?.researchCost,
      ).toBe('1.10');
      expect(await viewer.scan(workspaceId)).toBe(updated);
    } finally {
      await writeFile(absolutePath, original);
    }
    expect((await viewer.scan(workspaceId)).revision).toBe(graph.revision);
  });

  it('compares graph snapshots directly with stable semantic identities', () => {
    const same = compareTechnologyGraphs(graph, graph);
    expect(same.technologies.added).toEqual([]);
    expect(same.technologies.removed).toEqual([]);
    expect(same.edges.added).toEqual([]);
    expect(same.regressions).toEqual([]);
  });
});

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
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
  traceTechnology,
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
    expect(graph.technologies).toHaveLength(graphManifest.counts.totalTechnologyDefinitions);
    expect(graph.statistics.technologyCount).toBe(graphManifest.counts.technologies);
    expect(graph.statistics.legacyDoctrineCount).toBe(graphManifest.counts.legacyDoctrines);
    expect(graph.technologies.map(({ id }) => id)).toEqual(graphManifest.technologyIds);
    expect(graph.folders.map(({ id }) => id)).toEqual(graphManifest.folderIds);
    expect(graph.placements).toHaveLength(graphManifest.counts.placements);
    expect(graph.gridboxes).toHaveLength(graphManifest.counts.gridboxes);
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
    expect(first.render.hashes).toEqual(second.render.hashes);
    expect(first.render.generatedAnalysisLayout).toBe(true);
    expect(first.focused).toHaveLength(graph.folders.length);
    expect(first.focused.every(({ sourceAccurate }) => sourceAccurate)).toBe(true);
    expect(new Set(first.focused.flatMap(({ selectedIds }) => selectedIds)).size).toBe(
      graph.technologies.length - 2,
    );
    expect(first.render.svg).toContain('data-source-path=');
    expect(first.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['application/json', 'image/svg+xml', 'image/png', 'text/html']),
    );
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
    }
  }, 120_000);

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
    engine.invalidate(workspaceId);
    const updated = await viewer.scan(workspaceId, { refresh: true });
    expect(updated.revision).not.toBe(graph.revision);
    expect(updated.technologies.find(({ id }) => id === 'synthetic_tech_0392')?.researchCost).toBe(
      '1.10',
    );
    await writeFile(absolutePath, original);
  });

  it('compares graph snapshots directly with stable semantic identities', () => {
    const same = compareTechnologyGraphs(graph, graph);
    expect(same.technologies.added).toEqual([]);
    expect(same.technologies.removed).toEqual([]);
    expect(same.edges.added).toEqual([]);
    expect(same.regressions).toEqual([]);
  });
});

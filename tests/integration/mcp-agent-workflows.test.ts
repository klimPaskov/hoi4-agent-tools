import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

interface OperationResult {
  status: 'ok' | 'blocked' | 'error';
  code: string;
  changedFiles: string[];
  artifacts: Array<{ uri: string; name: string; mimeType: string }>;
  validation: {
    passed: boolean;
    checks: Array<{ id: string; passed: boolean; message: string }>;
  };
  data: Record<string, unknown>;
}

const cleanup: Array<() => Promise<void>> = [];
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

function resultOf(value: Awaited<ReturnType<Client['callTool']>>): OperationResult {
  return value.structuredContent as unknown as OperationResult;
}

async function connect(temporary: string, workspace: Record<string, unknown>): Promise<Client> {
  const artifactRoot = path.join(temporary, 'runtime', 'artifacts');
  const cacheRoot = path.join(temporary, 'runtime', 'cache');
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'server-state'),
    storageRoots: [artifactRoot, cacheRoot],
    workspaces: [
      {
        ...workspace,
        artifactRoot,
        cacheRoot,
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'agent-workflow-acceptance', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
    async () => rm(temporary, { recursive: true, force: true }),
  );
  return client;
}

async function readJsonArtifact(client: Client, uri: string): Promise<Record<string, unknown>> {
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content))
    throw new Error('Expected a JSON text resource');
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function readBinaryArtifact(client: Client, uri: string): Promise<Buffer> {
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content === undefined || !('blob' in content)) throw new Error('Expected a binary resource');
  return Buffer.from(content.blob, 'base64');
}

function jsonArtifact(result: OperationResult): { uri: string; name: string; mimeType: string } {
  const artifact = result.artifacts.find(({ mimeType }) => mimeType === 'application/json');
  if (artifact === undefined) throw new Error(`Expected a JSON artifact from ${result.code}`);
  return artifact;
}

describe('MCP coding-agent workflows', () => {
  it('inspects, renders, cleans up, and creates focus trees through the composite tools', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-focus-workflow-'));
    const mod = path.join(temporary, 'mod');
    const relativePath = 'common/national_focus/workflow.txt';
    const sourcePath = path.join(mod, ...relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      [
        'focus_tree = {',
        '\tid = workflow_tree',
        '\tdefault = yes',
        '\tfocus = {',
        '\t\tid = workflow_root',
        '\t\tx = 0',
        '\t\ty = 0',
        '\t\tcost = 5',
        '\t\tcompletion_reward = { add_political_power = 10 }',
        '\t}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const client = await connect(temporary, {
      id: 'focus',
      name: 'Synthetic focus workflow',
      root: mod,
    });

    const inspected = resultOf(
      await client.callTool({
        name: 'hoi4.focus_inspect',
        arguments: { workspaceId: 'focus', relativePath, treeId: 'workflow_tree' },
      }),
    );
    expect(inspected).toMatchObject({
      status: 'ok',
      code: 'FOCUS_INSPECTED',
      data: { mode: 'national', treeCount: 1 },
    });
    const inspection = await readJsonArtifact(client, jsonArtifact(inspected).uri);
    const plan = (inspection.plans as Array<Record<string, unknown>>)[0]!;
    expect(plan).toMatchObject({ id: 'workflow_tree' });
    expect(inspection.layouts).toEqual([
      expect.objectContaining({ treeId: 'workflow_tree', layout: expect.any(Object) }),
    ]);

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.focus_render',
        arguments: { workspaceId: 'focus', relativePath, treeId: 'workflow_tree' },
      }),
    );
    expect(rendered).toMatchObject({
      status: 'ok',
      code: 'FOCUS_RENDERED',
      data: { mode: 'national', treeId: 'workflow_tree' },
    });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['text/html', 'image/svg+xml', 'application/json']),
    );
    expect(rendered.artifacts.some(({ mimeType }) => mimeType === 'image/png')).toBe(false);
    const rasterized = resultOf(
      await client.callTool({
        name: 'hoi4.focus_raster',
        arguments: { workspaceId: 'focus', relativePath, treeId: 'workflow_tree' },
      }),
    );
    expect(rasterized).toMatchObject({
      status: 'ok',
      code: 'FOCUS_RASTERIZED',
      data: { mode: 'national', treeId: 'workflow_tree' },
    });
    const focusPng = rasterized.artifacts.find(({ mimeType }) => mimeType === 'image/png')!;
    expect((await readBinaryArtifact(client, focusPng.uri)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const focuses = plan.focuses as Array<Record<string, unknown>>;
    focuses[0]!.cost = 7;
    const rewritten = resultOf(
      await client.callTool({
        name: 'hoi4.focus_rewrite',
        arguments: { workspaceId: 'focus', relativePath, plan },
      }),
    );
    expect(rewritten).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_APPLIED',
      data: { execution: 'applied', created: false },
    });
    expect(rewritten.changedFiles).toEqual(
      expect.arrayContaining([relativePath, 'common/national_focus/workflow.focus-plan.json']),
    );
    expect(await readFile(sourcePath, 'utf8')).toContain('\t\tcost = 7');

    const createdPlan = JSON.parse(
      JSON.stringify(plan)
        .replaceAll('workflow_tree', 'created_workflow_tree')
        .replaceAll('workflow_root', 'created_workflow_root'),
    ) as Record<string, unknown>;
    createdPlan.provenance = {
      sourcePath: 'plan:created_workflow_tree',
      sourceHash: '0'.repeat(64),
      importedPlanHash: '0'.repeat(64),
    };
    const createdRelativePath = 'common/national_focus/created-workflow.txt';
    const created = resultOf(
      await client.callTool({
        name: 'hoi4.focus_rewrite',
        arguments: {
          workspaceId: 'focus',
          relativePath: createdRelativePath,
          plan: createdPlan,
          createIfMissing: true,
        },
      }),
    );
    expect(created).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_APPLIED',
      data: { execution: 'applied', created: true, treeId: 'created_workflow_tree' },
    });
    expect(await readFile(path.join(mod, ...createdRelativePath.split('/')), 'utf8')).toContain(
      '\tid = created_workflow_tree',
    );
  }, 60_000);

  it('inspects, renders, cleans up, and creates scripted GUIs through the composite tools', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-gui-workflow-'));
    const mod = path.join(temporary, 'mod');
    await cp(path.join(repositoryRoot, 'fixtures', 'gui', 'workspace'), mod, { recursive: true });
    const scenario = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'fixtures', 'gui', 'scenarios', 'baseline.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const comparisonScenario = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'fixtures', 'gui', 'scenarios', 'comparison.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const client = await connect(temporary, {
      id: 'gui',
      name: 'Synthetic GUI workflow',
      root: mod,
    });

    const inspected = resultOf(
      await client.callTool({
        name: 'hoi4.gui_inspect',
        arguments: {
          workspaceId: 'gui',
          windowName: 'synthetic_gui_window',
          scenario,
          relatedScenarios: [comparisonScenario],
        },
      }),
    );
    expect(inspected).toMatchObject({
      status: 'ok',
      code: 'GUI_INSPECTED',
      data: {
        complete: true,
        windowName: 'synthetic_gui_window',
        scenarioId: 'synthetic-acceptance',
      },
    });
    const inspection = await readJsonArtifact(client, jsonArtifact(inspected).uri);
    expect(inspection).toMatchObject({
      offline: true,
      scenario: expect.objectContaining({ id: 'synthetic-acceptance' }),
      fidelity: expect.any(Object),
    });

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.gui_render',
        arguments: {
          workspaceId: 'gui',
          windowName: 'synthetic_gui_window',
          scenario,
          states: ['normal', 'hover', 'selected'],
          resolutions: [{ width: 960, height: 540 }],
          comparisonScenario,
        },
      }),
    );
    expect(rendered).toMatchObject({
      status: 'ok',
      code: 'GUI_RENDERED',
      data: {
        windowName: 'synthetic_gui_window',
        stateCount: 3,
        resolutionCount: 1,
        offlineRepresentation: true,
      },
    });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['image/svg+xml', 'image/png', 'application/json']),
    );

    const cleanTemporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-gui-write-'));
    const cleanMod = path.join(cleanTemporary, 'mod');
    const cleanRelativePath = 'interface/clean.gui';
    const cleanSourcePath = path.join(cleanMod, ...cleanRelativePath.split('/'));
    const cleanSource = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "clean_window"',
      '\t\tposition = { x = 10 y = 20 }',
      '\t\tsize = { width = 320 height = 200 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    await mkdir(path.dirname(cleanSourcePath), { recursive: true });
    await writeFile(cleanSourcePath, cleanSource, 'utf8');
    const cleanClient = await connect(cleanTemporary, {
      id: 'gui-clean',
      name: 'Synthetic clean GUI workflow',
      root: cleanMod,
    });
    const cleanScenario = { id: 'clean', resolution: { width: 640, height: 360 } };
    const expectedText = 'x = 10';
    const start = cleanSource.indexOf(expectedText);
    expect(start).toBeGreaterThanOrEqual(0);
    const rewritten = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'patches',
          workspaceId: 'gui-clean',
          relativePath: cleanRelativePath,
          windowName: 'clean_window',
          scenario: cleanScenario,
          expectedSourceHash: sha256Bytes(Buffer.from(cleanSource, 'utf8')),
          patches: [
            {
              start,
              end: start + expectedText.length,
              expectedText,
              text: 'x = 40',
              description: 'Align the main window on the layout grid',
            },
          ],
        },
      }),
    );
    expect(rewritten).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { mode: 'patches', execution: 'applied' },
    });
    expect(await readFile(cleanSourcePath, 'utf8')).toContain('position = { x = 40 y = 20 }');

    const cleanedSource = cleanSource.replace('x = 10', 'x = 48');
    const wholeFileCleanup = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'source',
          workspaceId: 'gui-clean',
          relativePath: cleanRelativePath,
          windowName: 'clean_window',
          scenario: cleanScenario,
          source: cleanedSource,
        },
      }),
    );
    expect(wholeFileCleanup).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { mode: 'source', execution: 'applied' },
    });
    expect(await readFile(cleanSourcePath, 'utf8')).toContain('position = { x = 48 y = 20 }');

    const helperRelativePath = 'interface/helper_created.gui';
    const helper = (width: number) => ({
      version: 1,
      root: {
        id: 'helper_window',
        kind: 'column',
        name: 'helper_window',
        width,
        height: 200,
        children: [],
      },
    });
    const helperCreated = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'helpers',
          workspaceId: 'gui-clean',
          relativePath: helperRelativePath,
          windowName: 'helper_window',
          scenario: { id: 'helper-created', resolution: { width: 640, height: 360 } },
          helper: helper(320),
        },
      }),
    );
    expect(helperCreated).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { mode: 'helpers', execution: 'applied', nodeCount: 1 },
    });
    const helperCleaned = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'helpers',
          workspaceId: 'gui-clean',
          relativePath: helperRelativePath,
          windowName: 'helper_window',
          scenario: { id: 'helper-cleaned', resolution: { width: 640, height: 360 } },
          helper: helper(360),
        },
      }),
    );
    expect(helperCleaned).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { mode: 'helpers', execution: 'applied', nodeCount: 1 },
    });
    expect(await readFile(path.join(cleanMod, ...helperRelativePath.split('/')), 'utf8')).toContain(
      'width = 360',
    );

    const packageRelativePath = 'interface/package_window.gui';
    const packageSource = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "package_window"',
      '\t\tposition = { x = 20 y = 20 }',
      '\t\tsize = { width = 320 height = 200 }',
      '\t\ttext = "PACKAGE_WINDOW_TITLE"',
      '\t}',
      '}',
      '',
    ].join('\n');
    const packageFiles = [
      {
        relativePath: 'interface/package_companion.gui',
        source:
          'guiTypes = { containerWindowType = { name = "package_companion" size = { width = 20 height = 20 } } }\n',
      },
      {
        relativePath: 'interface/package_window.gfx',
        source: 'spriteTypes = { spriteType = { name = "GFX_package_marker" } }\n',
      },
      {
        relativePath: 'common/scripted_guis/package_window.txt',
        source: [
          'scripted_gui = {',
          '\tpackage_window_controller = {',
          '\t\tcontext_type = country',
          '\t\twindow_name = package_window',
          '\t\tvisible = { always = yes }',
          '\t\tai_enabled = { always = yes }',
          '\t}',
          '}',
          '',
        ].join('\n'),
      },
      {
        relativePath: 'localisation/english/package_window_l_english.yml',
        source: 'l_english:\nPACKAGE_WINDOW_TITLE: "Package Window"\n',
      },
    ];
    const packageCreated = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'source',
          workspaceId: 'gui-clean',
          relativePath: packageRelativePath,
          windowName: 'package_window',
          scenario: { id: 'package-created', resolution: { width: 640, height: 360 } },
          source: packageSource,
          additionalFiles: packageFiles,
        },
      }),
    );
    expect(packageCreated, JSON.stringify(packageCreated, null, 2)).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { mode: 'source', execution: 'applied', fileCount: 5 },
    });
    expect(packageCreated.changedFiles).toEqual([
      'common/scripted_guis/package_window.txt',
      'interface/package_companion.gui',
      'interface/package_window.gfx',
      'interface/package_window.gui',
      'localisation/english/package_window_l_english.yml',
    ]);
    const localisationBytes = await readFile(
      path.join(cleanMod, 'localisation', 'english', 'package_window_l_english.yml'),
    );
    expect(localisationBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const packageScenario = {
      id: 'package-inspection',
      resolution: { width: 640, height: 360 },
    };
    const packageInspected = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_inspect',
        arguments: {
          workspaceId: 'gui-clean',
          windowName: 'package_window',
          scenario: packageScenario,
        },
      }),
    );
    expect(packageInspected).toMatchObject({ status: 'ok', code: 'GUI_INSPECTED' });
    const packageInspection = (await readJsonArtifact(
      cleanClient,
      jsonArtifact(packageInspected).uri,
    )) as {
      graph: {
        nodes: Array<{ path: string }>;
        edges: Array<{ kind: string; resolved: boolean }>;
      };
    };
    expect(packageInspection.graph.nodes.map(({ path: sourcePath }) => sourcePath)).toEqual(
      expect.arrayContaining(packageFiles.map(({ relativePath: file }) => `mod:${file}`)),
    );
    expect(packageInspection.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'window', resolved: true }),
        expect.objectContaining({ kind: 'uses_localisation', resolved: true }),
      ]),
    );
    const packageRendered = resultOf(
      await cleanClient.callTool({
        name: 'hoi4.gui_render',
        arguments: {
          workspaceId: 'gui-clean',
          windowName: 'package_window',
          scenario: packageScenario,
          states: ['normal'],
          resolutions: [{ width: 640, height: 360 }],
        },
      }),
    );
    expect(packageRendered).toMatchObject({ status: 'ok', code: 'GUI_RENDERED' });
  }, 120_000);

  it('inspects, renders, and applies a province-geometry split through the composite map tools', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-map-workflow-'));
    const fixtureRoots = path.join(repositoryRoot, 'fixtures', 'map', 'roots');
    const game = path.join(temporary, 'game');
    const dependency = path.join(temporary, 'dependency');
    const mod = path.join(temporary, 'mod');
    await Promise.all([
      cp(path.join(fixtureRoots, 'game'), game, { recursive: true }),
      cp(path.join(fixtureRoots, 'dependency'), dependency, { recursive: true }),
      cp(path.join(fixtureRoots, 'mod'), mod, { recursive: true }),
    ]);
    const client = await connect(temporary, {
      id: 'map',
      name: 'Synthetic map workflow',
      root: mod,
      gameRoot: game,
      dependencyRoots: [dependency],
    });

    const inspected = resultOf(
      await client.callTool({
        name: 'hoi4.map_inspect',
        arguments: {
          workspaceId: 'map',
          provinceIds: [1, 4, 999],
          stateIds: [1, 5, 999],
          regionIds: [1, 2, 999],
          allocationRequests: [
            { kind: 'state' },
            {
              kind: 'province',
              requestedId: 5,
              requestedColor: { r: 123, g: 45, b: 67 },
            },
          ],
        },
      }),
    );
    expect(inspected).toMatchObject({
      status: 'ok',
      code: 'MAP_INSPECTED',
      data: {
        inspectedProvinceCount: 3,
        inspectedStateCount: 3,
        inspectedRegionCount: 3,
        allocationCount: 2,
      },
    });
    const inspection = await readJsonArtifact(client, jsonArtifact(inspected).uri);
    expect(inspection).toMatchObject({
      selected: {
        provinces: expect.any(Array),
        states: expect.any(Array),
        regions: expect.any(Array),
      },
      allocationPreviews: [expect.any(Object), expect.any(Object)],
      validation: expect.any(Object),
    });

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.map_render',
        arguments: { workspaceId: 'map', layer: 'province', overlays: ['coastlines'] },
      }),
    );
    expect(rendered).toMatchObject({ status: 'ok', code: 'MAP_RENDERED' });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['image/png', 'application/json', 'text/html']),
    );

    const pixels = Array.from({ length: 128 }, (_, y) =>
      Array.from({ length: 16 }, (_unused, x) => ({ x: x + 80, y: y + 64 })),
    ).flat();
    const rewritten = resultOf(
      await client.callTool({
        name: 'hoi4.map_rewrite',
        arguments: {
          workspaceId: 'map',
          operations: [
            {
              id: 'workflow-split-province',
              kind: 'split_province',
              sourceProvinceId: 4,
              geometry: { kind: 'pixels', pixels },
              definition: { method: 'inherit-source' },
              distribution: {
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
              },
            },
          ],
        },
      }),
    );
    expect(rewritten).toMatchObject({
      status: 'ok',
      code: 'MAP_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    expect(rewritten.changedFiles).toEqual(
      expect.arrayContaining([
        'history/states/1-GAME.txt',
        'map/definition.csv',
        'map/provinces.bmp',
        'map/strategicregions/1-REGION.txt',
      ]),
    );
    expect(rewritten.data.changedProvinceCount).toBeGreaterThan(0);
    expect(await readFile(path.join(mod, 'map', 'definition.csv'), 'utf8')).toContain('5;');
  }, 120_000);
});

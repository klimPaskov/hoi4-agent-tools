import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

interface OperationResult {
  status: 'ok' | 'blocked' | 'error';
  code: string;
  workspaceId?: string;
  transactionId?: string;
  planHash?: string;
  proposedFiles: string[];
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

async function connect(
  workspaces: Array<Record<string, unknown>>,
): Promise<{ client: Client; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-mcp-workflow-'));
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    writePolicy: 'transactions',
    serverStateRoot: path.join(root, 'server-state'),
    storageRoots: workspaces.flatMap((workspace) =>
      [workspace.artifactRoot, workspace.cacheRoot].filter(
        (value): value is string => typeof value === 'string',
      ),
    ),
    workspaces,
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
    async () => rm(root, { recursive: true, force: true }),
  );
  return { client, root };
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

async function transactionManifest(
  client: Client,
  planned: OperationResult,
): Promise<Record<string, unknown>> {
  const manifestLink = planned.artifacts.find(({ name }) => name.endsWith('.manifest.json'));
  if (manifestLink === undefined) throw new Error('Expected a transaction manifest resource');
  return readJsonArtifact(client, manifestLink.uri);
}

async function reviewArtifacts(
  client: Client,
  planned: OperationResult,
): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const manifest = await transactionManifest(client, planned);
  return manifest.artifacts as Array<{ uri: string; name: string; mimeType: string }>;
}

async function applyAndRollback(
  client: Client,
  workspaceId: string,
  planned: OperationResult,
): Promise<OperationResult> {
  expect(planned.status).toBe('ok');
  expect(planned.transactionId).toMatch(/^txn_/u);
  expect(planned.planHash).toMatch(/^[a-f0-9]{64}$/u);
  const transactionId = planned.transactionId!;
  const expectedPlanHash = planned.planHash!;

  const status = resultOf(
    await client.callTool({
      name: 'hoi4.transaction_status',
      arguments: { workspaceId, transactionId },
    }),
  );
  expect(status).toMatchObject({
    status: 'ok',
    code: 'TRANSACTION_STATUS',
    data: {
      manifest: {
        transactionId,
        state: 'planned',
        fileCount: planned.proposedFiles.length,
      },
    },
  });
  expect(status.artifacts.some(({ name }) => name.endsWith('.manifest.json'))).toBe(true);
  const manifestLink = status.artifacts.find(({ name }) => name.endsWith('.manifest.json'))!;
  const manifestResource = await client.readResource({ uri: manifestLink.uri });
  const manifestContent = manifestResource.contents[0];
  expect(manifestContent !== undefined && 'text' in manifestContent).toBe(true);
  const completeManifest = JSON.parse(
    manifestContent !== undefined && 'text' in manifestContent ? manifestContent.text : '',
  ) as { files: unknown[]; operations: unknown[] };
  expect(completeManifest.files).toHaveLength(planned.proposedFiles.length);
  expect(completeManifest.operations.length).toBeGreaterThan(0);
  const statusManifest = status.data.manifest as Record<string, unknown>;
  expect(statusManifest).not.toHaveProperty('readDependencies');
  expect(statusManifest).not.toHaveProperty('operations');

  const reviewed = resultOf(
    await client.callTool({
      name: 'hoi4.transaction_diff',
      arguments: { workspaceId, transactionId },
    }),
  );
  expect(reviewed.code).toBe('TRANSACTION_DIFF');
  expect(reviewed.planHash).toBe(expectedPlanHash);
  expect(reviewed.artifacts.length).toBeGreaterThan(0);
  const reviewedData = reviewed.data as {
    fileCount: number;
    operationCount: number;
    files: unknown[];
    operations: Array<Record<string, unknown>>;
  };
  expect(reviewedData.files).toHaveLength(reviewedData.fileCount);
  expect(reviewedData.operations).toHaveLength(reviewedData.operationCount);
  expect(reviewedData.operations.every((operation) => !('data' in operation))).toBe(true);

  const applied = resultOf(
    await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: { workspaceId, transactionId, expectedPlanHash },
    }),
  );
  expect(applied, JSON.stringify(applied, null, 2)).toMatchObject({
    status: 'ok',
    code: 'TRANSACTION_APPLIED',
  });
  expect(applied.changedFiles).toEqual(planned.proposedFiles);

  const rolledBack = resultOf(
    await client.callTool({
      name: 'hoi4.transaction_rollback',
      arguments: { workspaceId, transactionId, expectedPlanHash },
    }),
  );
  expect(rolledBack).toMatchObject({ status: 'ok', code: 'TRANSACTION_ROLLED_BACK' });
  return applied;
}

describe('MCP coding-agent workflows', () => {
  it('scans, renders, plans, applies, and rolls back a focus source edit', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-focus-workflow-'));
    const mod = path.join(temporary, 'mod');
    const game = path.join(temporary, 'game');
    const relativePath = 'content/focus/workflow.txt';
    const sourcePath = path.join(mod, ...relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const original = Buffer.from(
      [
        'focus_tree = {',
        '\tid = workflow_tree',
        '\tcountry = { factor = 0 modifier = { add = 10 tag = AAA } }',
        '\tfocus = {',
        '\t\tid = workflow_root',
        '\t\ticon = GFX_workflow_focus',
        '\t\tx = 0',
        '\t\ty = 0',
        '\t\tcost = 5',
        '\t\tcompletion_reward = {',
        '\t\t\tadd_political_power = 10',
        '\t\t\tactivate_decision = reform_country_economy',
        '\t\t}',
        '\t}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(sourcePath, original);
    const decisionPath = path.join(mod, 'common', 'decisions', 'workflow.txt');
    await mkdir(path.dirname(decisionPath), { recursive: true });
    await writeFile(
      decisionPath,
      [
        'workflow_decisions = {',
        '\treform_country_economy = {',
        '\t\tallowed = { always = yes }',
        '\t\tavailable = { always = yes }',
        '\t\tvisible = { always = yes }',
        '\t\tcost = 1',
        '\t\tcomplete_effect = { }',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    const gfxPath = path.join(mod, 'interface', 'workflow.gfx');
    const texturePath = path.join(mod, 'gfx', 'interface', 'workflow-focus.png');
    const localisationPath = path.join(mod, 'localisation', 'english', 'workflow_l_english.yml');
    await mkdir(path.dirname(gfxPath), { recursive: true });
    await mkdir(path.dirname(texturePath), { recursive: true });
    await mkdir(path.dirname(localisationPath), { recursive: true });
    await writeFile(
      gfxPath,
      [
        'spriteTypes = {',
        '\tspriteType = {',
        '\t\tname = "GFX_workflow_focus"',
        '\t\ttexturefile = "gfx/interface/workflow-focus.png"',
        '\t\tnoOfFrames = 2',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    await cp(
      path.join(
        repositoryRoot,
        'fixtures',
        'focus',
        'workspace',
        'gfx',
        'interface',
        'goals',
        'synthetic_focus.png',
      ),
      texturePath,
    );
    await writeFile(
      localisationPath,
      Buffer.from(
        '\ufeffl_english:\n workflow_root: "Localized Workflow Root"\n workflow_root_desc: "Localized workflow description."\n',
        'utf8',
      ),
    );
    const gameGfxPath = path.join(game, 'interface', 'workflow.gfx');
    const gameTexturePath = path.join(game, 'gfx', 'interface', 'workflow-focus.png');
    const gameLocalisationPath = path.join(
      game,
      'localisation',
      'english',
      'workflow_l_english.yml',
    );
    await mkdir(path.dirname(gameGfxPath), { recursive: true });
    await mkdir(path.dirname(gameTexturePath), { recursive: true });
    await mkdir(path.dirname(gameLocalisationPath), { recursive: true });
    await writeFile(
      gameGfxPath,
      [
        'spriteTypes = {',
        '\tspriteType = {',
        '\t\tname = "GFX_workflow_focus"',
        '\t\ttexturefile = "gfx/interface/workflow-focus.png"',
        '\t\tnoOfFrames = 1',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    await cp(texturePath, gameTexturePath);
    await writeFile(
      gameLocalisationPath,
      Buffer.from(
        '\ufeffl_english:\n workflow_root: "Base Workflow Root"\n workflow_root_desc: "Base workflow description."\n',
        'utf8',
      ),
    );
    const { client, root } = await connect([
      {
        id: 'focus',
        name: 'Synthetic focus workflow',
        root: mod,
        gameRoot: game,
        writeEnabled: true,
        roots: {
          localisation: ['localisation', 'localisation_synced'],
          interface: ['interface'],
          gfx: ['gfx'],
          map: ['map'],
          focus: ['content/focus'],
          scriptedGui: ['common/scripted_guis'],
          states: ['history/states'],
        },
        artifactRoot: path.join(temporary, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporary, 'runtime', 'cache'),
      },
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
    expect(root).not.toBe(mod);

    const scanned = resultOf(
      await client.callTool({
        name: 'hoi4.focus_scan',
        arguments: { workspaceId: 'focus', relativePath },
      }),
    );
    expect(scanned.code).toBe('FOCUS_SCANNED');
    const scanArtifact = scanned.artifacts.find(({ mimeType }) => mimeType === 'application/json');
    expect(scanArtifact).toBeDefined();
    const scanJson = await readJsonArtifact(client, scanArtifact!.uri);
    const plan = (scanJson.plans as Array<Record<string, unknown>>)[0]!;
    const planFocuses = plan.focuses as Array<{ links?: Array<{ kind: string; target: string }> }>;
    expect(planFocuses[0]?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'decision', target: 'reform_country_economy' }),
      ]),
    );
    const presentation = scanJson.presentation as {
      entries: Record<string, { title: string }>;
      icons: Record<string, { frameCount: number; dataUri?: string }>;
    };
    expect(presentation.entries.workflow_root?.title).toBe('Localized Workflow Root');
    expect(presentation.icons.GFX_workflow_focus).toEqual(
      expect.objectContaining({
        frameCount: 2,
      }),
    );
    expect(presentation.icons.GFX_workflow_focus?.dataUri).toBeUndefined();
    expect(JSON.stringify(scanJson)).not.toContain('data:image');

    const linted = resultOf(
      await client.callTool({
        name: 'hoi4.focus_lint',
        arguments: { workspaceId: 'focus', relativePath, treeId: 'workflow_tree' },
      }),
    );
    expect(linted).toMatchObject({
      status: 'ok',
      code: 'FOCUS_LINTED',
      data: { mode: 'national', treeId: 'workflow_tree' },
    });

    const laidOut = resultOf(
      await client.callTool({
        name: 'hoi4.focus_layout',
        arguments: {
          workspaceId: 'focus',
          relativePath,
          treeId: 'workflow_tree',
          laneSpacing: 3,
          nodeSpacing: 2,
        },
      }),
    );
    expect(laidOut).toMatchObject({ status: 'ok', code: 'FOCUS_LAYOUT_PLANNED' });
    const layoutArtifact = laidOut.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    expect(layoutArtifact).toBeDefined();
    const previousLayout = await readJsonArtifact(client, layoutArtifact!.uri);
    const previousDecisions = previousLayout.decisions;
    expect(Array.isArray(previousDecisions)).toBe(true);
    previousLayout.decisions = [
      ...(Array.isArray(previousDecisions) ? previousDecisions : []),
      {
        focusId: 'workflow_root',
        kind: 'moved_for_mutual_exclusion',
        message: 'Retained schema round-trip evidence',
      },
      {
        focusId: 'workflow_child',
        kind: 'moved_to_reduce_crossings',
        message: 'Retained schema round-trip evidence',
      },
    ];
    const stableLayout = resultOf(
      await client.callTool({
        name: 'hoi4.focus_layout',
        arguments: {
          workspaceId: 'focus',
          relativePath,
          treeId: 'workflow_tree',
          previous: previousLayout,
          laneSpacing: 3,
          nodeSpacing: 2,
        },
      }),
    );
    expect(stableLayout.data.layoutHash).toBe(laidOut.data.layoutHash);

    const focuses = plan.focuses as Array<Record<string, unknown>>;
    focuses[0]!.cost = 7;

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.focus_render',
        arguments: { workspaceId: 'focus', relativePath, treeId: 'workflow_tree' },
      }),
    );
    expect(rendered.code).toBe('FOCUS_RENDERED');
    expect(rendered.data).toMatchObject({ mode: 'national', treeId: 'workflow_tree' });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['text/html', 'image/svg+xml', 'image/png', 'application/json']),
    );
    expect(rendered.artifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'workflow_tree.focus.source-map.json',
        'workflow_tree.focus.plan.json',
      ]),
    );
    const renderedSourceMapArtifact = rendered.artifacts.find(
      ({ name }) => name === 'workflow_tree.focus.source-map.json',
    );
    expect(renderedSourceMapArtifact).toBeDefined();
    const renderedSourceMap = await readJsonArtifact(client, renderedSourceMapArtifact!.uri);
    expect(renderedSourceMap.mappings).toEqual([
      expect.objectContaining({
        focusId: 'workflow_root',
        generatedLocation: expect.any(Object),
        planNodeLocation: expect.objectContaining({
          path: 'mod:content/focus/workflow.txt',
          symbol: 'workflow_root',
        }),
      }),
    ]);
    const svgArtifact = rendered.artifacts.find(({ mimeType }) => mimeType === 'image/svg+xml');
    expect(svgArtifact).toBeDefined();
    const svgResource = await client.readResource({ uri: svgArtifact!.uri });
    const svg = svgResource.contents[0];
    expect(svg !== undefined && 'text' in svg ? svg.text : '').toContain('Localized Workflow Root');

    const planned = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: { workspaceId: 'focus', relativePath, plan },
      }),
    );
    expect(planned.code).toBe('FOCUS_CHANGES_PLANNED');
    expect(planned.data).toMatchObject({ mode: 'national', treeId: 'workflow_tree' });
    expect(planned.proposedFiles).toEqual([
      'content/focus/workflow.focus-plan.json',
      'content/focus/workflow.txt',
    ]);
    const plannedReviewArtifacts = await reviewArtifacts(client, planned);
    expect(plannedReviewArtifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'workflow_tree.focus.proposed-source-map.json',
        'workflow_tree.focus.proposed-plan.json',
      ]),
    );
    const proposedSourceMapArtifact = plannedReviewArtifacts.find(
      ({ name }) => name === 'workflow_tree.focus.proposed-source-map.json',
    );
    expect(proposedSourceMapArtifact).toBeDefined();
    const proposedSourceMap = await readJsonArtifact(client, proposedSourceMapArtifact!.uri);
    expect(proposedSourceMap.mappings).toEqual([
      expect.objectContaining({
        focusId: 'workflow_root',
        generatedLocation: expect.any(Object),
        planNodeLocation: expect.objectContaining({
          path: 'mod:content/focus/workflow.txt',
          symbol: 'workflow_root',
        }),
      }),
    ]);
    expect(await readFile(sourcePath)).toEqual(original);
    await applyAndRollback(client, 'focus', planned);
    expect(await readFile(sourcePath)).toEqual(original);
    await expect(
      readFile(path.join(mod, 'content', 'focus', 'workflow.focus-plan.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const createdRelativePath = 'content/focus/created-workflow.txt';
    const createdSourcePath = path.join(mod, ...createdRelativePath.split('/'));
    const createdSidecarPath = path.join(
      mod,
      'content',
      'focus',
      'created-workflow.focus-plan.json',
    );
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
    const refusedCreation = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          workspaceId: 'focus',
          relativePath: createdRelativePath,
          plan: createdPlan,
        },
      }),
    );
    expect(refusedCreation).toMatchObject({ status: 'error', code: 'FOCUS_SOURCE_NOT_FOUND' });
    const created = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
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
      code: 'FOCUS_CHANGES_PLANNED',
      data: {
        mode: 'national',
        treeId: 'created_workflow_tree',
        created: true,
        drift: { status: 'target_missing', requiresAuthority: false },
      },
    });
    expect(created.proposedFiles).toEqual(
      [createdSidecarPath, createdSourcePath]
        .map((file) => path.relative(mod, file).replaceAll('\\', '/'))
        .sort(),
    );
    const createdReviewArtifacts = await reviewArtifacts(client, created);
    expect(createdReviewArtifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'created_workflow_tree.focus-before.png',
        'created_workflow_tree.focus-visual-diff.png',
        'created_workflow_tree.focus.proposed-source-map.json',
      ]),
    );
    await applyAndRollback(client, 'focus', created);
    await expect(readFile(createdSourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(createdSidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const refusedExistingSourceCreation = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          workspaceId: 'focus',
          relativePath,
          plan: createdPlan,
          createIfMissing: true,
        },
      }),
    );
    expect(refusedExistingSourceCreation).toMatchObject({
      status: 'error',
      code: 'FOCUS_CREATE_REQUIRES_NEW_SOURCE',
    });

    const readOnlyRelativePath = 'content/focus/read-only-base.txt';
    const readOnlyGamePath = path.join(game, ...readOnlyRelativePath.split('/'));
    await mkdir(path.dirname(readOnlyGamePath), { recursive: true });
    await writeFile(readOnlyGamePath, original);
    const refusedShadow = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          workspaceId: 'focus',
          relativePath: readOnlyRelativePath,
          plan: createdPlan,
          createIfMissing: true,
        },
      }),
    );
    expect(refusedShadow).toMatchObject({ status: 'error', code: 'FOCUS_SOURCE_READ_ONLY' });
    await expect(
      readFile(path.join(mod, ...readOnlyRelativePath.split('/'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await Promise.all([rm(texturePath), rm(gameTexturePath)]);
    const missingTextureScan = resultOf(
      await client.callTool({
        name: 'hoi4.focus_scan',
        arguments: { workspaceId: 'focus', relativePath },
      }),
    );
    const missingTextureArtifact = missingTextureScan.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    expect(missingTextureArtifact).toBeDefined();
    const missingTextureJson = await readJsonArtifact(client, missingTextureArtifact!.uri);
    const missingTextureDiagnostics = missingTextureJson.diagnostics as Array<{
      code: string;
      location?: { path: string; symbol?: string };
    }>;
    expect(missingTextureDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'FOCUS_ICON_TEXTURE_MISSING',
        location: expect.objectContaining({
          path: 'mod:content/focus/workflow.txt',
          symbol: 'GFX_workflow_focus',
        }),
      }),
    );
  }, 30_000);

  it('renders and dry-runs a wide, deep focus-tree rewrite with one uniform safe review scale', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-focus-review-scale-'));
    const mod = path.join(temporary, 'mod');
    const relativePath = 'common/national_focus/large-review.txt';
    const sourcePath = path.join(mod, ...relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const focusCount = 89;
    const focusBlocks = Array.from({ length: focusCount }, (_, index) => {
      const x = -28 + (index % 58);
      const y = index < 58 ? 0 : 41;
      return [
        '\tfocus = {',
        `\t\tid = large_review_${String(index).padStart(3, '0')}`,
        `\t\tx = ${x}`,
        `\t\ty = ${y}`,
        '\t\tcost = 5',
        '\t}',
      ].join('\n');
    });
    const original = Buffer.from(
      [
        'focus_tree = {',
        '\tid = large_review_tree',
        '\tdefault = yes',
        ...focusBlocks,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(sourcePath, original);
    const { client } = await connect([
      {
        id: 'large_review',
        name: 'Large focus transaction review scale',
        root: mod,
        writeEnabled: true,
        artifactRoot: path.join(temporary, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporary, 'runtime', 'cache'),
      },
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const scanned = resultOf(
      await client.callTool({
        name: 'hoi4.focus_scan',
        arguments: { workspaceId: 'large_review', relativePath },
      }),
    );
    expect(scanned.code).toBe('FOCUS_SCANNED');
    const scanArtifact = scanned.artifacts.find(({ mimeType }) => mimeType === 'application/json');
    expect(scanArtifact).toBeDefined();
    const scanJson = await readJsonArtifact(client, scanArtifact!.uri);
    const plan = (scanJson.plans as Array<Record<string, unknown>>)[0]!;
    const focuses = plan.focuses as Array<{
      cost?: number;
      position: { mode: string; x: number; y: number; pinned: boolean };
    }>;
    expect(focuses).toHaveLength(focusCount);
    for (const [index, focus] of focuses.entries()) {
      focus.position = {
        mode: 'fixed',
        x: index - 44,
        y: index < 58 ? 0 : 41,
        pinned: false,
      };
    }
    focuses[0]!.cost = 6;

    const unscaledRender = resultOf(
      await client.callTool({
        name: 'hoi4.focus_render',
        arguments: { workspaceId: 'large_review', relativePath },
      }),
    );
    expect(unscaledRender).toMatchObject({ status: 'blocked', code: 'RENDER_PIXELS_BLOCKED' });
    const scaledRender = resultOf(
      await client.callTool({
        name: 'hoi4.focus_render',
        arguments: { workspaceId: 'large_review', relativePath, reviewScale: 0.4 },
      }),
    );
    expect(scaledRender).toMatchObject({
      status: 'ok',
      code: 'FOCUS_RENDERED',
      data: { width: 4_134, height: 1_997 },
    });

    const unscaled = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: { workspaceId: 'large_review', relativePath, plan },
      }),
    );
    expect(unscaled).toMatchObject({ status: 'blocked', code: 'RENDER_PIXELS_BLOCKED' });

    const planned = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          workspaceId: 'large_review',
          relativePath,
          plan,
          horizontalSpacing: 176,
          verticalSpacing: 116,
          padding: 80,
          reviewScale: 0.4,
        },
      }),
    );
    expect(planned).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_PLANNED',
      data: { mode: 'national', treeId: 'large_review_tree' },
    });
    expect(await readFile(sourcePath)).toEqual(original);

    const artifacts = await reviewArtifacts(client, planned);
    const before = artifacts.find(({ name }) => name === 'large_review_tree.focus-before.png');
    const proposed = artifacts.find(({ name }) => name === 'large_review_tree.focus.png');
    const diff = artifacts.find(({ name }) => name === 'large_review_tree.focus-visual-diff.json');
    const completeValidation = artifacts.find(
      ({ name }) => name === 'large_review_tree.focus.proposed-validation.json',
    );
    expect(before).toBeDefined();
    expect(proposed).toBeDefined();
    expect(diff).toBeDefined();
    expect(completeValidation).toBeDefined();
    const [beforeMetadata, proposedMetadata, diffJson, completeValidationJson] = await Promise.all([
      sharp(await readBinaryArtifact(client, before!.uri)).metadata(),
      sharp(await readBinaryArtifact(client, proposed!.uri)).metadata(),
      readJsonArtifact(client, diff!.uri),
      readJsonArtifact(client, completeValidation!.uri),
    ]);
    expect(beforeMetadata).toMatchObject({ width: 4_134, height: 1_997 });
    expect(proposedMetadata).toMatchObject({ width: 6_317, height: 1_997 });
    expect(diffJson).toMatchObject({ width: 6_317, height: 1_997 });
    expect(completeValidationJson.diagnosticCount).toBeGreaterThan(100);
    expect(completeValidationJson.diagnostics).toHaveLength(
      completeValidationJson.diagnosticCount as number,
    );

    const applied = resultOf(
      await client.callTool({
        name: 'hoi4.transaction_apply',
        arguments: {
          workspaceId: 'large_review',
          transactionId: planned.transactionId,
          expectedPlanHash: planned.planHash,
        },
      }),
    );
    expect(applied).toMatchObject({ code: 'TRANSACTION_APPLIED', data: { state: 'applied' } });
    expect(await readFile(sourcePath)).not.toEqual(original);
    const status = resultOf(
      await client.callTool({
        name: 'hoi4.transaction_status',
        arguments: { workspaceId: 'large_review', transactionId: planned.transactionId },
      }),
    );
    const manifest = await readJsonArtifact(client, status.artifacts[0]!.uri);
    const postValidationSummary = (
      manifest.diagnostics as Array<{
        code: string;
        details?: { artifact?: { uri?: string } };
      }>
    ).find(({ code }) => code === 'POST_VALIDATION_DIAGNOSTICS_IN_RESOURCE');
    expect(postValidationSummary?.details?.artifact?.uri).toBeTypeOf('string');
    const postValidationEvidence = await readJsonArtifact(
      client,
      postValidationSummary!.details!.artifact!.uri!,
    );
    expect(postValidationEvidence.diagnosticCount).toBeGreaterThan(100);
    expect(
      (postValidationEvidence.diagnostics as Array<{ code: string }>).map(({ code }) => code),
    ).not.toContain('FOCUS_TREE_NOT_FOUND');

    const rolledBack = resultOf(
      await client.callTool({
        name: 'hoi4.transaction_rollback',
        arguments: {
          workspaceId: 'large_review',
          transactionId: planned.transactionId,
          expectedPlanHash: planned.planHash,
        },
      }),
    );
    expect(rolledBack).toMatchObject({
      code: 'TRANSACTION_ROLLED_BACK',
      data: { state: 'rolled_back' },
    });
    expect(await readFile(sourcePath)).toEqual(original);
  }, 90_000);

  it('lints, renders, plans, applies, and rolls back a continuous focus palette edit', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-continuous-workflow-'));
    const mod = path.join(temporary, 'mod');
    const relativePath = 'common/continuous_focus/workflow.txt';
    const sourcePath = path.join(mod, ...relativePath.split('/'));
    const nationalPath = path.join(mod, 'common', 'national_focus', 'discovery.txt');
    const gfxPath = path.join(mod, 'interface', 'continuous-workflow.gfx');
    await Promise.all([
      mkdir(path.dirname(sourcePath), { recursive: true }),
      mkdir(path.dirname(nationalPath), { recursive: true }),
      mkdir(path.dirname(gfxPath), { recursive: true }),
    ]);
    const original = Buffer.from(
      [
        'continuous_focus_palette = {',
        '\tid = workflow_continuous_palette',
        '\tdefault = yes',
        '\treset_on_civilwar = no',
        '',
        '\tfocus = {',
        '\t\tid = workflow_continuous_focus',
        '\t\ticon = GFX_workflow_continuous',
        '\t\tmodifier = { army_org_factor = 0.05 }',
        '\t}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(sourcePath, original);
    await writeFile(
      nationalPath,
      ['focus_tree = {', '\tid = discovery_tree', '\tdefault = yes', '}', ''].join('\n'),
    );
    await writeFile(
      gfxPath,
      [
        'spriteTypes = {',
        '\tspriteType = {',
        '\t\tname = "GFX_workflow_continuous"',
        '\t\ttexturefile = "gfx/interface/missing-continuous-workflow.png"',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    const { client } = await connect([
      {
        id: 'continuous',
        name: 'Synthetic continuous focus workflow',
        root: mod,
        writeEnabled: true,
        artifactRoot: path.join(temporary, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporary, 'runtime', 'cache'),
      },
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const scanned = resultOf(
      await client.callTool({
        name: 'hoi4.focus_scan',
        arguments: { workspaceId: 'continuous' },
      }),
    );
    const scanArtifact = scanned.artifacts.find(({ mimeType }) => mimeType === 'application/json');
    expect(scanArtifact).toBeDefined();
    const scanJson = await readJsonArtifact(client, scanArtifact!.uri);
    const plan = (scanJson.continuousFocusPalettes as Array<Record<string, unknown>>).find(
      ({ id }) => id === 'workflow_continuous_palette',
    );
    expect(plan).toBeDefined();

    const ambiguousRenderScale = await client.callTool({
      name: 'hoi4.focus_render',
      arguments: {
        mode: 'continuous',
        workspaceId: 'continuous',
        relativePath,
        reviewScale: 0.5,
      },
    });
    expect(ambiguousRenderScale.isError).toBe(true);
    expect(JSON.stringify(ambiguousRenderScale.content)).toContain('reviewScale');

    const ambiguousReviewScale = await client.callTool({
      name: 'hoi4.focus_plan_changes',
      arguments: {
        mode: 'continuous',
        workspaceId: 'continuous',
        relativePath,
        plan,
        reviewScale: 0.5,
      },
    });
    expect(ambiguousReviewScale.isError).toBe(true);
    expect(JSON.stringify(ambiguousReviewScale.content)).toContain('reviewScale');

    const linted = resultOf(
      await client.callTool({
        name: 'hoi4.focus_lint',
        arguments: {
          mode: 'continuous',
          workspaceId: 'continuous',
          relativePath,
          paletteId: 'workflow_continuous_palette',
        },
      }),
    );
    expect(linted).toMatchObject({
      status: 'ok',
      code: 'CONTINUOUS_FOCUS_LINTED',
      data: { mode: 'continuous', paletteId: 'workflow_continuous_palette' },
    });

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.focus_render',
        arguments: {
          mode: 'continuous',
          workspaceId: 'continuous',
          relativePath,
          paletteId: 'workflow_continuous_palette',
          columns: 2,
        },
      }),
    );
    expect(rendered).toMatchObject({
      status: 'ok',
      code: 'CONTINUOUS_FOCUS_RENDERED',
      data: { mode: 'continuous', paletteId: 'workflow_continuous_palette' },
    });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['text/html', 'image/svg+xml', 'image/png', 'application/json']),
    );
    expect(rendered.artifacts.map(({ name }) => name)).toContain(
      'workflow_continuous_palette.continuous.source-map.json',
    );

    plan!.resetOnCivilWar = true;
    const planned = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          mode: 'continuous',
          workspaceId: 'continuous',
          relativePath,
          plan,
        },
      }),
    );
    expect(planned).toMatchObject({
      status: 'ok',
      code: 'CONTINUOUS_FOCUS_CHANGES_PLANNED',
      data: { mode: 'continuous', paletteId: 'workflow_continuous_palette' },
    });
    expect(planned.proposedFiles).toEqual([relativePath]);
    const plannedReviewArtifacts = await reviewArtifacts(client, planned);
    expect(plannedReviewArtifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'workflow_continuous_palette.continuous.proposed-source-map.json',
        'workflow_continuous_palette.continuous-focus-before.png',
        'workflow_continuous_palette.continuous-focus-visual-diff.png',
      ]),
    );
    expect(await readFile(sourcePath)).toEqual(original);
    await applyAndRollback(client, 'continuous', planned);
    const completeValidation = (await transactionManifest(client, planned)).validation as {
      checks: Array<{ id: string; passed: boolean }>;
    };
    expect(completeValidation.checks).toContainEqual(
      expect.objectContaining({ id: 'post-write-continuous-focus', passed: true }),
    );
    expect(await readFile(sourcePath)).toEqual(original);

    const createdRelativePath = 'common/continuous_focus/created-workflow.txt';
    const createdSourcePath = path.join(mod, ...createdRelativePath.split('/'));
    const createdPlan = JSON.parse(
      JSON.stringify(plan)
        .replaceAll('workflow_continuous_palette', 'created_continuous_palette')
        .replaceAll('workflow_continuous_focus', 'created_continuous_focus'),
    ) as Record<string, unknown>;
    createdPlan.provenance = {
      sourcePath: 'plan:created_continuous_palette',
      sourceHash: '0'.repeat(64),
      importedPlanHash: '0'.repeat(64),
    };
    const created = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          mode: 'continuous',
          workspaceId: 'continuous',
          relativePath: createdRelativePath,
          plan: createdPlan,
          createIfMissing: true,
        },
      }),
    );
    expect(created).toMatchObject({
      status: 'ok',
      code: 'CONTINUOUS_FOCUS_CHANGES_PLANNED',
      data: {
        mode: 'continuous',
        paletteId: 'created_continuous_palette',
        created: true,
        drift: { status: 'target_missing', requiresAuthority: false },
      },
    });
    expect(created.proposedFiles).toEqual([createdRelativePath]);
    const createdReviewArtifacts = await reviewArtifacts(client, created);
    expect(createdReviewArtifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'created_continuous_palette.continuous-focus-before.png',
        'created_continuous_palette.continuous-focus-visual-diff.png',
        'created_continuous_palette.continuous.proposed-source-map.json',
      ]),
    );
    await applyAndRollback(client, 'continuous', created);
    await expect(readFile(createdSourcePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const refusedExistingSourceCreation = resultOf(
      await client.callTool({
        name: 'hoi4.focus_plan_changes',
        arguments: {
          mode: 'continuous',
          workspaceId: 'continuous',
          relativePath,
          plan: createdPlan,
          createIfMissing: true,
        },
      }),
    );
    expect(refusedExistingSourceCreation).toMatchObject({
      status: 'error',
      code: 'CONTINUOUS_FOCUS_CREATE_REQUIRES_NEW_SOURCE',
    });
  }, 30_000);

  it('renders, plans a source-linked GUI patch, applies it, and restores exact bytes', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-gui-workflow-'));
    const mod = path.join(temporary, 'mod');
    const relativePath = 'interface/workflow.gui';
    const sourcePath = path.join(mod, ...relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const source = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "workflow_window"',
      '\t\tposition = { x = 10 y = 10 }',
      '\t\tsize = { width = 120 height = 80 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    const original = Buffer.from(source, 'utf8');
    await writeFile(sourcePath, original);
    const { client } = await connect([
      {
        id: 'gui',
        name: 'Synthetic GUI workflow',
        root: mod,
        writeEnabled: true,
        artifactRoot: path.join(temporary, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporary, 'runtime', 'cache'),
      },
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
    const scenario = { id: 'workflow', resolution: { width: 640, height: 360 } };

    const scanned = resultOf(
      await client.callTool({
        name: 'hoi4.gui_scan',
        arguments: { workspaceId: 'gui' },
      }),
    );
    expect(scanned).toMatchObject({ status: 'ok', code: 'GUI_SCANNED' });

    const comparedScenario = {
      id: 'workflow-selected',
      resolution: { width: 800, height: 450 },
      uiScale: 1.25,
      state: 'selected',
      variables: { readiness: 1 },
      visibility: { workflow_window: true },
    };
    const linted = resultOf(
      await client.callTool({
        name: 'hoi4.gui_lint',
        arguments: {
          workspaceId: 'gui',
          windowName: 'workflow_window',
          scenario,
          relatedScenarios: [comparedScenario],
        },
      }),
    );
    expect(linted).toMatchObject({ status: 'ok', code: 'GUI_LINTED' });

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.gui_render',
        arguments: { workspaceId: 'gui', windowName: 'workflow_window', scenario },
      }),
    );
    expect(rendered.code).toBe('GUI_RENDERED');
    expect(rendered.artifacts.some(({ name }) => name.includes('fidelity'))).toBe(true);

    const statesRendered = resultOf(
      await client.callTool({
        name: 'hoi4.gui_render_states',
        arguments: {
          workspaceId: 'gui',
          windowName: 'workflow_window',
          scenario,
          states: ['normal', 'hover', 'selected', 'disabled'],
          resolutions: [
            { width: 640, height: 360 },
            { width: 800, height: 450, uiScale: 1.25 },
          ],
          comparisonScenario: comparedScenario,
        },
      }),
    );
    expect(statesRendered).toMatchObject({ status: 'ok', code: 'GUI_STATES_RENDERED' });

    const compared = resultOf(
      await client.callTool({
        name: 'hoi4.gui_compare',
        arguments: {
          workspaceId: 'gui',
          windowName: 'workflow_window',
          before: scenario,
          after: comparedScenario,
        },
      }),
    );
    expect(compared).toMatchObject({ status: 'ok', code: 'GUI_COMPARED' });
    const comparisonJson = compared.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    expect(comparisonJson).toBeDefined();
    const comparisonEvidence = await readJsonArtifact(client, comparisonJson!.uri);
    expect(comparisonEvidence).toMatchObject({
      offline: true,
      kind: 'gui-comparison',
      windowName: 'workflow_window',
      before: {
        scenario: { id: scenario.id, resolution: scenario.resolution, uiScale: 1 },
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        fidelity: expect.objectContaining({ modelled: expect.any(Array) }),
      },
      after: {
        scenario: {
          id: comparedScenario.id,
          resolution: comparedScenario.resolution,
          uiScale: comparedScenario.uiScale,
        },
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        fidelity: expect.objectContaining({ modelled: expect.any(Array) }),
      },
      comparison: expect.objectContaining({ offline: true, threshold: 8 }),
    });
    expect(comparisonEvidence.sourceHashes).toEqual(expect.any(Object));
    const comparisonDescription = resultOf(
      await client.callTool({
        name: 'hoi4.artifact_describe',
        arguments: { workspaceId: 'gui', uri: comparisonJson!.uri },
      }),
    );
    const comparisonManifestLink = comparisonDescription.artifacts.find(({ name }) =>
      name.endsWith('.manifest.json'),
    );
    expect(comparisonManifestLink).toBeDefined();
    const comparisonManifest = await readJsonArtifact(client, comparisonManifestLink!.uri);
    expect(comparisonManifest).toMatchObject({
      provenance: {
        kind: 'gui-comparison-json',
        renderProfile: {
          offline: true,
          scenarioId: scenario.id,
          sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
          scenarios: [
            expect.objectContaining({
              scenario: expect.objectContaining({ id: scenario.id }),
              fidelity: expect.any(Object),
            }),
            expect.objectContaining({
              scenario: expect.objectContaining({ id: comparedScenario.id }),
              fidelity: expect.any(Object),
            }),
          ],
        },
      },
    });

    const artifactList = resultOf(
      await client.callTool({
        name: 'hoi4.artifact_list',
        arguments: { workspaceId: 'gui', limit: 2 },
      }),
    );
    expect(artifactList).toMatchObject({ status: 'ok', code: 'ARTIFACT_LIST' });
    expect(artifactList.artifacts).toHaveLength(2);
    expect(artifactList.data).toMatchObject({ returned: 2 });
    expect(artifactList.data.count).toEqual(expect.any(Number));
    expect(artifactList.data.nextCursor).toEqual(expect.any(String));
    const nextArtifactPage = resultOf(
      await client.callTool({
        name: 'hoi4.artifact_list',
        arguments: {
          workspaceId: 'gui',
          limit: 2,
          cursor: artifactList.data.nextCursor,
        },
      }),
    );
    expect(nextArtifactPage).toMatchObject({
      status: 'ok',
      code: 'ARTIFACT_LIST',
      data: { returned: 2 },
    });
    expect(nextArtifactPage.artifacts.map(({ uri }) => uri)).not.toEqual(
      artifactList.artifacts.map(({ uri }) => uri),
    );
    const invalidCursor = resultOf(
      await client.callTool({
        name: 'hoi4.artifact_list',
        arguments: { workspaceId: 'gui', cursor: 'not_a_valid_cursor' },
      }),
    );
    expect(invalidCursor).toMatchObject({ status: 'error', code: 'ARTIFACT_CURSOR_INVALID' });
    const described = resultOf(
      await client.callTool({
        name: 'hoi4.artifact_describe',
        arguments: { workspaceId: 'gui', uri: rendered.artifacts[0]!.uri },
      }),
    );
    expect(described).toMatchObject({ status: 'ok', code: 'ARTIFACT_DESCRIBE' });

    const expectedText = 'x = 10';
    const start = source.indexOf(expectedText);
    const planned = resultOf(
      await client.callTool({
        name: 'hoi4.gui_plan_changes',
        arguments: {
          mode: 'patches',
          workspaceId: 'gui',
          relativePath,
          windowName: 'workflow_window',
          scenario,
          expectedSourceHash: sha256Bytes(original),
          patches: [
            {
              start,
              end: start + expectedText.length,
              expectedText,
              text: 'x = 30',
              description: 'Move the synthetic workflow window',
            },
          ],
        },
      }),
    );
    expect(planned.code).toBe('GUI_CHANGES_PLANNED');
    expect((await reviewArtifacts(client, planned)).map(({ name }) => name).join('\n')).toMatch(
      /before|visual-diff/u,
    );
    expect(await readFile(sourcePath)).toEqual(original);
    await applyAndRollback(client, 'gui', planned);
    expect(await readFile(sourcePath)).toEqual(original);
  }, 60_000);

  it('renders, geometry-plans, applies, and exactly rolls back a map transaction', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-map-workflow-'));
    const fixtureRoots = path.resolve('fixtures', 'map', 'roots');
    const game = path.join(temporary, 'game');
    const dependency = path.join(temporary, 'dependency');
    const mod = path.join(temporary, 'mod');
    await Promise.all([
      cp(path.join(fixtureRoots, 'game'), game, { recursive: true }),
      cp(path.join(fixtureRoots, 'dependency'), dependency, { recursive: true }),
      cp(path.join(fixtureRoots, 'mod'), mod, { recursive: true }),
    ]);
    const originalModDefinitionExists = await readFile(
      path.join(dependency, 'map', 'definition.csv'),
    );
    const { client } = await connect([
      {
        id: 'map',
        name: 'Synthetic map workflow',
        root: mod,
        gameRoot: game,
        dependencyRoots: [dependency],
        writeEnabled: true,
        artifactRoot: path.join(temporary, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporary, 'runtime', 'cache'),
      },
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const scanned = resultOf(
      await client.callTool({ name: 'hoi4.map_scan', arguments: { workspaceId: 'map' } }),
    );
    expect(scanned).toMatchObject({ status: 'ok', code: 'MAP_SCANNED' });

    const inspected = resultOf(
      await client.callTool({
        name: 'hoi4.map_inspect',
        arguments: {
          workspaceId: 'map',
          provinceIds: [1, 4, 4, 999],
          stateIds: [1, 999],
          regionIds: [1, 999],
        },
      }),
    );
    expect(inspected).toMatchObject({ status: 'ok', code: 'MAP_INSPECTED' });

    const allocatedState = resultOf(
      await client.callTool({
        name: 'hoi4.map_allocate',
        arguments: { workspaceId: 'map', request: { kind: 'state' } },
      }),
    );
    expect(allocatedState).toMatchObject({ status: 'ok', code: 'MAP_ALLOCATION_PREVIEWED' });
    const allocatedProvince = resultOf(
      await client.callTool({
        name: 'hoi4.map_allocate',
        arguments: {
          workspaceId: 'map',
          request: {
            kind: 'province',
            requestedId: 5,
            requestedColor: { r: 123, g: 45, b: 67 },
          },
        },
      }),
    );
    expect(allocatedProvince).toMatchObject({ status: 'ok', code: 'MAP_ALLOCATION_PREVIEWED' });

    const validated = resultOf(
      await client.callTool({ name: 'hoi4.map_validate', arguments: { workspaceId: 'map' } }),
    );
    expect(validated).toMatchObject({ status: 'ok', code: 'MAP_VALIDATED' });

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.map_render',
        arguments: { workspaceId: 'map', layer: 'province', overlays: ['coastlines'] },
      }),
    );
    expect(rendered.code).toBe('MAP_RENDERED');
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['image/png', 'application/json', 'text/html']),
    );
    const defaultRender = resultOf(
      await client.callTool({ name: 'hoi4.map_render', arguments: { workspaceId: 'map' } }),
    );
    expect(defaultRender).toMatchObject({ status: 'ok', code: 'MAP_RENDERED' });

    const pixels = Array.from({ length: 128 }, (_, y) =>
      Array.from({ length: 16 }, (_unused, x) => ({ x: x + 80, y: y + 64 })),
    ).flat();
    const planned = resultOf(
      await client.callTool({
        name: 'hoi4.map_plan',
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
    expect(planned.code).toBe('MAP_CHANGES_PLANNED');
    expect(planned.proposedFiles).toEqual(
      expect.arrayContaining([
        'history/states/1-GAME.txt',
        'map/definition.csv',
        'map/provinces.bmp',
        'map/strategicregions/1-REGION.txt',
      ]),
    );
    await applyAndRollback(client, 'map', planned);
    await expect(readFile(path.join(mod, 'map', 'definition.csv'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(dependency, 'map', 'definition.csv'))).toEqual(
      originalModDefinitionExists,
    );
  }, 60_000);
});

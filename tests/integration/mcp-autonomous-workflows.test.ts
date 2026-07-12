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
import { errorResult } from '../../src/hoi4_agent_tools/mcp/server/result.js';
import {
  autonomousFailureContext,
  executePlannedTransaction,
} from '../../src/hoi4_agent_tools/mcp/server/transaction-execution.js';
import type { AutonomousRewriteError } from '../../src/hoi4_agent_tools/mcp/server/transaction-execution.js';

interface OperationResult {
  status: 'ok' | 'blocked' | 'error';
  code: string;
  changedFiles: string[];
  artifacts: Array<{ uri: string; name: string; mimeType: string }>;
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

async function readJsonArtifact(client: Client, uri: string): Promise<Record<string, unknown>> {
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content)) {
    throw new Error('Expected a JSON text resource');
  }
  return JSON.parse(content.text) as Record<string, unknown>;
}

describe('autonomous MCP rewrite workflows', () => {
  it('discovers one-call writers and applies focus, GUI, and map changes without transaction calls', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-autonomous-'));
    const fixtureRoots = path.join(repositoryRoot, 'fixtures', 'map', 'roots');
    const game = path.join(temporary, 'game');
    const dependency = path.join(temporary, 'dependency');
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    await Promise.all([
      cp(path.join(fixtureRoots, 'game'), game, { recursive: true }),
      cp(path.join(fixtureRoots, 'dependency'), dependency, { recursive: true }),
      cp(path.join(fixtureRoots, 'mod'), mod, { recursive: true }),
    ]);

    const focusRelativePath = 'common/national_focus/autonomous.txt';
    const focusPath = path.join(mod, ...focusRelativePath.split('/'));
    const focusSource = [
      'focus_tree = {',
      '\tid = autonomous_tree',
      '\tdefault = yes',
      '\tfocus = {',
      '\t\tid = autonomous_root',
      '\t\tx = 0',
      '\t\ty = 0',
      '\t\tcost = 5',
      '\t\tcompletion_reward = { add_political_power = 10 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    await mkdir(path.dirname(focusPath), { recursive: true });
    await writeFile(focusPath, focusSource, 'utf8');

    const guiRelativePath = 'interface/autonomous.gui';
    const guiPath = path.join(mod, ...guiRelativePath.split('/'));
    const guiSource = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "autonomous_window"',
      '\t\tposition = { x = 10 y = 10 }',
      '\t\tsize = { width = 120 height = 80 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    await mkdir(path.dirname(guiPath), { recursive: true });
    await writeFile(guiPath, guiSource, 'utf8');

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      storageRoots: [runtime],
      workspaces: [
        {
          id: 'autonomous',
          name: 'Autonomous synthetic workflow',
          root: mod,
          gameRoot: game,
          dependencyRoots: [dependency],
          artifactRoot: path.join(runtime, 'artifacts'),
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'autonomous-workflow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const tools = await client.listTools();
    const toolNames = tools.tools.map(({ name }) => name);
    expect(toolNames).toEqual([
      'hoi4.mods',
      'hoi4.focus_inspect',
      'hoi4.focus_render',
      'hoi4.focus_rewrite',
      'hoi4.gui_inspect',
      'hoi4.gui_render',
      'hoi4.gui_rewrite',
      'hoi4.map_inspect',
      'hoi4.map_render',
      'hoi4.map_rewrite',
    ]);
    for (const name of ['hoi4.focus_rewrite', 'hoi4.gui_rewrite', 'hoi4.map_rewrite']) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    await expect(client.listPrompts()).rejects.toThrow(/Method not found/iu);

    const scannedFocus = resultOf(
      await client.callTool({
        name: 'hoi4.focus_inspect',
        arguments: { workspaceId: 'autonomous', relativePath: focusRelativePath },
      }),
    );
    const focusInventoryLink = scannedFocus.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    expect(focusInventoryLink).toBeDefined();
    const focusInventory = await readJsonArtifact(client, focusInventoryLink!.uri);
    const plan = (focusInventory.plans as Array<Record<string, unknown>>)[0]!;
    const focuses = plan.focuses as Array<Record<string, unknown>>;
    focuses[0]!.cost = 6;
    const rewrittenFocus = resultOf(
      await client.callTool({
        name: 'hoi4.focus_rewrite',
        arguments: { workspaceId: 'autonomous', relativePath: focusRelativePath, plan },
      }),
    );
    expect(rewrittenFocus).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    expect(rewrittenFocus).not.toHaveProperty('transactionId');
    expect(rewrittenFocus).not.toHaveProperty('planHash');
    expect(rewrittenFocus).not.toHaveProperty('rollbackStatus');
    expect(rewrittenFocus.artifacts.length).toBeGreaterThan(0);
    const executionValidationLink = rewrittenFocus.artifacts.find(({ name }) =>
      name.endsWith('.execution-validation.json'),
    );
    expect(executionValidationLink).toBeDefined();
    const executionValidation = await readJsonArtifact(client, executionValidationLink!.uri);
    expect(executionValidation).not.toHaveProperty('transactionId');
    expect(executionValidation).not.toHaveProperty('planHash');
    expect(executionValidation).toMatchObject({
      execution: 'post-validation-passed',
      validation: {
        passed: true,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'post-write-shared-index', passed: true }),
          expect.objectContaining({ id: 'post-write-focus', passed: true }),
        ]),
      },
    });
    expect(rewrittenFocus.changedFiles).toEqual(
      expect.arrayContaining([
        focusRelativePath,
        'common/national_focus/autonomous.focus-plan.json',
      ]),
    );
    expect(await readFile(focusPath, 'utf8')).toContain('\t\tcost = 6');

    const appliedFocusBytes = await readFile(focusPath);
    const rescannedFocus = resultOf(
      await client.callTool({
        name: 'hoi4.focus_inspect',
        arguments: { workspaceId: 'autonomous', relativePath: focusRelativePath },
      }),
    );
    const rescannedInventoryLink = rescannedFocus.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    const rescannedInventory = await readJsonArtifact(client, rescannedInventoryLink!.uri);
    const blockedPlan = (rescannedInventory.plans as Array<Record<string, unknown>>)[0]!;
    const unchangedFocus = resultOf(
      await client.callTool({
        name: 'hoi4.focus_rewrite',
        arguments: {
          workspaceId: 'autonomous',
          relativePath: focusRelativePath,
          plan: structuredClone(blockedPlan),
        },
      }),
    );
    expect(unchangedFocus).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_UNCHANGED',
      data: { execution: 'unchanged' },
      changedFiles: [],
    });
    expect(await readFile(focusPath)).toEqual(appliedFocusBytes);
    const blockedFocuses = blockedPlan.focuses as Array<Record<string, unknown>>;
    blockedFocuses[0]!.prerequisites = {
      operator: 'and',
      groups: [
        {
          operator: 'or',
          focusIds: ['missing_autonomous_prerequisite'],
          rawPassthrough: [],
        },
      ],
    };
    const blockedRewrite = resultOf(
      await client.callTool({
        name: 'hoi4.focus_rewrite',
        arguments: {
          workspaceId: 'autonomous',
          relativePath: focusRelativePath,
          plan: blockedPlan,
        },
      }),
    );
    expect(blockedRewrite).toMatchObject({
      status: 'blocked',
      code: 'FOCUS_CHANGES_BLOCKED',
      data: { execution: 'blocked' },
    });
    expect(blockedRewrite).not.toHaveProperty('transactionId');
    expect(blockedRewrite).not.toHaveProperty('planHash');
    expect(await readFile(focusPath)).toEqual(appliedFocusBytes);

    const rewrittenGui = resultOf(
      await client.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'patches',
          workspaceId: 'autonomous',
          relativePath: guiRelativePath,
          windowName: 'autonomous_window',
          scenario: { id: 'autonomous', resolution: { width: 640, height: 360 } },
          expectedSourceHash: sha256Bytes(Buffer.from(guiSource, 'utf8')),
          patches: [
            {
              start: guiSource.indexOf('x = 10'),
              end: guiSource.indexOf('x = 10') + 'x = 10'.length,
              expectedText: 'x = 10',
              text: 'x = 24',
              description: 'Move the autonomous test window',
            },
          ],
        },
      }),
    );
    expect(rewrittenGui).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    expect(await readFile(guiPath, 'utf8')).toContain('x = 24');
    const unchangedGuiSource = guiSource.replace('x = 10', 'x = 24');
    const unchangedGui = resultOf(
      await client.callTool({
        name: 'hoi4.gui_rewrite',
        arguments: {
          mode: 'patches',
          workspaceId: 'autonomous',
          relativePath: guiRelativePath,
          windowName: 'autonomous_window',
          scenario: { id: 'autonomous', resolution: { width: 640, height: 360 } },
          expectedSourceHash: sha256Bytes(Buffer.from(unchangedGuiSource, 'utf8')),
          patches: [
            {
              start: unchangedGuiSource.indexOf('x = 24'),
              end: unchangedGuiSource.indexOf('x = 24') + 'x = 24'.length,
              expectedText: 'x = 24',
              text: 'x = 24',
              description: 'Confirm an already satisfied GUI patch is a no-op',
            },
          ],
        },
      }),
    );
    expect(unchangedGui).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_UNCHANGED',
      data: { execution: 'unchanged' },
      changedFiles: [],
    });

    const statePath = path.join(mod, 'history', 'states', '5-MOD.txt');
    expect(await readFile(statePath, 'utf8')).toContain('manpower = 50');
    const rewrittenMap = resultOf(
      await client.callTool({
        name: 'hoi4.map_rewrite',
        arguments: {
          workspaceId: 'autonomous',
          operations: [
            {
              id: 'autonomous-update-state',
              kind: 'update_state',
              stateId: 5,
              changes: { manpower: 60 },
            },
          ],
        },
      }),
    );
    expect(rewrittenMap).toMatchObject({
      status: 'ok',
      code: 'MAP_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    expect(await readFile(statePath, 'utf8')).toContain('manpower = 60');
    const unchangedMap = resultOf(
      await client.callTool({
        name: 'hoi4.map_rewrite',
        arguments: {
          workspaceId: 'autonomous',
          operations: [
            {
              id: 'autonomous-update-state-noop',
              kind: 'update_state',
              stateId: 5,
              changes: { manpower: 60 },
            },
          ],
        },
      }),
    );
    expect(unchangedMap).toMatchObject({
      status: 'ok',
      code: 'MAP_CHANGES_UNCHANGED',
      data: { execution: 'unchanged' },
      changedFiles: [],
    });
  }, 120_000);

  it('restores exact source bytes when autonomous post-write validation fails', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-autonomous-recovery-'));
    const mod = path.join(temporary, 'mod');
    const relativePath = 'common/national_focus/recovery.txt';
    const sourcePath = path.join(mod, ...relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const original = Buffer.from(
      ['focus_tree = {', '\tid = recovery_tree', '\tdefault = yes', '}', ''].join('\n'),
      'utf8',
    );
    await writeFile(sourcePath, original);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      workspaces: [
        {
          id: 'recovery',
          name: 'Autonomous recovery fixture',
          root: mod,
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const planned = await engine.transactions.plan({
      workspaceId: 'recovery',
      operationKind: 'focus-plan-changes',
      operations: [
        {
          id: 'force-post-validation-failure',
          kind: 'replace-focus-tree',
          summary: 'Exercise autonomous recovery',
          data: {},
        },
      ],
      changes: [
        {
          relativePath,
          content: Buffer.from('focus_tree = {\n', 'utf8'),
          operationIds: ['force-post-validation-failure'],
          mediaType: 'text/plain',
        },
      ],
      validate: () =>
        Promise.resolve({
          diagnostics: [],
          checks: [
            {
              id: 'synthetic-preflight',
              passed: true,
              message: 'Synthetic preflight intentionally permits post-validation exercise',
            },
          ],
        }),
    });

    let failure: unknown;
    try {
      await executePlannedTransaction(engine, planned);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'REWRITE_POST_VALIDATION_FAILED',
      details: {
        execution: 'failed',
        automaticRecovery: 'restored',
      },
    });
    const publicFailure = errorResult(
      failure,
      'recovery',
      autonomousFailureContext(failure),
    ).structuredContent;
    expect(publicFailure).toMatchObject({
      status: 'error',
      code: 'REWRITE_POST_VALIDATION_FAILED',
      workspaceId: 'recovery',
      changedFiles: [],
      blockers: [
        expect.objectContaining({
          details: expect.objectContaining({ automaticRecovery: 'restored' }),
        }),
      ],
    });
    expect(publicFailure).not.toHaveProperty('rollbackStatus');
    expect(await readFile(sourcePath)).toEqual(original);
    await expect(
      engine.transactions.status('recovery', planned.transactionId),
    ).resolves.toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
    });
    const incompleteRecovery = failure as AutonomousRewriteError;
    incompleteRecovery.manifest.state = 'failed';
    incompleteRecovery.manifest.rollbackStatus = 'failed';
    incompleteRecovery.manifest.appliedFiles = [];
    expect(autonomousFailureContext(incompleteRecovery)?.changedFiles).toEqual([relativePath]);
  });
});

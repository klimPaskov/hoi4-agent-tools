import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { FocusWorkbench } from '../../src/hoi4_agent_tools/focus/index.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

interface OperationResult {
  status: 'ok' | 'blocked' | 'error';
  code: string;
  changedFiles: string[];
  artifacts: Array<{ uri: string; name: string; mimeType: string }>;
  data: Record<string, unknown>;
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

function resultOf(value: Awaited<ReturnType<Client['callTool']>>): OperationResult {
  return value.structuredContent as unknown as OperationResult;
}

describe('large public focus workflow', () => {
  it('creates, inspects, and renders a 255-focus mixed-route tree through MCP', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-large-focus-'));
    const mod = path.join(temporary, 'mod');
    await cp(path.join(repositoryRoot, 'fixtures', 'focus', 'workspace'), mod, { recursive: true });
    await rm(path.join(mod, 'common', 'national_focus'), { recursive: true, force: true });
    await mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true });

    const plan = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'fixtures', 'focus', 'plans', 'synthetic_acceptance.plan.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    plan.provenance = {
      sourcePath: 'plan:synthetic_acceptance_tree',
      sourceHash: '0'.repeat(64),
      importedPlanHash: '0'.repeat(64),
    };

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      workspaces: [{ id: 'large-focus', name: 'Large focus fixture', root: mod }],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'large-focus-workflow', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const relativePath = 'common/national_focus/synthetic_acceptance.txt';
    const rewriteProgress: string[] = [];
    let rewriteResponse: Awaited<ReturnType<Client['callTool']>>;
    try {
      rewriteResponse = await client.callTool(
        {
          name: 'hoi4.focus_rewrite',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            plan,
            createIfMissing: true,
          },
        },
        undefined,
        {
          timeout: 60_000,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: 60_000,
          onprogress: ({ message }) => {
            if (message !== undefined) rewriteProgress.push(message);
          },
        },
      );
    } catch (error) {
      throw new Error(`Large focus rewrite failed after: ${rewriteProgress.join(' -> ')}`, {
        cause: error,
      });
    }
    const rewritten = resultOf(rewriteResponse);
    expect(rewritten).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_APPLIED',
      data: { execution: 'applied', created: true, treeId: 'synthetic_acceptance_tree' },
    });
    expect(rewritten.changedFiles).toEqual(
      expect.arrayContaining([
        relativePath,
        'common/national_focus/synthetic_acceptance.focus-plan.json',
      ]),
    );
    const source = await readFile(path.join(mod, ...relativePath.split('/')), 'utf8');
    expect(source.match(/^\s*focus\s*=\s*\{/gmu)).toHaveLength(255);

    const layoutSpy = vi.spyOn(FocusWorkbench.prototype, 'layoutAsync');
    const compacted = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_rewrite',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            treeId: 'synthetic_acceptance_tree',
            layoutMode: 'compact',
          },
        },
        undefined,
        { timeout: 180_000, resetTimeoutOnProgress: true, maxTotalTimeout: 180_000 },
      ),
    );
    expect(compacted).toMatchObject({
      status: 'ok',
      code: expect.stringMatching(/^FOCUS_CHANGES_(?:APPLIED|UNCHANGED)$/u),
      data: { treeId: 'synthetic_acceptance_tree' },
    });
    expect(layoutSpy).not.toHaveBeenCalled();
    layoutSpy.mockRestore();
    const compactSource = await readFile(path.join(mod, ...relativePath.split('/')));
    const compactSidecarPath = path.join(
      mod,
      ...relativePath.replace(/\.txt$/u, '.focus-plan.json').split('/'),
    );
    const compactSidecar = await readFile(compactSidecarPath);
    const repeatedCompact = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_rewrite',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            treeId: 'synthetic_acceptance_tree',
            layoutMode: 'compact',
          },
        },
        undefined,
        { timeout: 180_000, resetTimeoutOnProgress: true, maxTotalTimeout: 180_000 },
      ),
    );
    expect(repeatedCompact).toMatchObject({ status: 'ok', code: 'FOCUS_CHANGES_UNCHANGED' });
    expect(await readFile(path.join(mod, ...relativePath.split('/')))).toEqual(compactSource);
    expect(await readFile(compactSidecarPath)).toEqual(compactSidecar);

    const inspected = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_inspect',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            treeId: 'synthetic_acceptance_tree',
          },
        },
        undefined,
        { timeout: 180_000, resetTimeoutOnProgress: true, maxTotalTimeout: 180_000 },
      ),
    );
    expect(inspected).toMatchObject({
      status: 'ok',
      code: 'FOCUS_INSPECTED',
      data: { treeCount: 1 },
    });

    const rendered = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_render',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            treeId: 'synthetic_acceptance_tree',
          },
        },
        undefined,
        { timeout: 180_000, resetTimeoutOnProgress: true, maxTotalTimeout: 180_000 },
      ),
    );
    expect(rendered).toMatchObject({
      status: 'ok',
      code: 'FOCUS_RENDERED',
      data: { treeId: 'synthetic_acceptance_tree' },
    });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['text/html', 'image/svg+xml', 'image/png', 'application/json']),
    );
  }, 180_000);
});

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function authoredPlan(focusCount: number): Record<string, unknown> {
  const columns = 32;
  const rows = Math.ceil(focusCount / columns);
  const pad = (value: number): string => String(value).padStart(4, '0');
  const idAt = (index: number): string => `massive_focus_${pad(index)}`;
  const focusIds = Array.from({ length: focusCount }, (_unused, index) => idAt(index));
  const laneId = (column: number): string => `massive_lane_${String(column).padStart(2, '0')}`;
  return {
    schemaVersion: 1,
    id: 'massive_agent_tree',
    default: true,
    branchGroups: Array.from({ length: columns }, (_unused, column) => ({
      id: laneId(column),
      label: `Massive lane ${column + 1}`,
      family: 'scale-regression',
      focusIds: focusIds.filter((_id, index) => index % columns === column),
      laneId: laneId(column),
      major: false,
      hidden: false,
      crisis: false,
      conditional: false,
      aiStrategyIds: [],
    })),
    laneGroups: Array.from({ length: columns }, (_unused, column) => ({
      id: laneId(column),
      label: `Massive lane ${column + 1}`,
      order: column,
      minimumX: column * 2,
      maximumX: column * 2,
    })),
    entryFocusIds: focusIds.slice(0, columns),
    focuses: focusIds.map((id, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const terminal = row === rows - 1 || index + columns >= focusCount;
      return {
        id,
        label: `Massive focus ${index + 1}`,
        branchId: laneId(column),
        laneId: laneId(column),
        prerequisites: {
          operator: 'and',
          groups:
            row === 0
              ? []
              : [
                  {
                    operator: 'or',
                    focusIds: [idAt(index - columns)],
                    rawPassthrough: [],
                  },
                ],
        },
        mutuallyExclusive: [],
        routeLocks: [],
        position: { mode: 'fixed', x: column * 2, y: row, pinned: true },
        visibility: 'normal',
        convergence: false,
        sharedSupport: false,
        icons: [{ kind: 'static', sprite: 'GFX_synthetic_focus' }],
        localisation: {
          titleKey: 'synthetic_root',
          descriptionKey: 'synthetic_root_desc',
          workingLabel: `Massive focus ${index + 1}`,
        },
        ai: {
          raw: { text: '{ factor = 10 }', referencedFocusIds: [] },
          majorRoute: false,
          strategyIds: [],
        },
        filters: ['FOCUS_FILTER_POLITICAL'],
        links: [],
        cost: 10,
        completionReward: {
          text: `{ add_political_power = ${index + 1} }`,
          referencedFocusIds: [],
        },
        ...(terminal
          ? { payoff: `Massive lane ${column + 1} capstone`, terminalKind: 'capstone' }
          : {}),
        rawPassthrough: [],
      };
    }),
    sharedFocusIds: [],
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    rawPassthrough: [],
    provenance: {
      sourcePath: 'plan:massive_agent_tree',
      sourceHash: '0'.repeat(64),
      importedPlanHash: '0'.repeat(64),
    },
  };
}

describe('large public focus workflow', () => {
  it('inspects, renders, and rasterizes a 1,024-icon tree through the public MCP tools', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-many-icon-focus-'));
    const mod = path.join(temporary, 'mod');
    const focusDirectory = path.join(mod, 'common', 'national_focus');
    const textureDirectory = path.join(mod, 'gfx', 'interface');
    await Promise.all([
      mkdir(focusDirectory, { recursive: true }),
      mkdir(textureDirectory, { recursive: true }),
      mkdir(path.join(mod, 'interface'), { recursive: true }),
    ]);
    const focusCount = 1_024;
    const columns = 32;
    const pad = (value: number): string => String(value).padStart(4, '0');
    const focusSource = [
      'focus_tree = {',
      '\tid = many_icon_tree',
      '\tcountry = { factor = 0 }',
      ...Array.from({ length: focusCount }, (_, index) => [
        '\tfocus = {',
        `\t\tid = many_icon_${pad(index)}`,
        `\t\ticon = GFX_many_icon_${pad(index)}`,
        `\t\tx = ${(index % columns) * 2}`,
        `\t\ty = ${Math.floor(index / columns)}`,
        '\t\tcost = 10',
        '\t}',
      ]).flat(),
      '}',
      '',
    ].join('\n');
    const gfxSource = [
      'spriteTypes = {',
      ...Array.from({ length: focusCount }, (_, index) => [
        '\tspriteType = {',
        `\t\tname = "GFX_many_icon_${pad(index)}"`,
        `\t\ttexturefile = "gfx/interface/many_icon_${pad(index)}.png"`,
        '\t}',
      ]).flat(),
      '}',
      '',
    ].join('\n');
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const relativePath = 'common/national_focus/many_icon_tree.txt';
    await Promise.all([
      writeFile(path.join(mod, ...relativePath.split('/')), focusSource),
      writeFile(path.join(mod, 'interface', 'many_icon_tree.gfx'), gfxSource),
      ...Array.from({ length: focusCount }, (_, index) =>
        writeFile(path.join(textureDirectory, `many_icon_${pad(index)}.png`), onePixelPng),
      ),
    ]);

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      workspaces: [{ id: 'many-icons', name: 'Many icon focus fixture', root: mod }],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'many-icon-focus-workflow', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const inspected = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'many-icons', relativePath, treeId: 'many_icon_tree' },
        },
        undefined,
        { timeout: 30_000, resetTimeoutOnProgress: true, maxTotalTimeout: 30_000 },
      ),
    );
    expect(inspected).toMatchObject({
      status: 'ok',
      code: 'FOCUS_INSPECTED',
      data: { treeCount: 1, trees: [expect.objectContaining({ focusCount })] },
    });

    const rendered = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_render',
          arguments: { workspaceId: 'many-icons', relativePath, treeId: 'many_icon_tree' },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
      ),
    );
    expect(rendered).toMatchObject({ status: 'ok', code: 'FOCUS_RENDERED' });
    expect(rendered.artifacts.some(({ mimeType }) => mimeType === 'image/png')).toBe(false);

    const rasterized = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_raster',
          arguments: { workspaceId: 'many-icons', relativePath, treeId: 'many_icon_tree' },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
      ),
    );
    expect(rasterized).toMatchObject({ status: 'ok', code: 'FOCUS_RASTERIZED' });
    expect(rasterized.artifacts.some(({ mimeType }) => mimeType === 'image/png')).toBe(true);
  }, 300_000);

  it('creates, compacts, inspects, renders, and rasterizes a 1,024-focus tree through MCP', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-large-focus-'));
    const mod = path.join(temporary, 'mod');
    await cp(path.join(repositoryRoot, 'fixtures', 'focus', 'workspace'), mod, { recursive: true });
    await rm(path.join(mod, 'common', 'national_focus'), { recursive: true, force: true });
    await mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true });

    const focusCount = 1_024;
    const plan = authoredPlan(focusCount);

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

    const relativePath = 'common/national_focus/massive_agent_tree.txt';
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
          timeout: 300_000,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: 300_000,
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
      data: { execution: 'applied', created: true, treeId: 'massive_agent_tree' },
    });
    expect(rewritten.changedFiles).toEqual(
      expect.arrayContaining([
        relativePath,
        'common/national_focus/massive_agent_tree.focus-plan.json',
      ]),
    );
    const source = await readFile(path.join(mod, ...relativePath.split('/')), 'utf8');
    expect(source.match(/^\s*focus\s*=\s*\{/gmu)).toHaveLength(focusCount);

    const layoutSpy = vi.spyOn(FocusWorkbench.prototype, 'layoutAsync');
    const compacted = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_rewrite',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            treeId: 'massive_agent_tree',
            layoutMode: 'compact',
          },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
      ),
    );
    expect(compacted).toMatchObject({
      status: 'ok',
      code: expect.stringMatching(/^FOCUS_CHANGES_(?:APPLIED|UNCHANGED)$/u),
      data: { treeId: 'massive_agent_tree' },
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
            treeId: 'massive_agent_tree',
            layoutMode: 'compact',
          },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
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
            treeId: 'massive_agent_tree',
          },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
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
            treeId: 'massive_agent_tree',
          },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
      ),
    );
    expect(rendered).toMatchObject({
      status: 'ok',
      code: 'FOCUS_RENDERED',
      data: { treeId: 'massive_agent_tree' },
    });
    expect(rendered.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['text/html', 'image/svg+xml', 'application/json']),
    );
    expect(rendered.artifacts.some(({ mimeType }) => mimeType === 'image/png')).toBe(false);
    const rasterized = resultOf(
      await client.callTool(
        {
          name: 'hoi4.focus_raster',
          arguments: {
            workspaceId: 'large-focus',
            relativePath,
            treeId: 'massive_agent_tree',
          },
        },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 },
      ),
    );
    expect(rasterized).toMatchObject({
      status: 'ok',
      code: 'FOCUS_RASTERIZED',
      data: { treeId: 'massive_agent_tree' },
    });
    expect(rasterized.artifacts.map(({ mimeType }) => mimeType)).toEqual(
      expect.arrayContaining(['text/html', 'image/svg+xml', 'image/png', 'application/json']),
    );
  }, 300_000);
});

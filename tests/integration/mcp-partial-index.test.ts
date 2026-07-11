import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SOURCE_TOKEN_LIMIT } from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

describe('MCP partial shared-index inventory', () => {
  it('returns an ok partial project scan and a bounded completeness resource', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-mcp-partial-index-'));
    const mod = path.join(temporary, 'mod');
    const artifactRoot = path.join(temporary, 'artifacts');
    const cacheRoot = path.join(temporary, 'cache');
    const limitedPath = path.join(mod, 'interface', 'partial.gfx');
    const focusPath = path.join(mod, 'common', 'national_focus', 'partial.txt');
    await mkdir(path.dirname(limitedPath), { recursive: true });
    await mkdir(path.dirname(focusPath), { recursive: true });
    await writeFile(
      limitedPath,
      `spriteTypes = { spriteType = { name = GFX_partial } }\n${'value = yes '.repeat(
        Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1,
      )}`,
    );
    await writeFile(
      focusPath,
      'focus_tree = { id = partial_tree focus = { id = partial_focus icon = GFX_partial } }\n',
    );

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [artifactRoot, cacheRoot],
      workspaces: [
        {
          id: 'partial',
          name: 'Partial inventory fixture',
          root: mod,
          artifactRoot,
          cacheRoot,
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'partial-index-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const response = await client.callTool({
      name: 'hoi4.project_scan',
      arguments: { workspaceId: 'partial' },
    });
    const result = response.structuredContent as {
      status: string;
      code: string;
      diagnostics: Array<{ code: string; severity: string }>;
      artifacts: Array<{ uri: string }>;
      validation: { passed: boolean };
      data: {
        complete: boolean;
        skippedSourceCount: number;
        skippedSources: Array<{ path: string; reasonCodes: string[] }>;
      };
    };
    expect(result).toMatchObject({
      status: 'ok',
      code: 'WORKSPACE_SCANNED_PARTIAL',
      validation: { passed: true },
      data: {
        complete: false,
        skippedSourceCount: 1,
        skippedSources: [
          {
            path: 'mod:interface/partial.gfx',
            reasonCodes: ['SOURCE_TOKEN_LIMIT'],
          },
        ],
      },
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INDEX_SOURCE_SKIPPED_LIMIT', severity: 'warning' }),
        expect.objectContaining({
          code: 'INDEX_UNRESOLVED_REFERENCE_PARTIAL',
          severity: 'warning',
        }),
      ]),
    );
    expect(result.diagnostics.some(({ severity }) => severity === 'error')).toBe(false);
    expect(result.artifacts).toHaveLength(1);

    const resource = await client.readResource({ uri: result.artifacts[0]!.uri });
    const content = resource.contents[0];
    expect(content).toHaveProperty('text');
    if (content === undefined || !('text' in content)) throw new Error('Expected JSON artifact');
    const inventory = JSON.parse(content.text) as Record<string, unknown>;
    expect(inventory).toMatchObject({
      complete: false,
      skippedSourceCount: 1,
      skippedSources: [{ path: 'mod:interface/partial.gfx', reasonCodes: ['SOURCE_TOKEN_LIMIT'] }],
    });

    for (const [tool, expectedCode] of [
      ['hoi4.focus_scan', 'FOCUS_SCANNED'],
      ['hoi4.focus_lint', 'FOCUS_LINTED'],
    ] as const) {
      const focusResponse = await client.callTool({
        name: tool,
        arguments: {
          workspaceId: 'partial',
          relativePath: 'common/national_focus/partial.txt',
          ...(tool === 'hoi4.focus_lint' ? { treeId: 'partial_tree' } : {}),
        },
      });
      const focusResult = focusResponse.structuredContent as {
        code: string;
        diagnostics: Array<{ code: string; severity: string }>;
        validation: { passed: boolean };
      };
      expect(focusResult).toMatchObject({ code: expectedCode, validation: { passed: true } });
      expect(focusResult.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'FOCUS_ICON_REFERENCE_PARTIAL',
            severity: 'warning',
          }),
        ]),
      );
      expect(
        focusResult.diagnostics.some(({ code }) => code === 'FOCUS_ICON_REFERENCE_MISSING'),
      ).toBe(false);
      expect(focusResult.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'FOCUS_LOCALISATION_REFERENCE_MISSING',
            severity: 'warning',
          }),
        ]),
      );
      expect(
        focusResult.diagnostics.some(({ code }) => code === 'FOCUS_LOCALISATION_REFERENCE_PARTIAL'),
      ).toBe(false);
    }

    const guiResponse = await client.callTool({
      name: 'hoi4.gui_scan',
      arguments: { workspaceId: 'partial' },
    });
    const guiResult = guiResponse.structuredContent as {
      status: string;
      code: string;
      diagnostics: Array<{ code: string; severity: string }>;
      artifacts: Array<{ uri: string }>;
      validation: { passed: boolean };
      data: {
        complete: boolean;
        skippedSourceCount: number;
        skippedSources: Array<{ path: string; reasonCodes: string[] }>;
      };
    };
    expect(guiResult).toMatchObject({
      status: 'ok',
      code: 'GUI_SCANNED_PARTIAL',
      validation: { passed: true },
      data: {
        complete: false,
        skippedSourceCount: 1,
        skippedSources: [
          {
            path: 'mod:interface/partial.gfx',
            reasonCodes: ['SOURCE_TOKEN_LIMIT'],
          },
        ],
      },
    });
    expect(guiResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'GUI_INVENTORY_PARTIAL', severity: 'warning' }),
      ]),
    );
    expect(guiResult.diagnostics.some(({ severity }) => severity === 'error')).toBe(false);

    const guiResource = await client.readResource({ uri: guiResult.artifacts[0]!.uri });
    const guiContent = guiResource.contents[0];
    expect(guiContent).toHaveProperty('text');
    if (guiContent === undefined || !('text' in guiContent))
      throw new Error('Expected GUI JSON artifact');
    const guiInventory = JSON.parse(guiContent.text) as Record<string, unknown>;
    expect(guiInventory).toMatchObject({
      graph: {
        complete: false,
        skippedSourceCount: 1,
        skippedSources: [
          { path: 'mod:interface/partial.gfx', reasonCodes: ['SOURCE_TOKEN_LIMIT'] },
        ],
      },
    });
  });

  it('returns a deterministic blocker for a parser-capped active default.map selector', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-mcp-map-selector-'));
    const mod = path.join(temporary, 'mod');
    const artifactRoot = path.join(temporary, 'artifacts');
    const cacheRoot = path.join(temporary, 'cache');
    const selectorPath = path.join(mod, 'map', 'default.map');
    await mkdir(path.dirname(selectorPath), { recursive: true });
    await writeFile(
      selectorPath,
      `${'value = yes '.repeat(Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1)}\nprovinces = "selected-provinces.bmp"\n`,
    );

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [artifactRoot, cacheRoot],
      workspaces: [
        {
          id: 'blocked-map-selector',
          name: 'Blocked map selector fixture',
          root: mod,
          artifactRoot,
          cacheRoot,
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'map-selector-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const response = await client.callTool({
      name: 'hoi4.map_scan',
      arguments: { workspaceId: 'blocked-map-selector' },
    });
    const result = response.structuredContent as {
      status: string;
      code: string;
      filesScanned: string[];
      blockers: Array<{ code: string; details: Record<string, unknown> }>;
      validation: { passed: boolean };
    };
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'MAP_DEFAULT_MAP_SELECTOR_BLOCKED',
      filesScanned: [],
      validation: { passed: false },
      blockers: [
        {
          code: 'MAP_DEFAULT_MAP_SELECTOR_BLOCKED',
          details: {
            path: 'mod:map/default.map',
            relativePath: 'map/default.map',
            rootKind: 'mod',
            reasonCodes: ['SOURCE_MISSING_VALUE', 'SOURCE_TOKEN_LIMIT'],
          },
        },
      ],
    });
  });
});

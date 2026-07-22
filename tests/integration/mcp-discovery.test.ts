import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  createMcpServer,
  SERVER_INSTRUCTIONS,
} from '../../src/hoi4_agent_tools/mcp/server/create.js';
import type { ServerContext } from '../../src/hoi4_agent_tools/mcp/server/base-tools.js';

const close: Array<() => Promise<void>> = [];
const toolsListByteBudget = 32_768;
const singleToolByteBudget = 8_192;
const toolInputSchemaByteBudget = 6_144;
const toolOutputSchemaByteBudget = 2_048;
const toolDescriptionByteBudget = 512;
const resourceTemplateListByteBudget = 2_048;
afterEach(async () => Promise.all(close.splice(0).map((callback) => callback())));

async function connected(context: ServerContext = {}, workspaceIds: readonly string[] = ['test']) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-mcp-'));
  await Promise.all(workspaceIds.map((id) => mkdir(path.join(root, id))));
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: workspaceIds.map((id) => ({ id, name: id, root: path.join(root, id) })),
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(config));
  const server = createMcpServer(engine, context);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  close.push(
    async () => client.close(),
    async () => server.close(),
  );
  return client;
}

describe('MCP discovery', () => {
  it('exposes exactly the focused creation and cleanup surface', async () => {
    const client = await connected();
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      'hoi4.focus_inspect',
      'hoi4.focus_render',
      'hoi4.focus_raster',
      'hoi4.focus_rewrite',
      'hoi4.gui_inspect',
      'hoi4.gui_render',
      'hoi4.gui_rewrite',
      'hoi4.map_inspect',
      'hoi4.map_render',
      'hoi4.map_rewrite',
      'hoi4.event_inspect',
      'hoi4.event_render',
      'hoi4.event_compare',
      'hoi4.tech_inspect',
      'hoi4.tech_render',
      'hoi4.tech_compare',
    ]);

    for (const name of [
      'hoi4.focus_inspect',
      'hoi4.focus_render',
      'hoi4.focus_raster',
      'hoi4.gui_inspect',
      'hoi4.gui_render',
      'hoi4.map_inspect',
      'hoi4.map_render',
    ]) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of [
      'hoi4.event_inspect',
      'hoi4.event_render',
      'hoi4.event_compare',
      'hoi4.tech_inspect',
      'hoi4.tech_render',
      'hoi4.tech_compare',
    ]) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of ['hoi4.focus_rewrite', 'hoi4.gui_rewrite', 'hoi4.map_rewrite']) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }

    const focusInspect = tools.tools.find(({ name }) => name === 'hoi4.focus_inspect');
    expect(JSON.stringify(focusInspect?.inputSchema)).toContain('previous');
    expect(JSON.stringify(focusInspect?.inputSchema)).toContain('laneSpacing');
    expect(JSON.stringify(focusInspect?.inputSchema)).toContain('nodeSpacing');
    const guiInspect = tools.tools.find(({ name }) => name === 'hoi4.gui_inspect');
    expect(JSON.stringify(guiInspect?.inputSchema)).toContain('relatedScenarios');
    const guiRewrite = tools.tools.find(({ name }) => name === 'hoi4.gui_rewrite');
    expect(JSON.stringify(guiRewrite?.inputSchema)).toContain('additionalFiles');
    expect(guiRewrite?.description).toContain('binary art');
    const mapInspect = tools.tools.find(({ name }) => name === 'hoi4.map_inspect');
    expect(JSON.stringify(mapInspect?.inputSchema)).toContain('allocationRequests');
    expect(JSON.stringify(mapInspect?.inputSchema)).toContain('provinceIds');
    const eventInspect = tools.tools.find(({ name }) => name === 'hoi4.event_inspect');
    expect(JSON.stringify(eventInspect?.inputSchema)).toContain('explain_path');
    expect(JSON.stringify(eventInspect?.inputSchema)).toContain('state_flow');
    expect(JSON.stringify(eventInspect?.inputSchema)).toContain('impactSubject');

    for (const tool of tools.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { enum: ['ok', 'blocked', 'error'] },
          diagnostics: { type: 'array', maxItems: 20 },
          artifacts: { type: 'array', maxItems: 32 },
          data: { type: 'object' },
        },
      });
      expect(Buffer.byteLength(JSON.stringify(tool.outputSchema), 'utf8')).toBeLessThanOrEqual(
        2_048,
      );
      expect(JSON.stringify(tool.outputSchema)).not.toContain('transactionId');
      expect(JSON.stringify(tool.outputSchema)).not.toContain('planHash');
      expect(JSON.stringify(tool.outputSchema)).not.toContain('rollbackStatus');
    }

    for (const name of [
      'hoi4.focus_inspect',
      'hoi4.focus_render',
      'hoi4.focus_raster',
      'hoi4.focus_rewrite',
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(JSON.stringify(tool?.inputSchema)).toContain('continuous');
      expect(JSON.stringify(tool?.inputSchema)).toContain('national');
    }

    expect((await client.listResources()).resources).toEqual([]);
    const resourceTemplates = (await client.listResourceTemplates()).resourceTemplates;
    expect(resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual([
      'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}',
    ]);
    expect(resourceTemplates[0]).toMatchObject({
      description: expect.stringContaining('byte offset'),
      _meta: {
        'io.github.klimpaskov/hoi4-agent-tools.artifact-byte-range': {
          version: 1,
          unit: 'byte',
          maxChunkSize: 1_048_576,
          selectors: {
            offset: { type: 'integer', minimum: 0, default: 0 },
            length: {
              type: 'integer',
              minimum: 1,
              maximum: 1_048_576,
              default: 1_048_576,
            },
          },
        },
      },
    });
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await expect(client.listPrompts()).rejects.toThrow(/Method not found/iu);
  });

  it('resolves omitted workspace IDs to the sole configured mod', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'hoi4.gui_inspect', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      workspaceId: 'test',
    });
  });

  it('keeps discovery metadata within fixed context budgets', async () => {
    const client = await connected();
    const tools = await client.listTools();
    expect(Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBeLessThanOrEqual(
      toolsListByteBudget,
    );
    for (const tool of tools.tools) {
      expect(Buffer.byteLength(JSON.stringify(tool), 'utf8'), tool.name).toBeLessThanOrEqual(
        singleToolByteBudget,
      );
      expect(
        Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8'),
        `${tool.name} input schema`,
      ).toBeLessThanOrEqual(toolInputSchemaByteBudget);
      expect(
        Buffer.byteLength(JSON.stringify(tool.outputSchema), 'utf8'),
        `${tool.name} output schema`,
      ).toBeLessThanOrEqual(toolOutputSchemaByteBudget);
      expect(
        Buffer.byteLength(tool.description ?? '', 'utf8'),
        `${tool.name} description`,
      ).toBeLessThanOrEqual(toolDescriptionByteBudget);
    }
    expect(
      Buffer.byteLength(JSON.stringify(await client.listResourceTemplates()), 'utf8'),
    ).toBeLessThanOrEqual(resourceTemplateListByteBudget);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('retains exact nested validation behind compact discovery fields', async () => {
    const client = await connected();
    const tools = await client.listTools();
    const focusRewrite = tools.tools.find(({ name }) => name === 'hoi4.focus_rewrite');
    const guiInspect = tools.tools.find(({ name }) => name === 'hoi4.gui_inspect');
    const mapRewrite = tools.tools.find(({ name }) => name === 'hoi4.map_rewrite');
    const eventInspect = tools.tools.find(({ name }) => name === 'hoi4.event_inspect');

    expect(JSON.stringify(focusRewrite?.inputSchema)).not.toContain('completionReward');
    expect(JSON.stringify(guiInspect?.inputSchema)).not.toContain('animationTimeSeconds');
    expect(JSON.stringify(mapRewrite?.inputSchema)).not.toContain('move_state_provinces');
    expect(JSON.stringify(eventInspect?.inputSchema)).not.toContain('eventId');
    const invalidFocus = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: {
        workspaceId: 'test',
        relativePath: 'common/national_focus/test.txt',
        plan: {},
      },
    });
    expect(invalidFocus).toMatchObject({ isError: true });
    expect(JSON.stringify(invalidFocus.content)).toMatch(/Input validation error/iu);
    const invalidGui = await client.callTool({
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: 'test', windowName: 'window', scenario: {} },
    });
    expect(invalidGui).toMatchObject({ isError: true });
    expect(JSON.stringify(invalidGui.content)).toMatch(/Input validation error/iu);
    const invalidMap = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        operations: [{ id: 'invalid', kind: 'not-a-map-operation' }],
      },
    });
    expect(invalidMap).toMatchObject({ isError: true });
    expect(JSON.stringify(invalidMap.content)).toMatch(/Input validation error/iu);
    const invalidEvent = await client.callTool({
      name: 'hoi4.event_inspect',
      arguments: { workspaceId: 'test', mode: 'trace' },
    });
    expect(invalidEvent).toMatchObject({ isError: true });
    expect(JSON.stringify(invalidEvent.content)).toMatch(/Input validation error/iu);
    const invalidEventSelector = await client.callTool({
      name: 'hoi4.event_inspect',
      arguments: {
        workspaceId: 'test',
        mode: 'trace',
        selector: { kind: 'event', eventId: 4, unknown: true },
      },
    });
    expect(invalidEventSelector).toMatchObject({ isError: true });
    expect(JSON.stringify(invalidEventSelector.content)).toMatch(/Input validation error/iu);
  });

  it('emits progress and honors cancellation for GUI inspection', async () => {
    const client = await connected();
    const progress: number[] = [];
    const inspection = await client.callTool(
      { name: 'hoi4.gui_inspect', arguments: { workspaceId: 'test' } },
      undefined,
      { onprogress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([0, 3]);
    const artifacts = (
      inspection.structuredContent as { artifacts: Array<Record<string, unknown>> }
    ).artifacts;
    expect(artifacts.every((artifact) => !('path' in artifact))).toBe(true);

    const controller = new AbortController();
    await expect(
      client.callTool({ name: 'hoi4.gui_inspect', arguments: { workspaceId: 'test' } }, undefined, {
        signal: controller.signal,
        onprogress: () => controller.abort(),
      }),
    ).rejects.toThrow(/abort/iu);
  });

  it('serves large binary artifacts through bounded resource chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-large-resource-'));
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const config = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'large', name: 'Large', root: mod }],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(config));
    const workspace = engine.resolver.get('large');
    const bytes = Buffer.allocUnsafe(2_200_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const artifact = await engine.artifacts.put(
      workspace,
      'large-proof.bin',
      'application/octet-stream',
      bytes,
      {
        kind: 'large-resource-acceptance',
        toolVersion: '1.0.0',
        schemaVersion: 'large-resource.v1',
        sourceHashes: {},
      },
    );
    const server = createMcpServer(engine);
    const client = new Client({ name: 'large-resource-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    close.push(
      async () => client.close(),
      async () => server.close(),
    );

    const offset = 777_777;
    const resource = await client.readResource({
      uri: `${artifact.uri}?offset=${offset}&length=1048576`,
    });
    const content = resource.contents[0];
    expect(content).toBeDefined();
    if (content === undefined || !('blob' in content)) return;
    const chunk = Buffer.from(content.blob, 'base64');
    expect(chunk).toHaveLength(1_048_576);
    expect(chunk).toEqual(bytes.subarray(offset, offset + 1_048_576));

    await expect(client.readResource({ uri: `${artifact.uri}?length=9999999` })).rejects.toThrow(
      /byte range/u,
    );

    for (const query of [
      'length=NaN',
      'length=Infinity',
      'length=9007199254740992',
      'length=0',
      'offset=NaN',
      'offset=-1',
    ]) {
      await expect(client.readResource({ uri: `${artifact.uri}?${query}` })).rejects.toThrow();
    }
  });
});

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
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import type { ServerContext } from '../../src/hoi4_agent_tools/mcp/server/base-tools.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(close.splice(0).map((callback) => callback())));

function strictObjectLeaves(schema: unknown): Array<Record<string, unknown>> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const object = schema as Record<string, unknown>;
  if (object.type === 'object') return [object];
  return ['anyOf', 'oneOf', 'allOf'].flatMap((key) => {
    const children = object[key];
    return Array.isArray(children) ? children.flatMap(strictObjectLeaves) : [];
  });
}

async function connected(context: ServerContext = {}, workspaceIds: readonly string[] = ['test']) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-mcp-'));
  await Promise.all(workspaceIds.map((id) => mkdir(path.join(root, id))));
  const config = serverConfigurationSchema.parse({
    version: 1,
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
  it('discovers strict tools, resources, templates, and safe prompts', async () => {
    const client = await connected();
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'hoi4.project_register',
        'hoi4.project_scan',
        'hoi4.project_status',
        'hoi4.focus_scan',
        'hoi4.focus_lint',
        'hoi4.focus_layout',
        'hoi4.focus_render',
        'hoi4.focus_plan_changes',
        'hoi4.gui_scan',
        'hoi4.gui_lint',
        'hoi4.gui_render',
        'hoi4.gui_render_states',
        'hoi4.gui_compare',
        'hoi4.gui_plan_changes',
        'hoi4.map_scan',
        'hoi4.map_inspect',
        'hoi4.map_allocate',
        'hoi4.map_plan',
        'hoi4.map_render',
        'hoi4.map_validate',
        'hoi4.transaction_diff',
        'hoi4.transaction_apply',
        'hoi4.transaction_rollback',
        'hoi4.artifact_list',
      ]),
    );
    const apply = tools.tools.find(({ name }) => name === 'hoi4.transaction_apply');
    expect(apply?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    for (const toolName of [
      'hoi4.project_scan',
      'hoi4.focus_scan',
      'hoi4.focus_lint',
      'hoi4.focus_layout',
      'hoi4.focus_render',
      'hoi4.gui_scan',
      'hoi4.gui_lint',
      'hoi4.gui_render',
      'hoi4.gui_render_states',
      'hoi4.gui_compare',
      'hoi4.map_scan',
      'hoi4.map_inspect',
      'hoi4.map_allocate',
      'hoi4.map_render',
      'hoi4.map_validate',
    ]) {
      expect(
        tools.tools.find(({ name }) => name === toolName)?.annotations,
        toolName,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const toolName of [
      'hoi4.project_status',
      'hoi4.transaction_status',
      'hoi4.transaction_diff',
      'hoi4.artifact_list',
      'hoi4.artifact_describe',
    ]) {
      expect(
        tools.tools.find(({ name }) => name === toolName)?.annotations,
        toolName,
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    const focusLayout = tools.tools.find(({ name }) => name === 'hoi4.focus_layout');
    expect(focusLayout?.description).toContain('position.mode "auto"');
    const focusPlanChanges = tools.tools.find(({ name }) => name === 'hoi4.focus_plan_changes');
    expect(focusPlanChanges?.description).toContain('createIfMissing: true');
    for (const kind of ['moved_for_mutual_exclusion', 'moved_to_reduce_crossings']) {
      expect(JSON.stringify(focusLayout?.inputSchema)).toContain(kind);
      expect(JSON.stringify(focusLayout?.outputSchema)).toContain(kind);
    }
    for (const tool of tools.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const outputSchema = tool.outputSchema as
        { properties?: { data?: { anyOf?: Array<Record<string, unknown>> } } } | undefined;
      const dataVariants = outputSchema?.properties?.data?.anyOf;
      expect(dataVariants, `${tool.name} must advertise exact success/error data`).toHaveLength(2);
      expect(dataVariants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'object', additionalProperties: false }),
        ]),
      );
      const dataLeaves = dataVariants?.flatMap(strictObjectLeaves) ?? [];
      expect(
        dataLeaves.every(
          (variant) => variant.type === 'object' && variant.additionalProperties === false,
        ),
        `${tool.name} data variants must reject unknown fields`,
      ).toBe(true);
      expect(
        dataLeaves.length,
        `${tool.name} must expose concrete data object variants`,
      ).toBeGreaterThanOrEqual(2);
    }
    for (const toolName of ['hoi4.focus_lint', 'hoi4.focus_render', 'hoi4.focus_plan_changes']) {
      const tool = tools.tools.find(({ name }) => name === toolName);
      const inputSchema = tool?.inputSchema as { required?: string[] } | undefined;
      expect(JSON.stringify(inputSchema), `${toolName} must discover continuous mode`).toContain(
        'continuous',
      );
      expect(JSON.stringify(inputSchema), `${toolName} must preserve national mode`).toContain(
        'national',
      );
      expect(inputSchema?.required ?? []).not.toContain('mode');
      expect(
        JSON.stringify(tool?.outputSchema),
        `${toolName} must type both output modes`,
      ).toContain('continuous');
    }
    const resources = await client.listResources();
    expect(resources.resources.map(({ uri }) => uri)).toContain(
      'hoi4-agent://workspace/test/summary',
    );
    expect(resources.resources.map(({ uri }) => uri)).toEqual(
      expect.arrayContaining([
        'hoi4-agent://docs/agent-integration',
        'hoi4-agent://docs/security',
        'hoi4-agent://schema/continuous-focus-palette',
        'hoi4-agent://schema/focus-planning-sidecar',
        'hoi4-agent://schema/transaction-manifest',
      ]),
    );
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual(
      expect.arrayContaining([
        'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}',
        'hoi4-agent://workspace/{workspaceId}/transaction/{transactionId}',
        'hoi4-agent://docs/{name}',
        'hoi4-agent://schema/{name}',
      ]),
    );
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'hoi4.safe-focus-workflow',
        'hoi4.safe-gui-workflow',
        'hoi4.safe-map-workflow',
      ]),
    );
    const focusPrompt = await client.getPrompt({
      name: 'hoi4.safe-focus-workflow',
      arguments: { workspaceId: 'test' },
    });
    const focusPromptText = focusPrompt.messages
      .map(({ content }) => ('text' in content ? content.text : ''))
      .join('\n');
    expect(focusPromptText).toContain('continuous focus palette');
    expect(focusPromptText).toContain('mode "continuous"');
    expect(focusPromptText).toContain('bitmap comparison');
    expect(focusPromptText).toContain('every transaction_diff nextCursor');
    expect(focusPromptText).toContain(
      'preserve prerequisites, exclusions, rewards, and raw blocks',
    );
    expect(focusPromptText).toContain('position.mode "auto"');
    expect(focusPromptText).toContain('createIfMissing: true');
    expect(focusPromptText).toContain("coding-agent host's configured write and approval policy");
    expect(focusPromptText).not.toContain('ask for approval');
    const agentGuide = await client.readResource({ uri: 'hoi4-agent://docs/agent-integration' });
    expect(agentGuide.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect('text' in agentGuide.contents[0]!).toBe(true);
    expect('text' in agentGuide.contents[0]! ? agentGuide.contents[0].text : '').toContain(
      'Autonomous selection rules',
    );
    const schema = await client.readResource({ uri: 'hoi4-agent://schema/focus-plan' });
    expect(schema.contents[0]).toMatchObject({ mimeType: 'application/schema+json' });
    expect(JSON.parse('text' in schema.contents[0]! ? schema.contents[0].text : '')).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('returns the shared structured result envelope', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'hoi4.project_status',
      arguments: { workspaceId: 'test' },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      code: 'WORKSPACE_STATUS',
      workspaceId: 'test',
      filesScanned: [],
      proposedFiles: [],
      changedFiles: [],
    });
  });

  it('pages workspace status without constructing an aggregate unbounded response', async () => {
    const client = await connected({}, ['alpha', 'beta']);
    const first = await client.callTool({ name: 'hoi4.project_status', arguments: {} });
    const firstData = (first.structuredContent as { data: Record<string, unknown> }).data as {
      count: number;
      returned: number;
      workspaces: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstData).toMatchObject({
      count: 2,
      returned: 1,
      workspaces: [{ id: 'alpha' }],
      nextCursor: expect.any(String),
    });
    const second = await client.callTool({
      name: 'hoi4.project_status',
      arguments: { cursor: firstData.nextCursor },
    });
    expect((second.structuredContent as { data: unknown }).data).toMatchObject({
      count: 2,
      returned: 1,
      workspaces: [{ id: 'beta' }],
    });
  });

  it('emits monotonic progress and honors protocol cancellation', async () => {
    const client = await connected();
    const progress: number[] = [];
    const scan = await client.callTool(
      { name: 'hoi4.project_scan', arguments: { workspaceId: 'test' } },
      undefined,
      { onprogress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([0, 2, 3]);
    const scanArtifacts = (scan.structuredContent as { artifacts: Array<Record<string, unknown>> })
      .artifacts;
    expect(scanArtifacts.every((artifact) => !('path' in artifact))).toBe(true);

    const controller = new AbortController();
    await expect(
      client.callTool(
        { name: 'hoi4.project_scan', arguments: { workspaceId: 'test' } },
        undefined,
        {
          signal: controller.signal,
          onprogress: () => controller.abort(),
        },
      ),
    ).rejects.toThrow(/abort/iu);
  });

  it('requires an explicit write scope for remote registration and apply handlers', async () => {
    const client = await connected({ scopes: ['hoi4:read'] });
    const registration = await client.callTool({
      name: 'hoi4.project_register',
      arguments: { id: 'denied', name: 'Denied', root: 'C:/denied' },
    });
    expect(registration.structuredContent).toMatchObject({
      status: 'error',
      code: 'AUTH_SCOPE_REQUIRED',
    });
    const apply = await client.callTool({
      name: 'hoi4.transaction_apply',
      arguments: {
        workspaceId: 'test',
        transactionId: 'txn_00000000-0000-4000-8000-000000000000',
        expectedPlanHash: '0'.repeat(64),
      },
    });
    expect(apply.structuredContent).toMatchObject({
      status: 'error',
      code: 'AUTH_SCOPE_REQUIRED',
    });
  });

  it('serves large binary artifacts through bounded resource chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-large-resource-'));
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const config = serverConfigurationSchema.parse({
      version: 1,
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
        toolVersion: '0.1.0',
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
      uri: `${artifact.uri}?offset=${offset}&length=9999999`,
    });
    const content = resource.contents[0];
    expect(content).toBeDefined();
    if (content === undefined || !('blob' in content)) return;
    const chunk = Buffer.from(content.blob, 'base64');
    expect(chunk).toHaveLength(1_048_576);
    expect(chunk).toEqual(bytes.subarray(offset, offset + 1_048_576));

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

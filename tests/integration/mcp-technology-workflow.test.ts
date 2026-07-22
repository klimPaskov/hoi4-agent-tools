import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import type { ServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixtureWorkspace = path.join(repositoryRoot, 'fixtures', 'technology', 'workspace');
let temporaryRoot: string;
let copiedWorkspace: string;
let server: ReturnType<typeof createMcpServer>;
let client: Client;

function resultOf(
  value: Awaited<ReturnType<Client['callTool']>>,
): ServiceResult<Record<string, unknown>> {
  return value.structuredContent as unknown as ServiceResult<Record<string, unknown>>;
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-mcp-technology-'));
  copiedWorkspace = path.join(temporaryRoot, 'mod');
  await cp(fixtureWorkspace, copiedWorkspace, { recursive: true });
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporaryRoot, 'state'),
    storageRoots: [path.join(temporaryRoot, 'runtime')],
    workspaces: [
      {
        id: 'technology_workflow',
        name: 'Technology MCP workflow',
        root: copiedWorkspace,
        artifactRoot: path.join(temporaryRoot, 'runtime', 'artifacts'),
        cacheRoot: path.join(temporaryRoot, 'runtime', 'cache'),
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  server = createMcpServer(engine);
  client = new Client({ name: 'technology-workflow-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('MCP Technology Tree Viewer workflow', () => {
  it('runs every inspection mode plus render and compare against a 500+ tree', async () => {
    const original = await readFile(
      path.join(copiedWorkspace, 'common', 'technologies', 'synthetic_technologies_01.txt'),
      'utf8',
    );
    const calls: Array<{ name: string; arguments: Record<string, unknown>; code: string }> = [
      { name: 'hoi4.tech_inspect', arguments: { mode: 'scan' }, code: 'TECH_INSPECTED' },
      {
        name: 'hoi4.tech_inspect',
        arguments: { mode: 'folders', folderId: 'synthetic_folder_01' },
        code: 'TECH_INSPECTED',
      },
      {
        name: 'hoi4.tech_inspect',
        arguments: {
          mode: 'trace',
          technologyId: 'synthetic_tech_0039',
          direction: 'prerequisites',
          maxNodes: 1_000,
        },
        code: 'TECH_INSPECTED',
      },
      {
        name: 'hoi4.tech_inspect',
        arguments: { mode: 'explain', technologyId: 'synthetic_tech_0003' },
        code: 'TECH_INSPECTED',
      },
      {
        name: 'hoi4.tech_inspect',
        arguments: { mode: 'unlocks', technologyId: 'synthetic_tech_0003' },
        code: 'TECH_INSPECTED',
      },
      {
        name: 'hoi4.tech_inspect',
        arguments: { mode: 'bonus_coverage', categoryId: 'synthetic_category_04' },
        code: 'TECH_INSPECTED',
      },
      {
        name: 'hoi4.tech_inspect',
        arguments: { mode: 'lint', classifications: ['confirmed_error'] },
        code: 'TECH_INSPECTED',
      },
      {
        name: 'hoi4.tech_render',
        arguments: { view: 'folder', folderId: 'synthetic_folder_01', includeHtml: true },
        code: 'TECH_RENDERED',
      },
      {
        name: 'hoi4.tech_compare',
        arguments: {
          proposedSources: [
            {
              relativePath: 'common/technologies/synthetic_technologies_01.txt',
              source: original.replace('synthetic_tech_0008 = {', 'synthetic_tech_renamed = {'),
            },
          ],
          render: true,
        },
        code: 'TECH_COMPARED',
      },
      {
        name: 'hoi4.tech_inspect',
        arguments: {
          mode: 'impact',
          impact: {
            kind: 'technology',
            id: 'synthetic_tech_0004',
            operation: 'rename',
            replacementId: 'synthetic_tech_renamed',
          },
        },
        code: 'TECH_INSPECTED',
      },
    ];
    for (const call of calls) {
      const response = resultOf(
        await client.callTool({
          name: call.name,
          arguments: { workspaceId: 'technology_workflow', ...call.arguments },
        }),
      );
      expect(response.status, call.name).toBe('ok');
      expect(response.code, call.name).toBe(call.code);
      expect(response.changedFiles, call.name).toEqual([]);
      expect(response.proposedFiles, call.name).toEqual([]);
      expect(response.artifacts.length, call.name).toBeGreaterThan(0);
      const first = await client.readResource({ uri: response.artifacts[0]!.uri });
      expect(first.contents[0], call.name).toBeDefined();
    }
    expect(
      await readFile(
        path.join(copiedWorkspace, 'common', 'technologies', 'synthetic_technologies_01.txt'),
        'utf8',
      ),
    ).toBe(original);
  }, 120_000);
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import type { ServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

function resultOf(
  value: Awaited<ReturnType<Client['callTool']>>,
): ServiceResult<Record<string, unknown>> {
  return value.structuredContent as unknown as ServiceResult<Record<string, unknown>>;
}

async function jsonArtifact(client: Client, result: ServiceResult<Record<string, unknown>>) {
  const artifact = result.artifacts.find(({ mimeType }) => mimeType === 'application/json');
  if (artifact === undefined) throw new Error(`Expected JSON evidence from ${result.code}`);
  const resource = await client.readResource({ uri: artifact.uri });
  const content = resource.contents[0];
  if (content === undefined || !('text' in content)) throw new Error('Expected JSON text evidence');
  return JSON.parse(content.text) as Record<string, unknown>;
}

const initialEvents = `add_namespace = agent

country_event = {
	id = agent.1
	title = agent.1.t
	is_triggered_only = yes
	immediate = {
		set_country_flag = agent_chain_started
	}
	option = {
		name = agent.1.a
		country_event = { id = agent.2 days = 1 }
	}
}

country_event = {
	id = agent.2
	title = agent.2.t
	is_triggered_only = yes
	option = {
		name = agent.2.a
		set_variable = { agent_chain_stage = 2 }
	}
}
`;

describe('MCP Event Chain Viewer workflow', () => {
  it('inspects, traces, renders, and compares without editing event source', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-event-workflow-'));
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    const eventRelativePath = 'events/agent-chain.txt';
    const eventPath = path.join(mod, ...eventRelativePath.split('/'));
    await Promise.all([
      mkdir(path.dirname(eventPath), { recursive: true }),
      mkdir(path.join(mod, 'common', 'on_actions'), { recursive: true }),
      mkdir(path.join(mod, 'localisation', 'english'), { recursive: true }),
      mkdir(runtime, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(eventPath, initialEvents, 'utf8'),
      writeFile(
        path.join(mod, 'common', 'on_actions', 'agent-chain.txt'),
        `on_actions = {
	on_startup = {
		effect = { country_event = { id = agent.1 } }
	}
}
`,
        'utf8',
      ),
      writeFile(
        path.join(mod, 'localisation', 'english', 'agent_chain_l_english.yml'),
        `\ufeffl_english:
agent.1.t: "First Event"
agent.1.a: "Continue"
agent.2.t: "Second Event"
agent.2.a: "Finish"
`,
        'utf8',
      ),
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      storageRoots: [runtime],
      workspaces: [
        {
          id: 'event-workflow',
          name: 'Event workflow',
          root: mod,
          artifactRoot: path.join(runtime, 'artifacts'),
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const server = createMcpServer(engine);
    const client = new Client({ name: 'event-workflow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
    );

    const progress: number[] = [];
    const scanned = resultOf(
      await client.callTool(
        {
          name: 'hoi4.event_inspect',
          arguments: { workspaceId: 'event-workflow', mode: 'scan' },
        },
        undefined,
        { onprogress: ({ progress: value }) => progress.push(value) },
      ),
    );
    expect(scanned).toMatchObject({
      status: 'ok',
      code: 'EVENT_INSPECTED',
      changedFiles: [],
      proposedFiles: [],
      data: {
        mode: 'scan',
        counts: { events: 2 },
      },
    });
    expect(progress).toEqual([0, 2, 3]);
    const scanEvidence = await jsonArtifact(client, scanned);
    expect(scanEvidence).toMatchObject({ mode: 'scan' });

    const traced = resultOf(
      await client.callTool({
        name: 'hoi4.event_inspect',
        arguments: {
          workspaceId: 'event-workflow',
          mode: 'trace',
          selector: { kind: 'event', eventId: 'agent.1' },
          direction: 'downstream',
          maxDepth: 4,
        },
      }),
    );
    expect(traced).toMatchObject({
      status: 'ok',
      code: 'EVENT_INSPECTED',
      changedFiles: [],
      data: { mode: 'trace', boundary: { direction: 'downstream', maxDepth: 4 } },
    });

    const rendered = resultOf(
      await client.callTool({
        name: 'hoi4.event_render',
        arguments: {
          workspaceId: 'event-workflow',
          view: 'overview',
          includeHtml: true,
        },
      }),
    );
    expect(rendered).toMatchObject({
      status: 'ok',
      code: 'EVENT_RENDERED',
      changedFiles: [],
      data: { view: 'overview', boundary: { includeHtml: true } },
    });
    expect(new Set(rendered.artifacts.map(({ mimeType }) => mimeType))).toEqual(
      new Set(['application/json', 'image/svg+xml', 'image/png', 'text/html']),
    );

    const proposedEvents = `${initialEvents}
country_event = {
	id = agent.3
	title = agent.3.t
	is_triggered_only = yes
	option = { name = agent.3.a }
}
`;
    const compared = resultOf(
      await client.callTool({
        name: 'hoi4.event_compare',
        arguments: {
          workspaceId: 'event-workflow',
          proposedSources: [{ relativePath: eventRelativePath, source: proposedEvents }],
          render: true,
        },
      }),
    );
    expect(compared).toMatchObject({
      status: 'ok',
      code: 'EVENT_COMPARED',
      changedFiles: [],
      proposedFiles: [],
      data: {
        counts: { addedNodes: expect.any(Number), changes: expect.any(Number) },
        boundary: { proposedSources: 1, render: true },
      },
    });
    expect((compared.data.counts as { addedNodes: number }).addedNodes).toBeGreaterThan(0);
    expect((compared.data.counts as { changes: number }).changes).toBeGreaterThan(0);
    expect(await readFile(eventPath, 'utf8')).toBe(initialEvents);

    await writeFile(eventPath, proposedEvents, 'utf8');
    const intentionallyCachedComparison = resultOf(
      await client.callTool({
        name: 'hoi4.event_compare',
        arguments: {
          workspaceId: 'event-workflow',
          before: { revision: scanned.data.revision },
          render: false,
          refresh: false,
        },
      }),
    );
    expect(intentionallyCachedComparison).toMatchObject({
      status: 'ok',
      code: 'EVENT_COMPARED',
      data: { counts: { changes: 0 }, boundary: { refresh: false } },
    });

    const comparedAfterAgentEdit = resultOf(
      await client.callTool({
        name: 'hoi4.event_compare',
        arguments: {
          workspaceId: 'event-workflow',
          before: { revision: scanned.data.revision },
          render: false,
        },
      }),
    );
    expect(comparedAfterAgentEdit).toMatchObject({
      status: 'ok',
      code: 'EVENT_COMPARED',
      data: {
        counts: { addedNodes: expect.any(Number), changes: expect.any(Number) },
        boundary: { refresh: true },
      },
    });
    expect(
      (comparedAfterAgentEdit.data.counts as { addedNodes: number }).addedNodes,
    ).toBeGreaterThan(0);
    expect((comparedAfterAgentEdit.data.counts as { changes: number }).changes).toBeGreaterThan(0);

    const manyBranchEvents = `add_namespace = branch\n\n${Array.from(
      { length: 12 },
      (_, index) => `country_event = {
\tid = branch.${index + 1}
\ttitle = branch.${index + 1}.t
\tis_triggered_only = no
\toption = { name = branch.${index + 1}.a }
}`,
    ).join('\n\n')}\n`;
    await writeFile(eventPath, manyBranchEvents, 'utf8');
    const largeRendered = resultOf(
      await client.callTool({
        name: 'hoi4.event_render',
        arguments: {
          workspaceId: 'event-workflow',
          view: 'overview',
          maxNodes: 1,
          includeHtml: false,
          refresh: true,
        },
      }),
    );
    expect(largeRendered).toMatchObject({
      status: 'ok',
      code: expect.stringMatching(/^EVENT_RENDERED/u),
      data: { counts: { branchRenders: expect.any(Number) } },
    });
    const manifestLink = largeRendered.artifacts.find(({ name }) => name.includes('-manifest.'));
    expect(manifestLink).toBeDefined();
    const manifestResource = await client.readResource({ uri: manifestLink!.uri });
    const manifestContent = manifestResource.contents[0];
    if (manifestContent === undefined || !('text' in manifestContent)) {
      throw new Error('Expected render manifest JSON text');
    }
    const renderManifest = JSON.parse(manifestContent.text) as {
      resources: {
        branches: unknown[];
        artifacts: Array<{
          uri: string;
          name: string;
          mimeType: string;
          sha256?: string;
        }>;
      };
    };
    expect(renderManifest.resources.branches.length).toBeGreaterThan(10);
    expect(renderManifest.resources.artifacts.length).toBeGreaterThan(32);
    expect(largeRendered.artifacts.length).toBeLessThan(
      renderManifest.resources.artifacts.length + 1,
    );
    expect(new Set(renderManifest.resources.artifacts.map(({ uri }) => uri)).size).toBe(
      renderManifest.resources.artifacts.length,
    );
    for (const artifact of renderManifest.resources.artifacts) {
      const resource = await client.readResource({ uri: artifact.uri });
      const content = resource.contents[0];
      expect(content?.mimeType).toBe(artifact.mimeType);
      if (content === undefined) throw new Error(`Missing ${artifact.name}`);
      const bytes =
        'text' in content ? Buffer.from(content.text, 'utf8') : Buffer.from(content.blob, 'base64');
      expect(bytes.length, artifact.name).toBeGreaterThan(0);
      expect(sha256Bytes(bytes), artifact.name).toBe(artifact.sha256);
    }
  }, 60_000);
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

async function treeSnapshot(root: string, current = root): Promise<Record<string, string>> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const rows: Array<[string, string]> = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) rows.push(...Object.entries(await treeSnapshot(root, absolute)));
    else if (entry.isFile())
      rows.push([
        path.relative(root, absolute).replaceAll('\\', '/'),
        (await readFile(absolute)).toString('base64'),
      ]);
  }
  return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right, 'en-US')));
}

async function resourceBytes(client: Client, uri: string): Promise<Buffer> {
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content === undefined || !('blob' in content))
    throw new Error(`Expected binary resource ${uri}`);
  return Buffer.from(content.blob, 'base64');
}

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

async function connected(): Promise<{ client: Client; mod: string }> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-probability-mcp-'));
  const mod = path.join(temporary, 'mod');
  const runtime = path.join(temporary, 'runtime');
  await Promise.all([mkdir(mod, { recursive: true }), mkdir(runtime, { recursive: true })]);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    storageRoots: [runtime],
    workspaces: [
      {
        id: 'probability-mcp',
        name: 'Probability MCP fixture',
        root: mod,
        artifactRoot: path.join(runtime, 'artifacts'),
        cacheRoot: path.join(runtime, 'cache'),
      },
    ],
  });
  const server = createMcpServer(new CoreEngine(await WorkspaceResolver.create(configuration)));
  const client = new Client({ name: 'probability-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
    async () => rm(temporary, { recursive: true, force: true }),
  );
  return { client, mod };
}

describe('probability MCP workflow', () => {
  it('evaluates proposed weighted source and serves authoritative JSON plus deterministic visuals', async () => {
    const { client } = await connected();
    const evaluated = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'event_option_ai_chance',
        source: {
          inlineClausewitz: `country_event = {
 id = mcp.1
 option = { name = mcp.1.a ai_chance = { base = 1 } }
 option = { name = mcp.1.b ai_chance = { base = 4 } }
}`,
        },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'mcp-scenarios',
          scenarios: [{ id: 'baseline', state: {} }],
        },
        outputs: ['json', 'ranking'],
      },
    });
    expect(evaluated.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_ANALYZED',
      workspaceId: 'probability-mcp',
      data: {
        operation: 'evaluate',
        analysisStatus: 'complete',
        adapterId: 'event_option_ai_chance',
        scenarios: 1,
        candidates: 2,
        visualResources: 2,
      },
    });
    const structured = evaluated.structuredContent as {
      artifacts: Array<{ uri: string; mimeType: string }>;
      data: { analysisId: string };
    };
    const jsonArtifact = structured.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    expect(jsonArtifact).toBeDefined();
    const resource = await client.readResource({ uri: jsonArtifact!.uri });
    const text = resource.contents[0];
    expect(text).toBeDefined();
    if (text === undefined || !('text' in text)) return;
    const result = JSON.parse(text.text) as {
      scenarios: Array<{ candidates: Array<{ conditionalProbability: number }> }>;
    };
    expect(
      result.scenarios[0]?.candidates.map(({ conditionalProbability }) => conditionalProbability),
    ).toEqual([0.2, 0.8]);

    const rendered = await client.callTool({
      name: 'hoi4.probability_render',
      arguments: {
        analysisId: structured.data.analysisId,
        outputs: ['matrix', 'waterfall', 'threshold'],
        filter: { metrics: ['conditional_probability'] },
      },
    });
    expect(rendered.structuredContent).toMatchObject({
      status: 'ok',
      data: { operation: 'render', visualResources: 6 },
    });

    const repeated = await client.callTool({
      name: 'hoi4.probability_render',
      arguments: {
        analysisId: structured.data.analysisId,
        outputs: ['matrix', 'waterfall', 'threshold'],
        filter: { metrics: ['conditional_probability'] },
      },
    });
    const firstPng = (
      rendered.structuredContent as { artifacts: Array<{ uri: string; name: string }> }
    ).artifacts.find(({ name }) => name.endsWith('matrix.png'));
    const secondPng = (
      repeated.structuredContent as { artifacts: Array<{ uri: string; name: string }> }
    ).artifacts.find(({ name }) => name.endsWith('matrix.png'));
    expect(firstPng).toBeDefined();
    expect(secondPng).toBeDefined();
    const [firstRaster, secondRaster] = await Promise.all([
      sharp(await resourceBytes(client, firstPng!.uri))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(await resourceBytes(client, secondPng!.uri))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    expect(secondRaster.info).toMatchObject({
      width: firstRaster.info.width,
      height: firstRaster.info.height,
      channels: firstRaster.info.channels,
    });
    expect(
      pixelmatch(
        firstRaster.data,
        secondRaster.data,
        undefined,
        firstRaster.info.width,
        firstRaster.info.height,
      ),
    ).toBe(0);
  });

  it('keeps every probability operation out of the mod source tree', async () => {
    const { client, mod } = await connected();
    const before = await treeSnapshot(mod);
    const source =
      'country_event = { id = readonly.1 option = { name = readonly.a ai_chance = { base = 1 } } option = { name = readonly.b ai_chance = { base = 2 } } }';
    const scenarioSet = {
      schemaVersion: '1.0',
      id: 'readonly',
      scenarios: [
        {
          id: 'range',
          state: {},
          uncertainInputs: [{ path: 'variable.pressure', range: { min: 0, max: 10 } }],
        },
      ],
    };
    await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: { adapter: 'event_option_ai_chance', source: { inlineClausewitz: source } },
    });
    const evaluated = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'event_option_ai_chance',
        source: { inlineClausewitz: source },
        scenarioSet,
      },
    });
    await client.callTool({
      name: 'hoi4.probability_sweep',
      arguments: {
        adapter: 'event_option_ai_chance',
        source: { inlineClausewitz: source },
        scenarioSet,
        sweep: { paths: ['variable.pressure'], steps: 2, pairwise: false, findRankReversals: true },
      },
    });
    await client.callTool({
      name: 'hoi4.probability_simulate',
      arguments: {
        adapter: 'event_option_ai_chance',
        source: { inlineClausewitz: source },
        scenarioSet,
        samples: 100,
        seed: 12,
        confidenceLevel: 0.95,
      },
    });
    await client.callTool({
      name: 'hoi4.probability_sequence',
      arguments: {
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'sequence',
          scenarios: [{ id: 'baseline', state: {} }],
        },
        customPoolManifest: {
          schemaVersion: '1.0',
          id: 'readonly-pool',
          selection: { mode: 'categorical_weighted', cadence: 'daily' },
          candidates: [{ id: 'only', weight: 1 }],
          transitions: [],
        },
        horizonDays: 1,
        maxSteps: 1,
        samples: 100,
        seed: 12,
        confidenceLevel: 0.95,
      },
    });
    await client.callTool({
      name: 'hoi4.probability_compare',
      arguments: {
        adapter: 'event_option_ai_chance',
        before: { inlineClausewitz: source },
        after: { inlineClausewitz: source.replace('base = 1', 'base = 3') },
        scenarioSet,
      },
    });
    const analysisId = (evaluated.structuredContent as { data: { analysisId: string } }).data
      .analysisId;
    await client.callTool({
      name: 'hoi4.probability_render',
      arguments: { analysisId, outputs: ['ranking'] },
    });
    expect(await treeSnapshot(mod)).toEqual(before);
  });

  it('refuses to render a cached claim after workspace source changes', async () => {
    const { client, mod } = await connected();
    const evaluated = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'direct_random',
        source: { inlineClausewitz: 'random = { chance = 50 }' },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'stale',
          scenarios: [{ id: 'baseline', state: {} }],
        },
      },
    });
    const analysisId = (evaluated.structuredContent as { data: { analysisId: string } }).data
      .analysisId;
    const scenarioStale = await client.callTool({
      name: 'hoi4.probability_render',
      arguments: {
        analysisId,
        expectedScenarioHash: '0'.repeat(64),
        outputs: ['ranking'],
      },
    });
    expect(scenarioStale.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SCENARIO_STALE',
      data: { operation: 'render', analysisStatus: 'stale', visualResources: 0 },
    });
    await mkdir(path.join(mod, 'events'), { recursive: true });
    await writeFile(
      path.join(mod, 'events', 'changed.txt'),
      'country_event = { id = changed.1 }\n',
    );
    const rendered = await client.callTool({
      name: 'hoi4.probability_render',
      arguments: { analysisId, outputs: ['ranking'] },
    });
    expect(rendered.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_ANALYSIS_STALE',
      data: { operation: 'render', analysisStatus: 'stale', visualResources: 0 },
    });
  });

  it('reports cancellation and rejects cross-workspace scenario declarations', async () => {
    const { client } = await connected();
    const mismatch = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'direct_random',
        source: { inlineClausewitz: 'random = { chance = 50 }' },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'wrong',
          workspaceId: 'another-workspace',
          scenarios: [{ id: 'baseline', state: {} }],
        },
      },
    });
    expect(mismatch.structuredContent).toMatchObject({
      status: 'error',
      code: 'PROBABILITY_SCENARIO_WORKSPACE_MISMATCH',
    });

    const controller = new AbortController();
    await expect(
      client.callTool(
        {
          name: 'hoi4.probability_simulate',
          arguments: {
            adapter: 'direct_random',
            source: { inlineClausewitz: 'random = { chance = 50 }' },
            scenarioSet: {
              schemaVersion: '1.0',
              id: 'cancel',
              scenarios: [{ id: 'baseline', state: {} }],
            },
            samples: 1_000_000,
            seed: 4,
            confidenceLevel: 0.95,
          },
        },
        undefined,
        { signal: controller.signal, onprogress: () => controller.abort() },
      ),
    ).rejects.toThrow(/abort/iu);
  });

  it('rejects malformed scenarios and undeclared sequence targets at the MCP boundary', async () => {
    const { client } = await connected();
    const malformed = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'direct_random',
        source: { inlineClausewitz: 'random = { chance = 50 }' },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'malformed',
          scenarios: [{ id: 'missing-state' }],
        },
      },
    });
    expect(malformed.isError).toBe(true);

    const invalidTarget = await client.callTool({
      name: 'hoi4.probability_sequence',
      arguments: {
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'invalid-target',
          scenarios: [{ id: 'baseline', state: {} }],
        },
        customPoolManifest: {
          schemaVersion: '1.0',
          id: 'invalid-target',
          selection: { mode: 'categorical_weighted', cadence: 'daily' },
          candidates: [{ id: 'known', weight: 1 }],
          transitions: [
            {
              when: 'true',
              actions: [{ operation: 'add', target: 'candidate.unknown.weight', value: 1 }],
            },
          ],
        },
        horizonDays: 1,
        maxSteps: 1,
        samples: 100,
        seed: 1,
        confidenceLevel: 0.95,
      },
    });
    expect(invalidTarget.isError).toBe(true);
  });
});

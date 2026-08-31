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
  it('evaluates and compares complete declared dynamic candidate pools', async () => {
    const { client } = await connected();
    const manifest = (secondWeight: number) => ({
      schemaVersion: '1.0',
      id: 'owner-action-pool',
      selection: { mode: 'categorical_weighted', cadence: 'daily' },
      state: { reserve_weight: 3 },
      candidates: [
        { id: 'advisor', weight: 'state.reserve_weight', eligibleWhen: 'state.can_advise == true' },
        { id: 'law', weight: secondWeight, eligibleWhen: 'state.can_change_law == true' },
        { id: 'command', weight: 2, eligibleWhen: 'state.at_war == true' },
      ],
      transitions: [],
    });
    const scenarioSet = {
      schemaVersion: '1.0',
      id: 'owner-actions',
      scenarios: [
        {
          id: 'all-valid',
          state: { can_advise: true, can_change_law: true, at_war: true },
        },
        {
          id: 'peace',
          state: { can_advise: true, can_change_law: true, at_war: false },
        },
      ],
    };
    const inspected = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: {
        adapter: 'custom_weighted_pool',
        customPoolManifest: manifest(5),
      },
    });
    expect(inspected.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SOURCE_INSPECTED',
      data: {
        adapterId: 'custom_weighted_pool',
        poolComplete: true,
        candidates: 3,
      },
    });
    const evaluated = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'custom_weighted_pool',
        customPoolManifest: manifest(5),
        scenarioSet,
      },
    });
    expect(evaluated.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_ANALYZED',
      data: {
        analysisStatus: 'complete',
        adapterId: 'custom_weighted_pool',
        candidates: 6,
      },
    });
    const artifact = (evaluated.structuredContent as { artifacts: Array<{ uri: string }> })
      .artifacts[0];
    expect(artifact).toBeDefined();
    const resource = await client.readResource({ uri: artifact!.uri });
    const content = resource.contents[0];
    expect(content !== undefined && 'text' in content).toBe(true);
    if (content === undefined || !('text' in content)) return;
    const json = JSON.parse(content.text) as {
      scenarios: Array<{
        id: string;
        poolComplete: boolean;
        candidates: Array<{ id: string; conditionalProbability: number; eligibility: string }>;
      }>;
    };
    expect(json.scenarios.find(({ id }) => id === 'all-valid')).toMatchObject({
      poolComplete: true,
      candidates: [
        { id: 'advisor', conditionalProbability: 0.3, eligibility: 'true' },
        { id: 'law', conditionalProbability: 0.5, eligibility: 'true' },
        { id: 'command', conditionalProbability: 0.2, eligibility: 'true' },
      ],
    });
    expect(json.scenarios.find(({ id }) => id === 'peace')?.candidates[2]).toMatchObject({
      id: 'command',
      conditionalProbability: 0,
      eligibility: 'false',
    });

    const compared = await client.callTool({
      name: 'hoi4.probability_compare',
      arguments: {
        adapter: 'custom_weighted_pool',
        beforeManifest: manifest(5),
        afterManifest: manifest(7),
        scenarioSet,
      },
    });
    expect(compared.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_ANALYZED',
      data: {
        operation: 'compare',
        analysisStatus: 'complete',
        adapterId: 'custom_weighted_pool',
      },
    });
  });

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

  it('accepts scoped FROM bindings and returns enumerated dynamic pools through MCP resources', async () => {
    const { client } = await connected();
    const evaluated = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'event_option_ai_chance',
        source: {
          inlineClausewitz:
            'country_event = { id = scoped.2 option = { name = scoped.2.a ai_chance = { base = 1 modifier = { factor = 3 FROM = { tag = FRA } } } } option = { name = scoped.2.b ai_chance = { base = 1 } } }',
        },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'scoped-mcp',
          scenarios: [
            {
              id: 'baseline',
              state: {},
              scopes: { FROM: { id: 'origin', actor: 'FRA', state: {} } },
              scopePools: [
                {
                  id: 'destination',
                  bindAs: 'FROM',
                  selection: 'uniform',
                  complete: true,
                  filter: { inlineClausewitz: 'FROM = { is_ai = yes }' },
                  candidates: [
                    { id: 'AAA', actor: 'AAA', state: { is_ai: true } },
                    { id: 'BBB', actor: 'BBB', state: { is_ai: false } },
                  ],
                },
              ],
            },
          ],
        },
        outputs: ['json'],
      },
    });
    expect(evaluated.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_ANALYZED',
      data: { analysisStatus: 'complete', scopePools: 1, scopePoolCandidates: 2 },
    });
    const structured = evaluated.structuredContent as {
      artifacts: Array<{ uri: string; mimeType: string }>;
    };
    const jsonArtifact = structured.artifacts.find(
      ({ mimeType }) => mimeType === 'application/json',
    );
    expect(jsonArtifact).toBeDefined();
    const resource = await client.readResource({ uri: jsonArtifact!.uri });
    const content = resource.contents[0];
    expect(content).toBeDefined();
    if (content === undefined || !('text' in content)) return;
    const result = JSON.parse(content.text) as {
      scenarios: Array<{
        candidates: Array<{ conditionalProbability: number }>;
        scopePools: Array<{
          eligibleCandidateIds: string[];
          candidates: Array<{ id: string; conditionalProbability: number }>;
        }>;
      }>;
    };
    expect(
      result.scenarios[0]?.candidates.map(({ conditionalProbability }) => conditionalProbability),
    ).toEqual([0.75, 0.25]);
    expect(result.scenarios[0]?.scopePools[0]).toMatchObject({
      eligibleCandidateIds: ['AAA'],
      candidates: [
        { id: 'AAA', conditionalProbability: 1 },
        { id: 'BBB', conditionalProbability: 0 },
      ],
    });
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

  it('discovers compatible adapters instead of failing empty probability inspection', async () => {
    const { client } = await connected();
    const source =
      'focus_tree = { id = weighted_tree focus = { id = weighted_focus x = 0 y = 0 ai_will_do = { factor = 2 } } }';
    const discovered = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: {
        adapter: 'decision_ai_will_do',
        source: { inlineClausewitz: source },
      },
    });
    expect(discovered.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SOURCE_DISCOVERED',
      data: {
        requestedAdapter: 'decision_ai_will_do',
        suggestedAdapter: 'national_focus_ai_will_do',
        discoveryReason: 'requested_adapter_empty',
        candidates: 0,
        availableCandidates: 1,
        availableAdapters: [
          expect.objectContaining({ adapterId: 'national_focus_ai_will_do', candidates: 1 }),
        ],
        candidateExamples: ['weighted_focus'],
      },
    });
    const structured = discovered.structuredContent as {
      artifacts: Array<{ uri: string }>;
    };
    expect(structured.artifacts).toHaveLength(1);
    const discovery = await client.readResource({ uri: structured.artifacts[0]!.uri });
    const discoveryContent = discovery.contents[0];
    expect(discoveryContent).toBeDefined();
    if (discoveryContent !== undefined && 'text' in discoveryContent)
      expect(JSON.parse(discoveryContent.text)).toMatchObject({
        schemaVersion: 'probability-inspection.v2',
        discovery: {
          reason: 'requested_adapter_empty',
          suggestedAdapter: 'national_focus_ai_will_do',
        },
      });

    const automatic = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: { source: { inlineClausewitz: source } },
    });
    expect(automatic.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SOURCE_DISCOVERED',
      data: {
        suggestedAdapter: 'national_focus_ai_will_do',
        discoveryReason: 'source_inventory',
      },
    });

    const missingIdentifier = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: {
        adapter: 'national_focus_ai_will_do',
        source: { identifier: 'missing_focus', inlineClausewitz: source },
      },
    });
    expect(missingIdentifier.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SOURCE_DISCOVERED',
      data: {
        suggestedAdapter: 'national_focus_ai_will_do',
        discoveryReason: 'identifier_not_found',
        candidateExamples: ['weighted_focus'],
      },
    });

    const missingPool = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: {
        adapter: 'national_focus_ai_will_do',
        source: { inlineClausewitz: source },
        candidatePool: ['missing_focus'],
      },
    });
    expect(missingPool.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SOURCE_DISCOVERED',
      data: {
        suggestedAdapter: 'national_focus_ai_will_do',
        discoveryReason: 'candidate_pool_not_found',
      },
    });

    const noSurface = await client.callTool({
      name: 'hoi4.probability_inspect',
      arguments: { source: { inlineClausewitz: 'set_country_flag = no_weight_here' } },
    });
    expect(noSurface.structuredContent).toMatchObject({
      status: 'ok',
      code: 'PROBABILITY_SOURCE_DISCOVERED',
      data: {
        discoveryReason: 'no_weighted_surfaces',
        availableCandidates: 0,
        availableAdapters: [],
        candidateExamples: [],
      },
    });

    const evaluated = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: {
        adapter: 'decision_ai_will_do',
        source: { inlineClausewitz: source },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'strict-empty-evaluation',
          scenarios: [{ id: 'baseline', state: {} }],
        },
      },
    });
    expect(evaluated.structuredContent).toMatchObject({
      status: 'error',
      code: 'PROBABILITY_SURFACE_EMPTY',
    });
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
    await mkdir(path.join(mod, 'common', 'scripted_triggers'), { recursive: true });
    await writeFile(
      path.join(mod, 'common', 'scripted_triggers', 'changed.txt'),
      'changed_probability_trigger = { always = yes }\n',
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { ArtifactStore } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { EventChainViewer, inspectEventStateFlow } from '../../src/hoi4_agent_tools/event/index.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

const source = `add_namespace = service

country_event = {
	id = service.1
	title = service.1.t
	is_triggered_only = yes
	option = {
		name = service.1.a
		set_country_flag = service_ready
		country_event = { id = service.2 days = 2 }
	}
}

country_event = {
	id = service.2
	title = service.2.t
	is_triggered_only = yes
	trigger = { has_country_flag = service_ready }
	option = { name = service.2.a }
}
`;

async function fixture(artifactMaxSingleBytes?: number) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-event-service-'));
  const mod = path.join(temporary, 'mod');
  const runtime = path.join(temporary, 'runtime');
  const sourcePath = path.join(mod, 'events', 'service.txt');
  await Promise.all([
    mkdir(path.dirname(sourcePath), { recursive: true }),
    mkdir(path.join(mod, 'common', 'on_actions'), { recursive: true }),
    mkdir(path.join(mod, 'localisation', 'english'), { recursive: true }),
    mkdir(runtime, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(sourcePath, source, 'utf8'),
    writeFile(
      path.join(mod, 'common', 'on_actions', 'service.txt'),
      'on_actions = { on_startup = { effect = { country_event = { id = service.1 } } } }\n',
      'utf8',
    ),
    writeFile(
      path.join(mod, 'localisation', 'english', 'service_l_english.yml'),
      '\ufeffl_english:\nservice.1.t: "One"\nservice.1.a: "Continue"\nservice.2.t: "Two"\nservice.2.a: "Finish"\n',
      'utf8',
    ),
  ]);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    storageRoots: [runtime],
    workspaces: [
      {
        id: 'event-service',
        name: 'Event service fixture',
        root: mod,
        artifactRoot: path.join(runtime, 'artifacts'),
        cacheRoot: path.join(runtime, 'cache'),
      },
    ],
  });
  const scanner = new WorkspaceScanner();
  const scan = vi.spyOn(scanner, 'scan');
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver, {
    scanner,
    ...(artifactMaxSingleBytes === undefined
      ? {}
      : { artifacts: new ArtifactStore(536_870_912, 5_000, artifactMaxSingleBytes) }),
  });
  cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
  return { engine, scan, sourcePath };
}

describe('Event Chain Viewer service', () => {
  it('shares an unchanged semantic graph across viewers and invalidates by generation', async () => {
    const { engine, scan } = await fixture();
    const first = new EventChainViewer(engine);
    const scanned = await first.inspect({ workspaceId: 'event-service', mode: 'scan' });
    expect(scanned.graph.statistics.eventCount).toBe(2);
    expect(scan).toHaveBeenCalledTimes(1);

    const second = new EventChainViewer(engine);
    const trace = await second.inspect({
      workspaceId: 'event-service',
      mode: 'trace',
      selector: { kind: 'event', eventId: 'service.1' },
      direction: 'downstream',
    });
    expect(trace.graph).toBe(scanned.graph);
    expect(scan).toHaveBeenCalledTimes(1);

    expect(await second.scan('event-service', { refresh: true })).toBe(scanned.graph);
    expect(scan).toHaveBeenCalledTimes(2);

    engine.invalidate('event-service');
    expect(await second.scan('event-service')).not.toBe(scanned.graph);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('re-authorizes every request before returning a shared cached graph', async () => {
    const { engine } = await fixture();
    const viewer = new EventChainViewer(engine);
    await viewer.scan('event-service');

    await expect(
      viewer.scan('event-service', { principal: 'not-allowlisted' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
  });

  it('round-trips a scan artifact as a comparison baseline without writing source', async () => {
    const { engine, sourcePath } = await fixture();
    const viewer = new EventChainViewer(engine);
    const baseline = await viewer.inspect({ workspaceId: 'event-service', mode: 'scan' });
    const artifactUri = baseline.artifacts[0]?.uri;
    expect(artifactUri).toBeDefined();
    expect(JSON.parse(baseline.reportJson)).toMatchObject({
      schemaVersion: 'event-analysis.v1',
      graphSchemaVersion: 1,
      parserVersion: 'clausewitz-cst.v1',
      workspaceId: 'event-service',
      graphRevision: baseline.graph.revision,
      filters: { maxDepth: 8, maxNodes: 500, maxEdges: 2_000, refresh: true },
      resources: [{ name: expect.stringMatching(/\.json$/u), mimeType: 'application/json' }],
    });
    const proposed = `${source}\ncountry_event = {\n\tid = service.3\n\ttitle = service.3.t\n\tis_triggered_only = yes\n\toption = { name = service.3.a }\n}\n`;

    const artifactRead = vi.spyOn(engine.artifacts, 'read');
    const compared = await viewer.compareAndStore({
      workspaceId: 'event-service',
      before: { artifactUri: artifactUri! },
      proposedSources: [{ relativePath: 'events/service.txt', source: proposed }],
      render: false,
    });

    expect(compared.before.revision).toBe(baseline.graph.revision);
    expect(compared.comparison.addedNodeIds).toContain('event:service.3');
    expect(compared.artifacts.some(({ mimeType }) => mimeType === 'application/json')).toBe(true);
    const comparisonArtifact = JSON.parse(compared.comparisonJson) as {
      evidence: { after: { nodes: Array<{ eventId?: string }> } };
    };
    expect(comparisonArtifact).toMatchObject({
      schemaVersion: 'event-comparison-artifact.v1',
      graphSchemaVersion: 1,
      parserVersion: 'clausewitz-cst.v1',
      workspaceId: 'event-service',
      filters: {
        proposedSources: [
          {
            relativePath: 'events/service.txt',
            operation: 'overlay',
            sourceHash: sha256Bytes(proposed),
          },
        ],
        render: false,
      },
      resources: { json: expect.stringMatching(/\.json$/u) },
    });
    expect(comparisonArtifact.evidence.after.nodes).toContainEqual(
      expect.objectContaining({ eventId: 'service.3' }),
    );
    expect(artifactRead.mock.calls[0]?.[2]).toEqual({ offset: 0, length: 1 });
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it('reconstructs bounded chunked graph references and rejects unbounded chunk indexes', async () => {
    const { engine } = await fixture(8_192);
    const viewer = new EventChainViewer(engine);
    const baseline = await viewer.inspect({ workspaceId: 'event-service', mode: 'scan' });
    const workspace = engine.resolver.get('event-service');
    const provenance = {
      kind: 'event-artifact-test',
      toolVersion: 'test',
      schemaVersion: 'event-analysis.v1',
      sourceHashes: baseline.graph.sourceHashes,
    };
    const chunked = await engine.artifacts.putChunked(
      workspace,
      'chunked-event-graph.json',
      'application/json',
      `${JSON.stringify({
        schemaVersion: 'event-analysis.v1',
        mode: 'scan',
        padding: 'x'.repeat(24_000),
        report: { graph: baseline.graph },
      })}\n`,
      provenance,
    );
    const chunkIndex = JSON.parse(
      (await engine.artifacts.read(workspace, chunked.uri)).bytes.toString('utf8'),
    ) as { type?: string; chunks?: unknown[] };
    expect(chunkIndex.type).toBe('hoi4-agent.chunked-artifact');
    expect(chunkIndex.chunks?.length).toBeGreaterThan(1);

    const compared = await viewer.compareAndStore({
      workspaceId: 'event-service',
      before: { artifactUri: chunked.uri },
      render: false,
    });
    expect(compared.before.revision).toBe(baseline.graph.revision);

    const tooManyChunks = await engine.artifacts.put(
      workspace,
      'unbounded-event-chunks.json',
      'application/json',
      `${JSON.stringify({
        schemaVersion: 1,
        type: 'hoi4-agent.chunked-artifact',
        original: {
          name: 'graph.json',
          mimeType: 'application/json',
          size: 1,
          sha256: sha256Bytes('x'),
        },
        chunks: Array.from({ length: 1_025 }, () => ({})),
      })}\n`,
      provenance,
    );
    await expect(
      viewer.compareAndStore({
        workspaceId: 'event-service',
        before: { artifactUri: tooManyChunks.uri },
        render: false,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_GRAPH_ARTIFACT_LIMIT' });
  });

  it('rejects forged graph structure before comparison', async () => {
    const { engine } = await fixture();
    const viewer = new EventChainViewer(engine);
    const baseline = await viewer.inspect({ workspaceId: 'event-service', mode: 'scan' });
    const workspace = engine.resolver.get('event-service');
    const forged = structuredClone(baseline.graph);
    forged.edges[0]!.to = 'event:not-indexed';
    const artifact = await engine.artifacts.put(
      workspace,
      'forged-event-graph.json',
      'application/json',
      `${JSON.stringify(forged)}\n`,
      {
        kind: 'event-artifact-test',
        toolVersion: 'test',
        schemaVersion: 'event-graph.v1',
        sourceHashes: baseline.graph.sourceHashes,
      },
    );

    await expect(
      viewer.compareAndStore({
        workspaceId: 'event-service',
        before: { artifactUri: artifact.uri },
        render: false,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_GRAPH_ARTIFACT_INVALID' });
  });

  it('rejects escaping or unbounded proposed comparison sources before mutation', async () => {
    const { engine, sourcePath } = await fixture();
    const viewer = new EventChainViewer(engine);
    await viewer.scan('event-service', { refresh: true });

    await expect(
      viewer.compareAndStore({
        workspaceId: 'event-service',
        proposedSources: [{ relativePath: '../outside.txt', source: 'country_event = {}' }],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_PROPOSED_PATH_INVALID' });
    await expect(
      viewer.compareAndStore({
        workspaceId: 'event-service',
        proposedSources: Array.from({ length: 65 }, (_, index) => ({
          relativePath: `events/too-many-${index}.txt`,
          source: 'country_event = {}',
        })),
      }),
    ).rejects.toMatchObject({ code: 'EVENT_PROPOSED_SOURCE_COUNT_LIMIT' });
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it('retains same-load-level cross-file event duplicates and resolves calls deterministically', async () => {
    const { engine, sourcePath } = await fixture();
    await writeFile(
      path.join(path.dirname(sourcePath), 'zz-duplicate.txt'),
      'country_event = {\n\tid = service.1\n\tis_triggered_only = yes\n\toption = { name = service.1.duplicate }\n}\n',
      'utf8',
    );
    const viewer = new EventChainViewer(engine);
    const graph = await viewer.scan('event-service', { refresh: true });

    expect(
      graph.nodes.filter(({ kind, eventId }) => kind === 'event' && eventId === 'service.1'),
    ).toHaveLength(2);
    expect(graph.nodes.map(({ id }) => id)).toContain('event:service.1');
    expect(graph.nodes.some(({ id }) => id.startsWith('event:service.1:duplicate:'))).toBe(true);
    expect(graph.issues).toContainEqual(
      expect.objectContaining({
        code: 'EVENT_DUPLICATE_ID',
        details: expect.objectContaining({ eventId: 'service.1', definitionCount: 2 }),
      }),
    );
    expect(
      graph.edges.some(
        ({ from, to, reason }) =>
          graph.nodes.some(({ id, kind }) => id === from && kind === 'entry') &&
          to === 'event:service.1' &&
          reason === 'on_action_entry',
      ),
    ).toBe(true);
  });

  it('recognizes clear_global_event_targets as cleanup for every named global target', async () => {
    const { engine, sourcePath } = await fixture();
    await writeFile(
      sourcePath,
      `country_event = {
\tid = service.1
\tis_triggered_only = no
\timmediate = { save_global_event_target_as = service_target }
\toption = { name = service.1.a country_event = service.2 }
}
country_event = {
\tid = service.2
\tis_triggered_only = yes
\timmediate = { clear_global_event_targets = yes }
\toption = { name = service.2.a }
}
`,
      'utf8',
    );
    const viewer = new EventChainViewer(engine);
    const graph = await viewer.scan('event-service', { refresh: true });

    expect(graph.issues.map(({ code }) => code)).not.toContain(
      'EVENT_GLOBAL_TARGET_WITHOUT_CLEANUP',
    );
    const flow = inspectEventStateFlow(graph, undefined, {
      kind: 'global_event_target',
      name: 'service_target',
    });
    expect(flow.clears.map(({ name }) => name)).toEqual(['*']);
    expect(flow.globalTargetLeaks).toEqual([]);
  });

  it('inherits caller scope through helper state and event projections', async () => {
    const { engine, sourcePath } = await fixture();
    const helperPath = path.join(
      path.dirname(path.dirname(sourcePath)),
      'common',
      'scripted_effects',
      'service-scope.txt',
    );
    await mkdir(path.dirname(helperPath), { recursive: true });
    await Promise.all([
      writeFile(
        sourcePath,
        `country_event = {
\tid = service.1
\tis_triggered_only = no
\toption = { name = service.1.a service_scope_helper = yes }
}
state_event = {
\tid = service.2
\tis_triggered_only = yes
\toption = { name = service.2.a }
}
`,
        'utf8',
      ),
      writeFile(
        helperPath,
        `service_scope_helper = {
\tset_variable = { helper_value = 1 }
\tstate_event = service.2
}
`,
        'utf8',
      ),
    ]);
    const viewer = new EventChainViewer(engine);
    const graph = await viewer.scan('event-service', { refresh: true });

    expect(
      graph.stateAccesses.find(
        ({ name, metadata }) =>
          name === 'helper_value' && metadata.projectedFromAccessId !== undefined,
      ),
    ).toMatchObject({ scope: 'country' });
    expect(
      graph.edges.find(
        ({ derived, to, helperStack }) =>
          derived && to === 'event:service.2' && helperStack.includes('service_scope_helper'),
      ),
    ).toMatchObject({
      scope: { source: 'country', destination: 'state' },
    });
  });

  it('links a global saved-scope producer to an unqualified scope read without a false warning', async () => {
    const { engine, sourcePath } = await fixture();
    await writeFile(
      sourcePath,
      `add_namespace = service

country_event = {
	id = service.1
	title = service.1.t
	is_triggered_only = no
	immediate = {
		save_global_scope_as = shared_scope
		country_event = service.2
	}
	option = { name = service.1.a }
}

country_event = {
	id = service.2
	title = service.2.t
	is_triggered_only = yes
	immediate = {
		scope:shared_scope = { set_country_flag = service_scope_read }
	}
	option = { name = service.2.a }
}
`,
      'utf8',
    );
    const viewer = new EventChainViewer(engine);
    const graph = await viewer.scan('event-service', { refresh: true });
    const savedScopes = graph.stateAccesses.filter(
      ({ kind, name }) => kind === 'saved_scope' && name === 'shared_scope',
    );
    const producer = savedScopes.find(({ access }) => access === 'write');
    const consumer = savedScopes.find(({ access }) => access === 'read');

    expect(producer).toMatchObject({ metadata: { storage: 'global' } });
    expect(consumer).toMatchObject({ metadata: {} });
    expect(graph.stateLinks).toContainEqual(
      expect.objectContaining({
        stateKind: 'saved_scope',
        name: 'shared_scope',
        producerId: producer?.id,
        consumerId: consumer?.id,
        confidence: 'unresolved',
        pathConfirmed: true,
      }),
    );
    expect(
      graph.issues.filter(
        ({ code, details }) =>
          code === 'EVENT_TARGET_READ_BEFORE_SAVE' && details.accessId === consumer?.id,
      ),
    ).toEqual([]);
  });

  it('renders removed nodes and edges as source-linked tombstones', async () => {
    const { engine } = await fixture();
    const viewer = new EventChainViewer(engine);
    await viewer.scan('event-service', { refresh: true });
    const proposed = `country_event = {
\tid = service.1
\ttitle = service.1.t
\tis_triggered_only = yes
\toption = { name = service.1.a set_country_flag = service_done }
}
`;
    const compared = await viewer.compareAndStore({
      workspaceId: 'event-service',
      proposedSources: [{ relativePath: 'events/service.txt', source: proposed }],
      render: true,
    });

    expect(compared.comparison.removedNodeIds.length).toBeGreaterThan(0);
    expect(compared.comparison.removedEdgeIds.length).toBeGreaterThan(0);
    expect(compared.render?.svg).toContain('data-comparison-status="removed"');
    expect(compared.render?.svg).toContain('data-source-path="mod:events/service.txt"');
    expect(JSON.parse(compared.render?.json ?? '{}')).toMatchObject({
      graphSchemaVersion: 1,
      parserVersion: 'clausewitz-cst.v1',
      workspaceId: 'event-service',
      filters: { direction: 'both', maxDepth: 2 },
    });
  });

  it('partitions interleaved disconnected chains into coherent rooted branches', async () => {
    const { engine, sourcePath } = await fixture();
    await writeFile(
      sourcePath,
      `country_event = {
\tid = service.1
\tis_triggered_only = yes
\toption = { name = service.1.a country_event = service.3 }
}
country_event = {
\tid = service.2
\tis_triggered_only = yes
\toption = { name = service.2.a country_event = service.4 }
}
country_event = {
\tid = service.3
\tis_triggered_only = yes
\toption = { name = service.3.a }
}
country_event = {
\tid = service.4
\tis_triggered_only = yes
\toption = { name = service.4.a }
}
`,
      'utf8',
    );
    const viewer = new EventChainViewer(engine);
    const rendered = await viewer.renderAndStore({
      workspaceId: 'event-service',
      view: 'overview',
      maxNodes: 2,
      includeHtml: false,
      refresh: true,
    });
    const firstChain = rendered.branches.find(
      ({ selectedNodeIds }) =>
        selectedNodeIds.includes('event:service.1') && selectedNodeIds.includes('event:service.3'),
    );
    const secondChain = rendered.branches.find(
      ({ selectedNodeIds }) =>
        selectedNodeIds.includes('event:service.2') && selectedNodeIds.includes('event:service.4'),
    );
    expect(firstChain?.selectedNodeIds).not.toContain('event:service.2');
    expect(secondChain?.selectedNodeIds).not.toContain('event:service.1');
    expect(JSON.parse(rendered.manifestJson)).toMatchObject({
      graphSchemaVersion: 1,
      parserVersion: 'clausewitz-cst.v1',
      workspaceId: 'event-service',
      filters: { view: 'overview', maxNodes: 2, includeHtml: false },
      resources: {
        manifest: expect.stringMatching(/-manifest\.json$/u),
        overview: {
          json: expect.stringMatching(/\.json$/u),
          svg: expect.stringMatching(/\.svg$/u),
          png: expect.stringMatching(/\.png$/u),
        },
      },
      coverage: {
        omittedNodeCount: 0,
        omittedNodeIds: [],
        truncated: false,
      },
    });
  });

  it('requires localisation fields only for visible events and their options', async () => {
    const { engine, sourcePath } = await fixture();
    await writeFile(
      sourcePath,
      `country_event = {
\tid = service.1
\tis_triggered_only = yes
\toption = { add_political_power = 1 }
}
country_event = {
\tid = service.2
\thidden = yes
\ttitle = hidden.missing.title
\tdesc = hidden.missing.desc
\tis_triggered_only = yes
\toption = { name = hidden.missing.option }
}
`,
      'utf8',
    );
    const graph = await new EventChainViewer(engine).scan('event-service', { refresh: true });
    const localisationIssues = graph.issues.filter(
      ({ code }) => code === 'EVENT_LOCALISATION_MISSING',
    );

    expect(localisationIssues).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          missingFields: ['description', 'option_name', 'title'],
        }),
      }),
    );
    expect(
      localisationIssues.some(({ details }) =>
        (details.missingKeys as unknown[] | undefined)?.includes('hidden.missing.title'),
      ),
    ).toBe(false);
  });

  it('reports callerless events even when is_triggered_only is omitted', async () => {
    const { engine, sourcePath } = await fixture();
    const onActionPath = path.join(
      path.dirname(path.dirname(sourcePath)),
      'common',
      'on_actions',
      'service.txt',
    );
    await Promise.all([
      writeFile(
        sourcePath,
        `country_event = {
\tid = service.1
\ttitle = service.1.t
\tdesc = service.1.d
\toption = { name = service.1.a }
}
`,
        'utf8',
      ),
      writeFile(onActionPath, 'on_actions = {}\n', 'utf8'),
    ]);
    const graph = await new EventChainViewer(engine).scan('event-service', { refresh: true });

    expect(graph.issues).toContainEqual(
      expect.objectContaining({
        code: 'EVENT_UNREACHABLE_IN_SELECTION',
        details: expect.objectContaining({ subjectIds: ['event:service.1'] }),
      }),
    );
  });

  it('accepts documented event call scopes and preserves conservative on-action roots', async () => {
    const { engine, sourcePath } = await fixture();
    const onActionPath = path.join(
      path.dirname(path.dirname(sourcePath)),
      'common',
      'on_actions',
      'service.txt',
    );
    await Promise.all([
      writeFile(
        sourcePath,
        `country_event = {
\tid = service.1
\ttitle = service.1.t
\tdesc = service.1.d
\tis_triggered_only = yes
\timmediate = {
\t\tstate_event = service.2
\t\tcharacter = { unit_leader_event = service.3 operative_leader_event = service.4 }
\t}
}
state_event = {
\tid = service.2
\ttitle = service.2.t
\tdesc = service.2.d
\tis_triggered_only = yes
}
unit_leader_event = {
\tid = service.3
\ttitle = service.3.t
\tdesc = service.3.d
\tis_triggered_only = yes
}
operative_leader_event = {
\tid = service.4
\ttitle = service.4.t
\tdesc = service.4.d
\tis_triggered_only = yes
}
`,
        'utf8',
      ),
      writeFile(
        onActionPath,
        `on_actions = {
\ton_unit_leader_created = { effect = { unit_leader_event = service.3 } }
\ton_unmapped_custom_hook = { effect = { country_event = service.1 } }
}
`,
        'utf8',
      ),
    ]);
    const graph = await new EventChainViewer(engine).scan('event-service', { refresh: true });
    const byTarget = (target: string) =>
      graph.edges.filter(({ metadata }) => metadata.targetEventId === target);

    expect(byTarget('service.2')).toContainEqual(
      expect.objectContaining({ scope: expect.objectContaining({ source: 'country' }) }),
    );
    expect(byTarget('service.3')).toContainEqual(
      expect.objectContaining({ scope: expect.objectContaining({ source: 'character' }) }),
    );
    expect(byTarget('service.4')).toContainEqual(
      expect.objectContaining({ scope: expect.objectContaining({ source: 'character' }) }),
    );
    expect(byTarget('service.3')).toContainEqual(
      expect.objectContaining({ scope: expect.objectContaining({ source: 'unit_leader' }) }),
    );
    expect(byTarget('service.1')).toContainEqual(
      expect.objectContaining({
        scope: expect.objectContaining({ source: 'unknown', confidence: 'low' }),
      }),
    );
    expect(graph.issues.map(({ code }) => code)).not.toContain('EVENT_SCOPE_MISMATCH');
  });

  it('diagnoses incompatible mapped scopes without treating dynamic scopes as confirmed', async () => {
    const { engine, sourcePath } = await fixture();
    await writeFile(
      sourcePath,
      `country_event = {
\tid = service.1
\ttitle = service.1.t
\tdesc = service.1.d
\tis_triggered_only = yes
\timmediate = {
\t\tevery_state = { country_event = service.2 }
\t\tFROM.FROM = { country_event = service.2 }
\t}
}
country_event = {
\tid = service.2
\ttitle = service.2.t
\tdesc = service.2.d
\tis_triggered_only = yes
}
`,
      'utf8',
    );
    const graph = await new EventChainViewer(engine).scan('event-service', { refresh: true });
    const calls = graph.edges.filter(({ metadata }) => metadata.targetEventId === 'service.2');
    const mapped = calls.find(({ scope }) => scope?.expression === 'every_state');
    const dynamic = calls.find(({ scope }) => scope?.expression === 'FROM.FROM');
    const mismatches = graph.issues.filter(({ code }) => code === 'EVENT_SCOPE_MISMATCH');

    expect(mapped?.scope).toMatchObject({
      source: 'state',
      destination: 'country',
      confidence: 'high',
    });
    expect(dynamic?.scope).toMatchObject({
      source: 'unknown',
      destination: 'country',
      confidence: 'low',
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.details).toMatchObject({
      edgeId: mapped?.id,
      source: 'state',
      destination: 'country',
    });
  });
});

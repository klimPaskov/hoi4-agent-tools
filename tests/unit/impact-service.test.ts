import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ImpactAnalyzer } from '../../src/hoi4_agent_tools/impact/service.js';
import { impactInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/analysis.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-impact-service-'));
  temporaryRoots.push(temporary);
  const mod = path.join(temporary, 'mod');
  const ideas = path.join(mod, 'common', 'ideas', 'needs.txt');
  const decisions = path.join(mod, 'common', 'decisions', 'needs.txt');
  await Promise.all([
    mkdir(path.dirname(ideas), { recursive: true }),
    mkdir(path.dirname(decisions), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(ideas, 'ideas = { country = { rationing = {} } }'),
    writeFile(decisions, 'needs = { spend = { available = { has_idea = rationing } } }'),
  ]);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    workspaces: [{ id: 'fixture', name: 'Impact fixture', root: mod }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  return { engine, analyzer: new ImpactAnalyzer(engine) };
}

describe('authorized impact analysis service', () => {
  it('links a bounded report and compares a proposed source without writing the mod', async () => {
    const { engine, analyzer } = await fixture();
    const request = impactInspectRequestSchema.parse({
      workspaceId: 'fixture',
      symbols: [{ kind: 'idea', id: 'rationing' }],
    });
    const baseline = await analyzer.inspect(request);
    expect(baseline.data).toMatchObject({ mode: 'inspect', directConsumers: 1 });
    expect(baseline.artifacts).toHaveLength(1);
    const compared = await analyzer.inspect({
      ...request,
      proposedSources: [
        {
          relativePath: 'common/decisions/needs.txt',
          content: 'needs = { spend = { available = { always = yes } } }',
        },
      ],
    });
    expect(compared.data).toMatchObject({
      mode: 'compare',
      removedConsumers: 1,
      addedConsumers: 0,
      directConsumers: 1,
    });
    const workspace = engine.resolver.get('fixture');
    const linked = await engine.artifacts.readLogical(workspace, compared.artifacts[0]!.uri, {
      mimeType: 'application/json',
      maxBytes: 10_000_000,
      maxChunks: 128,
    });
    const report = JSON.parse(linked.bytes.toString('utf8')) as { schemaVersion: string };
    expect(report.schemaVersion).toBe('impact-analysis.v1');
    const rescanned = await engine.scan('fixture');
    expect(rescanned.revision).toBe(baseline.data.sourceRevision);
    expect(rescanned.index.find('decision', 'spend')).toBeDefined();
  });

  it('rejects stale revisions and paths outside the scanned or proposed source set', async () => {
    const { analyzer } = await fixture();
    const request = impactInspectRequestSchema.parse({
      workspaceId: 'fixture',
      symbols: [{ kind: 'idea', id: 'rationing' }],
    });
    await expect(
      analyzer.inspect({ ...request, expectedRevision: '0'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'IMPACT_SOURCE_STALE',
    });
    await expect(
      analyzer.inspect({ ...request, changedFiles: ['mod:events/missing.txt'] }),
    ).rejects.toMatchObject({
      code: 'IMPACT_SOURCE_UNKNOWN',
    });
  });

  it('links declared scenario cases affected by a source symbol without executing them', async () => {
    const { engine, analyzer } = await fixture();
    const workspace = engine.resolver.get('fixture');
    const suite = path.join(workspace.modRoot, 'tests', 'policy.json');
    await mkdir(path.dirname(suite), { recursive: true });
    await writeFile(
      suite,
      JSON.stringify({
        schemaVersion: '1.0',
        id: 'policy',
        cases: [
          { id: 'decision', sourceSelectors: [{ kind: 'decision', id: 'spend' }] },
          { id: 'idea_file', sourceFiles: ['mod:common/ideas/needs.txt'] },
          { id: 'unrelated', sourceSelectors: [{ kind: 'focus', id: 'other' }] },
        ],
      }),
    );
    const request = impactInspectRequestSchema.parse({
      workspaceId: 'fixture',
      symbols: [{ kind: 'idea', id: 'rationing' }],
      scenarioSuites: ['tests/policy.json'],
    });
    const result = await analyzer.inspect(request);
    expect(result.data).toMatchObject({ scenarioSuites: 1, affectedCases: 2, complete: true });
    const linked = await engine.artifacts.readLogical(workspace, result.artifacts[0]!.uri, {
      mimeType: 'application/json',
      maxBytes: 10_000_000,
      maxChunks: 128,
    });
    const report = JSON.parse(linked.bytes.toString('utf8')) as {
      scenarioSuites: { matches: Array<{ caseId: string }> };
    };
    expect(report.scenarioSuites.matches.map(({ caseId }) => caseId)).toEqual([
      'decision',
      'idea_file',
    ]);
    const removed = await analyzer.inspect({
      ...request,
      proposedSources: [{ relativePath: 'common/decisions/needs.txt', content: null }],
    });
    expect(removed.data).toMatchObject({ mode: 'compare', affectedCases: 2 });
    await writeFile(suite, '{ incomplete');
    const partial = await analyzer.inspect(request);
    expect(partial.data).toMatchObject({ complete: false, scenarioSuites: 0 });
  });
});

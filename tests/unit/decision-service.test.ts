import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { DecisionAnalyzer } from '../../src/hoi4_agent_tools/decision/service.js';
import { decisionInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/analysis.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const relativePath = 'common/decisions/policy.txt';
const baselineSource = `policy = { fund = {
	available = { has_country_flag = approved }
	cost = 10
	days_re_enable = 7
	complete_effect = { set_country_flag = funded }
} }`;

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-decision-service-'));
  temporaryRoots.push(temporary);
  const mod = path.join(temporary, 'mod');
  const sourcePath = path.join(mod, relativePath);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, baselineSource);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    workspaces: [{ id: 'fixture', name: 'Decision fixture', root: mod }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  return { engine, analyzer: new DecisionAnalyzer(engine), sourcePath };
}

describe('authorized decision analysis service', () => {
  it('inventories decisions, links scenario evidence, and compares a proposal without writing source', async () => {
    const { engine, analyzer, sourcePath } = await fixture();
    const inventory = await analyzer.inspect(
      decisionInspectRequestSchema.parse({ workspaceId: 'fixture' }),
    );
    expect(inventory.data).toMatchObject({ mode: 'inventory', decisions: 1, categories: 1 });
    const scenario = {
      id: 'approved_actor',
      actor: 'AAA',
      state: { political_power: 15 },
      flags: ['approved'],
      closedFlags: true,
    };
    const inspected = await analyzer.inspect(
      decisionInspectRequestSchema.parse({
        workspaceId: 'fixture',
        mode: 'inspect',
        id: 'fund',
        scenarios: [scenario],
        expectedRevision: inventory.data.sourceRevision,
      }),
    );
    expect(inspected.data).toMatchObject({ mode: 'inspect', scenarios: 1, complete: true });
    const compared = await analyzer.inspect(
      decisionInspectRequestSchema.parse({
        workspaceId: 'fixture',
        mode: 'compare',
        id: 'fund',
        scenarios: [scenario],
        proposedSources: [
          {
            relativePath,
            content: baselineSource.replace('cost = 10', 'cost = 20'),
          },
        ],
      }),
    );
    expect(compared.data).toMatchObject({ mode: 'compare', scenarios: 1, complete: true });
    const workspace = engine.resolver.get('fixture');
    const linked = await engine.artifacts.readLogical(workspace, compared.artifacts[0]!.uri, {
      mimeType: 'application/json',
      maxBytes: 10_000_000,
      maxChunks: 128,
    });
    const report = JSON.parse(linked.bytes.toString('utf8')) as {
      schemaVersion: string;
      analysis: { cases: Array<{ changed: string[] }> };
    };
    expect(report.schemaVersion).toBe('decision-analysis.v1');
    expect(report.analysis.cases[0]?.changed).toContain('cost_amount');
    expect(await readFile(sourcePath, 'utf8')).toBe(baselineSource);
    expect((await engine.scan('fixture')).revision).toBe(inventory.data.sourceRevision);
  });

  it('rejects a stale source revision', async () => {
    const { analyzer } = await fixture();
    const request = decisionInspectRequestSchema.parse({ workspaceId: 'fixture' });
    await expect(
      analyzer.inspect({ ...request, expectedRevision: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'DECISION_SOURCE_STALE' });
  });

  it('reuses probability scoring for a weighted decision and a source proposal', async () => {
    const { engine, analyzer, sourcePath } = await fixture();
    const weighted = baselineSource.replace(
      'cost = 10',
      'cost = 10\n\tai_will_do = { factor = 2 }',
    );
    await writeFile(sourcePath, weighted);
    const request = decisionInspectRequestSchema.parse({
      workspaceId: 'fixture',
      mode: 'compare',
      id: 'fund',
      scenarios: [
        { id: 'approved', actor: 'AAA', state: { political_power: 15 }, flags: ['approved'] },
      ],
      proposedSources: [{ relativePath, content: weighted.replace('factor = 2', 'factor = 3') }],
      refresh: true,
    });
    const result = await analyzer.inspect(request);
    const workspace = engine.resolver.get('fixture');
    const linked = await engine.artifacts.readLogical(workspace, result.artifacts[0]!.uri, {
      mimeType: 'application/json',
      maxBytes: 10_000_000,
      maxChunks: 128,
    });
    const report = JSON.parse(linked.bytes.toString('utf8')) as {
      ai: {
        mode: string;
        adapter: string;
        comparison?: { scenarioChanges: Array<{ candidateId: string; rawDelta?: number }> };
        resources: unknown[];
      };
    };
    expect(report.ai).toMatchObject({
      mode: 'compare',
      adapter: 'decision_ai_will_do',
      status: 'complete',
    });
    expect(report.ai.comparison).toBeDefined();
    expect(report.ai.comparison?.scenarioChanges).toContainEqual(
      expect.objectContaining({ candidateId: 'fund', rawDelta: 1 }),
    );
    expect(report.ai.resources).toHaveLength(1);
    expect(await readFile(sourcePath, 'utf8')).toBe(weighted);
  });
});

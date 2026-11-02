import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  analyzeProbabilities,
  inspectProbabilities,
} from '../../src/hoi4_agent_tools/probability/operations.js';
import { ProbabilityAnalyzer } from '../../src/hoi4_agent_tools/probability/service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

const DECISIONS = `
death_decisions = {
  death_consume_another_island = {
    days_remove = -1
    available = { check_variable = { var = death_souls value = 5 compare = greater_than } }
    ai_will_do = { base = 1 modifier = { factor = 3 check_variable = { var = death_souls value = 8 compare = greater_than } } }
    complete_effect = { add_political_power = 1 }
  }
  death_timed_mission = {
    days_mission_timeout = 30
    ai_will_do = { base = 2 }
    timeout_effect = { add_political_power = -1 }
  }
}
`;

const EVENTS = `
add_namespace = chaos
country_event = {
  id = chaos.1
  mean_time_to_happen = { days = 10 modifier = { factor = 2 check_variable = { var = pressure value = 5 compare = greater_than } } }
  option = { name = chaos.1.a ai_chance = { base = 1 } }
  option = { name = chaos.1.b ai_chance = { base = 3 } }
}
`;

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-prob-req-'));
  const mod = path.join(temporary, 'mod');
  const runtime = path.join(temporary, 'runtime');
  await mkdir(path.join(mod, 'common/decisions'), { recursive: true });
  await mkdir(path.join(mod, 'events'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Requested outputs"\n', 'utf8');
  await writeFile(path.join(mod, 'common/decisions/010_death.txt'), DECISIONS, 'utf8');
  await writeFile(path.join(mod, 'events/chaos.txt'), EVENTS, 'utf8');
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    storageRoots: [runtime],
    workspaces: [
      {
        id: 'requested',
        name: 'Requested outputs',
        root: mod,
        artifactRoot: path.join(runtime, 'artifacts'),
        cacheRoot: path.join(runtime, 'cache'),
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
  return { analyzer: new ProbabilityAnalyzer(engine), context: { workspaceId: 'requested' } };
}

const scenarioSet = (state: Record<string, number>) => ({
  schemaVersion: '1.0' as const,
  id: 'requested',
  scenarios: [{ id: 'ger', state }],
});

const sweepRequest = {
  analysis: 'sweep' as const,
  source: { path: 'common/decisions/010_death.txt' },
  candidatePool: ['death_consume_another_island'],
  scenarioSet: scenarioSet({ 'variable.death_souls': 10 }),
  sweep: { paths: ['variable.death_souls'], steps: 5, pairwise: false, findRankReversals: true },
  outputs: ['json' as const],
};

describe('probability tools honour the request', () => {
  it('treats days_remove = -1 as an ordinary decision and sweeps the requested steps', async () => {
    const { analyzer, context } = await fixture();
    const result = await analyzeProbabilities(
      analyzer,
      { ...sweepRequest, adapter: 'decision_ai_will_do' } as never,
      context,
    );
    expect(result.data).toMatchObject({ adapterId: 'decision_ai_will_do', sweepPoints: 5 });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PROBABILITY_SWEEP_RANGE_DEFAULTED',
        details: {
          ranges: [
            { scenarioId: 'ger', path: 'variable.death_souls', current: 10, min: 0, max: 20 },
          ],
        },
      }),
    );
  });

  it('spreads the steps over a declared range', async () => {
    const { analyzer, context } = await fixture();
    const result = await analyzeProbabilities(
      analyzer,
      {
        ...sweepRequest,
        adapter: 'decision_ai_will_do',
        scenarioSet: {
          ...scenarioSet({ 'variable.death_souls': 10 }),
          scenarios: [
            {
              id: 'ger',
              state: { 'variable.death_souls': 10 },
              uncertainInputs: [{ path: 'variable.death_souls', range: { min: 0, max: 4 } }],
            },
          ],
        },
      } as never,
      context,
    );
    expect(result.data).toMatchObject({ sweepPoints: 5 });
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'PROBABILITY_SWEEP_RANGE_DEFAULTED',
    );
  });

  it('keeps a timed mission on the mission adapter', async () => {
    const { analyzer, context } = await fixture();
    const result = await analyzeProbabilities(
      analyzer,
      {
        ...sweepRequest,
        candidatePool: ['death_timed_mission'],
        adapter: 'mission_ai_will_do',
      } as never,
      context,
    );
    expect(result.data).toMatchObject({ adapterId: 'mission_ai_will_do', sweepPoints: 5 });
  });

  it('refuses an explicit adapter that matches nothing instead of running another one', async () => {
    const { analyzer, context } = await fixture();
    await expect(
      analyzeProbabilities(
        analyzer,
        { ...sweepRequest, adapter: 'mission_ai_will_do' } as never,
        context,
      ),
    ).rejects.toMatchObject({
      code: 'PROBABILITY_SURFACE_EMPTY',
      message: expect.stringContaining('decision_ai_will_do'),
    });
  });

  const mtthRequest = {
    adapter: 'event_mean_time_to_happen' as const,
    source: { path: 'events/chaos.txt', identifier: 'chaos.1' },
    metrics: ['effective_mtth_days' as const, 'cumulative_chance' as const],
    scenarioSet: scenarioSet({ 'variable.pressure': 10 }),
  };

  it('computes the requested MTTH metrics when the horizon is given', async () => {
    const { analyzer, context } = await fixture();
    const result = await inspectProbabilities(
      analyzer,
      { ...mtthRequest, horizonDays: 20 } as never,
      context,
    );
    expect(result.data).toMatchObject({
      adapterId: 'event_mean_time_to_happen',
      ranking: [{ candidates: [{ id: 'chaos.1', mtthDays: 20 }] }],
    });
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'PROBABILITY_METRIC_NOT_COMPUTED',
    );
    const stored = await analyzer.evaluate({
      ...mtthRequest,
      workspaceId: 'requested',
      horizonDays: 20,
    } as never);
    expect(stored.scenarios[0]?.candidates[0]?.cumulativeChance).toBeGreaterThan(0);
  });

  it('explains a requested metric it cannot compute', async () => {
    const { analyzer, context } = await fixture();
    const result = await inspectProbabilities(analyzer, mtthRequest as never, context);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PROBABILITY_METRIC_NOT_COMPUTED',
        details: { metric: 'cumulative_chance', adapterId: 'event_mean_time_to_happen' },
        message: expect.stringContaining('horizonDays'),
      }),
    );
    const unresolved = await inspectProbabilities(
      analyzer,
      { ...mtthRequest, scenarioSet: scenarioSet({}), horizonDays: 20 } as never,
      context,
    );
    expect(unresolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PROBABILITY_METRIC_NOT_COMPUTED',
        message: expect.stringContaining('missingInputs'),
      }),
    );
  });

  it('evaluates an event id by default instead of returning the source inventory', async () => {
    const { analyzer, context } = await fixture();
    const result = await inspectProbabilities(
      analyzer,
      { source: { identifier: 'chaos.1' } } as never,
      context,
    );
    expect(result.data).toMatchObject({ adapterId: 'event_option_ai_chance', candidates: 2 });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PROBABILITY_ADAPTER_SELECTED',
        details: expect.objectContaining({ alternatives: ['event_mean_time_to_happen'] }),
      }),
    );
  });
});

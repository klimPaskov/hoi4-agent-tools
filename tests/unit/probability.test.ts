import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { probabilityAdapter } from '../../src/hoi4_agent_tools/probability/adapters.js';
import {
  Rational,
  uniformRaceProbabilities,
} from '../../src/hoi4_agent_tools/probability/rational.js';
import { ProbabilityAnalyzer } from '../../src/hoi4_agent_tools/probability/service.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

async function fixture(gameVersion?: {
  rawVersion: string;
  checksum: string;
}): Promise<{ engine: CoreEngine; workspaceId: string }> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-probability-'));
  const mod = path.join(temporary, 'mod');
  const runtime = path.join(temporary, 'runtime');
  const game = path.join(temporary, 'game');
  await Promise.all([
    mkdir(mod, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    ...(gameVersion === undefined ? [] : [mkdir(game, { recursive: true })]),
  ]);
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Probability fixture"\n', 'utf8');
  if (gameVersion !== undefined)
    await writeFile(
      path.join(game, 'launcher-settings.json'),
      `${JSON.stringify({
        version: `Fixture v${gameVersion.rawVersion} (${gameVersion.checksum})`,
        rawVersion: gameVersion.rawVersion,
      })}\n`,
      'utf8',
    );
  const workspaceId = 'probability-fixture';
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    storageRoots: [runtime],
    workspaces: [
      {
        id: workspaceId,
        name: 'Probability fixture',
        root: mod,
        ...(gameVersion === undefined ? {} : { gameRoot: game }),
        artifactRoot: path.join(runtime, 'artifacts'),
        cacheRoot: path.join(runtime, 'cache'),
      },
    ],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
  return { engine, workspaceId };
}

describe('probability arithmetic and adapters', () => {
  it('keeps decimal modifier arithmetic exact', () => {
    const tenth = Rational.parse('0.1')!;
    expect(tenth.toJSON()).toMatchObject({ numerator: '1', denominator: '10' });
    expect(tenth.add(Rational.parse('0.2')!).toJSON()).toMatchObject({
      numerator: '3',
      denominator: '10',
    });
  });

  it('computes the documented independent-uniform score race instead of weight share', () => {
    const probabilities = uniformRaceProbabilities([new Rational(1n), new Rational(2n)]);
    expect(probabilities.map((value) => value.toJSON())).toMatchObject([
      { numerator: '1', denominator: '4' },
      { numerator: '3', denominator: '4' },
    ]);
    const three = uniformRaceProbabilities([new Rational(3n), new Rational(5n), new Rational(9n)]);
    expect(three.reduce((sum, value) => sum.add(value), Rational.zero).toNumber()).toBe(1);
  });

  it('keeps exact score-race analysis practical for 1,000 candidates', () => {
    const probabilities = uniformRaceProbabilities(
      Array.from({ length: 1_000 }, (_, index) => new Rational(BigInt((index % 25) + 1))),
    );
    expect(probabilities).toHaveLength(1_000);
    expect(
      probabilities.reduce((sum, probability) => sum.add(probability), Rational.zero).toNumber(),
    ).toBeCloseTo(1, 12);
    expect(probabilities.every((probability) => probability.compare(Rational.zero) >= 0)).toBe(
      true,
    );
  });

  it('publishes distinct capabilities for categorical, score-only, random, and timing surfaces', () => {
    expect(probabilityAdapter('event_option_ai_chance').selectionRule).toBe(
      'proportional_categorical',
    );
    expect(probabilityAdapter('national_focus_ai_will_do').selectionRule).toBe(
      'uniform_score_race',
    );
    expect(probabilityAdapter('decision_ai_will_do').selectionRule).toBe('score_only');
    expect(probabilityAdapter('direct_random').selectionRule).toBe('independent_chance');
    expect(probabilityAdapter('event_mean_time_to_happen').capabilities.timeDistribution).toBe(
      true,
    );
    expect(probabilityAdapter('event_mean_time_to_happen')).toMatchObject({
      supportedGameVersions: ['Operation Postern 1.19.2.0 (d245)'],
    });
    expect(
      probabilityAdapter('event_mean_time_to_happen').candidateDiscoveryRules.length,
    ).toBeGreaterThan(0);
    expect(probabilityAdapter('event_mean_time_to_happen').testFixtures).toContain(
      'fixtures/probability',
    );
  });
});

describe('AI and MTTH analyzer', () => {
  it('records the verified installed game identity and rejects unsupported versions', async () => {
    const verified = await fixture({ rawVersion: '1.19.2.0', checksum: 'd245' });
    const verifiedResult = await new ProbabilityAnalyzer(verified.engine).evaluate({
      workspaceId: verified.workspaceId,
      adapter: 'direct_random',
      source: { inlineClausewitz: 'random = { chance = 50 }' },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'verified-game',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      metrics: ['raw_value'],
      outputs: ['json'],
    });
    expect(verifiedResult.metadata.gameVersionVerification).toMatchObject({
      status: 'workspace_verified',
      observedRawVersion: '1.19.2.0',
      observedChecksum: 'd245',
    });
    expect(verifiedResult.metadata.requestedMetrics).toEqual(['raw_value']);

    const unsupported = await fixture({ rawVersion: '1.20.0.0', checksum: 'ffff' });
    await expect(
      new ProbabilityAnalyzer(unsupported.engine).evaluate({
        workspaceId: unsupported.workspaceId,
        adapter: 'direct_random',
        source: { inlineClausewitz: 'random = { chance = 50 }' },
        scenarioSet: {
          schemaVersion: '1.0',
          id: 'unsupported-game',
          scenarios: [{ id: 'baseline', state: {} }],
        },
        outputs: ['json'],
      }),
    ).rejects.toMatchObject({ code: 'PROBABILITY_GAME_VERSION_UNSUPPORTED' });
  });

  it('evaluates focus score races and event option proportional pools independently', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const focusSource = `focus_tree = {
 id = sample
 focus = { id = first ai_will_do = { factor = 1 } }
 focus = { id = second ai_will_do = { factor = 2 } }
}`;
    const scenarioSet = {
      schemaVersion: '1.0' as const,
      id: 'exact',
      scenarios: [
        {
          id: 'baseline',
          state: { 'focus.external_factors_complete': true },
        },
      ],
    };
    const focus = await analyzer.evaluate({
      workspaceId,
      adapter: 'national_focus_ai_will_do',
      source: { inlineClausewitz: focusSource },
      scenarioSet,
      candidatePool: ['first', 'second'],
      outputs: ['json'],
    });
    expect(focus.status).toBe('complete');
    expect(
      focus.scenarios[0]?.candidates.map(({ conditionalProbability }) => conditionalProbability),
    ).toEqual([0.25, 0.75]);

    const event = await analyzer.evaluate({
      workspaceId,
      adapter: 'event_option_ai_chance',
      source: {
        inlineClausewitz: `country_event = {
 id = sample.1
 option = { name = sample.1.a ai_chance = { base = 1 } }
 option = { name = sample.1.b ai_chance = { base = 3 } }
}`,
      },
      scenarioSet: { ...scenarioSet, id: 'event', scenarios: [{ id: 'baseline', state: {} }] },
      outputs: ['json'],
    });
    expect(
      event.scenarios[0]?.candidates.map(({ conditionalProbability }) => conditionalProbability),
    ).toEqual([0.25, 0.75]);
  });

  it('keeps AST provenance and diagnoses modifier duplication and named target bands', async () => {
    const { engine, workspaceId } = await fixture();
    const result = await new ProbabilityAnalyzer(engine).evaluate({
      workspaceId,
      adapter: 'event_option_ai_chance',
      source: {
        inlineClausewitz: `country_event = {
 id = diagnostics.1
 option = {
  name = diagnostics.1.a
  ai_chance = {
   base = 0
   modifier = { factor = 2 has_war = yes }
   modifier = { factor = 2 has_war = yes }
   modifier = { factor = 3 has_war = yes }
  }
 }
 option = { name = diagnostics.1.b ai_chance = { base = 10 } }
}`,
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'diagnostic-bands',
        scenarios: [{ id: 'war', state: { has_war: true } }],
      },
      acceptanceBands: [
        {
          id: 'intended-common',
          scenarioId: 'war',
          candidateId: 'diagnostics.1.a',
          metric: 'conditional_probability',
          min: 0.2,
        },
        {
          id: 'rare-cap',
          scenarioId: 'war',
          candidateId: 'diagnostics.1.b',
          metric: 'conditional_probability',
          max: 0.5,
        },
      ],
      outputs: ['json'],
    });
    const first = result.scenarios[0]?.candidates[0];
    expect(first?.provenance[0]?.astPath).toBeDefined();
    expect(first?.trace.some(({ provenance }) => provenance?.astPath !== undefined)).toBe(true);
    const codes = new Set(result.diagnostics.map(({ code }) => code));
    expect(codes.has('PROBABILITY_DUPLICATE_MODIFIER')).toBe(true);
    expect(codes.has('PROBABILITY_CONFLICTING_MODIFIER_CONDITION')).toBe(true);
    expect(codes.has('PROBABILITY_INTENDED_OUTCOME_UNREACHABLE')).toBe(true);
    expect(codes.has('PROBABILITY_RARE_OUTCOME_UNEXPECTEDLY_COMMON')).toBe(true);
  });

  it('withholds non-finite values and reports unresolved scheduled timing intervals', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const nonFinite = await analyzer.evaluate({
      workspaceId,
      adapter: 'direct_random',
      source: { inlineClausewitz: 'random = { chance = 1e309 }' },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'non-finite',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      outputs: ['json'],
    });
    expect(nonFinite.scenarios[0]?.candidates[0]?.conditionalProbability).toBeNull();
    expect(nonFinite.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PROBABILITY_NON_FINITE_VALUE' }),
    );

    const schedule = await analyzer.evaluate({
      workspaceId,
      adapter: 'event_mean_time_to_happen',
      source: {
        inlineClausewitz:
          'country_event = { id = schedule.1 trigger = { has_war = yes } mean_time_to_happen = { days = 10 } option = { name = schedule.1.a } }',
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'unresolved-schedule',
        scenarios: [
          {
            id: 'missing-war-state',
            state: {},
            schedule: [{ atDay: 10, set: {} }],
          },
        ],
      },
      horizonDays: 20,
      outputs: ['json'],
    });
    expect(schedule.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MTTH_SCHEDULE_INTERVAL_UNRESOLVED' }),
    );
  });

  it('does not normalize a filtered event-option pool or sample an unresolved score race', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const event = await analyzer.evaluate({
      workspaceId,
      adapter: 'event_option_ai_chance',
      source: {
        identifier: 'sample.4',
        inlineClausewitz: `country_event = {
 id = sample.4
 option = { name = sample.4.a ai_chance = { base = 1 } }
 option = { name = sample.4.b ai_chance = { base = 2 } }
 option = { name = sample.4.c ai_chance = { base = 3 } }
}`,
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'partial-pool',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      candidatePool: ['sample.4.a', 'sample.4.b'],
      outputs: ['json'],
    });
    expect(event.scenarios[0]?.poolComplete).toBe(false);
    expect(
      event.scenarios[0]?.candidates.every(
        ({ conditionalProbability }) => conditionalProbability == null,
      ),
    ).toBe(true);

    const focus = await analyzer.simulate({
      workspaceId,
      adapter: 'national_focus_ai_will_do',
      source: {
        inlineClausewitz:
          'focus_tree = { id = sample focus = { id = first ai_will_do = { factor = 1 } } focus = { id = second ai_will_do = { factor = 2 } } }',
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'external-factors-missing',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      candidatePool: ['first', 'second'],
      samples: 1_000,
      seed: 17,
      confidenceLevel: 0.95,
      outputs: ['json'],
    });
    expect(
      focus.simulation?.[0]?.candidates.every(({ frequency }) => frequency === undefined),
    ).toBe(true);
    expect(focus.scenarios[0]?.supportLevel).toBe('external');
    expect(
      focus.scenarios[0]?.candidates.every(({ supportLevel }) => supportLevel === 'external'),
    ).toBe(true);
    expect(focus.unresolved.some(({ code }) => code === 'FOCUS_EXTERNAL_FACTORS_UNDECLARED')).toBe(
      true,
    );
  });

  it('keeps direct random independent and converts verified MTTH medians into horizon chance', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const scenarioSet = {
      schemaVersion: '1.0' as const,
      id: 'baseline',
      scenarios: [{ id: 'baseline', state: { has_war: true } }],
    };
    const random = await analyzer.evaluate({
      workspaceId,
      adapter: 'direct_random',
      source: { inlineClausewitz: 'random = { chance = 25 add_stability = 0.1 }' },
      scenarioSet,
      outputs: ['json'],
    });
    expect(random.scenarios[0]?.candidates[0]?.conditionalProbability).toBe(0.25);

    const mtth = await analyzer.evaluate({
      workspaceId,
      adapter: 'event_mean_time_to_happen',
      source: {
        inlineClausewitz: `country_event = {
 id = sample.2
 trigger = { has_war = yes }
 mean_time_to_happen = { days = 10 modifier = { factor = 2 has_war = yes } }
 option = { name = sample.2.a }
}`,
      },
      scenarioSet,
      horizonDays: 20,
      outputs: ['json'],
    });
    expect(mtth.scenarios[0]?.candidates[0]?.effectiveMtthDays).toBe(20);
    expect(mtth.scenarios[0]?.candidates[0]?.cumulativeChance).toBeCloseTo(0.5, 12);
  });

  it('attributes an acceptance-band regression during before-and-after comparison', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const source = (firstWeight: number) => `country_event = {
 id = compare.1
 option = { name = compare.1.a ai_chance = { base = ${firstWeight} } }
 option = { name = compare.1.b ai_chance = { base = 1 } }
}`;
    const result = await analyzer.compare({
      workspaceId,
      adapter: 'event_option_ai_chance',
      before: { inlineClausewitz: source(1) },
      after: { inlineClausewitz: source(0.1) },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'comparison-band',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      acceptanceBands: [
        {
          id: 'first-share',
          candidateId: 'compare.1.a',
          metric: 'conditional_probability',
          min: 0.4,
          max: 0.6,
        },
      ],
      outputs: ['json'],
    });
    expect(result.comparison?.regressions).toContainEqual(
      expect.objectContaining({
        code: 'ACCEPTANCE_BAND_REGRESSION',
        candidateId: 'compare.1.a',
      }),
    );
  });

  it('reports when the tested sweep never reaches a named target band', async () => {
    const { engine, workspaceId } = await fixture();
    const result = await new ProbabilityAnalyzer(engine).sweep({
      workspaceId,
      adapter: 'event_option_ai_chance',
      source: {
        inlineClausewitz:
          'country_event = { id = sweep.1 option = { name = sweep.1.a ai_chance = { base = variable.pressure } } option = { name = sweep.1.b ai_chance = { base = 100 } } }',
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'target-sweep',
        scenarios: [
          {
            id: 'range',
            state: {},
            uncertainInputs: [{ path: 'variable.pressure', range: { min: 0, max: 10 } }],
          },
        ],
      },
      sweep: {
        paths: ['variable.pressure'],
        steps: 11,
        pairwise: false,
        findRankReversals: true,
      },
      acceptanceBands: [
        {
          id: 'major-share',
          scenarioId: 'range',
          candidateId: 'sweep.1.a',
          metric: 'conditional_probability',
          min: 0.5,
        },
      ],
      outputs: ['json'],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PROBABILITY_SWEEP_TARGET_BAND_UNREACHED' }),
    );
    expect(result.sweep?.localElasticities.length).toBeGreaterThan(0);
  });

  it('measures selected pairwise sweep interactions', async () => {
    const { engine, workspaceId } = await fixture();
    const result = await new ProbabilityAnalyzer(engine).sweep({
      workspaceId,
      adapter: 'event_option_ai_chance',
      source: {
        inlineClausewitz: `country_event = {
 id = interaction.1
 option = {
  name = interaction.1.a
  ai_chance = {
   base = variable.left
   modifier = { factor = 3 check_variable = { var = right value = 5 compare = greater_than_or_equals } }
  }
 }
 option = { name = interaction.1.b ai_chance = { base = 10 } }
}`,
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'pairwise',
        scenarios: [
          {
            id: 'grid',
            state: {},
            uncertainInputs: [
              { path: 'variable.left', range: { min: 1, max: 10 } },
              { path: 'variable.right', range: { min: 0, max: 10 } },
            ],
          },
        ],
      },
      sweep: {
        paths: ['variable.left', 'variable.right'],
        steps: 3,
        pairwise: true,
        findRankReversals: true,
      },
      outputs: ['json'],
    });
    expect(
      result.sweep?.pairwiseInteractions.some(
        ({ candidateId, mixedDifference }) =>
          candidateId === 'interaction.1.a' && Math.abs(mixedDifference) > 0,
      ),
    ).toBe(true);
  });

  it('sweeps enumerated numeric alternatives without inventing intermediate values', async () => {
    const { engine, workspaceId } = await fixture();
    const result = await new ProbabilityAnalyzer(engine).sweep({
      workspaceId,
      adapter: 'direct_random',
      source: { inlineClausewitz: 'random = { chance = variable.chance }' },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'alternatives',
        scenarios: [
          {
            id: 'alternatives',
            state: {},
            uncertainInputs: [{ path: 'variable.chance', alternatives: [5, 15, 95] }],
          },
        ],
      },
      sweep: {
        paths: ['variable.chance'],
        steps: 10,
        pairwise: false,
        findRankReversals: true,
      },
      outputs: ['json'],
    });
    expect(result.sweep?.points.map(({ value }) => value)).toEqual([5, 15, 95]);
  });

  it('reports reproducible MTTH timing quantiles with order-statistic uncertainty', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const request = {
      workspaceId,
      adapter: 'event_mean_time_to_happen' as const,
      source: {
        inlineClausewitz:
          'country_event = { id = timing.1 mean_time_to_happen = { days = 10 } option = { name = timing.1.a } }',
      },
      scenarioSet: {
        schemaVersion: '1.0' as const,
        id: 'sampled-timing',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      samples: 20_000,
      seed: 771,
      confidenceLevel: 0.95,
      samplingMethod: 'latin_hypercube' as const,
      outputs: ['json' as const],
    };
    const first = await analyzer.simulate(request);
    const second = await analyzer.simulate(request);
    expect(first.simulation).toEqual(second.simulation);
    const timing = first.simulation?.[0]?.candidates[0];
    expect(first.simulation?.[0]?.samplingMethod).toBe('latin_hypercube');
    expect(timing).toMatchObject({
      timingSampleCount: 20_000,
      timingEvaluations: 20_000,
      timingMethod: 'sampled_discrete_daily_hazard',
      timingConfidenceMethod: 'normal_order_statistic',
    });
    expect(timing?.timingQuantilesDays?.p50).toBeCloseTo(10, 0);
    expect(timing?.timingQuantileIntervals?.p50.low).toBeLessThanOrEqual(
      timing!.timingQuantilesDays!.p50,
    );
    expect(timing?.timingQuantileIntervals?.p50.high).toBeGreaterThanOrEqual(
      timing!.timingQuantilesDays!.p50,
    );
  });

  it('selects a complete random_list pool from the parent block line', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const inspected = await analyzer.inspect({ workspaceId }, 'random_list', {
      inlineClausewitz: `random_list = {
 1 = { add_stability = 0.1 }
 99 = { add_war_support = 0.1 }
}`,
      line: 1,
    });
    expect(inspected.surface).toMatchObject({ candidateCount: 2, poolComplete: true });
  });

  it('retains full path probability for nested random_list candidates', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const source = `random_list = {
 25 = { add_stability = 0.1 }
 75 = {
  random_list = {
   1 = { add_war_support = 0.1 }
   3 = { add_political_power = 10 }
  }
 }
}`;
    const result = await analyzer.evaluate({
      workspaceId,
      adapter: 'random_list',
      source: { inlineClausewitz: source, line: 4 },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'nested-random',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      outputs: ['json'],
    });
    expect(
      result.scenarios[0]?.candidates.map(({ conditionalProbability }) =>
        Number(conditionalProbability?.toFixed(4)),
      ),
    ).toEqual([0.25, 0.75]);
    expect(
      result.scenarios[0]?.candidates.map(({ pathProbability }) =>
        Number(pathProbability?.toFixed(4)),
      ),
    ).toEqual([0.1875, 0.5625]);
    expect(result.scenarios[0]?.candidates.every(({ provenance }) => provenance.length >= 2)).toBe(
      true,
    );
  });

  it('makes missing scenario inputs visible and produces deterministic seeded samples', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const request = {
      workspaceId,
      adapter: 'event_option_ai_chance' as const,
      source: {
        inlineClausewitz: `country_event = {
 id = sample.3
 option = { name = sample.3.a ai_chance = { base = 1 modifier = { factor = 5 has_war = yes } } }
 option = { name = sample.3.b ai_chance = { base = 2 } }
}`,
      },
      scenarioSet: {
        schemaVersion: '1.0' as const,
        id: 'uncertain',
        scenarios: [
          {
            id: 'sampled',
            state: {},
            uncertainInputs: [
              {
                path: 'has_war',
                distribution: {
                  kind: 'categorical' as const,
                  values: [true, false],
                  probabilities: [0.4, 0.6],
                },
              },
            ],
          },
        ],
      },
      samples: 10_000,
      seed: 90210,
      confidenceLevel: 0.95,
      outputs: ['json' as const],
    };
    const first = await analyzer.simulate(request);
    const second = await analyzer.simulate(request);
    expect(first.analysisId).toBe(second.analysisId);
    expect(first.simulation).toEqual(second.simulation);
    expect(first.simulation?.[0]?.candidates[0]?.frequency).toBeGreaterThan(0.3);
  });

  it('supports continuous correlations and reports categorical or invalid correlation requests', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const base = {
      workspaceId,
      adapter: 'direct_random' as const,
      source: { inlineClausewitz: 'random = { chance = variable.chance }' },
      samples: 2_000,
      seed: 614,
      confidenceLevel: 0.95,
      outputs: ['json' as const],
    };
    const continuous = await analyzer.simulate({
      ...base,
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'continuous-correlation',
        scenarios: [
          {
            id: 'continuous',
            state: {},
            uncertainInputs: [
              { path: 'variable.chance', distribution: { kind: 'normal', mean: 50, stddev: 5 } },
              { path: 'variable.peer', distribution: { kind: 'normal', mean: 0, stddev: 1 } },
            ],
            correlations: [{ left: 'variable.chance', right: 'variable.peer', coefficient: 0.75 }],
          },
        ],
      },
    });
    expect(continuous.unresolved).toEqual([]);
    expect(continuous.simulation?.[0]?.samplingMethod).toBe('latin_hypercube');
    expect(continuous.simulation?.[0]?.candidates[0]?.rawMean).toBeCloseTo(50, 0);
    expect(
      continuous.simulation?.[0]?.globalImportance.find(({ path }) => path === 'variable.chance')
        ?.score,
    ).toBeGreaterThan(0.99);

    const categorical = await analyzer.simulate({
      ...base,
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'categorical-correlation',
        scenarios: [
          {
            id: 'categorical',
            state: {},
            uncertainInputs: [
              {
                path: 'variable.chance',
                distribution: { kind: 'categorical', values: [25, 75] },
              },
            ],
            correlations: [{ left: 'variable.chance', right: 'variable.peer', coefficient: 0.5 }],
          },
        ],
      },
    });
    expect(
      categorical.unresolved.some(({ code }) => code === 'CATEGORICAL_CORRELATION_UNSUPPORTED'),
    ).toBe(true);
    expect(
      categorical.unresolved.some(({ code }) => code === 'CORRELATED_INPUTS_SAMPLED_INDEPENDENTLY'),
    ).toBe(true);

    const invalid = await analyzer.simulate({
      ...base,
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'invalid-correlation',
        scenarios: [
          {
            id: 'invalid',
            state: {},
            uncertainInputs: [
              { path: 'variable.chance', distribution: { kind: 'normal', mean: 50, stddev: 5 } },
              { path: 'variable.peer', distribution: { kind: 'normal', mean: 0, stddev: 1 } },
              { path: 'variable.third', distribution: { kind: 'normal', mean: 0, stddev: 1 } },
            ],
            correlations: [
              { left: 'variable.chance', right: 'variable.peer', coefficient: 0.9 },
              { left: 'variable.chance', right: 'variable.third', coefficient: 0.9 },
              { left: 'variable.peer', right: 'variable.third', coefficient: -0.9 },
            ],
          },
        ],
      },
    });
    expect(invalid.unresolved.some(({ code }) => code === 'CORRELATION_MATRIX_INVALID')).toBe(true);
    expect(
      invalid.unresolved.some(({ code }) => code === 'CORRELATED_INPUTS_SAMPLED_INDEPENDENTLY'),
    ).toBe(true);
  });

  it('stratifies numeric ranges and preserves the direction of declared Gaussian correlations', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const range = await analyzer.simulate({
      workspaceId,
      adapter: 'direct_random',
      source: { inlineClausewitz: 'random = { chance = variable.chance }' },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'lhs-range',
        scenarios: [
          {
            id: 'range',
            state: {},
            uncertainInputs: [{ path: 'variable.chance', range: { min: 0, max: 100 } }],
          },
        ],
      },
      samples: 100,
      seed: 88,
      confidenceLevel: 0.95,
      samplingMethod: 'latin_hypercube',
      outputs: ['json'],
    });
    expect(range.simulation?.[0]?.candidates[0]?.rawMean).toBeCloseTo(50, 1);

    const source = `country_event = {
 id = correlation.1
 option = {
  name = correlation.1.a
  ai_chance = {
   base = variable.left
   modifier = {
    factor = 2
    check_variable = { var = peer value = 0 compare = greater_than }
   }
  }
 }
 option = { name = correlation.1.b ai_chance = { base = 100 } }
}`;
    const analyze = (coefficient: number) =>
      analyzer.simulate({
        workspaceId,
        adapter: 'event_option_ai_chance',
        source: { inlineClausewitz: source },
        scenarioSet: {
          schemaVersion: '1.0',
          id: `correlation-${coefficient}`,
          scenarios: [
            {
              id: 'sampled',
              state: {},
              uncertainInputs: [
                {
                  path: 'variable.left',
                  distribution: { kind: 'normal' as const, mean: 50, stddev: 10 },
                },
                {
                  path: 'variable.peer',
                  distribution: { kind: 'normal' as const, mean: 0, stddev: 1 },
                },
              ],
              correlations: [{ left: 'variable.left', right: 'variable.peer', coefficient }],
            },
          ],
        },
        samples: 20_000,
        seed: 991,
        confidenceLevel: 0.95,
        samplingMethod: 'latin_hypercube' as const,
        outputs: ['json' as const],
      });
    const positive = await analyze(0.9);
    const negative = await analyze(-0.9);
    const positiveMean = positive.simulation?.[0]?.candidates[0]?.rawMean ?? 0;
    const negativeMean = negative.simulation?.[0]?.candidates[0]?.rawMean ?? 0;
    expect(positiveMean).toBeGreaterThan(negativeMean + 5);
  });

  it('analyzes only declared custom-pool state transitions', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const result = await analyzer.sequence({
      workspaceId,
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'sequence',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'pool',
        selection: { mode: 'categorical_weighted', cadence: 'daily' },
        candidates: [
          { id: 'once', weight: 1, oneTime: true },
          { id: 'repeat', weight: 1 },
        ],
        transitions: [
          {
            when: 'selected.one_time == true',
            actions: [{ operation: 'remove', target: 'selected.candidate', value: null }],
          },
        ],
      },
      horizonDays: 3,
      maxSteps: 3,
      samples: 1_000,
      seed: 7,
      confidenceLevel: 0.95,
      outputs: ['json'],
    });
    expect(result.sequence?.method).toBe('exact_state_distribution');
    expect(
      result.sequence?.candidates.find(({ id }) => id === 'once')?.expectedSelections,
    ).toBeCloseTo(0.875, 12);
  });

  it('enumerates small independent-chance sequence pools exactly', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const result = await analyzer.sequence({
      workspaceId,
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'independent-sequence',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'independent-pool',
        selection: { mode: 'independent_chances', cadence: 'daily' },
        candidates: [
          { id: 'coin', weight: 50 },
          { id: 'quarter', weight: 25 },
        ],
        transitions: [],
      },
      horizonDays: 1,
      maxSteps: 1,
      samples: 1_000,
      seed: 9,
      confidenceLevel: 0.95,
      outputs: ['json'],
    });
    expect(result.sequence?.method).toBe('exact_state_distribution');
    expect(result.sequence?.candidates).toMatchObject([
      { id: 'coin', expectedSelections: 0.5, everSelectedProbability: 0.5 },
      { id: 'quarter', expectedSelections: 0.25, everSelectedProbability: 0.25 },
    ]);
  });

  it('honors recovery, cap reduction, cooldown expiry, category reset, and termination', async () => {
    const { engine, workspaceId } = await fixture();
    const analyzer = new ProbabilityAnalyzer(engine);
    const base = {
      workspaceId,
      scenarioSet: {
        schemaVersion: '1.0' as const,
        id: 'transition-semantics',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      samples: 1_000,
      seed: 81,
      confidenceLevel: 0.95,
      outputs: ['json' as const],
    };

    const recovery = await analyzer.sequence({
      ...base,
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'recovery',
        selection: { mode: 'categorical_weighted', cadence: 'daily' },
        candidates: [{ id: 'recovering', weight: 0, cap: 1 }],
        recovery: [{ cadence: 'daily', target: 'candidate.recovering.weight', amount: 1, cap: 1 }],
        transitions: [],
      },
      horizonDays: 1,
      maxSteps: 1,
    });
    expect(recovery.sequence?.candidates[0]).toMatchObject({
      nextSelectionProbability: 1,
      expectedSelections: 1,
    });

    const cap = await analyzer.sequence({
      ...base,
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'cap',
        selection: { mode: 'categorical_weighted', cadence: 'daily' },
        candidates: [{ id: 'capped', weight: 1, cap: 1 }],
        transitions: [
          {
            when: 'selected.id == capped',
            actions: [
              { operation: 'multiply', target: 'candidate.capped.cap', value: 0 },
              {
                operation: 'cap',
                target: 'candidate.capped.weight',
                value: 'candidate.capped.cap',
              },
            ],
          },
        ],
      },
      horizonDays: 3,
      maxSteps: 3,
    });
    expect(cap.sequence?.candidates[0]?.countDistribution).toEqual([{ count: 1, probability: 1 }]);

    const cooldown = await analyzer.sequence({
      ...base,
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'cooldown',
        selection: { mode: 'categorical_weighted', cadence: 'daily' },
        candidates: [{ id: 'cooling', weight: 1, cooldownDays: 2 }],
        transitions: [],
      },
      horizonDays: 3,
      maxSteps: 3,
    });
    expect(cooldown.sequence?.candidates[0]?.countDistribution).toEqual([
      { count: 2, probability: 1 },
    ]);

    const terminal = await analyzer.sequence({
      ...base,
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'reset-and-terminate',
        selection: {
          mode: 'categorical_weighted',
          cadence: 'timer',
          timerMinDays: 2,
          timerMaxDays: 2,
        },
        candidates: [{ id: 'major', category: 'major', weight: 1 }],
        transitions: [
          {
            when: 'selected.category == major',
            actions: [
              { operation: 'reset_category', target: 'category.major', value: 0 },
              { operation: 'compress_timer', target: 'selection.timer_max_days', value: 1 },
              { operation: 'reset_timer', target: 'selection', value: null },
              { operation: 'terminate', target: 'selection', value: null },
            ],
          },
        ],
      },
      horizonDays: 10,
      maxSteps: 5,
    });
    expect(terminal.sequence).toMatchObject({ terminalProbability: 1, steps: 2 });
    expect(terminal.sequence?.categories).toEqual([
      {
        id: 'major',
        nextSelectionProbability: 1,
        expectedSelections: 1,
        everSelectedProbability: 1,
        starvationProbability: 0,
        expectedFirstSelectionDay: 2,
      },
    ]);
    expect(terminal.sequence?.topPaths[0]).toMatchObject({
      candidateIds: ['major'],
      terminal: true,
      endDay: 2,
    });
  });
});

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import type {
  CustomWeightedPoolManifest,
  ProbabilityScenarioSet,
} from '../../src/hoi4_agent_tools/probability/model.js';
import {
  Rational,
  uniformRaceProbabilities,
} from '../../src/hoi4_agent_tools/probability/rational.js';
import { ProbabilityAnalyzer } from '../../src/hoi4_agent_tools/probability/service.js';
import { DeterministicRandom } from '../../src/hoi4_agent_tools/probability/simulation.js';
import { probabilityAnalysisResultSchema } from '../../src/hoi4_agent_tools/schemas/probability.js';

const fixtureRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'probability');
const fixtureWorkspace = path.join(fixtureRoot, 'workspace');
let temporary = '';
let engine: CoreEngine;
let analyzer: ProbabilityAnalyzer;
let scenarios: ProbabilityScenarioSet;
let customPool: CustomWeightedPoolManifest;
let expectedResults: {
  identities: Record<string, unknown>;
  requiredUnresolvedCodes: string[];
  requiredDiagnosticCodes: string[];
  sourceLocations: Array<{
    adapter: string;
    candidateId: string;
    path: string;
    line: number;
    column: number;
    astPath: string[];
  }>;
};

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-probability-acceptance-'));
  const runtime = path.join(temporary, 'runtime');
  await mkdir(runtime, { recursive: true });
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    storageRoots: [runtime],
    workspaces: [
      {
        id: 'probability-acceptance',
        name: 'Probability acceptance fixture',
        root: fixtureWorkspace,
        artifactRoot: path.join(runtime, 'artifacts'),
        cacheRoot: path.join(runtime, 'cache'),
      },
    ],
  });
  engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  analyzer = new ProbabilityAnalyzer(engine);
  scenarios = JSON.parse(
    await readFile(path.join(fixtureRoot, 'scenarios.json'), 'utf8'),
  ) as ProbabilityScenarioSet;
  customPool = JSON.parse(
    await readFile(path.join(fixtureRoot, 'custom-pool.json'), 'utf8'),
  ) as CustomWeightedPoolManifest;
  expectedResults = JSON.parse(
    await readFile(path.join(fixtureRoot, 'expected-results.json'), 'utf8'),
  ) as typeof expectedResults;
});

afterAll(async () => rm(temporary, { recursive: true, force: true }));

describe('AI and MTTH acceptance corpus', () => {
  it('contains the required weighted surfaces, 250 named scenarios, expected results, and stateful pool', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'),
    ) as {
      inventory: Record<string, number>;
    };
    expect(manifest.inventory).toMatchObject({
      focusCandidateSets: 40,
      decisionMissionSets: 30,
      technologySets: 20,
      eventOptionSets: 25,
      randomSets: 20,
      mtthFamilies: 15,
      weightedBlocksMinimum: 150,
      scenarios: 250,
    });
    expect(scenarios.scenarios).toHaveLength(250);
    expect(new Set(scenarios.scenarios.map(({ id }) => id)).size).toBe(250);
    expect(
      customPool.transitions.some(({ actions }) =>
        actions.some(({ operation }) => operation === 'remove'),
      ),
    ).toBe(true);
    expect(customPool.recovery?.length).toBeGreaterThan(0);
    expect(expectedResults.requiredUnresolvedCodes).toContain('TRIGGER_UNRESOLVED');
    expect(expectedResults.requiredDiagnosticCodes).toContain(
      'PROBABILITY_ALL_ELIGIBLE_VALUES_ZERO',
    );
    expect(expectedResults.sourceLocations).toHaveLength(3);
  });

  it('matches exact categorical, score-race, direct-random, all-zero, and MTTH manifests', async () => {
    const baseScenario = {
      schemaVersion: '1.0' as const,
      id: 'exact',
      scenarios: [
        {
          id: 'exact',
          state: {
            has_war: false,
            is_major: false,
            'variable.pressure': 0,
            'focus.external_factors_complete': true,
            'technology.external_factors_complete': true,
          },
          flags: ['synthetic_active'],
        },
      ],
    };
    const focus = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'national_focus_ai_will_do',
      source: { identifier: 'synthetic_focus_00_a' },
      scenarioSet: baseScenario,
      candidatePool: ['synthetic_focus_00_a', 'synthetic_focus_00_b', 'synthetic_focus_00_c'],
      outputs: ['json'],
    });
    expect(
      focus.scenarios[0]?.candidates.map(
        ({ exactConditionalProbability }) =>
          `${exactConditionalProbability?.numerator}/${exactConditionalProbability?.denominator}`,
      ),
    ).toEqual(['1/18', '11/36', '23/36']);
    expect(probabilityAnalysisResultSchema.safeParse(focus).success).toBe(true);

    const options = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      source: { identifier: 'synthetic_options.1' },
      scenarioSet: baseScenario,
      outputs: ['json'],
    });
    expect(
      options.scenarios[0]?.candidates.map(
        ({ exactConditionalProbability }) =>
          `${exactConditionalProbability?.numerator}/${exactConditionalProbability?.denominator}`,
      ),
    ).toEqual(['1/6', '1/3', '1/2']);
    const optionLocation = expectedResults.sourceLocations.find(
      ({ candidateId }) => candidateId === 'synthetic_options.1.a',
    )!;
    expect(options.scenarios[0]?.candidates[0]?.provenance[0]).toMatchObject({
      path: optionLocation.path,
      astPath: optionLocation.astPath,
      location: {
        start: { line: optionLocation.line, column: optionLocation.column },
      },
    });

    const allZero = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      source: {
        inlineClausewitz:
          'country_event = { id = zero.1 option = { name = zero.a ai_chance = { base = 0 } } option = { name = zero.b ai_chance = { base = -5 } } }',
      },
      scenarioSet: baseScenario,
      outputs: ['json'],
    });
    expect(
      allZero.scenarios[0]?.candidates.map(({ conditionalProbability }) => conditionalProbability),
    ).toEqual([1, 0]);

    const mtth = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_mean_time_to_happen',
      source: {
        inlineClausewitz:
          'country_event = { id = median.1 trigger = { always = yes } mean_time_to_happen = { days = 30 } option = { name = median.a } }',
      },
      scenarioSet: baseScenario,
      horizonDays: 30,
      outputs: ['json'],
    });
    expect(mtth.scenarios[0]?.candidates[0]?.cumulativeChance).toBeCloseTo(0.5, 14);
  });

  it('evaluates all 250 scenarios without truncating the scenario matrix', async () => {
    const result = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      source: { identifier: 'synthetic_options.1' },
      scenarioSet: scenarios,
      outputs: ['json'],
    });
    expect(result.scenarios).toHaveLength(250);
    expect(result.resources[0]?.mimeType).toBe('application/json');
    expect(result.unresolved.some(({ code }) => code === 'DISTRIBUTION_REQUIRES_SIMULATION')).toBe(
      true,
    );
  });

  it('resolves file-local constants, global script constants, MTTH variables, and scripted-trigger helpers', async () => {
    const focus = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'national_focus_ai_will_do',
      source: { identifier: 'synthetic_focus_00_a' },
      candidatePool: ['synthetic_focus_00_a', 'synthetic_focus_00_b', 'synthetic_focus_00_c'],
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'helpers',
        scenarios: [
          {
            id: 'helpers',
            state: {
              has_war: true,
              'variable.pressure': 60,
              'focus.external_factors_complete': true,
            },
          },
        ],
      },
      outputs: ['json'],
    });
    expect(focus.scenarios[0]?.candidates[2]?.rawValue).toMatchObject({ value: 4.5 });
    expect(
      focus.scenarios[0]?.candidates.some(({ provenance }) =>
        provenance.some(({ path }) =>
          path.replaceAll('\\', '/').includes('common/scripted_triggers/'),
        ),
      ),
    ).toBe(true);
    expect(
      focus.scenarios[0]?.candidates.some(({ provenance }) =>
        provenance.some(({ symbol }) => symbol === '@focus_factor'),
      ),
    ).toBe(true);

    const mtth = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_mean_time_to_happen',
      source: { identifier: 'synthetic_mtth.1' },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'constants',
        scenarios: [
          {
            id: 'constants',
            state: { has_war: true, 'variable.pressure': 60 },
            flags: ['synthetic_active'],
          },
        ],
      },
      horizonDays: 15,
      outputs: ['json'],
    });
    expect(mtth.scenarios[0]?.candidates[0]?.effectiveMtthDays).toBe(15);
    expect(mtth.scenarios[0]?.candidates[0]?.cumulativeChance).toBeCloseTo(0.5, 14);
  });

  it('keeps exact probabilities normalized, scale invariant, monotone, and insensitive to ineligible candidates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 2, maxLength: 8 }),
        fc.integer({ min: 1, max: 1_000 }),
        (weights, scale) => {
          const base = uniformRaceProbabilities(
            weights.map((value) => new Rational(BigInt(value))),
          );
          const scaled = uniformRaceProbabilities(
            weights.map((value) => new Rational(BigInt(value * scale))),
          );
          expect(base.reduce((sum, value) => sum.add(value), Rational.zero).toNumber()).toBeCloseTo(
            1,
            12,
          );
          expect(scaled.map((value) => value.toNumber())).toEqual(
            base.map((value) => value.toNumber()),
          );
        },
      ),
      { numRuns: 100 },
    );
    const baseline = uniformRaceProbabilities([new Rational(2n), new Rational(3n)]);
    const withIneligible = uniformRaceProbabilities([
      new Rational(2n),
      new Rational(3n),
      Rational.zero,
    ]);
    expect(withIneligible.slice(0, 2).map((value) => value.toNumber())).toEqual(
      baseline.map((value) => value.toNumber()),
    );
    const raised = uniformRaceProbabilities([new Rational(4n), new Rational(3n)]);
    expect(raised[0]!.compare(baseline[0]!)).toBeGreaterThanOrEqual(0);
  });

  it('keeps interval endpoints safe and cumulative MTTH chance monotone', async () => {
    const bounded = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      source: {
        inlineClausewitz: `country_event = {
 id = interval.1
 option = { name = interval.a ai_chance = { base = 1 modifier = { factor = 5 check_variable = { var = pressure value = 50 compare = greater_than_or_equals } } } }
 option = { name = interval.b ai_chance = { base = 2 } }
}`,
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'bounded',
        scenarios: [
          {
            id: 'bounded',
            state: {},
            uncertainInputs: [{ path: 'variable.pressure', range: { min: 0, max: 100 } }],
          },
        ],
      },
      outputs: ['json'],
    });
    const interval = bounded.scenarios[0]?.candidates[0]?.conditionalProbabilityInterval;
    expect(interval).toBeDefined();
    expect(interval!.low).toBeLessThanOrEqual(1 / 3);
    expect(interval!.high).toBeGreaterThanOrEqual(5 / 7);

    const chances: number[] = [];
    for (const horizonDays of [1, 10, 30, 90, 365]) {
      const timing = await analyzer.evaluate({
        workspaceId: 'probability-acceptance',
        adapter: 'event_mean_time_to_happen',
        source: {
          inlineClausewitz:
            'country_event = { id = monotone.1 trigger = { always = yes } mean_time_to_happen = { days = 30 } option = { name = monotone.a } }',
        },
        scenarioSet: {
          schemaVersion: '1.0',
          id: `horizon-${horizonDays}`,
          scenarios: [{ id: 'baseline', state: {} }],
        },
        horizonDays,
        outputs: ['json'],
      });
      const chance = timing.scenarios[0]?.candidates[0]?.cumulativeChance;
      expect(chance).toBeGreaterThanOrEqual(0);
      expect(chance).toBeLessThanOrEqual(1);
      chances.push(chance!);
    }
    expect(chances).toEqual([...chances].sort((left, right) => left - right));

    const polled = await analyzer.evaluate({
      workspaceId: 'probability-acceptance',
      adapter: 'event_mean_time_to_happen',
      source: {
        inlineClausewitz:
          'country_event = { id = polled.1 trigger = { has_war = yes } mean_time_to_happen = { days = 30 } option = { name = polled.a } }',
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'polling',
        scenarios: [
          {
            id: 'polling',
            state: { has_war: false },
            schedule: [{ atDay: 10, set: { has_war: true } }],
          },
        ],
      },
      horizonDays: 40,
      outputs: ['json'],
    });
    expect(polled.scenarios[0]?.candidates[0]?.cumulativeChanceInterval).toBeDefined();
    expect(polled.unresolved.some(({ code }) => code === 'MTTH_POLL_PHASE_UNDECLARED')).toBe(true);
  });

  it('makes seeded sampling deterministic and statistically consistent with exact results', async () => {
    const request = {
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance' as const,
      source: { identifier: 'synthetic_options.1' },
      scenarioSet: {
        schemaVersion: '1.0' as const,
        id: 'sample',
        scenarios: [{ id: 'sample', state: { has_war: false }, flags: [] }],
      },
      samples: 100_000,
      seed: 3819,
      confidenceLevel: 0.95,
      outputs: ['json' as const],
    };
    const first = await analyzer.simulate(request);
    const second = await analyzer.simulate(request);
    expect(first.simulation).toEqual(second.simulation);
    const frequencies = first.simulation?.[0]?.candidates.map(({ frequency }) => frequency!);
    expect(frequencies?.[0]).toBeCloseTo(1 / 6, 2);
    expect(frequencies?.[1]).toBeCloseTo(1 / 3, 2);
    expect(frequencies?.[2]).toBeCloseTo(1 / 2, 2);
  });

  it('attributes identity comparisons without regressions and executes the declared stateful pool', async () => {
    const scenarioSet = {
      schemaVersion: '1.0' as const,
      id: 'compare',
      scenarios: [{ id: 'baseline', state: {} }],
    };
    const source = {
      inlineClausewitz:
        'country_event = { id = compare.1 option = { name = compare.a ai_chance = { base = 1 } } option = { name = compare.b ai_chance = { base = 2 } } }',
    };
    const comparison = await analyzer.compare({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      before: source,
      after: source,
      scenarioSet,
      outputs: ['json'],
    });
    expect(comparison.comparison?.scenarioChanges).toEqual([]);
    expect(comparison.comparison?.regressions).toEqual([]);

    const sequence = await analyzer.sequence({
      workspaceId: 'probability-acceptance',
      scenarioSet,
      customPoolManifest: customPool,
      horizonDays: 180,
      maxSteps: 6,
      samples: 10_000,
      seed: 991,
      confidenceLevel: 0.95,
      outputs: ['json'],
    });
    expect(sequence.sequence?.candidates).toHaveLength(3);
    expect(sequence.sequence?.steps).toBeGreaterThan(0);
    expect(sequence.sequence?.terminalProbability).toBeGreaterThanOrEqual(0);
    expect(sequence.sequence?.terminalProbability).toBeLessThanOrEqual(1);
    expect(sequence.sequence?.topPaths.length).toBeGreaterThan(0);
    expect(
      sequence.sequence?.candidates
        .find(({ id }) => id === 'minor_fire_once')
        ?.countDistribution.every(({ count }) => count <= 1),
    ).toBe(true);
    expect(
      sequence.sequence?.candidates.find(({ id }) => id === 'major_crisis')
        ?.everSelectedProbability,
    ).toBeGreaterThan(0);
    expect(sequence.sequence?.terminalProbability).toBeGreaterThan(0);
    expect(probabilityAnalysisResultSchema.safeParse(sequence).success).toBe(true);
  });

  it('finds sweep reversals, aggregates prevalence, and attributes a changed source term', async () => {
    const source = `country_event = {
 id = sweep.1
 option = { name = sweep.a ai_chance = { base = 1 modifier = { factor = 10 check_variable = { var = pressure value = 50 compare = greater_than_or_equals } } } }
 option = { name = sweep.b ai_chance = { base = 2 } }
}`;
    const scenarioSet = {
      schemaVersion: '1.0' as const,
      id: 'sweep-and-prevalence',
      scenarios: [
        {
          id: 'range',
          prevalence: 0.25,
          state: {},
          uncertainInputs: [{ path: 'variable.pressure', range: { min: 0, max: 100 } }],
        },
        {
          id: 'high',
          prevalence: 0.75,
          state: { 'variable.pressure': 100 },
        },
      ],
    };
    const swept = await analyzer.sweep({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      source: { inlineClausewitz: source },
      scenarioSet,
      sweep: {
        paths: ['variable.pressure'],
        steps: 5,
        pairwise: false,
        findRankReversals: true,
      },
      outputs: ['json'],
    });
    expect(swept.sweep?.points.length).toBeGreaterThanOrEqual(6);
    expect(swept.sweep?.rankReversals).toContainEqual(
      expect.objectContaining({
        scenarioId: 'range',
        beforeLeader: 'sweep.b',
        afterLeader: 'sweep.a',
      }),
    );
    expect(swept.prevalenceAggregate).toMatchObject({ prevalenceTotal: 1 });

    const compared = await analyzer.compare({
      workspaceId: 'probability-acceptance',
      adapter: 'event_option_ai_chance',
      before: {
        inlineClausewitz:
          'country_event = { id = patch.1 option = { name = patch.a ai_chance = { base = 1 } } option = { name = patch.b ai_chance = { base = 2 } } }',
      },
      after: {
        inlineClausewitz:
          'country_event = { id = patch.1 option = { name = patch.a ai_chance = { base = 4 } } option = { name = patch.b ai_chance = { base = 2 } } }',
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'patch',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      outputs: ['json'],
    });
    const change = compared.comparison?.scenarioChanges.find(
      ({ candidateId }) => candidateId === 'patch.a',
    );
    expect(change).toMatchObject({ rawDelta: 3, probabilityDelta: 1 / 3, rankDelta: -1 });
    expect(change?.attribution.some((item) => item.includes('base'))).toBe(true);
    expect(change?.changedAstPaths.length).toBeGreaterThan(0);
  });

  it('reports inspect inputs and Monte Carlo sequence method metadata', async () => {
    const inspected = await analyzer.inspect(
      { workspaceId: 'probability-acceptance' },
      'national_focus_ai_will_do',
      { identifier: 'synthetic_focus_00_a' },
      ['synthetic_focus_00_a', 'synthetic_focus_00_b', 'synthetic_focus_00_c'],
    );
    expect(inspected.surface?.requiredInputs).toContain('focus.external_factors_complete');
    expect(
      inspected.surface?.candidates.some(
        ({ referencedProvenance }) => referencedProvenance.length > 0,
      ),
    ).toBe(true);

    const largePool = {
      schemaVersion: '1.0' as const,
      id: 'large-sequence',
      selection: { mode: 'categorical_weighted' as const, cadence: 'daily' as const },
      candidates: Array.from({ length: 25 }, (_, index) => ({
        id: `candidate_${index}`,
        weight: 1,
      })),
      transitions: [],
    };
    const sequence = await analyzer.sequence({
      workspaceId: 'probability-acceptance',
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'large-sequence',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      customPoolManifest: largePool,
      horizonDays: 10,
      maxSteps: 10,
      samples: 2_000,
      seed: 445,
      confidenceLevel: 0.9,
      outputs: ['json'],
    });
    expect(sequence.sequence).toMatchObject({
      method: 'seeded_monte_carlo',
      samples: 2_000,
      seed: 445,
      rng: 'mulberry32',
      stoppingRule: 'fixed_sample_budget',
      confidenceLevel: 0.9,
    });
  });

  it('sustains one million deterministic simple draws without an analysis ceiling', () => {
    const random = new DeterministicRandom(73);
    let selected = 0;
    for (let index = 0; index < 1_000_000; index += 1) if (random.next() < 0.25) selected += 1;
    expect(selected / 1_000_000).toBeCloseTo(0.25, 2);
  });
});

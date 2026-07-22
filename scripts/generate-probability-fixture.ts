import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';

const root = path.resolve(import.meta.dirname, '..', 'fixtures', 'probability');

async function put(relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function putWorkspace(relativePath: string, content: string): Promise<void> {
  return put(path.join('workspace', relativePath), content);
}

async function json(value: unknown): Promise<string> {
  return format(JSON.stringify(value), {
    parser: 'json',
    printWidth: 100,
    endOfLine: 'lf',
  });
}

function focusTrees(): string {
  return Array.from({ length: 40 }, (_, set) => {
    const prefix = `synthetic_focus_${String(set).padStart(2, '0')}`;
    return `focus_tree = {
\tid = ${prefix}_tree
\tcountry = { factor = 0 modifier = { add = 10 tag = S${String(set).padStart(2, '0')} } }
\tfocus = {
\t\tid = ${prefix}_a
\t\tx = 0
\t\ty = 0
\t\tcost = 10
\t\tai_will_do = { factor = 1 modifier = { factor = 2 check_variable = { var = pressure value = 50 compare = greater_than_or_equals } } }
\t\tcompletion_reward = { add_political_power = 1 }
\t}
\tfocus = {
\t\tid = ${prefix}_b
\t\tx = 1
\t\ty = 1
\t\tcost = 10
\t\tprerequisite = { focus = ${prefix}_a }
\t\tai_will_do = { factor = 2 modifier = { add = 1 has_war = yes } }
\t\tcompletion_reward = { add_political_power = 1 }
\t}
\tfocus = {
\t\tid = ${prefix}_c
\t\tx = -1
\t\ty = 1
\t\tcost = 10
\t\tprerequisite = { focus = ${prefix}_a }
\t\tai_will_do = { factor = 3 modifier = { factor = @focus_factor has_synthetic_helper = yes } }
\t\tcompletion_reward = { add_political_power = 1 }
\t}
}
`;
  }).join('\n');
}

function decisions(): string {
  return Array.from({ length: 30 }, (_, set) => {
    const prefix = `synthetic_decision_${String(set).padStart(2, '0')}`;
    return `${prefix}_category = {
\t${prefix}_choice = {
\t\tavailable = { has_war = no }
\t\tai_will_do = { base = 1 modifier = { factor = 4 check_variable = { var = pressure value = 75 compare = greater_than } } }
\t\tcomplete_effect = { add_political_power = 1 }
\t}
\t${prefix}_mission = {
\t\tdays_mission_timeout = 30
\t\tavailable = { has_country_flag = mission_enabled }
\t\tai_will_do = { factor = 2 modifier = { add = 3 is_major = yes } }
\t\ttimeout_effect = { add_political_power = -1 }
\t}
}
`;
  }).join('\n');
}

function technologies(): string {
  const definitions = Array.from({ length: 20 }, (_, set) =>
    Array.from({ length: 3 }, (_, candidate) => {
      const id = `synthetic_tech_${String(set).padStart(2, '0')}_${candidate}`;
      return `${id} = {
\tstart_year = ${1936 + set}
\tresearch_cost = 1
\tfolder = { name = synthetic_industry position = { x = ${candidate} y = ${set} } }
\tai_will_do = { factor = ${candidate + 1} modifier = { factor = 2 has_war = yes } }
\tproduction_speed_buildings_factor = 0.01
}`;
    }).join('\n'),
  ).join('\n');
  return `technologies = {
${definitions}
}
`;
}

function doctrines(): string {
  return Array.from(
    { length: 10 },
    (_, index) => `synthetic_doctrine_${index} = {
\tfolder = synthetic_doctrine_folder
\tai_will_do = { factor = ${index + 1} modifier = { factor = 0.5 has_war = no } }
}
`,
  ).join('\n');
}

function events(): string {
  const optionEvents = Array.from(
    { length: 25 },
    (_, set) => `country_event = {
\tid = synthetic_options.${set + 1}
\tis_triggered_only = yes
\toption = { name = synthetic_options.${set + 1}.a ai_chance = { base = 10 } }
\toption = { name = synthetic_options.${set + 1}.b ai_chance = { base = 20 modifier = { factor = 2 has_war = yes } } }
\toption = { name = synthetic_options.${set + 1}.c ai_chance = { base = 30 modifier = { factor = 0 has_country_flag = disabled_option } } }
}
`,
  ).join('\n');
  const mtthEvents = Array.from(
    { length: 15 },
    (_, set) => `country_event = {
\tid = synthetic_mtth.${set + 1}
\ttrigger = { has_country_flag = synthetic_active }
\tmean_time_to_happen = {
\t\tdays = ${30 + set}
\t\tmodifier = { factor = mtth:synthetic_pressure_mtth check_variable = { var = pressure value = 50 compare = greater_than_or_equals } }
\t\tmodifier = { factor = constant:synthetic_probability.mtth_war_factor has_war = yes }
\t}
\toption = { name = synthetic_mtth.${set + 1}.a }
}
`,
  ).join('\n');
  const randomBlocks = Array.from(
    { length: 20 },
    (_, set) => `country_event = {
\tid = synthetic_random.${set + 1}
\tis_triggered_only = yes
\timmediate = {
\t\trandom = { chance = ${25 + (set % 4) * 10} add_political_power = 1 }
\t\trandom_list = {
\t\t\t10 = { add_political_power = 1 }
\t\t\t20 = { add_stability = 0.01 }
\t\t\t30 = { add_war_support = 0.01 }
\t\t}
\t}
\toption = { name = synthetic_random.${set + 1}.a }
}
`,
  ).join('\n');
  return `add_namespace = synthetic_options
add_namespace = synthetic_mtth
add_namespace = synthetic_random

${optionEvents}
${mtthEvents}
${randomBlocks}`;
}

function scenarios() {
  return {
    schemaVersion: '1.0',
    id: 'synthetic_probability_scenarios',
    surfaceHint: 'national_focus_ai_will_do',
    description:
      'Two hundred and fifty deterministic, bounded, sampled, and unresolved world states.',
    scenarios: Array.from({ length: 250 }, (_, index) => ({
      id: `scenario_${String(index).padStart(3, '0')}`,
      label: `Synthetic world state ${index}`,
      prevalence: 1 / 250,
      actor: `S${String(index % 40).padStart(2, '0')}`,
      date: `${1936 + Math.floor(index / 50)}.1.1`,
      state: {
        has_war: index % 2 === 0,
        is_major: index % 5 === 0,
        'variable.pressure': (index * 7) % 101,
        'focus.external_factors_complete': true,
        'technology.external_factors_complete': true,
        'research_weight_factor.all': index % 7 === 0 ? 25 : 0,
      },
      flags: [
        'synthetic_active',
        ...(index % 3 === 0 ? ['mission_enabled'] : []),
        ...(index % 17 === 0 ? ['disabled_option'] : []),
      ],
      ...(index % 25 === 0
        ? {
            uncertainInputs: [
              { path: 'variable.pressure', range: { min: 25, max: 85 } },
              { path: 'has_war', alternatives: [true, false] },
            ],
          }
        : {}),
      ...(index % 40 === 0
        ? {
            uncertainInputs: [
              {
                path: 'variable.pressure',
                distribution: { kind: 'triangular', min: 10, mode: 50, max: 95 },
              },
              {
                path: 'has_war',
                distribution: {
                  kind: 'categorical',
                  values: [true, false],
                  probabilities: [0.35, 0.65],
                },
              },
            ],
          }
        : {}),
      ...(index === 249
        ? { uncertainInputs: [{ path: 'unsupported.scope_value', unresolved: true }] }
        : {}),
      ...(index % 50 === 0
        ? {
            schedule: [
              { atDay: 60, set: { 'variable.pressure': 60 } },
              { atDay: 120, set: { has_war: true }, addFlags: ['mission_enabled'] },
            ],
          }
        : {}),
    })),
  };
}

function customPool() {
  return {
    schemaVersion: '1.0',
    id: 'synthetic_adaptive_pool',
    selection: {
      mode: 'categorical_weighted',
      cadence: 'timer',
      timerMinDays: 45,
      timerMaxDays: 60,
      rounding: 'nearest',
    },
    state: { minor_events_since_major: 0, major_gain: 150, timer_compression: 0 },
    candidates: [
      {
        id: 'minor_fire_once',
        category: 'fire_once',
        weight: 1000,
        cap: 1000,
        eligibleWhen: 'not selected.minor_fire_once',
        oneTime: true,
      },
      {
        id: 'minor_repeatable',
        category: 'repeatable',
        weight: 1000,
        cap: 1000,
        eligibleWhen: 'true',
        cooldownDays: 75,
      },
      {
        id: 'major_crisis',
        category: 'major',
        weight: 0,
        cap: 1000,
        eligibleWhen: 'not selected.major_crisis',
        oneTime: true,
      },
    ],
    recovery: [
      {
        cadence: 'monthly',
        target: 'candidate.minor_repeatable.weight',
        amount: 20,
        cap: 'candidate.minor_repeatable.cap',
      },
    ],
    transitions: [
      {
        when: 'selected.category != major',
        actions: [
          { operation: 'add', target: 'state.minor_events_since_major', value: 1 },
          { operation: 'add', target: 'candidate.major_crisis.weight', value: 'state.major_gain' },
          {
            operation: 'compress_timer',
            target: 'selection.timer_max_days',
            value: 'floor(state.minor_events_since_major / 3)',
          },
        ],
      },
      {
        when: 'selected.id == minor_repeatable',
        actions: [
          { operation: 'multiply', target: 'candidate.minor_repeatable.cap', value: 0.5 },
          {
            operation: 'cap',
            target: 'candidate.minor_repeatable.weight',
            value: 'candidate.minor_repeatable.cap',
          },
        ],
      },
      {
        when: 'selected.category == major',
        actions: [
          { operation: 'set', target: 'state.minor_events_since_major', value: 0 },
          { operation: 'reset_category', target: 'category.major', value: 0 },
          { operation: 'reset_timer', target: 'selection', value: null },
          { operation: 'terminate', target: 'selection', value: null },
        ],
      },
      {
        when: 'selected.one_time == true',
        actions: [{ operation: 'remove', target: 'selected.candidate', value: null }],
      },
    ],
  };
}

await rm(root, { recursive: true, force: true });
await putWorkspace('descriptor.mod', 'name="Synthetic probability fixture"\n');
await putWorkspace(
  'common/national_focus/synthetic_probability_focuses.txt',
  `@focus_factor = 1.5\n\n${focusTrees()}`,
);
await putWorkspace('common/decisions/synthetic_probability_decisions.txt', decisions());
await putWorkspace('common/technologies/synthetic_probability_technologies.txt', technologies());
await putWorkspace(
  'common/doctrines/subdoctrines/synthetic_probability_doctrines.txt',
  doctrines(),
);
await putWorkspace('events/synthetic_probability_events.txt', events());
await putWorkspace(
  'common/scripted_triggers/synthetic_probability_triggers.txt',
  `has_synthetic_helper = {
\tOR = {
\t\thas_war = yes
\t\tcheck_variable = { var = pressure value = 60 compare = greater_than_or_equals }
\t}
}

synthetic_recursive_a = { synthetic_recursive_b = yes }
synthetic_recursive_b = { synthetic_recursive_a = yes }
`,
);
await putWorkspace(
  'common/script_constants/synthetic_probability_constants.txt',
  `synthetic_probability = {
\tschema = { any_key = yes data = fixed_point }
\tmtth_war_factor = 0.5
\tstrategy_bonus = 25
}
`,
);
await putWorkspace(
  'common/mtth/synthetic_probability_mtth.txt',
  `synthetic_pressure_mtth = {
\tbase = 1
\tmodifier = { factor = 0.5 check_variable = { var = pressure value = 80 compare = greater_than_or_equals } }
}
`,
);
await putWorkspace(
  'common/ai_strategy/synthetic_probability_strategy.txt',
  `synthetic_probability_strategy = {
\tenable = { always = yes }
\tabort = { always = no }
\tai_strategy = { type = research_weight_factor id = synthetic_tech_00_0 value = 50 }
\tai_strategy = { type = research_tech id = synthetic_tech_00_1 value = 1 }
}
`,
);
await put('scenarios.json', await json(scenarios()));
await put('custom-pool.json', await json(customPool()));
const expected = {
  schemaVersion: 'probability-fixture-expected.v1',
  inventory: {
    focusCandidateSets: 40,
    decisionMissionSets: 30,
    technologySets: 20,
    doctrineSets: 10,
    eventOptionSets: 25,
    randomSets: 20,
    mtthFamilies: 15,
    weightedBlocksMinimum: 150,
    scenarios: 250,
  },
  identities: {
    proportionalWeights: [10, 20, 30],
    proportionalProbabilities: ['1/6', '1/3', '1/2'],
    uniformRaceWeights: [1, 2, 3],
    uniformRaceProbabilities: ['1/18', '11/36', '23/36'],
    directRandom: { chance: 25, probability: '1/4' },
    mtth: { medianDays: 30, horizonDays: 30, cumulativeChance: '1/2' },
    allZeroEventOptionWinner: 0,
    scaleInvarianceFactor: 17,
  },
  requiredUnresolvedCodes: [
    'TRIGGER_UNRESOLVED',
    'VALUE_UNRESOLVED',
    'DISTRIBUTION_REQUIRES_SIMULATION',
    'SCENARIO_INPUT_UNRESOLVED',
    'MTTH_RECURSION',
    'CATEGORICAL_CORRELATION_UNSUPPORTED',
  ],
  requiredDiagnosticCodes: [
    'PROBABILITY_ALL_ELIGIBLE_VALUES_ZERO',
    'PROBABILITY_CANDIDATE_POOL_INCOMPLETE',
    'PROBABILITY_MODIFIER_UNSATISFIED_IN_SCENARIOS',
    'PROBABILITY_NEGATIVE_VALUE_CLAMPED',
    'MTTH_HORIZON_CHANCE_NEGLIGIBLE',
  ],
  sourceLocations: [
    {
      adapter: 'event_option_ai_chance',
      candidateId: 'synthetic_options.1.a',
      path: 'mod:events/synthetic_probability_events.txt',
      line: 8,
      column: 11,
      astPath: ['country_event[0]', 'option[0]'],
    },
    {
      adapter: 'national_focus_ai_will_do',
      candidateId: 'synthetic_focus_00_a',
      path: 'mod:common/national_focus/synthetic_probability_focuses.txt',
      line: 6,
      column: 2,
      astPath: ['focus_tree[0]', 'focus[0]'],
    },
    {
      adapter: 'event_mean_time_to_happen',
      candidateId: 'synthetic_mtth.1',
      path: 'mod:events/synthetic_probability_events.txt',
      line: 205,
      column: 1,
      astPath: ['country_event[25]'],
    },
  ],
};
await put('expected-results.json', await json(expected));

const files: Record<string, { bytes: number; sha256: string }> = {};
for (const [relativePath, content] of [
  ['scenarios.json', await json(scenarios())],
  ['custom-pool.json', await json(customPool())],
  ['expected-results.json', await json(expected)],
] as const) {
  files[relativePath] = {
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}
await put(
  'manifest.json',
  await json({
    schemaVersion: 'probability-fixture-manifest.v1',
    generatedBy: 'scripts/generate-probability-fixture.ts',
    inventory: expected.inventory,
    files,
  }),
);

process.stderr.write(
  'Generated probability fixture with 250 scenarios and more than 150 weighted blocks.\n',
);

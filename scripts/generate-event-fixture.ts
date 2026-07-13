import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';

type EventType =
  'country_event' | 'news_event' | 'state_event' | 'unit_leader_event' | 'operative_leader_event';

type EdgeReason =
  | 'option_event_call'
  | 'immediate_event_call'
  | 'hidden_event_call'
  | 'after_event_call'
  | 'delayed_event_call'
  | 'random_event_call'
  | 'weighted_event_call'
  | 'scripted_effect_call'
  | 'scripted_effect_expansion'
  | 'on_action_entry'
  | 'focus_entry'
  | 'decision_entry'
  | 'mission_entry'
  | 'country_setup_entry'
  | 'state_setup_entry'
  | 'unresolved_dynamic_reference';

interface ExpectedEdge {
  callerId: string;
  targetId: string;
  reason: EdgeReason;
  sourcePath: string;
  sourceNeedle: string;
  container: string;
  delay?: string;
  weight?: string;
  helperStack?: string[];
  unresolved?: boolean;
}

interface ExpectedEntry {
  id: string;
  kind: 'on_action' | 'focus' | 'decision' | 'mission' | 'country_setup' | 'state_setup';
  targetId: string;
  reason: EdgeReason;
  sourcePath: string;
}

interface ExpectedDefinition {
  id: string;
  logicalId: string;
  type: EventType;
  sourcePath: string;
  duplicateOrdinal: number;
}

const fixtureRoot = path.resolve(import.meta.dirname, '..', 'fixtures', 'event');
const namespaces = [
  'synthetic_alpha',
  'synthetic_beta',
  'synthetic_gamma',
  'synthetic_delta',
] as const;
const definitions: ExpectedDefinition[] = [];
const edges: ExpectedEdge[] = [];
const entries: ExpectedEntry[] = [];
const files = new Map<string, string>();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

async function prettyJson(value: unknown): Promise<string> {
  return format(JSON.stringify(canonical(value)), {
    parser: 'json',
    printWidth: 100,
    endOfLine: 'lf',
  });
}

function eventType(namespace: string, number: number): EventType {
  if (namespace !== 'synthetic_delta') return 'country_event';
  if (number >= 61 && number <= 64) return 'news_event';
  if (number >= 65 && number <= 68) return 'state_event';
  if (number >= 69 && number <= 72) return 'unit_leader_event';
  if (number >= 73 && number <= 76) return 'operative_leader_event';
  return 'country_event';
}

function typeForId(id: string): EventType {
  const match = /^(synthetic_[a-z]+)\.(\d+)$/u.exec(id);
  return match === null ? 'country_event' : eventType(match[1] ?? '', Number(match[2]));
}

function callLine(targetId: string): string {
  return `${typeForId(targetId)} = { id = ${targetId} }`;
}

function recordEdge(
  callerId: string,
  targetId: string,
  reason: EdgeReason,
  sourcePath: string,
  container: string,
  extra: Pick<ExpectedEdge, 'delay' | 'weight' | 'helperStack' | 'unresolved'> = {},
): void {
  edges.push({
    callerId,
    targetId,
    reason,
    sourcePath,
    sourceNeedle: targetId.replace(/^(?:helper|unresolved):/u, ''),
    container,
    ...extra,
  });
}

function option(name: string, lines: string[]): string[] {
  return ['\toption = {', `\t\tname = ${name}`, ...lines.map((line) => `\t\t${line}`), '\t}'];
}

function specialBody(
  namespace: string,
  number: number,
  id: string,
  sourcePath: string,
): string[] | undefined {
  const key = `${namespace}.${number}`;
  const directOption = (target: string): string[] => {
    recordEdge(id, target, 'option_event_call', sourcePath, 'option:a');
    return option(`${id}.a`, [callLine(target)]);
  };
  switch (key) {
    case 'synthetic_alpha.1':
      recordEdge(id, 'synthetic_alpha.2', 'option_event_call', sourcePath, 'option:a');
      recordEdge(id, 'synthetic_alpha.3', 'option_event_call', sourcePath, 'option:b');
      return [
        '\timmediate = {',
        '\t\tset_country_flag = synthetic_chain_started',
        '\t\tset_variable = { synthetic_counter = 1 }',
        '\t\tsave_event_target_as = synthetic_origin',
        '\t}',
        ...option(`${id}.a`, [callLine('synthetic_alpha.2')]),
        ...option(`${id}.b`, [callLine('synthetic_alpha.3')]),
      ];
    case 'synthetic_alpha.2':
      recordEdge(id, 'synthetic_alpha.4', 'hidden_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'add_to_variable = { synthetic_counter = 1 }',
        'hidden_effect = {',
        `\t${callLine('synthetic_alpha.4')}`,
        '}',
      ]);
    case 'synthetic_alpha.3':
      recordEdge(id, 'synthetic_alpha.4', 'weighted_event_call', sourcePath, 'option:a', {
        weight: '70',
      });
      recordEdge(id, 'synthetic_alpha.5', 'weighted_event_call', sourcePath, 'option:a', {
        weight: '30',
      });
      return option(`${id}.a`, [
        'random_list = {',
        `\t70 = { ${callLine('synthetic_alpha.4')} }`,
        `\t30 = { ${callLine('synthetic_alpha.5')} }`,
        '}',
      ]);
    case 'synthetic_alpha.4':
      recordEdge(
        id,
        'helper:synthetic_alpha_outer',
        'scripted_effect_call',
        sourcePath,
        'option:a',
      );
      return option(`${id}.a`, ['synthetic_alpha_outer = yes']);
    case 'synthetic_alpha.5':
      return directOption('synthetic_alpha.6');
    case 'synthetic_alpha.6':
      recordEdge(id, 'synthetic_alpha.7', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'trigger = {',
        '\thas_country_flag = synthetic_chain_started',
        '\tcheck_variable = { synthetic_counter > 0 }',
        '}',
        callLine('synthetic_alpha.7'),
      ]);
    case 'synthetic_alpha.7':
      recordEdge(id, 'synthetic_alpha.8', 'delayed_event_call', sourcePath, 'option:a', {
        delay: 'days=4,random_days=2',
      });
      return option(`${id}.a`, [
        'save_event_target_as = synthetic_transient_target',
        'country_event = { id = synthetic_alpha.8 days = 4 random_days = 2 }',
      ]);
    case 'synthetic_alpha.8':
      recordEdge(id, 'synthetic_alpha.9', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'event_target:synthetic_transient_target = { set_country_flag = synthetic_target_seen }',
        callLine('synthetic_alpha.9'),
      ]);
    case 'synthetic_alpha.10':
      recordEdge(id, 'synthetic_alpha.11', 'after_event_call', sourcePath, 'after');
      return [
        '\tafter = {',
        `\t\t${callLine('synthetic_alpha.11')}`,
        '\t}',
        ...option(`${id}.a`, [
          'clr_country_flag = synthetic_chain_started',
          'clr_variable = synthetic_counter',
        ]),
      ];
    case 'synthetic_alpha.20':
      recordEdge(id, 'synthetic_alpha.21', 'immediate_event_call', sourcePath, 'immediate');
      return ['\timmediate = {', `\t\t${callLine('synthetic_alpha.21')}`, '\t}'];
    case 'synthetic_alpha.21':
      recordEdge(id, 'synthetic_alpha.20', 'immediate_event_call', sourcePath, 'immediate');
      return ['\timmediate = {', `\t\t${callLine('synthetic_alpha.20')}`, '\t}'];
    case 'synthetic_alpha.22':
      recordEdge(id, id, 'immediate_event_call', sourcePath, 'immediate');
      return ['\timmediate = {', `\t\t${callLine(id)}`, '\t}'];
    case 'synthetic_alpha.30':
      recordEdge(id, 'synthetic_alpha.31', 'delayed_event_call', sourcePath, 'option:a', {
        delay: 'days=3',
      });
      return option(`${id}.a`, ['country_event = { id = synthetic_alpha.31 days = 3 }']);
    case 'synthetic_alpha.31':
      recordEdge(id, 'synthetic_alpha.30', 'delayed_event_call', sourcePath, 'option:a', {
        delay: 'days=3',
      });
      return option(`${id}.a`, ['country_event = { id = synthetic_alpha.30 days = 3 }']);
    case 'synthetic_alpha.40':
      recordEdge(
        id,
        'unresolved:synthetic_alpha.[?synthetic_dynamic_event]',
        'unresolved_dynamic_reference',
        sourcePath,
        'option:a',
        {
          unresolved: true,
        },
      );
      return option(`${id}.a`, [
        'meta_effect = {',
        '\ttext = { country_event = { id = synthetic_alpha.[?synthetic_dynamic_event] } }',
        '}',
      ]);
    case 'synthetic_alpha.39':
      return option(`${id}.a`, ['set_country_flag = synthetic_pre_dynamic_terminal']);
    case 'synthetic_alpha.50':
      return directOption('synthetic_alpha.999');
    case 'synthetic_alpha.51':
      recordEdge(id, 'synthetic_alpha.52', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'trigger = { has_country_flag = synthetic_never_written_gate }',
        callLine('synthetic_alpha.52'),
      ]);
    case 'synthetic_alpha.52':
      recordEdge(id, 'synthetic_alpha.53', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'event_target:synthetic_never_saved_target = { set_country_flag = synthetic_impossible }',
        callLine('synthetic_alpha.53'),
      ]);
    case 'synthetic_alpha.53':
      recordEdge(id, 'synthetic_alpha.54', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'save_global_event_target_as = synthetic_leaked_global_target',
        callLine('synthetic_alpha.54'),
      ]);
    case 'synthetic_alpha.54':
      recordEdge(id, 'synthetic_alpha.55', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'add_to_array = { synthetic_participants = ROOT }',
        callLine('synthetic_alpha.55'),
      ]);
    case 'synthetic_alpha.55':
      recordEdge(id, 'synthetic_alpha.56', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'if = { limit = { is_in_array = { synthetic_participants = ROOT } } clear_array = synthetic_participants }',
        callLine('synthetic_alpha.56'),
      ]);
    case 'synthetic_alpha.58':
      return option(`${id}.a`, ['trigger = { has_country_flag = synthetic_chain_started }']);
    case 'synthetic_alpha.60':
      recordEdge(id, 'synthetic_delta.65', 'immediate_event_call', sourcePath, 'immediate');
      recordEdge(id, 'synthetic_delta.69', 'immediate_event_call', sourcePath, 'immediate');
      return [
        '\timmediate = {',
        '\t\tstate_event = { id = synthetic_delta.65 }',
        '\t\tunit_leader_event = { id = synthetic_delta.69 }',
        '\t}',
      ];
    case 'synthetic_alpha.68':
      return option(`${id}.a`, ['set_country_flag = synthetic_detached_predecessor_terminal']);
    case 'synthetic_alpha.69':
      return option(`${id}.a`, ['set_country_flag = synthetic_isolated_boundary']);
    case 'synthetic_beta.1':
      recordEdge(id, 'synthetic_beta.2', 'option_event_call', sourcePath, 'option:a');
      recordEdge(id, 'synthetic_beta.3', 'option_event_call', sourcePath, 'option:b');
      return [
        '\timmediate = { set_global_flag = synthetic_world_alarm }',
        ...option(`${id}.a`, [callLine('synthetic_beta.2')]),
        ...option(`${id}.b`, [callLine('synthetic_beta.3')]),
      ];
    case 'synthetic_beta.2':
    case 'synthetic_beta.3':
      return directOption('synthetic_beta.4');
    case 'synthetic_beta.10':
      recordEdge(id, 'synthetic_beta.11', 'random_event_call', sourcePath, 'option:a', {
        weight: '60',
      });
      recordEdge(id, 'synthetic_beta.12', 'random_event_call', sourcePath, 'option:a', {
        weight: '40',
      });
      recordEdge(id, 'synthetic_beta.13', 'random_event_call', sourcePath, 'option:a', {
        weight: '-5',
      });
      return option(`${id}.a`, [
        'random_events = {',
        '\t60 = synthetic_beta.11',
        '\t40 = synthetic_beta.12',
        '\t-5 = synthetic_beta.13',
        '}',
      ]);
    case 'synthetic_beta.20':
      recordEdge(id, 'synthetic_beta.21', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'if = { limit = { has_country_flag = synthetic_cycle_gate } country_event = synthetic_beta.21 }',
      ]);
    case 'synthetic_beta.21':
      return directOption('synthetic_beta.22');
    case 'synthetic_beta.22':
      return directOption('synthetic_beta.20');
    case 'synthetic_beta.30':
      recordEdge(id, 'helper:synthetic_beta_outer', 'scripted_effect_call', sourcePath, 'option:a');
      return option(`${id}.a`, ['synthetic_beta_outer = yes']);
    case 'synthetic_beta.40':
      recordEdge(
        id,
        'unresolved:synthetic_stage_[?synthetic_stage]',
        'unresolved_dynamic_reference',
        sourcePath,
        'option:a',
        {
          unresolved: true,
        },
      );
      return option(`${id}.a`, [
        'meta_effect = { text = { synthetic_stage_[?synthetic_stage] = yes } }',
      ]);
    case 'synthetic_beta.41':
      recordEdge(
        id,
        'unresolved:synthetic_missing_helper',
        'scripted_effect_call',
        sourcePath,
        'option:a',
        { unresolved: true },
      );
      return option(`${id}.a`, ['synthetic_missing_helper = yes']);
    case 'synthetic_beta.50':
      recordEdge(id, 'synthetic_beta.51', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'trigger = { has_global_flag = synthetic_world_alarm }',
        'clr_global_flag = synthetic_world_alarm',
        callLine('synthetic_beta.51'),
      ]);
    case 'synthetic_beta.52':
      recordEdge(id, 'synthetic_beta.53', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'save_global_event_target_as = synthetic_managed_global_target',
        callLine('synthetic_beta.53'),
      ]);
    case 'synthetic_beta.53':
      recordEdge(id, 'synthetic_beta.54', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'global_event_target:synthetic_managed_global_target = { set_country_flag = synthetic_managed_target_read_once }',
        'save_global_event_target_as = synthetic_managed_global_target',
        callLine('synthetic_beta.54'),
      ]);
    case 'synthetic_beta.54':
      recordEdge(id, 'synthetic_beta.55', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'global_event_target:synthetic_managed_global_target = { set_country_flag = synthetic_managed_target_read_twice }',
        'clear_global_event_target = synthetic_managed_global_target',
        callLine('synthetic_beta.55'),
      ]);
    case 'synthetic_gamma.10':
      recordEdge(id, 'synthetic_gamma.11', 'random_event_call', sourcePath, 'option:a', {
        weight: 'chance=35',
      });
      recordEdge(id, 'synthetic_gamma.12', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'random = { chance = 35 country_event = synthetic_gamma.11 }',
        callLine('synthetic_gamma.12'),
      ]);
    case 'synthetic_gamma.20':
      recordEdge(id, 'synthetic_gamma.21', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'save_scope_as = synthetic_saved_country',
        callLine('synthetic_gamma.21'),
      ]);
    case 'synthetic_gamma.21':
      recordEdge(id, 'synthetic_gamma.22', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'scope:synthetic_saved_country = { set_country_flag = synthetic_saved_scope_read }',
        'clear_saved_scope = synthetic_saved_country',
        callLine('synthetic_gamma.22'),
      ]);
    case 'synthetic_gamma.30':
      recordEdge(id, 'synthetic_gamma.31', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'set_variable = { global.synthetic_pressure = 2 }',
        callLine('synthetic_gamma.31'),
      ]);
    case 'synthetic_gamma.31':
      recordEdge(id, 'synthetic_gamma.32', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'trigger = { check_variable = { global.synthetic_pressure > 0 } }',
        callLine('synthetic_gamma.32'),
      ]);
    case 'synthetic_gamma.79':
      return option(`${id}.a`, ['set_country_flag = synthetic_pre_automatic_terminal']);
    case 'synthetic_delta.64':
    case 'synthetic_delta.72':
    case 'synthetic_delta.76':
      return option(`${id}.a`, ['set_global_flag = synthetic_typed_event_terminal']);
    case 'synthetic_delta.68':
      return option(`${id}.a`, [
        'clr_state_flag = synthetic_state_ready',
        'set_global_flag = synthetic_typed_event_terminal',
      ]);
    case 'synthetic_delta.65':
      recordEdge(id, 'synthetic_delta.66', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'set_state_flag = synthetic_state_ready',
        'state_event = synthetic_delta.66',
      ]);
    case 'synthetic_delta.66':
      recordEdge(id, 'synthetic_delta.67', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'trigger = { has_state_flag = synthetic_state_ready }',
        'state_event = synthetic_delta.67',
      ]);
    case 'synthetic_delta.67':
      recordEdge(id, 'synthetic_alpha.60', 'option_event_call', sourcePath, 'option:a');
      recordEdge(id, 'synthetic_delta.68', 'option_event_call', sourcePath, 'option:a');
      return option(`${id}.a`, [
        'owner = { country_event = synthetic_alpha.60 }',
        'state_event = synthetic_delta.68',
      ]);
    case 'synthetic_delta.79':
      return directOption('synthetic_delta.80');
    case 'synthetic_delta.80':
      return option(`${id}.a`, ['set_country_flag = synthetic_duplicate_definition_reached']);
    default:
      return undefined;
  }
}

function renderEvent(namespace: string, number: number, sourcePath: string): string {
  const logicalId = `${namespace}.${number}`;
  const id = namespace === 'synthetic_delta' && number === 80 ? 'synthetic_delta.79' : logicalId;
  const duplicateOrdinal = definitions.filter((definition) => definition.id === id).length + 1;
  const type = eventType(namespace, number);
  definitions.push({ id, logicalId, type, sourcePath, duplicateOrdinal });
  let body = specialBody(namespace, number, id, sourcePath);
  if (body === undefined) {
    if (number === 80) body = option(`${id}.a`, ['set_country_flag = synthetic_terminal_reached']);
    else {
      const targetId = `${namespace}.${number + 1}`;
      recordEdge(id, targetId, 'option_event_call', sourcePath, 'option:a');
      body = option(`${id}.a`, [callLine(targetId)]);
    }
  }
  return [
    `${type} = {`,
    `\tid = ${id}`,
    `\ttitle = ${id}.t`,
    `\tdesc = ${id}.d`,
    ...(namespace === 'synthetic_gamma' && number === 80
      ? [
          '\tis_triggered_only = no',
          '\ttrigger = { always = yes }',
          '\tmean_time_to_happen = { days = 1 }',
        ]
      : ['\tis_triggered_only = yes']),
    ...(number === 80 && namespace === 'synthetic_delta'
      ? ['\t# Intentional duplicate definition of synthetic_delta.79.']
      : []),
    ...body,
    '}',
    '',
  ].join('\n');
}

for (const namespace of namespaces) {
  for (const [start, end, suffix] of [
    [1, 40, '01'],
    [41, 80, '02'],
  ] as const) {
    const sourcePath = `workspace/events/${namespace}_${suffix}.txt`;
    const blocks: string[] = [
      '# Project-owned synthetic Event Chain Viewer acceptance fixture.',
      '# Generated deterministically; event triggering mode is explicit.',
      `add_namespace = ${namespace}`,
      '',
    ];
    for (let number = start; number <= end; number += 1)
      blocks.push(renderEvent(namespace, number, sourcePath));
    files.set(sourcePath, `${blocks.join('\n').trimEnd()}\n`);
  }
}

const helperPath = 'workspace/common/scripted_effects/synthetic_event_helpers.txt';
const helperSource = [
  '# Nested helpers intentionally cross several call frames.',
  'synthetic_alpha_outer = {',
  '\tset_country_flag = synthetic_helper_entered',
  '\tsynthetic_alpha_middle = yes',
  '}',
  'synthetic_alpha_middle = { synthetic_alpha_inner = yes }',
  'synthetic_alpha_inner = { country_event = { id = synthetic_alpha.6 hours = 6 } }',
  '',
  'synthetic_beta_outer = { synthetic_beta_middle = yes }',
  'synthetic_beta_middle = { synthetic_beta_inner = yes }',
  'synthetic_beta_inner = { country_event = synthetic_beta.31 }',
  '',
  'synthetic_dynamic_helper = {',
  '\tmeta_effect = { text = { synthetic_stage_[?synthetic_stage] = yes } }',
  '}',
  '',
].join('\n');
files.set(helperPath, helperSource);
recordEdge(
  'helper:synthetic_alpha_outer',
  'helper:synthetic_alpha_middle',
  'scripted_effect_call',
  helperPath,
  'helper',
  {
    helperStack: ['synthetic_alpha_outer'],
  },
);
recordEdge(
  'helper:synthetic_alpha_middle',
  'helper:synthetic_alpha_inner',
  'scripted_effect_call',
  helperPath,
  'helper',
  {
    helperStack: ['synthetic_alpha_outer', 'synthetic_alpha_middle'],
  },
);
recordEdge(
  'helper:synthetic_alpha_inner',
  'synthetic_alpha.6',
  'scripted_effect_expansion',
  helperPath,
  'helper',
  {
    delay: 'hours=6',
    helperStack: ['synthetic_alpha_outer', 'synthetic_alpha_middle', 'synthetic_alpha_inner'],
  },
);
recordEdge(
  'helper:synthetic_beta_outer',
  'helper:synthetic_beta_middle',
  'scripted_effect_call',
  helperPath,
  'helper',
  {
    helperStack: ['synthetic_beta_outer'],
  },
);
recordEdge(
  'helper:synthetic_beta_middle',
  'helper:synthetic_beta_inner',
  'scripted_effect_call',
  helperPath,
  'helper',
  {
    helperStack: ['synthetic_beta_outer', 'synthetic_beta_middle'],
  },
);
recordEdge(
  'helper:synthetic_beta_inner',
  'synthetic_beta.31',
  'scripted_effect_expansion',
  helperPath,
  'helper',
  {
    helperStack: ['synthetic_beta_outer', 'synthetic_beta_middle', 'synthetic_beta_inner'],
  },
);
recordEdge(
  'helper:synthetic_dynamic_helper',
  'unresolved:synthetic_stage_[?synthetic_stage]',
  'unresolved_dynamic_reference',
  helperPath,
  'helper',
  { helperStack: ['synthetic_dynamic_helper'], unresolved: true },
);

function addEntry(
  id: string,
  kind: ExpectedEntry['kind'],
  targetId: string,
  reason: EdgeReason,
  sourcePath: string,
): void {
  entries.push({ id, kind, targetId, reason, sourcePath });
  recordEdge(`entry:${kind}:${id}`, targetId, reason, sourcePath, id);
}

const entryTargets = {
  on_action: [
    'synthetic_alpha.1',
    'synthetic_alpha.11',
    'synthetic_alpha.20',
    'synthetic_alpha.30',
    'synthetic_beta.1',
    'synthetic_beta.10',
    'synthetic_gamma.1',
    'synthetic_delta.61',
  ],
  focus: [
    'synthetic_alpha.40',
    'synthetic_alpha.50',
    'synthetic_alpha.60',
    'synthetic_beta.11',
    'synthetic_beta.20',
    'synthetic_gamma.10',
    'synthetic_gamma.20',
    'synthetic_delta.65',
  ],
  decision: [
    'synthetic_alpha.51',
    'synthetic_beta.30',
    'synthetic_beta.40',
    'synthetic_beta.50',
    'synthetic_gamma.30',
    'synthetic_gamma.40',
    'synthetic_delta.69',
    'synthetic_delta.77',
  ],
  mission: [
    'synthetic_alpha.70',
    'synthetic_beta.60',
    'synthetic_beta.70',
    'synthetic_gamma.50',
    'synthetic_gamma.60',
    'synthetic_gamma.70',
    'synthetic_delta.73',
    'synthetic_delta.78',
  ],
  country_setup: [
    'synthetic_alpha.2',
    'synthetic_alpha.12',
    'synthetic_beta.2',
    'synthetic_beta.12',
    'synthetic_gamma.2',
    'synthetic_gamma.12',
    'synthetic_delta.1',
    'synthetic_delta.11',
  ],
  state_setup: [
    'synthetic_delta.65',
    'synthetic_delta.66',
    'synthetic_delta.67',
    'synthetic_delta.68',
    'synthetic_alpha.3',
    'synthetic_beta.3',
    'synthetic_gamma.3',
    'synthetic_delta.21',
  ],
} as const;

const onActionPath = 'workspace/common/on_actions/synthetic_event_entries.txt';
const onActionLines = ['on_actions = {'];
entryTargets.on_action.forEach((targetId, index) => {
  const id = `synthetic_on_action_${String(index + 1).padStart(2, '0')}`;
  onActionLines.push(`\t${id} = { effect = { ${callLine(targetId)} } }`);
  addEntry(id, 'on_action', targetId, 'on_action_entry', onActionPath);
});
onActionLines.push('}', '');
files.set(onActionPath, onActionLines.join('\n'));

const focusPath = 'workspace/common/national_focus/synthetic_event_entries.txt';
const focusLines = [
  'focus_tree = {',
  '\tid = synthetic_event_entries',
  '\tcountry = { factor = 0 }',
];
entryTargets.focus.forEach((targetId, index) => {
  const id = `synthetic_event_focus_${String(index + 1).padStart(2, '0')}`;
  focusLines.push(
    `\tfocus = { id = ${id} x = ${index} y = 0 cost = 1 completion_reward = { ${callLine(targetId)} } }`,
  );
  addEntry(id, 'focus', targetId, 'focus_entry', focusPath);
});
focusLines.push('}', '');
files.set(focusPath, focusLines.join('\n'));

const decisionPath = 'workspace/common/decisions/synthetic_event_entries.txt';
const decisionLines = ['synthetic_event_category = {'];
entryTargets.decision.forEach((targetId, index) => {
  const id = `synthetic_event_decision_${String(index + 1).padStart(2, '0')}`;
  decisionLines.push(`\t${id} = { cost = 0 complete_effect = { ${callLine(targetId)} } }`);
  addEntry(id, 'decision', targetId, 'decision_entry', decisionPath);
});
entryTargets.mission.forEach((targetId, index) => {
  const id = `synthetic_event_mission_${String(index + 1).padStart(2, '0')}`;
  decisionLines.push(
    `\t${id} = { days_mission_timeout = 30 complete_effect = { ${callLine(targetId)} } timeout_effect = { set_country_flag = ${id}_expired } }`,
  );
  addEntry(id, 'mission', targetId, 'mission_entry', decisionPath);
});
decisionLines.push('}', '');
files.set(decisionPath, decisionLines.join('\n'));

entryTargets.country_setup.forEach((targetId, index) => {
  const id = `S${String(index + 1).padStart(2, '0')}`;
  const sourcePath = `workspace/history/countries/${id} - Synthetic ${index + 1}.txt`;
  files.set(sourcePath, `capital = 1\n1936.1.1 = { ${callLine(targetId)} }\n`);
  addEntry(id, 'country_setup', targetId, 'country_setup_entry', sourcePath);
});

entryTargets.state_setup.forEach((targetId, index) => {
  const stateId = index + 1;
  const id = `synthetic_state_setup_${String(stateId).padStart(2, '0')}`;
  const sourcePath = `workspace/history/states/${stateId}-Synthetic.txt`;
  files.set(
    sourcePath,
    `state = {\n\tid = ${stateId}\n\tprovinces = { ${stateId} }\n\thistory = { owner = S01 1936.1.1 = { ${callLine(targetId)} } }\n}\n`,
  );
  addEntry(id, 'state_setup', targetId, 'state_setup_entry', sourcePath);
});

const localisationPath = 'workspace/localisation/english/synthetic_events_l_english.yml';
const localisation = ['l_english:'];
for (const definition of definitions) {
  if (definition.duplicateOrdinal > 1 || definition.id === 'synthetic_delta.77') continue;
  localisation.push(
    `${definition.id}.t: "Synthetic event ${definition.id}"`,
    `${definition.id}.d: "A project-owned event-chain fixture node."`,
    `${definition.id}.a: "Continue"`,
    `${definition.id}.b: "Take the alternate route"`,
  );
}
for (const entry of entries.filter(
  ({ kind }) => kind === 'focus' || kind === 'decision' || kind === 'mission',
))
  localisation.push(`${entry.id}: "Synthetic ${entry.kind} ${entry.id}"`);
files.set(localisationPath, `\ufeff${localisation.join('\n')}\n`);

const sourceHashes = Object.fromEntries(
  [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([relativePath, content]) => [relativePath, sha256(content)]),
);
const uniqueEventIds = [...new Set(definitions.map(({ id }) => id))].sort();
const reasonCounts = Object.fromEntries(
  [...new Set(edges.map(({ reason }) => reason))]
    .sort()
    .map((reason) => [reason, edges.filter((edge) => edge.reason === reason).length]),
);

const fixtureManifest = {
  schemaVersion: 1,
  fixtureId: 'synthetic-event-chain-v1',
  ownership: 'Project-owned synthetic source; contains no game or third-party mod content.',
  eventDefinitionCount: definitions.length,
  uniqueEventIdCount: uniqueEventIds.length,
  namespaceCount: namespaces.length,
  eventFileCount: 8,
  externalEntryPointCount: entries.length,
  scriptedHelperCount: 7,
  expectedEdgeCount: edges.length,
  edgeReasonCounts: reasonCounts,
  intentionalCycleCount: 4,
  automaticEventCount: 1,
  callerlessTriggeredEventCount: 1,
  sourceHashes,
  oraclePolicy:
    'Expected manifests are emitted from explicit fixture specifications, never from the production Event Chain Viewer.',
};

const graphManifest = {
  schemaVersion: 1,
  definitions,
  uniqueEventIds,
  expectedEdges: edges,
  expectedExternalEntries: entries,
  expectedCycles: [
    ['synthetic_alpha.20', 'synthetic_alpha.21'],
    ['synthetic_alpha.22'],
    ['synthetic_alpha.30', 'synthetic_alpha.31'],
    ['synthetic_beta.20', 'synthetic_beta.21', 'synthetic_beta.22'],
  ],
  expectedAutomaticRootEventIds: ['synthetic_gamma.80'],
  expectedCallerlessTriggeredEventIds: ['synthetic_alpha.69'],
  expectedDerivedHelperProjections: [
    {
      callerId: 'synthetic_alpha.4',
      targetId: 'synthetic_alpha.6',
      helperStack: ['synthetic_alpha_outer', 'synthetic_alpha_middle', 'synthetic_alpha_inner'],
    },
    {
      callerId: 'synthetic_beta.30',
      targetId: 'synthetic_beta.31',
      helperStack: ['synthetic_beta_outer', 'synthetic_beta_middle', 'synthetic_beta_inner'],
    },
  ],
  expectedUnresolved: [
    {
      ownerId: 'synthetic_alpha.40',
      expression: 'synthetic_alpha.[?synthetic_dynamic_event]',
      kind: 'dynamic_event',
    },
    {
      ownerId: 'synthetic_beta.40',
      expression: 'synthetic_stage_[?synthetic_stage]',
      kind: 'dynamic_helper',
    },
    {
      ownerId: 'synthetic_beta.41',
      expression: 'synthetic_missing_helper',
      kind: 'missing_helper',
    },
    {
      ownerId: 'helper:synthetic_dynamic_helper',
      expression: 'synthetic_stage_[?synthetic_stage]',
      kind: 'dynamic_helper',
    },
  ],
  forbiddenInventedEdges: [
    { callerId: 'synthetic_alpha.40', targetId: 'synthetic_alpha.40' },
    { callerId: 'synthetic_beta.40', targetId: 'synthetic_beta.41' },
  ],
};

const analysisManifest = {
  schemaVersion: 1,
  expectedStateFlows: [
    {
      kind: 'country_flag',
      name: 'synthetic_chain_started',
      producers: ['synthetic_alpha.1'],
      consumers: ['synthetic_alpha.6'],
      clearers: ['synthetic_alpha.10'],
    },
    {
      kind: 'global_flag',
      name: 'synthetic_world_alarm',
      producers: ['synthetic_beta.1'],
      consumers: ['synthetic_beta.50'],
      clearers: ['synthetic_beta.50'],
    },
    {
      kind: 'state_flag',
      name: 'synthetic_state_ready',
      producers: ['synthetic_delta.65'],
      consumers: ['synthetic_delta.66'],
      clearers: ['synthetic_delta.68'],
    },
    {
      kind: 'variable',
      name: 'synthetic_counter',
      producers: ['synthetic_alpha.1', 'synthetic_alpha.2'],
      consumers: ['synthetic_alpha.6'],
      clearers: ['synthetic_alpha.10'],
    },
    {
      kind: 'global_variable',
      name: 'synthetic_pressure',
      producers: ['synthetic_gamma.30'],
      consumers: ['synthetic_gamma.31'],
      clearers: [],
    },
    {
      kind: 'array',
      name: 'synthetic_participants',
      producers: ['synthetic_alpha.54'],
      consumers: ['synthetic_alpha.55'],
      clearers: ['synthetic_alpha.55'],
    },
    {
      kind: 'event_target',
      name: 'synthetic_transient_target',
      producers: ['synthetic_alpha.7'],
      consumers: ['synthetic_alpha.8'],
      clearers: [],
    },
    {
      kind: 'global_event_target',
      name: 'synthetic_leaked_global_target',
      producers: ['synthetic_alpha.53'],
      consumers: [],
      clearers: [],
    },
    {
      kind: 'global_event_target',
      name: 'synthetic_managed_global_target',
      producers: ['synthetic_beta.52', 'synthetic_beta.53'],
      consumers: ['synthetic_beta.53', 'synthetic_beta.54'],
      clearers: ['synthetic_beta.54'],
      expectedAccessOrder: ['save', 'read', 'replace', 'read', 'clear'],
    },
    {
      kind: 'saved_scope',
      name: 'synthetic_saved_country',
      producers: ['synthetic_gamma.20'],
      consumers: ['synthetic_gamma.21'],
      clearers: ['synthetic_gamma.21'],
    },
  ],
  intentionalDiagnostics: [
    {
      code: 'EVENT_DUPLICATE_ID',
      classification: 'confirmed_error',
      owners: ['synthetic_delta.79'],
    },
    {
      code: 'EVENT_REFERENCE_MISSING',
      classification: 'confirmed_error',
      owners: ['synthetic_alpha.50', 'synthetic_delta.79'],
    },
    {
      code: 'EVENT_IMMEDIATE_SELF_CALL',
      classification: 'confirmed_error',
      owners: ['synthetic_alpha.22'],
    },
    {
      code: 'EVENT_IMMEDIATE_CYCLE',
      classification: 'probable_defect',
      owners: ['synthetic_alpha.20', 'synthetic_alpha.21'],
    },
    {
      code: 'EVENT_DYNAMIC_DISPATCH_UNRESOLVED',
      classification: 'unresolved_analysis',
      owners: ['synthetic_alpha.40'],
    },
    {
      code: 'EVENT_HELPER_UNRESOLVED',
      classification: 'unresolved_analysis',
      owners: ['synthetic_beta.40'],
    },
    {
      code: 'EVENT_HELPER_UNRESOLVED',
      classification: 'unresolved_analysis',
      owners: ['synthetic_beta.41'],
    },
    {
      code: 'EVENT_HELPER_UNRESOLVED',
      classification: 'unresolved_analysis',
      owners: ['helper:synthetic_dynamic_helper'],
    },
    {
      code: 'EVENT_LOCALISATION_MISSING',
      classification: 'probable_defect',
      owners: ['synthetic_delta.77'],
    },
    {
      code: 'EVENT_RANDOM_WEIGHT_INVALID',
      classification: 'confirmed_error',
      owners: ['synthetic_beta.10'],
    },
    {
      code: 'EVENT_OPTION_DANGLING',
      classification: 'design_warning',
      owners: ['synthetic_alpha.58'],
    },
    {
      code: 'EVENT_SCOPE_MISMATCH',
      classification: 'probable_defect',
      owners: ['synthetic_alpha.60'],
    },
    {
      code: 'EVENT_TARGET_READ_BEFORE_SAVE',
      classification: 'probable_defect',
      owners: ['synthetic_alpha.52'],
    },
    {
      code: 'EVENT_GLOBAL_TARGET_WITHOUT_CLEANUP',
      classification: 'design_warning',
      owners: ['synthetic_alpha.53'],
    },
    {
      code: 'EVENT_GATE_WITHOUT_WRITER',
      classification: 'design_warning',
      owners: ['synthetic_alpha.51'],
    },
    {
      code: 'EVENT_DELAYED_TRANSIENT_CONTEXT',
      classification: 'probable_defect',
      owners: ['synthetic_alpha.7', 'synthetic_alpha.8'],
    },
    {
      code: 'EVENT_UNREACHABLE_IN_SELECTION',
      classification: 'design_warning',
      owners: ['synthetic_alpha.69'],
    },
  ],
};

const proposedChanges = {
  schemaVersion: 1,
  description: 'Independent source mutations for event_compare tests; apply to a temporary copy.',
  mutations: [
    {
      kind: 'replace_scalar',
      sourcePath: 'workspace/events/synthetic_alpha_02.txt',
      from: 'synthetic_alpha.999',
      to: 'synthetic_alpha.49',
    },
    {
      kind: 'remove_event',
      sourcePath: 'workspace/events/synthetic_beta_01.txt',
      eventId: 'synthetic_beta.31',
    },
    { kind: 'remove_entry', sourcePath: focusPath, entryId: 'synthetic_event_focus_01' },
    {
      kind: 'replace_scalar',
      sourcePath: 'workspace/events/synthetic_gamma_01.txt',
      from: 'synthetic_gamma.32',
      to: 'synthetic_gamma.33',
    },
  ],
};

const comparisonManifest = {
  schemaVersion: 1,
  expected: {
    repairedMissingTargets: ['synthetic_alpha.999'],
    removedEventIds: ['synthetic_beta.31'],
    callersLeftDangling: ['helper:synthetic_beta_inner'],
    removedEntryIds: ['synthetic_event_focus_01'],
    eventsWithChangedOutgoingEdges: ['synthetic_alpha.50', 'synthetic_gamma.31'],
    newlyDisconnectedCandidates: ['synthetic_alpha.40'],
  },
};

files.set('fixture-manifest.json', await prettyJson(fixtureManifest));
files.set('expected/graph-manifest.json', await prettyJson(graphManifest));
files.set('expected/analysis-manifest.json', await prettyJson(analysisManifest));
files.set('comparison/proposed-changes.json', await prettyJson(proposedChanges));
files.set('expected/comparison-manifest.json', await prettyJson(comparisonManifest));

if (definitions.length !== 320)
  throw new Error(`Expected 320 event definitions, got ${definitions.length}.`);
if (entries.length !== 48) throw new Error(`Expected 48 external entries, got ${entries.length}.`);
await rm(fixtureRoot, { recursive: true, force: true });
for (const [relativePath, content] of files) {
  const target = path.join(fixtureRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
process.stderr.write(
  `Generated ${definitions.length} event definitions, ${entries.length} external entries, and ${files.size} deterministic Event Chain Viewer fixture files.\n`,
);

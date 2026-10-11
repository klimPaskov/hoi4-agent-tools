import { z } from 'zod/v4';
import type { AssignmentNode, BlockNode } from '../core/source/index.js';
import rulesFile from './known-mistakes.json' with { type: 'json' };
import type { PlayerTextFinding } from './player-text.js';

/**
 * Known mistakes: a reviewed, source-cited list of script errors that the game accepts silently
 * or reports with an unhelpful message. The list ships with the server as `known-mistakes.json`;
 * it is changed only by reviewed edits to that file, never at run time. Each active rule has a
 * detector below that flags the mistake in a checked file, and a rule that no longer applies
 * stays in the file as `resolved` with the reason, so the history is kept and it is no longer
 * applied.
 */

const sourceSchema = z
  .object({
    kind: z.enum(['wiki', 'game_doc']),
    page: z.string().min(1),
    heading: z.string().min(1),
    item: z.string().min(1),
  })
  .strict();

const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/u),
    status: z.enum(['active', 'resolved']),
    severity: z.enum(['error', 'warning']),
    surfaces: z
      .array(
        z.enum([
          'event',
          'decision',
          'idea',
          'focus',
          'technology',
          'gui',
          'map',
          'localisation',
          'ai',
        ]),
      )
      .min(1),
    title: z.string().min(1).max(120),
    mistake: z.string().min(1).max(300),
    symptom: z.string().min(1).max(400),
    fix: z.string().min(1).max(300),
    sources: z.array(sourceSchema).min(1),
    /** A regular expression for the game's own log message about the mistake. */
    logPattern: z.string().min(1).max(200).optional(),
    /** Required when `status` is `resolved`: why the rule no longer applies. */
    resolution: z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), note: z.string().min(1).max(300) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if ((rule.status === 'resolved') !== (rule.resolution !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: 'A resolved rule needs a resolution; an active rule must not have one',
      });
  });

const rulesSchema = z
  .object({
    version: z.literal(1),
    reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    rules: z.array(ruleSchema).min(1),
  })
  .strict();

export type KnownMistakeRule = z.infer<typeof ruleSchema>;
export type KnownMistakeSurface = KnownMistakeRule['surfaces'][number];

/** The reviewed rule list, validated once; a malformed file fails when the server loads. */
export const knownMistakeRules: readonly KnownMistakeRule[] = rulesSchema.parse(rulesFile).rules;

/** Rules that are applied: resolved rules stay in the file as history only. */
export function activeKnownMistakes(
  surface?: string,
  rules: readonly KnownMistakeRule[] = knownMistakeRules,
): KnownMistakeRule[] {
  return rules.filter(
    (rule) =>
      rule.status === 'active' &&
      (surface === undefined || surface === 'general' || rule.surfaces.some((s) => s === surface)),
  );
}

/** The rule whose logged message `message` is, so a log entry can name its documented fix. */
export function knownMistakeForLogMessage(
  message: string,
  rules: readonly KnownMistakeRule[] = knownMistakeRules,
): KnownMistakeRule | undefined {
  return activeKnownMistakes(undefined, rules).find(
    (rule) => rule.logPattern !== undefined && new RegExp(rule.logPattern, 'iu').test(message),
  );
}

/** What a detector may read besides the checked file. */
export interface KnownMistakeContext {
  /** Every namespace declared with `add_namespace` in any active events file. */
  eventNamespaces?: ReadonlySet<string>;
}

type Detector = (
  document: { root: BlockNode },
  family: string,
  context: KnownMistakeContext,
) => Array<{ node: AssignmentNode; message?: string }>;

function assignmentsOf(block: BlockNode): AssignmentNode[] {
  return block.entries.filter((entry): entry is AssignmentNode => entry.type === 'assignment');
}

function field(block: BlockNode, key: string): AssignmentNode | undefined {
  return assignmentsOf(block).find((entry) => entry.key.value === key);
}

function scalarField(block: BlockNode, key: string): string | undefined {
  const entry = field(block, key);
  return entry?.value.type === 'scalar' ? entry.value.value : undefined;
}

const eventKeys = new Set([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

/** The event definitions of a file: the assignment, its block and its id. */
function eventsOf(document: {
  root: BlockNode;
}): Array<{ node: AssignmentNode; body: BlockNode; id: string | undefined }> {
  const events: Array<{ node: AssignmentNode; body: BlockNode; id: string | undefined }> = [];
  for (const node of assignmentsOf(document.root))
    if (eventKeys.has(node.key.value) && node.value.type === 'block')
      events.push({ node, body: node.value, id: scalarField(node.value, 'id') });
  return events;
}

/** `days` of a `mean_time_to_happen` block when it is a plain number. */
function baseMeanDays(timer: AssignmentNode): number | undefined {
  if (timer.value.type !== 'block') return undefined;
  const days = scalarField(timer.value, 'days');
  const months = scalarField(timer.value, 'months');
  const years = scalarField(timer.value, 'years');
  const unit = (value: string | undefined, factor: number): number | undefined =>
    value === undefined ? 0 : /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) * factor : undefined;
  const parts = [unit(days, 1), unit(months, 30), unit(years, 365)];
  let total = 0;
  for (const part of parts) {
    if (part === undefined) return undefined;
    total += part;
  }
  return total;
}

/** Days from a `Y.M.D` or `Y.M.D.H` date, ignoring leap days as the game does. */
function dayNumber(date: string): number | undefined {
  const match = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})(?:\.\d{1,2})?$/u.exec(date);
  if (match === null) return undefined;
  const monthDays = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12) return undefined;
  return year * 365 + monthDays[month - 1]! + day;
}

/** Date bounds directly inside a trigger block, with `OR`/`NOT` branches left out. */
function dateBounds(trigger: BlockNode): { lower?: number; upper?: number } {
  const bounds: { lower?: number; upper?: number } = {};
  for (const entry of assignmentsOf(trigger)) {
    if (entry.key.value !== 'date' || entry.value.type !== 'scalar') continue;
    const day = dayNumber(entry.value.value);
    if (day === undefined) continue;
    if (entry.operator.text === '>' || entry.operator.text === '>=')
      bounds.lower = Math.max(bounds.lower ?? day, day);
    else if (entry.operator.text === '<' || entry.operator.text === '<=')
      bounds.upper = Math.min(bounds.upper ?? day, day);
  }
  return bounds;
}

const TRIGGER_CHECK_DAYS = 20;

const detectors: Readonly<Record<string, Detector>> = {
  event_triggered_only_with_mtth: (document) =>
    eventsOf(document).flatMap(({ body }) => {
      const timer = field(body, 'mean_time_to_happen');
      return timer !== undefined && scalarField(body, 'is_triggered_only') === 'yes'
        ? [{ node: timer }]
        : [];
    }),

  event_fires_every_day: (document) =>
    eventsOf(document).flatMap(({ node, body }) => {
      if (scalarField(body, 'is_triggered_only') === 'yes') return [];
      if (scalarField(body, 'fire_only_once') === 'yes') return [];
      const timer = field(body, 'mean_time_to_happen');
      if (timer === undefined) return [{ node }];
      const days = baseMeanDays(timer);
      return days !== undefined && days <= 1 ? [{ node: timer }] : [];
    }),

  news_event_not_major: (document) =>
    eventsOf(document).flatMap(({ node, body }) => {
      if (node.key.value !== 'news_event') return [];
      if (scalarField(body, 'major') !== 'yes') return [{ node }];
      const once = field(body, 'fire_only_once');
      return once !== undefined && scalarField(body, 'fire_only_once') === 'yes'
        ? [{ node: once }]
        : [];
    }),

  event_date_window_too_tight: (document) =>
    eventsOf(document).flatMap(({ body }) => {
      if (scalarField(body, 'is_triggered_only') === 'yes') return [];
      const trigger = field(body, 'trigger');
      if (trigger?.value.type !== 'block') return [];
      const { lower, upper } = dateBounds(trigger.value);
      return lower !== undefined && upper !== undefined && upper - lower < TRIGGER_CHECK_DAYS
        ? [{ node: trigger }]
        : [];
    }),

  event_namespace_missing: (document, _family, context) => {
    const declared = new Set<string>(context.eventNamespaces ?? []);
    for (const node of assignmentsOf(document.root))
      if (node.key.value === 'add_namespace' && node.value.type === 'scalar')
        declared.add(node.value.value);
    return eventsOf(document).flatMap(({ body, id }) => {
      const idNode = field(body, 'id');
      const dot = id?.lastIndexOf('.') ?? -1;
      if (idNode === undefined || id === undefined || dot < 1) return [];
      const namespace = id.slice(0, dot);
      return declared.has(namespace)
        ? []
        : [
            {
              node: idNode,
              message: `${id} uses namespace ${namespace}, which no events file declares with add_namespace`,
            },
          ];
    });
  },

  event_numeric_id_invalid: (document) =>
    eventsOf(document).flatMap(({ body, id }) => {
      const idNode = field(body, 'id');
      const dot = id?.lastIndexOf('.') ?? -1;
      if (idNode === undefined || id === undefined || dot < 1) return [];
      const number = id.slice(dot + 1);
      if (/^\d+$/u.test(number) && Number(number) < 100_000) return [];
      return [
        {
          node: idNode,
          message: `${id} ends in "${number}", which is not a whole number from 0 to 99999`,
        },
      ];
    }),

  temp_variable_scope_prefix: (document) => {
    const temporary = new Set<string>();
    const regular = new Set<string>();
    const names: Array<{ node: AssignmentNode; token: string }> = [];
    const setters =
      /^(?:set|add_to|subtract_from|multiply|divide|modulo|round|clamp|set_to_random|clear)_(temp_)?variable$/u;
    const visit = (block: BlockNode): void => {
      for (const entry of block.entries) {
        if (entry.type === 'block') {
          visit(entry);
          continue;
        }
        if (entry.type !== 'assignment') continue;
        const setter = setters.exec(entry.key.value);
        if (setter !== null && entry.value.type === 'block')
          for (const child of assignmentsOf(entry.value)) {
            if (child.key.value === 'var' && child.value.type === 'scalar')
              (setter[1] === undefined ? regular : temporary).add(child.value.value);
            else if (
              child.key.value !== 'value' &&
              child.key.value !== 'tooltip' &&
              child.key.value !== 'min' &&
              child.key.value !== 'max' &&
              child.key.value !== 'integer'
            )
              (setter[1] === undefined ? regular : temporary).add(child.key.value);
          }
        else if (setter !== null && entry.value.type === 'scalar')
          (setter[1] === undefined ? regular : temporary).add(entry.value.value);
        if (entry.value.type === 'scalar' && entry.value.value.includes('.'))
          names.push({ node: entry, token: entry.value.value });
        if (entry.value.type === 'block') visit(entry.value);
      }
    };
    visit(document.root);
    const findings: Array<{ node: AssignmentNode; message: string }> = [];
    for (const { node, token } of names) {
      const name = token.slice(token.lastIndexOf('.') + 1);
      if (!temporary.has(name) || regular.has(name)) continue;
      if (!/^(?:[A-Za-z_][\w]*|[a-z_]+:[\w]+)(?:\.[A-Za-z_][\w]*)+$/u.test(token)) continue;
      findings.push({
        node,
        message: `${token} reads the temporary variable ${name} through a scope; temporary variables are unscoped, so read ${name} directly`,
      });
    }
    return findings;
  },
};

/** The rule ids that have a detector. */
export const knownMistakeDetectorIds: readonly string[] = Object.keys(detectors);

/** The families each rule's detector runs in; others do not hold the construct. */
const ruleFamilies: Readonly<Record<string, readonly string[] | 'any'>> = {
  event_triggered_only_with_mtth: ['events'],
  event_fires_every_day: ['events'],
  news_event_not_major: ['events'],
  event_date_window_too_tight: ['events'],
  event_namespace_missing: ['events'],
  event_numeric_id_invalid: ['events'],
  temp_variable_scope_prefix: 'any',
};

export interface KnownMistakeFinding extends PlayerTextFinding {
  rule: KnownMistakeRule;
}

/**
 * Flags the known mistakes in one checked file. Resolved rules are not applied. Each finding
 * names the rule, the symptom and the documented fix, in the finding's own message.
 */
export function knownMistakeFindings(
  family: string,
  document: { root: BlockNode },
  context: KnownMistakeContext = {},
  rules: readonly KnownMistakeRule[] = knownMistakeRules,
): KnownMistakeFinding[] {
  const findings: KnownMistakeFinding[] = [];
  for (const rule of activeKnownMistakes(undefined, rules)) {
    const detector = detectors[rule.id];
    const families = ruleFamilies[rule.id];
    if (detector === undefined || families === undefined) continue;
    if (families !== 'any' && !families.includes(family)) continue;
    for (const hit of detector(document, family, context))
      findings.push({
        code: `KNOWN_MISTAKE_${rule.id.toUpperCase()}`,
        command: hit.node.key.value,
        offset: hit.node.start,
        end: hit.node.end,
        message: `${hit.message ?? rule.title}. ${rule.symptom} Fix: ${rule.fix}`.slice(0, 500),
        rule,
      });
  }
  return findings;
}

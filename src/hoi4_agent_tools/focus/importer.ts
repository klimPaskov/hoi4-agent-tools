import { compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import {
  assignments,
  firstScalar,
  nodeLocation,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
  type SourceEntry,
} from '../core/source/index.js';
import {
  FOCUS_PLAN_SCHEMA_VERSION,
  FOCUS_COST_CONSTANT_PATTERN,
  focusPlanHash,
  type FocusAiMetadata,
  type ContinuousFocusDefinition,
  type ContinuousFocusPalettePlan,
  type FocusCountryAssignment,
  type FocusCost,
  type FocusIcon,
  type FocusImportResult,
  type FocusNodePlan,
  type FocusPrerequisiteGroup,
  type FocusReferenceKind,
  type FocusReferenceCatalog,
  type FocusReferenceLink,
  type FocusRouteLock,
  type FocusTreePlan,
  type RawClausewitzBlock,
  type RawPassthroughEntry,
} from './model.js';
import { nativeFocusEffectKeys } from './native-effects.js';

const knownTreeKeys = new Set([
  'id',
  'country',
  'default',
  'focus',
  'shared_focus',
  'continuous_focus_position',
  'initial_show_position',
]);

const knownFocusKeys = new Set([
  'id',
  'icon',
  'prerequisite',
  'mutually_exclusive',
  'x',
  'y',
  'relative_position_id',
  'cost',
  'available',
  'bypass',
  'allow_branch',
  'search_filters',
  'ai_will_do',
  'completion_reward',
  // Legacy planner markers are read for migration diagnostics but never re-emitted.
  'hidden',
  'crisis',
  'continuous',
]);

const knownContinuousPaletteKeys = new Set([
  'id',
  'country',
  'default',
  'reset_on_civilwar',
  'position',
  'focus',
]);

const knownContinuousFocusKeys = new Set(['id', 'icon']);

interface ReferenceEffectSpec {
  kind: FocusReferenceKind;
  fields?: readonly string[];
  blockScalars?: boolean;
}

const referenceEffects = new Map<string, ReferenceEffectSpec>([
  ['activate_decision', { kind: 'decision', fields: ['decision', 'id'] }],
  ['activate_mission', { kind: 'decision', fields: ['mission', 'decision', 'id'] }],
  ['activate_mission_tooltip', { kind: 'decision', fields: ['mission', 'decision', 'id'] }],
  ['activate_targeted_decision', { kind: 'decision', fields: ['decision'] }],
  ['add_days_mission_timeout', { kind: 'decision', fields: ['mission'] }],
  ['remove_decision', { kind: 'decision', fields: ['decision', 'id'] }],
  ['remove_decision_on_cooldown', { kind: 'decision', fields: ['decision', 'id'] }],
  ['remove_mission', { kind: 'decision', fields: ['mission', 'decision', 'id'] }],
  ['remove_targeted_decision', { kind: 'decision', fields: ['decision'] }],
  ['unlock_decision_tooltip', { kind: 'decision', fields: ['decision'] }],
  ['unlock_decision_category_tooltip', { kind: 'decision_category', fields: ['category', 'id'] }],
  ['country_event', { kind: 'event', fields: ['id'] }],
  ['news_event', { kind: 'event', fields: ['id'] }],
  ['state_event', { kind: 'event', fields: ['id'] }],
  ['unit_leader_event', { kind: 'event', fields: ['id'] }],
  ['operative_leader_event', { kind: 'event', fields: ['id'] }],
  ['add_ideas', { kind: 'idea', fields: ['id', 'idea'], blockScalars: true }],
  ['remove_ideas', { kind: 'idea', fields: ['id', 'idea'], blockScalars: true }],
  ['add_timed_idea', { kind: 'idea', fields: ['idea'] }],
  ['modify_timed_idea', { kind: 'idea', fields: ['idea'] }],
  ['show_ideas_tooltip', { kind: 'idea', fields: ['idea', 'id'] }],
  ['swap_ideas', { kind: 'idea', fields: ['add_idea', 'remove_idea'] }],
  ['recruit_character', { kind: 'leader', fields: ['character', 'id'] }],
  ['promote_character', { kind: 'leader', fields: ['character', 'id'] }],
  ['retire_character', { kind: 'leader', fields: ['character', 'id'] }],
]);

const effectContainerKeys = new Set([
  'create_dynamic_country',
  'custom_override_tooltip',
  'effect_tooltip',
  'else',
  'else_if',
  'for_each_loop',
  'for_each_scope_loop',
  'for_loop_effect',
  'hidden_effect',
  'if',
  'party_leader',
  'random',
  'random_list',
  'while_loop_effect',
]);

const effectContainerControlKeys = new Set([
  'add',
  'array',
  'break',
  'chance',
  'compare',
  'copy_tag',
  'count',
  'display_individual_scopes',
  'end',
  'include_invisible',
  'index',
  'limit',
  'max',
  'min',
  'modifier',
  'order_by',
  'position',
  'prioritize',
  'random_select_amount',
  'seed',
  'start',
  'original_tag',
  'tooltip',
  'trigger',
  'value',
]);

const scopeKeys = new Set([
  'capital_scope',
  'controller',
  'faction_leader',
  'host',
  'occupied',
  'occupied_country',
  'original_country',
  'overlord',
  'owner',
  'target',
]);

export interface FocusImportOptions {
  references?: FocusReferenceCatalog;
}

function catalogValues(options: FocusImportOptions, kind: FocusReferenceKind): ReadonlySet<string> {
  const values = options.references?.[kind];
  if (values === undefined) return new Set();
  return values instanceof Set ? values : new Set(values);
}

function isFormableDecision(target: string, options: FocusImportOptions): boolean {
  if (catalogValues(options, 'formable').has(target)) return true;
  if (catalogValues(options, 'decision').has(target)) return false;
  return /(?:^form_|formable|form_country)/iu.test(target);
}

function isEffectContainer(key: string): boolean {
  return (
    effectContainerKeys.has(key) ||
    (nativeFocusEffectKeys.has(key) &&
      /^(?:(?:global_)?every|ordered|random)_[a-z0-9_]+$/u.test(key))
  );
}

function isScopeKey(key: string, knownLeaders: ReadonlySet<string>): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    knownLeaders.has(key) ||
    scopeKeys.has(normalizedKey) ||
    /^\d+$/u.test(key) ||
    /^(?:ROOT|THIS|PREV|FROM(?:FROM)*|[A-Z][A-Z0-9]{2})$/u.test(key) ||
    /^(?:array|character|country|division|event_target|global|global_event_target|mio|operative|province|scope|state|unit_leader|var):[a-z0-9_.-]+$/iu.test(
      key,
    )
  );
}

function sourceLocation(
  document: SourceDocument,
  node: { start: number; end: number },
  symbol?: string,
): SourceLocation {
  return nodeLocation(document, node, symbol);
}

function rawText(document: SourceDocument, node: { start: number; end: number }): string {
  return document.text.slice(node.start, node.end);
}

function focusReferences(block: BlockNode): string[] {
  const references: string[] = [];
  const walk = (current: BlockNode): void => {
    for (const assignment of assignments(current)) {
      if (
        (assignment.key.value === 'has_completed_focus' || assignment.key.value === 'focus') &&
        assignment.value.type === 'scalar'
      ) {
        references.push(assignment.value.value);
      }
      if (assignment.value.type === 'block') walk(assignment.value);
    }
  };
  walk(block);
  return [...new Set(references)].sort((left, right) => compareCodeUnits(left, right));
}

function rawBlock(document: SourceDocument, block: BlockNode): RawClausewitzBlock {
  return {
    text: rawText(document, block),
    referencedFocusIds: focusReferences(block),
    sourceLocation: sourceLocation(document, block),
  };
}

function passthroughEntry(
  document: SourceDocument,
  entry: SourceEntry,
  order: number,
): RawPassthroughEntry {
  return {
    kind: entry.type,
    ...(entry.type === 'assignment' ? { key: entry.key.value } : {}),
    order,
    text: rawText(document, entry),
    sourceLocation: sourceLocation(document, entry),
  };
}

function scalarNumber(block: BlockNode, key: string): number | undefined {
  const value = firstScalar(block, key)?.value;
  if (value === undefined || !/^-?(?:\d+|\d*\.\d+)$/u.test(value)) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function focusCost(block: BlockNode): FocusCost | undefined {
  const value = firstScalar(block, 'cost')?.value;
  if (value === undefined) return undefined;
  if (value.length <= 256 && FOCUS_COST_CONSTANT_PATTERN.test(value)) return value as FocusCost;
  if (!/^-?(?:\d+|\d*\.\d+)$/u.test(value)) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function scalarBoolean(block: BlockNode, key: string): boolean | undefined {
  const value = firstScalar(block, key)?.value.toLowerCase();
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return undefined;
}

function blockScalars(block: BlockNode): string[] {
  return block.entries.filter((entry) => entry.type === 'scalar').map(({ value }) => value);
}

function assignmentBlocks(
  block: BlockNode,
  key: string,
): { assignment: AssignmentNode; block: BlockNode }[] {
  return assignments(block, key).flatMap((assignment) =>
    assignment.value.type === 'block' ? [{ assignment, block: assignment.value }] : [],
  );
}

function prerequisiteGroups(document: SourceDocument, block: BlockNode): FocusPrerequisiteGroup[] {
  return assignmentBlocks(block, 'prerequisite').map(({ assignment, block: prerequisite }) => ({
    operator: 'or',
    focusIds: assignments(prerequisite, 'focus').flatMap(({ value }) =>
      value.type === 'scalar' ? [value.value] : [],
    ),
    rawPassthrough: prerequisite.entries.flatMap((entry, order) => {
      if (
        entry.type === 'assignment' &&
        entry.key.value === 'focus' &&
        entry.value.type === 'scalar'
      )
        return [];
      return [passthroughEntry(document, entry, order)];
    }),
    sourceLocation: sourceLocation(document, assignment),
  }));
}

function mutualExclusions(block: BlockNode): string[] {
  const values = assignmentBlocks(block, 'mutually_exclusive').flatMap(({ block: exclusion }) =>
    assignments(exclusion, 'focus').flatMap(({ value }) =>
      value.type === 'scalar' ? [value.value] : [],
    ),
  );
  return [...new Set(values)].sort((left, right) => compareCodeUnits(left, right));
}

function iconDefinitions(document: SourceDocument, block: BlockNode): FocusIcon[] {
  return assignments(block, 'icon').flatMap((assignment): FocusIcon[] => {
    if (assignment.value.type === 'scalar') {
      return [
        {
          kind: 'static',
          sprite: assignment.value.value,
          sourceLocation: sourceLocation(document, assignment, assignment.value.value),
        },
      ];
    }
    const value = firstScalar(assignment.value, 'value');
    if (value === undefined) return [];
    const trigger = assignmentBlocks(assignment.value, 'trigger')[0]?.block;
    return [
      {
        kind: 'dynamic',
        sprite: value.value,
        ...(trigger === undefined ? {} : { trigger: rawBlock(document, trigger) }),
        sourceLocation: sourceLocation(document, assignment, value.value),
      },
    ];
  });
}

function routeLockPredicates(block: BlockNode):
  | {
      required: string[];
      excluded: string[];
      impossible: boolean;
    }
  | undefined {
  const required: string[] = [];
  const excluded: string[] = [];
  let impossible = false;
  for (const entry of block.entries) {
    if (entry.type !== 'assignment') return undefined;
    if (entry.key.value === 'has_completed_focus' && entry.value.type === 'scalar') {
      required.push(entry.value.value);
      continue;
    }
    if (entry.key.value === 'always' && entry.value.type === 'scalar') {
      if (['no', 'false', '0'].includes(entry.value.value.toLowerCase())) impossible = true;
      else if (!['yes', 'true', '1'].includes(entry.value.value.toLowerCase())) return undefined;
      continue;
    }
    if (entry.key.value === 'NOT' && entry.value.type === 'block') {
      const nested = entry.value.entries;
      if (
        nested.length === 0 ||
        nested.some(
          (candidate) =>
            candidate.type !== 'assignment' ||
            candidate.key.value !== 'has_completed_focus' ||
            candidate.value.type !== 'scalar',
        )
      ) {
        return undefined;
      }
      excluded.push(
        ...nested.flatMap((candidate) =>
          candidate.type === 'assignment' && candidate.value.type === 'scalar'
            ? [candidate.value.value]
            : [],
        ),
      );
      continue;
    }
    return undefined;
  }
  return {
    required: [...new Set(required)].sort((left, right) => compareCodeUnits(left, right)),
    excluded: [...new Set(excluded)].sort((left, right) => compareCodeUnits(left, right)),
    impossible,
  };
}

function structuredRouteLock(
  document: SourceDocument,
  focusId: string,
  field: 'available' | 'allow_branch',
  assignment: AssignmentNode,
  block: BlockNode,
): FocusRouteLock | undefined {
  let mode: FocusRouteLock['mode'] = 'all';
  let predicateBlock = block;
  if (block.entries.length === 1) {
    const entry = block.entries[0];
    if (
      entry?.type === 'assignment' &&
      (entry.key.value === 'OR' || entry.key.value === 'AND') &&
      entry.value.type === 'block'
    ) {
      mode = entry.key.value === 'OR' ? 'any' : 'all';
      predicateBlock = entry.value;
    }
  }
  const predicates = routeLockPredicates(predicateBlock);
  if (
    predicates === undefined ||
    (predicates.required.length === 0 && predicates.excluded.length === 0 && !predicates.impossible)
  ) {
    return undefined;
  }
  return {
    id: `${focusId}:${field}`,
    field,
    mode,
    requiredFocusIds: predicates.required,
    excludedFocusIds: predicates.excluded,
    ...(predicates.impossible ? { alwaysImpossible: true } : {}),
    sourceLocation: sourceLocation(document, assignment, focusId),
  };
}

function referenceTargets(
  assignment: AssignmentNode,
  specification: ReferenceEffectSpec,
): string[] {
  if (assignment.value.type === 'scalar') return [assignment.value.value];
  const targets = specification.blockScalars ? blockScalars(assignment.value) : [];
  for (const field of specification.fields ?? []) {
    for (const candidate of assignments(assignment.value, field)) {
      if (candidate.value.type === 'scalar') targets.push(candidate.value.value);
    }
  }
  return [...new Set(targets)];
}

function referenceLinks(
  document: SourceDocument,
  block: BlockNode,
  options: FocusImportOptions,
): FocusReferenceLink[] {
  const links: FocusReferenceLink[] = [];
  const knownHelpers = catalogValues(options, 'helper');
  const knownLeaders = catalogValues(options, 'leader');

  function recordReference(assignment: AssignmentNode, specification: ReferenceEffectSpec): void {
    for (const target of referenceTargets(assignment, specification)) {
      const kind =
        specification.kind === 'decision' && isFormableDecision(target, options)
          ? 'formable'
          : specification.kind;
      links.push({
        kind,
        target,
        sourceLocation: sourceLocation(document, assignment, target),
      });
    }
  }

  function effectAssignment(assignment: AssignmentNode, controls: ReadonlySet<string>): void {
    const key = assignment.key.value;
    const normalizedKey = key.toLowerCase();
    if (controls.has(normalizedKey)) return;

    const reference = referenceEffects.get(normalizedKey);
    if (reference !== undefined) {
      recordReference(assignment, reference);
      if (assignment.value.type === 'block') {
        for (const nested of assignments(assignment.value)) {
          if (nested.value.type === 'block' && isEffectContainer(nested.key.value.toLowerCase())) {
            effectAssignment(nested, new Set());
          }
        }
      }
      return;
    }

    if (
      knownHelpers.has(key) &&
      !effectContainerKeys.has(normalizedKey) &&
      !nativeFocusEffectKeys.has(normalizedKey)
    ) {
      links.push({
        kind: 'helper',
        target: key,
        sourceLocation: sourceLocation(document, assignment, key),
      });
      return;
    }

    if (isEffectContainer(normalizedKey)) {
      if (assignment.value.type !== 'block') return;
      if (normalizedKey === 'random_list') {
        for (const weighted of assignments(assignment.value)) {
          if (
            weighted.value.type === 'block' &&
            !['log', 'seed'].includes(weighted.key.value.toLowerCase())
          ) {
            effectWalk(weighted.value, effectContainerControlKeys);
          }
        }
      } else {
        effectWalk(assignment.value, effectContainerControlKeys);
      }
      return;
    }

    if (nativeFocusEffectKeys.has(normalizedKey)) return;
    if (assignment.value.type === 'block' && isScopeKey(key, knownLeaders)) {
      effectWalk(assignment.value, new Set());
      return;
    }
    links.push({
      kind: 'helper',
      target: key,
      sourceLocation: sourceLocation(document, assignment, key),
    });
  }

  function effectWalk(current: BlockNode, controls: ReadonlySet<string>): void {
    for (const assignment of assignments(current)) {
      effectAssignment(assignment, controls);
    }
  }

  effectWalk(block, new Set());
  return links.filter(
    (link, index, all) =>
      all.findIndex(({ kind, target }) => kind === link.kind && target === link.target) === index,
  );
}

function aiMetadata(document: SourceDocument, block: BlockNode): FocusAiMetadata {
  const aiBlock = assignmentBlocks(block, 'ai_will_do')[0]?.block;
  return {
    ...(aiBlock === undefined ? {} : { raw: rawBlock(document, aiBlock) }),
    majorRoute: false,
    strategyIds: [],
  };
}

function importFocus(
  document: SourceDocument,
  assignment: AssignmentNode,
  diagnostics: Diagnostic[],
  ordinal: number,
  options: FocusImportOptions,
): FocusNodePlan | undefined {
  if (assignment.value.type !== 'block') return undefined;
  const block = assignment.value;
  const idNode = firstScalar(block, 'id');
  const id = idNode?.value ?? `__missing_focus_${ordinal + 1}`;
  if (idNode === undefined) {
    diagnostics.push({
      code: 'FOCUS_ID_MISSING',
      severity: 'error',
      category: 'syntax',
      message: 'Focus block is missing an id',
      location: sourceLocation(document, assignment),
    });
  }
  const prerequisites = prerequisiteGroups(document, block);
  const relative = firstScalar(block, 'relative_position_id');
  const x = scalarNumber(block, 'x');
  const y = scalarNumber(block, 'y');
  const position =
    relative !== undefined
      ? ({
          mode: 'relative',
          x: x ?? 0,
          y: y ?? 0,
          relativeTo: relative.value,
          pinned: false,
        } as const)
      : x !== undefined || y !== undefined
        ? ({ mode: 'fixed', x: x ?? 0, y: y ?? 0, pinned: false } as const)
        : ({ mode: 'auto', pinned: false } as const);
  const allowBranchEntry = assignmentBlocks(block, 'allow_branch')[0];
  const availabilityEntry = assignmentBlocks(block, 'available')[0];
  const allowBranch = allowBranchEntry?.block;
  const availability = availabilityEntry?.block;
  const bypass = assignmentBlocks(block, 'bypass')[0]?.block;
  const completionReward = assignmentBlocks(block, 'completion_reward')[0]?.block;
  const cost = focusCost(block);
  const hidden = scalarBoolean(block, 'hidden') === true;
  const crisis = scalarBoolean(block, 'crisis') === true;
  for (const markerName of ['hidden', 'crisis', 'continuous'] as const) {
    const marker = assignments(block, markerName)[0];
    if (marker === undefined) continue;
    const isContinuous = markerName === 'continuous';
    diagnostics.push({
      code: isContinuous ? 'FOCUS_INVALID_CONTINUOUS_MARKER' : 'FOCUS_INVALID_VISIBILITY_MARKER',
      severity: 'warning',
      category: 'syntax',
      message: isContinuous
        ? 'continuous is not a national-focus field; define the focus inside common/continuous_focus instead'
        : `${markerName} is planner metadata, not a national-focus field; use allow_branch plus a planning sidecar`,
      location: sourceLocation(document, marker, id),
    });
  }
  const focusIds = prerequisites.flatMap(({ focusIds: targets }) => targets);
  const filters = assignmentBlocks(block, 'search_filters').flatMap(({ block: filterBlock }) =>
    blockScalars(filterBlock),
  );

  const availabilityLock =
    availabilityEntry === undefined
      ? undefined
      : structuredRouteLock(
          document,
          id,
          'available',
          availabilityEntry.assignment,
          availabilityEntry.block,
        );
  const allowBranchLock =
    allowBranchEntry === undefined
      ? undefined
      : structuredRouteLock(
          document,
          id,
          'allow_branch',
          allowBranchEntry.assignment,
          allowBranchEntry.block,
        );

  return {
    id,
    label: id,
    prerequisites: { operator: 'and', groups: prerequisites },
    mutuallyExclusive: mutualExclusions(block),
    routeLocks: [availabilityLock, allowBranchLock].filter(
      (lock): lock is FocusRouteLock => lock !== undefined,
    ),
    ...(availability === undefined || availabilityLock !== undefined
      ? {}
      : { availability: rawBlock(document, availability) }),
    ...(bypass === undefined ? {} : { bypass: rawBlock(document, bypass) }),
    ...(allowBranch === undefined || allowBranchLock !== undefined
      ? {}
      : { allowBranch: rawBlock(document, allowBranch) }),
    position,
    visibility: hidden
      ? 'hidden'
      : crisis
        ? 'crisis'
        : allowBranch === undefined
          ? 'normal'
          : 'conditional',
    ...(allowBranch === undefined
      ? {}
      : {
          reveal: {
            kind: 'allow_branch' as const,
            references: focusReferences(allowBranch),
            ...(allowBranchLock === undefined ? { trigger: rawBlock(document, allowBranch) } : {}),
          },
        }),
    convergence: prerequisites.length > 1 || focusIds.length > 1,
    sharedSupport: false,
    icons: iconDefinitions(document, block),
    localisation: { titleKey: id, descriptionKey: `${id}_desc` },
    ai: aiMetadata(document, block),
    filters: [...new Set(filters)].sort((left, right) => compareCodeUnits(left, right)),
    links:
      completionReward === undefined ? [] : referenceLinks(document, completionReward, options),
    ...(cost === undefined ? {} : { cost }),
    ...(completionReward === undefined
      ? {}
      : { completionReward: rawBlock(document, completionReward) }),
    rawPassthrough: block.entries.flatMap((entry, order) => {
      if (entry.type === 'assignment' && knownFocusKeys.has(entry.key.value)) return [];
      return [passthroughEntry(document, entry, order)];
    }),
    sourceLocation: sourceLocation(document, assignment, id),
  };
}

function countryAssignment(
  document: SourceDocument,
  tree: BlockNode,
): FocusCountryAssignment | undefined {
  const country = assignmentBlocks(tree, 'country')[0]?.block;
  if (country === undefined) return undefined;
  const tags: string[] = [];
  const walk = (block: BlockNode): void => {
    for (const assignment of assignments(block)) {
      if (
        (assignment.key.value === 'tag' || assignment.key.value === 'original_tag') &&
        assignment.value.type === 'scalar'
      ) {
        tags.push(assignment.value.value);
      }
      if (assignment.value.type === 'block') walk(assignment.value);
    }
  };
  walk(country);
  return {
    raw: rawBlock(document, country),
    countryTags: [...new Set(tags)].sort((left, right) => compareCodeUnits(left, right)),
  };
}

function continuousPosition(tree: BlockNode): { x: number; y: number } | undefined {
  const block = assignmentBlocks(tree, 'continuous_focus_position')[0]?.block;
  if (block === undefined) return undefined;
  return { x: scalarNumber(block, 'x') ?? 0, y: scalarNumber(block, 'y') ?? 0 };
}

function importContinuousFocus(
  document: SourceDocument,
  assignment: AssignmentNode,
  diagnostics: Diagnostic[],
  ordinal: number,
): ContinuousFocusDefinition | undefined {
  if (assignment.value.type !== 'block') return undefined;
  const block = assignment.value;
  const idNode = firstScalar(block, 'id');
  const id = idNode?.value ?? `__missing_continuous_focus_${ordinal + 1}`;
  if (idNode === undefined) {
    diagnostics.push({
      code: 'CONTINUOUS_FOCUS_ID_MISSING',
      severity: 'error',
      category: 'syntax',
      message: 'Continuous focus block is missing an id',
      location: sourceLocation(document, assignment),
    });
  }
  return {
    id,
    icons: iconDefinitions(document, block),
    localisation: { titleKey: id, descriptionKey: `${id}_desc` },
    rawPassthrough: block.entries.flatMap((entry, order) =>
      entry.type === 'assignment' && knownContinuousFocusKeys.has(entry.key.value)
        ? []
        : [passthroughEntry(document, entry, order)],
    ),
    sourceLocation: sourceLocation(document, assignment, id),
  };
}

function palettePosition(block: BlockNode): { x: number; y: number } | undefined {
  const position = assignmentBlocks(block, 'position')[0]?.block;
  return position === undefined
    ? undefined
    : { x: scalarNumber(position, 'x') ?? 0, y: scalarNumber(position, 'y') ?? 0 };
}

function importContinuousPalette(
  document: SourceDocument,
  assignment: AssignmentNode,
  diagnostics: Diagnostic[],
  ordinal: number,
): ContinuousFocusPalettePlan | undefined {
  if (assignment.value.type !== 'block') return undefined;
  const block = assignment.value;
  const idNode = firstScalar(block, 'id');
  const id = idNode?.value ?? `__missing_continuous_palette_${ordinal + 1}`;
  if (idNode === undefined) {
    diagnostics.push({
      code: 'CONTINUOUS_FOCUS_PALETTE_ID_MISSING',
      severity: 'error',
      category: 'syntax',
      message: 'continuous_focus_palette is missing an id',
      location: sourceLocation(document, assignment),
    });
  }
  const country = countryAssignment(document, block);
  const sourceHash = sha256Bytes(document.bytes);
  const resetOnCivilWar = scalarBoolean(block, 'reset_on_civilwar');
  const position = palettePosition(block);
  const provisional: ContinuousFocusPalettePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id,
    ...(country === undefined ? {} : { countryAssignment: country }),
    default: scalarBoolean(block, 'default') === true,
    ...(resetOnCivilWar === undefined ? {} : { resetOnCivilWar }),
    ...(position === undefined ? {} : { position }),
    focuses: assignments(block, 'focus').flatMap((focus, focusOrdinal) => {
      const imported = importContinuousFocus(document, focus, diagnostics, focusOrdinal);
      return imported === undefined ? [] : [imported];
    }),
    rawPassthrough: block.entries.flatMap((entry, order) =>
      entry.type === 'assignment' && knownContinuousPaletteKeys.has(entry.key.value)
        ? []
        : [passthroughEntry(document, entry, order)],
    ),
    provenance: {
      sourcePath: document.path,
      sourceHash,
      importedPlanHash: '',
    },
    sourceLocation: sourceLocation(document, assignment, id),
  };
  provisional.provenance.importedPlanHash = focusPlanHash(provisional);
  return provisional;
}

function importTree(
  document: SourceDocument,
  assignment: AssignmentNode,
  diagnostics: Diagnostic[],
  ordinal: number,
  options: FocusImportOptions,
): FocusTreePlan | undefined {
  if (assignment.value.type !== 'block') return undefined;
  const tree = assignment.value;
  const idNode = firstScalar(tree, 'id');
  const id = idNode?.value ?? `__missing_focus_tree_${ordinal + 1}`;
  if (idNode === undefined) {
    diagnostics.push({
      code: 'FOCUS_TREE_ID_MISSING',
      severity: 'error',
      category: 'syntax',
      message: 'Focus tree block is missing an id',
      location: sourceLocation(document, assignment),
    });
  }
  const focuses = assignments(tree, 'focus').flatMap((focus, focusOrdinal) => {
    const imported = importFocus(document, focus, diagnostics, focusOrdinal, options);
    return imported === undefined ? [] : [imported];
  });
  const entries = focuses
    .filter(({ prerequisites }) => prerequisites.groups.length === 0)
    .map(({ id: focusId }) => focusId);
  const initial = assignmentBlocks(tree, 'initial_show_position')[0]?.block;
  const assignmentForCountry = countryAssignment(document, tree);
  const positionForContinuousFocuses = continuousPosition(tree);
  const sourceHash = sha256Bytes(document.bytes);
  const provisional: FocusTreePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id,
    ...(assignmentForCountry === undefined ? {} : { countryAssignment: assignmentForCountry }),
    default: scalarBoolean(tree, 'default') === true,
    branchGroups: [],
    laneGroups: [{ id: 'default', label: 'Default', order: 0 }],
    entryFocusIds: entries.sort((left, right) => compareCodeUnits(left, right)),
    focuses,
    sharedFocusIds: assignments(tree, 'shared_focus').flatMap(({ value }) =>
      value.type === 'scalar' ? [value.value] : [],
    ),
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    ...(positionForContinuousFocuses === undefined
      ? {}
      : { continuousFocusPosition: positionForContinuousFocuses }),
    ...(initial === undefined ? {} : { initialShowPosition: rawBlock(document, initial) }),
    rawPassthrough: tree.entries.flatMap((entry, order) => {
      if (entry.type === 'assignment' && knownTreeKeys.has(entry.key.value)) return [];
      return [passthroughEntry(document, entry, order)];
    }),
    provenance: {
      sourcePath: document.path,
      sourceHash,
      importedPlanHash: '',
    },
    sourceLocation: sourceLocation(document, assignment, id),
  };
  provisional.provenance.importedPlanHash = focusPlanHash(provisional);
  return provisional;
}

export function importFocusTrees(
  document: SourceDocument,
  options: FocusImportOptions = {},
): FocusImportResult {
  const diagnostics = [...document.diagnostics];
  const plans = assignments(document.root, 'focus_tree').flatMap((assignment, ordinal) => {
    const plan = importTree(document, assignment, diagnostics, ordinal, options);
    return plan === undefined ? [] : [plan];
  });
  if (plans.length === 0) {
    diagnostics.push({
      code: 'FOCUS_TREE_NOT_FOUND',
      severity: 'warning',
      category: 'syntax',
      message: 'No focus_tree block was found in the source document',
    });
  }
  return { plans, continuousFocusPalettes: [], diagnostics };
}

export function importContinuousFocusPalettes(document: SourceDocument): FocusImportResult {
  const diagnostics = [...document.diagnostics];
  const continuousFocusPalettes = assignments(document.root, 'continuous_focus_palette').flatMap(
    (assignment, ordinal) => {
      const palette = importContinuousPalette(document, assignment, diagnostics, ordinal);
      return palette === undefined ? [] : [palette];
    },
  );
  if (continuousFocusPalettes.length === 0) {
    diagnostics.push({
      code: 'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
      severity: 'warning',
      category: 'syntax',
      message: 'No continuous_focus_palette block was found in the source document',
    });
  }
  return { plans: [], continuousFocusPalettes, diagnostics };
}

export function linkContinuousFocusPalettes(
  plan: FocusTreePlan,
  palettes: readonly ContinuousFocusPalettePlan[],
): FocusTreePlan {
  const tags = new Set(plan.countryAssignment?.countryTags ?? []);
  const matching = palettes.filter(
    (palette) => palette.countryAssignment?.countryTags.some((tag) => tags.has(tag)) === true,
  );
  const selected =
    matching.length > 0 ? matching : palettes.filter(({ default: fallback }) => fallback);
  const linked = structuredClone(plan);
  linked.continuousFocusPaletteIds = selected
    .map(({ id }) => id)
    .sort((left, right) => compareCodeUnits(left, right));
  linked.continuousFocusIds = [
    ...new Set(selected.flatMap(({ focuses }) => focuses.map(({ id }) => id))),
  ].sort((left, right) => compareCodeUnits(left, right));
  linked.provenance.importedPlanHash = focusPlanHash(linked);
  return linked;
}

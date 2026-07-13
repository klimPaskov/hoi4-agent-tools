import { compareCodeUnits, deterministicId } from '../core/canonical.js';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  assignments,
  childBlocks,
  firstScalar,
  nodeLocation,
  parseClausewitz,
  parseLocalisation,
  sourcePartialLimitDiagnostics,
  type AssignmentNode,
  type BlockNode,
  type ScalarNode,
  type SourceDocument,
  type SourceEntry,
  type SourceValue,
} from '../core/source/index.js';
import { nativeEffectKeys } from '../focus/native-effects.js';
import {
  EVENT_FRAGMENT_CACHE_MAX_ENTRIES,
  EVENT_FRAGMENT_CACHE_MAX_SOURCE_BYTES,
  EVENT_GRAPH_MAX_CONDITION_TEXT,
  EventAnalysisBudget,
} from './limits.js';
import type {
  EventCondition,
  EventEdgeReason,
  EventEntryKind,
  EventGraphEdge,
  EventGraphNode,
  EventIssue,
  EventScopeKind,
  EventSemanticFragmentCacheLike,
  EventSourceFragment,
  EventStateAccess,
  EventStateAccessKind,
  EventStateKind,
  EventTiming,
  EventType,
  EventUnresolvedAnalysis,
  EventWeight,
} from './model.js';

const EVENT_TYPES = new Set<EventType>([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

const EVENT_CALLS = EVENT_TYPES;
const CONTROL_BLOCKS = new Set([
  'if',
  'else_if',
  'else',
  'while',
  'every_country',
  'every_state',
  'every_owned_state',
  'every_character',
  'random_country',
  'random_state',
  'random_list',
  'hidden_effect',
]);

const SCOPE_BLOCKS: Readonly<Record<string, EventScopeKind>> = {
  country: 'country',
  every_country: 'country',
  every_enemy_country: 'country',
  every_faction_member: 'country',
  every_neighbor_country: 'country',
  every_subject_country: 'country',
  random_country: 'country',
  random_enemy_country: 'country',
  random_neighbor_country: 'country',
  random_occupied_country: 'country',
  random_other_country: 'country',
  random_subject_country: 'country',
  owner: 'country',
  controller: 'country',
  capital_scope: 'state',
  state: 'state',
  every_controlled_state: 'state',
  every_core_state: 'state',
  every_neighbor_state: 'state',
  every_state: 'state',
  every_owned_state: 'state',
  random_controlled_state: 'state',
  random_core_state: 'state',
  random_neighbor_state: 'state',
  random_owned_state: 'state',
  random_state: 'state',
  unit_leader: 'unit_leader',
  operative_leader: 'operative',
  character: 'character',
  every_army_leader: 'character',
  every_character: 'character',
  every_navy_leader: 'character',
  every_unit_leader: 'character',
  random_army_leader: 'character',
  random_character: 'character',
  random_navy_leader: 'character',
  random_unit_leader: 'character',
  every_operative: 'operative',
  random_operative: 'operative',
  root: 'unknown',
  prev: 'unknown',
  from: 'unknown',
  this: 'unknown',
};

interface StateRule {
  kind: EventStateKind;
  access: EventStateAccessKind;
  nameField?: string;
  storage?: 'local' | 'global';
}

const STATE_RULES: Readonly<Record<string, StateRule>> = {
  set_country_flag: { kind: 'country_flag', access: 'write', nameField: 'flag' },
  clr_country_flag: { kind: 'country_flag', access: 'clear', nameField: 'flag' },
  has_country_flag: { kind: 'country_flag', access: 'read', nameField: 'flag' },
  set_global_flag: { kind: 'global_flag', access: 'write', nameField: 'flag' },
  clr_global_flag: { kind: 'global_flag', access: 'clear', nameField: 'flag' },
  has_global_flag: { kind: 'global_flag', access: 'read', nameField: 'flag' },
  set_state_flag: { kind: 'state_flag', access: 'write', nameField: 'flag' },
  clr_state_flag: { kind: 'state_flag', access: 'clear', nameField: 'flag' },
  has_state_flag: { kind: 'state_flag', access: 'read', nameField: 'flag' },
  set_variable: { kind: 'variable', access: 'write' },
  add_to_variable: { kind: 'variable', access: 'read_write' },
  subtract_from_variable: { kind: 'variable', access: 'read_write' },
  multiply_variable: { kind: 'variable', access: 'read_write' },
  divide_variable: { kind: 'variable', access: 'read_write' },
  clamp_variable: { kind: 'variable', access: 'read_write' },
  check_variable: { kind: 'variable', access: 'read' },
  has_variable: { kind: 'variable', access: 'read' },
  is_variable_equal: { kind: 'variable', access: 'read' },
  clr_variable: { kind: 'variable', access: 'clear' },
  clear_variable: { kind: 'variable', access: 'clear' },
  set_global_variable: { kind: 'global_variable', access: 'write' },
  add_to_global_variable: { kind: 'global_variable', access: 'read_write' },
  subtract_from_global_variable: { kind: 'global_variable', access: 'read_write' },
  check_global_variable: { kind: 'global_variable', access: 'read' },
  has_global_variable: { kind: 'global_variable', access: 'read' },
  clear_global_variable: { kind: 'global_variable', access: 'clear' },
  add_to_array: { kind: 'array', access: 'write', nameField: 'array' },
  remove_from_array: { kind: 'array', access: 'read_write', nameField: 'array' },
  is_in_array: { kind: 'array', access: 'read', nameField: 'array' },
  clear_array: { kind: 'array', access: 'clear' },
  save_event_target_as: { kind: 'event_target', access: 'replace' },
  has_event_target: { kind: 'event_target', access: 'read' },
  save_global_event_target_as: { kind: 'global_event_target', access: 'replace' },
  has_global_event_target: { kind: 'global_event_target', access: 'read' },
  clear_global_event_target: { kind: 'global_event_target', access: 'clear' },
  clear_global_event_targets: { kind: 'global_event_target', access: 'clear' },
  save_scope_as: { kind: 'saved_scope', access: 'replace', storage: 'local' },
  save_global_scope_as: { kind: 'saved_scope', access: 'replace', storage: 'global' },
  clear_saved_scope: { kind: 'saved_scope', access: 'clear', storage: 'local' },
  clear_global_scope: { kind: 'saved_scope', access: 'clear', storage: 'global' },
};

export interface EventSourceAnalysisContext {
  signal?: AbortSignal;
  budget?: EventAnalysisBudget;
  knownEventIds?: ReadonlySet<string>;
  knownEventTypes?: ReadonlyMap<string, EventType>;
  knownHelperIds?: ReadonlySet<string>;
  knownDecisionIds?: ReadonlySet<string>;
  activeEventPaths?: ReadonlyMap<string, string>;
  retainedEventPaths?: ReadonlyMap<string, ReadonlySet<string>>;
  activeHelperPaths?: ReadonlyMap<string, string>;
  activeDecisionPaths?: ReadonlyMap<string, string>;
  inventoryComplete?: boolean;
  catalogFingerprint?: string;
}

interface WalkContext {
  ownerId: string;
  sourceScope: EventScopeKind;
  phase: 'immediate' | 'option' | 'after' | 'hidden' | 'entry' | 'helper' | 'other';
  conditions: EventCondition[];
  helperStack: string[];
  semanticPath: string[];
  weight?: string;
  weightModifiers?: EventCondition[];
  reason?: EventEdgeReason;
  scopeExpression?: string;
  /** Whether an unknown effect-shaped assignment can be a scripted helper call. */
  effectContext?: boolean;
  /** True inside display-only constructs such as effect_tooltip. */
  suppressSemantics?: boolean;
}

function normalizedPath(file: ScannedFile): string {
  return file.relativePath.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function isDynamic(value: string): boolean {
  return /\[|\]|\?|@|^event_target:|^var:|^scope:/iu.test(value);
}

function isQualifiedDynamicScope(value: string): boolean {
  return /^(?:event_target|global_event_target|scope|var|temp_var):\S+$/iu.test(value);
}

function isScopeChain(value: string): boolean {
  return /^(?:root|prev|from|this)(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/iu.test(value);
}

function isLiteralCountryTag(value: string): boolean {
  return /^[A-Z][A-Z0-9]{2}$/u.test(value);
}

const EFFECT_WRAPPER_BLOCKS = new Set([
  ...CONTROL_BLOCKS,
  'effect',
  'completion_reward',
  'meta_effect',
  'text',
]);

const NON_HELPER_BLOCKS = new Set([
  ...EFFECT_WRAPPER_BLOCKS,
  'trigger',
  'limit',
  'ai_chance',
  'modifier',
  'random_events',
  'mean_time_to_happen',
  'effect_tooltip',
  'custom_effect_tooltip',
]);

const NON_EXECUTING_BLOCKS = new Set([
  'trigger',
  'limit',
  'ai_chance',
  'modifier',
  'mean_time_to_happen',
  'effect_tooltip',
  'custom_effect_tooltip',
]);

const TOOLTIP_ONLY_BLOCKS = new Set(['effect_tooltip', 'custom_effect_tooltip']);

const COUNTRY_ON_ACTIONS = new Set([
  'on_startup',
  'on_daily',
  'on_weekly',
  'on_monthly',
  // Official on-action examples scope ROOT to the new controller country;
  // the affected state is exposed through the FROM chain.
  'on_state_control_changed',
]);

const UNIT_LEADER_ON_ACTIONS = new Set([
  'on_unit_leader_created',
  'on_army_leader_daily',
  'on_army_leader_won_combat',
  'on_army_leader_lost_combat',
  'on_unit_leader_level_up',
  'on_army_leader_promoted',
  'on_deployed_leader_defeated',
]);

const OPERATIVE_ON_ACTIONS = new Set([
  'on_operative_detected_during_operation',
  'on_operative_on_mission_spotted',
  'on_operative_captured',
  'on_operative_created',
  'on_operative_death',
  'on_operative_recruited',
]);

function onActionScope(name: string): EventScopeKind {
  const normalized = name.toLowerCase();
  if (
    COUNTRY_ON_ACTIONS.has(normalized) ||
    /^on_(?:daily|weekly|monthly)_[a-z0-9_]+$/u.test(normalized)
  ) {
    return 'country';
  }
  if (UNIT_LEADER_ON_ACTIONS.has(normalized)) return 'unit_leader';
  if (OPERATIVE_ON_ACTIONS.has(normalized)) return 'operative';
  return 'unknown';
}

function localisationKeysFromValue(value: SourceValue): string[] {
  if (value.type === 'scalar') return [value.value];
  const keys: string[] = [];
  for (const assignment of assignments(value)) {
    const key = assignment.key.value.toLowerCase();
    if (key === 'text' || key === 'fallback' || key === 'localisation_key') {
      if (assignment.value.type === 'scalar') keys.push(assignment.value.value);
      else keys.push(...localisationKeysFromValue(assignment.value));
    }
  }
  return [...new Set(keys)].sort(compareCodeUnits);
}

function missingHelperCandidate(key: string, value: SourceValue, effectContext: boolean): boolean {
  const normalizedKey = key.toLowerCase();
  if (
    !effectContext ||
    nativeEffectKeys.has(normalizedKey) ||
    NON_HELPER_BLOCKS.has(normalizedKey) ||
    SCOPE_BLOCKS[normalizedKey] !== undefined ||
    STATE_RULES[normalizedKey] !== undefined ||
    isDynamic(key) ||
    /^\d+(?:\.\d+)?$/u.test(key) ||
    /^(?:event_target|global_event_target|scope):/iu.test(key)
  ) {
    return false;
  }
  if (value.type === 'scalar') return /^(?:yes|no)$/iu.test(value.value);
  // Unknown blocks are frequently definitions, date scopes, or native-effect
  // argument objects. Retain the established explicit naming signal for an
  // absent block helper instead of inventing calls from arbitrary containers.
  return /(?:_helper|_scripted_effect)$/u.test(normalizedKey);
}

function weightValidity(weight: string): EventWeight['valid'] {
  if (/^\d+(?:\.\d+)?$/u.test(weight)) return true;
  if (/^(?:(?:var|temp_var|global_var|constant):)?[A-Za-z_][A-Za-z0-9_.:@^-]*$/u.test(weight)) {
    return 'unknown';
  }
  return false;
}

function expectedScope(type: EventType): EventScopeKind {
  if (type === 'state_event') return 'state';
  if (type === 'unit_leader_event') return 'unit_leader';
  if (type === 'operative_leader_event') return 'operative';
  return 'country';
}

function valueText(document: SourceDocument, value: SourceValue): string {
  return document.text
    .slice(value.start, value.end)
    .trim()
    .slice(0, EVENT_GRAPH_MAX_CONDITION_TEXT);
}

function scalarOrField(value: SourceValue, field: string): string | undefined {
  if (value.type === 'scalar') return value.value;
  return firstScalar(value, field)?.value;
}

function firstScalarForKey(block: BlockNode, key: string): ScalarNode | undefined {
  return assignments(block, key)
    .map(({ value }) => value)
    .find((value): value is ScalarNode => value.type === 'scalar');
}

/**
 * Location- and trivia-independent Clausewitz content used only for semantic
 * identity. Entry order remains significant because it is significant to the
 * source language, while comments, whitespace, quoting style, and offsets do
 * not participate in the identity.
 */
function semanticSourceEntry(entry: SourceEntry): unknown {
  if (entry.type === 'scalar') return { type: 'scalar', value: entry.value };
  if (entry.type === 'assignment') {
    return {
      type: 'assignment',
      key: entry.key.value,
      operator: entry.operator.text,
      value: semanticSourceEntry(entry.value),
    };
  }
  return {
    type: 'block',
    entries: entry.entries.map(semanticSourceEntry),
  };
}

function semanticOccurrenceSegment(
  label: string,
  semantic: unknown,
  occurrences: Map<string, number>,
): string {
  const identity = deterministicId('event_semantic_path', { label, semantic });
  const duplicateOrdinal = occurrences.get(identity) ?? 0;
  occurrences.set(identity, duplicateOrdinal + 1);
  return duplicateOrdinal === 0 ? identity : `${identity}:${duplicateOrdinal}`;
}

function issueFromDiagnostic(diagnostic: Diagnostic): EventIssue {
  return {
    code: diagnostic.code,
    classification: 'unresolved_analysis',
    severity: diagnostic.severity,
    message: diagnostic.message,
    confidence: 'unresolved',
    ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
    ...(diagnostic.related === undefined ? {} : { related: diagnostic.related }),
    blockers: [{ code: diagnostic.code, message: diagnostic.message }],
    details: {},
  };
}

export function eventSemanticFragmentCacheKey(file: ScannedFile, catalogFingerprint = ''): string {
  return deterministicId('event_fragment', {
    parser: 'clausewitz-cst.v1',
    sourcePath: file.displayPath,
    sourceHash: file.sha256,
    catalogFingerprint,
  });
}

/** Bounded content-addressed cache suitable for direct graph-builder use. */
export class EventSemanticFragmentCache implements EventSemanticFragmentCacheLike {
  readonly #entries = new Map<string, { fragment: EventSourceFragment; bytes: number }>();
  #bytes = 0;

  public get(key: string): EventSourceFragment | undefined {
    const hit = this.#entries.get(key);
    if (hit === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit.fragment;
  }

  public set(key: string, fragment: EventSourceFragment, sourceBytes: number): void {
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) return;
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(key);
    }
    if (sourceBytes > EVENT_FRAGMENT_CACHE_MAX_SOURCE_BYTES) return;
    this.#entries.set(key, { fragment, bytes: sourceBytes });
    this.#bytes += sourceBytes;
    while (
      this.#entries.size > EVENT_FRAGMENT_CACHE_MAX_ENTRIES ||
      this.#bytes > EVENT_FRAGMENT_CACHE_MAX_SOURCE_BYTES
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      this.#bytes -= removed?.bytes ?? 0;
    }
  }
}

class FragmentAnalyzer {
  readonly nodes: EventGraphNode[] = [];
  readonly edges: EventGraphEdge[] = [];
  readonly stateAccesses: EventStateAccess[] = [];
  readonly issues: EventIssue[] = [];
  readonly unresolved: EventUnresolvedAnalysis[] = [];
  readonly #budget: EventAnalysisBudget;
  readonly #knownEvents: ReadonlySet<string>;
  readonly #knownEventTypes: ReadonlyMap<string, EventType>;
  readonly #knownHelpers: ReadonlySet<string>;
  readonly #seenStateWriters = new Set<string>();
  readonly #edgeCollisions = new Map<string, number>();
  readonly #conditionCollisions = new Map<string, number>();
  readonly #stateCollisions = new Map<string, number>();
  readonly #unresolvedCollisions = new Map<string, number>();

  public constructor(
    readonly file: ScannedFile,
    readonly document: SourceDocument,
    readonly context: EventSourceAnalysisContext,
  ) {
    this.#budget = context.budget ?? new EventAnalysisBudget(context.signal);
    this.#knownEvents = context.knownEventIds ?? new Set<string>();
    this.#knownEventTypes = context.knownEventTypes ?? new Map<string, EventType>();
    this.#knownHelpers = context.knownHelperIds ?? new Set<string>();
  }

  public analyze(): void {
    const sourcePath = normalizedPath(this.file);
    if (sourcePath.startsWith('events/')) this.analyzeEvents();
    else if (sourcePath.startsWith('common/scripted_effects/')) this.analyzeHelpers();
    else if (sourcePath.startsWith('common/on_actions/')) this.analyzeOnActions();
    else if (/common\/(?:national_)?focus/u.test(sourcePath)) this.analyzeFocuses();
    else if (sourcePath.startsWith('common/decisions/')) this.analyzeDecisions();
    else if (sourcePath.startsWith('history/countries/'))
      this.analyzeSetup('country_setup', 'country');
    else if (sourcePath.startsWith('history/states/')) this.analyzeSetup('state_setup', 'state');
    else this.analyzeOther();
  }

  private location(node: { start: number; end: number }, symbol?: string): SourceLocation {
    return nodeLocation(this.document, node, symbol);
  }

  private uniqueId(prefix: string, semantic: unknown): string {
    return deterministicId(prefix, { source: this.file.displayPath, semantic });
  }

  private uniqueOccurrenceId(
    prefix: string,
    semantic: unknown,
    occurrences: Map<string, number>,
  ): string {
    const identity = this.uniqueId(prefix, semantic);
    const duplicateOrdinal = occurrences.get(identity) ?? 0;
    occurrences.set(identity, duplicateOrdinal + 1);
    return duplicateOrdinal === 0
      ? identity
      : this.uniqueId(prefix, { semantic, duplicateOrdinal });
  }

  private addNode(node: EventGraphNode): void {
    this.#budget.spend('event source node');
    this.nodes.push(node);
  }

  private analyzeEvents(): void {
    const occurrences = new Map<string, number>();
    for (const assignment of assignments(this.document.root)) {
      if (!EVENT_TYPES.has(assignment.key.value as EventType) || assignment.value.type !== 'block')
        continue;
      const type = assignment.key.value as EventType;
      const idScalar = firstScalar(assignment.value, 'id');
      if (idScalar === undefined) continue;
      const id = idScalar.value;
      const retainedPaths = this.context.retainedEventPaths?.get(id);
      if (
        retainedPaths !== undefined
          ? !retainedPaths.has(this.file.displayPath)
          : this.context.activeEventPaths !== undefined &&
            this.context.activeEventPaths.get(id) !== this.file.displayPath
      ) {
        continue;
      }
      const ordinal = occurrences.get(id) ?? 0;
      occurrences.set(id, ordinal + 1);
      // Definitions remain unique even when an invalid duplicate ID appears in
      // another active file. Calls use an event:<logical-id> placeholder that
      // the graph stage resolves to the selected definition.
      const ownerId = this.uniqueId('event_definition', { id, ordinal });
      const eventAssignments = assignments(assignment.value);
      const titleAssignments = eventAssignments.filter(
        ({ key }) => key.value.toLowerCase() === 'title',
      );
      const descriptionAssignments = eventAssignments.filter(
        ({ key }) => key.value.toLowerCase() === 'desc',
      );
      const titleKeys = [
        ...new Set(titleAssignments.flatMap(({ value }) => localisationKeysFromValue(value))),
      ].sort(compareCodeUnits);
      const descriptionKeys = [
        ...new Set(descriptionAssignments.flatMap(({ value }) => localisationKeysFromValue(value))),
      ].sort(compareCodeUnits);
      const titleKey = titleKeys[0];
      const descKey = descriptionKeys[0];
      const triggeredOnlyScalar = firstScalar(assignment.value, 'is_triggered_only');
      const triggeredOnly = triggeredOnlyScalar?.value === 'yes';
      const hidden =
        firstScalar(assignment.value, 'hidden')?.value === 'yes' ||
        firstScalar(assignment.value, 'hide_window')?.value === 'yes';
      this.addNode({
        id: ownerId,
        kind: 'event',
        label: id,
        eventId: id,
        namespace: id.includes('.') ? id.slice(0, id.indexOf('.')) : id,
        sourcePath: this.file.displayPath,
        location: this.location(assignment, id),
        metadata: {
          eventType: type,
          expectedScope: expectedScope(type),
          hidden,
          hasTitle: titleAssignments.length > 0,
          hasDescription: descriptionAssignments.length > 0,
          ...(triggeredOnlyScalar === undefined ? {} : { isTriggeredOnly: triggeredOnly }),
          ...(titleKey === undefined ? {} : { titleKey }),
          ...(descKey === undefined ? {} : { descKey }),
          ...(titleKeys.length === 0 ? {} : { titleKeys }),
          ...(descriptionKeys.length === 0 ? {} : { descriptionKeys }),
          ...(titleKeys.length + descriptionKeys.length === 0
            ? {}
            : {
                localisationKeys: [...new Set([...titleKeys, ...descriptionKeys])].sort(
                  compareCodeUnits,
                ),
              }),
        },
      });
      const scope = expectedScope(type);
      const trigger = childBlocks(assignment.value, 'trigger')[0];
      const eventConditions =
        trigger === undefined
          ? []
          : [this.condition(ownerId, 'event_trigger', trigger, ['trigger'])];
      if (trigger !== undefined) {
        this.walk(trigger, {
          ownerId,
          sourceScope: scope,
          phase: 'other',
          conditions: eventConditions,
          helperStack: [],
          semanticPath: [id, 'trigger'],
        });
      }
      for (const [field, fieldAssignments] of [
        ['title', titleAssignments],
        ['desc', descriptionAssignments],
      ] as const) {
        const fieldOccurrences = new Map<string, number>();
        for (const fieldAssignment of fieldAssignments) {
          if (fieldAssignment.value.type !== 'block') continue;
          this.walk(fieldAssignment.value, {
            ownerId,
            sourceScope: scope,
            phase: 'other',
            conditions: [],
            helperStack: [],
            semanticPath: [
              id,
              semanticOccurrenceSegment(
                field,
                semanticSourceEntry(fieldAssignment.value),
                fieldOccurrences,
              ),
            ],
            effectContext: false,
          });
        }
      }
      for (const [phase, key] of [
        ['immediate', 'immediate'],
        ['after', 'after'],
      ] as const) {
        const phaseOccurrences = new Map<string, number>();
        childBlocks(assignment.value, key).forEach((block) =>
          this.walk(block, {
            ownerId,
            sourceScope: scope,
            phase,
            conditions: eventConditions,
            helperStack: [],
            semanticPath: [
              id,
              semanticOccurrenceSegment(key, semanticSourceEntry(block), phaseOccurrences),
            ],
          }),
        );
      }
      const options = childBlocks(assignment.value, 'option');
      const optionNameCounts = new Map<string, number>();
      for (const option of options) {
        const nameKey = firstScalar(option, 'name')?.value ?? '<unnamed>';
        optionNameCounts.set(nameKey, (optionNameCounts.get(nameKey) ?? 0) + 1);
      }
      const optionOccurrences = new Map<string, number>();
      options.forEach((option, optionIndex) => {
        const nameKey = firstScalar(option, 'name')?.value;
        const semanticName = nameKey ?? '<unnamed>';
        const optionSemantic =
          nameKey !== undefined && optionNameCounts.get(semanticName) === 1
            ? { nameKey }
            : { nameKey: semanticName, content: semanticSourceEntry(option) };
        const optionOccurrence = semanticOccurrenceSegment(
          'option',
          optionSemantic,
          optionOccurrences,
        );
        const optionId = this.uniqueId('option', {
          eventDefinition: ownerId,
          optionOccurrence,
        });
        const optionTrigger = childBlocks(option, 'trigger')[0];
        const conditions =
          optionTrigger === undefined
            ? []
            : [
                this.condition(optionId, 'option_trigger', optionTrigger, [
                  'option',
                  optionId,
                  'trigger',
                ]),
              ];
        const effectCount = assignments(option).filter(
          ({ key }) => !['name', 'trigger', 'ai_chance'].includes(key.value),
        ).length;
        this.addNode({
          id: optionId,
          kind: 'option',
          label: nameKey ?? `Option ${optionIndex + 1}`,
          eventId: id,
          sourcePath: this.file.displayPath,
          location: this.location(option, nameKey ?? id),
          metadata: {
            optionIndex,
            effectCount,
            hasEffects: effectCount > 0,
            hasName: nameKey !== undefined,
            ...(nameKey === undefined ? {} : { nameKey }),
          },
        });
        this.addEdge(ownerId, optionId, 'option_branch', option, conditions, {
          phase: 'option',
          sourceScope: scope,
          semanticPath: [id, 'option_branch', optionId],
        });
        this.walk(option, {
          ownerId: optionId,
          sourceScope: scope,
          phase: 'option',
          conditions,
          helperStack: [],
          semanticPath: [id, 'option', optionId],
        });
      });
      const meanTimeToHappen = childBlocks(assignment.value, 'mean_time_to_happen')[0];
      if (!triggeredOnly && (trigger !== undefined || meanTimeToHappen !== undefined)) {
        const meanTimeConditions =
          meanTimeToHappen === undefined
            ? []
            : childBlocks(meanTimeToHappen, 'modifier').map((modifier, modifierIndex) =>
                this.condition(ownerId, 'weight_modifier', modifier, [
                  id,
                  'mean_time_to_happen',
                  `modifier:${modifierIndex}`,
                ]),
              );
        if (meanTimeToHappen !== undefined) {
          this.walk(meanTimeToHappen, {
            ownerId,
            sourceScope: scope,
            phase: 'other',
            conditions: meanTimeConditions,
            helperStack: [],
            semanticPath: [id, 'mean_time_to_happen'],
            effectContext: false,
          });
        }
        const entryId = this.uniqueId('entry', {
          kind: 'implicit_event_trigger',
          event: id,
          ordinal,
        });
        this.addNode({
          id: entryId,
          kind: 'entry',
          label: `${id} automatic trigger`,
          sourcePath: this.file.displayPath,
          location: this.location(assignment, id),
          metadata: { entryKind: 'implicit_event_trigger', scope },
        });
        const entryEvidence = meanTimeToHappen ?? trigger ?? assignment;
        this.addEdge(
          entryId,
          ownerId,
          'implicit_event_entry',
          entryEvidence,
          [...eventConditions, ...meanTimeConditions],
          {
            phase: 'entry',
            sourceScope: scope,
            ...(meanTimeToHappen === undefined
              ? {}
              : {
                  timing: this.meanTimeTiming(meanTimeToHappen),
                }),
            semanticPath: [id, 'implicit_event_trigger'],
          },
        );
      }
    }
  }

  private analyzeHelpers(): void {
    for (const assignment of assignments(this.document.root)) {
      if (assignment.value.type !== 'block') continue;
      if (this.#knownHelpers.size > 0 && !this.#knownHelpers.has(assignment.key.value)) continue;
      const name = assignment.key.value;
      if (
        this.context.activeHelperPaths !== undefined &&
        this.context.activeHelperPaths.get(name) !== this.file.displayPath
      ) {
        continue;
      }
      const ownerId = `helper:${name}`;
      this.addNode({
        id: ownerId,
        kind: 'helper',
        label: name,
        sourcePath: this.file.displayPath,
        location: this.location(assignment, name),
        metadata: { name },
      });
      this.walk(assignment.value, {
        ownerId,
        sourceScope: 'unknown',
        phase: 'helper',
        conditions: [],
        helperStack: [name],
        semanticPath: ['helper', name],
      });
    }
  }

  private analyzeOnActions(): void {
    const containers = childBlocks(this.document.root, 'on_actions');
    const roots = containers.length === 0 ? [this.document.root] : containers;
    roots.forEach((root) => {
      for (const action of assignments(root)) {
        if (
          action.value.type !== 'block' ||
          (containers.length === 0 && !action.key.value.startsWith('on_'))
        ) {
          continue;
        }
        const actionScope = onActionScope(action.key.value);
        const ownerId = this.entryNode('on_action', action.key.value, action, actionScope);
        const eventOccurrences = new Map<string, number>();
        for (const events of childBlocks(action.value, 'events')) {
          events.entries.forEach((entry) => {
            if (entry.type !== 'scalar') return;
            this.recordEventCall(entry.value, entry, {
              ownerId,
              sourceScope: actionScope,
              phase: 'entry',
              conditions: [],
              helperStack: [],
              semanticPath: [
                action.key.value,
                'events',
                semanticOccurrenceSegment('event', { target: entry.value }, eventOccurrences),
              ],
              reason: 'on_action_entry',
            });
          });
        }
        this.walk(action.value, {
          ownerId,
          sourceScope: actionScope,
          phase: 'entry',
          conditions: [],
          helperStack: [],
          semanticPath: [action.key.value],
        });
      }
    });
  }

  private analyzeFocuses(): void {
    this.visitAssignments(this.document.root, (assignment, ancestors) => {
      if (assignment.key.value !== 'focus' || assignment.value.type !== 'block') return;
      const id = firstScalar(assignment.value, 'id')?.value;
      if (id === undefined) return;
      const ownerId = this.entryNode('focus', id, assignment, 'country');
      for (const key of ['available', 'bypass', 'allow_branch']) {
        const blockOccurrences = new Map<string, number>();
        childBlocks(assignment.value, key).forEach((block) => {
          const occurrence = semanticOccurrenceSegment(
            key,
            semanticSourceEntry(block),
            blockOccurrences,
          );
          this.walk(block, {
            ownerId,
            sourceScope: 'country',
            phase: 'other',
            conditions: [this.condition(ownerId, 'branch_guard', block, [id, occurrence])],
            helperStack: [],
            semanticPath: [...ancestors, id, occurrence],
          });
        });
      }
      const rewardOccurrences = new Map<string, number>();
      childBlocks(assignment.value, 'completion_reward').forEach((block) =>
        this.walk(block, {
          ownerId,
          sourceScope: 'country',
          phase: 'entry',
          conditions: [],
          helperStack: [],
          semanticPath: [
            ...ancestors,
            id,
            semanticOccurrenceSegment(
              'completion_reward',
              semanticSourceEntry(block),
              rewardOccurrences,
            ),
          ],
        }),
      );
    });
  }

  private analyzeDecisions(): void {
    this.visitAssignments(this.document.root, (assignment, ancestors) => {
      if (assignment.value.type !== 'block') return;
      const id = assignment.key.value;
      if (this.context.knownDecisionIds !== undefined && !this.context.knownDecisionIds.has(id))
        return;
      if (
        this.context.activeDecisionPaths !== undefined &&
        this.context.activeDecisionPaths.get(id) !== this.file.displayPath
      ) {
        return;
      }
      if (this.context.knownDecisionIds === undefined && ancestors.length !== 1) return;
      const mission = firstScalar(assignment.value, 'days_mission_timeout') !== undefined;
      const ownerId = this.entryNode(mission ? 'mission' : 'decision', id, assignment, 'country');
      for (const key of [
        'visible',
        'available',
        'allowed',
        'activation',
        'remove_trigger',
        'complete_trigger',
        'target_trigger',
      ]) {
        const blockOccurrences = new Map<string, number>();
        childBlocks(assignment.value, key).forEach((block) => {
          const occurrence = semanticOccurrenceSegment(
            key,
            semanticSourceEntry(block),
            blockOccurrences,
          );
          this.walk(block, {
            ownerId,
            sourceScope: 'country',
            phase: 'other',
            conditions: [this.condition(ownerId, 'branch_guard', block, [id, occurrence])],
            helperStack: [],
            semanticPath: [id, occurrence],
          });
        });
      }
      for (const key of [
        'complete_effect',
        'remove_effect',
        'timeout_effect',
        'cancel_effect',
        'select_effect',
      ]) {
        const blockOccurrences = new Map<string, number>();
        childBlocks(assignment.value, key).forEach((block) =>
          this.walk(block, {
            ownerId,
            sourceScope: 'country',
            phase: 'entry',
            conditions: [],
            helperStack: [],
            semanticPath: [
              id,
              semanticOccurrenceSegment(key, semanticSourceEntry(block), blockOccurrences),
            ],
          }),
        );
      }
    });
  }

  private analyzeSetup(kind: 'country_setup' | 'state_setup', scope: 'country' | 'state'): void {
    const name =
      this.file.relativePath.replaceAll('\\', '/').split('/').at(-1) ?? this.file.displayPath;
    const ownerId = this.uniqueId('entry', { kind, name });
    const edgeCount = this.edges.length;
    const stateCount = this.stateAccesses.length;
    this.walk(this.document.root, {
      ownerId,
      sourceScope: scope,
      phase: 'entry',
      conditions: [],
      helperStack: [],
      semanticPath: [kind, name],
    });
    if (this.edges.length === edgeCount) {
      this.stateAccesses.splice(stateCount);
      return;
    }
    this.addNode({
      id: ownerId,
      kind: 'entry',
      label: name,
      sourcePath: this.file.displayPath,
      location: this.location(this.document.root, name),
      metadata: { entryKind: kind, scope },
    });
  }

  private analyzeOther(): void {
    const ownerId = this.uniqueId('entry', { kind: 'other', path: this.file.displayPath });
    const before = this.edges.length + this.stateAccesses.length;
    this.walk(this.document.root, {
      ownerId,
      sourceScope: 'unknown',
      phase: 'other',
      conditions: [],
      helperStack: [],
      semanticPath: ['other'],
      effectContext: true,
    });
    if (this.edges.length + this.stateAccesses.length > before) {
      this.addNode({
        id: ownerId,
        kind: 'entry',
        label: this.file.relativePath,
        sourcePath: this.file.displayPath,
        location: this.location(this.document.root, this.file.relativePath),
        metadata: { entryKind: 'other', scope: 'unknown' },
      });
    }
  }

  private entryNode(
    kind: EventEntryKind,
    name: string,
    node: { start: number; end: number },
    scope: EventScopeKind,
  ): string {
    const id = this.uniqueId('entry', { kind, name });
    const reason = kind === 'focus' ? 'focus' : kind;
    this.addNode({
      id,
      kind: 'entry',
      label: name,
      sourcePath: this.file.displayPath,
      location: this.location(node, name),
      metadata: { entryKind: kind, scope, reason },
    });
    return id;
  }

  private condition(
    ownerId: string,
    kind: EventCondition['kind'],
    node: SourceValue,
    _semanticPath: string[],
  ): EventCondition {
    const semantic = {
      ownerId,
      kind,
      content: semanticSourceEntry(node),
    };
    return {
      id: this.uniqueOccurrenceId('event_condition', semantic, this.#conditionCollisions),
      kind,
      expression: this.document.text
        .slice(node.start, node.end)
        .trim()
        .slice(0, EVENT_GRAPH_MAX_CONDITION_TEXT),
      location: this.location(node),
      confidence: 'confirmed',
    };
  }

  private walk(block: BlockNode, context: WalkContext): void {
    const semanticOccurrences = new Map<string, number>();
    block.entries.forEach((entry) => {
      this.#budget.spend('event effect entry');
      if (entry.type !== 'assignment') return;
      const key = entry.key.value;
      const normalizedKey = key.toLowerCase();
      const occurrence = semanticOccurrenceSegment(
        key,
        semanticSourceEntry(entry),
        semanticOccurrences,
      );
      const semanticPath = [...context.semanticPath, occurrence];
      const effectContext = context.effectContext ?? context.phase !== 'other';
      const qualifiedDynamicScope = isQualifiedDynamicScope(key);
      const chainedScope = isScopeChain(key);
      const literalCountryTag = isLiteralCountryTag(key);
      if (effectContext && EVENT_CALLS.has(normalizedKey as EventType)) {
        const id = scalarOrField(entry.value, 'id');
        if (id !== undefined) this.recordEventCall(id, entry, { ...context, semanticPath });
        else
          this.recordDynamicEvent(
            valueText(this.document, entry.value),
            entry,
            context.ownerId,
            semanticPath,
          );
        return;
      }
      if (context.suppressSemantics !== true) this.recordState(entry, context, semanticPath);
      if (effectContext && this.#knownHelpers.has(key)) {
        const target = `helper:${key}`;
        this.addEdge(context.ownerId, target, 'scripted_effect_call', entry, context.conditions, {
          phase: context.phase,
          sourceScope: context.sourceScope,
          helperStack: context.helperStack,
          semanticPath,
        });
        return;
      }
      if (
        this.context.inventoryComplete !== false &&
        missingHelperCandidate(key, entry.value, effectContext)
      ) {
        const target = this.unresolvedNode(
          'missing_helper',
          key,
          entry,
          context.ownerId,
          semanticPath,
        );
        this.addEdge(context.ownerId, target, 'scripted_effect_call', entry, context.conditions, {
          phase: context.phase,
          sourceScope: context.sourceScope,
          helperStack: context.helperStack,
          semanticPath,
        });
        return;
      }
      if (effectContext && isDynamic(key) && !qualifiedDynamicScope) {
        this.recordDynamicHelper(key, entry, context.ownerId, semanticPath);
        return;
      }
      if (effectContext && normalizedKey === 'random_events' && entry.value.type === 'block') {
        const memberOccurrences = new Map<string, number>();
        for (const weighted of assignments(entry.value)) {
          if (weighted.value.type !== 'scalar' || weighted.value.value === '0') continue;
          const weight = weighted.key.value;
          this.recordEventCall(weighted.value.value, weighted, {
            ...context,
            semanticPath: [
              ...semanticPath,
              semanticOccurrenceSegment(
                'weighted_event',
                { weight, target: weighted.value.value },
                memberOccurrences,
              ),
            ],
            weight,
            reason: 'random_event_call',
          });
        }
        return;
      }
      if (entry.value.type !== 'block') return;
      let conditions = context.conditions;
      if (normalizedKey === 'if' || normalizedKey === 'else_if' || normalizedKey === 'while') {
        const limit = childBlocks(entry.value, 'limit')[0];
        if (limit !== undefined)
          conditions = [
            ...conditions,
            this.condition(context.ownerId, 'limit', limit, [...semanticPath, 'limit']),
          ];
      }
      if (normalizedKey === 'limit')
        conditions = [
          ...conditions,
          this.condition(context.ownerId, 'limit', entry.value, semanticPath),
        ];
      if (normalizedKey === 'trigger') {
        conditions = [
          ...conditions,
          this.condition(context.ownerId, 'branch_guard', entry.value, semanticPath),
        ];
      }
      if (normalizedKey === 'random') {
        const chance = firstScalar(entry.value, 'chance');
        if (chance !== undefined) {
          conditions = [
            ...conditions,
            this.condition(context.ownerId, 'random_chance', chance, [...semanticPath, 'chance']),
          ];
        }
      }
      const scopeBlock = SCOPE_BLOCKS[normalizedKey];
      const explicitDynamicScope = qualifiedDynamicScope || chainedScope;
      const scope = explicitDynamicScope
        ? 'unknown'
        : literalCountryTag
          ? 'country'
          : (scopeBlock ?? context.sourceScope);
      const scopeExpression =
        explicitDynamicScope || literalCountryTag || scopeBlock !== undefined
          ? key
          : context.scopeExpression;
      const phase = normalizedKey === 'hidden_effect' ? 'hidden' : context.phase;
      if (effectContext && normalizedKey === 'random_list') {
        const branchOccurrences = new Map<string, number>();
        for (const weighted of assignments(entry.value)) {
          const weight = weighted.key.value;
          if (weighted.value.type !== 'block') continue;
          const branchOccurrence = semanticOccurrenceSegment(
            'weighted_branch',
            { weight, content: semanticSourceEntry(weighted.value) },
            branchOccurrences,
          );
          const weightModifiers: EventCondition[] = [];
          childBlocks(weighted.value, 'modifier').forEach((modifier, modifierIndex) => {
            weightModifiers.push(
              this.condition(context.ownerId, 'weight_modifier', modifier, [
                ...semanticPath,
                branchOccurrence,
                `modifier:${modifierIndex}`,
              ]),
            );
          });
          this.walk(weighted.value, {
            ...context,
            conditions,
            sourceScope: scope,
            ...(scopeExpression === undefined ? {} : { scopeExpression }),
            semanticPath: [...semanticPath, branchOccurrence],
            weight,
            weightModifiers,
            reason: 'weighted_event_call',
            effectContext: true,
          });
        }
        return;
      }
      if (
        CONTROL_BLOCKS.has(normalizedKey) ||
        scopeBlock !== undefined ||
        normalizedKey === 'effect' ||
        normalizedKey === 'completion_reward' ||
        normalizedKey === 'random'
      ) {
        this.walk(entry.value, {
          ...context,
          conditions,
          sourceScope: scope,
          phase,
          semanticPath,
          ...(scopeExpression === undefined ? {} : { scopeExpression }),
          effectContext: NON_EXECUTING_BLOCKS.has(normalizedKey) ? false : effectContext,
          suppressSemantics:
            context.suppressSemantics === true || TOOLTIP_ONLY_BLOCKS.has(normalizedKey),
          ...(normalizedKey === 'random' ? { reason: 'random_event_call' as const } : {}),
        });
        return;
      }
      this.walk(entry.value, {
        ...context,
        conditions,
        sourceScope: scope,
        phase,
        effectContext: NON_EXECUTING_BLOCKS.has(normalizedKey) ? false : effectContext,
        suppressSemantics:
          context.suppressSemantics === true || TOOLTIP_ONLY_BLOCKS.has(normalizedKey),
        semanticPath,
        ...(scopeExpression === undefined ? {} : { scopeExpression }),
      });
    });
  }

  private recordEventCall(
    id: string,
    node: ScalarNode | AssignmentNode,
    context: WalkContext,
  ): void {
    if (isDynamic(id)) {
      this.recordDynamicEvent(id, node, context.ownerId, context.semanticPath);
      return;
    }
    const known = this.#knownEvents.size === 0 || this.#knownEvents.has(id);
    const target = known
      ? this.eventNodeId(id)
      : this.unresolvedNode(
          this.context.inventoryComplete === false ? 'partial_source' : 'missing_event',
          id,
          node,
          context.ownerId,
          context.semanticPath,
        );
    const assignmentValue = node.type === 'assignment' ? node.value : undefined;
    const reason =
      context.reason ?? this.edgeReason(context.phase, assignmentValue, context.weight);
    const timing = assignmentValue === undefined ? undefined : this.timing(assignmentValue);
    this.addEdge(context.ownerId, target, reason, node, context.conditions, {
      phase: context.phase,
      sourceScope: context.sourceScope,
      helperStack: context.helperStack,
      ...(timing === undefined ? {} : { timing }),
      ...(context.weight === undefined ? {} : { weight: context.weight }),
      ...(context.weightModifiers === undefined
        ? {}
        : { weightModifiers: context.weightModifiers }),
      ...(context.scopeExpression === undefined
        ? {}
        : { scopeExpression: context.scopeExpression }),
      semanticPath: context.semanticPath,
      targetEventId: id,
    });
  }

  private eventNodeId(eventId: string): string {
    return `event:${eventId}`;
  }

  private edgeReason(
    phase: WalkContext['phase'],
    value: SourceValue | undefined,
    weight: string | undefined,
  ): EventEdgeReason {
    if (weight !== undefined) return 'weighted_event_call';
    const timing = value === undefined ? undefined : this.timing(value);
    if (timing !== undefined && timing.mode !== 'immediate') return 'delayed_event_call';
    if (phase === 'immediate') return 'immediate_event_call';
    if (phase === 'option') return 'option_event_call';
    if (phase === 'hidden') return 'hidden_event_call';
    if (phase === 'after') return 'after_event_call';
    if (phase === 'entry') return 'other_entry';
    return 'immediate_event_call';
  }

  private meanTimeTiming(value: BlockNode): EventTiming {
    const timing = this.timing(value);
    if (timing?.mode === 'unknown') return timing;
    return {
      ...(timing ?? {}),
      mode: 'mean_time_to_happen',
      expression: valueText(this.document, value),
    };
  }

  private timing(value: SourceValue): EventTiming | undefined {
    if (value.type !== 'block') return undefined;
    const fields = {
      years: firstScalar(value, 'years')?.value,
      hours: firstScalar(value, 'hours')?.value,
      days: firstScalar(value, 'days')?.value,
      months: firstScalar(value, 'months')?.value,
      randomHours:
        firstScalar(value, 'random_hours')?.value ?? firstScalarForKey(value, 'random')?.value,
      randomDays: firstScalar(value, 'random_days')?.value,
      randomMonths: firstScalar(value, 'random_months')?.value,
      date: firstScalar(value, 'date')?.value,
    };
    if (Object.values(fields).every((field) => field === undefined)) return undefined;
    const numericFields = [
      fields.years,
      fields.hours,
      fields.days,
      fields.months,
      fields.randomHours,
      fields.randomDays,
      fields.randomMonths,
    ];
    const dynamic =
      numericFields.some((field) => field !== undefined && !/^[+-]?\d+(?:\.\d+)?$/u.test(field)) ||
      (fields.date !== undefined && !/^\d{1,4}\.\d{1,2}\.\d{1,2}$/u.test(fields.date));
    const fixed =
      fields.years !== undefined ||
      fields.hours !== undefined ||
      fields.days !== undefined ||
      fields.months !== undefined;
    const random =
      fields.randomHours !== undefined ||
      fields.randomDays !== undefined ||
      fields.randomMonths !== undefined;
    const mode = dynamic
      ? 'unknown'
      : fields.date !== undefined
        ? 'date'
        : fixed && random
          ? 'fixed_and_random'
          : random
            ? 'random'
            : 'fixed';
    return {
      mode,
      ...(fields.years === undefined ? {} : { years: fields.years }),
      ...(fields.hours === undefined ? {} : { hours: fields.hours }),
      ...(fields.days === undefined ? {} : { days: fields.days }),
      ...(fields.months === undefined ? {} : { months: fields.months }),
      ...(fields.randomHours === undefined ? {} : { randomHours: fields.randomHours }),
      ...(fields.randomDays === undefined ? {} : { randomDays: fields.randomDays }),
      ...(fields.randomMonths === undefined ? {} : { randomMonths: fields.randomMonths }),
      ...(fields.date === undefined ? {} : { date: fields.date }),
      ...(dynamic ? { expression: valueText(this.document, value) } : {}),
    };
  }

  private addEdge(
    from: string,
    to: string,
    reason: EventEdgeReason,
    node: { start: number; end: number },
    conditions: EventCondition[],
    extra: {
      phase: WalkContext['phase'];
      sourceScope: EventScopeKind;
      helperStack?: string[];
      timing?: EventTiming;
      weight?: string;
      weightModifiers?: EventCondition[];
      targetEventId?: string;
      scopeExpression?: string;
      semanticPath?: string[];
    },
  ): void {
    const location = this.location(node);
    const semanticIdentity = {
      from,
      to,
      reason,
      phase: extra.phase,
      sourceScope: extra.sourceScope,
      conditions: conditions.map(({ id: conditionId }) => conditionId),
      helperStack: extra.helperStack ?? [],
      timing: extra.timing,
      weight: extra.weight,
      weightModifiers: extra.weightModifiers?.map(({ id }) => id),
      targetEventId: extra.targetEventId,
      scopeExpression: extra.scopeExpression,
    };
    const collisionKey = deterministicId('event_edge', semanticIdentity);
    const collisionOrdinal = this.#edgeCollisions.get(collisionKey) ?? 0;
    this.#edgeCollisions.set(collisionKey, collisionOrdinal + 1);
    const id =
      collisionOrdinal === 0
        ? collisionKey
        : deterministicId('event_edge', { ...semanticIdentity, collisionOrdinal });
    const destinationType =
      extra.targetEventId === undefined
        ? undefined
        : this.#knownEventTypes.get(extra.targetEventId);
    this.edges.push({
      id,
      from,
      to,
      reason,
      conditions,
      helperStack: [...(extra.helperStack ?? [])],
      location,
      provenance: [
        {
          role:
            reason === 'scripted_effect_call'
              ? 'helper_call'
              : extra.phase === 'entry'
                ? 'entry'
                : 'invocation',
          location,
        },
      ],
      confidence: to.startsWith('unresolved_')
        ? 'unresolved'
        : extra.timing?.mode === 'unknown'
          ? 'low'
          : 'confirmed',
      derived: false,
      ...(extra.timing === undefined ? {} : { timing: extra.timing }),
      ...(extra.weight === undefined
        ? {}
        : {
            weight: {
              value: extra.weight,
              modifiers: [...(extra.weightModifiers ?? [])],
              valid: weightValidity(extra.weight),
            },
          }),
      ...(destinationType === undefined
        ? {}
        : {
            scope: {
              source: extra.sourceScope,
              destination: expectedScope(destinationType),
              ...(extra.scopeExpression === undefined ? {} : { expression: extra.scopeExpression }),
              confidence: extra.sourceScope === 'unknown' ? 'low' : 'high',
            },
          }),
      metadata: {
        ...(extra.targetEventId === undefined ? {} : { targetEventId: extra.targetEventId }),
        ...(extra.timing?.mode === 'unknown'
          ? { blocker: 'Event timing could not be resolved statically.' }
          : {}),
      },
    });
  }

  private recordDynamicEvent(
    expression: string,
    node: { start: number; end: number },
    ownerId: string,
    semanticPath: string[],
  ): void {
    const target = this.unresolvedNode('dynamic_event', expression, node, ownerId, semanticPath);
    this.addEdge(ownerId, target, 'unresolved_dynamic_reference', node, [], {
      phase: 'other',
      sourceScope: 'unknown',
      semanticPath,
    });
  }

  private recordDynamicHelper(
    expression: string,
    node: { start: number; end: number },
    ownerId: string,
    semanticPath: string[],
  ): void {
    const target = this.unresolvedNode('dynamic_helper', expression, node, ownerId, semanticPath);
    this.addEdge(ownerId, target, 'unresolved_dynamic_reference', node, [], {
      phase: 'helper',
      sourceScope: 'unknown',
      semanticPath,
    });
  }

  private unresolvedNode(
    kind: EventUnresolvedAnalysis['kind'],
    expression: string,
    node: { start: number; end: number },
    ownerId: string,
    _semanticPath: string[],
  ): string {
    const id = this.uniqueOccurrenceId(
      'unresolved',
      { kind, ownerId, expression },
      this.#unresolvedCollisions,
    );
    const blocker =
      kind === 'missing_event'
        ? {
            code: 'EVENT_REFERENCE_MISSING',
            message: `Event ${expression} is absent from the active catalog`,
          }
        : kind === 'missing_helper'
          ? {
              code: 'EVENT_HELPER_UNRESOLVED',
              message: `Scripted helper ${expression} is absent from the active catalog`,
            }
          : kind === 'partial_source'
            ? {
                code: 'PARTIAL_SOURCE_INVENTORY',
                message: 'A skipped source could contain this definition',
              }
            : {
                code:
                  kind === 'dynamic_helper'
                    ? 'EVENT_HELPER_UNRESOLVED'
                    : 'EVENT_DYNAMIC_DISPATCH_UNRESOLVED',
                message: 'Runtime expression cannot be resolved',
              };
    this.addNode({
      id,
      kind: 'unresolved',
      label: expression,
      sourcePath: this.file.displayPath,
      location: this.location(node),
      metadata: { unresolvedKind: kind, expression },
    });
    this.unresolved.push({
      id,
      kind,
      expression,
      ownerId,
      location: this.location(node),
      confidence: 'unresolved',
      blockers: [blocker],
    });
    return id;
  }

  private recordState(
    assignment: AssignmentNode,
    context: WalkContext,
    semanticPath: string[],
  ): void {
    const keyedTarget = /^(event_target|global_event_target|scope):([A-Za-z0-9_.-]+)$/u.exec(
      assignment.key.value,
    );
    if (keyedTarget !== null) {
      this.addState(
        context,
        keyedTarget[1] === 'global_event_target'
          ? 'global_event_target'
          : keyedTarget[1] === 'scope'
            ? 'saved_scope'
            : 'event_target',
        keyedTarget[2]!,
        'read',
        assignment.key,
        [...semanticPath, 'scope_read'],
        false,
      );
    }
    const rule = STATE_RULES[assignment.key.value];
    if (rule === undefined) {
      const raw = valueText(this.document, assignment.value);
      for (const match of raw.matchAll(
        /\b(event_target|global_event_target):([A-Za-z0-9_.-]+)/gu,
      )) {
        this.addState(
          context,
          match[1] === 'global_event_target' ? 'global_event_target' : 'event_target',
          match[2]!,
          'read',
          assignment,
          semanticPath,
          false,
        );
      }
      return;
    }
    let kind = rule.kind;
    let name = scalarOrField(assignment.value, rule.nameField ?? 'name');
    if (name === undefined && assignment.value.type === 'block') {
      const candidate = assignments(assignment.value).find(
        ({ key }) => !['value', 'compare', 'tooltip'].includes(key.value),
      );
      name = candidate?.key.value;
    }
    if (assignment.key.value === 'clear_global_event_targets') name = '*';
    if (name === undefined) return;
    if ((kind === 'variable' || kind === 'global_variable') && name.startsWith('global.')) {
      kind = 'global_variable';
      name = name.slice('global.'.length);
    }
    let access = rule.access;
    const writerKey = `${kind}:${name}:${rule.storage ?? ''}`;
    if (
      access === 'replace' &&
      (kind === 'event_target' || kind === 'global_event_target' || kind === 'saved_scope')
    ) {
      access = this.#seenStateWriters.has(writerKey) ? 'replace' : 'write';
      this.#seenStateWriters.add(writerKey);
    } else if (access === 'write') {
      this.#seenStateWriters.add(writerKey);
    }
    this.addState(
      context,
      kind,
      name,
      access,
      assignment,
      semanticPath,
      isDynamic(name),
      rule.storage === undefined ? {} : { storage: rule.storage },
    );
  }

  private addState(
    context: WalkContext,
    kind: EventStateKind,
    name: string,
    access: EventStateAccessKind,
    node: { start: number; end: number },
    _semanticPath: string[],
    dynamic: boolean,
    metadata: EventStateAccess['metadata'] = {},
  ): void {
    const semantic = {
      ownerId: context.ownerId,
      kind,
      name,
      access,
      scope: context.sourceScope,
      helperStack: context.helperStack,
      conditions: context.conditions.map(({ id }) => id),
      dynamic,
      metadata,
    };
    this.stateAccesses.push({
      id: this.uniqueOccurrenceId('event_state', semantic, this.#stateCollisions),
      ownerId: context.ownerId,
      kind,
      name,
      access,
      location: this.location(node, name),
      confidence: dynamic ? 'unresolved' : 'confirmed',
      scope: context.sourceScope,
      helperStack: [...context.helperStack],
      conditions: [...context.conditions],
      dynamic,
      metadata,
    });
  }

  private visitAssignments(
    block: BlockNode,
    visit: (assignment: AssignmentNode, ancestors: string[]) => void,
    ancestors: string[] = [],
  ): void {
    for (const entry of block.entries) {
      if (entry.type !== 'assignment') continue;
      visit(entry, ancestors);
      if (entry.value.type === 'block')
        this.visitAssignments(entry.value, visit, [...ancestors, entry.key.value]);
    }
  }
}

export function analyzeEventSource(
  file: ScannedFile,
  context: EventSourceAnalysisContext = {},
): EventSourceFragment {
  context.signal?.throwIfAborted();
  const cacheKey = eventSemanticFragmentCacheKey(file, context.catalogFingerprint);
  const base = {
    cacheKey,
    sourcePath: file.displayPath,
    sourceHash: file.sha256,
  };
  const sourcePath = normalizedPath(file);
  if (sourcePath.endsWith('.yml') || sourcePath.endsWith('.yaml')) {
    const document = parseLocalisation(file.bytes, file.displayPath);
    return {
      ...base,
      nodes: [],
      edges: [],
      stateAccesses: [],
      issues: document.diagnostics.map(issueFromDiagnostic),
      unresolved: [],
      localisation: document.entries
        .map((entry) => ({
          key: entry.key,
          language: entry.language,
          value: entry.value,
          location: {
            path: file.displayPath,
            start: { line: entry.line, column: 1, offset: entry.start },
            end: {
              line: entry.line,
              column: Math.max(1, entry.end - entry.start + 1),
              offset: entry.end,
            },
          },
        }))
        .sort(
          (left, right) =>
            compareCodeUnits(left.key, right.key) ||
            compareCodeUnits(left.language, right.language),
        ),
    };
  }
  if (!sourcePath.endsWith('.txt')) {
    return {
      ...base,
      nodes: [],
      edges: [],
      stateAccesses: [],
      issues: [],
      unresolved: [],
      localisation: [],
    };
  }
  const document = parseClausewitz(file.bytes, file.displayPath);
  const analyzer = new FragmentAnalyzer(file, document, context);
  analyzer.issues.push(...document.diagnostics.map(issueFromDiagnostic));
  const partial = sourcePartialLimitDiagnostics(document.diagnostics);
  if (partial.length > 0) {
    analyzer.unresolved.push({
      id: deterministicId('unresolved', {
        source: file.displayPath,
        hash: file.sha256,
        kind: 'partial_source',
      }),
      kind: 'partial_source',
      expression: file.displayPath,
      confidence: 'unresolved',
      blockers: partial.map(({ code, message, location }) => ({
        code,
        message,
        ...(location === undefined ? {} : { location }),
      })),
    });
  } else {
    analyzer.analyze();
  }
  return {
    ...base,
    nodes: analyzer.nodes,
    edges: analyzer.edges,
    stateAccesses: analyzer.stateAccesses,
    issues: analyzer.issues,
    unresolved: analyzer.unresolved,
    localisation: [],
  };
}

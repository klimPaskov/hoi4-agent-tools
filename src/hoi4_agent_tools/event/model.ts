import type { JsonValue } from '../core/canonical.js';
import type { Diagnostic, DiagnosticSeverity, SourceLocation } from '../core/diagnostics.js';
import type { IndexSkippedSource } from '../core/index.js';

export const EVENT_GRAPH_SCHEMA_VERSION = 1 as const;
export const EVENT_GRAPH_PARSER_VERSION = 'clausewitz-cst.v1' as const;

export type EventConfidence = 'confirmed' | 'high' | 'medium' | 'low' | 'unresolved';

export type EventDefectClass =
  'confirmed_error' | 'probable_defect' | 'design_warning' | 'unresolved_analysis';

export type EventType =
  'country_event' | 'news_event' | 'state_event' | 'unit_leader_event' | 'operative_leader_event';

export type EventScopeKind =
  | 'country'
  | 'state'
  | 'province'
  | 'unit_leader'
  | 'operative'
  | 'character'
  | 'global'
  | 'unknown';

export type EventGraphNodeKind =
  'event' | 'option' | 'entry' | 'helper' | 'unresolved' | 'terminal';

export type EventEntryKind =
  | 'on_action'
  | 'focus'
  | 'decision'
  | 'mission'
  | 'country_setup'
  | 'state_setup'
  | 'implicit_event_trigger'
  | 'other';

export interface EventGraphNode {
  id: string;
  kind: EventGraphNodeKind;
  label: string;
  eventId?: string;
  namespace?: string;
  sourcePath?: string;
  location?: SourceLocation;
  metadata: Record<string, JsonValue>;
}

export type EventEdgeReason =
  | 'option_branch'
  | 'immediate_event_call'
  | 'option_event_call'
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
  | 'implicit_event_entry'
  | 'other_entry'
  | 'unresolved_dynamic_reference'
  | 'terminal';

export type EventConditionKind =
  | 'event_trigger'
  | 'option_trigger'
  | 'limit'
  | 'random_chance'
  | 'weight_modifier'
  | 'branch_guard'
  | 'unknown';

export interface EventCondition {
  id: string;
  kind: EventConditionKind;
  expression: string;
  location: SourceLocation;
  confidence: EventConfidence;
}

export interface EventTiming {
  mode:
    | 'immediate'
    | 'fixed'
    | 'random'
    | 'fixed_and_random'
    | 'mean_time_to_happen'
    | 'date'
    | 'unknown';
  years?: string;
  hours?: string;
  days?: string;
  months?: string;
  randomHours?: string;
  randomDays?: string;
  randomMonths?: string;
  date?: string;
  expression?: string;
}

export interface EventWeight {
  value: string;
  modifiers: EventCondition[];
  /** Symbolic variable weights are valid syntax but not statically evaluable. */
  valid: boolean | 'unknown';
}

export interface EventScopeTransition {
  source: EventScopeKind;
  destination: EventScopeKind;
  expression?: string;
  confidence: EventConfidence;
}

export interface EventEdgeProvenance {
  role: 'invocation' | 'helper_call' | 'dispatch' | 'condition' | 'entry';
  location: SourceLocation;
}

export interface EventGraphEdge {
  id: string;
  from: string;
  to: string;
  reason: EventEdgeReason;
  conditions: EventCondition[];
  helperStack: string[];
  location: SourceLocation;
  provenance: EventEdgeProvenance[];
  confidence: EventConfidence;
  derived: boolean;
  timing?: EventTiming;
  weight?: EventWeight;
  scope?: EventScopeTransition;
  metadata: Record<string, JsonValue>;
}

export type EventStateKind =
  | 'country_flag'
  | 'global_flag'
  | 'state_flag'
  | 'variable'
  | 'global_variable'
  | 'array'
  | 'event_target'
  | 'global_event_target'
  | 'saved_scope';

export type EventStateAccessKind = 'read' | 'write' | 'read_write' | 'replace' | 'clear';

export interface EventStateAccess {
  id: string;
  ownerId: string;
  kind: EventStateKind;
  name: string;
  access: EventStateAccessKind;
  location: SourceLocation;
  confidence: EventConfidence;
  scope: EventScopeKind;
  helperStack: string[];
  conditions: EventCondition[];
  dynamic: boolean;
  metadata: Record<string, JsonValue>;
}

export interface EventStateLink {
  id: string;
  stateKind: EventStateKind;
  name: string;
  producerId: string;
  consumerId: string;
  confidence: EventConfidence;
  pathConfirmed: boolean;
}

export interface EventAnalysisBlocker {
  code: string;
  message: string;
  location?: SourceLocation;
  details?: Record<string, JsonValue>;
}

export interface EventIssue {
  code: string;
  classification: EventDefectClass;
  severity: DiagnosticSeverity;
  message: string;
  confidence: EventConfidence;
  location?: SourceLocation;
  related?: SourceLocation[];
  blockers: EventAnalysisBlocker[];
  details: Record<string, JsonValue>;
}

export interface EventUnresolvedAnalysis {
  id: string;
  kind:
    | 'dynamic_event'
    | 'missing_event'
    | 'dynamic_helper'
    | 'missing_helper'
    | 'scope'
    | 'state'
    | 'partial_source';
  expression: string;
  ownerId?: string;
  location?: SourceLocation;
  confidence: EventConfidence;
  blockers: EventAnalysisBlocker[];
}

export interface EventGraphStatistics {
  eventCount: number;
  optionCount: number;
  entryCount: number;
  helperCount: number;
  unresolvedNodeCount: number;
  terminalCount: number;
  edgeCount: number;
  derivedEdgeCount: number;
  stateAccessCount: number;
  issueCount: number;
}

export interface EventGraphSnapshot {
  schemaVersion: typeof EVENT_GRAPH_SCHEMA_VERSION;
  parserVersion: typeof EVENT_GRAPH_PARSER_VERSION;
  workspaceId: string;
  workspaceIdentity: string;
  revision: string;
  complete: boolean;
  sourceHashes: Record<string, string>;
  filesScanned: string[];
  skippedSourceCount: number;
  skippedSources: readonly IndexSkippedSource[];
  nodes: EventGraphNode[];
  edges: EventGraphEdge[];
  stateAccesses: EventStateAccess[];
  stateLinks: EventStateLink[];
  issues: EventIssue[];
  diagnostics: Diagnostic[];
  unresolved: EventUnresolvedAnalysis[];
  statistics: EventGraphStatistics;
}

export interface EventGraphBuildOptions {
  signal?: AbortSignal;
  /** Canonical root-topology identity supplied by the shared workspace resolver. */
  workspaceIdentity?: string;
  /** Tests or long-lived services may provide their own bounded fragment cache. */
  cache?: EventSemanticFragmentCacheLike;
}

export interface EventSemanticFragmentCacheLike {
  get(key: string): EventSourceFragment | undefined;
  set(key: string, fragment: EventSourceFragment, sourceBytes: number): void;
}

export interface EventLocalisationRecord {
  key: string;
  language: string;
  value: string;
  location: SourceLocation;
}

export interface EventSourceFragment {
  cacheKey: string;
  sourcePath: string;
  sourceHash: string;
  nodes: EventGraphNode[];
  edges: EventGraphEdge[];
  stateAccesses: EventStateAccess[];
  issues: EventIssue[];
  unresolved: EventUnresolvedAnalysis[];
  localisation: EventLocalisationRecord[];
}

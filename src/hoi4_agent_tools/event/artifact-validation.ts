import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import {
  EVENT_GRAPH_MAX_CONDITION_TEXT,
  EVENT_GRAPH_MAX_EDGES,
  EVENT_GRAPH_MAX_HELPER_DEPTH,
  EVENT_GRAPH_MAX_ISSUES,
  EVENT_GRAPH_MAX_NODES,
  EVENT_GRAPH_MAX_STATE_ACCESSES,
  EVENT_GRAPH_MAX_STATE_LINKS,
  EVENT_GRAPH_MAX_UNRESOLVED,
} from './limits.js';
import {
  EVENT_GRAPH_PARSER_VERSION,
  EVENT_GRAPH_SCHEMA_VERSION,
  type EventGraphSnapshot,
} from './model.js';

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_CONTAINER_ENTRIES = 500_000;
const MAX_JSON_VALUES = 20_000_000;
const MAX_STRING_LENGTH = 1_048_576;
const MAX_SOURCE_RECORDS = 100_000;
const MAX_DIAGNOSTICS = 20_000;
const MAX_CONDITIONS_PER_EDGE = 10_000;
const MAX_PROVENANCE_PER_EDGE = 10_000;
const MAX_RELATED_LOCATIONS = 1_000;

const nodeKinds = new Set(['event', 'option', 'entry', 'helper', 'unresolved', 'terminal']);
const edgeReasons = new Set([
  'option_branch',
  'immediate_event_call',
  'option_event_call',
  'hidden_event_call',
  'after_event_call',
  'delayed_event_call',
  'random_event_call',
  'weighted_event_call',
  'scripted_effect_call',
  'scripted_effect_expansion',
  'on_action_entry',
  'focus_entry',
  'decision_entry',
  'mission_entry',
  'country_setup_entry',
  'state_setup_entry',
  'implicit_event_entry',
  'other_entry',
  'unresolved_dynamic_reference',
  'terminal',
]);
const confidenceValues = new Set(['confirmed', 'high', 'medium', 'low', 'unresolved']);
const conditionKinds = new Set([
  'event_trigger',
  'option_trigger',
  'limit',
  'random_chance',
  'weight_modifier',
  'branch_guard',
  'unknown',
]);
const provenanceRoles = new Set(['invocation', 'helper_call', 'dispatch', 'condition', 'entry']);
const timingModes = new Set([
  'immediate',
  'fixed',
  'random',
  'fixed_and_random',
  'mean_time_to_happen',
  'date',
  'unknown',
]);
const scopeKinds = new Set([
  'country',
  'state',
  'province',
  'unit_leader',
  'operative',
  'character',
  'global',
  'unknown',
]);
const stateKinds = new Set([
  'country_flag',
  'global_flag',
  'state_flag',
  'variable',
  'global_variable',
  'array',
  'event_target',
  'global_event_target',
  'saved_scope',
]);
const stateAccessKinds = new Set(['read', 'write', 'read_write', 'replace', 'clear']);
const defectClasses = new Set([
  'confirmed_error',
  'probable_defect',
  'design_warning',
  'unresolved_analysis',
]);
const severities = new Set(['info', 'warning', 'error', 'blocker']);
const diagnosticCategories = new Set([
  'syntax',
  'reference',
  'layout',
  'design',
  'rendering',
  'security',
  'validation',
  'map',
  'configuration',
]);
const unresolvedKinds = new Set([
  'dynamic_event',
  'missing_event',
  'dynamic_helper',
  'missing_helper',
  'scope',
  'state',
  'partial_source',
]);
const rootKinds = new Set(['mod', 'game', 'dependency', 'artifact', 'cache', 'fixture']);
const symbolKinds = new Set([
  'focus_tree',
  'focus',
  'continuous_focus_palette',
  'continuous_focus',
  'decision',
  'decision_category',
  'event',
  'idea',
  'leader',
  'formable',
  'scripted_effect',
  'scripted_trigger',
  'sprite',
  'texture',
  'gui_element',
  'scripted_gui',
  'localisation',
  'state',
  'province',
  'province_color',
  'strategic_region',
  'adjacency',
  'supply_node',
  'railway',
]);

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new ServiceError('EVENT_GRAPH_ARTIFACT_INVALID', message, details);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length > maximum) {
    invalid(`${label} exceeds its fixed item ceiling`, {
      count: value.length,
      maximum,
    });
  }
  return value;
}

function string(value: unknown, label: string, maximum = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length > maximum) {
    invalid(`${label} must be a bounded string`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum = MAX_STRING_LENGTH): void {
  if (value !== undefined) string(value, label, maximum);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function enumeration(value: unknown, label: string, allowed: ReadonlySet<string>): string {
  const selected = string(value, label, 128);
  if (!allowed.has(selected)) invalid(`${label} has an unsupported value`, { value: selected });
  return selected;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const selected = string(value, label, 64);
  if (!SHA256.test(selected)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return selected;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`${label} contains a duplicate identifier`, { id: value });
    seen.add(value);
  }
}

function validateJsonShape(value: unknown, signal?: AbortSignal): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    if ((visited & 255) === 0) signal?.throwIfAborted();
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_JSON_VALUES) {
      invalid('Event graph artifact exceeds the fixed structural work ceiling', {
        maximumValues: MAX_JSON_VALUES,
      });
    }
    if (current.depth > MAX_JSON_DEPTH) {
      invalid('Event graph artifact exceeds the fixed JSON nesting ceiling', {
        maximumDepth: MAX_JSON_DEPTH,
      });
    }
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value))
        invalid('Event graph artifact contains a non-finite number');
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_STRING_LENGTH) {
        invalid('Event graph artifact contains an oversized string');
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_CONTAINER_ENTRIES) {
        invalid('Event graph artifact contains an oversized array');
      }
      for (const member of current.value) stack.push({ value: member, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== 'object') invalid('Event graph artifact is not JSON data');
    const entries = Object.entries(current.value as JsonRecord);
    if (entries.length > MAX_JSON_CONTAINER_ENTRIES) {
      invalid('Event graph artifact contains an oversized object');
    }
    for (const [, member] of entries) {
      stack.push({ value: member, depth: current.depth + 1 });
    }
  }
  signal?.throwIfAborted();
}

function validatePosition(value: unknown, label: string): void {
  const selected = record(value, label);
  safeInteger(selected.line, `${label}.line`, 1);
  safeInteger(selected.column, `${label}.column`, 1);
  safeInteger(selected.offset, `${label}.offset`);
}

function validateLocation(value: unknown, label: string): SourceLocation {
  const selected = record(value, label);
  string(selected.path, `${label}.path`, 32_768);
  validatePosition(selected.start, `${label}.start`);
  validatePosition(selected.end, `${label}.end`);
  optionalString(selected.symbol, `${label}.symbol`, 32_768);
  const start = selected.start as { line: number; column: number; offset: number };
  const end = selected.end as { line: number; column: number; offset: number };
  if (end.offset < start.offset) invalid(`${label} ends before it starts`);
  return selected as unknown as SourceLocation;
}

function optionalLocation(value: unknown, label: string): void {
  if (value !== undefined) validateLocation(value, label);
}

function validateCondition(value: unknown, label: string): void {
  const selected = record(value, label);
  string(selected.id, `${label}.id`, 32_768);
  enumeration(selected.kind, `${label}.kind`, conditionKinds);
  string(selected.expression, `${label}.expression`, EVENT_GRAPH_MAX_CONDITION_TEXT);
  validateLocation(selected.location, `${label}.location`);
  enumeration(selected.confidence, `${label}.confidence`, confidenceValues);
}

function validateConditions(value: unknown, label: string): void {
  for (const [index, condition] of array(value, label, MAX_CONDITIONS_PER_EDGE).entries()) {
    validateCondition(condition, `${label}[${index}]`);
  }
}

function validateStringArray(
  value: unknown,
  label: string,
  maximum: number,
  itemMaximum = 32_768,
): string[] {
  return array(value, label, maximum).map((member, index) =>
    string(member, `${label}[${index}]`, itemMaximum),
  );
}

function validateTiming(value: unknown, label: string): void {
  const selected = record(value, label);
  enumeration(selected.mode, `${label}.mode`, timingModes);
  for (const key of [
    'years',
    'hours',
    'days',
    'months',
    'randomHours',
    'randomDays',
    'randomMonths',
    'date',
    'expression',
  ]) {
    optionalString(selected[key], `${label}.${key}`, EVENT_GRAPH_MAX_CONDITION_TEXT);
  }
}

function validateWeight(value: unknown, label: string): void {
  const selected = record(value, label);
  string(selected.value, `${label}.value`, EVENT_GRAPH_MAX_CONDITION_TEXT);
  validateConditions(selected.modifiers, `${label}.modifiers`);
  if (selected.valid !== 'unknown') boolean(selected.valid, `${label}.valid`);
}

function validateScopeTransition(value: unknown, label: string): void {
  const selected = record(value, label);
  enumeration(selected.source, `${label}.source`, scopeKinds);
  enumeration(selected.destination, `${label}.destination`, scopeKinds);
  optionalString(selected.expression, `${label}.expression`, EVENT_GRAPH_MAX_CONDITION_TEXT);
  enumeration(selected.confidence, `${label}.confidence`, confidenceValues);
}

function validateBlocker(value: unknown, label: string): void {
  const selected = record(value, label);
  string(selected.code, `${label}.code`, 1_024);
  string(selected.message, `${label}.message`);
  optionalLocation(selected.location, `${label}.location`);
  if (selected.details !== undefined) record(selected.details, `${label}.details`);
}

function validateDiagnostic(value: unknown, label: string): Diagnostic {
  const selected = record(value, label);
  string(selected.code, `${label}.code`, 1_024);
  enumeration(selected.severity, `${label}.severity`, severities);
  enumeration(selected.category, `${label}.category`, diagnosticCategories);
  string(selected.message, `${label}.message`);
  optionalLocation(selected.location, `${label}.location`);
  if (selected.related !== undefined) {
    for (const [index, location] of array(
      selected.related,
      `${label}.related`,
      MAX_RELATED_LOCATIONS,
    ).entries()) {
      validateLocation(location, `${label}.related[${index}]`);
    }
  }
  optionalString(selected.operationId, `${label}.operationId`, 32_768);
  if (selected.details !== undefined) record(selected.details, `${label}.details`);
  return selected as unknown as Diagnostic;
}

function validateSkippedSource(value: unknown, label: string): void {
  const selected = record(value, label);
  string(selected.path, `${label}.path`, 32_768);
  string(selected.relativePath, `${label}.relativePath`, 32_768);
  enumeration(selected.rootKind, `${label}.rootKind`, rootKinds);
  safeInteger(selected.loadOrder, `${label}.loadOrder`);
  sha256(selected.sha256, `${label}.sha256`);
  validateStringArray(selected.reasonCodes, `${label}.reasonCodes`, 1_000, 1_024);
  const possible = validateStringArray(
    selected.possibleSymbolKinds,
    `${label}.possibleSymbolKinds`,
    symbolKinds.size,
    128,
  );
  for (const kind of possible) {
    if (!symbolKinds.has(kind)) invalid(`${label}.possibleSymbolKinds has an unsupported value`);
  }
}

/**
 * Validate an untrusted, parsed Event Chain Viewer graph before comparison or rendering.
 * The validator is intentionally independent of TypeScript's compile-time types.
 */
export function validateEventGraphArtifact(
  value: unknown,
  signal?: AbortSignal,
): EventGraphSnapshot {
  signal?.throwIfAborted();
  validateJsonShape(value, signal);
  const graph = record(value, 'event graph');
  if (graph.schemaVersion !== EVENT_GRAPH_SCHEMA_VERSION) {
    invalid('Event graph artifact uses an unsupported schema version');
  }
  if (graph.parserVersion !== EVENT_GRAPH_PARSER_VERSION) {
    invalid('Event graph artifact uses an unsupported parser version');
  }
  string(graph.workspaceId, 'event graph.workspaceId', 256);
  sha256(graph.workspaceIdentity, 'event graph.workspaceIdentity');
  sha256(graph.revision, 'event graph.revision');
  boolean(graph.complete, 'event graph.complete');

  const sourceHashes = record(graph.sourceHashes, 'event graph.sourceHashes');
  const sourceHashEntries = Object.entries(sourceHashes);
  if (sourceHashEntries.length > MAX_SOURCE_RECORDS) {
    invalid('event graph.sourceHashes exceeds its fixed item ceiling');
  }
  for (const [sourcePath, sourceHash] of sourceHashEntries) {
    string(sourcePath, 'event graph.sourceHashes key', 32_768);
    sha256(sourceHash, `event graph.sourceHashes[${sourcePath}]`);
  }
  const filesScanned = validateStringArray(
    graph.filesScanned,
    'event graph.filesScanned',
    MAX_SOURCE_RECORDS,
    32_768,
  );
  assertUnique(filesScanned, 'event graph.filesScanned');
  const skippedSourceCount = safeInteger(
    graph.skippedSourceCount,
    'event graph.skippedSourceCount',
  );
  const skippedSources = array(
    graph.skippedSources,
    'event graph.skippedSources',
    MAX_SOURCE_RECORDS,
  );
  if (skippedSources.length > skippedSourceCount) {
    invalid('event graph.skippedSources exceeds the declared skipped source count');
  }
  for (const [index, skipped] of skippedSources.entries()) {
    validateSkippedSource(skipped, `event graph.skippedSources[${index}]`);
  }
  if (graph.complete === true && skippedSourceCount !== 0) {
    invalid('A complete event graph cannot declare skipped sources');
  }

  const nodes = array(graph.nodes, 'event graph.nodes', EVENT_GRAPH_MAX_NODES);
  const nodeIds: string[] = [];
  const nodeKindById = new Map<string, string>();
  for (const [index, candidate] of nodes.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const node = record(candidate, `event graph.nodes[${index}]`);
    const id = string(node.id, `event graph.nodes[${index}].id`, 32_768);
    const kind = enumeration(node.kind, `event graph.nodes[${index}].kind`, nodeKinds);
    string(node.label, `event graph.nodes[${index}].label`);
    optionalString(node.eventId, `event graph.nodes[${index}].eventId`, 32_768);
    optionalString(node.namespace, `event graph.nodes[${index}].namespace`, 32_768);
    optionalString(node.sourcePath, `event graph.nodes[${index}].sourcePath`, 32_768);
    optionalLocation(node.location, `event graph.nodes[${index}].location`);
    record(node.metadata, `event graph.nodes[${index}].metadata`);
    nodeIds.push(id);
    nodeKindById.set(id, kind);
  }
  assertUnique(nodeIds, 'event graph.nodes');
  const knownNodeIds = new Set(nodeIds);

  const edges = array(graph.edges, 'event graph.edges', EVENT_GRAPH_MAX_EDGES);
  const edgeIds: string[] = [];
  let derivedEdgeCount = 0;
  for (const [index, candidate] of edges.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const edge = record(candidate, `event graph.edges[${index}]`);
    const id = string(edge.id, `event graph.edges[${index}].id`, 32_768);
    const from = string(edge.from, `event graph.edges[${index}].from`, 32_768);
    const to = string(edge.to, `event graph.edges[${index}].to`, 32_768);
    if (!knownNodeIds.has(from) || !knownNodeIds.has(to)) {
      invalid('Event graph edge references an unknown node', { edgeId: id, from, to });
    }
    enumeration(edge.reason, `event graph.edges[${index}].reason`, edgeReasons);
    validateConditions(edge.conditions, `event graph.edges[${index}].conditions`);
    validateStringArray(
      edge.helperStack,
      `event graph.edges[${index}].helperStack`,
      EVENT_GRAPH_MAX_HELPER_DEPTH,
      32_768,
    );
    validateLocation(edge.location, `event graph.edges[${index}].location`);
    for (const [provenanceIndex, candidateProvenance] of array(
      edge.provenance,
      `event graph.edges[${index}].provenance`,
      MAX_PROVENANCE_PER_EDGE,
    ).entries()) {
      const provenance = record(
        candidateProvenance,
        `event graph.edges[${index}].provenance[${provenanceIndex}]`,
      );
      enumeration(
        provenance.role,
        `event graph.edges[${index}].provenance[${provenanceIndex}].role`,
        provenanceRoles,
      );
      validateLocation(
        provenance.location,
        `event graph.edges[${index}].provenance[${provenanceIndex}].location`,
      );
    }
    enumeration(edge.confidence, `event graph.edges[${index}].confidence`, confidenceValues);
    if (boolean(edge.derived, `event graph.edges[${index}].derived`)) derivedEdgeCount += 1;
    if (edge.timing !== undefined)
      validateTiming(edge.timing, `event graph.edges[${index}].timing`);
    if (edge.weight !== undefined)
      validateWeight(edge.weight, `event graph.edges[${index}].weight`);
    if (edge.scope !== undefined) {
      validateScopeTransition(edge.scope, `event graph.edges[${index}].scope`);
    }
    record(edge.metadata, `event graph.edges[${index}].metadata`);
    edgeIds.push(id);
  }
  assertUnique(edgeIds, 'event graph.edges');

  const stateAccesses = array(
    graph.stateAccesses,
    'event graph.stateAccesses',
    EVENT_GRAPH_MAX_STATE_ACCESSES,
  );
  const stateAccessIds: string[] = [];
  for (const [index, candidate] of stateAccesses.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const access = record(candidate, `event graph.stateAccesses[${index}]`);
    const id = string(access.id, `event graph.stateAccesses[${index}].id`, 32_768);
    const ownerId = string(access.ownerId, `event graph.stateAccesses[${index}].ownerId`, 32_768);
    if (!knownNodeIds.has(ownerId)) {
      invalid('Event graph state access references an unknown owner', { accessId: id, ownerId });
    }
    enumeration(access.kind, `event graph.stateAccesses[${index}].kind`, stateKinds);
    string(access.name, `event graph.stateAccesses[${index}].name`, 32_768);
    enumeration(access.access, `event graph.stateAccesses[${index}].access`, stateAccessKinds);
    validateLocation(access.location, `event graph.stateAccesses[${index}].location`);
    enumeration(
      access.confidence,
      `event graph.stateAccesses[${index}].confidence`,
      confidenceValues,
    );
    enumeration(access.scope, `event graph.stateAccesses[${index}].scope`, scopeKinds);
    validateStringArray(
      access.helperStack,
      `event graph.stateAccesses[${index}].helperStack`,
      EVENT_GRAPH_MAX_HELPER_DEPTH,
      32_768,
    );
    validateConditions(access.conditions, `event graph.stateAccesses[${index}].conditions`);
    boolean(access.dynamic, `event graph.stateAccesses[${index}].dynamic`);
    record(access.metadata, `event graph.stateAccesses[${index}].metadata`);
    stateAccessIds.push(id);
  }
  assertUnique(stateAccessIds, 'event graph.stateAccesses');
  const knownStateAccessIds = new Set(stateAccessIds);

  const stateLinks = array(graph.stateLinks, 'event graph.stateLinks', EVENT_GRAPH_MAX_STATE_LINKS);
  const stateLinkIds: string[] = [];
  for (const [index, candidate] of stateLinks.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const link = record(candidate, `event graph.stateLinks[${index}]`);
    const id = string(link.id, `event graph.stateLinks[${index}].id`, 32_768);
    enumeration(link.stateKind, `event graph.stateLinks[${index}].stateKind`, stateKinds);
    string(link.name, `event graph.stateLinks[${index}].name`, 32_768);
    const producerId = string(
      link.producerId,
      `event graph.stateLinks[${index}].producerId`,
      32_768,
    );
    const consumerId = string(
      link.consumerId,
      `event graph.stateLinks[${index}].consumerId`,
      32_768,
    );
    if (!knownStateAccessIds.has(producerId) || !knownStateAccessIds.has(consumerId)) {
      invalid('Event graph state link references an unknown access', {
        linkId: id,
        producerId,
        consumerId,
      });
    }
    enumeration(link.confidence, `event graph.stateLinks[${index}].confidence`, confidenceValues);
    boolean(link.pathConfirmed, `event graph.stateLinks[${index}].pathConfirmed`);
    stateLinkIds.push(id);
  }
  assertUnique(stateLinkIds, 'event graph.stateLinks');

  const issues = array(graph.issues, 'event graph.issues', EVENT_GRAPH_MAX_ISSUES);
  for (const [index, candidate] of issues.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const issue = record(candidate, `event graph.issues[${index}]`);
    string(issue.code, `event graph.issues[${index}].code`, 1_024);
    enumeration(issue.classification, `event graph.issues[${index}].classification`, defectClasses);
    enumeration(issue.severity, `event graph.issues[${index}].severity`, severities);
    string(issue.message, `event graph.issues[${index}].message`);
    enumeration(issue.confidence, `event graph.issues[${index}].confidence`, confidenceValues);
    optionalLocation(issue.location, `event graph.issues[${index}].location`);
    if (issue.related !== undefined) {
      for (const [relatedIndex, location] of array(
        issue.related,
        `event graph.issues[${index}].related`,
        MAX_RELATED_LOCATIONS,
      ).entries()) {
        validateLocation(location, `event graph.issues[${index}].related[${relatedIndex}]`);
      }
    }
    for (const [blockerIndex, blocker] of array(
      issue.blockers,
      `event graph.issues[${index}].blockers`,
      10_000,
    ).entries()) {
      validateBlocker(blocker, `event graph.issues[${index}].blockers[${blockerIndex}]`);
    }
    record(issue.details, `event graph.issues[${index}].details`);
  }

  const diagnostics = array(graph.diagnostics, 'event graph.diagnostics', MAX_DIAGNOSTICS);
  for (const [index, diagnostic] of diagnostics.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    validateDiagnostic(diagnostic, `event graph.diagnostics[${index}]`);
  }

  const unresolved = array(graph.unresolved, 'event graph.unresolved', EVENT_GRAPH_MAX_UNRESOLVED);
  const unresolvedIds: string[] = [];
  for (const [index, candidate] of unresolved.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const item = record(candidate, `event graph.unresolved[${index}]`);
    const id = string(item.id, `event graph.unresolved[${index}].id`, 32_768);
    enumeration(item.kind, `event graph.unresolved[${index}].kind`, unresolvedKinds);
    string(item.expression, `event graph.unresolved[${index}].expression`);
    if (item.ownerId !== undefined) {
      const ownerId = string(item.ownerId, `event graph.unresolved[${index}].ownerId`, 32_768);
      if (!knownNodeIds.has(ownerId)) {
        invalid('Event graph unresolved analysis references an unknown owner', { id, ownerId });
      }
    }
    optionalLocation(item.location, `event graph.unresolved[${index}].location`);
    enumeration(item.confidence, `event graph.unresolved[${index}].confidence`, confidenceValues);
    for (const [blockerIndex, blocker] of array(
      item.blockers,
      `event graph.unresolved[${index}].blockers`,
      10_000,
    ).entries()) {
      validateBlocker(blocker, `event graph.unresolved[${index}].blockers[${blockerIndex}]`);
    }
    unresolvedIds.push(id);
  }
  assertUnique(unresolvedIds, 'event graph.unresolved');

  const statistics = record(graph.statistics, 'event graph.statistics');
  const expectedStatistics: Record<string, number> = {
    eventCount: [...nodeKindById.values()].filter((kind) => kind === 'event').length,
    optionCount: [...nodeKindById.values()].filter((kind) => kind === 'option').length,
    entryCount: [...nodeKindById.values()].filter((kind) => kind === 'entry').length,
    helperCount: [...nodeKindById.values()].filter((kind) => kind === 'helper').length,
    unresolvedNodeCount: [...nodeKindById.values()].filter((kind) => kind === 'unresolved').length,
    terminalCount: [...nodeKindById.values()].filter((kind) => kind === 'terminal').length,
    edgeCount: edges.length,
    derivedEdgeCount,
    stateAccessCount: stateAccesses.length,
    issueCount: issues.length,
  };
  for (const [key, expected] of Object.entries(expectedStatistics)) {
    const actual = safeInteger(statistics[key], `event graph.statistics.${key}`);
    if (actual !== expected) {
      invalid('Event graph statistics do not match the graph structure', {
        field: key,
        expected,
        actual,
      });
    }
  }
  signal?.throwIfAborted();
  return graph as unknown as EventGraphSnapshot;
}

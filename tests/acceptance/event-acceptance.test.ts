import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import {
  assignments,
  firstScalar,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
} from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  EventChainViewer,
  type EventGraphEdge,
  type EventGraphNode,
  type EventGraphSnapshot,
  type EventPathExplanation,
  type EventRootDiscovery,
  type EventSelector,
  type EventStateAccess,
  type EventStateFlowResult,
  type EventTraceResult,
} from '../../src/hoi4_agent_tools/event/index.js';

interface FixtureManifest {
  schemaVersion: number;
  eventDefinitionCount: number;
  uniqueEventIdCount: number;
  eventFileCount: number;
  namespaceCount: number;
  externalEntryPointCount: number;
  automaticEventCount: number;
  callerlessTriggeredEventCount: number;
  expectedEdgeCount: number;
  sourceHashes: Record<string, string>;
}

interface ExpectedDefinition {
  id: string;
  logicalId: string;
  type: string;
  sourcePath: string;
  duplicateOrdinal: number;
}

interface ExpectedEdge {
  callerId: string;
  targetId: string;
  reason: EventGraphEdge['reason'];
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
  kind: string;
  targetId: string;
  reason: EventGraphEdge['reason'];
  sourcePath: string;
}

interface GraphManifest {
  schemaVersion: number;
  definitions: ExpectedDefinition[];
  uniqueEventIds: string[];
  expectedEdges: ExpectedEdge[];
  expectedExternalEntries: ExpectedEntry[];
  expectedCycles: string[][];
  expectedAutomaticRootEventIds: string[];
  expectedCallerlessTriggeredEventIds: string[];
  expectedDerivedHelperProjections: Array<{
    callerId: string;
    targetId: string;
    helperStack: string[];
  }>;
  expectedUnresolved: Array<{ ownerId: string; expression: string; kind: string }>;
  forbiddenInventedEdges: Array<{ callerId: string; targetId: string }>;
}

interface ExpectedStateFlow {
  kind: EventStateAccess['kind'];
  name: string;
  producers: string[];
  consumers: string[];
  clearers: string[];
  expectedAccessOrder?: string[];
}

interface AnalysisManifest {
  schemaVersion: number;
  expectedStateFlows: ExpectedStateFlow[];
  intentionalDiagnostics: Array<{
    code: string;
    classification: string;
    owners: string[];
  }>;
}

interface ProposedChanges {
  schemaVersion: number;
  mutations: Array<
    | { kind: 'replace_scalar'; sourcePath: string; from: string; to: string }
    | { kind: 'remove_event'; sourcePath: string; eventId: string }
    | { kind: 'remove_entry'; sourcePath: string; entryId: string }
  >;
}

interface ComparisonManifest {
  schemaVersion: number;
  expected: {
    repairedMissingTargets: string[];
    removedEventIds: string[];
    callersLeftDangling: string[];
    removedEntryIds: string[];
    eventsWithChangedOutgoingEdges: string[];
    newlyDisconnectedCandidates: string[];
  };
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'event');
const workspaceRoot = path.join(fixtureRoot, 'workspace');
const workspaceId = 'event_acceptance';

let temporaryRoot: string;
let engine: CoreEngine;
let viewer: EventChainViewer;
let graph: EventGraphSnapshot;
let fixtureManifest: FixtureManifest;
let graphManifest: GraphManifest;
let analysisManifest: AnalysisManifest;
let proposedChanges: ProposedChanges;
let comparisonManifest: ComparisonManifest;
let nodeById: Map<string, EventGraphNode>;
const sourceText = new Map<string, string>();

function withoutWorkspacePrefix(value: string): string {
  return value.replaceAll('\\', '/').replace(/^workspace\//u, '');
}

function pathMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const normalizedActual = actual.replaceAll('\\', '/').toLowerCase();
  const normalizedExpected = withoutWorkspacePrefix(expected).toLowerCase();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.endsWith(`:${normalizedExpected}`) ||
    normalizedActual.endsWith(`/${normalizedExpected}`)
  );
}

function eventIdForNode(nodeId: string): string | undefined {
  return nodeById.get(nodeId)?.eventId;
}

function metadataString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function ownerName(nodeId: string): string {
  const node = nodeById.get(nodeId);
  if (node?.eventId !== undefined) return node.eventId;
  if (node?.kind === 'helper') return `helper:${metadataString(node.metadata.name, node.label)}`;
  return nodeId;
}

function entryMatches(node: EventGraphNode | undefined, expected: ExpectedEntry): boolean {
  if (node?.kind !== 'entry' || node.metadata.entryKind !== expected.kind) return false;
  if (!pathMatches(node.sourcePath ?? node.location?.path, expected.sourcePath)) return false;
  if (expected.kind === 'country_setup' || expected.kind === 'state_setup') return true;
  return node.label === expected.id;
}

function expectedCallerMatches(edge: EventGraphEdge, expected: ExpectedEdge): boolean {
  if (expected.callerId.startsWith('helper:')) return edge.from === expected.callerId;
  if (expected.callerId.startsWith('entry:')) {
    const entry = graphManifest.expectedExternalEntries.find(
      ({ kind, id }) => expected.callerId === `entry:${kind}:${id}`,
    );
    return entry !== undefined && entryMatches(nodeById.get(edge.from), entry);
  }
  return eventIdForNode(edge.from) === expected.callerId;
}

function expectedTargetMatches(edge: EventGraphEdge, expected: ExpectedEdge): boolean {
  if (expected.targetId.startsWith('helper:')) return edge.to === expected.targetId;
  if (expected.targetId.startsWith('unresolved:')) {
    const expression = expected.targetId.slice('unresolved:'.length);
    const node = nodeById.get(edge.to);
    return (
      node?.kind === 'unresolved' &&
      metadataString(node.metadata.expression, node.label).includes(expression)
    );
  }
  const target = nodeById.get(edge.to);
  return (
    target?.eventId === expected.targetId ||
    (target?.kind === 'unresolved' &&
      metadataString(target.metadata.expression, target.label) === expected.targetId)
  );
}

async function sourceForExpectedPath(expectedPath: string): Promise<string> {
  const relativePath = withoutWorkspacePrefix(expectedPath);
  const cached = sourceText.get(relativePath);
  if (cached !== undefined) return cached;
  const source = await readFile(path.join(workspaceRoot, ...relativePath.split('/')), 'utf8');
  sourceText.set(relativePath, source);
  return source;
}

function sourceSlice(edge: EventGraphEdge, source: string): string {
  return source.slice(edge.location.start.offset, edge.location.end.offset);
}

function semanticIssueOwners(issue: EventGraphSnapshot['issues'][number]): string[] {
  const values = issue.details.subjectIds;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    return [ownerName(value)];
  });
}

function edgeSignature(edge: EventGraphEdge): string {
  const target = nodeById.get(edge.to);
  const targetName =
    target?.eventId ??
    (target?.kind === 'helper'
      ? `helper:${metadataString(target.metadata.name, target.label)}`
      : target?.kind === 'unresolved'
        ? `unresolved:${metadataString(target.metadata.expression, target.label)}`
        : edge.to);
  return [
    ownerName(edge.from),
    targetName,
    edge.reason,
    edge.derived ? 'derived' : 'source',
    edge.location.path,
    String(edge.location.start.line),
    edge.helperStack.join('>'),
  ].join('|');
}

function ownerSet(accesses: readonly EventStateAccess[]): string[] {
  return [...new Set(accesses.map(({ ownerId }) => ownerName(ownerId)))].sort();
}

function findEventAssignment(block: BlockNode, eventId: string): AssignmentNode | undefined {
  for (const assignment of assignments(block)) {
    if (
      assignment.value.type === 'block' &&
      firstScalar(assignment.value, 'id')?.value === eventId &&
      assignment.key.value.endsWith('_event')
    ) {
      return assignment;
    }
    if (assignment.value.type === 'block') {
      const nested = findEventAssignment(assignment.value, eventId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function removeEvent(source: string, relativePath: string, eventId: string): string {
  const document = parseClausewitz(Buffer.from(source), `mod:${relativePath}`);
  const assignment = findEventAssignment(document.root, eventId);
  if (assignment === undefined) throw new Error(`Comparison event ${eventId} is missing`);
  return `${source.slice(0, assignment.start)}${source.slice(assignment.end)}`;
}

async function comparisonSources(): Promise<Array<{ relativePath: string; source: string }>> {
  const changed = new Map<string, string>();
  for (const mutation of proposedChanges.mutations) {
    const relativePath = withoutWorkspacePrefix(mutation.sourcePath);
    let source =
      changed.get(relativePath) ??
      (await readFile(path.join(workspaceRoot, ...relativePath.split('/')), 'utf8'));
    if (mutation.kind === 'replace_scalar') {
      if (!source.includes(mutation.from))
        throw new Error(`Comparison scalar ${mutation.from} is missing`);
      source = source.replace(mutation.from, mutation.to);
    } else if (mutation.kind === 'remove_event') {
      source = removeEvent(source, relativePath, mutation.eventId);
    } else {
      const lines = source.split(/(?<=\n)/u);
      const retained = lines.filter((line) => !line.includes(`id = ${mutation.entryId}`));
      if (retained.length === lines.length)
        throw new Error(`Comparison entry ${mutation.entryId} is missing`);
      source = retained.join('');
    }
    changed.set(relativePath, source);
  }
  return [...changed].map(([relativePath, source]) => ({ relativePath, source }));
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-event-acceptance-'));
  [fixtureManifest, graphManifest, analysisManifest, proposedChanges, comparisonManifest] =
    await Promise.all([
      readFile(path.join(fixtureRoot, 'fixture-manifest.json'), 'utf8').then(
        (value) => JSON.parse(value) as FixtureManifest,
      ),
      readFile(path.join(fixtureRoot, 'expected', 'graph-manifest.json'), 'utf8').then(
        (value) => JSON.parse(value) as GraphManifest,
      ),
      readFile(path.join(fixtureRoot, 'expected', 'analysis-manifest.json'), 'utf8').then(
        (value) => JSON.parse(value) as AnalysisManifest,
      ),
      readFile(path.join(fixtureRoot, 'comparison', 'proposed-changes.json'), 'utf8').then(
        (value) => JSON.parse(value) as ProposedChanges,
      ),
      readFile(path.join(fixtureRoot, 'expected', 'comparison-manifest.json'), 'utf8').then(
        (value) => JSON.parse(value) as ComparisonManifest,
      ),
    ]);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(temporaryRoot, 'server-state'),
    storageRoots: [path.join(temporaryRoot, 'artifacts'), path.join(temporaryRoot, 'cache')],
    workspaces: [
      {
        id: workspaceId,
        name: 'Project-owned event acceptance fixture',
        root: workspaceRoot,
        kind: 'mod',
        artifactRoot: path.join(temporaryRoot, 'artifacts'),
        cacheRoot: path.join(temporaryRoot, 'cache'),
      },
    ],
  });
  engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  await engine.initialize();
  viewer = new EventChainViewer(engine);
  graph = await viewer.scan(workspaceId, { refresh: true });
  nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('Event Chain Viewer project-owned acceptance fixture', () => {
  it('indexes every expected event definition and all independent external entries', () => {
    expect(fixtureManifest.schemaVersion).toBe(1);
    expect(fixtureManifest.eventDefinitionCount).toBe(320);
    expect(fixtureManifest.uniqueEventIdCount).toBe(319);
    expect(fixtureManifest.eventFileCount).toBe(8);
    expect(fixtureManifest.namespaceCount).toBe(4);
    const eventNodes = graph.nodes.filter(({ kind }) => kind === 'event');
    expect(eventNodes).toHaveLength(fixtureManifest.eventDefinitionCount);
    expect(new Set(eventNodes.flatMap(({ eventId }) => eventId ?? []))).toEqual(
      new Set(graphManifest.uniqueEventIds),
    );
    for (const expected of graphManifest.definitions) {
      expect(
        eventNodes.some(
          (node) =>
            node.eventId === expected.id &&
            node.metadata.eventType === expected.type &&
            pathMatches(node.sourcePath, expected.sourcePath),
        ),
      ).toBe(true);
    }
    const externalEntries = graph.nodes.filter(
      (node) => node.kind === 'entry' && node.metadata.entryKind !== 'implicit_event_trigger',
    );
    expect(externalEntries).toHaveLength(fixtureManifest.externalEntryPointCount);
    for (const expected of graphManifest.expectedExternalEntries) {
      expect(externalEntries.some((node) => entryMatches(node, expected))).toBe(true);
    }
  });

  it('finds every oracle edge with exact source provenance and invents no forbidden edge', async () => {
    expect(graphManifest.expectedEdges).toHaveLength(fixtureManifest.expectedEdgeCount);
    for (const expected of graphManifest.expectedEdges) {
      const matches = graph.edges.filter(
        (edge) =>
          edge.reason === expected.reason &&
          expectedCallerMatches(edge, expected) &&
          expectedTargetMatches(edge, expected) &&
          pathMatches(edge.location.path, expected.sourcePath),
      );
      expect(matches.length, JSON.stringify(expected)).toBeGreaterThan(0);
      const source = await sourceForExpectedPath(expected.sourcePath);
      expect(
        matches.some((edge) => sourceSlice(edge, source).includes(expected.sourceNeedle)),
      ).toBe(true);
      for (const edge of matches) {
        expect(edge.location.start.line).toBeGreaterThan(0);
        expect(edge.location.start.column).toBeGreaterThan(0);
        expect(edge.provenance.length).toBeGreaterThan(0);
        expect(edge.provenance.every(({ location }) => location.path === edge.location.path)).toBe(
          true,
        );
      }
    }
    for (const forbidden of graphManifest.forbiddenInventedEdges) {
      expect(
        graph.edges.some(
          (edge) =>
            nodeById.get(edge.to)?.kind === 'event' &&
            edge.reason !== 'option_branch' &&
            eventIdForNode(edge.from) === forbidden.callerId &&
            eventIdForNode(edge.to) === forbidden.targetId,
        ),
      ).toBe(false);
    }
    for (const expected of graphManifest.expectedUnresolved) {
      expect(
        graph.unresolved.some(
          ({ ownerId, expression, kind }) =>
            ownerId !== undefined &&
            ownerName(ownerId) === expected.ownerId &&
            expression.includes(expected.expression) &&
            kind === expected.kind,
        ),
      ).toBe(true);
    }
    const unexpectedSourceEdges = graph.edges.filter((edge) => {
      if (edge.derived || edge.reason === 'option_branch' || edge.reason === 'terminal')
        return false;
      if (edge.reason === 'implicit_event_entry') {
        return !graphManifest.expectedAutomaticRootEventIds.includes(eventIdForNode(edge.to) ?? '');
      }
      return !graphManifest.expectedEdges.some(
        (expected) =>
          edge.reason === expected.reason &&
          expectedCallerMatches(edge, expected) &&
          expectedTargetMatches(edge, expected) &&
          pathMatches(edge.location.path, expected.sourcePath),
      );
    });
    expect(unexpectedSourceEdges.map(edgeSignature)).toEqual([]);

    const helperProjections = graph.edges.filter(({ derived }) => derived);
    const unexpectedProjections = helperProjections.filter(
      (edge) =>
        edge.reason !== 'scripted_effect_expansion' ||
        !graphManifest.expectedDerivedHelperProjections.some(
          (expected) =>
            eventIdForNode(edge.from) === expected.callerId &&
            eventIdForNode(edge.to) === expected.targetId &&
            JSON.stringify(edge.helperStack) === JSON.stringify(expected.helperStack),
        ),
    );
    expect(unexpectedProjections.map(edgeSignature)).toEqual([]);
    expect(helperProjections).toHaveLength(graphManifest.expectedDerivedHelperProjections.length);
  });

  it('discovers automatic and external roots, callerless events, SCCs, and helper projections', async () => {
    const inspected = await viewer.inspect({ workspaceId, mode: 'roots' });
    const roots = (inspected.report as { roots: EventRootDiscovery }).roots;
    expect(
      roots.entryPoints.filter(({ metadata }) => metadata.entryKind !== 'implicit_event_trigger'),
    ).toHaveLength(fixtureManifest.externalEntryPointCount);
    expect(roots.automaticEvents.flatMap(({ eventId }) => eventId ?? [])).toEqual(
      graphManifest.expectedAutomaticRootEventIds,
    );
    expect(roots.callerlessTriggeredEvents.flatMap(({ eventId }) => eventId ?? [])).toEqual(
      expect.arrayContaining(graphManifest.expectedCallerlessTriggeredEventIds),
    );
    for (const expectedCycle of graphManifest.expectedCycles) {
      expect(
        roots.stronglyConnectedComponents.some((component) => {
          const ids = new Set(component.nodeIds.flatMap((nodeId) => eventIdForNode(nodeId) ?? []));
          return expectedCycle.every((eventId) => ids.has(eventId));
        }),
      ).toBe(true);
    }

    const collapsed = await viewer.inspect({
      workspaceId,
      mode: 'trace',
      selector: { kind: 'event', eventId: 'synthetic_alpha.4' },
      direction: 'downstream',
      maxDepth: 10,
      maxNodes: 40,
      expandHelpers: false,
    });
    const collapsedTrace = (collapsed.report as { trace: EventTraceResult }).trace;
    expect(collapsedTrace.nodes.some(({ eventId }) => eventId === 'synthetic_alpha.6')).toBe(true);
    expect(collapsedTrace.nodes.some(({ kind }) => kind === 'helper')).toBe(false);
    expect(
      collapsedTrace.edges.some(
        ({ reason, helperStack }) =>
          reason === 'scripted_effect_expansion' && helperStack.length === 3,
      ),
    ).toBe(true);

    const expanded = await viewer.inspect({
      workspaceId,
      mode: 'trace',
      selector: { kind: 'event', eventId: 'synthetic_alpha.4' },
      direction: 'downstream',
      maxDepth: 10,
      maxNodes: 40,
      expandHelpers: true,
    });
    const expandedTrace = (expanded.report as { trace: EventTraceResult }).trace;
    expect(
      expandedTrace.nodes.filter(({ kind }) => kind === 'helper').map(({ label }) => label),
    ).toEqual(
      expect.arrayContaining([
        'synthetic_alpha_outer',
        'synthetic_alpha_middle',
        'synthetic_alpha_inner',
      ]),
    );
  });

  it('explains delayed, conditional, stateful, and helper-expanded paths with sources', async () => {
    const delayed = await viewer.inspect({
      workspaceId,
      mode: 'explain_path',
      from: { kind: 'event', eventId: 'synthetic_alpha.7' },
      to: { kind: 'event', eventId: 'synthetic_alpha.9' },
      maxDepth: 12,
      maxNodes: 60,
      expandHelpers: true,
    });
    const explanation = (delayed.report as { explanation: EventPathExplanation }).explanation;
    expect(explanation.found).toBe(true);
    expect(explanation.steps.flatMap(({ node }) => node.eventId ?? [])).toEqual(
      expect.arrayContaining(['synthetic_alpha.7', 'synthetic_alpha.8', 'synthetic_alpha.9']),
    );
    const delayedEdge = explanation.steps
      .flatMap(({ via }) => via ?? [])
      .find(({ reason }) => reason === 'delayed_event_call');
    expect(delayedEdge?.timing).toMatchObject({
      mode: 'fixed_and_random',
      days: '4',
      randomDays: '2',
    });
    expect(delayedEdge?.location.path).toContain('synthetic_alpha_01.txt');
    expect(
      explanation.steps
        .flatMap(({ producedState }) => producedState)
        .some(({ name }) => name === 'synthetic_transient_target'),
    ).toBe(true);
    expect(
      explanation.steps
        .flatMap(({ requiredState }) => requiredState)
        .some(({ name }) => name === 'synthetic_transient_target'),
    ).toBe(true);

    const helper = await viewer.inspect({
      workspaceId,
      mode: 'explain_path',
      from: { kind: 'event', eventId: 'synthetic_alpha.4' },
      to: { kind: 'event', eventId: 'synthetic_alpha.6' },
      maxDepth: 12,
      maxNodes: 60,
      expandHelpers: true,
    });
    const helperExplanation = (helper.report as { explanation: EventPathExplanation }).explanation;
    expect(helperExplanation.found).toBe(true);
    expect(helperExplanation.steps.filter(({ node }) => node.kind === 'helper')).toHaveLength(3);
    expect(
      helperExplanation.steps
        .flatMap(({ via }) => via ?? [])
        .every(({ location }) => location.start.line > 0),
    ).toBe(true);
  });

  it('connects state producers, consumers, replacement, cleanup, and intentional lifecycle defects', async () => {
    for (const expected of analysisManifest.expectedStateFlows) {
      const result = await viewer.inspect({
        workspaceId,
        mode: 'state_flow',
        stateSubject: { kind: expected.kind, name: expected.name },
      });
      const flow = (result.report as { flow: EventStateFlowResult }).flow;
      expect(ownerSet(flow.producers)).toEqual(expect.arrayContaining(expected.producers));
      expect(ownerSet(flow.consumers)).toEqual(expect.arrayContaining(expected.consumers));
      expect(ownerSet(flow.clears)).toEqual(expect.arrayContaining(expected.clearers));
      for (const producer of expected.producers) {
        for (const consumer of expected.consumers) {
          expect(
            flow.links.some(
              ({ producerOwnerId, consumerOwnerId }) =>
                ownerName(producerOwnerId) === producer && ownerName(consumerOwnerId) === consumer,
            ),
          ).toBe(true);
        }
      }
      if (expected.expectedAccessOrder !== undefined) {
        expect(
          flow.accesses
            .slice()
            .sort(
              (left, right) =>
                left.location.start.offset - right.location.start.offset ||
                left.location.path.localeCompare(right.location.path),
            )
            .map(({ access }) => (access === 'write' ? 'save' : access)),
        ).toEqual(expected.expectedAccessOrder);
      }
    }
    const leaked = await viewer.inspect({
      workspaceId,
      mode: 'state_flow',
      stateSubject: { kind: 'global_event_target', name: 'synthetic_leaked_global_target' },
    });
    expect((leaked.report as { flow: EventStateFlowResult }).flow.globalTargetLeaks.length).toBe(1);
    const managed = await viewer.inspect({
      workspaceId,
      mode: 'state_flow',
      stateSubject: { kind: 'global_event_target', name: 'synthetic_managed_global_target' },
    });
    expect((managed.report as { flow: EventStateFlowResult }).flow.globalTargetLeaks).toEqual([]);
  });

  it('classifies every intentional diagnostic with the exact code, class, and semantic owner', () => {
    for (const expected of analysisManifest.intentionalDiagnostics) {
      const matching = graph.issues.filter(
        ({ code, classification }) =>
          code === expected.code && classification === expected.classification,
      );
      expect(matching.length, `${expected.code}/${expected.classification}`).toBeGreaterThan(0);
      const owners = new Set(matching.flatMap(semanticIssueOwners));
      expect([...owners]).toEqual(expect.arrayContaining(expected.owners));
    }

    const scopeMismatch = graph.issues.find(
      (issue) =>
        issue.code === 'EVENT_SCOPE_MISMATCH' &&
        semanticIssueOwners(issue).includes('synthetic_alpha.60'),
    );
    expect(scopeMismatch?.details).toMatchObject({
      source: 'country',
      destination: 'unit_leader',
    });
  });

  it('resolves every selector kind and reports impact for events, helpers, and state subjects', async () => {
    const alphaOne = graph.nodes.find(
      ({ kind, eventId }) => kind === 'event' && eventId === 'synthetic_alpha.1',
    );
    if (alphaOne?.location === undefined) throw new Error('synthetic_alpha.1 location missing');
    const selectors: EventSelector[] = [
      { kind: 'event', eventId: 'synthetic_alpha.1' },
      { kind: 'namespace', namespace: 'synthetic_alpha' },
      { kind: 'file', sourcePath: 'events/synthetic_alpha_01.txt' },
      {
        kind: 'source',
        sourcePath: 'events/synthetic_alpha_01.txt',
        line: alphaOne.location.start.line,
        column: alphaOne.location.start.column,
      },
      { kind: 'node', nodeId: alphaOne.id },
      {
        kind: 'manifest',
        manifest: {
          id: 'alpha-manifest',
          eventIds: ['synthetic_alpha.1'],
          namespaces: ['synthetic_beta'],
          sourcePaths: ['events/synthetic_gamma_01.txt'],
          nodeIds: ['helper:synthetic_alpha_outer'],
        },
      },
    ];
    for (const selector of selectors) {
      const inspected = await viewer.inspect({
        workspaceId,
        mode: 'trace',
        selector,
        direction: 'both',
        maxDepth: 0,
        maxNodes: 500,
        maxEdges: 1,
      });
      expect(
        (inspected.report as { trace: EventTraceResult }).trace.startNodeIds.length,
      ).toBeGreaterThan(0);
    }

    for (const impactSubject of [
      { kind: 'event' as const, name: 'synthetic_alpha.7' },
      { kind: 'helper' as const, name: 'synthetic_alpha_outer' },
      { kind: 'flag' as const, name: 'synthetic_chain_started' },
      { kind: 'variable' as const, name: 'synthetic_counter' },
      { kind: 'array' as const, name: 'synthetic_participants' },
      { kind: 'event_target' as const, name: 'synthetic_transient_target' },
      { kind: 'saved_scope' as const, name: 'synthetic_saved_country' },
    ]) {
      const inspected = await viewer.inspect({ workspaceId, mode: 'impact', impactSubject });
      const impact = inspected.report as { impact: { directNodeIds: string[] } };
      expect(impact.impact.directNodeIds.length, JSON.stringify(impactSubject)).toBeGreaterThan(0);
    }
  });

  it('compares independent source mutations without writing the fixture', async () => {
    const before = graph;
    const sources = await comparisonSources();
    const compared = await viewer.compareAndStore({
      workspaceId,
      before: { revision: before.revision },
      proposedSources: sources,
      render: false,
    });
    for (const eventId of comparisonManifest.expected.removedEventIds) {
      expect(compared.comparison.removedNodeIds).toContain(`event:${eventId}`);
    }
    for (const targetId of comparisonManifest.expected.repairedMissingTargets) {
      expect(
        compared.before.issues.some(
          ({ code, details }) =>
            code === 'EVENT_REFERENCE_MISSING' && JSON.stringify(details).includes(targetId),
        ),
      ).toBe(true);
      expect(
        compared.after.issues.some(
          ({ code, details }) =>
            code === 'EVENT_REFERENCE_MISSING' && JSON.stringify(details).includes(targetId),
        ),
      ).toBe(false);
    }
    for (const entryId of comparisonManifest.expected.removedEntryIds) {
      const beforeEntry = compared.before.nodes.find(
        ({ kind, label }) => kind === 'entry' && label === entryId,
      );
      expect(beforeEntry).toBeDefined();
      expect(compared.comparison.removedNodeIds).toContain(beforeEntry!.id);
      expect(compared.after.nodes.some(({ id }) => id === beforeEntry!.id)).toBe(false);
    }
    const beforeNodes = new Map(compared.before.nodes.map((node) => [node.id, node]));
    const afterNodes = new Map(compared.after.nodes.map((node) => [node.id, node]));
    for (const eventId of comparisonManifest.expected.eventsWithChangedOutgoingEdges) {
      const removed = compared.before.edges.filter(
        ({ id, from, reason }) =>
          reason !== 'option_branch' &&
          compared.comparison.removedEdgeIds.includes(id) &&
          beforeNodes.get(from)?.eventId === eventId,
      );
      const added = compared.after.edges.filter(
        ({ id, from, reason }) =>
          reason !== 'option_branch' &&
          compared.comparison.addedEdgeIds.includes(id) &&
          afterNodes.get(from)?.eventId === eventId,
      );
      expect(removed.length, `${eventId} removed outgoing edge`).toBeGreaterThan(0);
      expect(added.length, `${eventId} added outgoing edge`).toBeGreaterThan(0);
    }
    for (const eventId of comparisonManifest.expected.newlyDisconnectedCandidates) {
      expect(compared.comparison.newlyDisconnectedRootIds).toContain(`event:${eventId}`);
    }
    expect(
      compared.after.issues.some(
        ({ code, details }) =>
          code === 'EVENT_REFERENCE_MISSING' &&
          JSON.stringify(details).includes('synthetic_beta.31'),
      ),
    ).toBe(true);
    for (const callerId of comparisonManifest.expected.callersLeftDangling) {
      expect(
        compared.after.issues.some(
          (issue) =>
            issue.code === 'EVENT_REFERENCE_MISSING' &&
            semanticIssueOwners(issue).includes(callerId),
        ),
      ).toBe(true);
    }
    expect(compared.render).toBeUndefined();
    expect(compared.artifacts.some(({ mimeType }) => mimeType === 'application/json')).toBe(true);
  });

  it('renders deterministic bounded overview and branch JSON, SVG, PNG, and coverage manifests', async () => {
    const first = await viewer.renderAndStore({
      workspaceId,
      view: 'overview',
      maxNodes: 120,
      includeHtml: true,
      expandHelpers: false,
    });
    const second = await viewer.renderAndStore({
      workspaceId,
      view: 'overview',
      maxNodes: 120,
      includeHtml: true,
      expandHelpers: false,
    });
    expect(second.render.hashes).toEqual(first.render.hashes);
    expect(second.branches.map(({ hashes }) => hashes)).toEqual(
      first.branches.map(({ hashes }) => hashes),
    );
    expect(first.render.json).toBe(second.render.json);
    expect(first.render.svg).toBe(second.render.svg);
    expect(first.render.png.equals(second.render.png)).toBe(true);
    expect(first.render.svg).toContain('data-source-path=');
    expect(first.render.svg).toContain('data-event-edge-reason=');
    expect(JSON.parse(first.render.json)).toMatchObject({ schemaVersion: 'event-render.v1' });
    const primary = await sharp(first.render.png).metadata();
    expect(primary.format).toBe('png');
    expect(primary.width).toBeGreaterThan(0);
    expect(first.branches.length).toBeGreaterThan(0);
    for (const branch of first.branches) {
      expect(JSON.parse(branch.json)).toMatchObject({ schemaVersion: 'event-render.v1' });
      expect(branch.svg).toContain('data-event-node-id=');
      const metadata = await sharp(branch.png).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.width).toBeGreaterThan(0);
    }
    const manifest = JSON.parse(first.manifestJson) as {
      overview: { selectedNodeIds: string[]; hashes: unknown };
      branches: Array<{ selectedNodeIds: string[]; hashes: unknown }>;
      coverage: { totalNodes: number; retainedBranchSourceNodes: number; truncated: boolean };
    };
    expect(manifest.overview.selectedNodeIds).toEqual(first.render.selectedNodeIds);
    expect(manifest.branches).toHaveLength(first.branches.length);
    manifest.branches.forEach((branch, index) => {
      expect(branch.selectedNodeIds).toEqual(first.branches[index]?.selectedNodeIds);
      expect(branch.hashes).toEqual(first.branches[index]?.hashes);
    });
    expect(manifest.coverage.totalNodes).toBe(graph.nodes.length);
    expect(manifest.coverage.retainedBranchSourceNodes).toBe(graph.nodes.length);
    expect(manifest.coverage.truncated).toBe(false);
    const coveredNodeIds = new Set([
      ...first.render.selectedNodeIds,
      ...first.branches.flatMap(({ selectedNodeIds }) => selectedNodeIds),
    ]);
    expect(graph.nodes.every(({ id }) => coveredNodeIds.has(id))).toBe(true);
    expect(first.artifacts.filter(({ mimeType }) => mimeType === 'application/json').length).toBe(
      2 + first.branches.length,
    );
    expect(first.artifacts.filter(({ mimeType }) => mimeType === 'image/svg+xml')).toHaveLength(
      1 + first.branches.length,
    );
    expect(first.artifacts.filter(({ mimeType }) => mimeType === 'image/png')).toHaveLength(
      1 + first.branches.length,
    );
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  analyzeEventImpact,
  compareEventGraphs,
  discoverEventRoots,
  eventStronglyConnectedComponents,
  explainEventPath,
  inspectEventStateFlow,
  layoutEventGraph,
  lintEventGraph,
  renderEventGraph,
  traceSelectedEvents,
  type EventGraphEdge,
  type EventGraphNode,
  type EventGraphSnapshot,
  type EventStateAccess,
} from '../../src/hoi4_agent_tools/event/index.js';

function location(symbol: string, offset: number) {
  return {
    path: 'mod:events/unit.txt',
    start: { line: offset + 1, column: 1, offset },
    end: { line: offset + 1, column: 8, offset: offset + 7 },
    symbol,
  };
}

function node(
  id: string,
  kind: EventGraphNode['kind'],
  metadata: EventGraphNode['metadata'] = {},
): EventGraphNode {
  const eventId = kind === 'event' ? id.replace('event:', '') : undefined;
  return {
    id,
    kind,
    label: id,
    ...(eventId === undefined ? {} : { eventId, namespace: eventId.split('.')[0] }),
    sourcePath: 'mod:events/unit.txt',
    location: location(id, id.length),
    metadata,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  reason: EventGraphEdge['reason'],
  overrides: Partial<EventGraphEdge> = {},
): EventGraphEdge {
  return {
    id,
    from,
    to,
    reason,
    conditions: [],
    helperStack: [],
    location: location(id, id.length + 20),
    provenance: [{ role: 'invocation', location: location(id, id.length + 20) }],
    confidence: 'confirmed',
    derived: false,
    metadata: {},
    ...overrides,
  };
}

function state(
  id: string,
  ownerId: string,
  access: EventStateAccess['access'],
  kind: EventStateAccess['kind'],
  name: string,
): EventStateAccess {
  return {
    id,
    ownerId,
    kind,
    name,
    access,
    location: location(id, id.length + 40),
    confidence: 'confirmed',
    scope: 'country',
    helperStack: [],
    conditions: [],
    dynamic: false,
    metadata: {},
  };
}

function graph(): EventGraphSnapshot {
  const nodes = [
    node('entry:on_startup', 'entry', { entryKind: 'on_action' }),
    node('event:unit.1', 'event', { isTriggeredOnly: true }),
    node('option:unit.1:a', 'option'),
    node('helper:unit_followup', 'helper', { name: 'unit_followup' }),
    node('event:unit.2', 'event', { isTriggeredOnly: true }),
    node('event:unit.3', 'event', { isTriggeredOnly: false }),
    node('unresolved:unit.1', 'unresolved'),
    node('terminal:unit.2', 'terminal'),
  ];
  const edges = [
    edge('edge:entry', 'entry:on_startup', 'event:unit.1', 'on_action_entry'),
    edge('edge:option', 'event:unit.1', 'option:unit.1:a', 'option_branch'),
    edge('edge:helper', 'option:unit.1:a', 'helper:unit_followup', 'scripted_effect_call'),
    edge('edge:helper-event', 'helper:unit_followup', 'event:unit.2', 'scripted_effect_expansion'),
    edge('edge:collapsed', 'option:unit.1:a', 'event:unit.2', 'scripted_effect_expansion', {
      derived: true,
      helperStack: ['unit_followup'],
    }),
    edge('edge:cycle', 'event:unit.2', 'event:unit.1', 'delayed_event_call', {
      timing: { mode: 'fixed', days: '2' },
    }),
    edge('edge:terminal', 'event:unit.2', 'terminal:unit.2', 'terminal'),
    edge('edge:unresolved', 'event:unit.1', 'unresolved:unit.1', 'unresolved_dynamic_reference', {
      confidence: 'unresolved',
    }),
  ];
  const stateAccesses = [
    state('state:write', 'event:unit.1', 'write', 'country_flag', 'unit_ready'),
    state('state:read', 'event:unit.2', 'read', 'country_flag', 'unit_ready'),
    state('state:target', 'event:unit.1', 'write', 'global_event_target', 'unit_target'),
  ];
  return {
    schemaVersion: 1,
    parserVersion: 'clausewitz-cst.v1',
    workspaceId: 'unit',
    workspaceIdentity: sha256Bytes('unit-workspace'),
    revision: sha256Bytes('unit-revision'),
    complete: true,
    sourceHashes: { 'mod:events/unit.txt': sha256Bytes('source') },
    filesScanned: ['mod:events/unit.txt'],
    skippedSourceCount: 0,
    skippedSources: [],
    nodes,
    edges,
    stateAccesses,
    stateLinks: [],
    issues: [],
    diagnostics: [],
    unresolved: [
      {
        id: 'unresolved:unit.1',
        kind: 'dynamic_event',
        expression: '[dynamic_event_id]',
        ownerId: 'event:unit.1',
        location: location('unresolved:unit.1', 80),
        confidence: 'unresolved',
        blockers: [{ code: 'DYNAMIC', message: 'Runtime event ID' }],
      },
    ],
    statistics: {
      eventCount: 3,
      optionCount: 1,
      entryCount: 1,
      helperCount: 1,
      unresolvedNodeCount: 1,
      terminalCount: 1,
      edgeCount: edges.length,
      derivedEdgeCount: 1,
      stateAccessCount: stateAccesses.length,
      issueCount: 0,
    },
  };
}

describe('Event Chain Viewer graph algorithms', () => {
  it('finds roots, cycles, bounded traces, and collapsed or expanded helper paths', () => {
    const source = graph();
    source.nodes.push(node('entry:state-only', 'entry', { entryKind: 'focus' }));
    source.stateAccesses.push(
      state('state:entry-only', 'entry:state-only', 'write', 'country_flag', 'not_an_event_root'),
    );
    const roots = discoverEventRoots(source);
    expect(roots.entryPoints.map(({ id }) => id)).toEqual(['entry:on_startup']);
    expect(roots.automaticEvents.map(({ eventId }) => eventId)).toEqual(['unit.3']);
    expect(roots.knownRootEventIds).toEqual(['unit.1', 'unit.3']);

    const components = eventStronglyConnectedComponents(source).filter(({ cyclic }) => cyclic);
    expect(components).toHaveLength(1);
    expect(components[0]?.nodeIds).toEqual(['event:unit.1', 'event:unit.2', 'option:unit.1:a']);

    const trace = traceSelectedEvents(
      source,
      { kind: 'event', eventId: 'unit.1' },
      {
        maxDepth: 2,
        maxNodes: 20,
        maxEdges: 20,
        direction: 'downstream',
        expandHelpers: false,
      },
    );
    expect(trace.nodes.map(({ id }) => id)).toContain('event:unit.2');
    expect(trace.edges.map(({ id }) => id)).toContain('edge:collapsed');
    expect(trace.edges.map(({ id }) => id)).not.toContain('edge:helper');

    const collapsed = explainEventPath(
      source,
      { kind: 'event', eventId: 'unit.1' },
      { kind: 'event', eventId: 'unit.2' },
      { maxDepth: 5, maxNodes: 20, expandHelpers: false },
    );
    expect(collapsed.found).toBe(true);
    expect(collapsed.steps.map(({ node }) => node.id)).toEqual([
      'event:unit.1',
      'option:unit.1:a',
      'event:unit.2',
    ]);
    expect(collapsed.steps[2]?.via?.helperStack).toEqual(['unit_followup']);

    const expanded = explainEventPath(
      source,
      { kind: 'event', eventId: 'unit.1' },
      { kind: 'event', eventId: 'unit.2' },
      { maxDepth: 6, maxNodes: 20, expandHelpers: true },
    );
    expect(expanded.steps.map(({ node }) => node.id)).toEqual([
      'event:unit.1',
      'option:unit.1:a',
      'helper:unit_followup',
      'event:unit.2',
    ]);
  });

  it('applies the node ceiling to broad selector start sets', () => {
    const source = graph();
    const trace = traceSelectedEvents(
      source,
      { kind: 'file', sourcePath: 'events/unit.txt' },
      {
        maxDepth: 1,
        maxNodes: 3,
        maxEdges: 20,
        direction: 'both',
        expandHelpers: false,
      },
    );

    expect(trace.startNodeIds).toHaveLength(3);
    expect(trace.nodes.length).toBeLessThanOrEqual(3);
    expect(trace.truncated).toBe(true);
  });

  it('connects state producers and consumers and reports lifecycle impact', () => {
    const source = graph();
    const flow = inspectEventStateFlow(source);
    expect(flow.links).toEqual([
      expect.objectContaining({
        producerId: 'state:write',
        consumerId: 'state:read',
        name: 'unit_ready',
      }),
    ]);
    expect(flow.globalTargetLeaks.map(({ name }) => name)).toEqual(['unit_target']);
    const impact = analyzeEventImpact(source, { kind: 'flag', name: 'unit_ready' });
    expect(impact.directNodeIds).toEqual(['event:unit.1', 'event:unit.2']);
    expect(impact.upstreamNodeIds).toContain('entry:on_startup');
    expect(impact.downstreamNodeIds).toContain('terminal:unit.2');

    const helperImpact = analyzeEventImpact(source, {
      kind: 'helper',
      name: 'unit_followup',
    });
    expect(helperImpact.upstreamNodeIds).toContain('option:unit.1:a');
    expect(helperImpact.downstreamNodeIds).toContain('event:unit.2');
    expect(helperImpact.affectedRootIds).toContain('entry:on_startup');

    const automaticImpact = analyzeEventImpact(source, { kind: 'event', name: 'unit.3' });
    expect(automaticImpact.affectedRootIds).toEqual(['event:unit.3']);
    expect(automaticImpact.removedRootIds).toEqual(['event:unit.3']);
  });

  it('recomputes removal impact without disconnecting nodes that retain an alternate path', () => {
    const source = graph();
    source.nodes.push(
      node('event:unit.4', 'event', { isTriggeredOnly: true }),
      node('event:unit.5', 'event', { isTriggeredOnly: true }),
      node('event:unit.6', 'event', { isTriggeredOnly: true }),
      node('terminal:unit.6', 'terminal'),
    );
    source.edges.push(
      edge('edge:diamond-left', 'event:unit.1', 'event:unit.4', 'immediate_event_call'),
      edge('edge:diamond-right', 'event:unit.1', 'event:unit.5', 'immediate_event_call'),
      edge('edge:left-join', 'event:unit.4', 'event:unit.6', 'immediate_event_call'),
      edge('edge:right-join', 'event:unit.5', 'event:unit.6', 'immediate_event_call'),
      edge('edge:joined-terminal', 'event:unit.6', 'terminal:unit.6', 'terminal'),
    );

    const alternate = analyzeEventImpact(source, { kind: 'event', name: 'unit.4' });
    expect(alternate.downstreamNodeIds).toEqual(
      expect.arrayContaining(['event:unit.6', 'terminal:unit.6']),
    );
    expect(alternate.wouldDisconnectNodeIds).not.toContain('event:unit.6');
    expect(alternate.wouldDisconnectTerminalIds).not.toContain('terminal:unit.6');

    const bridge = analyzeEventImpact(source, { kind: 'event', name: 'unit.6' });
    expect(bridge.wouldDisconnectNodeIds).toContain('terminal:unit.6');
    expect(bridge.wouldDisconnectTerminalIds).toEqual(['terminal:unit.6']);
  });

  it('treats a wildcard global-target clear as cleanup in subject-specific state flow', () => {
    const source = graph();
    source.stateAccesses.push(
      state('state:clear-all-targets', 'event:unit.2', 'clear', 'global_event_target', '*'),
    );

    const flow = inspectEventStateFlow(source, undefined, {
      kind: 'global_event_target',
      name: 'unit_target',
    });
    expect(flow.clears.map(({ id }) => id)).toEqual(['state:clear-all-targets']);
    expect(flow.globalTargetLeaks).toEqual([]);
  });

  it('includes linked producer evidence outside a selected consumer and marks scope ambiguity', () => {
    const linked = graph();
    linked.stateLinks = [
      {
        id: 'state-link:unit-ready',
        stateKind: 'country_flag',
        name: 'unit_ready',
        producerId: 'state:write',
        consumerId: 'state:read',
        confidence: 'confirmed',
        pathConfirmed: true,
      },
    ];
    const selected = inspectEventStateFlow(
      linked,
      { kind: 'event', eventId: 'unit.2' },
      { kind: 'country_flag', name: 'unit_ready' },
    );
    expect(selected.accesses.map(({ id }) => id)).toEqual(['state:read', 'state:write']);
    expect(selected.producers.map(({ id }) => id)).toEqual(['state:write']);

    const scoped = graph();
    const writer = state('state:scoped-write', 'event:unit.1', 'write', 'variable', 'shared_name');
    writer.scope = 'state';
    const reader = state('state:scoped-read', 'event:unit.2', 'read', 'variable', 'shared_name');
    reader.scope = 'country';
    scoped.stateAccesses = [writer, reader];
    scoped.stateLinks = [];
    const ambiguous = inspectEventStateFlow(scoped, undefined, {
      kind: 'variable',
      name: 'shared_name',
    });
    expect(ambiguous.links).toContainEqual(
      expect.objectContaining({
        producerId: writer.id,
        consumerId: reader.id,
        confidence: 'unresolved',
        pathConfirmed: false,
      }),
    );
    expect(ambiguous.unproducedReads.map(({ id }) => id)).toEqual([reader.id]);
  });

  it('treats unqualified saved-scope reads as unresolved local or global storage', () => {
    const source = graph();
    const localWriter = state(
      'state:saved-local',
      'event:unit.1',
      'write',
      'saved_scope',
      'shared_scope',
    );
    localWriter.metadata = { storage: 'local' };
    const globalWriter = state(
      'state:saved-global',
      'event:unit.1',
      'write',
      'saved_scope',
      'shared_scope',
    );
    globalWriter.metadata = { storage: 'global' };
    const unknownReader = state(
      'state:saved-read',
      'event:unit.2',
      'read',
      'saved_scope',
      'shared_scope',
    );
    source.stateAccesses = [localWriter, globalWriter, unknownReader];
    source.stateLinks = [];

    const ambiguous = inspectEventStateFlow(source, undefined, {
      kind: 'saved_scope',
      name: 'shared_scope',
    });
    expect(ambiguous.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producerId: globalWriter.id,
          consumerId: unknownReader.id,
          confidence: 'unresolved',
          pathConfirmed: false,
        }),
        expect.objectContaining({
          producerId: localWriter.id,
          consumerId: unknownReader.id,
          confidence: 'unresolved',
          pathConfirmed: false,
        }),
      ]),
    );
    expect(ambiguous.unproducedReads).toEqual([]);

    const exactLocalReader = { ...unknownReader, metadata: { storage: 'local' } };
    source.stateAccesses = [localWriter, globalWriter, exactLocalReader];
    const exact = inspectEventStateFlow(source, undefined, {
      kind: 'saved_scope',
      name: 'shared_scope',
    });
    expect(exact.links).toEqual([
      expect.objectContaining({
        producerId: localWriter.id,
        consumerId: exactLocalReader.id,
        confidence: 'confirmed',
      }),
    ]);
  });

  it('selects option-owned state and diagnostics without leaking same-file issues', () => {
    const source = graph();
    source.stateAccesses.push(
      state('state:option-write', 'option:unit.1:a', 'write', 'country_flag', 'unit_option_flag'),
    );
    source.issues.push(
      {
        code: 'EVENT_OPTION_TEST',
        classification: 'design_warning',
        severity: 'warning',
        message: 'Option-owned issue',
        confidence: 'confirmed',
        location: location('option issue', 70),
        blockers: [],
        details: { subjectIds: ['option:unit.1:a'] },
      },
      {
        code: 'EVENT_UNRELATED_TEST',
        classification: 'design_warning',
        severity: 'warning',
        message: 'Unrelated issue in the same file',
        confidence: 'confirmed',
        location: location('unrelated issue', 200),
        blockers: [],
        details: { subjectIds: ['event:unit.3'] },
      },
    );

    const selector = { kind: 'event', eventId: 'unit.1' } as const;
    expect(inspectEventStateFlow(source, selector).accesses.map(({ id }) => id)).toContain(
      'state:option-write',
    );
    expect(lintEventGraph(source, selector).map(({ code }) => code)).toContain('EVENT_OPTION_TEST');
    expect(lintEventGraph(source, selector).map(({ code }) => code)).not.toContain(
      'EVENT_UNRELATED_TEST',
    );
  });

  it('classifies only reachable unresolved constructs in failed path explanations', () => {
    const dynamic = explainEventPath(
      graph(),
      { kind: 'event', eventId: 'unit.1' },
      { kind: 'event', eventId: 'unit.3' },
      { maxDepth: 20, maxNodes: 100, expandHelpers: false },
    );
    expect(dynamic.failureReason).toBe('dynamic_dispatch');

    const missingGraph = graph();
    missingGraph.unresolved = missingGraph.unresolved.map((item) => ({
      ...item,
      kind: 'missing_event',
    }));
    const missing = explainEventPath(
      missingGraph,
      { kind: 'event', eventId: 'unit.1' },
      { kind: 'event', eventId: 'unit.3' },
      { maxDepth: 20, maxNodes: 100, expandHelpers: false },
    );
    expect(missing.failureReason).toBe('unsupported_analysis');

    const unrelatedGraph = { ...graph(), complete: false };
    const unrelated = explainEventPath(
      unrelatedGraph,
      { kind: 'event', eventId: 'unit.3' },
      { kind: 'event', eventId: 'unit.1' },
      { maxDepth: 20, maxNodes: 100, expandHelpers: false },
    );
    expect(unrelated.failureReason).toBe('unreachable');
    expect(unrelated.unresolvedAssumptions).toEqual([]);
  });

  it('reports uncertain scope, timing, conditions, and dynamic state on a proven path', () => {
    const source = graph();
    source.edges = source.edges.map((value) =>
      value.id === 'edge:collapsed'
        ? {
            ...value,
            timing: { mode: 'unknown' as const, expression: '[runtime_delay]' },
            scope: {
              source: 'unknown' as const,
              destination: 'country' as const,
              confidence: 'low' as const,
            },
            conditions: [
              {
                id: 'condition:uncertain',
                kind: 'branch_guard' as const,
                expression: '[runtime_guard]',
                location: location('condition:uncertain', 260),
                confidence: 'unresolved' as const,
              },
            ],
          }
        : value,
    );
    const dynamic = state(
      'state:dynamic-path',
      'event:unit.2',
      'read',
      'variable',
      '[runtime_name]',
    );
    dynamic.dynamic = true;
    dynamic.confidence = 'unresolved';
    source.stateAccesses.push(dynamic);

    const explanation = explainEventPath(
      source,
      { kind: 'event', eventId: 'unit.1' },
      { kind: 'event', eventId: 'unit.2' },
      { maxDepth: 5, maxNodes: 20, expandHelpers: false },
    );
    expect(explanation.found).toBe(true);
    expect(explanation.unresolvedAssumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeId: 'edge:collapsed',
          blocker: expect.stringMatching(/Scope/),
        }),
        expect.objectContaining({ edgeId: 'edge:collapsed', expression: '[runtime_delay]' }),
        expect.objectContaining({ edgeId: 'edge:collapsed', expression: '[runtime_guard]' }),
        expect.objectContaining({ nodeId: 'event:unit.2', expression: 'variable:[runtime_name]' }),
      ]),
    );
  });

  it('compares directional structural changes and marks disconnected terminals', () => {
    const before = graph();
    const after: EventGraphSnapshot = {
      ...before,
      revision: sha256Bytes('after'),
      edges: before.edges.filter(({ id }) => id !== 'edge:terminal'),
    };
    const comparison = compareEventGraphs(before, after);
    expect(comparison.removedEdgeIds).toEqual(['edge:terminal']);
    expect(comparison.newlyDisconnectedTerminalIds).toEqual(['terminal:unit.2']);
    expect(comparison.changes.map(({ kind }) => kind)).toContain('terminal_disconnected');
  });

  it('cooperatively cancels comparison work after it has started', () => {
    let checks = 0;
    const signal = {
      throwIfAborted: () => {
        checks += 1;
        if (checks > 4) throw new DOMException('Comparison cancelled', 'AbortError');
      },
    } as unknown as AbortSignal;

    expect(() => compareEventGraphs(graph(), graph(), signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(checks).toBeGreaterThan(4);
  });

  it('compares state, diagnostics, and unresolved analysis as first-class changes', () => {
    const before = graph();
    const after: EventGraphSnapshot = {
      ...before,
      revision: sha256Bytes('state-and-diagnostics-after'),
      stateAccesses: before.stateAccesses.map((access) =>
        access.id === 'state:write' ? { ...access, name: 'unit_ready_renamed' } : access,
      ),
      issues: [
        {
          code: 'EVENT_REFERENCE_MISSING',
          classification: 'confirmed_error',
          severity: 'error',
          message: 'A referenced event is missing.',
          confidence: 'confirmed',
          location: location('missing', 120),
          blockers: [],
          details: { subjectIds: ['event:unit.1'] },
        },
      ],
      unresolved: [],
    };
    const comparison = compareEventGraphs(before, after);
    expect(comparison.changedStateAccessIds).toEqual(['state:write']);
    expect(comparison.addedIssueIds).toHaveLength(1);
    expect(comparison.resolvedUnresolvedIds).toEqual(['unresolved:unit.1']);
    expect(comparison.changes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['state_access_changed', 'diagnostic_added', 'unresolved_resolved']),
    );
  });

  it('does not report structural changes for source-line movement alone', () => {
    const before = graph();
    const shifted: EventGraphSnapshot = {
      ...before,
      revision: sha256Bytes('line-shifted'),
      nodes: before.nodes.map((value) => ({ ...value, location: location(value.id, 400) })),
      edges: before.edges.map((value) => ({
        ...value,
        location: location(value.id, 420),
        provenance: value.provenance.map(({ role }) => ({
          role,
          location: location(value.id, 420),
        })),
      })),
      stateAccesses: before.stateAccesses.map((value) => ({
        ...value,
        location: location(value.id, 440),
      })),
      unresolved: before.unresolved.map((value) => ({
        ...value,
        location: location(value.id, 460),
      })),
    };
    const comparison = compareEventGraphs(before, shifted);
    expect(comparison.changes).toEqual([]);
    expect(comparison.beforeGraphHash).toBe(comparison.afterGraphHash);
  });

  it('lays out and renders the same graph to identical source-linked artifacts', async () => {
    const source = graph();
    const firstLayout = layoutEventGraph(source);
    const secondLayout = layoutEventGraph(source);
    expect(firstLayout).toEqual(secondLayout);
    const first = await renderEventGraph(source, { view: 'overview', maxNodes: 20 });
    const second = await renderEventGraph(source, { view: 'overview', maxNodes: 20 });
    expect(first.hashes).toEqual(second.hashes);
    expect(first.svg).toContain('data-source-path="mod:events/unit.txt"');
    expect(first.png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(JSON.parse(first.json)).toMatchObject({
      schemaVersion: 'event-render.v1',
      graphRevision: source.revision,
    });
  });

  it('keeps specialized renders focused while retaining explicit entry context', async () => {
    const source = graph();
    const timing = await renderEventGraph(source, {
      view: 'timing',
      maxNodes: 20,
      includeHtml: false,
    });
    expect(timing.selectedNodeIds).toEqual(['event:unit.1', 'event:unit.2']);
    expect(timing.selectedNodeIds).not.toContain('event:unit.3');

    const stateView = await renderEventGraph(source, {
      view: 'state',
      maxNodes: 20,
      includeHtml: false,
    });
    expect(stateView.selectedNodeIds).toEqual(['event:unit.1', 'event:unit.2']);
    expect(stateView.selectedNodeIds).not.toContain('entry:on_startup');

    const entries = await renderEventGraph(source, {
      view: 'entries',
      maxNodes: 20,
      includeHtml: false,
    });
    expect(entries.selectedNodeIds).toEqual(['entry:on_startup', 'event:unit.1', 'event:unit.3']);
  });

  it('bounds large layouts, routes self loops externally, and preserves anchored coordinates', async () => {
    const linear = graph();
    linear.nodes = Array.from({ length: 65 }, (_, index) =>
      node(`event:linear.${String(index).padStart(3, '0')}`, 'event', {
        isTriggeredOnly: true,
      }),
    );
    linear.edges = linear.nodes
      .slice(1)
      .map((current, index) =>
        edge(`edge:linear:${index}`, linear.nodes[index]!.id, current.id, 'immediate_event_call'),
      );
    linear.stateAccesses = [];
    linear.stateLinks = [];
    linear.unresolved = [];
    const rendered = await renderEventGraph(linear, {
      view: 'overview',
      maxNodes: 100,
      includeHtml: false,
    });
    expect(rendered.layout.width).toBeLessThanOrEqual(16_384);
    expect(rendered.layout.height).toBeLessThanOrEqual(16_384);
    expect(rendered.layout.width * rendered.layout.height).toBeLessThanOrEqual(50_331_648);

    const sameLayer = graph();
    sameLayer.nodes = Array.from({ length: 153 }, (_, index) =>
      node(`event:wide.${String(index).padStart(3, '0')}`, 'event', {
        isTriggeredOnly: true,
      }),
    );
    sameLayer.edges = [];
    const wideLayout = layoutEventGraph(sameLayer);
    expect(wideLayout.width).toBeLessThanOrEqual(16_384);
    expect(wideLayout.height).toBeLessThanOrEqual(16_384);

    const stable = graph();
    stable.nodes = [node('event:stable.m', 'event'), node('event:stable.z', 'event')];
    stable.edges = [];
    const before = layoutEventGraph(stable);
    stable.nodes.push(node('event:stable.a', 'event'));
    const after = layoutEventGraph(stable);
    for (const id of ['event:stable.m', 'event:stable.z']) {
      expect(after.nodes.find((placed) => placed.id === id)).toMatchObject(
        before.nodes.find((placed) => placed.id === id)!,
      );
    }

    const self = graph();
    self.nodes = [node('event:self.1', 'event')];
    self.edges = [edge('edge:self', 'event:self.1', 'event:self.1', 'immediate_event_call')];
    const selfLayout = layoutEventGraph(self);
    const placed = selfLayout.nodes[0]!;
    const loop = selfLayout.edges[0]!;
    expect(loop.points.some(({ x }) => x > placed.x + placed.width)).toBe(true);
    expect(loop.points.some(({ y }) => y < placed.y)).toBe(true);
  });

  it('renders timing, scope, state links, and focused unresolved evidence visibly', async () => {
    const source = graph();
    source.edges = source.edges.map((value) =>
      value.id === 'edge:cycle'
        ? {
            ...value,
            scope: {
              source: 'country',
              destination: 'country',
              expression: 'ROOT',
              confidence: 'confirmed',
            },
          }
        : value,
    );
    source.stateLinks = [
      {
        id: 'state-link:visible',
        stateKind: 'country_flag',
        name: 'unit_ready',
        producerId: 'state:write',
        consumerId: 'state:read',
        confidence: 'confirmed',
        pathConfirmed: true,
      },
    ];
    source.unresolved.push({
      id: 'unresolved:unrelated',
      kind: 'dynamic_event',
      expression: '[unrelated]',
      ownerId: 'event:unit.3',
      confidence: 'unresolved',
      blockers: [{ code: 'DYNAMIC', message: 'Unrelated dynamic dispatch' }],
    });

    const timing = await renderEventGraph(source, {
      view: 'timing',
      maxNodes: 20,
      includeHtml: false,
    });
    expect(timing.svg).toContain('aria-label="d 2"');
    expect(
      (JSON.parse(timing.json) as { unresolved: Array<{ id: string }> }).unresolved.map(
        ({ id }) => id,
      ),
    ).not.toContain('unresolved:unrelated');

    const scope = await renderEventGraph(source, {
      view: 'scope',
      maxNodes: 20,
      includeHtml: false,
    });
    expect(scope.svg).toContain('aria-label="country → country via ROOT"');

    const stateView = await renderEventGraph(source, {
      view: 'state',
      maxNodes: 20,
      includeHtml: false,
    });
    expect(stateView.svg).toContain('data-event-state-link-id="state-link:visible"');
    expect(
      (JSON.parse(stateView.json) as { stateLinks: Array<{ id: string }> }).stateLinks,
    ).toEqual([expect.objectContaining({ id: 'state-link:visible' })]);
  });

  it('propagates cancellation through roots, state, lint, and impact queries', () => {
    const controller = new AbortController();
    controller.abort();
    const source = graph();
    expect(() => discoverEventRoots(source, controller.signal)).toThrow();
    expect(() => inspectEventStateFlow(source, undefined, undefined, controller.signal)).toThrow();
    expect(() => lintEventGraph(source, undefined, controller.signal)).toThrow();
    expect(() =>
      analyzeEventImpact(source, { kind: 'event', name: 'unit.1' }, controller.signal),
    ).toThrow();
  });
});

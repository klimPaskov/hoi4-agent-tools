import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  explainEventPath,
  traceSelectedEvents,
  type EventGraphEdge,
  type EventGraphNode,
  type EventGraphSnapshot,
} from '../../src/hoi4_agent_tools/event/index.js';

const at = (symbol: string, offset: number) => ({
  path: 'mod:events/p.txt',
  start: { line: offset + 1, column: 1, offset },
  end: { line: offset + 1, column: 8, offset: offset + 7 },
  symbol,
});

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
    sourcePath: 'mod:events/p.txt',
    location: at(id, id.length),
    metadata,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  reason: EventGraphEdge['reason'],
): EventGraphEdge {
  return {
    id,
    from,
    to,
    reason,
    conditions: [],
    helperStack: [],
    location: at(id, id.length + 20),
    provenance: [{ role: 'invocation', location: at(id, id.length + 20) }],
    confidence: 'confirmed',
    derived: false,
    metadata: {},
  };
}

/** A focused graph (issue 278): helpers are structural nodes and no derived edge is materialised. */
function focusedGraph(): EventGraphSnapshot {
  const edges = [
    edge('edge:a-option', 'event:p.1', 'option:p.1:a', 'option_branch'),
    edge('edge:option-helper', 'option:p.1:a', 'helper:p_follow', 'scripted_effect_call'),
    edge('edge:helper-event', 'helper:p_follow', 'event:p.2', 'scripted_effect_expansion'),
  ];
  return {
    schemaVersion: 1,
    parserVersion: 'clausewitz-cst.v1',
    workspaceId: 'p',
    workspaceIdentity: sha256Bytes('p-workspace'),
    revision: sha256Bytes('p-revision'),
    complete: true,
    sourceHashes: { 'mod:events/p.txt': sha256Bytes('source') },
    filesScanned: ['mod:events/p.txt'],
    skippedSourceCount: 0,
    skippedSources: [],
    nodes: [
      node('event:p.1', 'event'),
      node('option:p.1:a', 'option'),
      node('helper:p_follow', 'helper', { name: 'p_follow' }),
      node('event:p.2', 'event'),
    ],
    edges,
    stateAccesses: [],
    stateLinks: [],
    issues: [],
    diagnostics: [],
    unresolved: [],
    statistics: {
      eventCount: 2,
      optionCount: 1,
      entryCount: 0,
      helperCount: 1,
      unresolvedNodeCount: 0,
      terminalCount: 0,
      edgeCount: edges.length,
      derivedEdgeCount: 0,
      stateAccessCount: 0,
      issueCount: 0,
    },
  };
}

describe('issue 278: explain_path agrees with trace on collapsed helper edges', () => {
  it('finds the path the trace reports when helpers are collapsed and no derived edge exists', () => {
    const graph = focusedGraph();
    const trace = traceSelectedEvents(
      graph,
      { kind: 'event', eventId: 'p.1' },
      { maxDepth: 6, maxNodes: 100, maxEdges: 100, direction: 'downstream', expandHelpers: false },
    );
    expect(trace.nodes.map(({ id }) => id)).toContain('event:p.2');
    const explained = explainEventPath(
      graph,
      { kind: 'event', eventId: 'p.1' },
      { kind: 'event', eventId: 'p.2' },
      { maxDepth: 12, maxNodes: 2_000, expandHelpers: false },
    );
    expect(explained.found).toBe(true);
    expect(explained.steps.map(({ node: step }) => step.id)).toEqual([
      'event:p.1',
      'option:p.1:a',
      'event:p.2',
    ]);
  });
});

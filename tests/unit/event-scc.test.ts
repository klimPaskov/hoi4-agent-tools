import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import type { SourceLocation } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  buildEventGraph,
  eventStronglyConnectedComponents,
  type EventGraphEdge,
  type EventGraphNode,
  type EventGraphSnapshot,
  type EventSourceFragment,
} from '../../src/hoi4_agent_tools/event/index.js';

const sourceLocation: SourceLocation = {
  path: 'mod:events/deep_cycle.txt',
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 2, offset: 1 },
};

function eventId(index: number): string {
  return `deep.${index.toString().padStart(5, '0')}`;
}

function deepCycle(size: number): { nodes: EventGraphNode[]; edges: EventGraphEdge[] } {
  const nodes = Array.from({ length: size }, (_, index): EventGraphNode => {
    const id = eventId(index);
    return {
      id: `event:${id}`,
      kind: 'event',
      label: id,
      eventId: id,
      namespace: 'deep',
      sourcePath: sourceLocation.path,
      location: sourceLocation,
      metadata: { isTriggeredOnly: false },
    };
  });
  const edges = Array.from({ length: size }, (_, index): EventGraphEdge => {
    const from = `event:${eventId(index)}`;
    const to = `event:${eventId((index + 1) % size)}`;
    return {
      id: `edge:deep:${index.toString().padStart(5, '0')}`,
      from,
      to,
      reason: 'immediate_event_call',
      conditions: [],
      helperStack: [],
      location: sourceLocation,
      provenance: [{ role: 'invocation', location: sourceLocation }],
      confidence: 'confirmed',
      derived: false,
      metadata: {},
    };
  });
  return { nodes, edges };
}

function snapshotGraph(size: number): EventGraphSnapshot {
  const { nodes, edges } = deepCycle(size);
  return {
    schemaVersion: 1,
    parserVersion: 'clausewitz-cst.v1',
    workspaceId: 'deep-cycle',
    workspaceIdentity: sha256Bytes('deep-cycle-workspace'),
    revision: sha256Bytes('deep-cycle-revision'),
    complete: true,
    sourceHashes: { [sourceLocation.path]: sha256Bytes('deep-cycle-source') },
    filesScanned: [sourceLocation.path],
    skippedSourceCount: 0,
    skippedSources: [],
    nodes,
    edges,
    stateAccesses: [],
    stateLinks: [],
    issues: [],
    diagnostics: [],
    unresolved: [],
    statistics: {
      eventCount: size,
      optionCount: 0,
      entryCount: 0,
      helperCount: 0,
      unresolvedNodeCount: 0,
      terminalCount: 0,
      edgeCount: size,
      derivedEdgeCount: 0,
      stateAccessCount: 0,
      issueCount: 0,
    },
  };
}

describe('event SCC stack safety', () => {
  it(
    'finds a deterministic SCC across a graph deeper than the JavaScript call stack',
    { timeout: 30_000 },
    () => {
      const size = 15_000;
      const graph = snapshotGraph(size);
      const first = eventStronglyConnectedComponents(graph);
      const second = eventStronglyConnectedComponents(graph);

      expect(second).toEqual(first);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ cyclic: true });
      expect(first[0]?.nodeIds).toHaveLength(size);
      expect(first[0]?.nodeIds[0]).toBe('event:deep.00000');
      expect(first[0]?.nodeIds.at(-1)).toBe('event:deep.14999');
    },
  );

  it(
    'classifies a deep immediate cycle during graph construction without recursion',
    { timeout: 30_000 },
    () => {
      const size = 12_000;
      const { nodes, edges } = deepCycle(size);
      const bytes = Buffer.from('# semantic fragment supplied by the test cache\n', 'utf8');
      const file: ScannedFile = {
        absolutePath: 'C:/virtual/events/deep_cycle.txt',
        displayPath: sourceLocation.path,
        relativePath: 'events/deep_cycle.txt',
        rootKind: 'mod',
        loadOrder: 1,
        size: bytes.length,
        modifiedMs: 0,
        sha256: sha256Bytes(bytes),
        bytes,
      };
      const fragment: EventSourceFragment = {
        cacheKey: 'deep-cycle-fragment',
        sourcePath: file.displayPath,
        sourceHash: file.sha256,
        nodes,
        edges,
        stateAccesses: [],
        issues: [],
        unresolved: [],
        localisation: [],
      };
      const snapshot: ScanSnapshot = {
        workspaceId: 'deep-cycle-build',
        revision: sha256Bytes('deep-cycle-build-revision'),
        files: [file],
        index: SymbolIndex.build([file]),
        complete: true,
        skippedSourceCount: 0,
        skippedSources: [],
        diagnostics: [],
      };

      const built = buildEventGraph(snapshot, {
        cache: {
          get: () => fragment,
          set: () => undefined,
        },
      });
      const immediateCycle = built.issues.find(({ code }) => code === 'EVENT_IMMEDIATE_CYCLE');
      const subjectIds = immediateCycle?.details.subjectIds;

      expect(immediateCycle).toBeDefined();
      expect(Array.isArray(subjectIds) ? subjectIds : []).toHaveLength(size);
      expect(built.nodes).toHaveLength(size);
      expect(built.edges).toHaveLength(size);
    },
  );
});

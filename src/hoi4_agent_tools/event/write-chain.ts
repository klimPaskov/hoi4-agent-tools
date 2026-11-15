import { ServiceError } from '../core/result.js';
import type { EventChainReport } from '../schemas/event-write.js';
import type { EventGraphNode, EventGraphSnapshot } from './model.js';
import type { EventChainViewer } from './service.js';

const LIST_LIMIT = 20;
const ISSUE_LIMIT = 10;
const MESSAGE_LIMIT = 300;

/** The event ids of the graph node ids that are events, in id order, capped. */
function eventIds(
  nodeIds: readonly string[],
  graphs: readonly EventGraphSnapshot[],
): { ids: string[]; truncated: boolean } {
  const nodes = new Map<string, EventGraphNode>();
  for (const graph of graphs) for (const node of graph.nodes) nodes.set(node.id, node);
  const ids = [
    ...new Set(
      nodeIds.flatMap((id) => {
        const node = nodes.get(id);
        return node?.kind === 'event' && node.eventId !== undefined ? [node.eventId] : [];
      }),
    ),
  ].sort();
  return { ids: ids.slice(0, LIST_LIMIT), truncated: ids.length > LIST_LIMIT };
}

/**
 * What an edit does to the event chains of the mod: the events it adds, removes or changes, the calls
 * it removes, the events that lose a caller, the issues it introduces and the events it cuts off from
 * every root. It compares the current graph of the mod and the installed game with one in which the
 * planned file replaces the old one, so it costs a scan of both and is asked for with `chain: true`.
 * A comparison that cannot run is reported as such and never stops the write.
 */
export async function eventChainReport(
  viewer: EventChainViewer,
  request: {
    workspaceId: string;
    principal?: string;
    signal?: AbortSignal;
  },
  plan: { path: string; text: string; sourceHash: string | undefined },
): Promise<EventChainReport> {
  try {
    const compared = await viewer.compareAndStore({
      workspaceId: request.workspaceId,
      proposedSources: [
        {
          relativePath: plan.path,
          source: plan.text,
          ...(plan.sourceHash === undefined ? {} : { expectedSourceHash: plan.sourceHash }),
        },
      ],
      render: false,
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const { comparison, before, after } = compared;
    const graphs = [before, after] as const;
    const added = eventIds(comparison.addedNodeIds, graphs);
    const removed = eventIds(comparison.removedNodeIds, graphs);
    const changed = eventIds(comparison.changedNodeIds, graphs);
    const losing = eventIds(
      comparison.changes.filter(({ kind }) => kind === 'caller_removed').map((c) => c.subjectId),
      graphs,
    );
    const unreachable = eventIds(comparison.newlyDisconnectedRootIds, graphs);
    // An issue id is `issue:<code>:<hash>`; the message is the one the graph gives that code.
    const newIssues = comparison.addedIssueIds.flatMap((id) => {
      const code = /^issue:([^:]+):/u.exec(id)?.[1];
      if (code === undefined) return [];
      const sample = after.issues.find((issue) => issue.code === code);
      return [{ code, message: (sample?.message ?? code).slice(0, MESSAGE_LIMIT) }];
    });
    const nodes = new Map(graphs.flatMap((graph) => graph.nodes.map((node) => [node.id, node])));
    // A terminal edge only ends an option; it is not a call between events.
    const edges = new Map(graphs.flatMap((graph) => graph.edges.map((edge) => [edge.id, edge])));
    const calls = (ids: readonly string[]): number =>
      ids.filter((id) => edges.get(id)?.reason !== 'terminal').length;
    return {
      computed: true,
      complete: before.complete && after.complete,
      addedEvents: added.ids,
      removedEvents: removed.ids,
      changedEvents: changed.ids,
      changedOptions: comparison.changedNodeIds.filter((id) => nodes.get(id)?.kind === 'option')
        .length,
      addedCalls: calls(comparison.addedEdgeIds),
      removedCalls: calls(comparison.removedEdgeIds),
      eventsLosingCallers: losing.ids,
      newIssues: newIssues.slice(0, ISSUE_LIMIT),
      resolvedIssues: comparison.resolvedIssueIds.length,
      newlyUnreachable: unreachable.ids,
      truncated:
        added.truncated ||
        removed.truncated ||
        changed.truncated ||
        losing.truncated ||
        unreachable.truncated ||
        newIssues.length > ISSUE_LIMIT,
    };
  } catch (error) {
    if (request.signal?.aborted === true) throw error;
    if (error instanceof ServiceError)
      return { computed: false, reason: `${error.code}: ${error.message}`.slice(0, MESSAGE_LIMIT) };
    throw error;
  }
}

import { ServiceError } from '../core/result.js';
import type { TechWritePlacementReport } from '../schemas/tech-write.js';
import type { TechnologyPlacement } from './model.js';
import type { TechnologyTreeViewer } from './service.js';

const LIST_LIMIT = 20;
const MOVE_LIMIT = 10;
const ISSUE_LIMIT = 10;
const MESSAGE_LIMIT = 300;

function describePlacement(placement: TechnologyPlacement): string {
  const x = placement.x ?? placement.xExpression ?? '?';
  const y = placement.y ?? placement.yExpression ?? '?';
  return `${placement.folderId} (${x}, ${y})`;
}

function capped(ids: readonly string[]): { ids: string[]; truncated: boolean } {
  const sorted = [...new Set(ids)].sort();
  return { ids: sorted.slice(0, LIST_LIMIT), truncated: sorted.length > LIST_LIMIT };
}

/**
 * What an edit does to the technology trees: the technologies it adds, removes, moves or changes, the
 * prerequisite paths it adds or removes, the issues it introduces or resolves (two technologies on one
 * coordinate, for example) and the technologies it makes unreachable. It compares the technology graph
 * of the mod and the game with one in which the planned file replaces the old one, so it costs a scan
 * of both and is asked for with `placement: true`. A comparison that cannot run is reported as such and
 * never stops the write.
 */
export async function techPlacementReport(
  viewer: TechnologyTreeViewer,
  request: { workspaceId: string; principal?: string; signal?: AbortSignal },
  plan: { path: string; text: string; sourceHash: string | undefined },
): Promise<TechWritePlacementReport> {
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
    const added = capped(comparison.technologies.added);
    const removed = capped(comparison.technologies.removed);
    const changed = capped(
      comparison.technologies.metadataChanged.map(({ technologyId }) => technologyId),
    );
    const orphaned = capped(comparison.reachability.newlyOrphaned);
    const reachable = capped(comparison.reachability.newlyReachable);
    const moves = comparison.technologies.moved.slice(0, MOVE_LIMIT).map((move) => ({
      technologyId: move.technologyId,
      from: move.before.map(describePlacement).slice(0, 4),
      to: move.after.map(describePlacement).slice(0, 4),
    }));
    return {
      computed: true,
      complete: before.complete && after.complete,
      addedTechnologies: added.ids,
      removedTechnologies: removed.ids,
      changedTechnologies: changed.ids,
      moved: moves,
      addedPaths: comparison.edges.added.length,
      removedPaths: comparison.edges.removed.length,
      newIssues: comparison.issues.introduced.slice(0, ISSUE_LIMIT).map((issue) => ({
        code: issue.code,
        message: issue.message.slice(0, MESSAGE_LIMIT),
      })),
      resolvedIssues: comparison.issues.resolved.length,
      newlyOrphaned: orphaned.ids,
      newlyReachable: reachable.ids,
      truncated:
        added.truncated ||
        removed.truncated ||
        changed.truncated ||
        orphaned.truncated ||
        reachable.truncated ||
        comparison.technologies.moved.length > MOVE_LIMIT ||
        comparison.issues.introduced.length > ISSUE_LIMIT,
    };
  } catch (error) {
    if (request.signal?.aborted === true) throw error;
    if (error instanceof ServiceError)
      return { computed: false, reason: `${error.code}: ${error.message}`.slice(0, MESSAGE_LIMIT) };
    throw error;
  }
}

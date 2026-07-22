import { compareCodeUnits, deterministicId } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type {
  TechnologyDefectClass,
  TechnologyEdge,
  TechnologyGraphSnapshot,
  TechnologyIssue,
  TechnologyUnlockKind,
} from './model.js';

export interface TechnologyTraceInput {
  technologyId: string;
  direction?: 'prerequisites' | 'descendants' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  includeSubTechnologies?: boolean;
  signal?: AbortSignal;
}

export interface TechnologyTraceResult {
  technologyId: string;
  direction: 'prerequisites' | 'descendants' | 'both';
  nodes: string[];
  edges: TechnologyEdge[];
  layers: Array<{ depth: number; technologyIds: string[] }>;
  truncated: boolean;
  boundary: string[];
}

const MAX_TRACE_DEPTH = 256;
const MAX_TRACE_NODES = 25_000;

function requireTechnology(graph: TechnologyGraphSnapshot, technologyId: string): void {
  if (!graph.technologies.some(({ id }) => id === technologyId))
    throw new ServiceError('TECHNOLOGY_NOT_FOUND', `Technology ${technologyId} was not found`, {
      technologyId,
    });
}

export function technologyScanReport(graph: TechnologyGraphSnapshot): unknown {
  const classifications = Object.fromEntries(
    ['confirmed_error', 'probable_defect', 'design_warning', 'unresolved_analysis'].map(
      (classification) => [
        classification,
        graph.issues.filter((issue) => issue.classification === classification).length,
      ],
    ),
  );
  return {
    schemaVersion: graph.schemaVersion,
    parserVersion: graph.parserVersion,
    workspaceId: graph.workspaceId,
    workspaceIdentity: graph.workspaceIdentity,
    revision: graph.revision,
    complete: graph.complete,
    statistics: graph.statistics,
    issueClassifications: classifications,
    folderIds: graph.folders.map(({ id }) => id),
    modernDoctrineFolders: graph.doctrineDefinitions
      .filter(({ kind }) => kind === 'folder')
      .map(({ id }) => id),
    sourceHashCount: Object.keys(graph.sourceHashes).length,
    skippedSourceCount: graph.skippedSourceCount,
    analysisBoundary: graph.analysisBoundary,
    issueSamples: graph.issues.slice(0, 100),
    unresolvedSamples: graph.unresolved.slice(0, 100),
    authoritativeGraphIncluded: true,
  };
}

export function discoverTechnologyFolders(
  graph: TechnologyGraphSnapshot,
  folderId?: string,
): unknown {
  const incoming = new Set(
    graph.edges.filter(({ kind }) => kind === 'prerequisite').map(({ to }) => to),
  );
  const selected = graph.folders.filter(
    (folder) => folderId === undefined || folder.id === folderId,
  );
  if (folderId !== undefined && selected.length === 0)
    throw new ServiceError('TECH_FOLDER_NOT_FOUND', `Technology folder ${folderId} was not found`, {
      folderId,
    });
  return {
    folders: selected.map((folder) => {
      const placements = graph.placements.filter(
        ({ folderId: candidate }) => candidate === folder.id,
      );
      const technologyIds = [...new Set(placements.map(({ technologyId }) => technologyId))].sort(
        compareCodeUnits,
      );
      const roots = technologyIds.filter((technologyId) => !incoming.has(technologyId));
      return {
        folder,
        placementCount: placements.length,
        technologyCount: technologyIds.length,
        roots,
        placements,
        issues: graph.issues.filter(({ details }) => details.folderId === folder.id),
      };
    }),
    modernDoctrines: graph.doctrineDefinitions
      .filter(({ kind, id }) => kind === 'folder' && (folderId === undefined || id === folderId))
      .map((folder) => ({
        folder,
        grandDoctrines: graph.doctrineDefinitions.filter(
          ({ kind, folderId: candidate }) => kind === 'grand_doctrine' && candidate === folder.id,
        ),
      })),
  };
}

export function traceTechnology(
  graph: TechnologyGraphSnapshot,
  input: TechnologyTraceInput,
): TechnologyTraceResult {
  requireTechnology(graph, input.technologyId);
  const direction = input.direction ?? 'both';
  const maxDepth = input.maxDepth ?? 32;
  const maxNodes = input.maxNodes ?? 2_000;
  if (maxDepth < 0 || maxDepth > MAX_TRACE_DEPTH || maxNodes < 1 || maxNodes > MAX_TRACE_NODES)
    throw new ServiceError(
      'TECH_TRACE_LIMIT_INVALID',
      'Technology trace limits are outside supported bounds',
      {
        maxDepth,
        maxNodes,
        maximumDepth: MAX_TRACE_DEPTH,
        maximumNodes: MAX_TRACE_NODES,
      },
    );
  const allowedKinds = new Set<TechnologyEdge['kind']>([
    'prerequisite',
    ...(input.includeSubTechnologies === true ? (['sub_technology'] as const) : []),
  ]);
  const relevant = graph.edges.filter(({ kind }) => allowedKinds.has(kind));
  const incoming = new Map<string, TechnologyEdge[]>();
  const outgoing = new Map<string, TechnologyEdge[]>();
  for (const edge of relevant) {
    const upstream = incoming.get(edge.to) ?? [];
    upstream.push(edge);
    incoming.set(edge.to, upstream);
    const downstream = outgoing.get(edge.from) ?? [];
    downstream.push(edge);
    outgoing.set(edge.from, downstream);
  }
  const selected = new Set([input.technologyId]);
  const selectedEdges = new Map<string, TechnologyEdge>();
  const depthById = new Map([[input.technologyId, 0]]);
  const queue = [input.technologyId];
  const boundary = new Set<string>();
  let truncated = false;
  while (queue.length > 0) {
    input.signal?.throwIfAborted();
    const current = queue.shift()!;
    const depth = depthById.get(current) ?? 0;
    const candidates = [
      ...(direction === 'descendants'
        ? []
        : (incoming.get(current) ?? []).map((edge) => ({ edge, next: edge.from }))),
      ...(direction === 'prerequisites'
        ? []
        : (outgoing.get(current) ?? []).map((edge) => ({ edge, next: edge.to }))),
    ].sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id));
    for (const { edge, next } of candidates) {
      selectedEdges.set(edge.id, edge);
      if (selected.has(next)) continue;
      if (depth >= maxDepth || selected.size >= maxNodes) {
        truncated = true;
        boundary.add(next);
        continue;
      }
      selected.add(next);
      depthById.set(next, depth + 1);
      queue.push(next);
    }
  }
  const layers = [...new Set(depthById.values())]
    .sort((left, right) => left - right)
    .map((depth) => ({
      depth,
      technologyIds: [...depthById]
        .filter(([, candidate]) => candidate === depth)
        .map(([id]) => id)
        .sort(compareCodeUnits),
    }));
  return {
    technologyId: input.technologyId,
    direction,
    nodes: [...selected].sort(compareCodeUnits),
    edges: [...selectedEdges.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
    layers,
    truncated,
    boundary: [...boundary].sort(compareCodeUnits),
  };
}

export function explainTechnology(
  graph: TechnologyGraphSnapshot,
  technologyId: string,
  signal?: AbortSignal,
): unknown {
  requireTechnology(graph, technologyId);
  const technology = graph.technologies.find(({ id }) => id === technologyId)!;
  const prerequisites = traceTechnology(graph, {
    technologyId,
    direction: 'prerequisites',
    maxDepth: 256,
    maxNodes: 25_000,
    ...(signal === undefined ? {} : { signal }),
  });
  const descendants = traceTechnology(graph, {
    technologyId,
    direction: 'descendants',
    maxDepth: 256,
    maxNodes: 25_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    technology,
    placements: graph.placements.filter(
      ({ technologyId: candidate }) => candidate === technologyId,
    ),
    directPrerequisites: graph.edges.filter(
      ({ kind, to }) => kind === 'prerequisite' && to === technologyId,
    ),
    transitivePrerequisites: prerequisites,
    directDescendants: graph.edges.filter(
      ({ kind, from }) => kind === 'prerequisite' && from === technologyId,
    ),
    descendants,
    exclusiveChoices: graph.edges.filter(
      ({ kind, from, to }) =>
        kind === 'exclusive' && (from === technologyId || to === technologyId),
    ),
    unlocks: graph.unlocks.filter(({ technologyId: candidate }) => candidate === technologyId),
    externalGrants: graph.externalReferences.filter(
      ({ technologyId: candidate, kind }) =>
        candidate === technologyId && (kind === 'grant' || kind === 'starting_technology'),
    ),
    matchingBonuses: graph.externalReferences.filter(
      ({ technologyId: candidate, categoryId, kind }) =>
        kind === 'research_bonus' &&
        (candidate === technologyId ||
          (categoryId !== undefined && technology.categories.includes(categoryId))),
    ),
    issues: graph.issues.filter(
      ({ details }) =>
        details.technologyId === technologyId ||
        (Array.isArray(details.technologyIds) && details.technologyIds.includes(technologyId)),
    ),
    unresolved: graph.unresolved.filter(({ ownerId }) => ownerId === technologyId),
    confidenceLimits: graph.analysisBoundary,
  };
}

export function inspectTechnologyUnlocks(
  graph: TechnologyGraphSnapshot,
  selector: { technologyId?: string; targetKind?: TechnologyUnlockKind; targetId?: string },
): unknown {
  if (selector.technologyId !== undefined) requireTechnology(graph, selector.technologyId);
  const unlocks = graph.unlocks.filter(
    ({ technologyId, kind, targetId }) =>
      (selector.technologyId === undefined || technologyId === selector.technologyId) &&
      (selector.targetKind === undefined || kind === selector.targetKind) &&
      (selector.targetId === undefined || targetId === selector.targetId),
  );
  return {
    selector,
    unlocks,
    targets: graph.unlockTargets.filter(({ kind, targetId }) =>
      unlocks.some((unlock) => unlock.kind === kind && unlock.targetId === targetId),
    ),
    externalGrants: graph.externalReferences.filter(
      ({ technologyId, kind }) =>
        technologyId !== undefined &&
        unlocks.some((unlock) => unlock.technologyId === technologyId) &&
        (kind === 'grant' || kind === 'starting_technology'),
    ),
    issues: graph.issues.filter(
      ({ code, details }) =>
        code === 'TECH_UNLOCK_TARGET_MISSING' &&
        unlocks.some(
          ({ technologyId, kind, targetId }) =>
            details.technologyId === technologyId &&
            details.targetKind === kind &&
            details.targetId === targetId,
        ),
    ),
  };
}

export function technologyBonusCoverage(
  graph: TechnologyGraphSnapshot,
  selector: { categoryId?: string; technologyId?: string } = {},
): unknown {
  if (selector.technologyId !== undefined) requireTechnology(graph, selector.technologyId);
  const categories = graph.categories.filter(
    ({ id }) => selector.categoryId === undefined || id === selector.categoryId,
  );
  if (selector.categoryId !== undefined && categories.length === 0)
    throw new ServiceError(
      'TECH_CATEGORY_NOT_FOUND',
      `Technology category ${selector.categoryId} was not found`,
      { categoryId: selector.categoryId },
    );
  const rows = categories.map((category) => {
    const technologyIds = graph.technologies
      .filter(
        ({ id, categories: memberships }) =>
          memberships.includes(category.id) &&
          (selector.technologyId === undefined || id === selector.technologyId),
      )
      .map(({ id }) => id);
    const bonusSources = graph.externalReferences.filter(
      ({ kind, categoryId, technologyId }) =>
        kind === 'research_bonus' &&
        (categoryId === category.id ||
          (technologyId !== undefined && technologyIds.includes(technologyId))),
    );
    const sharingSources = graph.externalReferences.filter(
      ({ kind, categoryId }) => kind === 'technology_sharing' && categoryId === category.id,
    );
    return {
      category,
      technologyIds,
      bonusSources,
      sharingSources,
      covered: bonusSources.length > 0 || sharingSources.length > 0,
    };
  });
  return {
    selector,
    rows,
    uncoveredCategoryIds: rows.filter(({ covered }) => !covered).map(({ category }) => category.id),
    technologySpecificBonuses: graph.externalReferences.filter(
      ({ kind, technologyId }) =>
        kind === 'research_bonus' &&
        technologyId !== undefined &&
        (selector.technologyId === undefined || technologyId === selector.technologyId),
    ),
    invalidBonusSources: graph.issues.filter(
      ({ code }) =>
        code === 'TECH_EXTERNAL_CATEGORY_MISSING' || code === 'TECH_BONUS_TARGET_MISSING',
    ),
  };
}

export function lintTechnologyGraph(
  graph: TechnologyGraphSnapshot,
  filter: {
    classifications?: TechnologyDefectClass[];
    codes?: string[];
    folderId?: string;
    technologyId?: string;
  } = {},
): unknown {
  const issues = graph.issues.filter(
    (issue) =>
      (filter.classifications === undefined ||
        filter.classifications.includes(issue.classification)) &&
      (filter.codes === undefined || filter.codes.includes(issue.code)) &&
      (filter.folderId === undefined || issue.details.folderId === filter.folderId) &&
      (filter.technologyId === undefined ||
        issue.details.technologyId === filter.technologyId ||
        (Array.isArray(issue.details.technologyIds) &&
          issue.details.technologyIds.includes(filter.technologyId))),
  );
  const grouped = (key: (issue: TechnologyIssue) => string): Record<string, number> => {
    const counts = new Map<string, number>();
    for (const issue of issues) counts.set(key(issue), (counts.get(key(issue)) ?? 0) + 1);
    return Object.fromEntries([...counts].sort(([left], [right]) => compareCodeUnits(left, right)));
  };
  return {
    filter,
    issueCount: issues.length,
    byClassification: grouped(({ classification }) => classification),
    byCode: grouped(({ code }) => code),
    issues,
    unresolved: graph.unresolved.filter((item) =>
      filter.technologyId === undefined ? true : item.ownerId === filter.technologyId,
    ),
  };
}

export interface TechnologyImpactInput {
  kind: 'technology' | 'category' | 'folder' | 'unlock_target';
  id: string;
  operation: 'remove' | 'rename';
  replacementId?: string;
}

export function analyzeTechnologyImpact(
  graph: TechnologyGraphSnapshot,
  input: TechnologyImpactInput,
): unknown {
  if (input.operation === 'rename' && input.replacementId === undefined)
    throw new ServiceError(
      'TECH_IMPACT_REPLACEMENT_REQUIRED',
      'Rename impact requires replacementId',
    );
  const references: unknown[] = [];
  if (input.kind === 'technology') {
    requireTechnology(graph, input.id);
    references.push(
      ...graph.edges.filter(({ from, to }) => from === input.id || to === input.id),
      ...graph.placements.filter(({ technologyId }) => technologyId === input.id),
      ...graph.unlocks.filter(({ technologyId }) => technologyId === input.id),
      ...graph.externalReferences.filter(({ technologyId }) => technologyId === input.id),
    );
  } else if (input.kind === 'category') {
    references.push(
      ...graph.technologies.filter(({ categories }) => categories.includes(input.id)),
      ...graph.externalReferences.filter(({ categoryId }) => categoryId === input.id),
    );
  } else if (input.kind === 'folder') {
    references.push(
      ...graph.placements.filter(({ folderId }) => folderId === input.id),
      ...graph.technologies.filter(({ folders }) => folders.includes(input.id)),
    );
  } else {
    references.push(...graph.unlocks.filter(({ targetId }) => targetId === input.id));
  }
  const locations = references.flatMap((reference) => {
    if (reference !== null && typeof reference === 'object') {
      if ('location' in reference && reference.location !== undefined) return [reference.location];
      if (
        'source' in reference &&
        reference.source !== undefined &&
        reference.source !== null &&
        typeof reference.source === 'object' &&
        'location' in reference.source
      )
        return [reference.source.location];
    }
    return [];
  });
  return {
    id: deterministicId('tech-impact', input),
    subject: input,
    referenceCount: references.length,
    references,
    sourceLocations: locations,
    wouldBreakReferences: references.length > 0,
    replacementCollision:
      input.replacementId === undefined
        ? false
        : graph.technologies.some(({ id }) => id === input.replacementId) ||
          graph.categories.some(({ id }) => id === input.replacementId) ||
          graph.folders.some(({ id }) => id === input.replacementId),
    limitations: graph.analysisBoundary.unsupportedConstructs,
  };
}

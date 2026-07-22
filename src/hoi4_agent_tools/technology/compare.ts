import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import type {
  TechnologyDefinition,
  TechnologyEdge,
  TechnologyExternalReference,
  TechnologyGraphSnapshot,
  TechnologyIssue,
  TechnologyPlacement,
  TechnologyUnlock,
} from './model.js';

export interface TechnologyRenameComparison {
  beforeId: string;
  afterId: string;
  confidence: 'high' | 'medium';
  evidence: string[];
}

export interface TechnologyGraphComparison {
  schemaVersion: 1;
  beforeRevision: string;
  afterRevision: string;
  technologies: {
    added: string[];
    removed: string[];
    renamed: TechnologyRenameComparison[];
    moved: Array<{
      technologyId: string;
      before: TechnologyPlacement[];
      after: TechnologyPlacement[];
    }>;
    metadataChanged: Array<{
      technologyId: string;
      fields: string[];
      before: Partial<TechnologyDefinition>;
      after: Partial<TechnologyDefinition>;
    }>;
  };
  edges: { added: TechnologyEdge[]; removed: TechnologyEdge[] };
  unlocks: { added: TechnologyUnlock[]; removed: TechnologyUnlock[] };
  externalReferences: {
    added: TechnologyExternalReference[];
    removed: TechnologyExternalReference[];
  };
  folders: { added: string[]; removed: string[]; changed: string[] };
  issues: { introduced: TechnologyIssue[]; resolved: TechnologyIssue[]; retained: number };
  reachability: { newlyReachable: string[]; newlyOrphaned: string[] };
  sourceFiles: { added: string[]; removed: string[]; changed: string[] };
  regressions: TechnologyIssue[];
}

function byId<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function placementSignature(values: readonly TechnologyPlacement[]): string {
  return hashCanonical(
    values
      .map(({ folderId, x, y, xExpression, yExpression }) => ({
        folderId,
        x: x ?? null,
        y: y ?? null,
        xExpression: xExpression ?? null,
        yExpression: yExpression ?? null,
      }))
      .sort(
        (left, right) =>
          compareCodeUnits(left.folderId, right.folderId) ||
          (left.x ?? 0) - (right.x ?? 0) ||
          (left.y ?? 0) - (right.y ?? 0),
      ),
  );
}

function edgeKey(edge: TechnologyEdge): string {
  return hashCanonical({
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    coefficient: edge.coefficient ?? null,
    ignoreForLayout: edge.ignoreForLayout ?? null,
  });
}

function unlockKey(unlock: TechnologyUnlock): string {
  return hashCanonical({
    technologyId: unlock.technologyId,
    kind: unlock.kind,
    targetId: unlock.targetId,
    level: unlock.level ?? null,
  });
}

function externalKey(reference: TechnologyExternalReference): string {
  return hashCanonical({
    kind: reference.kind,
    sourceKind: reference.sourceKind,
    sourceId: reference.sourceId,
    technologyId: reference.technologyId ?? null,
    categoryId: reference.categoryId ?? null,
    helperStack: reference.helperStack,
    expression: reference.expression,
  });
}

function issueKey(issue: TechnologyIssue): string {
  return hashCanonical({
    code: issue.code,
    classification: issue.classification,
    details: issue.details,
  });
}

function difference<T>(
  before: readonly T[],
  after: readonly T[],
  key: (value: T) => string,
): { added: T[]; removed: T[] } {
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((value) => !beforeKeys.has(key(value))),
    removed: before.filter((value) => !afterKeys.has(key(value))),
  };
}

function reachable(graph: TechnologyGraphSnapshot, signal?: AbortSignal): Set<string> {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const technology of graph.technologies) {
    incoming.set(technology.id, 0);
    outgoing.set(technology.id, []);
  }
  for (const edge of graph.edges.filter(({ kind }) => kind === 'prerequisite')) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const result = new Set<string>();
  const pending = graph.technologies
    .filter(({ id, hidden }) => hidden !== true && (incoming.get(id) ?? 0) === 0)
    .map(({ id }) => id);
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return result;
}

function technologyMetadata(technology: TechnologyDefinition): Record<string, unknown> {
  return {
    kind: technology.kind,
    startYear: technology.startYear ?? null,
    researchCost: technology.researchCost ?? null,
    doctrineName: technology.doctrineName ?? null,
    hidden: technology.hidden,
    folders: technology.folders,
    categories: technology.categories,
    tags: technology.tags,
    subTechnologies: technology.subTechnologies,
    ai: technology.ai,
    effectSignature: technology.effectSignature,
    localisation: technology.localisation,
    icon: technology.icon,
  };
}

function renameCandidates(
  removed: readonly TechnologyDefinition[],
  added: readonly TechnologyDefinition[],
  beforePlacements: readonly TechnologyPlacement[],
  afterPlacements: readonly TechnologyPlacement[],
  signal?: AbortSignal,
): TechnologyRenameComparison[] {
  const candidates: TechnologyRenameComparison[] = [];
  const claimed = new Set<string>();
  for (const before of removed) {
    signal?.throwIfAborted();
    const matches = added
      .filter((after) => !claimed.has(after.id))
      .map((after) => {
        const evidence: string[] = [];
        if (before.effectSignature === after.effectSignature)
          evidence.push('identical effect and unlock signature');
        if (before.startYear === after.startYear && before.researchCost === after.researchCost)
          evidence.push('identical year and research cost');
        if (
          placementSignature(
            beforePlacements.filter(({ technologyId }) => technologyId === before.id),
          ) ===
          placementSignature(
            afterPlacements.filter(({ technologyId }) => technologyId === after.id),
          )
        )
          evidence.push('identical folder placements');
        if (before.categories.join('\0') === after.categories.join('\0'))
          evidence.push('identical category membership');
        if (before.source.path === after.source.path) evidence.push('same source file');
        return { after, evidence };
      })
      .filter(({ evidence }) => evidence.length >= 4)
      .sort(
        (left, right) =>
          right.evidence.length - left.evidence.length ||
          compareCodeUnits(left.after.id, right.after.id),
      );
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    claimed.add(match.after.id);
    candidates.push({
      beforeId: before.id,
      afterId: match.after.id,
      confidence: match.evidence.length >= 5 ? 'high' : 'medium',
      evidence: match.evidence,
    });
  }
  return candidates.sort((left, right) => compareCodeUnits(left.beforeId, right.beforeId));
}

export function compareTechnologyGraphs(
  before: TechnologyGraphSnapshot,
  after: TechnologyGraphSnapshot,
  signal?: AbortSignal,
): TechnologyGraphComparison {
  signal?.throwIfAborted();
  const beforeTech = byId(before.technologies);
  const afterTech = byId(after.technologies);
  const addedDefinitions = after.technologies.filter(({ id }) => !beforeTech.has(id));
  const removedDefinitions = before.technologies.filter(({ id }) => !afterTech.has(id));
  const added = addedDefinitions.map(({ id }) => id).sort(compareCodeUnits);
  const removed = removedDefinitions.map(({ id }) => id).sort(compareCodeUnits);
  const moved: TechnologyGraphComparison['technologies']['moved'] = [];
  const metadataChanged: TechnologyGraphComparison['technologies']['metadataChanged'] = [];
  for (const [technologyId, beforeDefinition] of beforeTech) {
    signal?.throwIfAborted();
    const afterDefinition = afterTech.get(technologyId);
    if (afterDefinition === undefined) continue;
    const beforePlacement = before.placements.filter(({ technologyId: id }) => id === technologyId);
    const afterPlacement = after.placements.filter(({ technologyId: id }) => id === technologyId);
    if (placementSignature(beforePlacement) !== placementSignature(afterPlacement))
      moved.push({ technologyId, before: beforePlacement, after: afterPlacement });
    const beforeMetadata = technologyMetadata(beforeDefinition);
    const afterMetadata = technologyMetadata(afterDefinition);
    const fields = Object.keys(beforeMetadata)
      .filter(
        (field) => hashCanonical(beforeMetadata[field]) !== hashCanonical(afterMetadata[field]),
      )
      .sort(compareCodeUnits);
    if (fields.length > 0)
      metadataChanged.push({
        technologyId,
        fields,
        before: Object.fromEntries(fields.map((field) => [field, beforeMetadata[field]])),
        after: Object.fromEntries(fields.map((field) => [field, afterMetadata[field]])),
      });
  }
  const edges = difference(before.edges, after.edges, edgeKey);
  const unlocks = difference(before.unlocks, after.unlocks, unlockKey);
  const externalReferences = difference(
    before.externalReferences,
    after.externalReferences,
    externalKey,
  );
  const beforeFolders = byId(before.folders);
  const afterFolders = byId(after.folders);
  const folderAdded = after.folders
    .filter(({ id }) => !beforeFolders.has(id))
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  const folderRemoved = before.folders
    .filter(({ id }) => !afterFolders.has(id))
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  const folderChanged = before.folders
    .filter(({ id }) => {
      const afterFolder = afterFolders.get(id);
      return (
        afterFolder !== undefined &&
        hashCanonical({ ...beforeFolders.get(id), source: undefined }) !==
          hashCanonical({ ...afterFolder, source: undefined })
      );
    })
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  const issueDifference = difference(before.issues, after.issues, issueKey);
  const retained = before.issues.filter((issue) =>
    new Set(after.issues.map(issueKey)).has(issueKey(issue)),
  ).length;
  const beforeReachable = reachable(before, signal);
  const afterReachable = reachable(after, signal);
  const sourceFiles = {
    added: Object.keys(after.sourceHashes)
      .filter((sourcePath) => !(sourcePath in before.sourceHashes))
      .sort(compareCodeUnits),
    removed: Object.keys(before.sourceHashes)
      .filter((sourcePath) => !(sourcePath in after.sourceHashes))
      .sort(compareCodeUnits),
    changed: Object.keys(before.sourceHashes)
      .filter(
        (sourcePath) =>
          after.sourceHashes[sourcePath] !== undefined &&
          after.sourceHashes[sourcePath] !== before.sourceHashes[sourcePath],
      )
      .sort(compareCodeUnits),
  };
  return {
    schemaVersion: 1,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    technologies: {
      added,
      removed,
      renamed: renameCandidates(
        removedDefinitions,
        addedDefinitions,
        before.placements,
        after.placements,
        signal,
      ),
      moved: moved.sort((left, right) => compareCodeUnits(left.technologyId, right.technologyId)),
      metadataChanged: metadataChanged.sort((left, right) =>
        compareCodeUnits(left.technologyId, right.technologyId),
      ),
    },
    edges,
    unlocks,
    externalReferences,
    folders: { added: folderAdded, removed: folderRemoved, changed: folderChanged },
    issues: { introduced: issueDifference.added, resolved: issueDifference.removed, retained },
    reachability: {
      newlyReachable: [...afterReachable]
        .filter((id) => !beforeReachable.has(id))
        .sort(compareCodeUnits),
      newlyOrphaned: [...beforeReachable]
        .filter((id) => !afterReachable.has(id) && afterTech.has(id))
        .sort(compareCodeUnits),
    },
    sourceFiles,
    regressions: issueDifference.added.filter(
      ({ classification }) =>
        classification === 'confirmed_error' || classification === 'probable_defect',
    ),
  };
}

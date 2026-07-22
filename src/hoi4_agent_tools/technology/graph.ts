import {
  canonicalJson,
  compareCodeUnits,
  deterministicId,
  hashCanonical,
} from '../core/canonical.js';
import { sortDiagnostics, type Diagnostic, type SourceLocation } from '../core/diagnostics.js';
import type { ScanSnapshot } from '../core/engine.js';
import type { SymbolIndex } from '../core/index.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import type { RootKind } from '../core/workspace.js';
import {
  analyzeTechnologySource,
  technologyAnalysisDiagnostics,
  technologySourceFiles,
  technologySourceFragmentCacheKey,
  type TechnologySourceAnalysisContext,
  type TechnologySourceFragmentCacheLike,
} from './source-analysis.js';
import {
  TECHNOLOGY_GRAPH_SCHEMA_VERSION,
  TECHNOLOGY_PARSER_VERSION,
  type DoctrineDefinition,
  type TechnologyCategory,
  type TechnologyConfidence,
  type TechnologyDefinition,
  type TechnologyEdge,
  type TechnologyExternalReference,
  type TechnologyFolder,
  type TechnologyGraphSnapshot,
  type TechnologyGridbox,
  type TechnologyHelperCall,
  type TechnologyIconStatus,
  type TechnologyIssue,
  type TechnologyPlacement,
  type TechnologySourceFragment,
  type TechnologyUnlock,
  type TechnologyUnlockTarget,
  type TechnologyUnresolvedAnalysis,
} from './model.js';

export interface TechnologyGraphBuildOptions {
  workspaceIdentity: string;
  assetFiles?: readonly ScannedFile[];
  cache?: TechnologySourceFragmentCacheLike;
  signal?: AbortSignal;
}

const MAX_TECHNOLOGIES = 100_000;
const MAX_EDGES = 500_000;
const MAX_EXTERNAL_REFERENCES = 1_000_000;
const MAX_ISSUES = 100_000;
const MAX_HELPER_DEPTH = 64;
const MAX_HELPER_PROJECTIONS = 500_000;

const confidenceRank: Record<TechnologyConfidence, number> = {
  confirmed: 0,
  high: 1,
  medium: 2,
  low: 3,
  unresolved: 4,
};

function worseConfidence(
  left: TechnologyConfidence,
  right: TechnologyConfidence,
): TechnologyConfidence {
  return confidenceRank[left] >= confidenceRank[right] ? left : right;
}

function sourceKey(source: { path: string; location: SourceLocation }): string {
  return `${source.path}:${source.location.start.offset}`;
}

function activeDefinitions<
  T extends { id: string; source: { loadOrder: number; path: string; location: SourceLocation } },
>(values: readonly T[]): { active: T[]; duplicates: T[][] } {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(value.id) ?? [];
    group.push(value);
    groups.set(value.id, group);
  }
  const active: T[] = [];
  const duplicates: T[][] = [];
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        right.source.loadOrder - left.source.loadOrder ||
        compareCodeUnits(sourceKey(left.source), sourceKey(right.source)),
    );
    const maximum = group[0]!.source.loadOrder;
    const sameLevel = group.filter(({ source }) => source.loadOrder === maximum);
    active.push(sameLevel[0]!);
    if (sameLevel.length > 1) duplicates.push(sameLevel);
  }
  return {
    active: active.sort((left, right) => compareCodeUnits(left.id, right.id)),
    duplicates: duplicates.sort((left, right) => compareCodeUnits(left[0]!.id, right[0]!.id)),
  };
}

function activeCategories(values: readonly TechnologyCategory[]): TechnologyCategory[] {
  return activeDefinitions(values).active;
}

function normalizedAssetPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/\/{2,}/gu, '/')
    .replace(/^\.\//u, '')
    .toLowerCase();
}

function assetMap(files: readonly ScannedFile[]): Map<string, ScannedFile> {
  const result = new Map<string, ScannedFile>();
  for (const file of [...files].sort(
    (left, right) =>
      left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
  )) {
    if (file.shadowedBy === undefined) result.set(normalizedAssetPath(file.relativePath), file);
  }
  return result;
}

function iconStatus(
  spriteName: string,
  index: SymbolIndex,
  assets: ReadonlyMap<string, ScannedFile>,
): TechnologyIconStatus {
  const sprite = index.find('sprite', spriteName);
  if (sprite === undefined) {
    return {
      sprite: spriteName,
      status: index.hasSkippedSourceForKind('sprite') ? 'partial' : 'missing_sprite',
    };
  }
  const texture = typeof sprite.metadata.texture === 'string' ? sprite.metadata.texture : undefined;
  if (texture === undefined)
    return { sprite: spriteName, spritePath: sprite.path, status: 'missing_texture' };
  return {
    sprite: spriteName,
    spritePath: sprite.path,
    texturePath: texture,
    status: assets.has(normalizedAssetPath(texture)) ? 'resolved' : 'missing_texture',
  };
}

function localisationValue(index: SymbolIndex, language: string, key: string): string | undefined {
  const symbol = index.find('localisation', `${language}:${key}`);
  return typeof symbol?.metadata.value === 'string' ? symbol.metadata.value : undefined;
}

function localiseTechnologies(
  values: readonly TechnologySourceFragment['technologies'][number][],
  index: SymbolIndex,
  assets: ReadonlyMap<string, ScannedFile>,
): TechnologyDefinition[] {
  const partialLocalisation = index.hasSkippedSourceForKind('localisation');
  return values.map(({ iconSprite, effectSignatureFields, ...technology }) => {
    const language = 'l_english';
    const name = localisationValue(index, language, technology.id);
    const descriptionKey = `${technology.id}_desc`;
    const description = localisationValue(index, language, descriptionKey);
    return {
      ...technology,
      icon: iconStatus(iconSprite, index, assets),
      localisation: {
        language,
        nameKey: technology.id,
        descriptionKey,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        status:
          name !== undefined && description !== undefined
            ? 'resolved'
            : partialLocalisation
              ? 'partial'
              : 'missing',
      },
      effectSignature: hashCanonical(effectSignatureFields),
    };
  });
}

function localiseFolders(
  values: readonly TechnologyFolder[],
  index: SymbolIndex,
): TechnologyFolder[] {
  const partial = index.hasSkippedSourceForKind('localisation');
  return values.map((folder) => {
    const name = localisationValue(index, 'l_english', folder.id);
    const description = localisationValue(index, 'l_english', `${folder.id}_desc`);
    return {
      ...folder,
      localisation: {
        language: 'l_english',
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        status:
          name !== undefined && description !== undefined
            ? 'resolved'
            : partial
              ? 'partial'
              : 'missing',
      },
    };
  });
}

function localiseDoctrines(
  values: readonly TechnologySourceFragment['doctrineDefinitions'][number][],
  index: SymbolIndex,
  assets: ReadonlyMap<string, ScannedFile>,
): DoctrineDefinition[] {
  return values.map(({ iconSprite, ...definition }) => ({
    ...definition,
    ...(iconSprite === undefined ? {} : { icon: iconStatus(iconSprite, index, assets) }),
  }));
}

function selectOwnedRecords<T>(
  values: readonly T[],
  owner: (value: T) => string,
  location: (value: T) => SourceLocation,
  active: ReadonlyMap<string, TechnologyDefinition>,
): T[] {
  return values.filter((value) => active.get(owner(value))?.source.path === location(value).path);
}

function activeGridboxes(values: readonly TechnologyGridbox[]): TechnologyGridbox[] {
  const groups = new Map<string, TechnologyGridbox[]>();
  for (const gridbox of values) {
    const key = `${gridbox.folderId ?? '<global>'}\0${gridbox.name}`;
    const group = groups.get(key) ?? [];
    group.push(gridbox);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(
      (group) =>
        group.sort(
          (left, right) =>
            right.loadOrder - left.loadOrder ||
            compareCodeUnits(left.sourcePath, right.sourcePath) ||
            left.location.start.offset - right.location.start.offset,
        )[0]!,
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.folderId ?? '', right.folderId ?? '') ||
        compareCodeUnits(left.name, right.name),
    );
}

function enrichPlacements(
  placements: readonly TechnologyPlacement[],
  edges: readonly TechnologyEdge[],
  gridboxes: readonly TechnologyGridbox[],
  signal?: AbortSignal,
): TechnologyPlacement[] {
  const placementsByTechnology = new Map<string, TechnologyPlacement[]>();
  for (const placement of placements) {
    const group = placementsByTechnology.get(placement.technologyId) ?? [];
    group.push(placement);
    placementsByTechnology.set(placement.technologyId, group);
  }
  const parents = new Map<string, string[]>();
  for (const edge of edges.filter(
    ({ kind, ignoreForLayout }) => kind === 'prerequisite' && ignoreForLayout !== true,
  )) {
    const group = parents.get(edge.to) ?? [];
    group.push(edge.from);
    parents.set(edge.to, group);
  }
  const rootsFor = (technologyId: string, folderId: string): string[] => {
    const roots = new Set<string>();
    const pending = [technologyId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const currentParents = parents.get(current) ?? [];
      if (currentParents.length === 0) {
        if (
          current === technologyId ||
          (placementsByTechnology.get(current) ?? []).some(
            ({ folderId: candidate }) => candidate === folderId,
          )
        )
          roots.add(current);
        continue;
      }
      pending.push(...currentParents);
    }
    return [...roots].sort(compareCodeUnits);
  };
  return placements.map((placement) => {
    const roots = rootsFor(placement.technologyId, placement.folderId);
    const branchRootId = roots.length === 1 ? roots[0] : undefined;
    const expectedGridbox = branchRootId === undefined ? undefined : `${branchRootId}_tree`;
    const candidates =
      expectedGridbox === undefined
        ? []
        : gridboxes.filter(
            ({ name, folderId }) =>
              name === expectedGridbox &&
              (folderId === undefined || folderId === placement.folderId),
          );
    const gridbox = candidates[0];
    let pixelX: number | undefined;
    let pixelY: number | undefined;
    if (
      gridbox !== undefined &&
      placement.x !== undefined &&
      placement.y !== undefined &&
      gridbox.position.x !== undefined &&
      gridbox.position.y !== undefined &&
      gridbox.slotSize.width !== undefined &&
      gridbox.slotSize.height !== undefined
    ) {
      const format = gridbox.format?.toUpperCase() ?? 'UP';
      if (format === 'LEFT') {
        pixelX = gridbox.position.x + placement.y * gridbox.slotSize.width;
        pixelY = gridbox.position.y + placement.x * gridbox.slotSize.height;
      } else if (format === 'UP') {
        pixelX = gridbox.position.x + placement.x * gridbox.slotSize.width;
        pixelY = gridbox.position.y + placement.y * gridbox.slotSize.height;
      }
    }
    return {
      ...placement,
      ...(branchRootId === undefined ? {} : { branchRootId }),
      ...(gridbox === undefined ? {} : { gridboxId: gridbox.id }),
      ...(pixelX === undefined ? {} : { pixelX }),
      ...(pixelY === undefined ? {} : { pixelY }),
      geometryStatus:
        pixelX !== undefined && pixelY !== undefined
          ? 'source_pixel'
          : placement.x !== undefined && placement.y !== undefined
            ? 'source_coordinate'
            : 'unresolved',
    };
  });
}

function addIssue(
  issues: TechnologyIssue[],
  issue: Omit<TechnologyIssue, 'blockers' | 'details'> & {
    blockers?: TechnologyIssue['blockers'];
    details?: TechnologyIssue['details'];
  },
): void {
  if (issues.length >= MAX_ISSUES) return;
  issues.push({ ...issue, blockers: issue.blockers ?? [], details: issue.details ?? {} });
}

function issueKey(issue: TechnologyIssue): string {
  return hashCanonical({
    code: issue.code,
    classification: issue.classification,
    location: issue.location,
    details: issue.details,
  });
}

function stableIssues(issues: readonly TechnologyIssue[]): TechnologyIssue[] {
  const deduplicated = new Map<string, TechnologyIssue>();
  for (const issue of issues)
    if (!deduplicated.has(issueKey(issue))) deduplicated.set(issueKey(issue), issue);
  return [...deduplicated.values()].sort(
    (left, right) =>
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.location?.path ?? '', right.location?.path ?? '') ||
      (left.location?.start.offset ?? 0) - (right.location?.start.offset ?? 0),
  );
}

function stronglyConnectedComponents(
  nodeIds: readonly string[],
  edges: readonly TechnologyEdge[],
  signal?: AbortSignal,
): string[][] {
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    reverse.set(id, []);
  }
  for (const edge of edges.filter(({ kind }) => kind === 'prerequisite')) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    reverse.get(edge.to)!.push(edge.from);
  }
  for (const list of [...adjacency.values(), ...reverse.values()]) list.sort(compareCodeUnits);
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of [...nodeIds].sort(compareCodeUnits)) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    visited.add(start);
    while (stack.length > 0) {
      signal?.throwIfAborted();
      const frame = stack.at(-1)!;
      const targets = adjacency.get(frame.id) ?? [];
      const target = targets[frame.next];
      if (target === undefined) {
        order.push(frame.id);
        stack.pop();
        continue;
      }
      frame.next += 1;
      if (!visited.has(target)) {
        visited.add(target);
        stack.push({ id: target, next: 0 });
      }
    }
  }
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const start of order.reverse()) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      signal?.throwIfAborted();
      const current = stack.pop()!;
      component.push(current);
      for (const target of reverse.get(current) ?? []) {
        if (assigned.has(target)) continue;
        assigned.add(target);
        stack.push(target);
      }
    }
    components.push(component.sort(compareCodeUnits));
  }
  return components.sort((left, right) => compareCodeUnits(left[0] ?? '', right[0] ?? ''));
}

function expandHelperReferences(
  references: readonly TechnologyExternalReference[],
  calls: readonly TechnologyHelperCall[],
  unresolved: TechnologyUnresolvedAnalysis[],
  signal?: AbortSignal,
): TechnologyExternalReference[] {
  const direct = references.filter(({ sourceKind }) => sourceKind === 'scripted_effect');
  const publicReferences = references.filter(({ sourceKind }) => sourceKind !== 'scripted_effect');
  const refsByHelper = new Map<string, TechnologyExternalReference[]>();
  for (const reference of direct) {
    const group = refsByHelper.get(reference.sourceId) ?? [];
    group.push(reference);
    refsByHelper.set(reference.sourceId, group);
  }
  const callsBySource = new Map<string, TechnologyHelperCall[]>();
  for (const call of calls) {
    const key = `${call.sourceKind}:${call.sourceId}`;
    const group = callsBySource.get(key) ?? [];
    group.push(call);
    callsBySource.set(key, group);
  }
  const projected: TechnologyExternalReference[] = [...publicReferences, ...direct];
  let projectionCount = 0;
  for (const rootCall of calls.filter(({ sourceKind }) => sourceKind !== 'scripted_effect')) {
    const stack: Array<{
      helperId: string;
      helperStack: string[];
      confidence: TechnologyConfidence;
    }> = [
      {
        helperId: rootCall.helperId,
        helperStack: [rootCall.helperId],
        confidence: rootCall.confidence,
      },
    ];
    const visited = new Set<string>();
    while (stack.length > 0) {
      signal?.throwIfAborted();
      const current = stack.pop()!;
      const visitKey = current.helperStack.join('\0');
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      if (current.helperStack.length > MAX_HELPER_DEPTH) {
        unresolved.push({
          id: deterministicId('tech-unresolved', { rootCall, helperStack: current.helperStack }),
          kind: 'unsupported_construct',
          expression: current.helperStack.join(' -> '),
          ownerId: rootCall.sourceId,
          location: rootCall.location,
          confidence: 'unresolved',
          blockers: [
            {
              code: 'TECH_HELPER_DEPTH_BLOCKED',
              message: `Scripted-effect expansion exceeds depth ${MAX_HELPER_DEPTH}`,
              location: rootCall.location,
            },
          ],
        });
        continue;
      }
      for (const reference of refsByHelper.get(current.helperId) ?? []) {
        projectionCount += 1;
        if (projectionCount > MAX_HELPER_PROJECTIONS) break;
        projected.push({
          ...reference,
          id: deterministicId('tech-external-projection', {
            root: rootCall.id,
            reference: reference.id,
            helperStack: current.helperStack,
          }),
          sourceKind: rootCall.sourceKind,
          sourceId: rootCall.sourceId,
          helperStack: [...current.helperStack],
          confidence: worseConfidence(current.confidence, reference.confidence),
          metadata: {
            ...reference.metadata,
            projectedFromScriptedEffect: reference.sourceId,
            callLocation: canonicalJson(rootCall.location),
          },
        });
      }
      if (projectionCount > MAX_HELPER_PROJECTIONS) break;
      for (const call of callsBySource.get(`scripted_effect:${current.helperId}`) ?? []) {
        if (current.helperStack.includes(call.helperId)) continue;
        stack.push({
          helperId: call.helperId,
          helperStack: [...current.helperStack, call.helperId],
          confidence: worseConfidence(current.confidence, call.confidence),
        });
      }
    }
    if (projectionCount > MAX_HELPER_PROJECTIONS) break;
  }
  if (projectionCount > MAX_HELPER_PROJECTIONS) {
    unresolved.push({
      id: 'tech-unresolved-helper-projection-limit',
      kind: 'unsupported_construct',
      expression: 'scripted_effect expansion',
      confidence: 'unresolved',
      blockers: [
        {
          code: 'TECH_HELPER_PROJECTION_LIMIT',
          message: `Scripted-effect reference expansion exceeds ${MAX_HELPER_PROJECTIONS} projections`,
        },
      ],
    });
  }
  const deduplicated = new Map<string, TechnologyExternalReference>();
  for (const reference of projected)
    if (!deduplicated.has(reference.id)) deduplicated.set(reference.id, reference);
  return [...deduplicated.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function diagnose(
  technologies: readonly TechnologyDefinition[],
  folders: readonly TechnologyFolder[],
  placements: readonly TechnologyPlacement[],
  gridboxes: readonly TechnologyGridbox[],
  edges: readonly TechnologyEdge[],
  categories: readonly TechnologyCategory[],
  doctrines: readonly DoctrineDefinition[],
  unlocks: readonly TechnologyUnlock[],
  externalReferences: readonly TechnologyExternalReference[],
  duplicates: readonly TechnologyDefinition[][],
  unresolved: readonly TechnologyUnresolvedAnalysis[],
  signal?: AbortSignal,
): TechnologyIssue[] {
  const issues: TechnologyIssue[] = [];
  const technologyById = new Map(technologies.map((technology) => [technology.id, technology]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const placementsByTech = new Map<string, TechnologyPlacement[]>();
  for (const placement of placements) {
    const group = placementsByTech.get(placement.technologyId) ?? [];
    group.push(placement);
    placementsByTech.set(placement.technologyId, group);
  }
  const incoming = new Map<string, TechnologyEdge[]>();
  const outgoing = new Map<string, TechnologyEdge[]>();
  for (const edge of edges.filter(({ kind }) => kind === 'prerequisite')) {
    const to = incoming.get(edge.to) ?? [];
    to.push(edge);
    incoming.set(edge.to, to);
    const from = outgoing.get(edge.from) ?? [];
    from.push(edge);
    outgoing.set(edge.from, from);
  }

  for (const group of duplicates) {
    const first = group[0]!;
    addIssue(issues, {
      code: 'TECH_DUPLICATE_ID',
      classification: 'confirmed_error',
      severity: 'error',
      message: `Technology ${first.id} has multiple active definitions at the same load order`,
      confidence: 'confirmed',
      location: first.source.location,
      related: group.slice(1).map(({ source }) => source.location),
      details: { technologyId: first.id },
    });
  }
  for (const edge of edges) {
    signal?.throwIfAborted();
    const owner = technologyById.get(edge.from);
    if (edge.from === edge.to) {
      addIssue(issues, {
        code: 'TECH_SELF_LINK',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${edge.from} links to itself through ${edge.kind}`,
        confidence: 'confirmed',
        location: edge.location,
        details: { technologyId: edge.from, edgeKind: edge.kind },
      });
    }
    if (!technologyById.has(edge.to)) {
      addIssue(issues, {
        code: edge.kind === 'exclusive' ? 'TECH_EXCLUSIVE_TARGET_MISSING' : 'TECH_TARGET_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${edge.from} references missing ${edge.kind} target ${edge.to}`,
        confidence: 'confirmed',
        location: edge.location,
        details: { technologyId: edge.from, targetId: edge.to, edgeKind: edge.kind },
      });
    }
    if (owner === undefined) continue;
  }
  for (const component of stronglyConnectedComponents(
    technologies.map(({ id }) => id),
    edges,
    signal,
  )) {
    if (component.length < 2) continue;
    const first = technologyById.get(component[0]!)!;
    addIssue(issues, {
      code: 'TECH_PREREQUISITE_CYCLE',
      classification: 'confirmed_error',
      severity: 'error',
      message: `Technology prerequisite cycle: ${component.join(' -> ')}`,
      confidence: 'confirmed',
      location: first.source.location,
      details: { technologyIds: component },
    });
  }

  const coordinateGroups = new Map<string, TechnologyPlacement[]>();
  for (const placement of placements) {
    if (!folderById.has(placement.folderId)) {
      addIssue(issues, {
        code: 'TECH_FOLDER_REFERENCE_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${placement.technologyId} references missing folder ${placement.folderId}`,
        confidence: 'confirmed',
        location: placement.location,
        details: { technologyId: placement.technologyId, folderId: placement.folderId },
      });
    }
    if (placement.x === undefined || placement.y === undefined) {
      addIssue(issues, {
        code: 'TECH_PLACEMENT_COORDINATE_UNRESOLVED',
        classification: 'unresolved_analysis',
        severity: 'warning',
        message: `Technology ${placement.technologyId} has an unresolved source coordinate in ${placement.folderId}`,
        confidence: 'unresolved',
        location: placement.location,
        blockers: [
          {
            code: 'TECH_COORDINATE_EXPRESSION_UNSUPPORTED',
            message: 'The coordinate is not a numeric literal or resolvable file-local constant',
            location: placement.location,
          },
        ],
        details: {
          technologyId: placement.technologyId,
          folderId: placement.folderId,
          xExpression: placement.xExpression ?? null,
          yExpression: placement.yExpression ?? null,
        },
      });
      continue;
    }
    const key =
      placement.pixelX !== undefined && placement.pixelY !== undefined
        ? `${placement.folderId}\0pixel\0${placement.pixelX}\0${placement.pixelY}`
        : `${placement.folderId}\0${placement.branchRootId ?? '<ambiguous>'}\0${placement.x}\0${placement.y}`;
    const group = coordinateGroups.get(key) ?? [];
    group.push(placement);
    coordinateGroups.set(key, group);
  }
  for (const group of coordinateGroups.values()) {
    const technologyIds = [...new Set(group.map(({ technologyId }) => technologyId))];
    if (technologyIds.length < 2) continue;
    addIssue(issues, {
      code: 'TECH_FOLDER_COORDINATE_OVERLAP',
      classification: 'confirmed_error',
      severity: 'error',
      message: `Technologies ${technologyIds.join(', ')} overlap at one source coordinate in ${group[0]!.folderId}`,
      confidence: 'confirmed',
      location: group[0]!.location,
      related: group.slice(1).map(({ location }) => location),
      details: {
        folderId: group[0]!.folderId,
        x: group[0]!.x!,
        y: group[0]!.y!,
        pixelX: group[0]!.pixelX ?? null,
        pixelY: group[0]!.pixelY ?? null,
        technologyIds,
      },
    });
  }
  for (const [technologyId, techPlacements] of placementsByTech) {
    const byFolder = new Map<string, TechnologyPlacement[]>();
    for (const placement of techPlacements) {
      const group = byFolder.get(placement.folderId) ?? [];
      group.push(placement);
      byFolder.set(placement.folderId, group);
    }
    for (const group of byFolder.values()) {
      const coordinates = new Set(
        group.map(
          ({ x, y, xExpression, yExpression }) => `${x ?? xExpression}:${y ?? yExpression}`,
        ),
      );
      if (coordinates.size < 2) continue;
      addIssue(issues, {
        code: 'TECH_PLACEMENT_CONFLICT',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${technologyId} has conflicting placements in folder ${group[0]!.folderId}`,
        confidence: 'confirmed',
        location: group[0]!.location,
        related: group.slice(1).map(({ location }) => location),
        details: {
          technologyId,
          folderId: group[0]!.folderId,
          coordinates: [...coordinates].sort(compareCodeUnits),
        },
      });
    }
  }

  const gridboxById = new Map(gridboxes.map((gridbox) => [gridbox.id, gridbox]));
  for (const placement of placements) {
    if (placement.geometryStatus === 'source_pixel') continue;
    if (placement.branchRootId === undefined) {
      addIssue(issues, {
        code: 'TECH_GRIDBOX_BRANCH_AMBIGUOUS',
        classification: 'probable_defect',
        severity: 'warning',
        message: `Technology ${placement.technologyId} cannot be assigned to one source branch gridbox in ${placement.folderId}`,
        confidence: 'high',
        location: placement.location,
        details: { technologyId: placement.technologyId, folderId: placement.folderId },
      });
    } else if (placement.gridboxId === undefined) {
      addIssue(issues, {
        code: 'TECH_GRIDBOX_MISSING',
        classification: 'probable_defect',
        severity: 'warning',
        message: `Technology branch ${placement.branchRootId} has no matching ${placement.branchRootId}_tree gridbox in ${placement.folderId}`,
        confidence: 'high',
        location: placement.location,
        details: {
          technologyId: placement.technologyId,
          folderId: placement.folderId,
          branchRootId: placement.branchRootId,
        },
      });
    } else {
      const gridbox = gridboxById.get(placement.gridboxId);
      addIssue(issues, {
        code: 'TECH_GRIDBOX_GEOMETRY_UNRESOLVED',
        classification: 'unresolved_analysis',
        severity: 'warning',
        message: `Gridbox geometry for technology ${placement.technologyId} cannot be reduced to source pixel coordinates`,
        confidence: 'unresolved',
        location: gridbox?.location ?? placement.location,
        details: {
          technologyId: placement.technologyId,
          folderId: placement.folderId,
          gridbox: gridbox?.name ?? null,
          format: gridbox?.format ?? null,
        },
      });
    }
  }

  const roots = technologies
    .filter(({ id, hidden }) => hidden !== true && (incoming.get(id)?.length ?? 0) === 0)
    .map(({ id }) => id);
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of outgoing.get(current) ?? [])
      if (technologyById.has(edge.to)) pending.push(edge.to);
  }

  const grantIds = new Set(
    externalReferences.flatMap(({ technologyId, kind }) =>
      technologyId !== undefined && (kind === 'grant' || kind === 'starting_technology')
        ? [technologyId]
        : [],
    ),
  );
  const unlocksByTechnology = new Map<string, TechnologyUnlock[]>();
  for (const unlock of unlocks) {
    const group = unlocksByTechnology.get(unlock.technologyId) ?? [];
    group.push(unlock);
    unlocksByTechnology.set(unlock.technologyId, group);
  }
  for (const technology of technologies) {
    signal?.throwIfAborted();
    const techPlacements = placementsByTech.get(technology.id) ?? [];
    if (technology.hidden !== true && techPlacements.length > 0 && !reachable.has(technology.id)) {
      addIssue(issues, {
        code: 'TECH_VISIBLE_WITHOUT_ROOT_PATH',
        classification: 'probable_defect',
        severity: 'warning',
        message: `Visible technology ${technology.id} has no valid prerequisite path from a visible root`,
        confidence: 'high',
        location: technology.source.location,
        details: { technologyId: technology.id },
      });
    }
    if (
      (technology.hidden === true || techPlacements.length === 0) &&
      !grantIds.has(technology.id)
    ) {
      addIssue(issues, {
        code: 'TECH_HIDDEN_OR_UNPLACED_WITHOUT_GRANT',
        classification: 'design_warning',
        severity: 'warning',
        message: `Technology ${technology.id} is hidden or unplaced and has no discovered static grant path`,
        confidence: technology.hidden === 'unknown' ? 'medium' : 'high',
        location: technology.source.location,
        details: {
          technologyId: technology.id,
          hidden: technology.hidden,
          placementCount: techPlacements.length,
        },
      });
    }
    const directParents = (incoming.get(technology.id) ?? [])
      .map(({ from }) => technologyById.get(from))
      .filter(
        (value): value is TechnologyDefinition => value !== undefined && value.hidden !== true,
      );
    const year = Number(technology.startYear);
    const parentYears = directParents
      .map(({ startYear }) => Number(startYear))
      .filter(Number.isFinite);
    if (
      Number.isFinite(year) &&
      parentYears.length > 0 &&
      parentYears.every((parentYear) => year < parentYear)
    ) {
      addIssue(issues, {
        code: 'TECH_CHILD_EARLIER_THAN_PARENTS',
        classification: 'design_warning',
        severity: 'warning',
        message: `Technology ${technology.id} is dated earlier than every visible direct prerequisite`,
        confidence: 'high',
        location: technology.source.location,
        details: { technologyId: technology.id, startYear: year, parentYears },
      });
    }
    const coefficientEdges = (incoming.get(technology.id) ?? []).filter(
      ({ coefficient }) => coefficient !== undefined,
    );
    for (const edge of coefficientEdges) {
      const coefficient = Number(edge.coefficient);
      if (!Number.isFinite(coefficient) || (coefficient >= 0.1 && coefficient <= 5)) continue;
      addIssue(issues, {
        code: 'TECH_EDGE_COEFFICIENT_OUTLIER',
        classification: 'design_warning',
        severity: 'warning',
        message: `Prerequisite edge ${edge.from} -> ${edge.to} has unusual research coefficient ${edge.coefficient}`,
        confidence: 'high',
        location: edge.location,
        details: { from: edge.from, to: edge.to, coefficient: edge.coefficient! },
      });
    }
    const degree =
      (incoming.get(technology.id)?.length ?? 0) + (outgoing.get(technology.id)?.length ?? 0);
    const technologyUnlocks = unlocksByTechnology.get(technology.id) ?? [];
    if (technology.effectKeys.length === 0 && technologyUnlocks.length === 0 && degree === 0) {
      addIssue(issues, {
        code: 'TECH_NO_VISIBLE_ROLE',
        classification: 'design_warning',
        severity: 'warning',
        message: `Technology ${technology.id} has no visible effect, unlock, or routing role`,
        confidence: 'high',
        location: technology.source.location,
        details: { technologyId: technology.id },
      });
    } else if (
      technology.effectKeys.length === 0 &&
      technologyUnlocks.length === 0 &&
      (incoming.get(technology.id)?.length ?? 0) > 0 &&
      (outgoing.get(technology.id)?.length ?? 0) === 0
    ) {
      addIssue(issues, {
        code: 'TECH_TERMINAL_WITHOUT_VISIBLE_PAYOFF',
        classification: 'design_warning',
        severity: 'warning',
        message: `Terminal technology ${technology.id} has no visible effect or unlock`,
        confidence: 'high',
        location: technology.source.location,
        details: { technologyId: technology.id },
      });
    }
    if (technology.localisation.status === 'missing') {
      addIssue(issues, {
        code: 'TECH_LOCALISATION_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${technology.id} is missing English name or description localisation`,
        confidence: 'confirmed',
        location: technology.source.location,
        details: {
          technologyId: technology.id,
          nameKey: technology.localisation.nameKey,
          descriptionKey: technology.localisation.descriptionKey,
        },
      });
    }
    if (
      technology.icon.status === 'missing_sprite' ||
      technology.icon.status === 'missing_texture'
    ) {
      addIssue(issues, {
        code:
          technology.icon.status === 'missing_sprite'
            ? 'TECH_ICON_SPRITE_MISSING'
            : 'TECH_ICON_TEXTURE_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message:
          technology.icon.status === 'missing_sprite'
            ? `Technology ${technology.id} references missing sprite ${technology.icon.sprite}`
            : `Technology ${technology.id} cannot resolve texture for sprite ${technology.icon.sprite}`,
        confidence: 'confirmed',
        location: technology.source.location,
        details: {
          technologyId: technology.id,
          sprite: technology.icon.sprite,
          texturePath: technology.icon.texturePath ?? null,
        },
      });
    }
    for (const category of technology.categories) {
      if (categoryById.has(category)) continue;
      addIssue(issues, {
        code: 'TECH_CATEGORY_REFERENCE_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${technology.id} references missing category ${category}`,
        confidence: 'confirmed',
        location: technology.source.location,
        details: { technologyId: technology.id, categoryId: category },
      });
    }
    for (const tag of technology.tags) {
      if (categoryById.get(tag)?.kind === 'tag') continue;
      addIssue(issues, {
        code: 'TECH_TAG_REFERENCE_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Technology ${technology.id} references missing tag ${tag}`,
        confidence: 'confirmed',
        location: technology.source.location,
        details: { technologyId: technology.id, tagId: tag },
      });
    }
    const branchPeers = [
      ...new Set([
        ...(incoming.get(technology.id) ?? []).flatMap(({ from }) =>
          (outgoing.get(from) ?? []).map(({ to }) => to),
        ),
        ...(outgoing.get(technology.id) ?? []).flatMap(({ to }) =>
          (incoming.get(to) ?? []).map(({ from }) => from),
        ),
      ]),
    ]
      .filter((id) => id !== technology.id)
      .map((id) => technologyById.get(id))
      .filter((value): value is TechnologyDefinition => value !== undefined);
    if (
      technology.hidden !== true &&
      degree > 0 &&
      branchPeers.some(({ ai }) => ai.present && ai.zero !== true) &&
      (!technology.ai.present || technology.ai.zero === true)
    ) {
      addIssue(issues, {
        code: 'TECH_BRANCH_AI_COVERAGE_GAP',
        classification: 'design_warning',
        severity: 'warning',
        message: `Technology ${technology.id} has missing or zero AI willingness while adjacent branch peers have active AI metadata`,
        confidence: 'medium',
        location: technology.source.location,
        details: {
          technologyId: technology.id,
          aiPresent: technology.ai.present,
          aiZero: technology.ai.zero,
        },
      });
    }
  }

  for (const unlock of unlocks) {
    if (unlock.resolved !== false) continue;
    addIssue(issues, {
      code: 'TECH_UNLOCK_TARGET_MISSING',
      classification: 'confirmed_error',
      severity: 'error',
      message: `Technology ${unlock.technologyId} unlocks missing ${unlock.kind} ${unlock.targetId}`,
      confidence: 'confirmed',
      location: unlock.location,
      details: {
        technologyId: unlock.technologyId,
        targetKind: unlock.kind,
        targetId: unlock.targetId,
      },
    });
  }
  const technologiesByCategory = new Map<string, string[]>();
  for (const technology of technologies)
    for (const category of technology.categories) {
      const group = technologiesByCategory.get(category) ?? [];
      group.push(technology.id);
      technologiesByCategory.set(category, group);
    }
  for (const reference of externalReferences) {
    if (
      reference.technologyId !== undefined &&
      !technologyById.has(reference.technologyId) &&
      !reference.dynamic
    ) {
      addIssue(issues, {
        code:
          reference.kind === 'research_bonus'
            ? 'TECH_BONUS_TARGET_MISSING'
            : 'TECH_EXTERNAL_REFERENCE_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `${reference.sourceKind} ${reference.sourceId} references missing technology ${reference.technologyId}`,
        confidence: reference.confidence,
        location: reference.location,
        details: {
          sourceKind: reference.sourceKind,
          sourceId: reference.sourceId,
          technologyId: reference.technologyId,
          referenceKind: reference.kind,
        },
      });
    }
    if (
      reference.categoryId !== undefined &&
      !categoryById.has(reference.categoryId) &&
      !reference.dynamic
    ) {
      addIssue(issues, {
        code: 'TECH_EXTERNAL_CATEGORY_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `${reference.sourceKind} ${reference.sourceId} references missing technology category ${reference.categoryId}`,
        confidence: reference.confidence,
        location: reference.location,
        details: {
          sourceKind: reference.sourceKind,
          sourceId: reference.sourceId,
          categoryId: reference.categoryId,
          referenceKind: reference.kind,
        },
      });
    } else if (
      reference.kind === 'research_bonus' &&
      reference.categoryId !== undefined &&
      (technologiesByCategory.get(reference.categoryId)?.length ?? 0) === 0
    ) {
      addIssue(issues, {
        code: 'TECH_BONUS_CATEGORY_EMPTY',
        classification: 'probable_defect',
        severity: 'warning',
        message: `Research bonus category ${reference.categoryId} matches no indexed technology`,
        confidence: 'high',
        location: reference.location,
        details: {
          sourceKind: reference.sourceKind,
          sourceId: reference.sourceId,
          categoryId: reference.categoryId,
        },
      });
    }
  }

  for (const doctrine of doctrines) {
    if (doctrine.folderId !== undefined) {
      const folderExists = doctrines.some(
        ({ kind, id }) => kind === 'folder' && id === doctrine.folderId,
      );
      if (!folderExists)
        addIssue(issues, {
          code: 'TECH_DOCTRINE_FOLDER_MISSING',
          classification: 'confirmed_error',
          severity: 'error',
          message: `Doctrine ${doctrine.id} references missing doctrine folder ${doctrine.folderId}`,
          confidence: 'confirmed',
          location: doctrine.source.location,
          details: { doctrineId: doctrine.id, folderId: doctrine.folderId },
        });
    }
    for (const trackId of doctrine.trackIds) {
      if (doctrines.some(({ kind, id }) => kind === 'track' && id === trackId)) continue;
      addIssue(issues, {
        code: 'TECH_DOCTRINE_TRACK_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Doctrine ${doctrine.id} references missing doctrine track ${trackId}`,
        confidence: 'confirmed',
        location: doctrine.source.location,
        details: { doctrineId: doctrine.id, trackId },
      });
    }
    for (const exclusiveId of doctrine.exclusiveIds) {
      if (doctrines.some(({ id }) => id === exclusiveId)) continue;
      addIssue(issues, {
        code: 'TECH_DOCTRINE_EXCLUSIVE_TARGET_MISSING',
        classification: 'confirmed_error',
        severity: 'error',
        message: `Doctrine ${doctrine.id} references missing exclusive choice ${exclusiveId}`,
        confidence: 'confirmed',
        location: doctrine.source.location,
        details: { doctrineId: doctrine.id, targetId: exclusiveId },
      });
    }
  }

  const signatureGroups = new Map<string, TechnologyDefinition[]>();
  for (const technology of technologies) {
    if (
      technology.effectKeys.length === 0 &&
      (unlocksByTechnology.get(technology.id)?.length ?? 0) === 0
    )
      continue;
    const key = hashCanonical({
      signature: technology.effectSignature,
      year: technology.startYear ?? null,
      folders: technology.folders,
      categories: technology.categories,
    });
    const group = signatureGroups.get(key) ?? [];
    group.push(technology);
    signatureGroups.set(key, group);
  }
  for (const group of signatureGroups.values()) {
    if (group.length < 2) continue;
    addIssue(issues, {
      code: 'TECH_SUSPICIOUS_IDENTICAL_SIGNATURE',
      classification: 'design_warning',
      severity: 'warning',
      message: `Technologies ${group.map(({ id }) => id).join(', ')} have identical effects, unlocks, year, folders, and categories`,
      confidence: 'medium',
      location: group[0]!.source.location,
      related: group.slice(1).map(({ source }) => source.location),
      details: { technologyIds: group.map(({ id }) => id) },
    });
  }

  for (const item of unresolved) {
    addIssue(issues, {
      code: 'TECH_ANALYSIS_UNRESOLVED',
      classification: 'unresolved_analysis',
      severity: 'warning',
      message: `Static technology analysis could not resolve ${item.expression}`,
      confidence: item.confidence,
      ...(item.location === undefined ? {} : { location: item.location }),
      blockers: item.blockers,
      details: { unresolvedId: item.id, kind: item.kind, ownerId: item.ownerId ?? null },
    });
  }
  return stableIssues(issues);
}

function assertLimits(graph: {
  technologies: readonly unknown[];
  edges: readonly unknown[];
  externalReferences: readonly unknown[];
}): void {
  if (graph.technologies.length > MAX_TECHNOLOGIES)
    throw new ServiceError(
      'TECH_GRAPH_NODE_LIMIT',
      `Technology graph exceeds ${MAX_TECHNOLOGIES} technologies`,
    );
  if (graph.edges.length > MAX_EDGES)
    throw new ServiceError('TECH_GRAPH_EDGE_LIMIT', `Technology graph exceeds ${MAX_EDGES} edges`);
  if (graph.externalReferences.length > MAX_EXTERNAL_REFERENCES)
    throw new ServiceError(
      'TECH_GRAPH_REFERENCE_LIMIT',
      `Technology graph exceeds ${MAX_EXTERNAL_REFERENCES} external references`,
    );
}

function sourceHashes(files: readonly ScannedFile[]): Record<string, string> {
  return Object.fromEntries(
    files
      .filter(({ shadowedBy }) => shadowedBy === undefined)
      .map(({ displayPath, sha256 }) => [displayPath, sha256] as const)
      .sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

function helperCatalogFingerprint(snapshot: ScanSnapshot): string {
  return hashCanonical(
    snapshot.index
      .findAll('scripted_effect')
      .filter(({ overridden, sourceShadowed }) => !overridden && !sourceShadowed)
      .map(({ id, path }) => ({ id, path }))
      .sort(
        (left, right) =>
          compareCodeUnits(left.id, right.id) || compareCodeUnits(left.path, right.path),
      ),
  );
}

function fragmentsFor(
  snapshot: ScanSnapshot,
  options: TechnologyGraphBuildOptions,
): TechnologySourceFragment[] {
  const helperIds = new Set(
    snapshot.index
      .findAll('scripted_effect')
      .filter(({ overridden, sourceShadowed }) => !overridden && !sourceShadowed)
      .map(({ id }) => id),
  );
  const context: TechnologySourceAnalysisContext = {
    helperIds,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const fingerprint = helperCatalogFingerprint(snapshot);
  const fragments: TechnologySourceFragment[] = [];
  for (const file of technologySourceFiles(snapshot.files)) {
    options.signal?.throwIfAborted();
    const key = technologySourceFragmentCacheKey(file, fingerprint);
    let fragment = options.cache?.get(key);
    if (fragment === undefined) {
      fragment = analyzeTechnologySource(file, context);
      options.cache?.set(key, fragment, file.bytes.length);
    }
    fragments.push(fragment);
  }
  return fragments;
}

function resolveUnlocks(
  unlocks: readonly TechnologyUnlock[],
  targets: readonly TechnologyUnlockTarget[],
  complete: boolean,
): TechnologyUnlock[] {
  const keys = new Set(targets.map(({ kind, targetId }) => `${kind}:${targetId}`));
  return unlocks.map((unlock) => ({
    ...unlock,
    resolved: keys.has(`${unlock.kind}:${unlock.targetId}`) ? true : complete ? false : 'unknown',
  }));
}

export function buildTechnologyGraph(
  snapshot: ScanSnapshot,
  options: TechnologyGraphBuildOptions,
): TechnologyGraphSnapshot {
  options.signal?.throwIfAborted();
  const fragments = fragmentsFor(snapshot, options);
  const assets = assetMap(options.assetFiles ?? []);
  const selectedTechnologies = activeDefinitions(
    fragments.flatMap(({ technologies }) => technologies),
  );
  const technologies = localiseTechnologies(selectedTechnologies.active, snapshot.index, assets);
  const technologyById = new Map(technologies.map((technology) => [technology.id, technology]));
  const selectedFolders = activeDefinitions(fragments.flatMap(({ folders }) => folders));
  const folders = localiseFolders(selectedFolders.active, snapshot.index);
  const gridboxes = activeGridboxes(fragments.flatMap(({ gridboxes }) => gridboxes));
  const categories = activeCategories(fragments.flatMap(({ categories }) => categories));
  const selectedDoctrines = activeDefinitions(
    fragments.flatMap(({ doctrineDefinitions }) => doctrineDefinitions),
  );
  const doctrineDefinitions = localiseDoctrines(selectedDoctrines.active, snapshot.index, assets);
  const selectedTargets = activeDefinitions(
    fragments
      .flatMap(({ unlockTargets }) => unlockTargets)
      .filter(
        (
          target,
        ): target is TechnologyUnlockTarget & {
          source: NonNullable<TechnologyUnlockTarget['source']>;
        } => target.source !== undefined,
      ),
  );
  const unlockTargets = selectedTargets.active;
  const basePlacements = selectOwnedRecords(
    fragments.flatMap(({ placements }) => placements),
    ({ technologyId }) => technologyId,
    ({ location }) => location,
    technologyById,
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  const edges = selectOwnedRecords(
    fragments.flatMap(({ edges }) => edges),
    ({ from }) => from,
    ({ location }) => location,
    technologyById,
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  const placements = enrichPlacements(basePlacements, edges, gridboxes, options.signal);
  const unlocks = resolveUnlocks(
    selectOwnedRecords(
      fragments.flatMap(({ unlocks }) => unlocks),
      ({ technologyId }) => technologyId,
      ({ location }) => location,
      technologyById,
    ).sort((left, right) => compareCodeUnits(left.id, right.id)),
    unlockTargets,
    snapshot.complete,
  );
  const unresolved = fragments.flatMap(({ unresolved }) => unresolved);
  const helperCalls = fragments.flatMap(({ helperCalls }) => helperCalls);
  const externalReferences = expandHelperReferences(
    fragments.flatMap(({ externalReferences }) => externalReferences),
    helperCalls,
    unresolved,
    options.signal,
  );
  const issues = diagnose(
    technologies,
    folders,
    placements,
    gridboxes,
    edges,
    categories,
    doctrineDefinitions,
    unlocks,
    externalReferences,
    selectedTechnologies.duplicates.map((group) =>
      group.map(({ iconSprite, effectSignatureFields, ...technology }) => ({
        ...technology,
        icon: iconStatus(iconSprite, snapshot.index, assets),
        localisation: {
          language: 'l_english',
          nameKey: technology.id,
          descriptionKey: `${technology.id}_desc`,
          status: 'missing' as const,
        },
        effectSignature: hashCanonical(effectSignatureFields),
      })),
    ),
    unresolved,
    options.signal,
  );
  const allFiles = [...snapshot.files, ...(options.assetFiles ?? [])];
  const hashes = sourceHashes(allFiles);
  const revision = hashCanonical({
    scanRevision: snapshot.revision,
    sourceHashes: hashes,
    technologyIds: technologies.map(({ id }) => id),
  });
  const diagnostics: Diagnostic[] = sortDiagnostics([
    ...snapshot.diagnostics,
    ...technologyAnalysisDiagnostics(fragments),
  ]);
  const graph: TechnologyGraphSnapshot = {
    schemaVersion: TECHNOLOGY_GRAPH_SCHEMA_VERSION,
    parserVersion: TECHNOLOGY_PARSER_VERSION,
    workspaceId: snapshot.workspaceId,
    workspaceIdentity: options.workspaceIdentity,
    revision,
    complete: snapshot.complete && unresolved.every(({ kind }) => kind !== 'partial_source'),
    analysisBoundary: {
      staticAnalysis: true,
      language: 'l_english',
      loadOrder:
        'game -> dependencies -> active mod; same-path files are shadowed and duplicate active IDs are retained as diagnostics',
      generatedLayoutsLabelled: true,
      unsupportedConstructs: [
        'runtime-evaluated visibility and allow triggers',
        'meta-generated or variable technology identifiers',
        'exact AI research choice and runtime research time',
        'dynamic scripted localisation without supplied runtime values',
      ],
      assumptions: [
        'classic technology paths point from the defining technology to leads_to_tech',
        'GFX_<technology>_medium is the default technology icon sprite',
        'file-local @ constants are resolved only when they reduce to numeric literals',
      ],
    },
    sourceHashes: hashes,
    filesScanned: Object.keys(hashes).sort(compareCodeUnits),
    skippedSourceCount: snapshot.skippedSourceCount,
    skippedSources: snapshot.skippedSources,
    technologies,
    folders,
    placements,
    gridboxes,
    edges,
    categories,
    doctrineDefinitions,
    unlockTargets,
    unlocks,
    externalReferences,
    helperCalls: helperCalls.sort((left, right) => compareCodeUnits(left.id, right.id)),
    issues,
    diagnostics,
    unresolved: unresolved.sort((left, right) => compareCodeUnits(left.id, right.id)),
    statistics: {
      technologyCount: technologies.filter(({ kind }) => kind === 'technology').length,
      legacyDoctrineCount: technologies.filter(({ kind }) => kind === 'legacy_doctrine').length,
      folderCount: folders.length,
      placementCount: placements.length,
      gridboxCount: gridboxes.length,
      prerequisiteCount: edges.filter(({ kind }) => kind === 'prerequisite').length,
      exclusiveCount: edges.filter(({ kind }) => kind === 'exclusive').length,
      categoryCount: categories.length,
      doctrineDefinitionCount: doctrineDefinitions.length,
      unlockCount: unlocks.length,
      externalReferenceCount: externalReferences.length,
      issueCount: issues.length,
      unresolvedCount: unresolved.length,
    },
  };
  assertLimits(graph);
  options.signal?.throwIfAborted();
  return graph;
}

export function technologyAssetPatterns(graph: TechnologyGraphSnapshot): string[] {
  return [
    ...new Set(
      [
        ...graph.technologies.flatMap(({ icon }) => icon.texturePath ?? []),
        ...graph.doctrineDefinitions.flatMap(({ icon }) => icon?.texturePath ?? []),
      ]
        .map((value) =>
          value
            .replaceAll('\\', '/')
            .replace(/\/{2,}/gu, '/')
            .replace(/^\.\//u, ''),
        )
        .filter((value) => value.length > 0 && !value.includes('..') && !/[[\]{}*?!]/u.test(value)),
    ),
  ].sort(compareCodeUnits);
}

export function technologyGraphSourceFiles(
  snapshot: ScanSnapshot,
  assetFiles: readonly ScannedFile[] = [],
): ScannedFile[] {
  return [...technologySourceFiles(snapshot.files), ...assetFiles].sort((left, right) =>
    compareCodeUnits(left.displayPath, right.displayPath),
  );
}

export function technologyGraphRootKinds(graph: TechnologyGraphSnapshot): RootKind[] {
  const kinds = new Set<RootKind>();
  for (const technology of graph.technologies) kinds.add(technology.source.rootKind);
  for (const folder of graph.folders) kinds.add(folder.source.rootKind);
  return [...kinds].sort(compareCodeUnits);
}

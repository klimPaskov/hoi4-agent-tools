import sharp from 'sharp';
import { canonicalJson, compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import { RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import { DeterministicSvgTextRenderer } from '../core/svg-text.js';
import type { TechnologyGraphComparison } from './compare.js';
import { traceTechnology } from './queries.js';
import type { TechnologyGraphSnapshot, TechnologyPlacement } from './model.js';

export type TechnologyRenderView =
  | 'summary'
  | 'folder'
  | 'dependencies'
  | 'technology'
  | 'doctrine'
  | 'exclusive'
  | 'memberships'
  | 'bonuses'
  | 'grants'
  | 'unlocks'
  | 'metadata'
  | 'assets'
  | 'unresolved'
  | 'comparison';

export interface TechnologyRenderOptions {
  view: TechnologyRenderView;
  folderId?: string;
  technologyId?: string;
  categoryId?: string;
  targetId?: string;
  maxNodes?: number;
  includeHtml?: boolean;
  comparison?: TechnologyGraphComparison;
  budget?: RenderBudget;
  signal?: AbortSignal;
}

export interface TechnologyRenderBundle {
  view: TechnologyRenderView;
  graphRevision: string;
  selectedIds: string[];
  omittedNodeCount: number;
  sourceAccurate: boolean;
  generatedAnalysisLayout: boolean;
  width: number;
  height: number;
  json: string;
  svg: string;
  png: Buffer;
  html?: string;
  hashes: { json: string; svg: string; png: string; html?: string };
}

interface RenderNode {
  id: string;
  label: string;
  subtitle: string;
  kind:
    | 'technology'
    | 'legacy_doctrine'
    | 'folder'
    | 'category'
    | 'doctrine'
    | 'source'
    | 'unlock'
    | 'issue'
    | 'unresolved'
    | 'added'
    | 'removed';
  sourcePath?: string;
  sourceLine?: number;
  placement?: TechnologyPlacement;
}

interface RenderEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
}

interface PositionedNode extends RenderNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_RENDER_NODES = 2_000;
const NODE_WIDTH = 210;
const NODE_HEIGHT = 76;
const GAP_X = 42;
const GAP_Y = 42;
const GENERATED_NODE_WIDTH = 180;
const GENERATED_NODE_HEIGHT = 64;
const GENERATED_GAP = 24;
const GENERATED_LAYER_COLUMNS = 40;
const GENERATED_LAYER_ROWS = 32;
const GENERATED_BAND_GAP = 32;
const PADDING = 42;
const HEADER_HEIGHT = 86;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function technologyNode(
  graph: TechnologyGraphSnapshot,
  technologyId: string,
  placement?: TechnologyPlacement,
): RenderNode | undefined {
  const technology = graph.technologies.find(({ id }) => id === technologyId);
  if (technology === undefined) return undefined;
  return {
    id: technology.id,
    label: technology.localisation.name ?? technology.id,
    subtitle: [
      technology.startYear === undefined ? undefined : `year ${technology.startYear}`,
      technology.researchCost === undefined ? undefined : `cost ${technology.researchCost}`,
      technology.icon.status === 'resolved'
        ? undefined
        : technology.icon.status.replaceAll('_', ' '),
    ]
      .filter((value): value is string => value !== undefined)
      .join(' · '),
    kind: technology.kind,
    sourcePath: technology.source.path,
    sourceLine: technology.source.location.start.line,
    ...(placement === undefined ? {} : { placement }),
  };
}

function sortedUniqueNodes(values: readonly RenderNode[]): RenderNode[] {
  const result = new Map<string, RenderNode>();
  for (const value of values) if (!result.has(value.id)) result.set(value.id, value);
  return [...result.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function viewSelection(
  graph: TechnologyGraphSnapshot,
  options: TechnologyRenderOptions,
): {
  nodes: RenderNode[];
  edges: RenderEdge[];
  sourceAccurate: boolean;
  title: string;
  payload: Record<string, unknown>;
} {
  const nodes: RenderNode[] = [];
  const edges: RenderEdge[] = [];
  let title: string;
  let sourceAccurate = false;
  if (options.view === 'summary') {
    title = 'Technology workspace summary';
    for (const folder of graph.folders) {
      nodes.push({
        id: `folder:${folder.id}`,
        label: folder.localisation.name ?? folder.id,
        subtitle: `${graph.placements.filter(({ folderId }) => folderId === folder.id).length} placements${folder.doctrine ? ' · legacy doctrine' : ''}`,
        kind: 'folder',
        sourcePath: folder.source.path,
        sourceLine: folder.source.location.start.line,
      });
    }
    for (const folder of graph.doctrineDefinitions.filter(({ kind }) => kind === 'folder'))
      nodes.push({
        id: `doctrine-folder:${folder.id}`,
        label: folder.nameKey ?? folder.id,
        subtitle: 'modern doctrine folder',
        kind: 'doctrine',
        sourcePath: folder.source.path,
        sourceLine: folder.source.location.start.line,
      });
    for (const classification of [
      'confirmed_error',
      'probable_defect',
      'design_warning',
      'unresolved_analysis',
    ]) {
      const count = graph.issues.filter((issue) => issue.classification === classification).length;
      if (count > 0)
        nodes.push({
          id: `issues:${classification}`,
          label: classification.replaceAll('_', ' '),
          subtitle: `${count} findings`,
          kind: classification === 'unresolved_analysis' ? 'unresolved' : 'issue',
        });
    }
  } else if (options.view === 'folder') {
    if (options.folderId === undefined)
      throw new ServiceError('TECH_RENDER_FOLDER_REQUIRED', 'Folder rendering requires folderId');
    title = `Source folder layout · ${options.folderId}`;
    const placements = graph.placements.filter(({ folderId }) => folderId === options.folderId);
    if (placements.length === 0)
      throw new ServiceError(
        'TECH_RENDER_FOLDER_EMPTY',
        `Technology folder ${options.folderId} has no source placements`,
      );
    for (const placement of placements) {
      const node = technologyNode(graph, placement.technologyId, placement);
      if (node !== undefined) nodes.push(node);
    }
    const selected = new Set(nodes.map(({ id }) => id));
    edges.push(
      ...graph.edges
        .filter(({ from, to }) => selected.has(from) && selected.has(to))
        .map(({ id, from, to, kind }) => ({ id, from, to, kind })),
    );
    sourceAccurate = true;
  } else if (options.view === 'dependencies' || options.view === 'technology') {
    const ids =
      options.technologyId === undefined
        ? graph.technologies.map(({ id }) => id)
        : traceTechnology(graph, {
            technologyId: options.technologyId,
            direction: 'both',
            maxDepth: 64,
            maxNodes: options.maxNodes ?? 1_000,
            includeSubTechnologies: true,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }).nodes;
    title =
      options.technologyId === undefined
        ? 'Generated semantic dependency overview'
        : `Generated dependency view · ${options.technologyId}`;
    for (const id of ids) {
      const node = technologyNode(graph, id);
      if (node !== undefined) nodes.push(node);
    }
    const selected = new Set(ids);
    edges.push(
      ...graph.edges
        .filter(({ from, to }) => selected.has(from) && selected.has(to))
        .map(({ id, from, to, kind }) => ({ id, from, to, kind })),
    );
  } else if (options.view === 'doctrine') {
    title = 'Doctrine branches';
    for (const definition of graph.doctrineDefinitions.filter(
      ({ folderId, id }) =>
        options.folderId === undefined || folderId === options.folderId || id === options.folderId,
    ))
      nodes.push({
        id: `doctrine:${definition.kind}:${definition.id}`,
        label: definition.nameKey ?? definition.id,
        subtitle: `${definition.kind.replaceAll('_', ' ')}${definition.xpCost === undefined ? '' : ` · ${definition.xpCost} ${definition.xpType ?? 'xp'}`}`,
        kind: 'doctrine',
        sourcePath: definition.source.path,
        sourceLine: definition.source.location.start.line,
      });
    for (const definition of graph.doctrineDefinitions) {
      const from = `doctrine:${definition.kind}:${definition.id}`;
      if (!nodes.some(({ id }) => id === from)) continue;
      for (const trackId of definition.trackIds) {
        const target = graph.doctrineDefinitions.find(
          ({ kind, id }) => kind === 'track' && id === trackId,
        );
        if (target !== undefined)
          edges.push({
            id: `${from}:track:${trackId}`,
            from,
            to: `doctrine:track:${trackId}`,
            kind: 'track',
          });
      }
      if (definition.parentId !== undefined) {
        const parent = graph.doctrineDefinitions.find(({ id }) => id === definition.parentId);
        if (parent !== undefined)
          edges.push({
            id: `${from}:parent:${definition.parentId}`,
            from: `doctrine:${parent.kind}:${parent.id}`,
            to: from,
            kind: 'reward',
          });
      }
    }
    for (const technology of graph.technologies.filter(({ kind }) => kind === 'legacy_doctrine')) {
      const node = technologyNode(graph, technology.id);
      if (node !== undefined) nodes.push(node);
    }
  } else if (options.view === 'exclusive') {
    title = 'Exclusive technology and doctrine choices';
    const exclusiveEdges = graph.edges.filter(({ kind }) => kind === 'exclusive');
    const ids = new Set(exclusiveEdges.flatMap(({ from, to }) => [from, to]));
    for (const id of ids) {
      const node = technologyNode(graph, id);
      if (node !== undefined) nodes.push(node);
    }
    edges.push(...exclusiveEdges.map(({ id, from, to, kind }) => ({ id, from, to, kind })));
    for (const doctrine of graph.doctrineDefinitions.filter(
      ({ exclusiveIds }) => exclusiveIds.length > 0,
    )) {
      const from = `doctrine:${doctrine.kind}:${doctrine.id}`;
      nodes.push({
        id: from,
        label: doctrine.nameKey ?? doctrine.id,
        subtitle: doctrine.kind,
        kind: 'doctrine',
        sourcePath: doctrine.source.path,
        sourceLine: doctrine.source.location.start.line,
      });
      for (const targetId of doctrine.exclusiveIds) {
        const target = graph.doctrineDefinitions.find(({ id }) => id === targetId);
        const to =
          target === undefined ? `unresolved:${targetId}` : `doctrine:${target.kind}:${target.id}`;
        if (!nodes.some(({ id }) => id === to))
          nodes.push({
            id: to,
            label: target?.nameKey ?? targetId,
            subtitle: target?.kind ?? 'missing target',
            kind: target === undefined ? 'unresolved' : 'doctrine',
            ...(target === undefined
              ? {}
              : { sourcePath: target.source.path, sourceLine: target.source.location.start.line }),
          });
        edges.push({ id: `${from}:xor:${to}`, from, to, kind: 'exclusive' });
      }
    }
  } else if (options.view === 'memberships') {
    title = 'Technology category membership matrix';
    const categories = graph.categories.filter(
      ({ id }) => options.categoryId === undefined || id === options.categoryId,
    );
    for (const category of categories)
      nodes.push({
        id: `category:${category.id}`,
        label: category.localisation ?? category.id,
        subtitle: `${graph.technologies.filter(({ categories }) => categories.includes(category.id)).length} technologies`,
        kind: 'category',
        sourcePath: category.source.path,
        sourceLine: category.source.location.start.line,
      });
    for (const technology of graph.technologies) {
      const memberships = technology.categories.filter((category) =>
        categories.some(({ id }) => id === category),
      );
      if (memberships.length === 0) continue;
      const node = technologyNode(graph, technology.id);
      if (node !== undefined) nodes.push(node);
      for (const category of memberships)
        edges.push({
          id: `membership:${technology.id}:${category}`,
          from: `category:${category}`,
          to: technology.id,
          kind: 'membership',
        });
    }
  } else if (options.view === 'bonuses' || options.view === 'grants') {
    const referenceKinds =
      options.view === 'bonuses'
        ? new Set(['research_bonus', 'technology_sharing'])
        : new Set(['grant', 'starting_technology']);
    title =
      options.view === 'bonuses'
        ? 'Research bonus coverage'
        : 'External and starting technology grants';
    const references = graph.externalReferences.filter(
      ({ kind, technologyId, categoryId }) =>
        referenceKinds.has(kind) &&
        (options.technologyId === undefined || technologyId === options.technologyId) &&
        (options.categoryId === undefined || categoryId === options.categoryId),
    );
    for (const reference of references) {
      const sourceId = `source:${reference.sourceKind}:${reference.sourceId}`;
      if (!nodes.some(({ id }) => id === sourceId))
        nodes.push({
          id: sourceId,
          label: reference.sourceId,
          subtitle: reference.sourceKind.replaceAll('_', ' '),
          kind: 'source',
          sourcePath: reference.location.path,
          sourceLine: reference.location.start.line,
        });
      const targetId = reference.technologyId ?? `category:${reference.categoryId ?? '<dynamic>'}`;
      if (!nodes.some(({ id }) => id === targetId)) {
        const technology =
          reference.technologyId === undefined ? undefined : technologyNode(graph, targetId);
        nodes.push(
          technology ?? {
            id: targetId,
            label: reference.categoryId ?? reference.expression,
            subtitle: reference.dynamic ? 'dynamic unresolved target' : 'technology category',
            kind: reference.dynamic ? 'unresolved' : 'category',
          },
        );
      }
      edges.push({ id: reference.id, from: sourceId, to: targetId, kind: reference.kind });
    }
  } else if (options.view === 'unlocks') {
    title = 'Technology unlock impact';
    const unlocks = graph.unlocks.filter(
      ({ technologyId, targetId }) =>
        (options.technologyId === undefined || technologyId === options.technologyId) &&
        (options.targetId === undefined || targetId === options.targetId),
    );
    for (const unlock of unlocks) {
      const technology = technologyNode(graph, unlock.technologyId);
      if (technology !== undefined) nodes.push(technology);
      const targetId = `unlock:${unlock.kind}:${unlock.targetId}`;
      if (!nodes.some(({ id }) => id === targetId))
        nodes.push({
          id: targetId,
          label: unlock.targetId,
          subtitle: `${unlock.kind.replaceAll('_', ' ')}${unlock.resolved === false ? ' · missing' : ''}`,
          kind: unlock.resolved === false ? 'unresolved' : 'unlock',
        });
      edges.push({ id: unlock.id, from: unlock.technologyId, to: targetId, kind: 'unlocks' });
    }
  } else if (options.view === 'metadata') {
    title = 'Technology year, cost, and AI metadata';
    for (const technology of graph.technologies) {
      const node = technologyNode(graph, technology.id);
      if (node !== undefined)
        nodes.push({
          ...node,
          subtitle: `year ${technology.startYear ?? '?'} · cost ${technology.researchCost ?? '?'} · AI ${technology.ai.present ? (technology.ai.zero === true ? 'zero' : 'defined') : 'missing'}`,
        });
    }
    edges.push(
      ...graph.edges
        .filter(({ kind }) => kind === 'prerequisite')
        .map(({ id, from, to, kind }) => ({ id, from, to, kind })),
    );
  } else if (options.view === 'assets') {
    title = 'Technology icon and localisation coverage';
    for (const technology of graph.technologies.filter(
      ({ icon, localisation }) => icon.status !== 'resolved' || localisation.status !== 'resolved',
    )) {
      const node = technologyNode(graph, technology.id);
      if (node !== undefined)
        nodes.push({
          ...node,
          subtitle: `icon ${technology.icon.status.replaceAll('_', ' ')} · localisation ${technology.localisation.status}`,
          kind:
            technology.icon.status === 'partial' || technology.localisation.status === 'partial'
              ? 'unresolved'
              : 'issue',
        });
    }
  } else if (options.view === 'unresolved') {
    title = 'Unresolved technology analysis';
    for (const item of graph.unresolved)
      nodes.push({
        id: item.id,
        label: item.expression,
        subtitle: item.kind.replaceAll('_', ' '),
        kind: 'unresolved',
        ...(item.location === undefined
          ? {}
          : { sourcePath: item.location.path, sourceLine: item.location.start.line }),
      });
  } else {
    if (options.comparison === undefined)
      throw new ServiceError(
        'TECH_RENDER_COMPARISON_REQUIRED',
        'Comparison rendering requires a technology comparison',
      );
    title = 'Technology structural comparison';
    for (const id of options.comparison.technologies.added)
      nodes.push({ id: `added:${id}`, label: id, subtitle: 'technology added', kind: 'added' });
    for (const id of options.comparison.technologies.removed)
      nodes.push({
        id: `removed:${id}`,
        label: id,
        subtitle: 'technology removed',
        kind: 'removed',
      });
    for (const rename of options.comparison.technologies.renamed) {
      const from = `removed:${rename.beforeId}`;
      const to = `added:${rename.afterId}`;
      if (!nodes.some(({ id }) => id === from))
        nodes.push({
          id: from,
          label: rename.beforeId,
          subtitle: 'rename source',
          kind: 'removed',
        });
      if (!nodes.some(({ id }) => id === to))
        nodes.push({
          id: to,
          label: rename.afterId,
          subtitle: `rename candidate · ${rename.confidence}`,
          kind: 'added',
        });
      edges.push({
        id: `rename:${rename.beforeId}:${rename.afterId}`,
        from,
        to,
        kind: 'rename candidate',
      });
    }
    for (const issue of options.comparison.issues.introduced.slice(0, 200))
      nodes.push({
        id: `introduced:${issueKey(issue)}`,
        label: issue.code,
        subtitle: issue.message,
        kind: 'issue',
        ...(issue.location === undefined
          ? {}
          : { sourcePath: issue.location.path, sourceLine: issue.location.start.line }),
      });
  }
  const selectedNodes = sortedUniqueNodes(nodes);
  const selectedIds = new Set(selectedNodes.map(({ id }) => id));
  const selectedEdges = edges
    .filter(({ from, to }) => selectedIds.has(from) && selectedIds.has(to))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return {
    nodes: selectedNodes,
    edges: selectedEdges,
    sourceAccurate,
    title,
    payload: {
      view: options.view,
      title,
      sourceAccurate,
      generatedAnalysisLayout: !sourceAccurate,
      nodes: selectedNodes,
      edges: selectedEdges,
      graphRevision: graph.revision,
      analysisBoundary: graph.analysisBoundary,
    },
  };
}

function issueKey(issue: { code: string; details: Record<string, unknown> }): string {
  return sha256Bytes(canonicalJson({ code: issue.code, details: issue.details })).slice(0, 20);
}

function layoutFolder(nodes: readonly RenderNode[]): PositionedNode[] {
  const sourcePixel = nodes.filter(
    ({ placement }) => placement?.pixelX !== undefined && placement.pixelY !== undefined,
  );
  if (sourcePixel.length === nodes.length && sourcePixel.length > 0) {
    const minimumX = Math.min(...sourcePixel.map(({ placement }) => placement!.pixelX!));
    const minimumY = Math.min(...sourcePixel.map(({ placement }) => placement!.pixelY!));
    return sourcePixel.map((node) => ({
      ...node,
      x: PADDING + node.placement!.pixelX! - minimumX,
      y: HEADER_HEIGHT + PADDING + node.placement!.pixelY! - minimumY,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));
  }
  const branchRoots = [
    ...new Set(nodes.map(({ placement }) => placement?.branchRootId ?? '<unresolved>')),
  ].sort(compareCodeUnits);
  const lanes = new Map(branchRoots.map((id, index) => [id, index]));
  return nodes.map((node, index) => {
    const placement = node.placement;
    const lane = lanes.get(placement?.branchRootId ?? '<unresolved>') ?? 0;
    const x = PADDING + lane * 680 + (placement?.x ?? index % 3) * (NODE_WIDTH + GAP_X);
    const y =
      HEADER_HEIGHT + PADDING + (placement?.y ?? Math.floor(index / 3)) * (NODE_HEIGHT + GAP_Y);
    return { ...node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT };
  });
}

function layoutGenerated(
  nodes: readonly RenderNode[],
  edges: readonly RenderEdge[],
): PositionedNode[] {
  const ids = new Set(nodes.map(({ id }) => id));
  const incoming = new Map(nodes.map(({ id }) => [id, 0]));
  const outgoing = new Map(nodes.map(({ id }) => [id, [] as string[]]));
  const directionalEdges = edges.filter(
    ({ kind }) =>
      !kind.includes('exclusive') && kind !== 'membership' && kind !== 'rename candidate',
  );
  for (const edge of directionalEdges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const layer = new Map<string, number>();
  const pending = [...nodes]
    .filter(({ id }) => (incoming.get(id) ?? 0) === 0)
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  for (const id of pending) layer.set(id, 0);
  let cursor = 0;
  while (cursor < pending.length) {
    const current = pending[cursor++]!;
    for (const target of (outgoing.get(current) ?? []).sort(compareCodeUnits)) {
      layer.set(target, Math.max(layer.get(target) ?? 0, (layer.get(current) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) pending.push(target);
    }
  }
  for (const node of nodes) if (!layer.has(node.id)) layer.set(node.id, 0);
  const byLayer = new Map<number, RenderNode[]>();
  for (const node of nodes) {
    const depth = layer.get(node.id) ?? 0;
    const group = byLayer.get(depth) ?? [];
    group.push(node);
    byLayer.set(depth, group);
  }
  const result: PositionedNode[] = [];
  const orderedLayers = [...byLayer].sort(([left], [right]) => left - right);
  const visualColumns = orderedLayers.flatMap(([, group]) => {
    const ordered = group.sort((left, right) => compareCodeUnits(left.id, right.id));
    const chunks: RenderNode[][] = [];
    for (let offset = 0; offset < ordered.length; offset += GENERATED_LAYER_ROWS)
      chunks.push(ordered.slice(offset, offset + GENERATED_LAYER_ROWS));
    return chunks;
  });
  const bandHeights: number[] = [];
  for (const [columnIndex, group] of visualColumns.entries()) {
    const band = Math.floor(columnIndex / GENERATED_LAYER_COLUMNS);
    bandHeights[band] = Math.max(bandHeights[band] ?? 0, group.length);
  }
  const bandOffsets = bandHeights.map((_, band) =>
    bandHeights
      .slice(0, band)
      .reduce(
        (total, rows) =>
          total + rows * (GENERATED_NODE_HEIGHT + GENERATED_GAP) + GENERATED_BAND_GAP,
        0,
      ),
  );
  for (const [columnIndex, group] of visualColumns.entries()) {
    const band = Math.floor(columnIndex / GENERATED_LAYER_COLUMNS);
    const column = columnIndex % GENERATED_LAYER_COLUMNS;
    for (const [row, node] of group.entries())
      result.push({
        ...node,
        x: PADDING + column * (GENERATED_NODE_WIDTH + GENERATED_GAP),
        y:
          HEADER_HEIGHT +
          PADDING +
          (bandOffsets[band] ?? 0) +
          row * (GENERATED_NODE_HEIGHT + GENERATED_GAP),
        width: GENERATED_NODE_WIDTH,
        height: GENERATED_NODE_HEIGHT,
      });
  }
  return result;
}

function colours(kind: RenderNode['kind']): { fill: string; stroke: string } {
  return {
    technology: { fill: '#16324a', stroke: '#6bb9e8' },
    legacy_doctrine: { fill: '#352a4a', stroke: '#bd8bed' },
    folder: { fill: '#2d3c26', stroke: '#8fc86e' },
    category: { fill: '#3a351e', stroke: '#dbc55a' },
    doctrine: { fill: '#34254a', stroke: '#c294ef' },
    source: { fill: '#183d37', stroke: '#6bd5c3' },
    unlock: { fill: '#3a2e20', stroke: '#e2a75f' },
    issue: { fill: '#4a2828', stroke: '#ef7d7d' },
    unresolved: { fill: '#403b43', stroke: '#c6a8d3' },
    added: { fill: '#1e452d', stroke: '#6bdb91' },
    removed: { fill: '#4a2828', stroke: '#ef7d7d' },
  }[kind];
}

function svgFor(
  titleText: string,
  positioned: readonly PositionedNode[],
  edges: readonly RenderEdge[],
  sourceAccurate: boolean,
): { svg: string; width: number; height: number } {
  const maximumX = Math.max(PADDING + NODE_WIDTH, ...positioned.map(({ x, width }) => x + width));
  const maximumY = Math.max(
    HEADER_HEIGHT + NODE_HEIGHT,
    ...positioned.map(({ y, height }) => y + height),
  );
  const width = Math.ceil(maximumX + PADDING);
  const height = Math.ceil(maximumY + PADDING);
  if (width > 16_384 || height > 16_384 || width * height > RENDER_MAX_PIXELS)
    throw new ServiceError(
      'TECH_RENDER_DIMENSIONS_BLOCKED',
      'Technology render exceeds fixed dimensions',
      {
        width,
        height,
      },
    );
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const text = new DeterministicSvgTextRenderer();
  const edgeSvg = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) return [];
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const middle = (x1 + x2) / 2;
    const colour = edge.kind.includes('exclusive') ? '#e27878' : '#8298ad';
    const dash = edge.kind.includes('exclusive') ? ' stroke-dasharray="7 5"' : '';
    return `<path d="M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}" fill="none" stroke="${colour}" stroke-width="2" marker-end="url(#tech-arrow)"${dash}><title>${escapeXml(edge.kind)}</title></path>`;
  });
  const nodeSvg = positioned.map((node) => {
    const colour = colours(node.kind);
    const label = node.label.length > 34 ? `${node.label.slice(0, 31)}…` : node.label;
    const subtitle = node.subtitle.length > 48 ? `${node.subtitle.slice(0, 45)}…` : node.subtitle;
    const labelSvg = text.render(label, {
      x: node.x + 12,
      y: node.y + 30,
      fontSize: 15,
      fill: '#f1f5f8',
      weight: 600,
      targetWidth: Math.min(node.width - 24, Math.max(1, text.measure(label, 15))),
    });
    const subtitleSvg = text.render(subtitle, {
      x: node.x + 12,
      y: node.y + 56,
      fontSize: 11,
      fill: '#b8c4ce',
      targetWidth: Math.min(node.width - 24, Math.max(1, text.measure(subtitle, 11))),
    });
    return `<g data-node-id="${escapeXml(node.id)}"${node.sourcePath === undefined ? '' : ` data-source-path="${escapeXml(node.sourcePath)}" data-source-line="${node.sourceLine ?? 1}"`}><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="2"/><title>${escapeXml(`${node.id}${node.sourcePath === undefined ? '' : ` · ${node.sourcePath}:${node.sourceLine ?? 1}`}`)}</title>${labelSvg}${subtitleSvg}</g>`;
  });
  const title = text.render(titleText, {
    x: PADDING,
    y: 38,
    fontSize: 24,
    fill: '#f5f8fa',
    weight: 700,
  });
  const mode = text.render(
    sourceAccurate ? 'SOURCE-ACCURATE PLACEMENT' : 'GENERATED ANALYSIS LAYOUT',
    { x: PADDING, y: 66, fontSize: 12, fill: sourceAccurate ? '#79d29b' : '#e0b66b', weight: 600 },
  );
  return {
    width,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(titleText)}"><defs><marker id="tech-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8298ad"/></marker>${text.definitions()}</defs><rect width="100%" height="100%" fill="#0d1721"/>${title}${mode}<g>${edgeSvg.join('')}</g><g>${nodeSvg.join('')}</g></svg>`,
  };
}

function htmlFor(title: string, svg: string, json: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(title)}</title><style>html,body{margin:0;background:#0d1721;color:#f1f5f8;font-family:system-ui,sans-serif}main{padding:16px}details{margin-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111e29;padding:12px}</style></head><body><main>${svg}<details><summary>Authoritative JSON</summary><pre>${escapeXml(json)}</pre></details></main></body></html>`;
}

export async function renderTechnologyGraph(
  graph: TechnologyGraphSnapshot,
  options: TechnologyRenderOptions,
): Promise<TechnologyRenderBundle> {
  options.signal?.throwIfAborted();
  const maximum = Math.max(1, Math.min(options.maxNodes ?? 600, MAX_RENDER_NODES));
  const selection = viewSelection(graph, options);
  const retained = selection.nodes.slice(0, maximum);
  const retainedIds = new Set(retained.map(({ id }) => id));
  const edges = selection.edges.filter(
    ({ from, to }) => retainedIds.has(from) && retainedIds.has(to),
  );
  const positioned = selection.sourceAccurate
    ? layoutFolder(retained)
    : layoutGenerated(retained, edges);
  const rendered = svgFor(selection.title, positioned, edges, selection.sourceAccurate);
  const budget = options.budget ?? new RenderBudget();
  budget.reserve(rendered.width, rendered.height, `technology ${options.view} render`);
  budget.reserveRasterOperation(
    `technology-render:${graph.revision}:${options.view}:${sha256Bytes(rendered.svg)}`,
    `technology ${options.view} rasterization`,
  );
  const png = await sharp(Buffer.from(rendered.svg, 'utf8'), {
    limitInputPixels: RENDER_MAX_PIXELS,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  options.signal?.throwIfAborted();
  const json = `${canonicalJson({
    ...selection.payload,
    nodes: retained,
    edges,
    omittedNodeCount: Math.max(0, selection.nodes.length - retained.length),
    render: { width: rendered.width, height: rendered.height },
  })}\n`;
  const html =
    options.includeHtml === true ? htmlFor(selection.title, rendered.svg, json) : undefined;
  return {
    view: options.view,
    graphRevision: graph.revision,
    selectedIds: retained.map(({ id }) => id),
    omittedNodeCount: Math.max(0, selection.nodes.length - retained.length),
    sourceAccurate: selection.sourceAccurate,
    generatedAnalysisLayout: !selection.sourceAccurate,
    width: rendered.width,
    height: rendered.height,
    json,
    svg: rendered.svg,
    png,
    ...(html === undefined ? {} : { html }),
    hashes: {
      json: sha256Bytes(json),
      svg: sha256Bytes(rendered.svg),
      png: sha256Bytes(png),
      ...(html === undefined ? {} : { html: sha256Bytes(html) }),
    },
  };
}

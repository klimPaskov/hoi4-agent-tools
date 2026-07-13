import sharp from 'sharp';
import { canonicalJson, compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import { RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { DeterministicSvgTextRenderer } from '../core/svg-text.js';
import { eventFlowEdges, traceEventGraph } from './algorithms.js';
import { layoutEventGraph, type EventGraphLayout } from './layout.js';
import {
  discoverEventRoots,
  issueSubjectIds,
  selectEventNodes,
  type EventSelector,
} from './queries.js';
import type { EventGraphEdge, EventGraphNode, EventGraphSnapshot } from './model.js';

export type EventRenderView =
  | 'overview'
  | 'neighborhood'
  | 'options'
  | 'entries'
  | 'reachability'
  | 'timing'
  | 'state'
  | 'targets'
  | 'scope'
  | 'terminals'
  | 'unresolved';

export interface EventRenderOptions {
  view: EventRenderView;
  selector?: EventSelector;
  direction?: 'upstream' | 'downstream' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  expandHelpers?: boolean;
  includeHtml?: boolean;
  compactLayout?: boolean;
  budget?: RenderBudget;
  signal?: AbortSignal;
}

export interface EventRenderBundle {
  view: EventRenderView;
  graphRevision: string;
  selectedNodeIds: string[];
  omittedNodeCount: number;
  layout: EventGraphLayout;
  json: string;
  svg: string;
  png: Buffer;
  html?: string;
  hashes: { json: string; svg: string; png: string; html?: string };
}

const colours: Record<EventGraphNode['kind'], { fill: string; stroke: string }> = {
  event: { fill: '#17324d', stroke: '#62b0e8' },
  option: { fill: '#3b2d4f', stroke: '#c693ef' },
  entry: { fill: '#204638', stroke: '#66d2a2' },
  helper: { fill: '#40391f', stroke: '#d8bd54' },
  unresolved: { fill: '#522a2a', stroke: '#ef7f7f' },
  terminal: { fill: '#32363e', stroke: '#aeb7c4' },
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function kindPriority(kind: EventGraphNode['kind']): number {
  return { entry: 0, event: 1, option: 2, helper: 3, unresolved: 4, terminal: 5 }[kind];
}

function selectedByEdge(
  graph: EventGraphSnapshot,
  predicate: (edge: EventGraphEdge) => boolean,
): Set<string> {
  const result = new Set<string>();
  for (const edge of eventFlowEdges(graph, false).filter(predicate)) {
    result.add(edge.from);
    result.add(edge.to);
  }
  return result;
}

function boundedSelection(
  graph: EventGraphSnapshot,
  options: EventRenderOptions,
): { selected: Set<string>; omitted: number } {
  const maximum = Math.max(1, Math.min(options.maxNodes ?? 120, 240));
  const selected = new Set<string>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const flowEdges = eventFlowEdges(graph, options.expandHelpers ?? false);
  const add = (ids: Iterable<string>): void => {
    for (const id of ids) {
      if (selected.size >= maximum) break;
      if (byId.has(id)) selected.add(id);
    }
  };
  const selectorNodes =
    options.selector === undefined
      ? []
      : selectEventNodes(graph, options.selector, options.signal).map(({ id }) => id);
  let selectorTrace = new Set<string>();
  if (selectorNodes.length > 0) {
    const trace = traceEventGraph(
      graph,
      selectorNodes,
      {
        maxDepth: options.maxDepth ?? 4,
        maxNodes: maximum,
        maxEdges: maximum * 4,
        direction: options.direction ?? 'both',
        expandHelpers: options.expandHelpers ?? false,
      },
      options.signal,
    );
    selectorTrace = new Set(trace.nodes.map(({ id }) => id));
  }

  const withinSelector = (ids: Iterable<string>): string[] => {
    const values = [...new Set(ids)].sort(compareCodeUnits);
    return selectorTrace.size === 0 ? values : values.filter((id) => selectorTrace.has(id));
  };

  if (options.view === 'entries') {
    const roots = discoverEventRoots(graph, options.signal);
    const rootIds = withinSelector([
      ...roots.entryPoints.map(({ id }) => id),
      ...roots.automaticEvents.map(({ id }) => id),
    ]);
    add(rootIds);
    const retainedRoots = new Set(rootIds);
    add(
      flowEdges.filter(({ from }) => retainedRoots.has(from)).flatMap(({ from, to }) => [from, to]),
    );
  } else if (options.view === 'options') {
    const events = new Set(
      withinSelector(
        selectorNodes.length > 0
          ? selectorNodes
          : graph.nodes.filter(({ kind }) => kind === 'event').map(({ id }) => id),
      ),
    );
    const optionIds = graph.edges
      .filter(({ from, reason }) => events.has(from) && reason === 'option_branch')
      .map(({ to }) => to);
    add(
      graph.edges
        .filter(({ from, reason }) => events.has(from) && reason === 'option_branch')
        .flatMap(({ from, to }) => [from, to]),
    );
    const options = new Set(optionIds);
    add(flowEdges.filter(({ from }) => options.has(from)).flatMap(({ from, to }) => [from, to]));
  } else if (options.view === 'timing') {
    add(
      withinSelector(
        selectedByEdge(
          graph,
          ({ timing, weight }) =>
            (timing !== undefined && timing.mode !== 'immediate') || weight !== undefined,
        ),
      ),
    );
  } else if (options.view === 'state') {
    add(withinSelector(graph.stateAccesses.map(({ ownerId }) => ownerId)));
  } else if (options.view === 'targets') {
    add(
      withinSelector(
        graph.stateAccesses
          .filter(({ kind }) => kind.endsWith('event_target') || kind === 'saved_scope')
          .map(({ ownerId }) => ownerId),
      ),
    );
  } else if (options.view === 'scope') {
    add(withinSelector(selectedByEdge(graph, ({ scope }) => scope !== undefined)));
  } else if (options.view === 'terminals') {
    const terminals = withinSelector(
      graph.nodes.filter(({ kind }) => kind === 'terminal').map(({ id }) => id),
    );
    add(terminals);
    add(
      graph.edges.filter(({ to }) => terminals.includes(to)).flatMap(({ from, to }) => [from, to]),
    );
  } else if (options.view === 'unresolved') {
    const unresolved = withinSelector(
      graph.nodes.filter(({ kind }) => kind === 'unresolved').map(({ id }) => id),
    );
    add(unresolved);
    add(
      graph.edges.filter(({ to }) => unresolved.includes(to)).flatMap(({ from, to }) => [from, to]),
    );
  } else if (options.view === 'neighborhood' || options.view === 'reachability') {
    add(selectorTrace);
    if (options.view === 'reachability' && selectorTrace.size === 0) {
      const roots = discoverEventRoots(graph, options.signal);
      const rootIds = [
        ...roots.entryPoints.map(({ id }) => id),
        ...roots.automaticEvents.map(({ id }) => id),
      ];
      const trace = traceEventGraph(
        graph,
        rootIds,
        {
          maxDepth: options.maxDepth ?? 4,
          maxNodes: maximum,
          maxEdges: maximum * 4,
          direction: options.direction ?? 'downstream',
          expandHelpers: options.expandHelpers ?? false,
        },
        options.signal,
      );
      add(trace.nodes.map(({ id }) => id));
    }
  }

  // Context nodes make specialized projections readable without filling the
  // remaining budget with unrelated globally sorted nodes.
  let contextChanged = true;
  while (contextChanged && selected.size < maximum) {
    const before = selected.size;
    for (const edge of graph.edges) {
      if (edge.reason === 'option_branch' && selected.has(edge.to)) add([edge.from]);
      if (byId.get(edge.to)?.kind === 'helper' && selected.has(edge.to)) add([edge.from]);
      if (
        (byId.get(edge.to)?.kind === 'unresolved' || byId.get(edge.to)?.kind === 'terminal') &&
        selected.has(edge.to)
      ) {
        add([edge.from]);
      }
      if (byId.get(edge.from)?.kind === 'entry' && selected.has(edge.from)) add([edge.to]);
    }
    contextChanged = selected.size !== before;
  }

  if (options.view === 'overview') {
    add(selectorTrace);
    if (selected.size < maximum && options.selector === undefined) {
      const roots = discoverEventRoots(graph, options.signal);
      add(roots.entryPoints.map(({ id }) => id));
      add(roots.automaticEvents.map(({ id }) => id));
    }
    if (selected.size < maximum) add(withinSelector(graph.issues.flatMap(issueSubjectIds)));
    if (selected.size < maximum) {
      add(
        withinSelector(graph.nodes.filter(({ kind }) => kind === 'unresolved').map(({ id }) => id)),
      );
    }
    if (selected.size < maximum) {
      add(
        withinSelector(graph.nodes.filter(({ kind }) => kind === 'terminal').map(({ id }) => id)),
      );
    }
  }

  if (
    (options.view === 'overview' && options.selector === undefined) ||
    (options.view === 'neighborhood' && selectorNodes.length === 0)
  ) {
    add(
      [...graph.nodes]
        .sort(
          (left, right) =>
            kindPriority(left.kind) - kindPriority(right.kind) ||
            compareCodeUnits(left.id, right.id),
        )
        .map(({ id }) => id),
    );
  }
  return { selected, omitted: Math.max(0, graph.nodes.length - selected.size) };
}

function edgePath(points: EventGraphLayout['edges'][number]['points']): string {
  const [first, ...remaining] = points;
  if (first === undefined) return '';
  return `M ${first.x} ${first.y} ${remaining.map(({ x, y }) => `L ${x} ${y}`).join(' ')}`;
}

function timingSummary(edge: EventGraphEdge): string | undefined {
  const timing = edge.timing;
  const parts: string[] = [];
  if (timing !== undefined) {
    const values = [
      ['y', timing.years],
      ['h', timing.hours],
      ['d', timing.days],
      ['mo', timing.months],
      ['random h', timing.randomHours],
      ['random d', timing.randomDays],
      ['random mo', timing.randomMonths],
      ['date', timing.date],
    ] as const;
    const fields = values.flatMap(([label, value]) =>
      value === undefined ? [] : [`${label} ${value}`],
    );
    if (timing.mode === 'mean_time_to_happen') {
      parts.push(
        fields.length === 0
          ? `MTTH ${truncateLabel(timing.expression ?? 'unresolved', 32)}`
          : `MTTH ${fields.join(' + ')}`,
      );
    } else {
      parts.push(fields.length === 0 ? timing.mode : fields.join(' + '));
    }
  }
  if (edge.weight !== undefined) parts.push(`weight ${edge.weight.value}`);
  if (edge.conditions.length > 0) {
    const condition = edge.conditions[0]!;
    parts.push(
      `${condition.kind.replaceAll('_', ' ')}: ${truncateLabel(condition.expression, 32)}`,
    );
    if (edge.conditions.length > 1) parts.push(`+${edge.conditions.length - 1} guards`);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

function scopeSummary(edge: EventGraphEdge): string | undefined {
  if (edge.scope === undefined) return undefined;
  const expression =
    edge.scope.expression === undefined ? '' : ` via ${truncateLabel(edge.scope.expression, 28)}`;
  const guard =
    edge.conditions.length === 0 ? '' : ` · ${edge.conditions[0]!.kind.replaceAll('_', ' ')}`;
  return `${edge.scope.source} → ${edge.scope.destination}${expression}${guard}`;
}

function stateAccessSummary(
  graph: EventGraphSnapshot,
  nodeId: string,
  view: EventRenderView,
): string | undefined {
  if (view !== 'state' && view !== 'targets') return undefined;
  const accesses = graph.stateAccesses.filter(
    ({ ownerId, kind }) =>
      ownerId === nodeId &&
      (view !== 'targets' || kind.endsWith('event_target') || kind === 'saved_scope'),
  );
  const first = accesses[0];
  if (first === undefined) return undefined;
  const suffix = accesses.length > 1 ? ` +${accesses.length - 1}` : '';
  return `${first.access} ${first.kind.replaceAll('_', ' ')}:${first.name}${suffix}`;
}

function truncateLabel(value: string, maximum = 28): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function renderSvg(
  graph: EventGraphSnapshot,
  layout: EventGraphLayout,
  selectedNodeIds: ReadonlySet<string>,
  view: EventRenderView,
  omittedNodeCount: number,
): string {
  const text = new DeterministicSvgTextRenderer();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const placedById = new Map(layout.nodes.map((node) => [node.id, node]));
  const accessById = new Map(graph.stateAccesses.map((access) => [access.id, access]));
  const edges = layout.edges.map((placed) => {
    const edge = edgeById.get(placed.id);
    const removed = edge?.metadata.comparisonStatus === 'removed';
    const colour = removed ? '#ff6b78' : edge?.confidence === 'confirmed' ? '#8298ad' : '#d4a85e';
    const dashed = removed || edge?.confidence !== 'confirmed' ? ' stroke-dasharray="7 5"' : '';
    const sourceAttributes =
      edge === undefined
        ? ''
        : ` data-event-edge-reason="${edge.reason}" data-source-path="${escapeXml(edge.location.path)}" data-source-line="${edge.location.start.line}" data-source-column="${edge.location.start.column}"${removed ? ' data-comparison-status="removed"' : ''}`;
    const semantic =
      edge === undefined
        ? undefined
        : view === 'timing'
          ? timingSummary(edge)
          : view === 'scope'
            ? scopeSummary(edge)
            : undefined;
    const anchor = placed.points[Math.floor(placed.points.length / 2)];
    const label =
      semantic === undefined || anchor === undefined
        ? ''
        : text.render(truncateLabel(semantic, 72), {
            x: anchor.x + 5,
            y: anchor.y - 6,
            fontSize: 10,
            fill: '#f4d58d',
            weight: 600,
          });
    return `<g><path data-event-edge-id="${escapeXml(placed.id)}"${sourceAttributes} d="${edgePath(placed.points)}" fill="none" stroke="${colour}" stroke-width="2"${dashed} marker-end="url(#event-arrow)"/>${label}</g>`;
  });
  const stateLinks =
    view !== 'state' && view !== 'targets'
      ? []
      : graph.stateLinks.flatMap((link) => {
          const producer = accessById.get(link.producerId);
          const consumer = accessById.get(link.consumerId);
          if (producer === undefined || consumer === undefined) return [];
          if (
            view === 'targets' &&
            !link.stateKind.endsWith('event_target') &&
            link.stateKind !== 'saved_scope'
          )
            return [];
          const from = placedById.get(producer.ownerId);
          const to = placedById.get(consumer.ownerId);
          if (from === undefined || to === undefined) return [];
          const start = { x: from.x + from.width / 2, y: from.y + from.height };
          const end = { x: to.x + to.width / 2, y: to.y };
          const bend = Math.max(start.y, end.y) + 18;
          const points =
            producer.ownerId === consumer.ownerId
              ? [
                  start,
                  { x: from.x + from.width + 22, y: start.y + 18 },
                  { x: from.x + from.width + 22, y: from.y - 18 },
                  end,
                ]
              : [start, { x: start.x, y: bend }, { x: end.x, y: bend }, end];
          const anchor = points[Math.floor(points.length / 2)]!;
          const label = text.render(
            truncateLabel(`${link.stateKind.replaceAll('_', ' ')}:${link.name}`, 44),
            {
              x: anchor.x + 4,
              y: anchor.y - 4,
              fontSize: 9,
              fill: '#64e6bd',
              weight: 600,
            },
          );
          return [
            `<g data-event-state-link-id="${escapeXml(link.id)}"><path d="${edgePath(points)}" fill="none" stroke="#49cfa6" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#state-arrow)"/>${label}</g>`,
          ];
        });
  const nodes = layout.nodes.flatMap((placed) => {
    const node = byId.get(placed.id);
    if (node === undefined || !selectedNodeIds.has(node.id)) return [];
    const removed = node.metadata.comparisonStatus === 'removed';
    const colour = removed ? { fill: '#4b2027', stroke: '#ff6b78' } : colours[node.kind];
    const source = node.location;
    const attrs = [
      `data-event-node-id="${escapeXml(node.id)}"`,
      `data-event-node-kind="${node.kind}"`,
      ...(source === undefined
        ? []
        : [
            `data-source-path="${escapeXml(source.path)}"`,
            `data-source-line="${source.start.line}"`,
            `data-source-column="${source.start.column}"`,
          ]),
      ...(removed ? ['data-comparison-status="removed"'] : []),
    ].join(' ');
    const label = text.render(truncateLabel(node.label), {
      x: placed.x + 12,
      y: placed.y + 31,
      fontSize: 15,
      fill: '#f3f7fb',
      weight: 600,
      targetWidth: placed.width - 24,
    });
    const kind = text.render(node.kind, {
      x: placed.x + 12,
      y: placed.y + 55,
      fontSize: 11,
      fill: colour.stroke,
      weight: 500,
    });
    const stateSummary = stateAccessSummary(graph, node.id, view);
    const stateLabel =
      stateSummary === undefined
        ? ''
        : text.render(truncateLabel(stateSummary, 42), {
            x: placed.x + 12,
            y: placed.y + 68,
            fontSize: 8,
            fill: '#86e8c8',
            weight: 500,
          });
    return [
      `<g ${attrs}><rect x="${placed.x}" y="${placed.y}" width="${placed.width}" height="${placed.height}" rx="10" fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="2"/>${label}${kind}${stateLabel}</g>`,
    ];
  });
  const title = text.render(`Event chain · ${view}`, {
    x: 24,
    y: 28,
    fontSize: 17,
    fill: '#e9f2fb',
    weight: 700,
  });
  const summary = text.render(
    `${layout.nodes.length} shown · ${omittedNodeCount} omitted · ${layout.cyclicComponentCount} cyclic components`,
    { x: 24, y: layout.height - 14, fontSize: 11, fill: '#9eb0c2' },
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="HOI4 event chain ${escapeXml(view)}"><defs><marker id="event-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8298ad"/></marker><marker id="state-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#49cfa6"/></marker>${text.definitions()}</defs><rect width="100%" height="100%" fill="#0d1721"/>${title}<g>${edges.join('')}</g><g>${stateLinks.join('')}</g><g>${nodes.join('')}</g>${summary}</svg>`;
}

function htmlDocument(svg: string, json: string, view: EventRenderView): string {
  const escapedJson = json.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HOI4 event chain ${escapeXml(view)}</title><style>html,body{margin:0;background:#0d1721;color:#e9f2fb;font-family:system-ui,sans-serif}main{padding:16px;overflow:auto}svg{max-width:none}details{margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main>${svg}<details><summary>Authoritative JSON projection</summary><pre>${escapedJson}</pre></details></main></body></html>`;
}

export async function renderEventGraph(
  graph: EventGraphSnapshot,
  options: EventRenderOptions,
): Promise<EventRenderBundle> {
  options.signal?.throwIfAborted();
  const selection = boundedSelection(graph, options);
  const layout = layoutEventGraph(graph, selection.selected, {
    ...(options.expandHelpers === undefined ? {} : { expandHelpers: options.expandHelpers }),
    ...(options.compactLayout === undefined ? {} : { compact: options.compactLayout }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const selectedNodes = graph.nodes.filter(({ id }) => selection.selected.has(id));
  const selectedEdges = eventFlowEdges(graph, options.expandHelpers ?? false).filter(
    ({ from, to }) => selection.selected.has(from) && selection.selected.has(to),
  );
  const selectedState = graph.stateAccesses.filter(({ ownerId }) =>
    selection.selected.has(ownerId),
  );
  const selectedStateIds = new Set(selectedState.map(({ id }) => id));
  const selectedStateLinks = graph.stateLinks.filter(
    ({ producerId, consumerId }) =>
      selectedStateIds.has(producerId) && selectedStateIds.has(consumerId),
  );
  const selectedSourcePaths = new Set(
    selectedNodes.flatMap(({ sourcePath, location }) =>
      [sourcePath, location?.path].filter((value): value is string => value !== undefined),
    ),
  );
  const selectedUnresolved = graph.unresolved.filter(
    ({ id, ownerId, kind, location }) =>
      selection.selected.has(id) ||
      (ownerId !== undefined && selection.selected.has(ownerId)) ||
      (ownerId === undefined &&
        kind === 'partial_source' &&
        location !== undefined &&
        selectedSourcePaths.has(location.path)),
  );
  const json = `${canonicalJson({
    schemaVersion: 'event-render.v1',
    graphSchemaVersion: graph.schemaVersion,
    parserVersion: graph.parserVersion,
    workspaceId: graph.workspaceId,
    workspaceIdentity: graph.workspaceIdentity,
    view: options.view,
    graphRevision: graph.revision,
    sourceHashes: graph.sourceHashes,
    complete: graph.complete,
    filters: {
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      direction: options.direction ?? 'both',
      maxDepth: options.maxDepth ?? 4,
      maxNodes: options.maxNodes ?? 120,
      expandHelpers: options.expandHelpers ?? false,
      includeHtml: options.includeHtml ?? true,
      compactLayout: options.compactLayout ?? false,
    },
    selectedNodeIds: [...selection.selected].sort(compareCodeUnits),
    omittedNodeCount: selection.omitted,
    nodes: selectedNodes,
    edges: selectedEdges,
    stateAccesses: selectedState,
    stateLinks: selectedStateLinks,
    layout,
    unresolved: selectedUnresolved,
  })}\n`;
  const svg = renderSvg(graph, layout, selection.selected, options.view, selection.omitted);
  const budget = options.budget ?? new RenderBudget();
  budget.reserve(layout.width, layout.height, 'event chain render');
  budget.reserveRasterOperation(`event-chain:${sha256Bytes(svg)}`, 'event chain SVG rasterization');
  const png = await sharp(Buffer.from(svg, 'utf8'), { limitInputPixels: RENDER_MAX_PIXELS })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  options.signal?.throwIfAborted();
  const html = options.includeHtml === false ? undefined : htmlDocument(svg, json, options.view);
  return {
    view: options.view,
    graphRevision: graph.revision,
    selectedNodeIds: [...selection.selected].sort(compareCodeUnits),
    omittedNodeCount: selection.omitted,
    layout,
    json,
    svg,
    png,
    ...(html === undefined ? {} : { html }),
    hashes: {
      json: sha256Bytes(json),
      svg: sha256Bytes(svg),
      png: sha256Bytes(png),
      ...(html === undefined ? {} : { html: sha256Bytes(html) }),
    },
  };
}

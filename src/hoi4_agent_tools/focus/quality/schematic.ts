import sharp from 'sharp';
import { compareCodeUnits } from '../../core/canonical.js';
import { RENDER_MAX_PIXELS, type RenderBudget } from '../../core/render-budget.js';
import { DeterministicSvgTextRenderer } from '../../core/svg-text.js';
import {
  orthogonalConnector,
  ORTHOGONAL_PLAQUE_HEIGHT,
  ORTHOGONAL_PLAQUE_WIDTH,
} from './orthogonal.js';
import type { QualityGraph, QualityRegion } from './types.js';

/**
 * A no-icon schematic of a focus layout in the in-game connector model: right-angle connectors, a
 * plaque 1.6 columns wide and half a row high, red marks between exclusive choices and dotted
 * connectors for alternative prerequisites. It is cheap, and it draws what the metrics measure, so
 * an agent that looks at it judges the same picture the scorecard describes. It is a tool render,
 * never a game screenshot.
 */

/** Pixels per grid column and per row of the unscaled schematic. */
const COLUMN_PIXELS = 44;
const ROW_PIXELS = 88;
const MARGIN_COLUMNS = 1.5;
const MARGIN_ROWS = 0.75;
const MAXIMUM_UPSCALE = 1.5;
const BRANCH_FILL = [
  '#2f4b6e',
  '#3e5f45',
  '#6b4a3a',
  '#5a3f66',
  '#6a5a2e',
  '#2f5f63',
  '#6e3f4f',
  '#4d5a2e',
];
const SHARED_FILL = '#3a4150';
/** Largest encoded image the response carries; a bigger one is redrawn at a smaller scale. */
const IMAGE_BYTE_BUDGET = 700_000;

export type SchematicSeverity = 'blocked' | 'revise' | 'review';

export interface SchematicOptions {
  /** Grid region to show, inclusive. Defaults to the whole tree. */
  region?: QualityRegion;
  /** Focuses to outline: red for a hard defect, amber for a metric beyond the vanilla range. */
  highlight?: ReadonlyMap<string, SchematicSeverity>;
  /** Longest edge of the image in pixels. */
  maximumEdge?: number;
  title?: string;
  budget?: RenderBudget;
}

export interface SchematicImage {
  png: Buffer;
  width: number;
  height: number;
  region: QualityRegion;
}

export function treeRegion(graph: QualityGraph): QualityRegion {
  const xs = graph.nodes.map(({ x }) => x);
  const ys = graph.nodes.map(({ y }) => y);
  return {
    minimumX: Math.min(...xs),
    maximumX: Math.max(...xs),
    minimumY: Math.min(...ys),
    maximumY: Math.max(...ys),
  };
}

/** The region around a set of focuses with room for context, never smaller than a readable window. */
export function regionAround(
  graph: QualityGraph,
  focusIds: readonly string[],
  context = { columns: 3, rows: 1 },
  minimum = { columns: 14, rows: 3 },
): QualityRegion | undefined {
  const points = focusIds.flatMap((id) => {
    const point = graph.position.get(id);
    return point === undefined ? [] : [point];
  });
  if (points.length === 0) return undefined;
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  let region: QualityRegion = {
    minimumX: Math.min(...xs) - context.columns,
    maximumX: Math.max(...xs) + context.columns,
    minimumY: Math.min(...ys) - context.rows,
    maximumY: Math.max(...ys) + context.rows,
  };
  const widthShort = minimum.columns - (region.maximumX - region.minimumX);
  const heightShort = minimum.rows - (region.maximumY - region.minimumY);
  if (widthShort > 0)
    region = {
      ...region,
      minimumX: region.minimumX - Math.floor(widthShort / 2),
      maximumX: region.maximumX + Math.ceil(widthShort / 2),
    };
  if (heightShort > 0)
    region = {
      ...region,
      minimumY: region.minimumY - Math.floor(heightShort / 2),
      maximumY: region.maximumY + Math.ceil(heightShort / 2),
    };
  return region;
}

function labelLines(id: string): string[] {
  const parts = id.split('_');
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line === '' ? part : `${line}_${part}`;
    if (candidate.length <= 12 || line === '') line = candidate;
    else {
      lines.push(line);
      line = part;
    }
  }
  lines.push(line);
  const clipped = lines
    .slice(0, 2)
    .map((entry) => (entry.length > 13 ? `${entry.slice(0, 12)}…` : entry));
  if (lines.length > 2) clipped[1] = `${clipped[1]!.replace(/…$/u, '').slice(0, 11)}…`;
  return clipped;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

interface SchematicDocument {
  svg: (outputWidth: number, outputHeight: number) => string;
  width: number;
  height: number;
}

function schematicDocument(graph: QualityGraph, options: SchematicOptions): SchematicDocument {
  const region = options.region ?? treeRegion(graph);
  const columns = region.maximumX - region.minimumX;
  const rows = region.maximumY - region.minimumY;
  const width = Math.ceil((columns + 2 * MARGIN_COLUMNS) * COLUMN_PIXELS + 2 * 2);
  const height = Math.ceil((rows + ORTHOGONAL_PLAQUE_HEIGHT + 2 * MARGIN_ROWS) * ROW_PIXELS);
  const px = (x: number): number => (x - region.minimumX + MARGIN_COLUMNS) * COLUMN_PIXELS + 2;
  const py = (y: number): number => (y - region.minimumY + MARGIN_ROWS) * ROW_PIXELS;
  const plaqueWidth = ORTHOGONAL_PLAQUE_WIDTH * COLUMN_PIXELS;
  const plaqueHeight = ORTHOGONAL_PLAQUE_HEIGHT * ROW_PIXELS;
  const text = new DeterministicSvgTextRenderer();
  const branchColours = new Map<string, string>();
  for (const branch of new Set(graph.nodes.map(({ id }) => graph.branchOf.get(id) ?? ''))) {
    if (branch === '') continue;
    branchColours.set(branch, BRANCH_FILL[branchColours.size % BRANCH_FILL.length]!);
  }
  const inRegion = (x: number, y: number): boolean =>
    x >= region.minimumX - 2 &&
    x <= region.maximumX + 2 &&
    y >= region.minimumY - 2 &&
    y <= region.maximumY + 2;
  const parts: string[] = [];
  // Ruler: column numbers along the top, row numbers down the left, so a picture maps to coordinates.
  const rulerEvery = columns > 60 ? 8 : columns > 24 ? 4 : 2;
  for (
    let x = Math.ceil(region.minimumX / rulerEvery) * rulerEvery;
    x <= region.maximumX;
    x += rulerEvery
  )
    parts.push(
      text.render(String(x), { x: px(x), y: 11, fontSize: 9, fill: '#7d8aa0', anchor: 'middle' }),
      `<line x1="${px(x)}" y1="14" x2="${px(x)}" y2="${height}" stroke="#1b2536" stroke-width="1"/>`,
    );
  for (let y = region.minimumY; y <= region.maximumY; y += 1)
    parts.push(
      text.render(String(y), {
        x: 4,
        y: py(y) + plaqueHeight / 2 + 3,
        fontSize: 9,
        fill: '#7d8aa0',
      }),
    );
  // Connectors: stem down, bar just above the child's row, stem into the child.
  const connectors = graph.edges.map((edge) => {
    const parent = graph.position.get(edge.parent)!;
    const child = graph.position.get(edge.child)!;
    return {
      edge,
      connector: orthogonalConnector({ id: edge.parent, ...parent }, { id: edge.child, ...child }),
    };
  });
  parts.push('<g id="connectors" fill="none" stroke-linejoin="round">');
  for (const { edge, connector } of connectors) {
    if (
      !inRegion(connector.parentX, connector.parentY) &&
      !inRegion(connector.childX, connector.childY)
    )
      continue;
    const startY = py(connector.parentY) + plaqueHeight;
    const barY = py(connector.barY);
    const endY = py(connector.childY);
    const d = `M ${px(connector.parentX)} ${startY} V ${barY} H ${px(connector.childX)} V ${endY}`;
    parts.push(
      `<path d="${d}" stroke="${edge.or ? '#8ab4e8' : '#9aa6b8'}" stroke-width="2"${edge.or ? ' stroke-dasharray="3 4"' : ''} data-parent="${escapeXml(edge.parent)}" data-child="${escapeXml(edge.child)}"/>`,
    );
  }
  parts.push('</g>', '<g id="exclusions" fill="none" stroke="#e26d6d" stroke-width="2">');
  for (const [left, right] of graph.exclusions) {
    const a = graph.position.get(left)!;
    const b = graph.position.get(right)!;
    if (!inRegion(a.x, a.y) && !inRegion(b.x, b.y)) continue;
    const sameRow = a.y === b.y;
    const [first, second] = a.x <= b.x ? [a, b] : [b, a];
    if (sameRow) {
      const y = py(a.y) + plaqueHeight / 2;
      parts.push(
        `<line x1="${px(first.x) + plaqueWidth / 2}" y1="${y}" x2="${px(second.x) - plaqueWidth / 2}" y2="${y}" stroke-dasharray="4 3"/>`,
      );
    } else {
      parts.push(
        `<line x1="${px(a.x)}" y1="${py(a.y) + plaqueHeight / 2}" x2="${px(b.x)}" y2="${py(b.y) + plaqueHeight / 2}" stroke-dasharray="4 3"/>`,
      );
    }
  }
  parts.push('</g>', '<g id="plaques">');
  for (const node of graph.nodes) {
    if (!inRegion(node.x, node.y)) continue;
    const branch = graph.branchOf.get(node.id) ?? '';
    const fill = branchColours.get(branch) ?? SHARED_FILL;
    const severity = options.highlight?.get(node.id);
    const stroke =
      severity === 'blocked' ? '#ff5d5d' : severity === undefined ? '#6f7f99' : '#f0b85a';
    const x = px(node.x) - plaqueWidth / 2;
    const y = py(node.y);
    parts.push(
      `<rect x="${x}" y="${y}" width="${plaqueWidth}" height="${plaqueHeight}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="${severity === undefined ? 1.5 : 3.5}" data-focus-id="${escapeXml(node.id)}"/>`,
    );
    const lines = labelLines(node.id);
    for (const [index, line] of lines.entries())
      parts.push(
        text.render(line, {
          x: px(node.x),
          y: y + plaqueHeight / 2 + (lines.length === 1 ? 3 : index === 0 ? -3 : 9),
          fontSize: 9,
          fill: '#eef2f8',
          anchor: 'middle',
          targetWidth: Math.min(plaqueWidth - 6, text.measure(line, 9)),
        }),
      );
  }
  parts.push('</g>');
  if (options.title !== undefined)
    parts.push(text.render(options.title, { x: 28, y: height - 6, fontSize: 10, fill: '#aeb9c8' }));
  return {
    width,
    height,
    svg: (outputWidth, outputHeight) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}" role="img"><defs>${text.definitions()}</defs><rect width="100%" height="100%" fill="#0f1520"/>${parts.join('')}</svg>`,
  };
}

/**
 * Renders the layout, or one region of it, to a PNG whose longer edge is at most
 * `maximumEdge` pixels. A small region is enlarged up to 1.5 times so labels stay readable.
 */
export async function renderSchematicPng(
  graph: QualityGraph,
  options: SchematicOptions = {},
): Promise<SchematicImage> {
  const document = schematicDocument(graph, options);
  const maximumEdge = options.maximumEdge ?? 1500;
  let scale = Math.min(MAXIMUM_UPSCALE, maximumEdge / Math.max(document.width, document.height));
  for (let attempt = 0; ; attempt += 1) {
    const width = Math.max(1, Math.round(document.width * scale));
    const height = Math.max(1, Math.round(document.height * scale));
    options.budget?.reserve(width, height, 'focus schematic PNG');
    const png = await sharp(Buffer.from(document.svg(width, height), 'utf8'), {
      limitInputPixels: RENDER_MAX_PIXELS,
    })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    if (png.length <= IMAGE_BYTE_BUDGET || attempt >= 3)
      return { png, width, height, region: options.region ?? treeRegion(graph) };
    scale *= 0.7;
  }
}

export interface InlineImagePlan {
  kind: 'overview' | 'branch' | 'focus' | 'problem';
  label: string;
  focusIds: string[];
  region: QualityRegion;
}

/** Inline image count for one response; the first is always the overview. */
export const INLINE_IMAGE_LIMIT = 6;

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

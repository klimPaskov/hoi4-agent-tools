import sharp from 'sharp';
import {
  boundedSourceHashEvidence,
  type ArtifactStore,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import { compareCodeUnits, canonicalJson, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import {
  assertRenderDimensions,
  RenderBudget,
  RENDER_MAX_DECODED_PIXELS,
  RENDER_MAX_ENCODED_IMAGE_BYTES,
  RENDER_MAX_PIXELS,
} from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import { DeterministicSvgTextRenderer } from '../core/svg-text.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import { compileFocusTreeWithSourceMap } from './compiler.js';
import {
  FOCUS_HORIZONTAL_GRID_PIXELS,
  FOCUS_NODE_HEIGHT_PIXELS,
  FOCUS_NODE_WIDTH_PIXELS,
  FOCUS_VERTICAL_GRID_PIXELS,
  focusConnectorCurve,
  focusConnectorSvgPath,
  focusNodeOrigin,
} from './geometry.js';
import { createFocusPlanningSidecar, serializeFocusPlanningSidecar } from './planning.js';
import { FOCUS_GRAPH_MAX_EDGES, FOCUS_GRAPH_MAX_NODES } from './lint.js';
import {
  layoutNodeMap,
  type FocusGeneratedSourceMap,
  type FocusLayoutResult,
  type FocusPresentationResolution,
  type FocusTreePlan,
} from './model.js';

export const FOCUS_RENDER_MIN_OUTPUT_SCALE = 0.25;
export const FOCUS_RENDER_MAX_OUTPUT_SCALE = 1;

export interface FocusRenderOptions {
  horizontalSpacing?: number;
  verticalSpacing?: number;
  padding?: number;
  /** Uniform raster-output scale; the logical SVG geometry and source coordinates are unchanged. */
  outputScale?: number;
  iconDataUris?: Readonly<Record<string, string>>;
  presentation?: FocusPresentationResolution;
  sourceHashes?: Record<string, string>;
  renderProfile?: Record<string, unknown>;
  budget?: RenderBudget;
  signal?: AbortSignal;
}

export interface FocusRenderBundle {
  html: string;
  svg: string;
  png: Buffer;
  json: string;
  hashes: { html: string; svg: string; png: string; json: string };
  sourceMap: FocusGeneratedSourceMap;
  width: number;
  height: number;
}

export async function admitFocusIconDataUris(
  options: Pick<FocusRenderOptions, 'iconDataUris' | 'presentation'>,
  budget: RenderBudget,
  renderedDataUris?: readonly string[],
): Promise<void> {
  const declaredDataUris = [
    ...Object.values(options.iconDataUris ?? {}),
    ...Object.values(options.presentation?.icons ?? {}).map(({ dataUri }) => dataUri),
  ];
  const occurrences = renderedDataUris ?? declaredDataUris;
  const dataUris = new Set([...declaredDataUris, ...occurrences]);
  if (dataUris.size > FOCUS_GRAPH_MAX_NODES) {
    throw new ServiceError(
      'FOCUS_RENDER_ICON_BUDGET_BLOCKED',
      'Focus render exceeds the fixed distinct icon asset ceiling',
      { icons: dataUris.size, maximumIcons: FOCUS_GRAPH_MAX_NODES },
    );
  }
  let totalUriCharacters = 0;
  let totalDecodedBytes = 0;
  const dimensions = new Map<string, { width: number; height: number }>();
  const decodedDimensions = new Map<string, { width: number; height: number }>();
  for (const [index, dataUri] of [...dataUris].entries()) {
    if (dataUri.length > RENDER_MAX_ENCODED_IMAGE_BYTES * 2) {
      throw new ServiceError(
        'RENDER_ASSET_BYTES_BLOCKED',
        'Focus icon data URI exceeds the fixed encoded-byte ceiling',
        {
          index,
          encodedCharacters: dataUri.length,
          maximumBytes: RENDER_MAX_ENCODED_IMAGE_BYTES,
        },
      );
    }
    if (dataUri.length > RENDER_MAX_ENCODED_IMAGE_BYTES * 2 - totalUriCharacters) {
      throw new ServiceError(
        'RENDER_ASSET_AGGREGATE_BYTES_BLOCKED',
        'Focus icon data URIs exceed the fixed aggregate encoded-character ceiling',
        {
          index,
          totalUriCharacters,
          requestedCharacters: totalUriCharacters + dataUri.length,
          maximumCharacters: RENDER_MAX_ENCODED_IMAGE_BYTES * 2,
        },
      );
    }
    totalUriCharacters += dataUri.length;
    const match = /^data:image\/(?:png|jpeg|webp)(?:;(base64))?,(.*)$/isu.exec(dataUri);
    if (match === null) {
      throw new ServiceError(
        'RENDER_ASSET_DATA_URI_BLOCKED',
        'Focus icon must be an embedded static PNG, JPEG, or WebP data URI',
        { index },
      );
    }
    const encoded = match[2] ?? '';
    if (encoded.length > RENDER_MAX_ENCODED_IMAGE_BYTES * 2) {
      throw new ServiceError(
        'RENDER_ASSET_BYTES_BLOCKED',
        'Focus icon data URI exceeds the fixed encoded-byte ceiling',
        { index, encodedCharacters: encoded.length, maximumBytes: RENDER_MAX_ENCODED_IMAGE_BYTES },
      );
    }
    let bytes: Buffer;
    try {
      bytes =
        match[1] === 'base64'
          ? Buffer.from(encoded, 'base64')
          : Buffer.from(decodeURIComponent(encoded), 'utf8');
    } catch {
      throw new ServiceError(
        'RENDER_ASSET_DECODE_BLOCKED',
        'Focus icon data URI contains malformed encoded data',
        { index },
      );
    }
    if (bytes.length > RENDER_MAX_ENCODED_IMAGE_BYTES) {
      throw new ServiceError(
        'RENDER_ASSET_BYTES_BLOCKED',
        'Focus icon data URI exceeds the fixed decoded-byte ceiling',
        { index, bytes: bytes.length, maximumBytes: RENDER_MAX_ENCODED_IMAGE_BYTES },
      );
    }
    if (bytes.length > RENDER_MAX_ENCODED_IMAGE_BYTES - totalDecodedBytes) {
      throw new ServiceError(
        'RENDER_ASSET_AGGREGATE_BYTES_BLOCKED',
        'Focus icon data URIs exceed the fixed aggregate decoded-byte ceiling',
        {
          index,
          totalDecodedBytes,
          requestedBytes: totalDecodedBytes + bytes.length,
          maximumBytes: RENDER_MAX_ENCODED_IMAGE_BYTES,
        },
      );
    }
    totalDecodedBytes += bytes.length;
    const decodeHash = sha256Bytes(bytes);
    budget.reserveRasterOperation(`focus-icon:${decodeHash}`, `focus icon decode ${index}`);
    const existingDimensions = decodedDimensions.get(decodeHash);
    if (existingDimensions !== undefined) {
      dimensions.set(dataUri, existingDimensions);
      continue;
    }
    try {
      const metadata = await sharp(bytes, {
        limitInputPixels: RENDER_MAX_DECODED_PIXELS,
      }).metadata();
      if (metadata.pages !== undefined && metadata.pages > 1) {
        throw new ServiceError(
          'RENDER_ASSET_PAGES_BLOCKED',
          'Focus icon data URI must contain exactly one static image page',
          { index, pages: metadata.pages },
        );
      }
      const admitted = assertRenderDimensions(
        metadata.width,
        metadata.height,
        `focus icon ${index}`,
        {
          maximumPixels: RENDER_MAX_DECODED_PIXELS,
        },
      );
      dimensions.set(dataUri, admitted);
      decodedDimensions.set(decodeHash, admitted);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        'RENDER_ASSET_DECODE_BLOCKED',
        'Focus icon data URI cannot be decoded within the fixed image budget',
        { index, maximumPixels: RENDER_MAX_DECODED_PIXELS },
      );
    }
  }
  for (const [index, dataUri] of occurrences.entries()) {
    const admitted = dimensions.get(dataUri);
    if (admitted === undefined) {
      throw new ServiceError(
        'RENDER_ASSET_DECODE_BLOCKED',
        'Rendered focus icon was not admitted before SVG rasterization',
        { index },
      );
    }
    budget.reserve(admitted.width, admitted.height, `rendered focus icon ${index}`, {
      maximumPixels: RENDER_MAX_DECODED_PIXELS,
    });
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function safeArtifactStem(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^[_-]+/u, '')
    .slice(0, 80);
  return safe.length === 0 ? 'focus-tree' : safe;
}

function focusIdForDiagnostic(diagnostic: Diagnostic): string | undefined {
  if (diagnostic.location?.symbol !== undefined) return diagnostic.location.symbol;
  const detail = diagnostic.details?.focusId;
  return typeof detail === 'string' ? detail : undefined;
}

function diagnosticLabel(diagnostic: Diagnostic): string {
  const location = diagnostic.location;
  const suffix =
    location === undefined
      ? ''
      : ` (${location.path}:${location.start.line}:${location.start.column})`;
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${suffix}`;
}

function focusIconDataUri(
  focus: FocusTreePlan['focuses'][number],
  options: Pick<FocusRenderOptions, 'iconDataUris' | 'presentation'>,
): string | undefined {
  const icon = focus.icons[0];
  return icon === undefined
    ? undefined
    : (options.presentation?.icons[icon.sprite]?.dataUri ?? options.iconDataUris?.[icon.sprite]);
}

function svgDocument(
  plan: FocusTreePlan,
  layout: FocusLayoutResult,
  diagnostics: readonly Diagnostic[],
  options: FocusRenderOptions,
): { svg: string; width: number; height: number; graph: Record<string, unknown> } {
  const horizontal = options.horizontalSpacing ?? FOCUS_HORIZONTAL_GRID_PIXELS;
  const vertical = options.verticalSpacing ?? FOCUS_VERTICAL_GRID_PIXELS;
  const padding = options.padding ?? 80;
  const outputScale = options.outputScale ?? 1;
  if (
    !Number.isFinite(outputScale) ||
    outputScale < FOCUS_RENDER_MIN_OUTPUT_SCALE ||
    outputScale > FOCUS_RENDER_MAX_OUTPUT_SCALE
  ) {
    throw new ServiceError(
      'FOCUS_RENDER_SCALE_INVALID',
      `Focus render output scale must be between ${FOCUS_RENDER_MIN_OUTPUT_SCALE} and ${FOCUS_RENDER_MAX_OUTPUT_SCALE}`,
      {
        outputScale: Number.isFinite(outputScale) ? outputScale : String(outputScale),
        minimumOutputScale: FOCUS_RENDER_MIN_OUTPUT_SCALE,
        maximumOutputScale: FOCUS_RENDER_MAX_OUTPUT_SCALE,
      },
    );
  }
  const nodeWidth = FOCUS_NODE_WIDTH_PIXELS;
  const nodeHeight = FOCUS_NODE_HEIGHT_PIXELS;
  const nodes = [...layout.nodes].sort((left, right) => compareCodeUnits(left.id, right.id));
  const minimumX = Math.min(0, ...nodes.map(({ x }) => x));
  const minimumY = Math.min(0, ...nodes.map(({ y }) => y));
  const maximumX = Math.max(0, ...nodes.map(({ x }) => x));
  const maximumY = Math.max(0, ...nodes.map(({ y }) => y));
  const logicalWidth = Math.max(320, (maximumX - minimumX) * horizontal + nodeWidth + padding * 2);
  const logicalHeight = Math.max(240, (maximumY - minimumY) * vertical + nodeHeight + padding * 2);
  const width = Math.max(1, Math.round(logicalWidth * outputScale));
  const height = Math.max(1, Math.round(logicalHeight * outputScale));
  (options.budget ?? new RenderBudget()).reserve(width, height, 'focus tree PNG');
  const pixel = new Map(
    nodes.map((node) => [
      node.id,
      focusNodeOrigin(node, minimumX, minimumY, padding, horizontal, vertical),
    ]),
  );
  const layoutNodes = new Map(nodes.map((node) => [node.id, node]));
  const focusMap = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const diagnosticMap = new Map<string, Diagnostic[]>();
  const toolText = new DeterministicSvgTextRenderer();
  for (const diagnostic of diagnostics) {
    const focusId = focusIdForDiagnostic(diagnostic);
    if (focusId === undefined) continue;
    const group = diagnosticMap.get(focusId) ?? [];
    group.push(diagnostic);
    diagnosticMap.set(focusId, group);
  }

  const prerequisiteEdges = plan.focuses
    .flatMap((focus) =>
      focus.prerequisites.groups.flatMap((group, groupIndex) =>
        group.focusIds.map((parentId) => ({ parentId, childId: focus.id, groupIndex })),
      ),
    )
    .filter(({ parentId, childId }) => pixel.has(parentId) && pixel.has(childId))
    .sort(
      (left, right) =>
        compareCodeUnits(left.parentId, right.parentId) ||
        compareCodeUnits(left.childId, right.childId) ||
        left.groupIndex - right.groupIndex,
    );
  const exclusionEdges = plan.focuses
    .flatMap((focus) => focus.mutuallyExclusive.map((other) => [focus.id, other] as const))
    .filter(
      ([left, right]) => pixel.has(left) && pixel.has(right) && compareCodeUnits(left, right) < 0,
    )
    .sort((left, right) => compareCodeUnits(left.join('\0'), right.join('\0')));

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${logicalWidth} ${logicalHeight}" role="img" aria-labelledby="title description">`,
    `<title id="title">${escapeXml(plan.id)} focus tree</title>`,
    `<desc id="description">Offline HOI4 Agent Tools representation. ${plan.focuses.length} focuses.</desc>`,
    '<defs>',
    '__DETERMINISTIC_FONT_DEFINITIONS__',
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8da2bc"/></marker>',
    '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/></filter>',
    '</defs>',
    '<rect width="100%" height="100%" fill="#111723"/>',
    toolText.render(plan.id, { x: padding, y: 36, fontSize: 22, weight: 700, fill: '#e8edf5' }),
    toolText.render(`Offline agent render · layout ${layout.layoutHash.slice(0, 12)}`, {
      x: padding,
      y: 58,
      fontSize: 12,
      fill: '#95a4b8',
    }),
    '<g id="prerequisites">',
  ];
  for (const edge of prerequisiteEdges) {
    const parent = layoutNodes.get(edge.parentId);
    const child = layoutNodes.get(edge.childId);
    if (parent === undefined || child === undefined) continue;
    const curve = focusConnectorCurve(parent, child, {
      horizontalSpacing: horizontal,
      verticalSpacing: vertical,
      nodeWidth,
      nodeHeight,
      originX: padding - minimumX * horizontal,
      originY: padding - minimumY * vertical,
    });
    parts.push(
      `<path d="${focusConnectorSvgPath(curve)}" fill="none" stroke="#8da2bc" stroke-width="2" marker-end="url(#arrow)" data-parent="${escapeXml(edge.parentId)}" data-child="${escapeXml(edge.childId)}" data-prerequisite-group="${edge.groupIndex}"/>`,
    );
  }
  parts.push('</g>', '<g id="mutual-exclusions">');
  for (const [leftId, rightId] of exclusionEdges) {
    const left = pixel.get(leftId);
    const right = pixel.get(rightId);
    if (left === undefined || right === undefined) continue;
    parts.push(
      `<line x1="${left.x + nodeWidth / 2}" y1="${left.y + nodeHeight / 2}" x2="${right.x + nodeWidth / 2}" y2="${right.y + nodeHeight / 2}" stroke="#e76f75" stroke-width="2" stroke-dasharray="7 5" data-mutual-left="${escapeXml(leftId)}" data-mutual-right="${escapeXml(rightId)}"/>`,
    );
  }
  parts.push('</g>', '<g id="focus-nodes">');
  for (const node of nodes) {
    const focus = focusMap.get(node.id);
    if (focus === undefined) continue;
    const point = pixel.get(node.id);
    if (point === undefined) continue;
    const focusDiagnostics = diagnosticMap.get(node.id) ?? [];
    const severity = focusDiagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    )
      ? 'error'
      : focusDiagnostics.some(({ severity }) => severity === 'warning')
        ? 'warning'
        : 'clean';
    const fill =
      focus.visibility === 'hidden'
        ? '#283043'
        : focus.visibility === 'crisis'
          ? '#4b2831'
          : '#25344a';
    const stroke =
      severity === 'error' ? '#ff6b6b' : severity === 'warning' ? '#f0b85a' : '#71849e';
    const icon = focus.icons[0];
    const iconUri = focusIconDataUri(focus, options);
    const title =
      options.presentation?.entries[focus.id]?.title ??
      focus.localisation.workingLabel ??
      focus.label;
    const diagnosticCodes = focusDiagnostics
      .map(({ code }) => code)
      .sort()
      .join(' ');
    parts.push(
      `<g class="focus-node ${escapeXml(focus.visibility)} ${severity}" id="focus-${escapeXml(node.id)}" data-focus-id="${escapeXml(node.id)}" data-branch="${escapeXml(focus.branchId ?? '')}" data-lane="${escapeXml(node.laneId)}" data-diagnostics="${escapeXml(diagnosticCodes)}" transform="translate(${point.x} ${point.y})" filter="url(#shadow)">`,
      `<title>${escapeXml(`${title} (${node.id}) at ${node.x},${node.y}`)}</title>`,
      `<rect width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${severity === 'clean' ? 1.5 : 3}"/>`,
    );
    if (iconUri !== undefined) {
      parts.push(
        `<image href="${escapeXml(iconUri)}" x="8" y="10" width="48" height="48" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else {
      parts.push(
        `<rect x="8" y="10" width="48" height="48" rx="5" fill="#182131" stroke="#52647d"/>`,
        toolText.render(icon?.sprite === undefined ? '?' : 'ICON', {
          x: 32,
          y: 38,
          fontSize: 10,
          anchor: 'middle',
          fill: '#91a0b4',
        }),
      );
    }
    parts.push(
      toolText.render(title.slice(0, 18), {
        x: 64,
        y: 25,
        fontSize: 12,
        weight: 700,
        fill: '#f2f5fa',
      }),
      toolText.render(node.id.slice(0, 22), {
        x: 64,
        y: 43,
        fontSize: 9,
        fill: '#aeb9c8',
      }),
      toolText.render(`(${node.x}, ${node.y}) · ${node.laneId}`, {
        x: 64,
        y: 59,
        fontSize: 9,
        fill: '#8391a5',
      }),
      '</g>',
    );
  }
  parts.push('</g>', '</svg>');

  const graph = {
    schemaVersion: 1,
    tree: {
      id: plan.id,
      sourcePath: plan.provenance.sourcePath,
      sourceHash: plan.provenance.sourceHash,
      importedPlanHash: plan.provenance.importedPlanHash,
      focusCount: plan.focuses.length,
      continuousFocusPaletteIds: plan.continuousFocusPaletteIds,
      continuousFocusIds: plan.continuousFocusIds,
    },
    layout: {
      hash: layout.layoutHash,
      nodes,
      decisions: layout.decisions,
      metrics: layout.metrics ?? null,
    },
    focuses: [...plan.focuses]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((focus) => ({
        id: focus.id,
        label: focus.label,
        position: positionsForJson(layoutNodeMap(layout), focus.id),
        prerequisiteGroups: focus.prerequisites.groups.map(({ focusIds }) => ({
          operator: 'or',
          focusIds,
        })),
        mutualExclusions: focus.mutuallyExclusive,
        branchId: focus.branchId ?? null,
        laneId: focus.laneId ?? null,
        visibility: focus.visibility,
        convergence: focus.convergence,
        terminal: !plan.focuses.some((candidate) =>
          prerequisiteIdsForRender(candidate).includes(focus.id),
        ),
        ai: focus.ai,
        filters: focus.filters,
        icons: focus.icons.map(({ kind, sprite }) => ({ kind, sprite })),
        localisation: focus.localisation,
        resolvedPresentation: options.presentation?.entries[focus.id] ?? null,
        links: focus.links,
        sourceLocation: focus.sourceLocation ?? null,
      })),
    diagnostics: [...diagnostics],
    sourceHashes: {
      [plan.provenance.sourcePath]: plan.provenance.sourceHash,
      ...(options.presentation?.sourceHashes ?? {}),
      ...(options.sourceHashes ?? {}),
    },
  };
  return {
    svg: `${parts.join('\n').replace('__DETERMINISTIC_FONT_DEFINITIONS__', toolText.definitions())}\n`,
    width,
    height,
    graph,
  };
}

function prerequisiteIdsForRender(focus: FocusTreePlan['focuses'][number]): string[] {
  return focus.prerequisites.groups.flatMap(({ focusIds }) => focusIds);
}

function positionsForJson(
  positions: ReturnType<typeof layoutNodeMap>,
  focusId: string,
): { x: number; y: number } | null {
  const node = positions.get(focusId);
  return node === undefined ? null : { x: node.x, y: node.y };
}

function htmlDocument(
  plan: FocusTreePlan,
  svg: string,
  graphJson: string,
  diagnostics: readonly Diagnostic[],
): string {
  const diagnosticsHtml = diagnostics
    .map(
      (diagnostic) =>
        `<li class="${escapeXml(diagnostic.severity)}" data-focus-id="${escapeXml(focusIdForDiagnostic(diagnostic) ?? '')}"><code>${escapeXml(diagnostic.code)}</code> ${escapeXml(diagnosticLabel(diagnostic))}</li>`,
    )
    .join('\n');
  const safeJson = graphJson.replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(plan.id)} focus tree · HOI4 Agent Tools</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b1019;color:#e9eef6}*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:minmax(0,1fr) 360px;height:100vh}.canvas{overflow:auto;background:#111723}.canvas svg{display:block}.panel{overflow:auto;border-left:1px solid #2d3849;padding:18px;background:#0d141f}.notice{color:#f0b85a;font-size:13px}.controls{position:sticky;top:0;background:#0d141f;padding-bottom:12px}input{width:100%;padding:9px;border:1px solid #41516a;border-radius:5px;background:#151e2c;color:#fff}li{margin:.65rem 0;font-size:12px;line-height:1.4}.error,.blocker{color:#ff8e8e}.warning{color:#f0c271}.muted{color:#92a0b2}.focus-node.filtered{opacity:.12}.focus-node.match rect{stroke:#66d9ef;stroke-width:4}</style>
</head>
<body>
<main class="canvas" aria-label="Focus tree artifact">${svg}</main>
<aside class="panel">
<div class="controls"><h1>${escapeXml(plan.id)}</h1><p class="notice">Offline HOI4 Agent Tools representation — not an in-game screenshot or editor.</p><label>Find focus<input id="search" type="search" placeholder="ID, title, branch, or lane"></label></div>
<h2>Diagnostics</h2><ol>${diagnosticsHtml}</ol>
<p class="muted">Source revision: <code>${escapeXml(plan.provenance.sourceHash)}</code></p>
</aside>
<script type="application/json" id="focus-data">${safeJson}</script>
<script>
const input=document.getElementById('search');
const nodes=[...document.querySelectorAll('.focus-node')];
input.addEventListener('input',()=>{const query=input.value.trim().toLowerCase();for(const node of nodes){const text=(node.textContent+' '+node.dataset.focusId+' '+node.dataset.branch+' '+node.dataset.lane).toLowerCase();node.classList.toggle('filtered',query!==''&&!text.includes(query));node.classList.toggle('match',query!==''&&text.includes(query));}});
</script>
</body>
</html>
`;
}

export async function renderFocusTree(
  plan: FocusTreePlan,
  layout: FocusLayoutResult,
  diagnostics: readonly Diagnostic[],
  options: FocusRenderOptions = {},
): Promise<FocusRenderBundle> {
  options.signal?.throwIfAborted();
  if (plan.focuses.length > FOCUS_GRAPH_MAX_NODES) {
    throw new ServiceError(
      'FOCUS_RENDER_NODE_BUDGET_BLOCKED',
      'Focus tree exceeds the fixed render node ceiling',
      { nodes: plan.focuses.length, maximumNodes: FOCUS_GRAPH_MAX_NODES },
    );
  }
  let edgeCount = 0;
  for (const focus of plan.focuses) {
    const prerequisiteEdges = focus.prerequisites.groups.reduce(
      (total, { focusIds }) => total + focusIds.length,
      0,
    );
    const additionalEdges = prerequisiteEdges + focus.mutuallyExclusive.length;
    if (additionalEdges > FOCUS_GRAPH_MAX_EDGES - edgeCount) {
      throw new ServiceError(
        'FOCUS_RENDER_EDGE_BUDGET_BLOCKED',
        'Focus tree exceeds the fixed render edge ceiling',
        { edges: edgeCount + additionalEdges, maximumEdges: FOCUS_GRAPH_MAX_EDGES },
      );
    }
    edgeCount += additionalEdges;
  }
  const budget = options.budget ?? new RenderBudget();
  const resolvedOptions = { ...options, budget };
  const focusById = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const renderedDataUris = layout.nodes.flatMap(({ id }) => {
    const focus = focusById.get(id);
    if (focus === undefined) return [];
    const dataUri = focusIconDataUri(focus, resolvedOptions);
    return dataUri === undefined ? [] : [dataUri];
  });
  await admitFocusIconDataUris(resolvedOptions, budget, renderedDataUris);
  const compiled = compileFocusTreeWithSourceMap(plan, layout);
  const rendered = svgDocument(plan, layout, diagnostics, resolvedOptions);
  const json = `${canonicalJson({ ...rendered.graph, generatedSourceMap: compiled.sourceMap })}\n`;
  const html = htmlDocument(plan, rendered.svg, json, diagnostics);
  assertRenderDimensions(rendered.width, rendered.height, 'focus tree Sharp raster');
  budget.reserveRasterOperation(
    `focus-tree:${sha256Bytes(rendered.svg)}`,
    'focus tree SVG rasterization',
  );
  const png = await sharp(Buffer.from(rendered.svg, 'utf8'), {
    limitInputPixels: RENDER_MAX_PIXELS,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  options.signal?.throwIfAborted();
  return {
    html,
    svg: rendered.svg,
    png,
    json,
    hashes: {
      html: sha256Bytes(html),
      svg: sha256Bytes(rendered.svg),
      png: sha256Bytes(png),
      json: sha256Bytes(json),
    },
    sourceMap: compiled.sourceMap,
    width: rendered.width,
    height: rendered.height,
  };
}

export async function storeFocusRenderArtifacts(
  workspace: ResolvedWorkspace,
  artifacts: ArtifactStore,
  plan: FocusTreePlan,
  bundle: FocusRenderBundle,
  options: FocusRenderOptions = {},
): Promise<StoredArtifact[]> {
  options.signal?.throwIfAborted();
  const stem = safeArtifactStem(plan.id);
  const sourceEvidence = boundedSourceHashEvidence({
    [plan.provenance.sourcePath]: plan.provenance.sourceHash,
    ...(options.presentation?.sourceHashes ?? {}),
    ...(options.sourceHashes ?? {}),
  });
  const provenance = {
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'focus-render.v1',
    sourceHashes: sourceEvidence.sourceHashes,
    renderProfile: {
      renderer: 'svg+sharp',
      width: bundle.width,
      height: bundle.height,
      ...(options.renderProfile ?? {}),
    },
    metadata: { sourceHashInventory: sourceEvidence.inventory },
  };
  const sidecar = createFocusPlanningSidecar(plan);
  const writes: ArtifactWrite[] = [
    {
      name: `${stem}.focus.html`,
      mimeType: 'text/html',
      content: bundle.html,
      provenance: { ...provenance, kind: 'focus-html' },
    },
    {
      name: `${stem}.focus.svg`,
      mimeType: 'image/svg+xml',
      content: bundle.svg,
      provenance: { ...provenance, kind: 'focus-svg' },
    },
    {
      name: `${stem}.focus.png`,
      mimeType: 'image/png',
      content: bundle.png,
      provenance: { ...provenance, kind: 'focus-png' },
    },
    {
      name: `${stem}.focus.json`,
      mimeType: 'application/json',
      content: bundle.json,
      provenance: { ...provenance, kind: 'focus-json' },
    },
    {
      name: `${stem}.focus.source-map.json`,
      mimeType: 'application/json',
      content: `${canonicalJson(bundle.sourceMap)}\n`,
      provenance: { ...provenance, kind: 'focus-source-map' },
      description: 'Generated focus ranges mapped to planning nodes and imported source locations',
    },
    {
      name: `${stem}.focus.plan.json`,
      mimeType: 'application/json',
      content: serializeFocusPlanningSidecar(sidecar),
      provenance: { ...provenance, kind: 'focus-planning-sidecar' },
      description: 'Source-hash-bound non-Clausewitz planning metadata',
    },
  ];
  return artifacts.withAtomicChunkedWrites(
    workspace,
    writes,
    (stored) => Promise.resolve([...stored]),
    options.signal,
  );
}

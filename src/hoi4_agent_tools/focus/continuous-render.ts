import sharp from 'sharp';
import {
  boundedSourceHashEvidence,
  type ArtifactStore,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import { canonicalJson, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { assertRenderDimensions, RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import { DeterministicSvgTextRenderer } from '../core/svg-text.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import { compileContinuousFocusPaletteWithSourceMap } from './compiler.js';
import { FOCUS_GRAPH_MAX_NODES } from './lint.js';
import { focusResolvedIconEvidence } from './presentation.js';
import { admitFocusIconDataUris } from './render.js';
import type {
  ContinuousFocusPalettePlan,
  FocusGeneratedSourceMap,
  FocusPresentationResolution,
} from './model.js';

export interface ContinuousFocusRenderOptions {
  presentation?: FocusPresentationResolution;
  columns?: number;
  padding?: number;
  signal?: AbortSignal;
  sourceHashes?: Record<string, string>;
  renderProfile?: Record<string, unknown>;
  budget?: RenderBudget;
  rasterize?: boolean;
}

export interface ContinuousFocusRenderBundle {
  html: string;
  svg: string;
  png: Buffer;
  json: string;
  hashes: { html: string; svg: string; png?: string; json: string };
  sourceMap: FocusGeneratedSourceMap;
  width: number;
  height: number;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function artifactStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 80) || 'continuous-focus';
}

export async function renderContinuousFocusPalette(
  plan: ContinuousFocusPalettePlan,
  diagnostics: readonly Diagnostic[],
  options: ContinuousFocusRenderOptions = {},
): Promise<ContinuousFocusRenderBundle> {
  options.signal?.throwIfAborted();
  if (plan.focuses.length > FOCUS_GRAPH_MAX_NODES) {
    throw new ServiceError(
      'FOCUS_RENDER_NODE_BUDGET_BLOCKED',
      'Continuous focus palette exceeds the fixed render node ceiling',
      { nodes: plan.focuses.length, maximumNodes: FOCUS_GRAPH_MAX_NODES },
    );
  }
  const budget = options.budget ?? new RenderBudget();
  const renderedDataUris = plan.focuses.flatMap((focus) => {
    const iconSprite = focus.icons[0]?.sprite;
    const dataUri =
      iconSprite === undefined ? undefined : options.presentation?.icons[iconSprite]?.dataUri;
    return dataUri === undefined ? [] : [dataUri];
  });
  if (options.rasterize !== false) {
    await admitFocusIconDataUris(options, budget, renderedDataUris);
  }
  const columns = Math.max(1, Math.min(12, options.columns ?? 5));
  const padding = Math.max(24, options.padding ?? 64);
  const cardWidth = 190;
  const cardHeight = 116;
  const gap = 24;
  const rows = Math.max(1, Math.ceil(plan.focuses.length / columns));
  const usedColumns = Math.max(1, Math.min(columns, plan.focuses.length));
  const width = padding * 2 + usedColumns * cardWidth + Math.max(0, usedColumns - 1) * gap;
  const height = padding * 2 + 84 + rows * cardHeight + Math.max(0, rows - 1) * gap;
  if (options.rasterize !== false) {
    budget.reserve(width, height, 'continuous focus palette PNG');
  }
  const diagnosticsById = new Map<string, Diagnostic[]>();
  const toolText = new DeterministicSvgTextRenderer();
  for (const diagnostic of diagnostics) {
    const id = diagnostic.location?.symbol;
    if (id === undefined) continue;
    const group = diagnosticsById.get(id) ?? [];
    group.push(diagnostic);
    diagnosticsById.set(id, group);
  }
  const cards = plan.focuses.map((focus, index) => {
    options.signal?.throwIfAborted();
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = padding + column * (cardWidth + gap);
    const y = padding + 84 + row * (cardHeight + gap);
    const entry = options.presentation?.entries[focus.id];
    const iconSprite = focus.icons[0]?.sprite;
    const icon = iconSprite === undefined ? undefined : options.presentation?.icons[iconSprite];
    const hard = (diagnosticsById.get(focus.id) ?? []).some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    const iconMarkup =
      icon === undefined
        ? `<rect x="12" y="14" width="48" height="48" rx="5" fill="#263747"/>${toolText.render('NO ICON', { x: 36, y: 43, fontSize: 10, anchor: 'middle', fill: '#9fb0bd' })}`
        : `<image href="${escapeXml(icon.dataUri)}" x="12" y="14" width="48" height="48" preserveAspectRatio="xMidYMid meet"/>`;
    const preservedLabel = `${focus.rawPassthrough.length} preserved source field${focus.rawPassthrough.length === 1 ? '' : 's'}`;
    const diagnosticCount = (diagnosticsById.get(focus.id) ?? []).length;
    return `<g transform="translate(${x} ${y})" data-continuous-focus-id="${escapeXml(focus.id)}"><rect width="${cardWidth}" height="${cardHeight}" rx="9" fill="#1c2a35" stroke="${hard ? '#e76f75' : '#668397'}" stroke-width="${hard ? 3 : 1.5}"/>${iconMarkup}${toolText.render(entry?.title ?? focus.localisation.titleKey, { x: 70, y: 30, fontSize: 13, weight: 700, fill: '#f3f6f8' })}${toolText.render(focus.id, { x: 70, y: 49, fontSize: 10, fill: '#aebbc5' })}${toolText.render(preservedLabel, { x: 12, y: 82, fontSize: 11, fill: '#9fb0bd' })}${toolText.render(`${diagnosticCount} diagnostic${diagnosticCount === 1 ? '' : 's'}`, { x: 12, y: 101, fontSize: 10, fill: '#d7b65b' })}</g>`;
  });
  const heading = toolText.render(plan.id, {
    x: padding,
    y: padding,
    fontSize: 24,
    weight: 700,
    fill: '#f3f6f8',
  });
  const notice = toolText.render('OFFLINE SOURCE MODEL \u00b7 NOT HOI4', {
    x: padding,
    y: padding + 27,
    fontSize: 12,
    fill: '#d7b65b',
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml(plan.id)} continuous focus palette</title><desc>Offline source-derived continuous focus palette; not an in-game screenshot.</desc><defs>${toolText.definitions()}</defs><rect width="${width}" height="${height}" fill="#101820"/>${heading}${notice}${cards.join('')}</svg>`;
  const compiled = compileContinuousFocusPaletteWithSourceMap(plan);
  const json = `${canonicalJson({
    schemaVersion: 1,
    kind: 'continuous-focus-palette',
    palette: {
      id: plan.id,
      default: plan.default,
      resetOnCivilWar: plan.resetOnCivilWar ?? null,
      position: plan.position ?? null,
      countryTags: plan.countryAssignment?.countryTags ?? [],
      sourcePath: plan.provenance.sourcePath,
      sourceHash: plan.provenance.sourceHash,
    },
    focuses: plan.focuses.map((focus) => ({
      id: focus.id,
      title: options.presentation?.entries[focus.id]?.title ?? focus.localisation.titleKey,
      description:
        options.presentation?.entries[focus.id]?.description ?? focus.localisation.descriptionKey,
      icons: focus.icons,
      resolvedIcon:
        focus.icons[0]?.sprite === undefined
          ? null
          : (() => {
              const icon = options.presentation?.icons[focus.icons[0].sprite];
              return icon === undefined ? null : focusResolvedIconEvidence(icon);
            })(),
      preservedFields: focus.rawPassthrough.map(({ key, kind, order }) => ({ key, kind, order })),
      sourceLocation: focus.sourceLocation ?? null,
    })),
    diagnostics,
    sourceMap: compiled.sourceMap,
    sourceHashes: {
      [plan.provenance.sourcePath]: plan.provenance.sourceHash,
      ...(options.sourceHashes ?? {}),
    },
    renderProfile: options.renderProfile ?? {},
  })}\n`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeXml(plan.id)} continuous focus palette</title><style>html{background:#101820;color:#f3f6f8;font:14px system-ui}body{margin:0;padding:24px}.notice{color:#d7b65b}svg{max-width:100%;height:auto;border:1px solid #385064}pre{white-space:pre-wrap}</style></head><body><h1>${escapeXml(plan.id)}</h1><p class="notice">Offline source-derived review artifact &mdash; not an in-game screenshot or editor.</p>${svg}<details><summary>Structured source model</summary><pre>${escapeXml(json)}</pre></details></body></html>`;
  options.signal?.throwIfAborted();
  let png = Buffer.alloc(0);
  if (options.rasterize !== false) {
    assertRenderDimensions(width, height, 'continuous focus palette Sharp raster');
    png = await sharp(Buffer.from(svg, 'utf8'), { limitInputPixels: RENDER_MAX_PIXELS })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
  }
  options.signal?.throwIfAborted();
  return {
    html,
    svg,
    png,
    json,
    hashes: {
      html: sha256Bytes(html),
      svg: sha256Bytes(svg),
      ...(options.rasterize === false ? {} : { png: sha256Bytes(png) }),
      json: sha256Bytes(json),
    },
    sourceMap: compiled.sourceMap,
    width,
    height,
  };
}

export async function storeContinuousFocusRenderArtifacts(
  workspace: ResolvedWorkspace,
  store: ArtifactStore,
  plan: ContinuousFocusPalettePlan,
  bundle: ContinuousFocusRenderBundle,
  options: ContinuousFocusRenderOptions = {},
): Promise<StoredArtifact[]> {
  options.signal?.throwIfAborted();
  const stem = artifactStem(plan.id);
  const sourceEvidence = boundedSourceHashEvidence({
    [plan.provenance.sourcePath]: plan.provenance.sourceHash,
    ...(options.sourceHashes ?? {}),
  });
  const provenance = {
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'continuous-focus-render.v1',
    sourceHashes: sourceEvidence.sourceHashes,
    renderProfile: { kind: 'continuous-focus-palette', ...(options.renderProfile ?? {}) },
    metadata: { sourceHashInventory: sourceEvidence.inventory },
  };
  const entries: Array<readonly [string, string, Uint8Array | string, string]> = [
    [`${stem}.continuous.html`, 'text/html', bundle.html, 'interactive-review'],
    [`${stem}.continuous.svg`, 'image/svg+xml', bundle.svg, 'vector-render'],
    ...(options.rasterize === false
      ? []
      : [[`${stem}.continuous.png`, 'image/png', bundle.png, 'raster-render'] as const]),
    [`${stem}.continuous.json`, 'application/json', bundle.json, 'structured-render'],
    [
      `${stem}.continuous.source-map.json`,
      'application/json',
      `${canonicalJson(bundle.sourceMap)}\n`,
      'source-map',
    ],
  ];
  const writes: ArtifactWrite[] = entries.map(([name, mimeType, content, kind]) => ({
    name,
    mimeType,
    content,
    provenance: { ...provenance, kind: `continuous-focus-${kind}` },
    description: `Continuous focus palette ${kind}`,
  }));
  return store.withAtomicChunkedWrites(
    workspace,
    writes,
    (stored) => Promise.resolve([...stored]),
    options.signal,
  );
}

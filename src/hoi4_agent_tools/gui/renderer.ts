import sharp from 'sharp';
import { compareCodeUnits, canonicalJson, sha256Bytes } from '../core/canonical.js';
import { comparePngImages } from '../core/image-diff.js';
import { assertRenderDimensions, RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import { DeterministicSvgTextRenderer } from '../core/svg-text.js';
import { GUI_SCENE_MAX_ELEMENTS } from './limits.js';
import type {
  GuiComparisonResult,
  GuiRect,
  GuiRenderedImage,
  GuiRenderResult,
  GuiRenderVariant,
  GuiScene,
  GuiSceneElement,
} from './types.js';

const defaultVariants: readonly GuiRenderVariant[] = [
  'full',
  'cropped',
  'annotated',
  'click-regions',
  'source-map',
];

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function rectAttributes(rect: GuiRect): string {
  return `x="${finite(rect.x)}" y="${finite(rect.y)}" width="${finite(rect.width)}" height="${finite(rect.height)}"`;
}

function colourFor(value: string): string {
  const digest = sha256Bytes(value);
  return `#${digest.slice(0, 6)}`;
}

function outlineDefinitionId(key: string): string {
  return `gui-font-outline-${sha256Bytes(key).slice(0, 20)}`;
}

function bitmapDefinitionId(key: string): string {
  return `gui-font-bitmap-${sha256Bytes(key).slice(0, 20)}`;
}

function sceneGlyphDefinitions(scene: GuiScene): string {
  const outlines = new Map<string, string>();
  const bitmaps = new Map<string, { dataUri: string; width: number; height: number }>();
  for (const element of scene.elements) {
    for (const line of element.text?.glyphLines ?? []) {
      for (const glyph of line.glyphs) {
        if (glyph.kind === 'outline') outlines.set(glyph.key, glyph.path);
        else
          bitmaps.set(glyph.key, {
            dataUri: glyph.dataUri,
            width: glyph.width,
            height: glyph.height,
          });
      }
    }
  }
  return [
    ...[...outlines.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, glyphPath]) => `<path id="${outlineDefinitionId(key)}" d="${glyphPath}"/>`),
    ...[...bitmaps.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(
        ([key, glyph]) =>
          `<image id="${bitmapDefinitionId(key)}" width="${finite(glyph.width)}" height="${finite(glyph.height)}" href="${glyph.dataUri}" preserveAspectRatio="none"/>`,
      ),
  ].join('');
}

function renderText(element: GuiSceneElement, toolText: DeterministicSvgTextRenderer): string {
  const text = element.text;
  if (text === undefined || text.lines.length === 0) return '';
  const rect = element.unclippedRect;
  const totalHeight = text.lines.length * text.lineHeight;
  const firstTop =
    text.verticalAlignment === 'center'
      ? rect.y + (rect.height - totalHeight) / 2
      : text.verticalAlignment === 'bottom'
        ? rect.y + rect.height - totalHeight
        : rect.y;
  const lines = text.lines.map((line, index) => {
    const width = text.lineWidths[index] ?? 0;
    const originX =
      text.horizontalAlignment === 'center'
        ? rect.x + (rect.width - width) / 2
        : text.horizontalAlignment === 'right'
          ? rect.x + rect.width - width
          : rect.x;
    const glyphLine = text.glyphLines[index];
    const lineTop = firstTop + index * text.lineHeight;
    const baseline =
      lineTop +
      (glyphLine === undefined || glyphLine.source === 'deterministic-fallback'
        ? text.lineHeight * 0.8
        : glyphLine.baseline);
    if (glyphLine?.source === 'fontkit-path') {
      const horizontalScale = glyphLine.width > 0 && width > 0 ? width / glyphLine.width : 1;
      return `<g data-font-sha256="${glyphLine.sourceHash}">${glyphLine.glyphs
        .filter((glyph) => glyph.kind === 'outline')
        .map(
          (glyph) =>
            `<use href="#${outlineDefinitionId(glyph.key)}" transform="translate(${finite(originX + glyph.x * horizontalScale)} ${finite(baseline + glyph.y)}) scale(${finite(glyph.scale * horizontalScale)} ${finite(-glyph.scale)})"/>`,
        )
        .join('')}</g>`;
    }
    if (glyphLine?.source === 'bmfont-atlas') {
      const horizontalScale = glyphLine.width > 0 && width > 0 ? width / glyphLine.width : 1;
      return `<g data-font-sha256="${glyphLine.sourceHash}">${glyphLine.glyphs
        .filter((glyph) => glyph.kind === 'bitmap')
        .map(
          (glyph) =>
            `<use href="#${bitmapDefinitionId(glyph.key)}" transform="translate(${finite(originX + glyph.x * horizontalScale)} ${finite(baseline + glyph.y - glyphLine.baseline)}) scale(${finite(horizontalScale)} 1)"/>`,
        )
        .join('')}</g>`;
    }
    return toolText.render(line, {
      x: originX,
      y: baseline,
      fontSize: text.fontSize,
      fill: '#f5f2e8',
      stroke: '#12151a',
      strokeWidth: 0.6,
      ...(width > 0 ? { targetWidth: width } : {}),
    });
  });
  return `<g data-source-id="${escapeXml(element.sourceId)}" fill="#f5f2e8" stroke="#12151a" stroke-width="0.6" paint-order="stroke">${lines.join('')}</g>`;
}

function renderBaseElement(
  element: GuiSceneElement,
  clipId: string | undefined,
  toolText: DeterministicSvgTextRenderer,
): string {
  if (!element.visible) return '';
  const rect = element.unclippedRect;
  const clip = clipId === undefined ? '' : ` clip-path="url(#${clipId})"`;
  const content: string[] = [];
  if (element.sprite?.supported === true && element.sprite.dataUri !== undefined) {
    content.push(
      `<image ${rectAttributes(rect)} href="${element.sprite.dataUri}" preserveAspectRatio="none"/>`,
    );
  } else if (element.sprite !== undefined) {
    content.push(
      `<rect ${rectAttributes(rect)} fill="#331f3f" stroke="#ff42d0" stroke-width="1"/><path d="M ${finite(rect.x)} ${finite(rect.y)} L ${finite(rect.x + rect.width)} ${finite(rect.y + rect.height)} M ${finite(rect.x + rect.width)} ${finite(rect.y)} L ${finite(rect.x)} ${finite(rect.y + rect.height)}" stroke="#ff42d0"/>`,
    );
  }
  if (element.progressRatio !== undefined) {
    content.push(
      `<rect x="${finite(rect.x)}" y="${finite(rect.y)}" width="${finite(rect.width * element.progressRatio)}" height="${finite(rect.height)}" fill="#5ecf8d" fill-opacity="0.65"/>`,
    );
  }
  content.push(renderText(element, toolText));
  if (element.state === 'hover')
    content.push(`<rect ${rectAttributes(rect)} fill="#fff" opacity="0.08"/>`);
  if (element.state === 'selected' || element.state === 'active')
    content.push(`<rect ${rectAttributes(rect)} fill="none" stroke="#ffd166" stroke-width="2"/>`);
  if (element.state === 'locked' || element.state === 'disabled')
    content.push(`<rect ${rectAttributes(rect)} fill="#111820" opacity="0.5"/>`);
  if (element.state === 'warning')
    content.push(`<rect ${rectAttributes(rect)} fill="none" stroke="#ff5d5d" stroke-width="3"/>`);
  if (element.state === 'completed')
    content.push(`<rect ${rectAttributes(rect)} fill="none" stroke="#5ecf8d" stroke-width="2"/>`);
  return `<g id="${escapeXml(element.id)}" data-source="${escapeXml(element.sourcePath)}" data-source-id="${escapeXml(element.sourceId)}"${clip}>${content.join('')}</g>`;
}

function renderOverlay(
  element: GuiSceneElement,
  variant: GuiRenderVariant,
  toolText: DeterministicSvgTextRenderer,
): string {
  if (!element.visible) return '';
  const rect = element.rect;
  if (rect.width <= 0 || rect.height <= 0) return '';
  if (variant === 'click-regions') {
    if (!element.clickable) return '';
    return `<g><rect ${rectAttributes(rect)} fill="#00d4ff" fill-opacity="0.2" stroke="#00d4ff" stroke-width="2"/>${toolText.render(element.name, { x: rect.x + 3, y: rect.y + 13, fontSize: 11, fill: '#00d4ff' })}</g>`;
  }
  if (variant === 'source-map') {
    const colour = colourFor(element.sourcePath);
    return `<g><rect ${rectAttributes(rect)} fill="${colour}" fill-opacity="0.28" stroke="${colour}" stroke-width="1"/><title>${escapeXml(`${element.sourcePath} :: ${element.name}`)}</title></g>`;
  }
  if (variant === 'annotated') {
    const colour = element.clipped
      ? '#ff9f1c'
      : element.text?.overflowX === true || element.text?.overflowY === true
        ? '#ff4d6d'
        : '#55d6be';
    return `<g><rect ${rectAttributes(rect)} fill="none" stroke="${colour}" stroke-width="1" stroke-dasharray="4 2"/><rect x="${finite(rect.x)}" y="${finite(rect.y)}" width="${Math.max(30, finite(toolText.measure(element.name, 10) + 8))}" height="14" fill="#090d12" fill-opacity="0.82"/>${toolText.render(element.name, { x: rect.x + 3, y: rect.y + 11, fontSize: 10, fill: colour })}</g>`;
  }
  return '';
}

function viewFor(
  scene: GuiScene,
  variant: GuiRenderVariant,
): { viewBox: GuiRect; width: number; height: number } {
  if (variant !== 'cropped' || scene.bounds.width <= 0 || scene.bounds.height <= 0) {
    return {
      viewBox: { x: 0, y: 0, width: scene.resolution.width, height: scene.resolution.height },
      width: scene.resolution.width,
      height: scene.resolution.height,
    };
  }
  const padding = 16;
  const x = Math.max(0, scene.bounds.x - padding);
  const y = Math.max(0, scene.bounds.y - padding);
  const right = Math.min(scene.resolution.width, scene.bounds.x + scene.bounds.width + padding);
  const bottom = Math.min(scene.resolution.height, scene.bounds.y + scene.bounds.height + padding);
  return {
    viewBox: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
    width: Math.max(1, Math.ceil(right - x)),
    height: Math.max(1, Math.ceil(bottom - y)),
  };
}

export function sceneToSvg(scene: GuiScene, variant: GuiRenderVariant): string {
  const view = viewFor(scene, variant);
  assertRenderDimensions(view.width, view.height, `GUI ${variant} SVG`);
  const toolText = new DeterministicSvgTextRenderer();
  const clipDefinitions = scene.elements.flatMap((element, index) =>
    element.clipRect === undefined
      ? []
      : [`<clipPath id="clip-${index}"><rect ${rectAttributes(element.clipRect)}/></clipPath>`],
  );
  const body = scene.elements
    .map((element, index) =>
      renderBaseElement(
        element,
        element.clipRect === undefined ? undefined : `clip-${index}`,
        toolText,
      ),
    )
    .join('');
  const overlays = scene.elements
    .map((element) => renderOverlay(element, variant, toolText))
    .join('');
  const fidelity = escapeXml(canonicalJson(scene.fidelity));
  const banner = toolText.render('OFFLINE APPROXIMATION \u00b7 NOT HOI4', {
    x: view.viewBox.x + 15,
    y: view.viewBox.y + 22,
    fontSize: 11,
    fill: '#f1c75b',
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="${finite(view.viewBox.x)} ${finite(view.viewBox.y)} ${finite(view.viewBox.width)} ${finite(view.viewBox.height)}"><metadata data-renderer="hoi4-agent-tools" data-mode="offline">${fidelity}</metadata><defs>${clipDefinitions.join('')}${sceneGlyphDefinitions(scene)}${toolText.definitions()}</defs><rect ${rectAttributes(view.viewBox)} fill="#17202a"/>${body}${overlays}<g><rect x="${finite(view.viewBox.x + 8)}" y="${finite(view.viewBox.y + 8)}" width="215" height="20" rx="3" fill="#05080c" fill-opacity="0.82"/>${banner}</g></svg>`;
}

async function cooperativeParts<T>(
  values: readonly T[],
  render: (value: T, index: number) => string,
  signal: AbortSignal,
): Promise<string> {
  const output: string[] = [];
  for (const [index, value] of values.entries()) {
    if (index % 64 === 0) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    }
    output.push(render(value, index));
  }
  return output.join('');
}

async function sceneToSvgCooperative(
  scene: GuiScene,
  variant: GuiRenderVariant,
  signal: AbortSignal,
): Promise<string> {
  const view = viewFor(scene, variant);
  assertRenderDimensions(view.width, view.height, `GUI ${variant} SVG`);
  const toolText = new DeterministicSvgTextRenderer();
  const clipDefinitions = await cooperativeParts(
    scene.elements,
    (element, index) =>
      element.clipRect === undefined
        ? ''
        : `<clipPath id="clip-${index}"><rect ${rectAttributes(element.clipRect)}/></clipPath>`,
    signal,
  );
  const body = await cooperativeParts(
    scene.elements,
    (element, index) =>
      renderBaseElement(
        element,
        element.clipRect === undefined ? undefined : `clip-${index}`,
        toolText,
      ),
    signal,
  );
  const overlays = await cooperativeParts(
    scene.elements,
    (element) => renderOverlay(element, variant, toolText),
    signal,
  );
  const fidelity = escapeXml(canonicalJson(scene.fidelity));
  const banner = toolText.render('OFFLINE APPROXIMATION \u00b7 NOT HOI4', {
    x: view.viewBox.x + 15,
    y: view.viewBox.y + 22,
    fontSize: 11,
    fill: '#f1c75b',
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="${finite(view.viewBox.x)} ${finite(view.viewBox.y)} ${finite(view.viewBox.width)} ${finite(view.viewBox.height)}"><metadata data-renderer="hoi4-agent-tools" data-mode="offline">${fidelity}</metadata><defs>${clipDefinitions}${sceneGlyphDefinitions(scene)}${toolText.definitions()}</defs><rect ${rectAttributes(view.viewBox)} fill="#17202a"/>${body}${overlays}<g><rect x="${finite(view.viewBox.x + 8)}" y="${finite(view.viewBox.y + 8)}" width="215" height="20" rx="3" fill="#05080c" fill-opacity="0.82"/>${banner}</g></svg>`;
}

export function hierarchyToSvg(scene: GuiScene): string {
  const rows = scene.elements.toSorted(
    (left, right) =>
      left.depth - right.depth || left.zIndex - right.zIndex || compareCodeUnits(left.id, right.id),
  );
  const width = 900;
  const rowHeight = 24;
  const height = Math.max(64, rows.length * rowHeight + 44);
  assertRenderDimensions(width, height, 'GUI hierarchy SVG');
  const toolText = new DeterministicSvgTextRenderer();
  const content = rows
    .map((element, index) => {
      const x = 16 + element.depth * 24;
      const y = 38 + index * rowHeight;
      const colour = element.visible ? '#55d6be' : '#73808c';
      const parentLine =
        element.depth === 0
          ? ''
          : `<line x1="${x - 16}" y1="${y - 8}" x2="${x - 4}" y2="${y - 8}" stroke="#536171"/>`;
      const name = `${element.name} `;
      const nameText = toolText.render(name, {
        x: x + 10,
        y: y - 4,
        fontSize: 12,
        fill: '#edf3f8',
      });
      const detailText = toolText.render(`${element.elementType} \u00b7 z${element.zIndex}`, {
        x: x + 10 + toolText.measure(name, 12),
        y: y - 4,
        fontSize: 12,
        fill: '#8291a2',
      });
      return `${parentLine}<circle cx="${x}" cy="${y - 8}" r="4" fill="${colour}"/>${nameText}${detailText}`;
    })
    .join('');
  const heading = toolText.render(`OFFLINE HIERARCHY \u00b7 ${scene.windowName}`, {
    x: 16,
    y: 20,
    fontSize: 12,
    fill: '#f1c75b',
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${toolText.definitions()}</defs><rect width="100%" height="100%" fill="#111820"/>${heading}${content}</svg>`;
}

function sceneLayoutEvidence(scene: GuiScene): Record<string, unknown> {
  return {
    ...scene,
    elements: scene.elements.map((element) => ({
      ...element,
      ...(element.sprite === undefined
        ? {}
        : {
            sprite: {
              spriteName: element.sprite.spriteName,
              texturePath: element.sprite.texturePath,
              frame: element.sprite.frame,
              frameCount: element.sprite.frameCount,
              width: element.sprite.width,
              height: element.sprite.height,
              format: element.sprite.format,
              supported: element.sprite.supported,
              ...(element.sprite.reason === undefined ? {} : { reason: element.sprite.reason }),
            },
          }),
      ...(element.text === undefined
        ? {}
        : {
            text: {
              ...element.text,
              glyphLines: element.text.glyphLines.map((line) => ({
                source: line.source,
                sourceHash: line.sourceHash,
                width: line.width,
                baseline: line.baseline,
                baselineModelled: line.baselineModelled,
                glyphCount: line.glyphs.length,
                missingGlyphs: line.missingGlyphs,
              })),
            },
          }),
    })),
  };
}

export async function renderGuiScene(
  scene: GuiScene,
  variants: readonly GuiRenderVariant[] = defaultVariants,
  signal?: AbortSignal,
  budget = new RenderBudget(),
): Promise<GuiRenderResult> {
  if (scene.elements.length > GUI_SCENE_MAX_ELEMENTS) {
    throw new ServiceError(
      'GUI_RENDER_ELEMENT_BUDGET_BLOCKED',
      'GUI scene exceeds the fixed render element ceiling',
      { elements: scene.elements.length, maximumElements: GUI_SCENE_MAX_ELEMENTS },
    );
  }
  const images: GuiRenderedImage[] = [];
  for (const variant of variants) {
    signal?.throwIfAborted();
    const view = viewFor(scene, variant);
    budget.reserve(view.width, view.height, `GUI ${variant} variant`);
    const svg =
      signal === undefined
        ? sceneToSvg(scene, variant)
        : await sceneToSvgCooperative(scene, variant, signal);
    assertRenderDimensions(view.width, view.height, `GUI ${variant} Sharp raster`);
    budget.reserveRasterOperation(
      `gui-variant:${sha256Bytes(svg)}`,
      `GUI ${variant} SVG rasterization`,
    );
    const png = await sharp(Buffer.from(svg), { limitInputPixels: RENDER_MAX_PIXELS })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    signal?.throwIfAborted();
    images.push({ variant, svg, png, width: view.width, height: view.height });
  }
  return {
    scene,
    images,
    hierarchySvg: hierarchyToSvg(scene),
    layoutJson: `${canonicalJson({
      offline: true,
      renderer: 'hoi4-agent-tools',
      scene: sceneLayoutEvidence(scene),
    })}\n`,
    scenarioJson: `${canonicalJson({ offline: true, scenario: scene.scenario })}\n`,
    diagnostics: scene.diagnostics,
    fidelity: scene.fidelity,
  };
}

export async function compareGuiImages(
  leftPng: Buffer,
  rightPng: Buffer,
  budget = new RenderBudget(),
  signal?: AbortSignal,
): Promise<GuiComparisonResult> {
  return comparePngImages(leftPng, rightPng, 8, signal, budget);
}

export interface GalleryItem {
  label: string;
  png: Buffer;
  width: number;
  height: number;
}

export function galleryDimensions(items: readonly GalleryItem[]): {
  width: number;
  height: number;
} {
  const cellWidth = 420;
  const cellHeight = 280;
  const columns = Math.min(3, Math.max(1, items.length));
  const rows = Math.max(1, Math.ceil(items.length / columns));
  return { width: columns * cellWidth, height: 46 + rows * cellHeight };
}

export function renderGallerySvg(title: string, items: readonly GalleryItem[]): string {
  const cellWidth = 420;
  const cellHeight = 280;
  const { width, height } = galleryDimensions(items);
  assertRenderDimensions(width, height, 'GUI gallery SVG');
  const toolText = new DeterministicSvgTextRenderer();
  const columns = Math.min(3, Math.max(1, items.length));
  const content = items
    .map((item, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth + 10;
      const y = 46 + row * cellHeight;
      const availableWidth = cellWidth - 20;
      const availableHeight = cellHeight - 34;
      const scale = Math.min(availableWidth / item.width, availableHeight / item.height);
      return `<g>${toolText.render(item.label, { x, y: y + 14, fontSize: 12, fill: '#f1c75b' })}<image x="${x}" y="${y + 22}" width="${finite(item.width * scale)}" height="${finite(item.height * scale)}" href="data:image/png;base64,${item.png.toString('base64')}"/></g>`;
    })
    .join('');
  const heading = toolText.render(`${title} \u00b7 OFFLINE APPROXIMATION`, {
    x: 12,
    y: 24,
    fontSize: 15,
    fill: '#f5f2e8',
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${toolText.definitions()}</defs><rect width="100%" height="100%" fill="#101720"/>${heading}${content}</svg>`;
}

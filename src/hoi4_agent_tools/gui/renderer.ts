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
  GuiTextGlyphLine,
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

function bitmapTintMarkup(id: string, colour: string, glyphs: string, rect: GuiRect): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(colour);
  const rgb = match?.[1] ?? 'ffffff';
  const alpha = match?.[2] ?? 'ff';
  const channels = [
    Number.parseInt(rgb.slice(0, 2), 16) / 255,
    Number.parseInt(rgb.slice(2, 4), 16) / 255,
    Number.parseInt(rgb.slice(4, 6), 16) / 255,
    Number.parseInt(alpha, 16) / 255,
  ].map(finite);
  const [red, green, blue, opacity] = channels;
  const matrix = `${red} 0 0 0 0 0 ${green} 0 0 0 0 0 ${blue} 0 0 0 0 0 ${opacity} 0`;
  return `<defs><filter id="${id}" filterUnits="userSpaceOnUse" ${rectAttributes(rect)} color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${matrix}"/></filter></defs><g filter="url(#${id})">${glyphs}</g>`;
}

function actualGlyphMarkup(
  glyphLine: GuiTextGlyphLine,
  originX: number,
  baseline: number,
  horizontalScale: number,
): string {
  if (glyphLine.source === 'fontkit-path')
    return glyphLine.glyphs
      .filter((glyph) => glyph.kind === 'outline')
      .map(
        (glyph) =>
          `<use href="#${outlineDefinitionId(glyph.key)}" transform="translate(${finite(originX + glyph.x * horizontalScale)} ${finite(baseline + glyph.y)}) scale(${finite(glyph.scale * horizontalScale)} ${finite(-glyph.scale)})"/>`,
      )
      .join('');
  if (glyphLine.source === 'bmfont-atlas')
    return glyphLine.glyphs
      .filter((glyph) => glyph.kind === 'bitmap')
      .map(
        (glyph) =>
          `<use href="#${bitmapDefinitionId(glyph.key)}" transform="translate(${finite(originX + glyph.x * horizontalScale)} ${finite(baseline + glyph.y - glyphLine.baseline)}) scale(${finite(horizontalScale)} 1)"/>`,
      )
      .join('');
  return '';
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
    const horizontalScale =
      glyphLine !== undefined && glyphLine.width > 0 && width > 0 ? width / glyphLine.width : 1;
    const inlineIconMarkup = (text.inlineIcons ?? [])
      .filter((icon) => icon.lineIndex === index)
      .map((icon) => {
        const iconRect = {
          x: originX + icon.offsetX * horizontalScale,
          y: lineTop + (text.lineHeight - icon.height) / 2,
          width: icon.width * horizontalScale,
          height: icon.height,
        };
        if (icon.sprite?.supported === true && icon.sprite.dataUri !== undefined)
          return `<image data-inline-icon="${escapeXml(icon.token)}" ${rectAttributes(iconRect)} href="${icon.sprite.dataUri}" preserveAspectRatio="xMidYMid meet"/>`;
        return `<g data-inline-icon-missing="${escapeXml(icon.token)}"><rect ${rectAttributes(iconRect)} fill="#331f3f" stroke="#ff42d0" stroke-width="1"/><path d="M ${finite(iconRect.x)} ${finite(iconRect.y)} L ${finite(iconRect.x + iconRect.width)} ${finite(iconRect.y + iconRect.height)} M ${finite(iconRect.x + iconRect.width)} ${finite(iconRect.y)} L ${finite(iconRect.x)} ${finite(iconRect.y + iconRect.height)}" stroke="#ff42d0"/></g>`;
      })
      .join('');
    const colourRuns = text.colourRuns?.[index] ?? [];
    if (
      colourRuns.length > 0 &&
      glyphLine !== undefined &&
      glyphLine.source !== 'deterministic-fallback'
    ) {
      const definitions: string[] = [];
      const renderedRuns = colourRuns.map((run, runIndex) => {
        const key = `${element.id}:${index}:${runIndex}:${run.colour}`;
        const clipId = `gui-font-run-clip-${sha256Bytes(key).slice(0, 20)}`;
        const runX = originX + run.offsetX * horizontalScale;
        definitions.push(
          `<clipPath id="${clipId}"><rect x="${finite(runX - 0.25)}" y="${finite(lineTop - text.lineHeight)}" width="${finite(run.width * horizontalScale + 0.5)}" height="${finite(text.lineHeight * 3)}"/></clipPath>`,
        );
        const glyphs = actualGlyphMarkup(glyphLine, originX, baseline, horizontalScale);
        if (glyphLine.source === 'bmfont-atlas') {
          const maskId = `gui-font-mask-${sha256Bytes(key).slice(0, 20)}`;
          const runRect = {
            x: runX - 0.25,
            y: lineTop - text.lineHeight,
            width: run.width * horizontalScale + 0.5,
            height: text.lineHeight * 3,
          };
          return `<g clip-path="url(#${clipId})" data-font-colour="${run.colour}">${bitmapTintMarkup(maskId, run.colour, glyphs, runRect)}</g>`;
        }
        return `<g clip-path="url(#${clipId})" fill="${run.colour}" stroke="${text.borderColour ?? '#12151a'}" data-font-colour="${run.colour}">${glyphs}</g>`;
      });
      return `<g data-hoi4-colour-runs="true" data-font-sha256="${glyphLine.sourceHash}"><defs>${definitions.join('')}</defs>${renderedRuns.join('')}${inlineIconMarkup}</g>`;
    }
    if (colourRuns.length > 0) {
      return `<g data-hoi4-colour-runs="true">${colourRuns
        .map((run) =>
          toolText.render(run.text, {
            x: originX + run.offsetX * horizontalScale,
            y: baseline,
            fontSize: text.fontSize,
            fill: run.colour,
            stroke: text.borderColour ?? '#12151a',
            strokeWidth: 0.6,
            ...(run.width > 0 ? { targetWidth: run.width * horizontalScale } : {}),
          }),
        )
        .join('')}${inlineIconMarkup}</g>`;
    }
    if (glyphLine?.source === 'fontkit-path') {
      return `<g data-font-sha256="${glyphLine.sourceHash}" fill="${text.colour ?? '#f5f2e8'}" stroke="${text.borderColour ?? '#12151a'}" data-font-colour="${text.colour ?? '#f5f2e8'}">${actualGlyphMarkup(glyphLine, originX, baseline, horizontalScale)}${inlineIconMarkup}</g>`;
    }
    if (glyphLine?.source === 'bmfont-atlas') {
      const glyphs = actualGlyphMarkup(glyphLine, originX, baseline, horizontalScale);
      if (text.colour === undefined)
        return `<g data-font-sha256="${glyphLine.sourceHash}">${glyphs}${inlineIconMarkup}</g>`;
      const maskId = `gui-font-mask-${sha256Bytes(`${element.id}:${index}:${text.colour}`).slice(0, 20)}`;
      const lineRect = { x: originX, y: lineTop, width, height: text.lineHeight };
      return `<g data-font-sha256="${glyphLine.sourceHash}" data-font-colour="${text.colour}">${bitmapTintMarkup(maskId, text.colour, glyphs, lineRect)}${inlineIconMarkup}</g>`;
    }
    const visibleLine = line.replace(/[\uE000-\uF8FF]/gu, ' ');
    return `<g>${toolText.render(visibleLine, {
      x: originX,
      y: baseline,
      fontSize: text.fontSize,
      fill: text.colour ?? '#f5f2e8',
      stroke: text.borderColour ?? '#12151a',
      strokeWidth: 0.6,
      ...(width > 0 ? { targetWidth: width } : {}),
    })}${inlineIconMarkup}</g>`;
  });
  const textClipId = `gui-text-clip-${sha256Bytes(element.id).slice(0, 20)}`;
  const clipDefinition = text.fixedSize
    ? `<defs><clipPath id="${textClipId}"><rect ${rectAttributes(rect)}/></clipPath></defs>`
    : '';
  const clip = text.fixedSize ? ` clip-path="url(#${textClipId})"` : '';
  return `${clipDefinition}<g data-source-id="${escapeXml(element.sourceId)}" fill="#f5f2e8" stroke="#12151a" stroke-width="0.6" paint-order="stroke"${clip}>${lines.join('')}</g>`;
}

function renderSpriteImage(sprite: NonNullable<GuiSceneElement['sprite']>, rect: GuiRect): string {
  if (!sprite.supported || sprite.dataUri === undefined) return '';
  return `<image ${rectAttributes(rect)} href="${sprite.dataUri}" preserveAspectRatio="none"/>`;
}

function renderSpriteSlice(
  sprite: NonNullable<GuiSceneElement['sprite']>,
  source: GuiRect,
  destination: GuiRect,
): string {
  if (
    !sprite.supported ||
    sprite.dataUri === undefined ||
    source.width <= 0 ||
    source.height <= 0 ||
    destination.width <= 0 ||
    destination.height <= 0
  )
    return '';
  return `<svg ${rectAttributes(destination)} viewBox="${finite(source.x)} ${finite(source.y)} ${finite(source.width)} ${finite(source.height)}" preserveAspectRatio="none" overflow="hidden"><image x="0" y="0" width="${finite(sprite.width)}" height="${finite(sprite.height)}" href="${sprite.dataUri}" preserveAspectRatio="none"/></svg>`;
}

function renderTiledSpriteSlice(
  element: GuiSceneElement,
  sprite: NonNullable<GuiSceneElement['sprite']>,
  source: GuiRect,
  destination: GuiRect,
): string {
  if (
    !sprite.supported ||
    sprite.dataUri === undefined ||
    source.width <= 0 ||
    source.height <= 0 ||
    destination.width <= 0 ||
    destination.height <= 0
  )
    return '';
  const tileWidth = Math.max(1, source.width * element.scale);
  const tileHeight = Math.max(1, source.height * element.scale);
  const id = `gui-tile-${sha256Bytes(`${element.id}:${source.x}:${source.y}:${source.width}:${source.height}`).slice(0, 20)}`;
  return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" x="${finite(destination.x)}" y="${finite(destination.y)}" width="${finite(tileWidth)}" height="${finite(tileHeight)}"><svg width="${finite(tileWidth)}" height="${finite(tileHeight)}" viewBox="${finite(source.x)} ${finite(source.y)} ${finite(source.width)} ${finite(source.height)}" preserveAspectRatio="none" overflow="hidden"><image x="0" y="0" width="${finite(sprite.width)}" height="${finite(sprite.height)}" href="${sprite.dataUri}" preserveAspectRatio="none"/></svg></pattern></defs><rect ${rectAttributes(destination)} fill="url(#${id})"/>`;
}

function renderCorneredTile(element: GuiSceneElement): string {
  const sprite = element.sprite;
  const rect = element.unclippedRect;
  const border = element.spriteBorderSize;
  if (
    sprite?.supported !== true ||
    sprite.dataUri === undefined ||
    border === undefined ||
    border.width <= 0 ||
    border.height <= 0
  )
    return sprite === undefined ? '' : renderSpriteImage(sprite, rect);
  const sourceBorderX = Math.min(border.width, sprite.width / 2);
  const sourceBorderY = Math.min(border.height, sprite.height / 2);
  const destinationBorderX = Math.min(sourceBorderX * element.scale, rect.width / 2);
  const destinationBorderY = Math.min(sourceBorderY * element.scale, rect.height / 2);
  const sourceWidths = [sourceBorderX, sprite.width - sourceBorderX * 2, sourceBorderX];
  const sourceHeights = [sourceBorderY, sprite.height - sourceBorderY * 2, sourceBorderY];
  const destinationWidths = [
    destinationBorderX,
    rect.width - destinationBorderX * 2,
    destinationBorderX,
  ];
  const destinationHeights = [
    destinationBorderY,
    rect.height - destinationBorderY * 2,
    destinationBorderY,
  ];
  const sourceXs = [0, sourceBorderX, sprite.width - sourceBorderX];
  const sourceYs = [0, sourceBorderY, sprite.height - sourceBorderY];
  const destinationXs = [
    rect.x,
    rect.x + destinationBorderX,
    rect.x + rect.width - destinationBorderX,
  ];
  const destinationYs = [
    rect.y,
    rect.y + destinationBorderY,
    rect.y + rect.height - destinationBorderY,
  ];
  const parts: string[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const source = {
        x: sourceXs[column] ?? 0,
        y: sourceYs[row] ?? 0,
        width: sourceWidths[column] ?? 0,
        height: sourceHeights[row] ?? 0,
      };
      const destination = {
        x: destinationXs[column] ?? rect.x,
        y: destinationYs[row] ?? rect.y,
        width: destinationWidths[column] ?? 0,
        height: destinationHeights[row] ?? 0,
      };
      parts.push(
        row === 1 && column === 1 && element.spriteTilingCenter === true
          ? renderTiledSpriteSlice(element, sprite, source, destination)
          : renderSpriteSlice(sprite, source, destination),
      );
    }
  }
  return parts.join('');
}

function renderProgressbar(element: GuiSceneElement): string {
  const rect = element.unclippedRect;
  const sprite = element.sprite;
  const secondary = element.secondarySprite;
  const ratio = Math.max(0, Math.min(1, element.progressRatio ?? 1));
  const background = secondary === undefined ? '' : renderSpriteImage(secondary, rect);
  if (sprite?.supported !== true || sprite.dataUri === undefined) return background;
  if (ratio <= 0) return background;
  const horizontal = element.progressHorizontal !== false;
  const filled = horizontal
    ? { x: rect.x, y: rect.y, width: rect.width * ratio, height: rect.height }
    : {
        x: rect.x,
        y: rect.y + rect.height * (1 - ratio),
        width: rect.width,
        height: rect.height * ratio,
      };
  const source = horizontal
    ? { x: 0, y: 0, width: sprite.width * ratio, height: sprite.height }
    : {
        x: 0,
        y: sprite.height * (1 - ratio),
        width: sprite.width,
        height: sprite.height * ratio,
      };
  return `${background}${renderSpriteSlice(sprite, source, filled)}`;
}

function renderMaskedShield(element: GuiSceneElement): string {
  const rect = element.unclippedRect;
  const sprite = element.sprite;
  const mask = element.secondarySprite;
  if (sprite?.supported !== true || sprite.dataUri === undefined) return '';
  if (mask?.supported !== true || mask.dataUri === undefined)
    return renderSpriteImage(sprite, rect);
  const id = `gui-mask-${sha256Bytes(element.id).slice(0, 20)}`;
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" ${rectAttributes(rect)}><image ${rectAttributes(rect)} href="${mask.dataUri}" preserveAspectRatio="none"/></mask></defs><image ${rectAttributes(rect)} href="${sprite.dataUri}" preserveAspectRatio="none" mask="url(#${id})"/>`;
}

function renderElementSprite(element: GuiSceneElement): string {
  if (element.sprite?.supported !== true || element.sprite.dataUri === undefined) return '';
  if (element.spriteRenderMode === 'cornered-tile') return renderCorneredTile(element);
  if (element.spriteRenderMode === 'progressbar') return renderProgressbar(element);
  if (element.spriteRenderMode === 'masked-shield') return renderMaskedShield(element);
  return renderSpriteImage(element.sprite, element.unclippedRect);
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
    content.push(renderElementSprite(element));
  } else if (element.sprite !== undefined) {
    content.push(
      `<rect ${rectAttributes(rect)} fill="#331f3f" stroke="#ff42d0" stroke-width="1"/><path d="M ${finite(rect.x)} ${finite(rect.y)} L ${finite(rect.x + rect.width)} ${finite(rect.y + rect.height)} M ${finite(rect.x + rect.width)} ${finite(rect.y)} L ${finite(rect.x)} ${finite(rect.y + rect.height)}" stroke="#ff42d0"/>`,
    );
  }
  if (element.progressRatio !== undefined && element.spriteRenderMode !== 'progressbar') {
    content.push(
      `<rect x="${finite(rect.x)}" y="${finite(rect.y)}" width="${finite(rect.width * element.progressRatio)}" height="${finite(rect.height)}" fill="#5ecf8d" fill-opacity="0.65"/>`,
    );
  }
  content.push(renderText(element, toolText));
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="${finite(view.viewBox.x)} ${finite(view.viewBox.y)} ${finite(view.viewBox.width)} ${finite(view.viewBox.height)}"><metadata data-renderer="hoi4-agent-tools" data-mode="offline">${fidelity}</metadata><defs>${clipDefinitions.join('')}${sceneGlyphDefinitions(scene)}${toolText.definitions()}</defs><rect ${rectAttributes(view.viewBox)} fill="#17202a"/>${body}${overlays}</svg>`;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="${finite(view.viewBox.x)} ${finite(view.viewBox.y)} ${finite(view.viewBox.width)} ${finite(view.viewBox.height)}"><metadata data-renderer="hoi4-agent-tools" data-mode="offline">${fidelity}</metadata><defs>${clipDefinitions}${sceneGlyphDefinitions(scene)}${toolText.definitions()}</defs><rect ${rectAttributes(view.viewBox)} fill="#17202a"/>${body}${overlays}</svg>`;
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
  const heading = toolText.render(`${scene.windowName} \u00b7 HIERARCHY`, {
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
      ...(element.secondarySprite === undefined
        ? {}
        : {
            secondarySprite: {
              spriteName: element.secondarySprite.spriteName,
              texturePath: element.secondarySprite.texturePath,
              frame: element.secondarySprite.frame,
              frameCount: element.secondarySprite.frameCount,
              width: element.secondarySprite.width,
              height: element.secondarySprite.height,
              format: element.secondarySprite.format,
              supported: element.secondarySprite.supported,
              ...(element.secondarySprite.reason === undefined
                ? {}
                : { reason: element.secondarySprite.reason }),
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
  const heading = toolText.render(title, {
    x: 12,
    y: 24,
    fontSize: 15,
    fill: '#f5f2e8',
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${toolText.definitions()}</defs><rect width="100%" height="100%" fill="#101720"/>${heading}${content}</svg>`;
}

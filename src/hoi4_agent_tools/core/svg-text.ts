import { readFileSync } from 'node:fs';
import { create as createFont } from 'fontkit';
import type { Font } from 'fontkit';
import { compareCodeUnits, hashCanonical, sha256Bytes } from './canonical.js';

export interface SvgOutlineGlyph {
  key: string;
  path: string;
  glyphId: number;
  x: number;
  y: number;
  scale: number;
}

export interface SvgOutlineRun {
  fontHash: string;
  glyphs: SvgOutlineGlyph[];
  width: number;
}

export interface DeterministicSvgTextOptions {
  x: number;
  y: number;
  fontSize: number;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  stroke?: string;
  strokeWidth?: number;
  weight?: number;
  targetWidth?: number;
}

function selectedFont(value: ReturnType<typeof createFont>): Font {
  const font = 'fonts' in value ? value.fonts[0] : value;
  if (font === undefined) throw new Error('The deterministic tool font has no selectable face.');
  return font;
}

const toolFontSpecifiers = [
  '@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2',
  '@fontsource-variable/roboto/files/roboto-cyrillic-wght-normal.woff2',
  '@fontsource-variable/roboto/files/roboto-greek-wght-normal.woff2',
  '@fontsource-variable/roboto/files/roboto-vietnamese-wght-normal.woff2',
] as const;

const toolFonts = toolFontSpecifiers.map((specifier) => {
  const bytes = readFileSync(new URL(import.meta.resolve(specifier)));
  return { base: selectedFont(createFont(bytes)), hash: sha256Bytes(bytes) };
});

export const DETERMINISTIC_TOOL_FONT_HASH = hashCanonical(toolFonts.map(({ hash }) => hash));

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function fontForCodePoint(codePoint: number): { font: Font; hash: string } {
  for (const candidate of toolFonts) {
    if (candidate.base.glyphForCodePoint(codePoint).id !== 0)
      return { font: candidate.base, hash: candidate.hash };
  }
  const fallback = toolFonts[0]!;
  return { font: fallback.base, hash: fallback.hash };
}

export function shapeFontkitOutline(
  font: Font,
  fontHash: string,
  text: string,
  fontSize: number,
): SvgOutlineRun {
  const safeSize = Math.max(1, fontSize);
  const scale = safeSize / font.unitsPerEm;
  const run = font.layout(text);
  const glyphs: SvgOutlineGlyph[] = [];
  let penX = 0;
  for (const [index, glyph] of run.glyphs.entries()) {
    const position = run.positions[index];
    if (position === undefined) continue;
    glyphs.push({
      key: `${fontHash}:${glyph.id}`,
      path: glyph.path.toSVG(),
      glyphId: glyph.id,
      x: (penX + position.xOffset) * scale,
      y: -position.yOffset * scale,
      scale,
    });
    penX += position.xAdvance;
  }
  return { fontHash, glyphs, width: run.advanceWidth * scale };
}

interface ToolTextRun extends SvgOutlineRun {
  offset: number;
}

function shapeToolText(text: string, fontSize: number): ToolTextRun[] {
  const characters = Array.from(text);
  if (characters.length === 0) return [];
  const runs: Array<{ font: Font; hash: string; text: string }> = [];
  for (const character of characters) {
    const codePoint = character.codePointAt(0) ?? 0;
    const selected = fontForCodePoint(codePoint);
    const previous = runs.at(-1);
    if (previous?.font === selected.font && previous.hash === selected.hash)
      previous.text += character;
    else runs.push({ ...selected, text: character });
  }
  let offset = 0;
  return runs.map(({ font, hash, text: runText }) => {
    const shaped = shapeFontkitOutline(font, hash, runText, fontSize);
    const result = { ...shaped, offset };
    offset += shaped.width;
    return result;
  });
}

export class DeterministicSvgTextRenderer {
  readonly #definitions = new Map<string, string>();

  public measure(text: string, fontSize: number): number {
    return shapeToolText(text, fontSize).reduce((total, run) => total + run.width, 0);
  }

  public render(text: string, options: DeterministicSvgTextOptions): string {
    const weight = Math.max(100, Math.min(900, Math.round(options.weight ?? 400)));
    const runs = shapeToolText(text, options.fontSize);
    const measuredWidth = runs.reduce((total, run) => total + run.width, 0);
    const horizontalScale =
      options.targetWidth !== undefined && measuredWidth > 0
        ? options.targetWidth / measuredWidth
        : 1;
    const renderedWidth = measuredWidth * horizontalScale;
    const startX =
      options.anchor === 'middle'
        ? options.x - renderedWidth / 2
        : options.anchor === 'end'
          ? options.x - renderedWidth
          : options.x;
    const uses: string[] = [];
    for (const run of runs) {
      for (const glyph of run.glyphs) {
        const id = `tool-font-${sha256Bytes(glyph.key).slice(0, 20)}`;
        this.#definitions.set(id, glyph.path);
        const x = startX + (run.offset + glyph.x) * horizontalScale;
        const y = options.y + glyph.y;
        uses.push(
          `<use href="#${id}" transform="translate(${finite(x)} ${finite(y)}) scale(${finite(glyph.scale * horizontalScale)} ${finite(-glyph.scale)})"/>`,
        );
      }
    }
    const syntheticWeight = weight > 400 ? ((weight - 400) / 500) * 0.7 : 0;
    const strokeColour = options.stroke ?? (syntheticWeight > 0 ? options.fill : undefined);
    const strokeWidth = options.strokeWidth ?? syntheticWeight;
    const stroke =
      strokeColour === undefined
        ? ''
        : ` stroke="${escapeXml(strokeColour)}" stroke-width="${finite(strokeWidth)}" paint-order="stroke"`;
    return `<g aria-label="${escapeXml(text)}" data-font-sha256="${DETERMINISTIC_TOOL_FONT_HASH}" data-font-weight="${weight}" fill="${escapeXml(options.fill)}"${stroke}>${uses.join('')}</g>`;
  }

  public definitions(): string {
    return [...this.#definitions.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([id, path]) => `<path id="${id}" d="${path}"/>`)
      .join('');
  }
}

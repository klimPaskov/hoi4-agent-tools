import path from 'node:path';
import { create as createFont } from 'fontkit';
import type { Font } from 'fontkit';
import sharp from 'sharp';
import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { RenderBudget, RENDER_MAX_DECODED_PIXELS } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { DETERMINISTIC_TOOL_FONT_HASH, shapeFontkitOutline } from '../core/svg-text.js';
import { decodeDds } from './dds.js';
import {
  GUI_BMFONT_MAX_CHARACTERS,
  GUI_BINARY_FONT_MAX_BYTES,
  GUI_BMFONT_MAX_BYTES,
  GUI_BMFONT_MAX_FIELDS_PER_RECORD,
  GUI_BMFONT_MAX_KERNING_PAIRS,
  GUI_BMFONT_MAX_PAGES,
  GUI_BMFONT_MAX_RECORDS,
  GUI_TEXT_MAX_CHARACTERS,
  GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES,
} from './limits.js';
import { decodeTga } from './tga.js';
import type {
  GuiFontDefinition,
  GuiSourceGraph,
  GuiSpriteDefinition,
  GuiTextGlyphLine,
  GuiTextureFrame,
} from './types.js';

export interface LoadedRaster {
  width: number;
  height: number;
  data: Buffer;
  format: string;
  supported: boolean;
  reason?: string;
}

interface BmFontCharacter {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  xAdvance: number;
  page: number;
}

interface BmFontMetrics {
  size: number;
  lineHeight: number;
  base: number;
  baseDeclared: boolean;
  pages: string[];
  characters: Map<number, BmFontCharacter>;
  kerning: Map<string, number>;
}

interface FontMetricEntry {
  kind: 'fontkit' | 'bmfont';
  sourceFile: ScannedFile;
  font?: Font;
  bmfont?: BmFontMetrics;
}

export interface MeasuredText {
  width: number;
  lineHeight: number;
  source: 'fontkit' | 'bmfont' | 'approximation';
  missingGlyphs: number[];
}

export interface ResolvedFontMetrics {
  source: 'fontkit' | 'bmfont' | 'approximation';
  nativeSize?: number;
  nativeLineHeight?: number;
  nativeBaseline?: number;
  baselineModelled: boolean;
}

function normalizeAssetPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/^\/+|^\.\//u, '')
    .toLowerCase();
}

function parseFields(line: string): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  let fields = 0;
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=(?:"([^"]*)"|(-?\d+))/gu)) {
    fields += 1;
    if (fields > GUI_BMFONT_MAX_FIELDS_PER_RECORD) {
      throw new ServiceError(
        'GUI_FONT_FIELD_BUDGET_BLOCKED',
        'BMFont record exceeds the fixed field ceiling',
        { fields, maximumFieldsPerRecord: GUI_BMFONT_MAX_FIELDS_PER_RECORD },
      );
    }
    const key = match[1];
    const quoted = match[2];
    const numeric = match[3];
    if (key !== undefined) {
      const value = quoted ?? Number(numeric);
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new ServiceError(
          'GUI_FONT_FIELD_INVALID',
          'BMFont numeric fields must be safe integers',
          { field: key },
        );
      }
      result[key] = value;
    }
  }
  return result;
}

export function parseBmFont(text: string): BmFontMetrics | undefined {
  if (Buffer.byteLength(text, 'utf8') > GUI_BMFONT_MAX_BYTES) {
    throw new ServiceError(
      'GUI_FONT_BYTES_BLOCKED',
      'BMFont source exceeds the fixed 2 MiB admission ceiling',
      { maximumBytes: GUI_BMFONT_MAX_BYTES },
    );
  }
  let size = 16;
  let lineHeight = 16;
  let base: number | undefined;
  const pages = new Map<number, string>();
  const characters = new Map<number, BmFontCharacter>();
  const kerning = new Map<string, number>();
  let recognised = false;
  let cursor = 0;
  let records = 0;
  while (cursor <= text.length) {
    records += 1;
    if (records > GUI_BMFONT_MAX_RECORDS) {
      throw new ServiceError(
        'GUI_FONT_RECORD_BUDGET_BLOCKED',
        'BMFont source exceeds the fixed record ceiling',
        { records, maximumRecords: GUI_BMFONT_MAX_RECORDS },
      );
    }
    const next = text.indexOf('\n', cursor);
    const rawLine = text.slice(cursor, next < 0 ? text.length : next).replace(/\r$/u, '');
    const line = rawLine.trim();
    if (line.startsWith('info ')) {
      const fields = parseFields(line);
      size = Math.abs(typeof fields.size === 'number' ? fields.size : size);
      recognised = true;
    } else if (line.startsWith('common ')) {
      const fields = parseFields(line);
      lineHeight = typeof fields.lineHeight === 'number' ? fields.lineHeight : lineHeight;
      base = typeof fields.base === 'number' ? fields.base : base;
      recognised = true;
    } else if (line.startsWith('page ')) {
      const fields = parseFields(line);
      const id = typeof fields.id === 'number' ? fields.id : pages.size;
      if (!Number.isSafeInteger(id) || id < 0 || id >= GUI_BMFONT_MAX_PAGES) {
        throw new ServiceError(
          'GUI_FONT_PAGE_BUDGET_BLOCKED',
          'BMFont page id exceeds the fixed page-map ceiling',
          { pageId: id, maximumPages: GUI_BMFONT_MAX_PAGES },
        );
      }
      if (typeof fields.file === 'string') {
        if (!pages.has(id) && pages.size >= GUI_BMFONT_MAX_PAGES) {
          throw new ServiceError(
            'GUI_FONT_PAGE_BUDGET_BLOCKED',
            'BMFont source exceeds the fixed page-map ceiling',
            { pages: pages.size + 1, maximumPages: GUI_BMFONT_MAX_PAGES },
          );
        }
        pages.set(id, fields.file);
      }
      recognised = true;
    } else if (line.startsWith('char ')) {
      const fields = parseFields(line);
      const id = fields.id;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && id <= 0x10ffff) {
        if (!characters.has(id) && characters.size >= GUI_BMFONT_MAX_CHARACTERS) {
          throw new ServiceError(
            'GUI_FONT_CHARACTER_BUDGET_BLOCKED',
            'BMFont source exceeds the fixed character-map ceiling',
            {
              characters: characters.size + 1,
              maximumCharacters: GUI_BMFONT_MAX_CHARACTERS,
            },
          );
        }
        characters.set(id, {
          id,
          x: typeof fields.x === 'number' ? fields.x : 0,
          y: typeof fields.y === 'number' ? fields.y : 0,
          width: typeof fields.width === 'number' ? fields.width : 0,
          height: typeof fields.height === 'number' ? fields.height : 0,
          xOffset: typeof fields.xoffset === 'number' ? fields.xoffset : 0,
          yOffset: typeof fields.yoffset === 'number' ? fields.yoffset : 0,
          xAdvance:
            typeof fields.xadvance === 'number'
              ? fields.xadvance
              : typeof fields.width === 'number'
                ? fields.width
                : 0,
          page: typeof fields.page === 'number' ? fields.page : 0,
        });
      }
      recognised = true;
    } else if (line.startsWith('kerning ')) {
      const fields = parseFields(line);
      if (typeof fields.first === 'number' && typeof fields.second === 'number') {
        const key = `${fields.first}:${fields.second}`;
        if (!kerning.has(key) && kerning.size >= GUI_BMFONT_MAX_KERNING_PAIRS) {
          throw new ServiceError(
            'GUI_FONT_KERNING_BUDGET_BLOCKED',
            'BMFont source exceeds the fixed kerning-map ceiling',
            {
              kerningPairs: kerning.size + 1,
              maximumKerningPairs: GUI_BMFONT_MAX_KERNING_PAIRS,
            },
          );
        }
        kerning.set(key, typeof fields.amount === 'number' ? fields.amount : 0);
      }
      recognised = true;
    }
    if (next < 0) break;
    cursor = next + 1;
  }
  return recognised
    ? {
        size: Math.max(1, size),
        lineHeight: Math.max(1, lineHeight),
        base: Math.max(0, base ?? Math.min(size, lineHeight)),
        baseDeclared: base !== undefined,
        pages: [...pages.entries()].sort(([left], [right]) => left - right).map(([, page]) => page),
        characters,
        kerning,
      }
    : undefined;
}

function selectFont(value: ReturnType<typeof createFont>): Font | undefined {
  return 'fonts' in value ? value.fonts[0] : value;
}

export class GuiAssetCatalog {
  private readonly files = new Map<string, ScannedFile>();
  private readonly basenames = new Map<string, ScannedFile[]>();
  private readonly rasters = new Map<string, Promise<LoadedRaster>>();
  private readonly frames = new Map<string, Promise<GuiTextureFrame | undefined>>();
  private readonly glyphRasters = new Map<
    string,
    Promise<{ dataUri: string; width: number; height: number } | undefined>
  >();
  private readonly metrics = new Map<string, FontMetricEntry | null>();
  private readonly fontDefinitions = new Map<string, GuiFontDefinition>();

  public constructor(
    private readonly graph: GuiSourceGraph,
    scannedFiles: readonly ScannedFile[],
    private readonly budget = new RenderBudget(),
  ) {
    for (const file of scannedFiles
      .filter((candidate) => candidate.shadowedBy === undefined)
      .sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath))) {
      const normalized = normalizeAssetPath(file.relativePath);
      this.files.set(normalized, file);
      const basename = path.posix.basename(normalized);
      const candidates = this.basenames.get(basename) ?? [];
      candidates.push(file);
      this.basenames.set(basename, candidates);
    }
    for (const definition of graph.fonts)
      this.fontDefinitions.set(definition.name.toLowerCase(), definition);
  }

  public resolveFile(assetPath: string, relativeTo?: string): ScannedFile | undefined {
    const normalized = normalizeAssetPath(assetPath);
    const normalizedCandidates =
      path.posix.extname(normalized).length === 0
        ? [normalized, `${normalized}.fnt`, `${normalized}.ttf`, `${normalized}.otf`]
        : [normalized];
    for (const candidatePath of normalizedCandidates) {
      const direct = this.files.get(candidatePath);
      if (direct !== undefined) return direct;
    }
    if (relativeTo !== undefined) {
      for (const candidatePath of normalizedCandidates) {
        const relative = normalizeAssetPath(
          path.posix.join(path.posix.dirname(normalizeAssetPath(relativeTo)), candidatePath),
        );
        const candidate = this.files.get(relative);
        if (candidate !== undefined) return candidate;
      }
    }
    for (const candidatePath of normalizedCandidates) {
      const candidates = this.basenames.get(path.posix.basename(candidatePath));
      if (candidates?.length === 1) return candidates[0];
    }
    return undefined;
  }

  public async loadRaster(assetPath: string, relativeTo?: string): Promise<LoadedRaster> {
    const file = this.resolveFile(assetPath, relativeTo);
    if (file === undefined)
      return {
        width: 0,
        height: 0,
        data: Buffer.alloc(0),
        format: path.extname(assetPath).slice(1).toLowerCase() || 'unknown',
        supported: false,
        reason: `Texture not found: ${assetPath}`,
      };
    const key = `${file.displayPath}:${file.sha256}`;
    let promise = this.rasters.get(key);
    if (promise === undefined) {
      this.budget.reserveRasterOperation(
        `gui-raster:${key}`,
        `GUI asset decode ${file.displayPath}`,
      );
      promise = this.decodeRaster(file);
      this.rasters.set(key, promise);
    }
    return promise;
  }

  public loadSpriteFrame(
    sprite: GuiSpriteDefinition,
    requestedFrame: number,
  ): Promise<GuiTextureFrame | undefined> {
    const texturePath = sprite.texturePath;
    if (texturePath === undefined) return Promise.resolve(undefined);
    const frameCount = Math.max(1, sprite.frameCount);
    const frame = Math.max(0, Math.min(frameCount - 1, Math.trunc(requestedFrame)));
    const key = `${sprite.id}:${texturePath}:${frameCount}:${frame}`;
    let promise = this.frames.get(key);
    if (promise === undefined) {
      promise = this.decodeSpriteFrame(sprite, texturePath, frameCount, frame, key);
      this.frames.set(key, promise);
    }
    return promise;
  }

  private async decodeSpriteFrame(
    sprite: GuiSpriteDefinition,
    texturePath: string,
    frameCount: number,
    frame: number,
    operationKey: string,
  ): Promise<GuiTextureFrame> {
    const raster = await this.loadRaster(texturePath, sprite.sourcePath);
    if (!raster.supported || raster.width === 0 || raster.height === 0) {
      return {
        spriteName: sprite.name,
        texturePath,
        frame,
        frameCount,
        width: raster.width,
        height: raster.height,
        format: raster.format,
        supported: false,
        ...(raster.reason === undefined ? {} : { reason: raster.reason }),
      };
    }
    if (raster.width % frameCount !== 0) {
      return {
        spriteName: sprite.name,
        texturePath,
        frame,
        frameCount,
        width: raster.width,
        height: raster.height,
        format: raster.format,
        supported: false,
        reason: `Horizontal frame strip width ${raster.width} is not divisible by noOfFrames ${frameCount}.`,
      };
    }
    const frameWidth = raster.width / frameCount;
    this.budget.reserveRasterOperation(
      `gui-sprite-frame:${operationKey}`,
      `GUI sprite frame rasterization ${sprite.name}`,
    );
    this.budget.reserve(raster.width, raster.height, `GUI texture Sharp plane ${texturePath}`, {
      maximumPixels: RENDER_MAX_DECODED_PIXELS,
    });
    this.budget.reserve(frameWidth, raster.height, `GUI sprite frame ${sprite.name}`, {
      maximumPixels: RENDER_MAX_DECODED_PIXELS,
    });
    const png = await sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: 4 },
      limitInputPixels: RENDER_MAX_DECODED_PIXELS,
    })
      .extract({ left: frame * frameWidth, top: 0, width: frameWidth, height: raster.height })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    return {
      spriteName: sprite.name,
      texturePath,
      frame,
      frameCount,
      width: frameWidth,
      height: raster.height,
      dataUri: `data:image/png;base64,${png.toString('base64')}`,
      format: raster.format,
      supported: true,
    };
  }

  public measureText(fontName: string | undefined, text: string, fontSize: number): MeasuredText {
    if (text.length > GUI_TEXT_MAX_CHARACTERS) {
      throw new ServiceError(
        'GUI_TEXT_BUDGET_BLOCKED',
        'GUI text measurement exceeds the fixed character ceiling',
        { characters: text.length, maximumCharacters: GUI_TEXT_MAX_CHARACTERS },
      );
    }
    const safeSize = Math.max(1, fontSize);
    const entry = fontName === undefined ? undefined : this.loadFontMetrics(fontName);
    if (entry?.kind === 'fontkit' && entry.font !== undefined) {
      const run = entry.font.layout(text);
      const missingGlyphs = this.missingFontkitCodePoints(entry.font, text);
      const scale = safeSize / entry.font.unitsPerEm;
      return {
        width: run.advanceWidth * scale,
        lineHeight: (entry.font.ascent - entry.font.descent + entry.font.lineGap) * scale,
        source: 'fontkit',
        missingGlyphs,
      };
    }
    if (entry?.kind === 'bmfont' && entry.bmfont !== undefined) {
      const scale = safeSize / entry.bmfont.size;
      let width = 0;
      let previous: number | undefined;
      const missingGlyphs: number[] = [];
      for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        const metric = entry.bmfont.characters.get(codePoint);
        if (metric === undefined) {
          if (
            missingGlyphs.length < GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES &&
            !missingGlyphs.includes(codePoint)
          )
            missingGlyphs.push(codePoint);
          width += safeSize * 0.6;
        } else {
          if (previous !== undefined)
            width += (entry.bmfont.kerning.get(`${previous}:${codePoint}`) ?? 0) * scale;
          width += metric.xAdvance * scale;
        }
        previous = codePoint;
      }
      return {
        width,
        lineHeight: entry.bmfont.lineHeight * scale,
        source: 'bmfont',
        missingGlyphs,
      };
    }
    const graphemes = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    ).length;
    return {
      width: graphemes * safeSize * 0.58,
      lineHeight: safeSize * 1.2,
      source: 'approximation',
      missingGlyphs: [],
    };
  }

  public async shapeText(
    fontName: string | undefined,
    text: string,
    fontSize: number,
  ): Promise<GuiTextGlyphLine> {
    const entry = fontName === undefined ? undefined : this.loadFontMetrics(fontName);
    if (entry?.kind === 'fontkit' && entry.font !== undefined) {
      const shaped = shapeFontkitOutline(entry.font, entry.sourceFile.sha256, text, fontSize);
      return {
        source: 'fontkit-path',
        sourceHash: entry.sourceFile.sha256,
        width: shaped.width,
        baseline: entry.font.ascent * (Math.max(1, fontSize) / entry.font.unitsPerEm),
        baselineModelled: true,
        glyphs: shaped.glyphs.map(({ key, path: glyphPath, x, y, scale }) => ({
          kind: 'outline' as const,
          key,
          path: glyphPath,
          x,
          y,
          scale,
        })),
        missingGlyphs: this.missingFontkitCodePoints(entry.font, text),
      };
    }
    if (entry?.kind === 'bmfont' && entry.bmfont !== undefined) {
      const scale = Math.max(1, fontSize) / entry.bmfont.size;
      const glyphs: GuiTextGlyphLine['glyphs'] = [];
      const missingGlyphs: number[] = [];
      const pageHashes = new Set<string>();
      let visibleCharacters = 0;
      let penX = 0;
      let previous: number | undefined;
      for (const character of text) {
        if (!/^\s$/u.test(character)) visibleCharacters += 1;
        const codePoint = character.codePointAt(0) ?? 0;
        const metric = entry.bmfont.characters.get(codePoint);
        if (metric === undefined) {
          if (
            missingGlyphs.length < GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES &&
            !missingGlyphs.includes(codePoint)
          )
            missingGlyphs.push(codePoint);
          penX += Math.max(1, fontSize) * 0.6;
          previous = codePoint;
          continue;
        }
        if (previous !== undefined)
          penX += (entry.bmfont.kerning.get(`${previous}:${codePoint}`) ?? 0) * scale;
        const pagePath = entry.bmfont.pages[metric.page];
        const raster =
          pagePath === undefined
            ? undefined
            : await this.loadBmFontGlyph(entry, pagePath, metric, codePoint);
        if (raster !== undefined && pagePath !== undefined) {
          const page = this.resolveFile(pagePath, entry.sourceFile.relativePath);
          if (page !== undefined) pageHashes.add(page.sha256);
          glyphs.push({
            kind: 'bitmap',
            key: `${entry.sourceFile.sha256}:${codePoint}:${Math.max(1, fontSize)}`,
            dataUri: raster.dataUri,
            x: penX + metric.xOffset * scale,
            y: metric.yOffset * scale,
            width: raster.width * scale,
            height: raster.height * scale,
          });
        } else if (
          metric.width > 0 &&
          metric.height > 0 &&
          missingGlyphs.length < GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES &&
          !missingGlyphs.includes(codePoint)
        ) {
          missingGlyphs.push(codePoint);
        }
        penX += metric.xAdvance * scale;
        previous = codePoint;
      }
      return {
        source:
          visibleCharacters > 0 && glyphs.length === 0 ? 'deterministic-fallback' : 'bmfont-atlas',
        sourceHash: hashCanonical([entry.sourceFile.sha256, ...[...pageHashes].sort()]),
        width: penX,
        baseline: entry.bmfont.base * scale,
        baselineModelled: entry.bmfont.baseDeclared,
        glyphs,
        missingGlyphs,
      };
    }
    return {
      source: 'deterministic-fallback',
      sourceHash: DETERMINISTIC_TOOL_FONT_HASH,
      width: this.measureText(undefined, text, fontSize).width,
      baseline: Math.max(1, fontSize) * 0.8,
      baselineModelled: false,
      glyphs: [],
      missingGlyphs: [],
    };
  }

  public fontDefinition(fontName: string): GuiFontDefinition | undefined {
    return this.fontDefinitions.get(fontName.toLowerCase());
  }

  public resolvedFontMetrics(fontName: string | undefined): ResolvedFontMetrics {
    const entry = fontName === undefined ? undefined : this.loadFontMetrics(fontName);
    if (entry?.kind === 'bmfont' && entry.bmfont !== undefined)
      return {
        source: 'bmfont',
        nativeSize: entry.bmfont.size,
        nativeLineHeight: entry.bmfont.lineHeight,
        nativeBaseline: entry.bmfont.base,
        baselineModelled: entry.bmfont.baseDeclared,
      };
    if (entry?.kind === 'fontkit' && entry.font !== undefined)
      return { source: 'fontkit', baselineModelled: true };
    return { source: 'approximation', baselineModelled: false };
  }

  private missingFontkitCodePoints(font: Font, text: string): number[] {
    const missingGlyphs: number[] = [];
    for (const character of text) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        font.glyphForCodePoint(codePoint).id === 0 &&
        missingGlyphs.length < GUI_TEXT_MAX_MISSING_GLYPH_SAMPLES &&
        !missingGlyphs.includes(codePoint)
      )
        missingGlyphs.push(codePoint);
    }
    return missingGlyphs;
  }

  private loadFontMetrics(fontName: string): FontMetricEntry | undefined {
    const key = fontName.toLowerCase();
    if (this.metrics.has(key)) return this.metrics.get(key) ?? undefined;
    const definition = this.fontDefinitions.get(key);
    if (definition === undefined) {
      this.metrics.set(key, null);
      return undefined;
    }
    for (const assetPath of definition.assetPaths) {
      const file = this.resolveFile(assetPath, definition.sourcePath);
      if (file === undefined) continue;
      const extension = path.extname(file.relativePath).toLowerCase();
      try {
        if (extension === '.fnt') {
          if (file.bytes.length > GUI_BMFONT_MAX_BYTES) {
            throw new ServiceError(
              'GUI_FONT_BYTES_BLOCKED',
              `BMFont ${file.displayPath} exceeds the fixed source-byte ceiling`,
              { bytes: file.bytes.length, maximumBytes: GUI_BMFONT_MAX_BYTES },
            );
          }
          const bmfont = parseBmFont(file.bytes.toString('utf8'));
          if (bmfont !== undefined) {
            const result: FontMetricEntry = { kind: 'bmfont', bmfont, sourceFile: file };
            this.metrics.set(key, result);
            return result;
          }
        } else if (['.ttf', '.otf', '.woff', '.woff2'].includes(extension)) {
          if (file.bytes.length > GUI_BINARY_FONT_MAX_BYTES) {
            throw new ServiceError(
              'GUI_FONT_BYTES_BLOCKED',
              `Font ${file.displayPath} exceeds the fixed binary-font byte ceiling`,
              { bytes: file.bytes.length, maximumBytes: GUI_BINARY_FONT_MAX_BYTES },
            );
          }
          const font = selectFont(createFont(file.bytes));
          if (font !== undefined) {
            const result: FontMetricEntry = { kind: 'fontkit', font, sourceFile: file };
            this.metrics.set(key, result);
            return result;
          }
        }
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        // Invalid font assets are surfaced as missing metrics by the renderer fidelity report.
      }
    }
    this.metrics.set(key, null);
    return undefined;
  }

  private loadBmFontGlyph(
    entry: FontMetricEntry,
    pagePath: string,
    metric: BmFontCharacter,
    codePoint: number,
  ): Promise<{ dataUri: string; width: number; height: number } | undefined> {
    if (metric.width <= 0 || metric.height <= 0) return Promise.resolve(undefined);
    const key = `${entry.sourceFile.sha256}:${pagePath}:${codePoint}:${metric.x}:${metric.y}:${metric.width}:${metric.height}`;
    let promise = this.glyphRasters.get(key);
    if (promise === undefined) {
      promise = (async () => {
        const raster = await this.loadRaster(pagePath, entry.sourceFile.relativePath);
        if (
          !raster.supported ||
          metric.x < 0 ||
          metric.y < 0 ||
          metric.width <= 0 ||
          metric.height <= 0 ||
          metric.x + metric.width > raster.width ||
          metric.y + metric.height > raster.height
        )
          return undefined;
        this.budget.reserveRasterOperation(
          `gui-bmfont-glyph:${key}`,
          `GUI BMFont glyph rasterization U+${codePoint.toString(16).toUpperCase()}`,
        );
        this.budget.reserve(
          metric.width,
          metric.height,
          `GUI BMFont glyph U+${codePoint.toString(16).toUpperCase()}`,
          { maximumPixels: RENDER_MAX_DECODED_PIXELS },
        );
        const png = await sharp(raster.data, {
          raw: { width: raster.width, height: raster.height, channels: 4 },
          limitInputPixels: RENDER_MAX_DECODED_PIXELS,
        })
          .extract({ left: metric.x, top: metric.y, width: metric.width, height: metric.height })
          .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
          .toBuffer();
        return {
          dataUri: `data:image/png;base64,${png.toString('base64')}`,
          width: metric.width,
          height: metric.height,
        };
      })();
      this.glyphRasters.set(key, promise);
    }
    return promise;
  }

  private async decodeRaster(file: ScannedFile): Promise<LoadedRaster> {
    const extension = path.extname(file.relativePath).toLowerCase();
    const operationKey = `gui-raster:${file.displayPath}:${file.sha256}`;
    if (extension === '.dds') {
      const decoded = decodeDds(file.bytes, this.budget, operationKey);
      return 'unsupported' in decoded
        ? {
            width: 0,
            height: 0,
            data: Buffer.alloc(0),
            format: decoded.format,
            supported: false,
            reason: decoded.reason,
          }
        : {
            width: decoded.width,
            height: decoded.height,
            data: decoded.data,
            format: decoded.format,
            supported: true,
          };
    }
    if (extension === '.tga') {
      const decoded = decodeTga(file.bytes, this.budget, operationKey);
      return 'unsupported' in decoded
        ? {
            width: 0,
            height: 0,
            data: Buffer.alloc(0),
            format: decoded.format,
            supported: false,
            reason: decoded.reason,
          }
        : {
            width: decoded.width,
            height: decoded.height,
            data: decoded.data,
            format: decoded.format,
            supported: true,
          };
    }
    if (extension === '.svg') {
      throw new ServiceError(
        'RENDER_ASSET_SVG_BLOCKED',
        'Workspace SVG raster inputs are not accepted; use a bounded PNG source asset',
        { path: file.displayPath },
      );
    }
    if (extension !== '.png' && extension !== '.bmp') {
      return {
        width: 0,
        height: 0,
        data: Buffer.alloc(0),
        format: extension.slice(1) || 'unknown',
        supported: false,
        reason: `Raster format ${extension || '<none>'} is unsupported.`,
      };
    }
    try {
      const metadata = await sharp(file.bytes, {
        limitInputPixels: RENDER_MAX_DECODED_PIXELS,
      }).metadata();
      this.budget.reserve(metadata.width, metadata.height, `GUI asset ${file.displayPath}`, {
        maximumPixels: RENDER_MAX_DECODED_PIXELS,
      });
      const decoded = await sharp(file.bytes, { limitInputPixels: RENDER_MAX_DECODED_PIXELS })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        width: decoded.info.width,
        height: decoded.info.height,
        data: decoded.data,
        format: extension.slice(1),
        supported: true,
      };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error instanceof Error && /pixel limit/iu.test(error.message)) {
        throw new ServiceError(
          'RENDER_PIXELS_BLOCKED',
          `GUI asset ${file.displayPath} exceeds the fixed per-artifact pixel ceiling`,
          { label: `GUI asset ${file.displayPath}`, maximumPixels: RENDER_MAX_DECODED_PIXELS },
        );
      }
      return {
        width: 0,
        height: 0,
        data: Buffer.alloc(0),
        format: extension.slice(1),
        supported: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

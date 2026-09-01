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
  channelMask: number;
}

interface BmFontMetrics {
  size: number;
  lineHeight: number;
  base: number;
  baseDeclared: boolean;
  pages: string[];
  characters: Map<number, BmFontCharacter>;
  kerning: Map<string, number>;
  channelRoles?: readonly [number, number, number, number];
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
    .replace(/\/+/gu, '/')
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
  let channelRoles: readonly [number, number, number, number] | undefined;
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
      const roles = [fields.redChnl, fields.greenChnl, fields.blueChnl, fields.alphaChnl];
      if (roles.every((role) => typeof role === 'number'))
        channelRoles = roles as [number, number, number, number];
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
          channelMask: typeof fields.chnl === 'number' ? fields.chnl : 15,
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
        ...(channelRoles === undefined ? {} : { channelRoles }),
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
  private readonly countryFlags = new Map<string, Promise<GuiTextureFrame>>();
  private readonly glyphRasters = new Map<
    string,
    Promise<{ dataUri: string; borderDataUri?: string; width: number; height: number } | undefined>
  >();
  private readonly metrics = new Map<string, FontMetricEntry | null>();
  private readonly fontDefinitions = new Map<string, GuiFontDefinition>();

  public constructor(
    private readonly graph: GuiSourceGraph,
    scannedFiles: readonly ScannedFile[],
    private readonly budget = new RenderBudget(),
    language = 'l_english',
  ) {
    const sourceLoadOrder = new Map(
      scannedFiles.map((file) => [file.displayPath, file.loadOrder] as const),
    );
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
    const normalizedLanguage = language.toLocaleLowerCase('en-US');
    const eligibleFonts = graph.fonts.filter(
      (definition) =>
        definition.languages.length === 0 ||
        definition.languages.some(
          (candidate) => candidate.toLocaleLowerCase('en-US') === normalizedLanguage,
        ),
    );
    const definitionPriority = (definition: GuiFontDefinition): readonly number[] => {
      const languageMatch = definition.languages.some(
        (candidate) => candidate.toLocaleLowerCase('en-US') === normalizedLanguage,
      );
      return [
        languageMatch ? 1 : 0,
        sourceLoadOrder.get(definition.sourcePath) ?? 0,
        languageMatch === definition.override ? 1 : 0,
      ];
    };
    const higherPriority = (left: GuiFontDefinition, right: GuiFontDefinition): boolean => {
      const leftPriority = definitionPriority(left);
      const rightPriority = definitionPriority(right);
      for (let index = 0; index < leftPriority.length; index += 1) {
        if (leftPriority[index] !== rightPriority[index])
          return leftPriority[index]! > rightPriority[index]!;
      }
      return false;
    };
    for (const definition of eligibleFonts) {
      const key = definition.name.toLocaleLowerCase('en-US');
      const existing = this.fontDefinitions.get(key);
      if (existing === undefined || higherPriority(definition, existing))
        this.fontDefinitions.set(key, definition);
    }
    const baseDefinitions = new Map<string, GuiFontDefinition>();
    for (const definition of eligibleFonts) {
      if (definition.override || definition.languages.length > 0) continue;
      const key = definition.name.toLocaleLowerCase('en-US');
      const existing = baseDefinitions.get(key);
      if (existing === undefined || higherPriority(definition, existing))
        baseDefinitions.set(key, definition);
    }
    for (const [key, definition] of this.fontDefinitions) {
      if (!definition.override) continue;
      const base = baseDefinitions.get(key);
      if (base === undefined) continue;
      this.fontDefinitions.set(key, {
        ...definition,
        ...(definition.colour === undefined && base.colour !== undefined
          ? { colour: base.colour }
          : {}),
        ...(definition.borderColour === undefined && base.borderColour !== undefined
          ? { borderColour: base.borderColour }
          : {}),
        textColours: { ...base.textColours, ...definition.textColours },
      });
    }
  }

  public resolveFile(assetPath: string, relativeTo?: string): ScannedFile | undefined {
    const normalized = normalizeAssetPath(assetPath);
    const extension = path.posix.extname(normalized);
    const rasterExtensions = ['.png', '.bmp', '.tga', '.dds', '.svg'];
    const normalizedCandidates =
      extension.length === 0
        ? [
            normalized,
            `${normalized}.fnt`,
            `${normalized}.ttf`,
            `${normalized}.otf`,
            `${normalized}.woff`,
            `${normalized}.woff2`,
          ]
        : rasterExtensions.includes(extension)
          ? [
              normalized,
              ...rasterExtensions
                .filter((candidate) => candidate !== extension)
                .map((candidate) => `${normalized.slice(0, -extension.length)}${candidate}`),
            ]
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
    return this.loadSpriteTextureFrame(sprite, sprite.texturePath, requestedFrame, 'primary');
  }

  public loadSecondarySpriteFrame(
    sprite: GuiSpriteDefinition,
    requestedFrame: number,
  ): Promise<GuiTextureFrame | undefined> {
    return this.loadSpriteTextureFrame(sprite, sprite.texturePath2, requestedFrame, 'secondary');
  }

  public loadCountryFlag(
    tag: string,
    sprite?: GuiSpriteDefinition,
    ideology?: string,
    slotName?: string,
  ): Promise<GuiTextureFrame> {
    const normalizedTag = tag
      .trim()
      .replace(/[^A-Za-z0-9_]/gu, '')
      .toUpperCase();
    const normalizedIdeology = ideology
      ?.trim()
      .replace(/[^A-Za-z0-9_]/gu, '')
      .toLowerCase();
    const spriteKey = (sprite?.name ?? slotName)?.toLocaleLowerCase('en-US') ?? 'plain';
    const key = `${normalizedTag}:${normalizedIdeology ?? ''}:${spriteKey}`;
    let promise = this.countryFlags.get(key);
    if (promise !== undefined) return promise;
    promise = this.decodeCountryFlag(normalizedTag, sprite, normalizedIdeology, slotName);
    this.countryFlags.set(key, promise);
    return promise;
  }

  private async decodeCountryFlag(
    tag: string,
    sprite: GuiSpriteDefinition | undefined,
    ideology: string | undefined,
    slotName: string | undefined,
  ): Promise<GuiTextureFrame> {
    if (!/^[A-Z0-9_]{2,64}$/u.test(tag))
      return {
        spriteName: `GFX_flag_${tag || 'invalid'}`,
        texturePath: '',
        frame: 0,
        frameCount: 1,
        width: 0,
        height: 0,
        format: 'unknown',
        supported: false,
        reason: `Invalid country tag: ${tag || '<empty>'}`,
      };
    const normalizedSlotName = (sprite?.name ?? slotName)?.toLocaleLowerCase('en-US') ?? '';
    const preferredDirectories = normalizedSlotName.includes('smallest')
      ? ['small', 'medium', '']
      : normalizedSlotName.includes('small')
        ? ['medium', '', 'small']
        : normalizedSlotName.includes('medium')
          ? ['medium', '', 'small']
          : ['', 'medium', 'small'];
    const directories = [...new Set([...preferredDirectories, '', 'medium', 'small'])];
    const ideologyCandidates =
      ideology === undefined ? ['democratic', 'neutrality', 'fascism', 'communism'] : [ideology];
    const stems = [...ideologyCandidates.map((candidate) => `${tag}_${candidate}`), tag];
    const maskedShield = sprite?.spriteType.toLocaleLowerCase('en-US') === 'maskedshieldtype';
    const [overlay, mask] = maskedShield
      ? await Promise.all([
          sprite.texturePath === undefined
            ? undefined
            : this.loadRaster(sprite.texturePath, sprite.sourcePath),
          sprite.texturePath2 === undefined
            ? undefined
            : this.loadRaster(sprite.texturePath2, sprite.sourcePath),
        ])
      : [undefined, undefined];
    const targetRaster =
      mask?.supported === true ? mask : overlay?.supported === true ? overlay : undefined;
    const candidates: ScannedFile[] = [];
    for (const directory of directories) {
      for (const stem of stems) {
        for (const extension of ['tga', 'png', 'dds', 'bmp']) {
          const candidate = this.resolveFile(
            `gfx/flags/${directory.length === 0 ? '' : `${directory}/`}${stem}.${extension}`,
          );
          if (candidate !== undefined && !candidates.includes(candidate))
            candidates.push(candidate);
        }
      }
    }
    if (candidates.length === 0)
      return {
        spriteName: `GFX_flag_${tag}`,
        texturePath: `gfx/flags/${tag}.tga`,
        frame: 0,
        frameCount: 1,
        width: 0,
        height: 0,
        format: 'unknown',
        supported: false,
        reason: `Country flag texture not found for ${tag}.`,
      };
    let firstDecoded: { file: ScannedFile; raster: LoadedRaster } | undefined;
    let selected: { file: ScannedFile; raster: LoadedRaster } | undefined;
    for (const file of candidates) {
      const raster = await this.loadRaster(file.relativePath);
      firstDecoded ??= { file, raster };
      if (!raster.supported) continue;
      selected ??= { file, raster };
      if (raster.width === targetRaster?.width && raster.height === targetRaster.height) {
        selected = { file, raster };
        break;
      }
      if (targetRaster === undefined) break;
    }
    const decoded = selected ?? firstDecoded!;
    const flagFile = decoded.file;
    const flag = decoded.raster;
    if (!flag.supported)
      return {
        spriteName: `GFX_flag_${tag}`,
        texturePath: flagFile.relativePath,
        frame: 0,
        frameCount: 1,
        width: flag.width,
        height: flag.height,
        format: flag.format,
        supported: false,
        ...(flag.reason === undefined ? {} : { reason: flag.reason }),
      };
    const width = targetRaster?.width ?? flag.width;
    const height = targetRaster?.height ?? flag.height;
    this.budget.reserveRasterOperation(
      `gui-country-flag:${flagFile.displayPath}:${sprite?.name ?? slotName ?? 'plain'}`,
      `GUI country flag rasterization ${tag}`,
    );
    this.budget.reserve(width, height, `GUI country flag ${tag}`, {
      maximumPixels: RENDER_MAX_DECODED_PIXELS,
    });
    const flagPng = await sharp(flag.data, {
      raw: { width: flag.width, height: flag.height, channels: 4 },
      limitInputPixels: RENDER_MAX_DECODED_PIXELS,
    })
      .resize(width, height, { fit: 'fill', kernel: 'nearest' })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const composites: { input: Buffer; blend: 'dest-in' | 'over' }[] = [];
    if (mask?.supported === true) {
      const maskPixels = await sharp(mask.data, {
        raw: { width: mask.width, height: mask.height, channels: 4 },
        limitInputPixels: RENDER_MAX_DECODED_PIXELS,
      })
        .resize(width, height, { fit: 'fill', kernel: 'nearest' })
        .raw()
        .toBuffer();
      let alphaVaries = false;
      const firstAlpha = maskPixels[3] ?? 255;
      for (let offset = 7; offset < maskPixels.length; offset += 4) {
        if (maskPixels[offset] !== firstAlpha) {
          alphaVaries = true;
          break;
        }
      }
      const alphaMask = Buffer.alloc(maskPixels.length);
      for (let offset = 0; offset < maskPixels.length; offset += 4) {
        alphaMask[offset] = 255;
        alphaMask[offset + 1] = 255;
        alphaMask[offset + 2] = 255;
        alphaMask[offset + 3] = alphaVaries
          ? maskPixels[offset + 3]!
          : Math.round(
              maskPixels[offset]! * 0.2126 +
                maskPixels[offset + 1]! * 0.7152 +
                maskPixels[offset + 2]! * 0.0722,
            );
      }
      composites.push({
        input: await sharp(alphaMask, {
          raw: { width, height, channels: 4 },
          limitInputPixels: RENDER_MAX_DECODED_PIXELS,
        })
          .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
          .toBuffer(),
        blend: 'dest-in',
      });
    }
    if (overlay?.supported === true)
      composites.push({
        input: await sharp(overlay.data, {
          raw: { width: overlay.width, height: overlay.height, channels: 4 },
          limitInputPixels: RENDER_MAX_DECODED_PIXELS,
        })
          .resize(width, height, { fit: 'fill', kernel: 'nearest' })
          .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
          .toBuffer(),
        blend: 'over',
      });
    const png =
      composites.length === 0
        ? flagPng
        : await sharp(flagPng, { limitInputPixels: RENDER_MAX_DECODED_PIXELS })
            .composite(composites)
            .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
            .toBuffer();
    return {
      spriteName: `GFX_flag_${tag}`,
      texturePath: flagFile.relativePath,
      frame: 0,
      frameCount: 1,
      width,
      height,
      dataUri: `data:image/png;base64,${png.toString('base64')}`,
      format: flag.format,
      supported: true,
    };
  }

  private loadSpriteTextureFrame(
    sprite: GuiSpriteDefinition,
    texturePath: string | undefined,
    requestedFrame: number,
    layer: 'primary' | 'secondary',
  ): Promise<GuiTextureFrame | undefined> {
    if (texturePath === undefined) return Promise.resolve(undefined);
    const frameCount = Math.max(1, sprite.frameCount);
    const frame = Math.max(0, Math.min(frameCount - 1, Math.trunc(requestedFrame)));
    // Different sprite names frequently reuse the same frame strip. Cache by resolved texture and
    // crop instead of sprite identity so large surfaces do not rasterize identical pixels hundreds
    // of times.
    const textureFile = this.resolveFile(texturePath, sprite.sourcePath);
    const textureIdentity =
      textureFile === undefined
        ? `${sprite.sourcePath}:${texturePath}`
        : `${textureFile.displayPath}:${textureFile.sha256}`;
    const key = `${textureIdentity}:${frameCount}:${frame}:${layer}`;
    let promise = this.frames.get(key);
    if (promise === undefined) {
      promise = this.decodeSpriteFrame(sprite, texturePath, frameCount, frame, key);
      this.frames.set(key, promise);
    }
    return promise.then((decoded) =>
      decoded === undefined
        ? undefined
        : {
            ...decoded,
            spriteName: layer === 'primary' ? sprite.name : `${sprite.name}#secondary`,
            texturePath,
          },
    );
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
        // Older shipped HOI4 descriptors omit the page record entirely. Page zero still uses the
        // descriptor stem (for example garamond_12.fnt -> garamond_12.dds/tga).
        const pageFile = this.resolveBmFontPage(entry, pagePath ?? '', metric.page);
        const raster =
          pageFile === undefined
            ? undefined
            : await this.loadBmFontGlyph(entry, pageFile, metric, codePoint, scale);
        if (raster !== undefined && pageFile !== undefined) {
          pageHashes.add(pageFile.sha256);
          glyphs.push({
            kind: 'bitmap',
            key: `${entry.sourceFile.sha256}:${codePoint}:${Math.max(1, fontSize)}`,
            dataUri: raster.dataUri,
            ...(raster.borderDataUri === undefined ? {} : { borderDataUri: raster.borderDataUri }),
            x: penX + metric.xOffset * scale,
            y: metric.yOffset * scale,
            width: raster.width * (scale > 1 ? 1 : scale),
            height: raster.height * (scale > 1 ? 1 : scale),
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
    pageFile: ScannedFile,
    metric: BmFontCharacter,
    codePoint: number,
    scale: number,
  ): Promise<
    { dataUri: string; borderDataUri?: string; width: number; height: number } | undefined
  > {
    if (metric.width <= 0 || metric.height <= 0) return Promise.resolve(undefined);
    const rasterScale = scale > 1 ? scale : 1;
    const targetWidth = Math.max(1, Math.round(metric.width * rasterScale));
    const targetHeight = Math.max(1, Math.round(metric.height * rasterScale));
    const key = `${entry.sourceFile.sha256}:${pageFile.sha256}:${codePoint}:${metric.x}:${metric.y}:${metric.width}:${metric.height}:${targetWidth}:${targetHeight}`;
    let promise = this.glyphRasters.get(key);
    if (promise === undefined) {
      promise = (async () => {
        const raster = await this.loadRaster(pageFile.relativePath);
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
          targetWidth,
          targetHeight,
          `GUI BMFont glyph U+${codePoint.toString(16).toUpperCase()}`,
          { maximumPixels: RENDER_MAX_DECODED_PIXELS },
        );
        const extracted = await sharp(raster.data, {
          raw: { width: raster.width, height: raster.height, channels: 4 },
          limitInputPixels: RENDER_MAX_DECODED_PIXELS,
        })
          .extract({ left: metric.x, top: metric.y, width: metric.width, height: metric.height })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const channelRoles = entry.bmfont?.channelRoles;
        const channelRanges = [0, 1, 2, 3].map((channel) => {
          let minimum = 255;
          let maximum = 0;
          for (let offset = channel; offset < extracted.data.length; offset += 4) {
            const sample = extracted.data[offset] ?? 0;
            minimum = Math.min(minimum, sample);
            maximum = Math.max(maximum, sample);
          }
          return maximum - minimum;
        });
        const channelActivePixels = [0, 1, 2, 3].map((channel) => {
          let active = 0;
          for (let offset = channel; offset < extracted.data.length; offset += 4)
            if ((extracted.data[offset] ?? 0) > 0) active += 1;
          return active;
        });
        const channelSelected = (channel: number): boolean => {
          if (metric.channelMask === 15) return true;
          const maskForChannel = [4, 2, 1, 8][channel] ?? 0;
          return (metric.channelMask & maskForChannel) !== 0;
        };
        const informativeChannels = (role: number): number[] =>
          channelRoles === undefined
            ? []
            : channelRoles
                .map((candidate, channel) => ({ candidate, channel }))
                .filter(
                  ({ candidate, channel }) =>
                    candidate === role &&
                    channelSelected(channel) &&
                    (channelRanges[channel] ?? 0) > 0,
                )
                .map(({ channel }) => channel);
        const alphaIsInformative = (channelRanges[3] ?? 0) > 0;
        let faceChannels = informativeChannels(0);
        let borderChannels = informativeChannels(1);
        const undeclaredRgbFaceChannels =
          channelRoles === undefined
            ? []
            : [0, 1, 2].filter(
                (channel) =>
                  channelRoles[channel] === 4 &&
                  (channelRanges[channel] ?? 0) > 0 &&
                  (channelActivePixels[channel] ?? 0) > 0,
              );
        const undeclaredRgbChannelsAgree = undeclaredRgbFaceChannels.every(
          (channel) =>
            channel === undeclaredRgbFaceChannels[0] ||
            extracted.data.every(
              (sample, offset) =>
                offset % 4 !== channel ||
                sample ===
                  extracted.data[offset - channel + (undeclaredRgbFaceChannels[0] ?? channel)],
            ),
        );
        if (
          faceChannels.includes(3) &&
          borderChannels.length === 0 &&
          undeclaredRgbFaceChannels.length > 0 &&
          undeclaredRgbChannelsAgree
        ) {
          const rgbFace = undeclaredRgbFaceChannels[0]!;
          const rgbPixels = channelActivePixels[rgbFace] ?? 0;
          const alphaPixels = channelActivePixels[3] ?? 0;
          if (rgbPixels * 1.15 < alphaPixels) {
            // Some shipped HOI4 descriptors label RGB as constant even though RGB stores the
            // thin face and alpha stores the wider face-plus-outline mask. Trusting the declared
            // alpha role paints the outline in the face colour and visibly fattens the font.
            faceChannels = [rgbFace];
            borderChannels = [3];
          }
        }
        if (faceChannels.length === 0) {
          if (borderChannels.length > 0) {
            // Some vanilla fonts declare their only useful alpha bitmap as the outline
            // channel even though the atlas contains no separate face channel. In that case
            // the alpha bitmap is the face; treating constant-white RGB as coverage produces
            // an opaque rectangle for every glyph.
            faceChannels = borderChannels;
            borderChannels = [];
          } else {
            faceChannels = alphaIsInformative
              ? [3]
              : channelRanges
                  .map((range, channel) => ({ range, channel }))
                  .filter(({ range }) => range > 0)
                  .map(({ channel }) => channel);
          }
        }
        const facePixels = Buffer.alloc(extracted.data.length);
        let borderPixels: Buffer | undefined;
        if (faceChannels.length > 0) {
          borderPixels =
            borderChannels.length > 0 ? Buffer.alloc(extracted.data.length) : undefined;
          // BMFont role 0 is coverage, not a per-glyph light/dark bitmap. Vanilla atlases may
          // contain glyphs with either more filled or more empty pixels, so polarity inference
          // from an individual crop corrupts neighboring letters inconsistently.
          for (let offset = 0; offset < extracted.data.length; offset += 4) {
            let faceCoverage = 0;
            let borderCoverage = 0;
            for (const channel of faceChannels) {
              const sample = extracted.data[offset + channel] ?? 0;
              faceCoverage = Math.max(faceCoverage, sample);
            }
            for (const channel of borderChannels)
              borderCoverage = Math.max(borderCoverage, extracted.data[offset + channel] ?? 0);
            // Vanilla's compressed multi-channel atlases can bleed a neighboring glyph into
            // an RGB face crop while the alpha silhouette remains correctly bounded. The
            // face is the intersection, not the union, of those declared layers.
            if (borderChannels.length > 0) faceCoverage = Math.min(faceCoverage, borderCoverage);
            facePixels[offset] = 255;
            facePixels[offset + 1] = 255;
            facePixels[offset + 2] = 255;
            facePixels[offset + 3] = faceCoverage;
            if (borderPixels !== undefined) {
              borderPixels[offset] = 255;
              borderPixels[offset + 1] = 255;
              borderPixels[offset + 2] = 255;
              borderPixels[offset + 3] = borderCoverage;
            }
          }
        }
        const normalizeCoverage = (pixels: Buffer | undefined): void => {
          if (pixels === undefined) return;
          let maximum = 0;
          for (let offset = 3; offset < pixels.length; offset += 4)
            maximum = Math.max(maximum, pixels[offset] ?? 0);
          if (maximum <= 0 || maximum >= 255) return;
          for (let offset = 3; offset < pixels.length; offset += 4)
            pixels[offset] = Math.round(((pixels[offset] ?? 0) * 255) / maximum);
        };
        // Font coverage masks describe opaque glyph faces. Block compression in several large
        // language atlases lowers the maximum stored sample, which otherwise makes localisation
        // colours look grey or translucent even when the font definition is fully opaque.
        normalizeCoverage(facePixels);
        normalizeCoverage(borderPixels);
        const encodeMask = async (pixels: Buffer): Promise<Buffer> => {
          const source = sharp(pixels, {
            raw: { width: extracted.info.width, height: extracted.info.height, channels: 4 },
            limitInputPixels: RENDER_MAX_DECODED_PIXELS,
          });
          if (targetWidth !== extracted.info.width || targetHeight !== extracted.info.height) {
            const resized = await source
              .resize(targetWidth, targetHeight, {
                fit: 'fill',
                kernel: scale > 1 ? sharp.kernel.lanczos3 : sharp.kernel.nearest,
              })
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            if (scale > 1) {
              // BMFont antialiasing is authored for the descriptor's native point size. A plain
              // enlargement makes that one-pixel edge band several pixels wide, which is why a
              // high-DPI preview looks blurry and why differently-antialiased faces appear to
              // change size. Reconstruct the edge at the target pixel density, then retain a
              // one-pixel coverage transition just as the native atlas does.
              const edgeGain = Math.max(1, scale);
              let maximumCoverage = 0;
              for (let offset = 3; offset < resized.data.length; offset += 4)
                maximumCoverage = Math.max(maximumCoverage, resized.data[offset] ?? 0);
              // Several compressed CJK atlases intentionally use a coverage range below 128.
              // Centre the reconstruction inside the glyph's real range so a faint but valid
              // face cannot be sharpened into complete transparency.
              const edgeCentre = Math.min(127.5, maximumCoverage / 2);
              for (let offset = 3; offset < resized.data.length; offset += 4) {
                const coverage = resized.data[offset] ?? 0;
                resized.data[offset] = Math.round(
                  Math.max(0, Math.min(255, (coverage - edgeCentre) * edgeGain + edgeCentre)),
                );
              }
            }
            return sharp(resized.data, {
              raw: {
                width: resized.info.width,
                height: resized.info.height,
                channels: 4,
              },
              limitInputPixels: RENDER_MAX_DECODED_PIXELS,
            })
              .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
              .toBuffer();
          }
          return source
            .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
            .toBuffer();
        };
        const png = await encodeMask(facePixels);
        const borderPng = borderPixels === undefined ? undefined : await encodeMask(borderPixels);
        return {
          dataUri: `data:image/png;base64,${png.toString('base64')}`,
          ...(borderPng === undefined
            ? {}
            : { borderDataUri: `data:image/png;base64,${borderPng.toString('base64')}` }),
          width: targetWidth,
          height: targetHeight,
        };
      })();
      this.glyphRasters.set(key, promise);
    }
    return promise;
  }

  private resolveBmFontPage(
    entry: FontMetricEntry,
    pagePath: string,
    pageIndex: number,
  ): ScannedFile | undefined {
    const normalizedPage = normalizeAssetPath(pagePath);
    const relativePage = normalizeAssetPath(
      path.posix.join(
        path.posix.dirname(normalizeAssetPath(entry.sourceFile.relativePath)),
        normalizedPage,
      ),
    );
    const rasterExtensions = ['.png', '.bmp', '.tga', '.dds', '.svg'];
    for (const candidate of [relativePage, normalizedPage]) {
      const candidateExtension = path.posix.extname(candidate).toLowerCase();
      const candidateStem = candidate.slice(0, -candidateExtension.length);
      const variants =
        candidateExtension.length === 0
          ? rasterExtensions.map((suffix) => `${candidate}${suffix}`)
          : rasterExtensions.includes(candidateExtension)
            ? [candidate, ...rasterExtensions.map((suffix) => `${candidateStem}${suffix}`)]
            : [candidate];
      for (const variant of variants) {
        const file = this.files.get(variant);
        if (file !== undefined) return file;
      }
    }
    if (pageIndex === 0) {
      const sourcePath = normalizeAssetPath(entry.sourceFile.relativePath);
      const sourceStem = sourcePath.slice(0, -path.posix.extname(sourcePath).length);
      for (const suffix of rasterExtensions) {
        const file = this.files.get(`${sourceStem}${suffix}`);
        if (file !== undefined) return file;
      }
    }
    return this.resolveFile(pagePath, entry.sourceFile.relativePath);
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

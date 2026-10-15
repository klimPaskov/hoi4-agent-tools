import { compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import { hasBlockingDiagnostics } from '../core/diagnostics.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  assignments,
  childBlocks,
  firstScalar,
  parseClausewitz,
  type SourceDocument,
} from '../core/source/index.js';
import { BmpImage } from './bmp.js';
import { defaultMapSelectorValue, type MapWorkspaceIndex } from './model.js';

export type PreviewColor = readonly [number, number, number];
export interface PreviewPoliticalPalette {
  colors: ReadonlyMap<string, PreviewColor>;
  sources: ReadonlyMap<string, string>;
  fallbackTags: readonly string[];
}

const PREVIEW_STYLE_FILE_BYTES = 65_536;
const PREVIEW_STYLE_TOTAL_BYTES = 4_194_304;
const PREVIEW_STYLE_FILE_COUNT = 512;

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

/** Preview interpretation stays bounded and uses only authorized active source bytes. */
class PreviewStyleParser {
  #bytes = 0;
  #files = 0;
  parse(file: ScannedFile): SourceDocument | undefined {
    if (
      file.bytes.length > PREVIEW_STYLE_FILE_BYTES ||
      this.#bytes + file.bytes.length > PREVIEW_STYLE_TOTAL_BYTES ||
      this.#files >= PREVIEW_STYLE_FILE_COUNT
    )
      return undefined;
    this.#bytes += file.bytes.length;
    this.#files += 1;
    const document = parseClausewitz(file.bytes, file.displayPath);
    return hasBlockingDiagnostics(document.diagnostics) ? undefined : document;
  }
}

/** Resolve the generated/active tag binding and its byte RGB color through the shared parser. */
export function previewPoliticalPalette(
  index: MapWorkspaceIndex,
  owners: ReadonlySet<string>,
): PreviewPoliticalPalette {
  const parser = new PreviewStyleParser();
  const bindings = new Map<string, string>();
  for (const file of index.activeFiles.all) {
    if (!/^common\/country_tags\/[^/]+\.txt$/u.test(normalized(file.relativePath))) continue;
    const document = parser.parse(file);
    if (document === undefined) continue;
    for (const entry of assignments(document.root)) {
      if (
        !owners.has(entry.key.value) ||
        entry.operator.text !== '=' ||
        entry.value.type !== 'scalar'
      )
        continue;
      const path = normalized(entry.value.value);
      if (
        /^countries\/(?:[^/:]+\/)*[^/:]+\.txt$/u.test(path) &&
        !path.split('/').some((segment) => segment === '.' || segment === '..')
      )
        bindings.set(entry.key.value, `common/${path}`);
      else bindings.delete(entry.key.value);
    }
  }
  const colors = new Map<string, PreviewColor>();
  const sources = new Map<string, string>();
  const fallbackTags: string[] = [];
  for (const tag of [...owners].sort(compareCodeUnits)) {
    const binding = bindings.get(tag);
    const file = binding === undefined ? undefined : index.activeFiles.byRelativePath.get(binding);
    const document = file === undefined ? undefined : parser.parse(file);
    const blocks = document === undefined ? [] : childBlocks(document.root, 'color');
    const values =
      blocks.length === 1 &&
      document !== undefined &&
      assignments(document.root, 'color').length === 1
        ? blocks[0]!.entries.flatMap((entry) =>
            entry.type === 'scalar' && /^\d+$/u.test(entry.value)
              ? [Number(entry.value)]
              : [Number.NaN],
          )
        : [];
    if (
      values.length === 3 &&
      values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) &&
      file !== undefined
    ) {
      colors.set(tag, [values[0]!, values[1]!, values[2]!]);
      sources.set(tag, file.displayPath);
    } else {
      const digest = sha256Bytes(tag);
      colors.set(
        tag,
        [0, 2, 4].map(
          (offset) => 72 + (Number.parseInt(digest.slice(offset, offset + 2), 16) % 144),
        ) as [number, number, number],
      );
      fallbackTags.push(tag);
    }
  }
  return { colors, sources, fallbackTags };
}

export interface PreviewGraphicalTerrain {
  terrain: BmpImage | undefined;
  cities: BmpImage | undefined;
  types: ReadonlyMap<number, string>;
  snowIndices: ReadonlySet<number>;
  sourceFiles: readonly string[];
}

/** Read graphical terrain and city footprints without changing combat province definitions. */
export function previewGraphicalTerrain(index: MapWorkspaceIndex): PreviewGraphicalTerrain {
  const parser = new PreviewStyleParser();
  const types = new Map<number, string>();
  const snowIndices = new Set<number>();
  const sourceFiles: string[] = [];
  for (const file of index.activeFiles.all) {
    if (!/^common\/terrain\/[^/]+\.txt$/u.test(normalized(file.relativePath))) continue;
    const document = parser.parse(file);
    if (document === undefined) continue;
    sourceFiles.push(file.displayPath);
    for (const block of childBlocks(document.root, 'terrain'))
      for (const entry of assignments(block)) {
        if (entry.value.type !== 'block') continue;
        const type = firstScalar(entry.value, 'type')?.value;
        const colorBlocks = childBlocks(entry.value, 'color');
        if (type === undefined || colorBlocks.length !== 1) continue;
        const values = colorBlocks[0]!.entries.flatMap((value) =>
          value.type === 'scalar' && /^\d+$/u.test(value.value)
            ? [Number(value.value)]
            : [Number.NaN],
        );
        if (
          !values.length ||
          values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
        )
          continue;
        const snow = firstScalar(entry.value, 'perm_snow')?.value === 'yes';
        for (const paletteIndex of values) {
          types.set(paletteIndex, type);
          if (snow) snowIndices.add(paletteIndex);
          else snowIndices.delete(paletteIndex);
        }
      }
  }
  if (sourceFiles.length === 0)
    for (const [paletteIndex, type] of [
      [0, 'plains'],
      [1, 'forest'],
      [17, 'hills'],
      [3, 'desert'],
      [6, 'mountain'],
      [9, 'marsh'],
      [13, 'urban'],
      [14, 'lakes'],
      [15, 'ocean'],
      [21, 'jungle'],
    ] as const)
      types.set(paletteIndex, type);
  // Generated worlds retain the vanilla mountain/snow-plain slots without installed definitions.
  for (const paletteIndex of [16, 19]) if (!types.has(paletteIndex)) snowIndices.add(paletteIndex);
  const bitmap = (name: 'terrain' | 'cities'): BmpImage | undefined => {
    if (index.raster === undefined) return undefined;
    const selector = defaultMapSelectorValue(index.defaultMapFile, name, `${name}.bmp`);
    const file = index.sourceRoots.map
      .map((root) => index.activeFiles.byRelativePath.get(normalized(`${root}/${selector}`)))
      .find((value) => value !== undefined);
    if (file === undefined) return undefined;
    try {
      const image = BmpImage.decode(file.bytes);
      if (
        image.bitsPerPixel !== 8 ||
        image.width !== index.raster.width ||
        image.height !== index.raster.height
      )
        return undefined;
      sourceFiles.push(file.displayPath);
      return image;
    } catch {
      return undefined;
    }
  };
  return { terrain: bitmap('terrain'), cities: bitmap('cities'), types, snowIndices, sourceFiles };
}

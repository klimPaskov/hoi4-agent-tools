import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';

/**
 * Independent measurements of a generated world's appearance files. They deliberately do not
 * import the tool's own water, colour or validation code, so a test fails when the tool and the
 * engine formulas disagree. The water alpha is the engine's formula from `pdxwater.shader`.
 */
export type WorldFiles = ReadonlyMap<string, Buffer>;

export function engineWaterAlpha(height: number): number {
  const t = (height / 95.7 - 0.954) * 25;
  return 1 - Math.min(1, Math.max(0, t));
}

function indexedPixels(image: BmpImage): Uint8Array {
  const out = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const row = image.topDown ? y : image.height - 1 - y;
    const start = image.pixelOffset + row * image.rowStride;
    out.set(image.bytes.subarray(start, start + image.width), y * image.width);
  }
  return out;
}

export interface RasterRead {
  width: number;
  height: number;
  /** Province type per pixel: 0 sea, 1 land, 2 lake. */
  type: Uint8Array;
}

export function readProvinceTypes(files: WorldFiles, mapRoot = 'map'): RasterRead {
  const image = BmpImage.decode(files.get(`${mapRoot}/provinces.bmp`)!);
  const types = new Map<number, number>();
  for (const line of files.get(`${mapRoot}/definition.csv`)!.toString().split(/\r?\n/u)) {
    const row = line.split(';');
    if (row.length < 5 || !/^\d+$/u.test(row[0]!) || row[0] === '0') continue;
    types.set(
      (Number(row[1]) << 16) | (Number(row[2]) << 8) | Number(row[3]),
      row[4] === 'land' ? 1 : row[4] === 'lake' ? 2 : 0,
    );
  }
  const type = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y += 1)
    for (let x = 0; x < image.width; x += 1) {
      const color = image.rgbAt(x, y);
      type[y * image.width + x] = types.get((color.r << 16) | (color.g << 8) | color.b) ?? 0;
    }
  return { width: image.width, height: image.height, type };
}

export function readHeights(files: WorldFiles, mapRoot = 'map'): Uint8Array {
  return indexedPixels(BmpImage.decode(files.get(`${mapRoot}/heightmap.bmp`)!));
}

export function readTerrainIndices(files: WorldFiles, mapRoot = 'map'): Uint8Array {
  return indexedPixels(BmpImage.decode(files.get(`${mapRoot}/terrain.bmp`)!));
}

export interface Dds32 {
  width: number;
  height: number;
  /** Top-down RGBA. */
  rgba: Uint8Array;
}

export function readDds32(file: Buffer): Dds32 {
  const height = file.readUInt32LE(12);
  const width = file.readUInt32LE(16);
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = 128 + pixel * 4;
    rgba[pixel * 4] = file[offset + 2]!;
    rgba[pixel * 4 + 1] = file[offset + 1]!;
    rgba[pixel * 4 + 2] = file[offset]!;
    rgba[pixel * 4 + 3] = file[offset + 3]!;
  }
  return { width, height, rgba };
}

export interface AppearanceMetrics {
  width: number;
  height: number;
  lake: {
    pixels: number;
    heightHistogram: Record<string, number>;
    meanAlpha: number;
    shareAboveAlpha90: number;
    indexHistogram: Record<string, number>;
  };
  landColourMap: {
    meanRgb: [number, number, number];
    meanValue: number;
    distinct5Bit: number;
    valueDeviation: number;
  };
  waterColourMap: { meanRgb: [number, number, number]; deviationRgb: [number, number, number] };
  seam: { leftRows: number; rightRows: number; bothRows: number; landRowsTouchingSeam: number };
  polar: { topColumns: number; bottomColumns: number };
  heights: { landMin: number; landMedian: number; landP99: number; landMax: number };
  frameBorders: Array<{ type: string; z: number }>;
}

function histogram(values: Iterable<number>): Record<string, number> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value, count]) => [value, count]),
  );
}

export function measureAppearance(files: WorldFiles, mapRoot = 'map'): AppearanceMetrics {
  const raster = readProvinceTypes(files, mapRoot);
  const { width, height, type } = raster;
  const heights = readHeights(files, mapRoot);
  const terrain = readTerrainIndices(files, mapRoot);
  const lakeHeights: number[] = [];
  const lakeIndices: number[] = [];
  let alphaSum = 0;
  let strong = 0;
  for (let pixel = 0; pixel < type.length; pixel += 1)
    if (type[pixel] === 2) {
      const h = heights[pixel]!;
      lakeHeights.push(h);
      lakeIndices.push(terrain[pixel]!);
      const alpha = engineWaterAlpha(h);
      alphaSum += alpha;
      if (alpha >= 0.9) strong += 1;
    }
  const colourMap = readDds32(files.get(`${mapRoot}/terrain/colormap_rgb_cityemissivemask_a.dds`)!);
  const sums = [0, 0, 0];
  let valueSum = 0;
  let valueSquares = 0;
  let landCount = 0;
  const distinct = new Set<number>();
  const waterSums = [0, 0, 0];
  const waterSquares = [0, 0, 0];
  let waterCount = 0;
  for (let y = 0; y < colourMap.height; y += 1)
    for (let x = 0; x < colourMap.width; x += 1) {
      const offset = (y * colourMap.width + x) * 4;
      const kind = type[y * 2 * width + x * 2]!;
      const r = colourMap.rgba[offset]!;
      const g = colourMap.rgba[offset + 1]!;
      const b = colourMap.rgba[offset + 2]!;
      if (kind === 1) {
        sums[0]! += r;
        sums[1]! += g;
        sums[2]! += b;
        const value = Math.max(r, g, b);
        valueSum += value;
        valueSquares += value * value;
        landCount += 1;
        distinct.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      }
    }
  const water = readDds32(files.get(`${mapRoot}/terrain/colormap_water_0.dds`)!);
  for (let y = 0; y < water.height; y += 1)
    for (let x = 0; x < water.width; x += 1) {
      if (type[y * 4 * width + x * 4] === 1) continue;
      const offset = (y * water.width + x) * 4;
      waterCount += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = water.rgba[offset + channel]!;
        waterSums[channel]! += value;
        waterSquares[channel]! += value * value;
      }
    }
  let left = 0;
  let right = 0;
  let both = 0;
  for (let y = 0; y < height; y += 1) {
    const l = type[y * width] === 1;
    const r = type[y * width + width - 1] === 1;
    if (l) left += 1;
    if (r) right += 1;
    if (l && r) both += 1;
  }
  let top = 0;
  let bottom = 0;
  for (let x = 0; x < width; x += 1) {
    if (type[x] === 1) top += 1;
    if (type[(height - 1) * width + x] === 1) bottom += 1;
  }
  const landHeights: number[] = [];
  for (let pixel = 0; pixel < type.length; pixel += 1)
    if (type[pixel] === 1) landHeights.push(heights[pixel]!);
  landHeights.sort((a, b) => a - b);
  const at = (q: number) =>
    landHeights[Math.min(landHeights.length - 1, Math.floor(q * landHeights.length))] ?? 0;
  const ambient = files.get(`${mapRoot}/ambient_object.txt`)?.toString('utf8') ?? '';
  const frameBorders = [
    ...ambient.matchAll(
      /type="(frame_border_(?:bottom_|logo_)?entity)"[\s\S]*?position=\{\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\}/gu,
    ),
  ].map((match) => ({ type: match[1]!, z: Number(match[4]) }));
  const mean = (sum: number, count: number) => (count === 0 ? 0 : sum / count);
  const dev = (sum: number, squares: number, count: number) =>
    count === 0 ? 0 : Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2));
  return {
    width,
    height,
    lake: {
      pixels: lakeHeights.length,
      heightHistogram: histogram(lakeHeights),
      meanAlpha: mean(alphaSum, lakeHeights.length),
      shareAboveAlpha90: mean(strong, lakeHeights.length),
      indexHistogram: histogram(lakeIndices),
    },
    landColourMap: {
      meanRgb: [mean(sums[0]!, landCount), mean(sums[1]!, landCount), mean(sums[2]!, landCount)],
      meanValue: mean(valueSum, landCount),
      distinct5Bit: distinct.size,
      valueDeviation: dev(valueSum, valueSquares, landCount),
    },
    waterColourMap: {
      meanRgb: [
        mean(waterSums[0]!, waterCount),
        mean(waterSums[1]!, waterCount),
        mean(waterSums[2]!, waterCount),
      ],
      deviationRgb: [
        dev(waterSums[0]!, waterSquares[0]!, waterCount),
        dev(waterSums[1]!, waterSquares[1]!, waterCount),
        dev(waterSums[2]!, waterSquares[2]!, waterCount),
      ],
    },
    seam: {
      leftRows: left,
      rightRows: right,
      bothRows: both,
      landRowsTouchingSeam: (() => {
        let rows = 0;
        for (let y = 0; y < height; y += 1)
          if (type[y * width] === 1 || type[y * width + width - 1] === 1) rows += 1;
        return rows;
      })(),
    },
    polar: { topColumns: top, bottomColumns: bottom },
    heights: {
      landMin: landHeights[0] ?? 0,
      landMedian: at(0.5),
      landP99: at(0.99),
      landMax: landHeights.at(-1) ?? 0,
    },
    frameBorders,
  };
}

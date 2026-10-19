/**
 * Independent checks of a river bitmap and a height raster, written without the generator's helpers
 * so a defect in the generator cannot hide itself.
 */

export interface RiverBitmapReport {
  riverPixels: number;
  /** 2 x 2 blocks made only of river pixels. */
  blocks: number;
  /** River pixels with no orthogonal river neighbour. */
  isolated: number;
  /** River pixels on water. */
  onWater: number;
  /** Indices outside 0..11, 254 and 255. */
  invalid: number;
  components: number;
  /** Components that do not hold exactly one index 0. */
  badSources: number;
  /** Counts of index 0, 1 and 2. */
  sources: number;
  tributaryEnds: number;
  distributaryStarts: number;
}

export function checkRiverBitmap(
  bitmap: Uint8Array,
  kind: Uint8Array,
  width: number,
  height: number,
): RiverBitmapReport {
  const isRiver = (index: number): boolean => bitmap[index]! <= 11;
  let riverPixels = 0;
  let blocks = 0;
  let isolated = 0;
  let onWater = 0;
  let invalid = 0;
  let sources = 0;
  let tributaryEnds = 0;
  let distributaryStarts = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = bitmap[index]!;
      if (value > 11 && value !== 254 && value !== 255) invalid += 1;
      if (!isRiver(index)) continue;
      riverPixels += 1;
      if (kind[index] !== 1) onWater += 1;
      if (value === 0) sources += 1;
      if (value === 1) tributaryEnds += 1;
      if (value === 2) distributaryStarts += 1;
      if (
        x + 1 < width &&
        y + 1 < height &&
        isRiver(index + 1) &&
        isRiver(index + width) &&
        isRiver(index + width + 1)
      )
        blocks += 1;
      const east = x + 1 < width && isRiver(index + 1);
      const west = x > 0 && isRiver(index - 1);
      const south = y + 1 < height && isRiver(index + width);
      const north = y > 0 && isRiver(index - width);
      if (!east && !west && !south && !north) isolated += 1;
    }
  const seen = new Uint8Array(bitmap.length);
  let components = 0;
  let badSources = 0;
  const stack: number[] = [];
  for (let start = 0; start < bitmap.length; start += 1) {
    if (!isRiver(start) || seen[start] === 1) continue;
    components += 1;
    let greens = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      if (bitmap[index] === 0) greens += 1;
      const x = index % width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        index >= width ? index - width : -1,
        index < bitmap.length - width ? index + width : -1,
      ];
      for (const next of neighbours)
        if (next >= 0 && seen[next] === 0 && isRiver(next)) {
          seen[next] = 1;
          stack.push(next);
        }
    }
    if (greens !== 1) badSources += 1;
  }
  return {
    riverPixels,
    blocks,
    isolated,
    onWater,
    invalid,
    components,
    badSources,
    sources,
    tributaryEnds,
    distributaryStarts,
  };
}

/** True when the pixel is land with a water pixel (or the map edge) at one of its four sides. */
export function touchesWaterOrEdge(
  kind: Uint8Array,
  width: number,
  height: number,
  pixel: number,
): boolean {
  const x = pixel % width;
  const y = (pixel - x) / width;
  return (
    x === 0 ||
    y === 0 ||
    x === width - 1 ||
    y === height - 1 ||
    kind[pixel - 1] !== 1 ||
    kind[pixel + 1] !== 1 ||
    kind[pixel - width] !== 1 ||
    kind[pixel + width] !== 1
  );
}

/**
 * Regression of the red channel (about 128 on flat ground) on the east-west height step, optionally
 * over moderate steps only: steep walls saturate any normal, so the slope response of the map is
 * measured where the encoding is still linear.
 */
export function normalResponse(
  normals: Uint8Array,
  heights: Uint8Array,
  width: number,
  height: number,
  maximumStep = Infinity,
): number {
  const halfWidth = width / 2;
  let covariance = 0;
  let variance = 0;
  for (let y = 1; y < height / 2 - 1; y += 2)
    for (let x = 1; x < halfWidth - 1; x += 2) {
      const step = heights[2 * y * width + 2 * x + 2]! - heights[2 * y * width + 2 * x - 2]!;
      if (Math.abs(step) > maximumStep) continue;
      covariance += (normals[(y * halfWidth + x) * 3]! - 128) * step;
      variance += step * step;
    }
  return -covariance / variance;
}

export function percentile(values: ArrayLike<number>, share: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
}

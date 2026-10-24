import { smoothDiagonalContacts } from '../../src/hoi4_agent_tools/map/partition-fields.js';
import { fractal, lattice } from '../../src/hoi4_agent_tools/map/world-noise.js';

/**
 * A project-owned synthetic world for partition measurements: land from a few wobbly ellipses, a
 * lake, ridges with steep flanks, and meandering one-pixel rivers that run from the ridges to the
 * coast. Nothing here comes from the game. Heights, rivers and the land mask are bitmaps in the
 * game's own conventions (`heightmap.bmp`: land from 96; `rivers.bmp`: 0 to 11 river, 255 land,
 * 254 water), which is what `partitionFieldsFromBitmaps` reads.
 */
export interface SyntheticPartitionWorld {
  width: number;
  height: number;
  /** 0 sea, 1 land, 2 lake. */
  kind: Uint8Array;
  heights: Uint8Array;
  rivers: Uint8Array;
  /** terrain.bmp indices of the base game: 0 plains, 1 forest, 2 hills, 3 desert, 5 farmland, 6 mountain, 15 water. */
  terrain: Uint8Array;
  /** A rough moisture plane, 0 to 255. */
  moisture: Uint8Array;
  riverPixels: number;
}

interface Ridge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  peak: number;
}

export function syntheticPartitionWorld(
  width: number,
  height: number,
  seed = 7,
): SyntheticPartitionWorld {
  const total = width * height;
  const kind = new Uint8Array(total);
  const unit = Math.min(width, height);
  const blobs = [
    { x: 0.3, y: 0.5, rx: 0.2, ry: 0.36 },
    { x: 0.62, y: 0.42, rx: 0.17, ry: 0.28 },
    { x: 0.78, y: 0.7, rx: 0.1, ry: 0.14 },
    { x: 0.5, y: 0.82, rx: 0.07, ry: 0.07 },
  ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const wobble = (fractal(seed, x, y, unit / 7, 4) - 0.5) * 0.35;
      let inside = false;
      for (const b of blobs) {
        const dx = (x / width - b.x) / b.rx;
        const dy = (y / height - b.y) / b.ry;
        if (dx * dx + dy * dy + wobble < 1) inside = true;
      }
      kind[y * width + x] = inside ? 1 : 0;
    }
  // A lake in the heart of the first continent.
  const lx = Math.round(width * 0.3);
  const ly = Math.round(height * 0.5);
  const lakeRadius = Math.max(4, Math.round(unit / 28));
  for (let y = -lakeRadius; y <= lakeRadius; y++)
    for (let x = -lakeRadius; x <= lakeRadius; x++)
      if (x * x + y * y <= lakeRadius * lakeRadius && kind[(ly + y) * width + lx + x] === 1)
        kind[(ly + y) * width + lx + x] = 2;
  // A coast that touches itself only at corners cannot be partitioned; draw none.
  smoothDiagonalContacts(kind, width, height);
  // Ridges: smooth bumps along a few lines, with steep flanks.
  const ridges: Ridge[] = [
    { x0: 0.18, y0: 0.3, x1: 0.42, y1: 0.62, width: unit / 40, peak: 80 },
    { x0: 0.55, y0: 0.25, x1: 0.7, y1: 0.55, width: unit / 44, peak: 70 },
    { x0: 0.12, y0: 0.7, x1: 0.34, y1: 0.78, width: unit / 52, peak: 55 },
  ];
  const heights = new Uint8Array(total);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (kind[p] === 0) {
        heights[p] = 89;
        continue;
      }
      let value = 100 + (fractal(seed + 5, x, y, unit / 5, 4) - 0.5) * 10;
      for (const r of ridges) {
        const ax = r.x0 * width;
        const ay = r.y0 * height;
        const bx = r.x1 * width;
        const by = r.y1 * height;
        const vx = bx - ax;
        const vy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
        const dx = x - (ax + vx * t);
        const dy = y - (ay + vy * t);
        const d = Math.sqrt(dx * dx + dy * dy) / r.width;
        value += r.peak * Math.max(0, 1 - d);
      }
      heights[p] = kind[p] === 2 ? 89 : Math.max(96, Math.min(255, Math.round(value)));
    }
  // Rivers: from the ridges, downhill-ish with a meander, in orthogonal steps, to water.
  const rivers = new Uint8Array(total).fill(255);
  for (let p = 0; p < total; p++) if (kind[p] !== 1) rivers[p] = 254;
  let riverPixels = 0;
  // A dendritic net: one source per lattice cell, each wandering in a persistent direction with a
  // slow meander until it meets water or has run a third of the map.
  const spacing = Math.max(24, Math.round(unit / 6));
  let index = 0;
  for (let gy = Math.round(spacing / 2); gy < height; gy += spacing)
    for (let gx = Math.round(spacing / 2); gx < width; gx += spacing) {
      index++;
      const jx = Math.floor(lattice(seed + 3, gx, gy) * spacing * 0.5);
      const jy = Math.floor(lattice(seed + 5, gx, gy) * spacing * 0.5);
      let x = gx + jx;
      let y = gy + jy;
      const heading = Math.floor(lattice(seed + 9, gx, gy) * 4);
      const mainX = heading === 0 ? 1 : heading === 1 ? -1 : 0;
      const mainY = heading === 2 ? 1 : heading === 3 ? -1 : 0;
      const sideX = mainX === 0 ? (lattice(seed + 11, gx, gy) < 0.5 ? 1 : -1) : 0;
      const sideY = mainY === 0 ? (lattice(seed + 13, gx, gy) < 0.5 ? 1 : -1) : 0;
      for (let step = 0; step < unit; step++) {
        if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) break;
        const p = y * width + x;
        if (kind[p] !== 1) break;
        if (rivers[p] === 255) {
          rivers[p] = 5;
          riverPixels++;
        }
        const meander = fractal(seed + 31 * index, step * 2, index * 17, unit / 8, 3);
        const aside = lattice(seed + index, step >> 2, step & 3) * 0.6 + meander * 0.6 > 0.6;
        if (aside) {
          x += sideX;
          y += sideY;
        } else {
          x += mainX;
          y += mainY;
        }
      }
    }
  const moisture = new Uint8Array(total);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      moisture[y * width + x] = Math.round(fractal(seed + 77, x, y, unit / 4, 4) * 255);
  const terrain = new Uint8Array(total);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const h = heights[p]!;
      const m = moisture[p]!;
      terrain[p] =
        kind[p] !== 1
          ? 15
          : h >= 150
            ? 6
            : h >= 118
              ? 2
              : x > width * 0.55 && y > height * 0.55
                ? 3
                : m > 170
                  ? 1
                  : m > 100 && m < 150
                    ? 5
                    : 0;
    }
  return { width, height, kind, heights, rivers, terrain, moisture, riverPixels };
}

/**
 * Inland seas (ADR 0062): a model lake with `gameplay: 'inland-sea'` is navigable water with ports
 * on its shore. The engine draws a `lake` province but a fleet and a naval base need a sea province
 * next to a coastal land province, so the water body is written as sea; the rest of the pipeline
 * then partitions, names and ports it like any other sea. Small lakes stay lakes.
 */
import type { ResolvedGeography } from '../geography/index.js';
import { LAKE, SEA, labelComponents } from '../relief/grid.js';
import { factGrid, paintAreas } from './facts.js';

export interface InlandSeaConversion {
  /** Indices into `geography.lakes` that became sea, with the pixels converted. */
  readonly converted: ReadonlyArray<{ lake: number; pixels: number }>;
  /** Inland-sea lakes that left no water body to convert (drawn under land or too small). */
  readonly missing: readonly number[];
}

/**
 * Turn the lake bodies that belong to inland-sea lakes into sea. `kind` is modified in place (and
 * `elevation`, to the sea value the province generator expects).
 */
export function convertInlandSeas(
  kind: Uint8Array,
  elevation: Float32Array,
  width: number,
  height: number,
  geography: ResolvedGeography,
): InlandSeaConversion {
  const wanted = geography.lakes
    .map((lake, position) => ({ lake, position }))
    .filter(({ lake }) => lake.gameplay === 'inland-sea');
  if (wanted.length === 0) return { converted: [], missing: [] };
  const grid = factGrid(width, height);
  const painted = paintAreas(
    wanted.map(({ lake }) => lake.area),
    grid,
  );
  const components = labelComponents(width, height, (index) => kind[index] === LAKE);
  const votes = new Map<number, number>();
  for (let y = 0; y < height; y += 2) {
    const gy = Math.min(grid.height - 1, Math.floor(((y + 0.5) * grid.height) / height));
    for (let x = 0; x < width; x += 2) {
      const label = components.label[y * width + x]!;
      if (label < 0) continue;
      const value =
        painted[
          gy * grid.width + Math.min(grid.width - 1, Math.floor(((x + 0.5) * grid.width) / width))
        ]!;
      if (value === 0) continue;
      const key = label * 4_096 + (value - 1);
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  // A body belongs to the inland-sea lake with most of its samples; it must be mostly inside it.
  const total = new Map<number, number>();
  for (let y = 0; y < height; y += 2)
    for (let x = 0; x < width; x += 2) {
      const label = components.label[y * width + x]!;
      if (label >= 0) total.set(label, (total.get(label) ?? 0) + 1);
    }
  const owner = new Map<number, number>();
  for (const [key, count] of [...votes].sort((a, b) => a[0] - b[0])) {
    const label = Math.floor(key / 4_096);
    const lake = key - label * 4_096;
    if (count * 2 < (total.get(label) ?? 0)) continue;
    const best = owner.get(label);
    const bestCount = best === undefined ? 0 : (votes.get(label * 4_096 + best) ?? 0);
    if (count > bestCount) owner.set(label, lake);
  }
  const pixelsOf = new Map<number, number>();
  for (let index = 0; index < kind.length; index += 1) {
    const label = components.label[index]!;
    if (label < 0 || !owner.has(label)) continue;
    kind[index] = SEA;
    elevation[index] = -0.15;
    const lake = owner.get(label)!;
    pixelsOf.set(lake, (pixelsOf.get(lake) ?? 0) + 1);
  }
  const converted = [...pixelsOf]
    .sort((a, b) => a[0] - b[0])
    .map(([lake, pixels]) => ({ lake: wanted[lake]!.position, pixels }));
  const missing = wanted
    .filter((_, position) => !pixelsOf.has(position))
    .map(({ position }) => position);
  return { converted, missing };
}

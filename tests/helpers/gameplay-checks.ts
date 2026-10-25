import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';
import type { GeneratedWorld } from '../../src/hoi4_agent_tools/map/world.js';
import { filesOf } from './map-appearance-world.js';

export interface AdjacencyRowView {
  from: number;
  to: number;
  type: string;
  through: number;
  coordinates: number[];
  rule: string;
  comment: string;
}

export function adjacencyRows(world: GeneratedWorld): AdjacencyRowView[] {
  const text = filesOf(world).get('map/adjacencies.csv')!.toString('utf8');
  return text
    .split('\r\n')
    .slice(1)
    .filter((line) => line !== '' && !line.startsWith('-1'))
    .map((line) => {
      const p = line.split(';');
      return {
        from: Number(p[0]),
        to: Number(p[1]),
        type: p[2]!,
        through: Number(p[3]),
        coordinates: [4, 5, 6, 7].map((i) => Number(p[i])),
        rule: p[8]!,
        comment: p[9] ?? '',
      };
    });
}

export interface ProvinceMapView {
  width: number;
  height: number;
  /** Province id (1-based) of every pixel. */
  ids: Int32Array;
  typeOf: Map<number, string>;
  neighbors: Map<number, Set<number>>;
}

export function provinceMap(world: GeneratedWorld): ProvinceMapView {
  const files = filesOf(world);
  const bmp = BmpImage.decode(files.get('map/provinces.bmp')!);
  const defs = files
    .get('map/definition.csv')!
    .toString('utf8')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => line.split(';'));
  const byColor = new Map<string, number>();
  for (const d of defs) byColor.set(`${d[1]},${d[2]},${d[3]}`, Number(d[0]));
  const typeOf = new Map(defs.map((d) => [Number(d[0]), d[4]!]));
  const { width, height } = bmp;
  const ids = new Int32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = bmp.topDown ? y : height - 1 - y;
    const start = bmp.pixelOffset + row * bmp.rowStride;
    for (let x = 0; x < width; x += 1)
      ids[y * width + x] =
        byColor.get(
          `${bmp.bytes[start + x * 3 + 2]},${bmp.bytes[start + x * 3 + 1]},${bmp.bytes[start + x * 3]}`,
        ) ?? -1;
  }
  const neighbors = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    if (a === b) return;
    (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
    (neighbors.get(b) ?? neighbors.set(b, new Set()).get(b)!).add(a);
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      link(ids[y * width + x]!, ids[y * width + ((x + 1) % width)]!);
      if (y + 1 < height) link(ids[y * width + x]!, ids[(y + 1) * width + x]!);
    }
  return { width, height, ids, typeOf, neighbors };
}

/** Connected components of the land provinces over touching pairs that `allowed` accepts. */
export function landComponents(
  map: ProvinceMapView,
  allowed: (a: number, b: number) => boolean,
): Map<number, number> {
  const label = new Map<number, number>();
  let next = 0;
  for (const [start, type] of [...map.typeOf].sort((a, b) => a[0] - b[0])) {
    if (type !== 'land' || label.has(start)) continue;
    const stack = [start];
    label.set(start, next);
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const other of map.neighbors.get(current) ?? [])
        if (map.typeOf.get(other) === 'land' && !label.has(other) && allowed(current, other)) {
          label.set(other, next);
          stack.push(other);
        }
    }
    next += 1;
  }
  return label;
}

/** Spearman rank correlation of two equally long samples. */
export function spearman(left: readonly number[], right: readonly number[]): number {
  const rank = (values: readonly number[]): number[] => {
    const order = values
      .map((value, index) => ({ value, index }))
      .sort((a, b) => a.value - b.value);
    const out = new Array<number>(values.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1;
      for (let k = i; k <= j; k += 1) out[order[k]!.index] = (i + j) / 2;
      i = j + 1;
    }
    return out;
  };
  const a = rank(left);
  const b = rank(right);
  const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

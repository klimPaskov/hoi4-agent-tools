import type { ProvinceGraph } from './partition-graph.js';

/**
 * States and strategic regions as agglomerative clusters of provinces (ADR 0058). The pair of
 * clusters with the best affinity merges first, where affinity is the border they share, damped on
 * natural lines (a state seldom straddles a river or a range) and between unlike ground, divided by
 * the square root of the two perimeters so clusters stay compact, and tapered towards zero as the
 * merged size nears its maximum. Pairs that a hard line separates merge last. Everything is
 * deterministic: ties go to the lower ids.
 */

export interface ClusterOptions {
  /** Fewest members a cluster should have; smaller clusters merge with priority. */
  min: number;
  /** The size merges are happy to reach. */
  target: number;
  /** The size no merge may exceed. */
  max: number;
  /** How strongly shared border on a natural line is discounted. Default 12. */
  lambda?: number;
  /** A shared border whose mean strength is above this is a hard line. Default 0.6. */
  hardBarrier?: number;
  /** Affinity left when the two provinces are unlike ground. Default 0.55. */
  unlikeGround?: number;
}

export interface ClusterHooks {
  /** Provinces with different group values never share a cluster (a region, a sea, a country). */
  group?: (province: number) => number;
  /** Ground class of a province; unlike neighbours attract less. */
  label?: (province: number) => number;
}

interface Candidate {
  score: number;
  a: number;
  b: number;
  versionA: number;
  versionB: number;
}

/** A binary max-heap keyed by score, then by the lower ids. */
class CandidateHeap {
  readonly #items: Candidate[] = [];
  get size(): number {
    return this.#items.length;
  }
  static #before(x: Candidate, y: Candidate): boolean {
    if (x.score !== y.score) return x.score > y.score;
    if (x.a !== y.a) return x.a < y.a;
    return x.b < y.b;
  }
  push(item: Candidate): void {
    const items = this.#items;
    let i = items.length;
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!CandidateHeap.#before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }
  pop(): Candidate | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && CandidateHeap.#before(items[l]!, items[best]!)) best = l;
        if (r < items.length && CandidateHeap.#before(items[r]!, items[best]!)) best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best]!, items[i]!];
        i = best;
      }
    }
    return top;
  }
}

/**
 * Cluster `members` (province ids) over the graph. Returns the cluster of every member, numbered
 * from 0 by the smallest member id of each cluster.
 */
export function clusterProvinces(
  members: readonly number[],
  graph: ProvinceGraph,
  options: ClusterOptions,
  hooks: ClusterHooks = {},
): Map<number, number> {
  const lambda = options.lambda ?? 12;
  const hard = options.hardBarrier ?? 0.6;
  const unlike = options.unlikeGround ?? 0.55;
  const sorted = [...members].sort((a, b) => a - b);
  const local = new Map<number, number>(sorted.map((id, index) => [id, index]));
  const n = sorted.length;
  const sizeOf = new Int32Array(n).fill(1);
  const perimeter = new Float64Array(n);
  const version = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  const affinity: Array<Map<number, number>> = Array.from(
    { length: n },
    () => new Map<number, number>(),
  );
  const shared: Array<Map<number, number>> = Array.from(
    { length: n },
    () => new Map<number, number>(),
  );
  for (let i = 0; i < n; i++) {
    const id = sorted[i]!;
    for (let e = graph.offsets[id]!; e < graph.offsets[id + 1]!; e++) {
      perimeter[i]! += graph.length[e]!;
      const other = local.get(graph.to[e]!);
      if (other === undefined || other === i) continue;
      if (hooks.group !== undefined && hooks.group(id) !== hooks.group(graph.to[e]!)) continue;
      const strength = graph.barrier[e]!;
      const damp = 1 / ((1 + lambda * strength) * (1 + lambda * strength));
      let weight = graph.length[e]! * damp;
      if (strength > hard) weight *= 0.05;
      if (hooks.label !== undefined && hooks.label(id) !== hooks.label(graph.to[e]!))
        weight *= unlike;
      affinity[i]!.set(other, weight);
      shared[i]!.set(other, graph.length[e]!);
    }
  }
  const heap = new CandidateHeap();
  const scoreOf = (a: number, b: number): number => {
    const total = sizeOf[a]! + sizeOf[b]!;
    if (total > options.max) return 0;
    let factor =
      total <= options.target ? 1 : (options.max - total) / (options.max - options.target + 1);
    const small = Math.min(sizeOf[a]!, sizeOf[b]!) < options.min;
    if (small) factor = Math.max(factor, 0.05) * 2;
    if (factor <= 0) return 0;
    const base = affinity[a]!.get(b)!;
    return (base / Math.sqrt(Math.max(1, perimeter[a]!) * Math.max(1, perimeter[b]!))) * factor;
  };
  const offer = (a: number, b: number): void => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const score = scoreOf(low, high);
    if (score > 0)
      heap.push({ score, a: low, b: high, versionA: version[low]!, versionB: version[high]! });
  };
  for (let i = 0; i < n; i++)
    for (const other of affinity[i]!.keys()) if (other > i) offer(i, other);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  for (let top = heap.pop(); top !== undefined; top = heap.pop()) {
    const { a, b } = top;
    if (!alive[a] || !alive[b] || version[a] !== top.versionA || version[b] !== top.versionB)
      continue;
    // Merge b into a. Only pairs that involve a change, so only a's version moves on.
    const between = shared[a]!.get(b) ?? 0;
    perimeter[a] = perimeter[a]! + perimeter[b]! - 2 * between;
    sizeOf[a]! += sizeOf[b]!;
    alive[b] = 0;
    parent[b] = a;
    affinity[a]!.delete(b);
    shared[a]!.delete(b);
    for (const [c, weight] of affinity[b]!) {
      if (c === a) continue;
      const combined = (affinity[a]!.get(c) ?? 0) + weight;
      const length = (shared[a]!.get(c) ?? 0) + (shared[b]!.get(c) ?? 0);
      affinity[a]!.set(c, combined);
      shared[a]!.set(c, length);
      affinity[c]!.delete(b);
      shared[c]!.delete(b);
      affinity[c]!.set(a, combined);
      shared[c]!.set(a, length);
    }
    affinity[b]!.clear();
    shared[b]!.clear();
    version[a]++;
    for (const c of affinity[a]!.keys()) offer(a, c);
  }
  // Number clusters by their smallest member (members are sorted, so the first one seen).
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    return r;
  };
  const dense = new Map<number, number>();
  const result = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = root(i);
    let id = dense.get(r);
    if (id === undefined) {
      id = dense.size;
      dense.set(r, id);
    }
    result.set(sorted[i]!, id);
  }
  return result;
}

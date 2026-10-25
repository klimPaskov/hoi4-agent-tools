/**
 * The cost of laying a railway between two neighbouring provinces (ADR 0063). A railway follows
 * the cheapest route through the land, so the cost has to say what is hard to build over: distance
 * between the province centres, the ground (mountain, marsh and jungle cost more), the climb
 * across the border (a pass is a low point of the ridge, so crossing it is cheap and crossing the
 * ridge elsewhere is not), a river on the border, and a model road, which makes the way easier.
 */
import { nearestOnPolyline } from '../geography/index.js';
import { LAND, centerOf, distanceOnMap, pairKey } from './facts.js';
import type { ProvinceMetrics } from './metrics.js';
import type { GameplayBase } from './prepare.js';

export interface RailCostModel {
  /** Cost of a step between two province ids (1-based); at least 0.2. */
  cost(from: number, to: number): number;
  /** Province ids that trunk lines must reach: the cities that matter most. */
  readonly trunk: ReadonlySet<number>;
}

/** Cost per unit of distance by the ground of the province entered. */
export const RAIL_TERRAIN_FACTOR: Readonly<Record<string, number>> = {
  urban: 0.8,
  plains: 1,
  desert: 1.3,
  forest: 1.25,
  hills: 1.6,
  jungle: 2,
  marsh: 2.2,
  mountain: 3,
};

/** Height units of climb that cost one step of plain ground. */
const CLIMB_PER_STEP = 12;
const RIVER_CROSSING_COST = 1.1;
const GATE_DISCOUNT = 0.7;
const ROAD_DISCOUNT = [1, 0.85, 0.72, 0.6];

export function buildRailCost(
  base: GameplayBase,
  metrics: ProvinceMetrics,
  terrain: ReadonlyMap<number, string>,
  trunk: ReadonlySet<number>,
): RailCostModel {
  const { geography, provinces, width, height } = base.input;
  const count = base.view.count;
  let landPixels = 0;
  let landCount = 0;
  for (let id = 0; id < count; id += 1)
    if (provinces.kind[id] === LAND) {
      landPixels += provinces.size[id]!;
      landCount += 1;
    }
  const spacing = Math.max(8, Math.sqrt(landPixels / Math.max(1, landCount)));
  const gates = new Set<number>();
  for (const [a, b] of base.crossings.gates) gates.add(pairKey(a, b, count));
  const cache = new Map<number, number>();
  const edge = (a: number, b: number): number => {
    const key = pairKey(a, b, count);
    const known = cache.get(key);
    if (known !== undefined) return known;
    const ca = centerOf(provinces, a);
    const cb = centerOf(provinces, b);
    const distance = distanceOnMap(ca.x, ca.y, cb.x, cb.y, width) / spacing;
    const ground = Math.max(
      RAIL_TERRAIN_FACTOR[terrain.get(a) ?? 'plains'] ?? 1,
      RAIL_TERRAIN_FACTOR[terrain.get(b) ?? 'plains'] ?? 1,
    );
    let cost = distance * ground;
    const stat = base.borders.get(key);
    const ha = metrics.meanHeight[a]!;
    const hb = metrics.meanHeight[b]!;
    cost += Math.abs(ha - hb) / CLIMB_PER_STEP;
    if (stat !== undefined && stat.count > 0) {
      const crest = stat.top / stat.count;
      cost += Math.max(0, crest - Math.max(ha, hb)) / CLIMB_PER_STEP;
      cost += RIVER_CROSSING_COST * Math.min(1, (stat.rivers / stat.count) * 2);
      if (gates.has(key)) cost *= GATE_DISCOUNT;
      for (const road of geography.roads) {
        const near = nearestOnPolyline(
          road.path,
          geography.frame,
          stat.sumX / stat.count / width,
          stat.sumY / stat.count / height,
        );
        if (near.distance <= Math.max(0.004, (1.5 * spacing) / width)) {
          cost *= ROAD_DISCOUNT[Math.min(3, road.importance)] ?? 0.85;
          break;
        }
      }
    }
    const result = Math.max(0.2, cost);
    cache.set(key, result);
    return result;
  };
  return {
    cost: (from, to) => edge(from - 1, to - 1),
    trunk,
  };
}

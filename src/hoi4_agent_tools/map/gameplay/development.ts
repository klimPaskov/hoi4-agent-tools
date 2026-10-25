/**
 * The development model of a geography world (ADR 0063): population, state category,
 * infrastructure, factories, resources and victory points follow from the fertility the model
 * states, river access, the coast, passes and the model's sites, not from random rolls. Every
 * number is a fixed function of those inputs, so two runs agree and a change in the model moves
 * the economy in the direction the model says.
 */
import { nearestOnPolyline } from '../geography/index.js';
import { LAND, centerOf } from './facts.js';
import { fertilityOf, type ProvinceMetrics } from './metrics.js';
import type { GameplayBase } from './prepare.js';
import type { PortPlan } from './ports.js';
import { SITE_VICTORY_POINTS, SITE_WEIGHT, VICTORY_SITE_KINDS, type LocatedSite } from './sites.js';

export interface DevelopmentStateInput {
  id: number;
  provinces: readonly number[];
  owner?: string | undefined;
  isCapital: boolean;
}

export interface DevelopmentOptions {
  categories: readonly string[];
  slotsFor: Readonly<Record<string, number>>;
  /** Categories the active game defines; others fall back to the nearest allowed one. */
  allowedCategories?: ReadonlySet<string> | undefined;
  /** Province indices chosen as country capitals. */
  capitalProvinces: ReadonlySet<number>;
}

export interface StateDevelopment {
  id: number;
  manpower: number;
  category: string;
  infrastructure: number;
  civilian: number;
  military: number;
  dockyard: number;
  airBase: number;
  resources: Map<string, number>;
  victoryPoints: Map<number, number>;
  /** 0 to 1: how developed the model says the state is. */
  development: number;
  /** Mean fertility of the state's land, 0 to 1. */
  fertility: number;
}

export interface DevelopmentResult {
  readonly states: Map<number, StateDevelopment>;
  /** Provinces that become urban: capitals and every victory point of 8 or more. */
  readonly urban: Set<number>;
  /** Development of every land province, 0 to 1. */
  readonly province: Float32Array;
  readonly fertility: Float32Array;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** The ore a range gives, by its profile. */
const RANGE_RESOURCE: Readonly<Record<string, string>> = {
  ridge: 'steel',
  massif: 'tungsten',
  escarpment: 'chromium',
  wall: 'steel',
};

export function developStates(
  base: GameplayBase,
  metrics: ProvinceMetrics,
  sites: readonly LocatedSite[],
  terrain: ReadonlyMap<number, string>,
  states: readonly DevelopmentStateInput[],
  ports: PortPlan,
  options: DevelopmentOptions,
): DevelopmentResult {
  const { geography, provinces, width, height } = base.input;
  const kind = provinces.kind;
  const count = base.view.count;
  const fertility = new Float32Array(count);
  const province = new Float32Array(count);
  // Sites by province.
  const siteStrength = new Float64Array(count);
  const victorySites = new Map<number, number>();
  for (const { site, province: id } of sites) {
    if (id === undefined) continue;
    siteStrength[id] = Math.max(
      siteStrength[id]!,
      SITE_WEIGHT[site.siteKind] * (0.4 + (site.importance * 0.6) / 5),
    );
    if (VICTORY_SITE_KINDS.has(site.siteKind))
      victorySites.set(
        id,
        Math.max(victorySites.get(id) ?? 0, SITE_VICTORY_POINTS[site.importance - 1] ?? 3),
      );
  }
  const gateProvince = new Set<number>();
  for (const [a, b] of base.crossings.gates) {
    gateProvince.add(a);
    gateProvince.add(b);
  }
  const hasSea = (id: number): boolean =>
    [...provinces.neighbors[id]!].some((other) => kind[other] === 0);
  const hasLake = (id: number): boolean =>
    [...provinces.neighbors[id]!].some((other) => kind[other] === 2);
  for (let id = 0; id < count; id += 1) {
    if (kind[id] !== LAND) continue;
    const f = fertilityOf(metrics, id, terrain.get(id) ?? 'plains');
    fertility[id] = f;
    const river = clamp01(
      metrics.riverPixels[id]! / Math.max(8, 2 * Math.sqrt(provinces.size[id]!)),
    );
    province[id] = clamp01(
      0.55 * f +
        0.12 * river +
        0.1 * (hasSea(id) ? 1 : 0) +
        0.06 * (hasLake(id) ? 1 : 0) +
        0.08 * (gateProvince.has(id) ? 1 : 0) +
        0.3 * siteStrength[id]! -
        0.15 * metrics.mountain[id]!,
    );
  }
  // Ore from the ranges: provinces of mountain terrain near a range crest, richest first.
  const resourcesOf = new Map<number, Map<string, number>>();
  const addResource = (id: number, name: string, amount: number): void => {
    const own = resourcesOf.get(id) ?? new Map<string, number>();
    own.set(name, (own.get(name) ?? 0) + amount);
    resourcesOf.set(id, own);
  };
  for (const range of geography.ranges) {
    const members: number[] = [];
    for (let id = 0; id < count; id += 1) {
      if (kind[id] !== LAND || metrics.mountain[id]! < 0.3) continue;
      const centre = centerOf(provinces, id);
      const near = nearestOnPolyline(
        range.path,
        geography.frame,
        centre.x / width,
        centre.y / height,
      );
      if (near.distance <= Math.max(near.halfWidth * 1.5, 0.004)) members.push(id);
    }
    if (members.length === 0) continue;
    members.sort((a, b) => metrics.mountain[b]! - metrics.mountain[a]! || a - b);
    const deposits = Math.max(1, Math.ceil(members.length / 3));
    let peak = 0;
    for (const value of range.path.peak) peak += value;
    peak /= Math.max(1, range.path.peak.length);
    const amount = 2 + Math.round(6 * peak);
    const resource = RANGE_RESOURCE[range.profile] ?? 'steel';
    for (const id of members.slice(0, deposits)) addResource(id, resource, amount);
  }
  // Rubber in the richest jungle.
  const jungle = [...terrain]
    .filter(([id, name]) => name === 'jungle' && kind[id] === LAND)
    .map(([id]) => id)
    .sort((a, b) => fertility[b]! - fertility[a]! || a - b);
  for (const id of jungle.slice(0, Math.ceil(jungle.length * 0.4)))
    addResource(id, 'rubber', 1 + Math.round(4 * fertility[id]!));
  // Mine sites name their resource (steel when they do not).
  for (const { site, province: id } of sites)
    if (site.siteKind === 'mine' && id !== undefined)
      addResource(id, site.resource ?? 'steel', 2 + site.importance * 3);

  const result = new Map<number, StateDevelopment>();
  const urban = new Set<number>();
  const categories = options.categories;
  for (const state of states) {
    let pixels = 0;
    let fertilitySum = 0;
    let developmentSum = 0;
    let bestSite = 0;
    let bestProvince = state.provinces[0]!;
    for (const id of state.provinces) {
      const size = provinces.size[id]!;
      pixels += size;
      fertilitySum += fertility[id]! * size;
      developmentSum += province[id]! * size;
      bestSite = Math.max(bestSite, siteStrength[id]!);
      if (
        province[id]! > province[bestProvince]! ||
        (province[id] === province[bestProvince] &&
          provinces.size[id]! > provinces.size[bestProvince]!)
      )
        bestProvince = id;
    }
    const meanFertility = fertilitySum / pixels;
    const development = clamp01(
      developmentSum / pixels + 0.25 * bestSite + (state.isCapital ? 0.25 : 0),
    );
    const barren = meanFertility < 0.1 && bestSite === 0 && !state.isCapital;
    let index = Math.round(development * 5.2 + (state.isCapital ? 1 : 0) + bestSite * 1.5);
    index = Math.max(barren ? 0 : 1, Math.min(categories.length - 1, index));
    let category = categories[index]!;
    if (options.allowedCategories !== undefined && !options.allowedCategories.has(category))
      category = options.allowedCategories.has('rural')
        ? 'rural'
        : ([...options.allowedCategories][0] ?? 'rural');
    const slots = options.slotsFor[category] ?? 2;
    const civilian = Math.round(slots * (0.25 + 0.3 * development));
    const military = Math.min(slots - civilian, Math.round(slots * 0.3 * development));
    const stateResources = new Map<string, number>();
    for (const id of state.provinces)
      for (const [name, amount] of resourcesOf.get(id) ?? [])
        stateResources.set(name, (stateResources.get(name) ?? 0) + amount);
    const victoryPoints = new Map<number, number>();
    for (const id of state.provinces) {
      const value = victorySites.get(id);
      if (value !== undefined) victoryPoints.set(id, value);
    }
    for (const id of state.provinces)
      if (options.capitalProvinces.has(id))
        victoryPoints.set(id, Math.max(25, victoryPoints.get(id) ?? 0));
    if (victoryPoints.size === 0)
      victoryPoints.set(bestProvince, Math.max(1, Math.round(province[bestProvince]! * 8)));
    for (const [id, value] of victoryPoints) if (value >= 8) urban.add(id);
    const airBase = state.isCapital ? 2 : 0;
    result.set(state.id, {
      id: state.id,
      manpower: Math.max(
        1_000,
        Math.round((pixels * 180 * Math.max(0.08, development)) / 1_000) * 1_000,
      ),
      category,
      infrastructure: Math.max(
        1,
        Math.min(5, Math.round(1 + development * 3 + (state.isCapital ? 1 : 0))),
      ),
      civilian,
      military,
      dockyard: ports.dockyards.has(state.id) && slots - civilian - military > 0 ? 1 : 0,
      airBase,
      resources: stateResources,
      victoryPoints,
      development,
      fertility: meanFertility,
    });
  }
  return { states: result, urban, province, fertility };
}

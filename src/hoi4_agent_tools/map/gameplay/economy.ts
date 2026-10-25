/**
 * The second stage of the geography-driven gameplay layer (ADR 0063): once states, strategic
 * regions and owners exist, plan the ports, the development of every state, the names and the
 * railway cost model from the model, and gather the notes they raise.
 */
import { computeMetrics, type ProvinceMetrics } from './metrics.js';
import { developStates, type DevelopmentOptions, type DevelopmentResult } from './development.js';
import { nameWorld, type NameResult } from './names.js';
import { harbourScores, planPorts, type HarbourScore, type PortPlan } from './ports.js';
import type { GameplayBase } from './prepare.js';
import { buildRailCost, type RailCostModel } from './rail-cost.js';
import { locateSites, type LocatedSite } from './sites.js';

export interface EconomyState {
  id: number;
  provinces: readonly number[];
  /** Absent for land no workspace country owns (ADR 0069). */
  owner?: string | undefined;
  isCapital: boolean;
}

export interface EconomyInput {
  states: readonly EconomyState[];
  /** Province terrain by province index, before victory-point cities turn urban. */
  terrain: ReadonlyMap<number, string>;
  options: DevelopmentOptions;
  /** Strategic region number by province index. */
  regionOf: ReadonlyMap<number, number>;
  fixedStateNames?: ReadonlyMap<number, string> | undefined;
  fixedRegionNames?: ReadonlyMap<number, string> | undefined;
  countryNames: ReadonlyMap<string, string>;
}

export interface EconomyNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface EconomyPlan {
  readonly metrics: ProvinceMetrics;
  readonly sites: readonly LocatedSite[];
  readonly harbours: ReadonlyMap<number, HarbourScore>;
  readonly ports: PortPlan;
  readonly development: DevelopmentResult;
  readonly names: NameResult;
  readonly railCost: RailCostModel;
  /** Land forts by province index, from the passes with a fort level. */
  readonly forts: ReadonlyMap<number, number>;
  readonly notes: EconomyNote[];
}

export function planEconomy(base: GameplayBase, input: EconomyInput): EconomyPlan {
  const metrics = computeMetrics(base.input, base.view);
  const sites = locateSites(base);
  const harbours = harbourScores(base, metrics, sites);
  const ports = planPorts(
    base,
    harbours,
    sites,
    input.states.map((state) => ({
      id: state.id,
      provinces: state.provinces,
      owner: state.owner,
      capital: state.isCapital,
    })),
  );
  const development = developStates(
    base,
    metrics,
    sites,
    input.terrain,
    input.states,
    ports,
    input.options,
  );
  const victoryPoints = new Map<number, ReadonlyMap<number, number>>();
  for (const [id, state] of development.states) victoryPoints.set(id, state.victoryPoints);
  const names = nameWorld({
    base,
    metrics,
    sites,
    states: input.states,
    regionOf: input.regionOf,
    fixedStates: input.fixedStateNames,
    fixedRegions: input.fixedRegionNames,
    victoryPoints,
    countryNames: input.countryNames,
  });
  const terrain = new Map(input.terrain);
  for (const id of development.urban) terrain.set(id, 'urban');
  const trunk = new Set<number>();
  for (const state of development.states.values())
    for (const [province, value] of state.victoryPoints) if (value >= 8) trunk.add(province + 1);
  const railCost = buildRailCost(base, metrics, terrain, trunk);
  const forts = new Map<number, number>();
  for (const { province, level } of base.crossings.forts)
    forts.set(province, Math.max(forts.get(province) ?? 0, level));
  const notes: EconomyNote[] = [...ports.notes, ...names.notes];
  let waterSites = 0;
  for (const located of sites) {
    if (located.province === undefined && !located.site.onWater) waterSites += 1;
  }
  if (waterSites > 0)
    notes.push({
      code: 'MAP_SITE_UNPLACED',
      severity: 'warning',
      message: `${waterSites} site(s) of the model lie farther than a few pixels from any land province, so they name nothing and give no victory point`,
      details: { sites: waterSites },
    });
  notes.push({
    code: 'MAP_DEVELOPMENT_PLANNED',
    severity: 'info',
    message: `Planned ${ports.ports.size} port(s), ${development.states.size} state economies, ${names.counts.states.total - names.counts.states.placeholders} of ${names.counts.states.total} state names and ${base.crossings.summary.straits + base.crossings.summary.canals} crossing(s) from the geography model`,
    details: {
      ports: ports.ports.size,
      states: development.states.size,
      namedStates: names.counts.states.total - names.counts.states.placeholders,
      namedRegions: names.counts.regions.total - names.counts.regions.placeholders,
      sites: sites.length,
    },
  });
  return { metrics, sites, harbours, ports, development, names, railCost, forts, notes };
}

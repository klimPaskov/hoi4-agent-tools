/**
 * Ports and naval bases from the shape of the coast (ADR 0063). Every coastal province gets a
 * harbour score from how sheltered its coast is (water share in a small and a large disc around
 * the coast point), river mouths, the depth class of the sea it faces, the length of its coast
 * and the port and city sites of the model. A state gets a port where the score is high, where a
 * port site stands, or where its country has no other port on that coast.
 */
import { LAND, SEA, pairKey, type BorderStat } from './facts.js';
import type { ProvinceMetrics } from './metrics.js';
import type { GameplayBase } from './prepare.js';
import { SITE_WEIGHT, type LocatedSite } from './sites.js';

export interface HarbourScore {
  readonly province: number;
  /** The sea province the port faces: the one with the longest shared coast. */
  readonly sea: number;
  readonly score: number;
  readonly concavity: number;
  readonly shelter: number;
  readonly mouth: number;
  readonly depth: number;
  readonly sites: number;
  readonly coast: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const DEPTH_SCORE: Readonly<Record<string, number>> = { shelf: 1, open: 0.6, abyss: 0.3 };

/** Share of non-land samples in the disc of `radius` pixels around a point. */
function waterShare(base: GameplayBase, cx: number, cy: number, radius: number): number {
  const { width, height } = base.input;
  const kind = base.input.provinces.kind;
  const step = Math.max(1, Math.round(radius / 7));
  let water = 0;
  let total = 0;
  for (let dy = -radius; dy <= radius; dy += step)
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const y = Math.round(cy + dy);
      if (y < 0 || y >= height) continue;
      const x = ((Math.round(cx + dx) % width) + width) % width;
      total += 1;
      if (kind[base.view.pixel[y * width + x]!] !== LAND) water += 1;
    }
  return total === 0 ? 0.5 : water / total;
}

export function harbourScores(
  base: GameplayBase,
  metrics: ProvinceMetrics,
  sites: readonly LocatedSite[],
): Map<number, HarbourScore> {
  const { width, geography, provinces } = base.input;
  const kind = provinces.kind;
  const count = base.view.count;
  const small = Math.max(5, Math.round(0.006 * width));
  const large = Math.max(14, Math.round(0.02 * width));
  // Site strength near each province: in the province itself, or one province away.
  const siteHere = new Float64Array(count);
  for (const { site, province } of sites) {
    if (province === undefined) continue;
    const weight =
      site.siteKind === 'port'
        ? 1
        : site.siteKind === 'capital' || site.siteKind === 'city'
          ? 0.5
          : SITE_WEIGHT[site.siteKind] * 0.3;
    siteHere[province] = Math.max(siteHere[province]!, weight * (0.5 + site.importance / 10));
  }
  const out = new Map<number, HarbourScore>();
  for (let id = 0; id < count; id += 1) {
    if (kind[id] !== LAND) continue;
    let sea = -1;
    let coast = 0;
    let stat: BorderStat | undefined;
    for (const other of [...provinces.neighbors[id]!].sort((a, b) => a - b)) {
      if (kind[other] !== SEA) continue;
      const candidate = base.borders.get(pairKey(id, other, count));
      if (candidate !== undefined && candidate.count > coast) {
        coast = candidate.count;
        sea = other;
        stat = candidate;
      }
    }
    if (sea < 0 || stat === undefined) continue;
    let totalCoast = 0;
    for (const other of provinces.neighbors[id]!)
      if (kind[other] === SEA)
        totalCoast += base.borders.get(pairKey(id, other, count))?.count ?? 0;
    const cx = stat.sumX / stat.count;
    const cy = stat.sumY / stat.count;
    const w1 = waterShare(base, cx, cy, small);
    const w2 = waterShare(base, cx, cy, large);
    const concavity = clamp01((0.58 - w1) / 0.3);
    const shelter = clamp01((0.6 - w2) / 0.35);
    const mouth = clamp01(metrics.mouthWidth[id]! / 11);
    const seaFeature = base.features.sea[sea]!;
    const lakeFeature = base.features.lake[sea]!;
    const depthClass =
      lakeFeature >= 0 && seaFeature < 0
        ? geography.lakes[lakeFeature]!.depthClass
        : seaFeature >= 0
          ? geography.seas[seaFeature]!.depthClass
          : 'open';
    const depth = DEPTH_SCORE[depthClass] ?? 0.6;
    let near = siteHere[id]!;
    for (const other of provinces.neighbors[id]!)
      if (kind[other] === LAND) near = Math.max(near, siteHere[other]! * 0.6);
    const contact = clamp01(totalCoast / Math.max(6, 2 * Math.sqrt(provinces.size[id]!)));
    const score = clamp01(
      0.28 * concavity + 0.2 * shelter + 0.14 * mouth + 0.1 * depth + 0.18 * near + 0.1 * contact,
    );
    out.set(id, {
      province: id,
      sea,
      score,
      concavity,
      shelter,
      mouth,
      depth,
      sites: near,
      coast: totalCoast,
    });
  }
  return out;
}

export interface PortStateInput {
  id: number;
  provinces: readonly number[];
  owner: string;
  capital: boolean;
}

export interface PortAssignment {
  readonly province: number;
  readonly level: number;
  readonly score: number;
  readonly reason: 'score' | 'site' | 'capital' | 'coast-floor';
}

export interface PortPlan {
  /** Port level by province index. */
  readonly ports: Map<number, PortAssignment>;
  /** States that also get a dockyard. */
  readonly dockyards: Set<number>;
  readonly notes: Array<{
    code: string;
    severity: 'warning' | 'info';
    message: string;
    details?: Record<string, unknown>;
  }>;
}

/** The share of coastal states that get a port by score alone; port sites and capitals add more. */
export const PORT_STATE_SHARE = 0.45;

export function planPorts(
  base: GameplayBase,
  scores: ReadonlyMap<number, HarbourScore>,
  sites: readonly LocatedSite[],
  states: readonly PortStateInput[],
): PortPlan {
  const { provinces, geography } = base.input;
  const kind = provinces.kind;
  const ports = new Map<number, PortAssignment>();
  const dockyards = new Set<number>();
  const notes: PortPlan['notes'] = [];
  const stateOfProvince = new Map<number, PortStateInput>();
  for (const state of states) for (const id of state.provinces) stateOfProvince.set(id, state);
  // Port sites name their province directly; one outside the coast cannot hold a port.
  const portSiteOf = new Map<number, number>();
  for (const located of sites) {
    const { site, province } = located;
    if (site.siteKind !== 'port' || province === undefined) continue;
    if (site.lakeId !== undefined) {
      const lake = geography.get('lake', site.lakeId);
      if (lake !== undefined && lake.gameplay !== 'inland-sea') {
        notes.push({
          code: 'MAP_PORT_LAKE_UNSUPPORTED',
          severity: 'warning',
          message: `Port ${site.id} stands on lake ${lake.id}, which is a decorative lake: the engine gives a lake province no fleet and no naval base. Set the lake's gameplay to "inland-sea" to give it ports, or make the site a city`,
          details: { siteId: site.id, lakeId: lake.id },
        });
        continue;
      }
    }
    if (!scores.has(province)) {
      notes.push({
        code: 'MAP_PORT_SITE_NOT_COASTAL',
        severity: 'warning',
        message: `Port site ${site.id} falls in an inland province (${province + 1}); no naval base was placed. Move the site to the coast`,
        details: { siteId: site.id, province: province + 1 },
      });
      continue;
    }
    portSiteOf.set(province, Math.max(portSiteOf.get(province) ?? 0, site.importance));
  }
  const levelOf = (score: HarbourScore, capital: boolean, importance: number): number =>
    Math.max(
      1,
      Math.min(
        6,
        1 + Math.round(3 * score.score) + Math.max(0, importance - 2) + (capital ? 1 : 0),
      ),
    );
  // States ranked by their best harbour.
  const best = new Map<number, HarbourScore>();
  for (const state of states) {
    let top: HarbourScore | undefined;
    for (const id of state.provinces) {
      const score = scores.get(id);
      if (score === undefined) continue;
      if (
        top === undefined ||
        score.score > top.score ||
        (score.score === top.score && id < top.province)
      )
        top = score;
    }
    if (top !== undefined) best.set(state.id, top);
  }
  const ranked = [...best.values()].map((score) => score.score).sort((a, b) => b - a);
  const cutoff =
    ranked.length === 0
      ? 1
      : ranked[Math.min(ranked.length - 1, Math.floor(PORT_STATE_SHARE * ranked.length))]!;
  const assign = (
    state: PortStateInput,
    score: HarbourScore,
    reason: PortAssignment['reason'],
    importance: number,
  ): void => {
    const level = levelOf(score, state.capital, importance);
    const previous = ports.get(score.province);
    if (previous !== undefined && previous.level >= level) return;
    ports.set(score.province, { province: score.province, level, score: score.score, reason });
    if (level >= 3 || state.capital) dockyards.add(state.id);
  };
  for (const state of states) {
    const sited = state.provinces
      .filter((id) => portSiteOf.has(id))
      .sort((a, b) => portSiteOf.get(b)! - portSiteOf.get(a)! || a - b);
    for (const id of sited) assign(state, scores.get(id)!, 'site', portSiteOf.get(id)!);
    const top = best.get(state.id);
    if (top === undefined || sited.length > 0) continue;
    if (state.capital) assign(state, top, 'capital', 0);
    else if (top.score >= cutoff && top.score > 0.25) assign(state, top, 'score', 0);
  }
  // Every coastal territory of a country keeps at least one port.
  const seen = new Set<number>();
  for (const state of states) {
    for (const start of state.provinces) {
      if (seen.has(start) || kind[start] !== LAND) continue;
      const queue = [start];
      seen.add(start);
      let hasPort = false;
      let top: HarbourScore | undefined;
      for (const id of queue) {
        if (ports.has(id)) hasPort = true;
        const score = scores.get(id);
        if (score !== undefined && (top === undefined || score.score > top.score)) top = score;
        for (const next of provinces.neighbors[id]!)
          if (
            !seen.has(next) &&
            kind[next] === LAND &&
            stateOfProvince.get(next)?.owner === state.owner
          ) {
            seen.add(next);
            queue.push(next);
          }
      }
      if (!hasPort && top !== undefined) {
        const owner = stateOfProvince.get(top.province);
        if (owner !== undefined) assign(owner, top, 'coast-floor', 0);
      }
    }
  }
  return { ports, dockyards, notes };
}

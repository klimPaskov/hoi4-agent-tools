/**
 * Names for states, strategic regions, victory points and lakes from the geography model
 * (ADR 0063). A feature is named by what the model puts there: a site, a lake shore, a river
 * valley, a range, a bay, a region, a land or a sea. Names are made unique with compass
 * qualifiers and, as a last resort, numerals. A feature the model gives no name falls back to the
 * generic "District N" or "Region N" and is counted, so a world with many placeholders says so.
 */
import { nearestOnPolyline, type ResolvedGeography } from '../geography/index.js';
import { LAND, SEA, centerOf } from './facts.js';
import type { ProvinceMetrics } from './metrics.js';
import type { GameplayBase } from './prepare.js';
import { SITE_WEIGHT, landProvinceNear, type LocatedSite } from './sites.js';

export interface NameState {
  id: number;
  provinces: readonly number[];
  owner?: string | undefined;
}

export interface NameInput {
  base: GameplayBase;
  metrics: ProvinceMetrics;
  sites: readonly LocatedSite[];
  states: readonly NameState[];
  /** Strategic region number by province index. */
  regionOf: ReadonlyMap<number, number>;
  /** Names already fixed by the caller (reference labels), which win over the model. */
  fixedStates?: ReadonlyMap<number, string> | undefined;
  fixedRegions?: ReadonlyMap<number, string> | undefined;
  /** Victory-point provinces by state id, with the value each carries. */
  victoryPoints: ReadonlyMap<number, ReadonlyMap<number, number>>;
  countryNames: ReadonlyMap<string, string>;
}

export interface NameCounts {
  total: number;
  placeholders: number;
}

export interface NameResult {
  states: Map<number, string>;
  regions: Map<number, string>;
  victory: Map<number, string>;
  lakes: Map<number, string>;
  counts: { states: NameCounts; regions: NameCounts; victoryPoints: NameCounts };
  notes: Array<{
    code: string;
    severity: 'warning' | 'info';
    message: string;
    details?: Record<string, unknown>;
  }>;
}

const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function roman(position: number): string {
  return position < ROMAN.length ? ROMAN[position]! : String(position + 1);
}
/** The compass word for an offset from a group's centre; screen y grows southwards. */
function compass(dx: number, dy: number, near: boolean): string {
  if (near) return 'Central';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay * 2.414 < ax) return dx > 0 ? 'Eastern' : 'Western';
  if (ax * 2.414 < ay) return dy > 0 ? 'Southern' : 'Northern';
  return `${dy > 0 ? 'South' : 'North'}${dx > 0 ? 'eastern' : 'western'}`;
}

/** A name without its leading article, for composing "<name> Shore" and the like. */
function bare(name: string): string {
  return name.replace(/^(the|a|an)\s+/iu, '');
}

const SETTLEMENT_KINDS: ReadonlySet<string> = new Set(['capital', 'city', 'port', 'fortress']);

interface Candidate {
  name: string;
  /** Lower ranks win when a state has several. */
  rank: number;
}

interface Located {
  x: number;
  y: number;
}

/**
 * Make a list of base names unique: names shared by several items get a compass qualifier by
 * position, then numerals for items still tied. `order` fixes the numeral order.
 */
export function uniqueNames(
  bases: ReadonlyArray<{ key: number; name: string; at: Located }>,
): Map<number, string> {
  const out = new Map<number, string>();
  const groups = new Map<string, Array<{ key: number; at: Located }>>();
  for (const { key, name, at } of bases) {
    const list = groups.get(name) ?? [];
    list.push({ key, at });
    groups.set(name, list);
  }
  const taken = new Set<string>();
  for (const [name, members] of [...groups].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (members.length === 1) {
      out.set(members[0]!.key, name);
      taken.add(name);
      continue;
    }
    let cx = 0;
    let cy = 0;
    for (const { at } of members) {
      cx += at.x;
      cy += at.y;
    }
    cx /= members.length;
    cy /= members.length;
    let reach = 0;
    for (const { at } of members)
      reach = Math.max(reach, Math.abs(at.x - cx) + Math.abs(at.y - cy));
    const labelled = members.map(({ key, at }) => {
      const dx = at.x - cx;
      const dy = at.y - cy;
      const near = members.length > 2 && Math.abs(dx) + Math.abs(dy) < reach * 0.3;
      let label: string;
      if (members.length === 2) {
        const spreadX = Math.abs(members[0]!.at.x - members[1]!.at.x);
        const spreadY = Math.abs(members[0]!.at.y - members[1]!.at.y);
        label =
          spreadX >= spreadY ? (dx > 0 ? 'Eastern' : 'Western') : dy > 0 ? 'Southern' : 'Northern';
      } else label = compass(dx, dy, near);
      return { key, label };
    });
    const byLabel = new Map<string, number[]>();
    for (const { key, label } of labelled) {
      const list = byLabel.get(label) ?? [];
      list.push(key);
      byLabel.set(label, list);
    }
    for (const [label, keys] of [...byLabel].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      keys.sort((a, b) => a - b);
      for (const [position, key] of keys.entries()) {
        const text = `${label} ${name}${position === 0 ? '' : ` ${roman(position)}`}`;
        out.set(key, text);
        taken.add(text);
      }
    }
  }
  return out;
}

function placeNames(base: GameplayBase): Map<number, string[]> {
  const { geography, width, height } = base.input;
  const out = new Map<number, string[]>();
  const reach = Math.max(8, Math.round(width * 0.02));
  for (const place of geography.places) {
    if (place.name === undefined) continue;
    const found = landProvinceNear(base, place.at.x * width, place.at.y * height, reach);
    if (found === undefined) continue;
    const list = out.get(found.province) ?? [];
    list.push(place.name);
    out.set(found.province, list);
  }
  return out;
}

/** The named river that runs through most of a province's pixels, as an index into `rivers`. */
function riverOfProvince(base: GameplayBase, geography: ResolvedGeography): Int32Array {
  const out = new Int32Array(base.view.count).fill(-1);
  const paths = base.input.riverPaths;
  if (paths === undefined) return out;
  const named = new Map(geography.rivers.map((river, index) => [river.id, index]));
  const votes = new Map<number, number>();
  const pixel = base.view.pixel;
  for (const path of paths) {
    const index = named.get(path.id);
    if (index === undefined || geography.rivers[index]!.name === undefined) continue;
    for (let at = 0; at < path.pixels.length; at += 2) {
      const province = pixel[path.pixels[at]!]!;
      const key = province * 4_096 + index;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  const best = new Int32Array(base.view.count);
  for (const [key, count] of [...votes].sort((a, b) => a[0] - b[0])) {
    const province = Math.floor(key / 4_096);
    if (count >= 6 && count > best[province]!) {
      best[province] = count;
      out[province] = key - province * 4_096;
    }
  }
  return out;
}

/** The nearest range with a name within one and a half half-widths of a province's centre. */
function rangeOfProvince(base: GameplayBase, metrics: ProvinceMetrics): Int32Array {
  const { geography, width, height, provinces } = base.input;
  const out = new Int32Array(base.view.count).fill(-1);
  for (let id = 0; id < base.view.count; id += 1) {
    if (provinces.kind[id] !== LAND || metrics.mountain[id]! < 0.2) continue;
    const centre = centerOf(provinces, id);
    let best = Number.POSITIVE_INFINITY;
    for (const [index, range] of geography.ranges.entries()) {
      if (range.name === undefined) continue;
      const near = nearestOnPolyline(
        range.path,
        geography.frame,
        centre.x / width,
        centre.y / height,
      );
      const ratio = near.distance / Math.max(near.halfWidth, 0.002);
      if (ratio <= 1.6 && ratio < best) {
        best = ratio;
        out[id] = index;
      }
    }
  }
  return out;
}

function mostCommon(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values)
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  return best;
}

export function nameWorld(input: NameInput): NameResult {
  const { base, metrics, sites, states } = input;
  const { geography, provinces } = base.input;
  const kind = provinces.kind;
  const features = base.features;
  const rivers = riverOfProvince(base, geography);
  const ranges = rangeOfProvince(base, metrics);
  const places = placeNames(base);
  const siteByProvince = new Map<number, LocatedSite[]>();
  for (const located of sites) {
    if (located.province === undefined || located.site.name === undefined) continue;
    const list = siteByProvince.get(located.province) ?? [];
    list.push(located);
    siteByProvince.set(located.province, list);
  }
  const countryName = (tag: string | undefined): string =>
    tag === undefined ? 'Free Land' : (input.countryNames.get(tag) ?? tag);
  const notes: NameResult['notes'] = [];

  // Lake provinces: the lake's own name.
  const lakes = new Map<number, string>();
  for (let id = 0; id < base.view.count; id += 1)
    if (kind[id] === 2) {
      const lake = features.lake[id]!;
      const name = lake >= 0 ? geography.lakes[lake]!.name : undefined;
      if (name !== undefined) lakes.set(id, name);
    }

  // States.
  const stateCandidates = new Map<number, Candidate[]>();
  const stateAt = new Map<number, Located>();
  for (const state of states) {
    const candidates: Candidate[] = [];
    let sx = 0;
    let sy = 0;
    let weight = 0;
    const lakeVotes: Array<string | undefined> = [];
    const riverVotes: Array<string | undefined> = [];
    const rangeVotes: Array<string | undefined> = [];
    const placeVotes: Array<string | undefined> = [];
    const regionVotes: Array<string | undefined> = [];
    const landVotes: Array<string | undefined> = [];
    let rangeProvinces = 0;
    for (const id of state.provinces) {
      const centre = centerOf(provinces, id);
      sx += centre.x * provinces.size[id]!;
      sy += centre.y * provinces.size[id]!;
      weight += provinces.size[id]!;
      for (const other of provinces.neighbors[id]!)
        if (kind[other] === 2 || (kind[other] === SEA && features.lake[other]! >= 0))
          lakeVotes.push(geography.lakes[features.lake[other]!]?.name);
      const river = rivers[id]!;
      if (river >= 0) riverVotes.push(geography.rivers[river]!.name);
      const range = ranges[id]!;
      if (range >= 0) {
        rangeVotes.push(geography.ranges[range]!.name);
        rangeProvinces += 1;
      }
      for (const place of places.get(id) ?? []) placeVotes.push(place);
      const regionIndex = features.region[id]!;
      regionVotes.push(regionIndex >= 0 ? geography.regions[regionIndex]!.name : undefined);
      const landIndex = features.land[id]!;
      landVotes.push(landIndex >= 0 ? geography.lands[landIndex]!.name : undefined);
      for (const located of siteByProvince.get(id) ?? []) {
        const strength = SITE_WEIGHT[located.site.siteKind] * (1 + located.site.importance);
        const settlement = SETTLEMENT_KINDS.has(located.site.siteKind);
        candidates.push({
          name: located.site.name!,
          rank: settlement ? 20 - strength : 45 + (6 - strength) / 10,
        });
      }
    }
    stateAt.set(state.id, { x: sx / weight, y: sy / weight });
    const lake = mostCommon(lakeVotes);
    if (lake !== undefined) candidates.push({ name: `${bare(lake)} Shore`, rank: 30 });
    const river = mostCommon(riverVotes);
    if (river !== undefined && riverVotes.length >= Math.max(2, state.provinces.length * 0.4))
      candidates.push({ name: `${bare(river)} Valley`, rank: 40 });
    const range = mostCommon(rangeVotes);
    if (range !== undefined && rangeProvinces * 2 >= state.provinces.length)
      candidates.push({ name: `${bare(range)} Foothills`, rank: 50 });
    const place = mostCommon(placeVotes);
    if (place !== undefined) candidates.push({ name: `${bare(place)} Coast`, rank: 60 });
    const region = mostCommon(regionVotes);
    if (region !== undefined) candidates.push({ name: region, rank: 70 });
    const land = mostCommon(landVotes);
    if (land !== undefined) candidates.push({ name: land, rank: 80 });
    candidates.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : 1));
    stateCandidates.set(state.id, candidates);
  }
  const stateBases: Array<{ key: number; name: string; at: Located }> = [];
  const stateNames = new Map<number, string>();
  let statePlaceholders = 0;
  for (const state of states) {
    const fixed = input.fixedStates?.get(state.id);
    if (fixed !== undefined) {
      stateNames.set(state.id, fixed);
      continue;
    }
    const best = stateCandidates.get(state.id)![0];
    if (best === undefined) {
      stateNames.set(state.id, `${countryName(state.owner)} District ${state.id}`);
      statePlaceholders += 1;
      continue;
    }
    stateBases.push({ key: state.id, name: best.name, at: stateAt.get(state.id)! });
  }
  // A site name is itself unique by construction when no other state shares it.
  for (const [key, name] of uniqueNames(stateBases)) stateNames.set(key, name);

  // Strategic regions.
  const regionMembers = new Map<number, number[]>();
  for (const [id, region] of input.regionOf) {
    const list = regionMembers.get(region) ?? [];
    list.push(id);
    regionMembers.set(region, list);
  }
  const regionNames = new Map<number, string>();
  const regionBases: Array<{ key: number; name: string; at: Located }> = [];
  let regionPlaceholders = 0;
  for (const [region, members] of [...regionMembers].sort((a, b) => a[0] - b[0])) {
    const fixed = input.fixedRegions?.get(region);
    if (fixed !== undefined) {
      regionNames.set(region, fixed);
      continue;
    }
    let sx = 0;
    let sy = 0;
    let weight = 0;
    const weights = new Map<string, number>();
    const vote = (name: string | undefined, size: number): void => {
      if (name !== undefined) weights.set(name, (weights.get(name) ?? 0) + size);
    };
    for (const id of members) {
      const centre = centerOf(provinces, id);
      sx += centre.x * provinces.size[id]!;
      sy += centre.y * provinces.size[id]!;
      weight += provinces.size[id]!;
      const size = provinces.size[id]!;
      if (kind[id] === SEA) {
        const sea = features.sea[id]!;
        const lake = features.lake[id]!;
        vote(sea >= 0 ? geography.seas[sea]!.name : undefined, size);
        if (sea < 0 && lake >= 0) vote(geography.lakes[lake]!.name, size);
      } else if (kind[id] === LAND) {
        const regionIndex = features.region[id]!;
        vote(regionIndex >= 0 ? geography.regions[regionIndex]!.name : undefined, size);
        const landIndex = features.land[id]!;
        if (regionIndex < 0)
          vote(landIndex >= 0 ? geography.lands[landIndex]!.name : undefined, size);
      }
    }
    let name: string | undefined;
    let best = 0;
    for (const [candidate, size] of [...weights].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
      if (size > best) {
        name = candidate;
        best = size;
      }
    if (name === undefined) {
      regionNames.set(region, `Region ${region}`);
      regionPlaceholders += 1;
      continue;
    }
    regionBases.push({ key: region, name, at: { x: sx / weight, y: sy / weight } });
  }
  for (const [key, name] of uniqueNames(regionBases)) regionNames.set(key, name);

  // Victory points: sites by their own name, the rest by what stands around them.
  const usedVictory = new Set<string>();
  const victory = new Map<number, string>();
  let victoryPlaceholders = 0;
  let victoryTotal = 0;
  const pending: Array<{ key: number; name: string; at: Located }> = [];
  for (const state of states) {
    const points = input.victoryPoints.get(state.id);
    if (points === undefined) continue;
    for (const id of [...points.keys()].sort((a, b) => a - b)) {
      victoryTotal += 1;
      const own = siteByProvince.get(id);
      const named = own?.sort(
        (a, b) =>
          SITE_WEIGHT[b.site.siteKind] * b.site.importance -
            SITE_WEIGHT[a.site.siteKind] * a.site.importance || (a.site.id < b.site.id ? -1 : 1),
      )[0];
      const centre = centerOf(provinces, id);
      if (named !== undefined) {
        pending.push({ key: id, name: named.site.name!, at: centre });
        continue;
      }
      const riverIndex = rivers[id]!;
      const lakeShore = [...provinces.neighbors[id]!]
        .map((other) =>
          features.lake[other]! >= 0 && kind[other] !== LAND
            ? geography.lakes[features.lake[other]!]!.name
            : undefined,
        )
        .find((name) => name !== undefined);
      const stateName = stateNames.get(state.id)!;
      const placeholderState = stateName.includes(' District ');
      const derived =
        riverIndex >= 0
          ? `${bare(geography.rivers[riverIndex]!.name!)} Ford`
          : lakeShore !== undefined
            ? `${bare(lakeShore)} Landing`
            : (places.get(id)?.[0] ?? (placeholderState ? undefined : `${stateName} Town`));
      if (derived === undefined) {
        victory.set(id, `${countryName(state.owner)} Settlement ${id + 1}`);
        victoryPlaceholders += 1;
      } else pending.push({ key: id, name: derived, at: centre });
    }
  }
  for (const [key, name] of uniqueNames(pending)) {
    let text = name;
    for (let n = 2; usedVictory.has(text); n += 1) text = `${name} ${roman(n - 1)}`;
    usedVictory.add(text);
    victory.set(key, text);
  }

  const counts = {
    states: { total: states.length, placeholders: statePlaceholders },
    regions: { total: regionMembers.size, placeholders: regionPlaceholders },
    victoryPoints: { total: victoryTotal, placeholders: victoryPlaceholders },
  };
  const total = counts.states.total + counts.regions.total + counts.victoryPoints.total;
  const placeholders =
    counts.states.placeholders + counts.regions.placeholders + counts.victoryPoints.placeholders;
  if (placeholders > 0)
    notes.push({
      code: 'MAP_NAME_PLACEHOLDER',
      severity: 'warning',
      message: `${placeholders} of ${total} states, strategic regions and victory points (${((placeholders / Math.max(1, total)) * 100).toFixed(1)}%) have no name in the geography model and keep a placeholder ("District N", "Region N", "Settlement N"): ${counts.states.placeholders} of ${counts.states.total} states, ${counts.regions.placeholders} of ${counts.regions.total} strategic regions, ${counts.victoryPoints.placeholders} of ${counts.victoryPoints.total} victory points. Name more regions, lands, seas, rivers, lakes or sites in the model`,
      details: {
        placeholders,
        total,
        share: Math.round((placeholders / Math.max(1, total)) * 1000) / 1000,
        ...counts,
      },
    });
  return { states: stateNames, regions: regionNames, victory, lakes, counts, notes };
}

/**
 * Straits, canals, passes and impassable ranges of a world built from a geography model
 * (ADR 0062). A model strait becomes a named `sea` crossing in `adjacencies.csv` with its rule in
 * `adjacency_rules.txt`; a range declared `barrier: 'impassable'` becomes `impassable` rows for
 * the land provinces on its two sides, except at the declared passes, which stay open; passes
 * with a fort level place land forts on the provinces that hold the gate.
 *
 * The planner reads only the province raster, its graph and the resolved model. It never writes
 * files; `world.ts` writes the rows and the rules text it returns.
 */
import { ServiceError } from '../../core/result.js';
import {
  clearBandStrip,
  createBandStrip,
  rasterizeBandStrip,
  rowStrips,
  sampleAlong,
  type GeoPoint,
  type ResolvedGeography,
  type ResolvedPass,
  type ResolvedRange,
  type ResolvedStrait,
} from '../geography/index.js';
import {
  LAKE,
  LAND,
  SEA,
  centerOf,
  closestApproach,
  collectContacts,
  distanceOnMap,
  pairKey,
  pairOf,
  type BorderStat,
  type CenterSource,
  type ProvinceFeatures,
  type ProvinceRasterView,
} from './facts.js';

/** Hard cap on `impassable` rows (the base game has 93). */
export const IMPASSABLE_ROW_LIMIT = 2_000;
/** Largest gap of an automatically detected strait, in pixels (the base game's largest is 30). */
export const DEFAULT_AUTO_STRAIT_GAP_PX = 24;
/** A model strait whose shores are farther apart than this (or 1.5 times its width) is reported. */
export const STRAIT_NARROW_LIMIT_PX = 48;
/** Most automatically detected straits one world may add. */
export const AUTO_STRAIT_LIMIT = 400;

export interface CrossingNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface AdjacencyRow {
  /** Province ids (1-based). */
  from: number;
  to: number;
  type: 'sea' | 'impassable';
  through: number;
  /** Pixel coordinates of the crossing line, y counted from the bottom; absent writes -1. */
  line?: { startX: number; startY: number; stopX: number; stopY: number };
  rule: string;
  comment: string;
}

export interface AdjacencyRule {
  name: string;
  comment: string;
  access: 'open' | 'army-closed' | 'navy-closed';
  required: number[];
  icon: number;
}

export interface FortSite {
  /** Province index (0-based) and land fort level. */
  province: number;
  level: number;
  pass: string;
}

export interface CrossingInput {
  width: number;
  height: number;
  geography: ResolvedGeography;
  view: ProvinceRasterView;
  /** Province kind by index: 0 sea, 1 land, 2 lake. */
  kind: readonly number[];
  neighbors: ReadonlyArray<ReadonlySet<number>>;
  center: CenterSource;
  features: ProvinceFeatures;
  borders: ReadonlyMap<number, BorderStat>;
  /** Add a crossing for every pair of landmasses a single sea province separates narrowly. */
  autoStraits?: { maxGapPx: number } | undefined;
  /** Indices (into `geography.lakes`) of the lakes written as inland seas. */
  inlandSeas: readonly number[];
  /** Most `impassable` rows allowed; default `IMPASSABLE_ROW_LIMIT`. */
  impassableLimit?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface PassReport {
  id: string;
  range: string;
  /** Province indices that form the open crossing(s) of the gate. */
  open: Array<[number, number]>;
}

export interface CrossingPlan {
  rows: AdjacencyRow[];
  rules: AdjacencyRule[];
  notes: CrossingNote[];
  forts: FortSite[];
  passes: PassReport[];
  /** Pairs (province indices) blocked by an impassable range. */
  blocked: Array<[number, number]>;
  /** Unordered province pairs freed at a pass (they carry no row). */
  gates: Array<[number, number]>;
  summary: {
    straits: number;
    autoStraits: number;
    canals: number;
    impassableRows: number;
    ranges: number;
    passes: number;
  };
}

function ruleNameFor(id: string, used: Set<string>): string {
  const base =
    id
      .toUpperCase()
      .replace(/[^A-Z0-9]+/gu, '_')
      .replace(/^_+|_+$/gu, '') || 'CROSSING';
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

function commentOf(name: string | undefined, id: string): string {
  return (name ?? id).replace(/[;\r\n]+/gu, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** Pixels (as indices) along a polyline of frame points, in order, without immediate repeats. */
function pixelsAlong(points: readonly GeoPoint[], width: number, height: number): number[] {
  const out: number[] = [];
  const px = (value: number, size: number): number =>
    Math.max(0, Math.min(size - 1, Math.floor(value * size)));
  for (let index = 0; index + 1 < points.length; index += 1) {
    const ax = px(points[index]!.x, width);
    const ay = px(points[index]!.y, height);
    const bx = px(points[index + 1]!.x, width);
    const by = px(points[index + 1]!.y, height);
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.floor(ax + ((bx - ax) * step) / steps + 0.5);
      const y = Math.floor(ay + ((by - ay) * step) / steps + 0.5);
      const pixel = y * width + x;
      if (out[out.length - 1] !== pixel) out.push(pixel);
    }
  }
  if (points.length === 1) out.push(px(points[0]!.y, height) * width + px(points[0]!.x, width));
  return out;
}

/** The nearest pair of ring vertices between two lands, as frame points. */
function nearestVertices(
  geography: ResolvedGeography,
  first: string,
  second: string,
): [GeoPoint, GeoPoint] | undefined {
  const a = geography.get('land', first);
  const b = geography.get('land', second);
  if (a === undefined || b === undefined) return undefined;
  const aspect = geography.frame.height / geography.frame.width;
  let best = Number.POSITIVE_INFINITY;
  let pair: [GeoPoint, GeoPoint] | undefined;
  for (const ringA of a.area.outers)
    for (let i = 0; i < ringA.xs.length; i += 1)
      for (const ringB of b.area.outers)
        for (let j = 0; j < ringB.xs.length; j += 1) {
          const dx = ringA.xs[i]! - ringB.xs[j]!;
          const dy = (ringA.ys[i]! - ringB.ys[j]!) * aspect;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            pair = [
              { x: ringA.xs[i]!, y: ringA.ys[i]! },
              { x: ringB.xs[j]!, y: ringB.ys[j]! },
            ];
          }
        }
  return pair;
}

function nearestVertexTo(
  geography: ResolvedGeography,
  landId: string,
  point: GeoPoint,
): GeoPoint | undefined {
  const land = geography.get('land', landId);
  if (land === undefined) return undefined;
  const aspect = geography.frame.height / geography.frame.width;
  let best = Number.POSITIVE_INFINITY;
  let found: GeoPoint | undefined;
  for (const ring of land.area.outers)
    for (let i = 0; i < ring.xs.length; i += 1) {
      const dx = ring.xs[i]! - point.x;
      const dy = (ring.ys[i]! - point.y) * aspect;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        found = { x: ring.xs[i]!, y: ring.ys[i]! };
      }
    }
  return found;
}

/** The probe line a strait is resolved along, in frame coordinates. */
function straitProbe(
  geography: ResolvedGeography,
  strait: ResolvedStrait,
  width: number,
  height: number,
): GeoPoint[] {
  if (strait.path !== undefined && strait.path.length >= 2) return [...strait.path];
  const [first, second] = strait.between;
  let ends: [GeoPoint, GeoPoint] | undefined;
  if (first.type === 'land' && second.type === 'land')
    ends = nearestVertices(geography, first.id, second.id);
  else {
    const pointOf = (end: typeof first, other: typeof first): GeoPoint | undefined => {
      if (end.type === 'point') return { x: end.x, y: end.y };
      if (other.type === 'point') return nearestVertexTo(geography, end.id, other);
      return undefined;
    };
    const a = pointOf(first, second);
    const b = pointOf(second, first);
    if (a !== undefined && b !== undefined) ends = [a, b];
  }
  if (ends === undefined) return [];
  // The ends lie on coasts; run the line a little way inland so it starts and ends on land.
  const dx = (ends[1].x - ends[0].x) * width;
  const dy = (ends[1].y - ends[0].y) * height;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) return ends;
  const reach = 14;
  return [
    {
      x: ends[0].x - ((dx / length) * reach) / width,
      y: ends[0].y - ((dy / length) * reach) / height,
    },
    {
      x: ends[1].x + ((dx / length) * reach) / width,
      y: ends[1].y + ((dy / length) * reach) / height,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Sea crossings

interface Triple {
  /** The provinces of the channel between the shores; `through` is one of them. */
  via: number[];
  from: number;
  through: number;
  to: number;
}

type CrossingKind = 'land-to-land' | 'sea-to-sea';

interface StraitCandidate {
  id: string;
  name: string | undefined;
  rule: 'open' | 'army-closed' | 'navy-closed' | undefined;
  declaredWidth: number | undefined;
  triple: Triple;
  crossing: CrossingKind;
  auto: boolean;
}

/**
 * Find (from, through, to) along a sequence of provinces: the two ends are of one kind (land or
 * sea), the middle one of the other kind, and the middle one touches both ends. Land to land is
 * preferred; `expected` names the model lands the ends should belong to.
 */
function tripleAlong(
  sequence: readonly number[],
  pixelsIn: ReadonlyMap<number, number>,
  input: CrossingInput,
  expected: readonly [number | undefined, number | undefined],
): { triple: Triple; crossing: CrossingKind } | undefined {
  // Maximal runs of provinces of one kind along the line; a lake ends a run.
  const runs: Array<{ kind: number; members: number[] }> = [];
  for (const province of sequence) {
    const kind = input.kind[province]!;
    const last = runs[runs.length - 1];
    if (last?.kind === kind) last.members.push(province);
    else runs.push({ kind, members: [province] });
  }
  let best: { triple: Triple; crossing: CrossingKind; score: number } | undefined;
  for (let r = 1; r + 1 < runs.length; r += 1) {
    const middle = runs[r]!;
    const before = runs[r - 1]!;
    const after = runs[r + 1]!;
    if (middle.kind === LAKE || before.kind !== after.kind || before.kind === middle.kind) continue;
    if (before.kind === LAKE) continue;
    const from = before.members[before.members.length - 1]!;
    const to = after.members[0]!;
    if (from === to || input.neighbors[from]!.has(to)) continue;
    // The through province touches both shores when it can; narrow channels cut in two reach
    // only one, as six of the base game's 151 crossings do.
    let through = middle.members[0]!;
    let throughScore = Number.NEGATIVE_INFINITY;
    for (const member of middle.members) {
      const touching =
        (input.neighbors[member]!.has(from) ? 1 : 0) + (input.neighbors[member]!.has(to) ? 1 : 0);
      const score = touching * 1_000_000 + (pixelsIn.get(member) ?? 0);
      if (score > throughScore) {
        throughScore = score;
        through = member;
      }
    }
    if (!input.neighbors[through]!.has(from) && !input.neighbors[through]!.has(to)) continue;
    let score = throughScore / 1_000_000;
    if (before.kind === LAND) score += 100;
    if (expected[0] !== undefined && input.features.land[from] === expected[0]) score += 10;
    if (expected[1] !== undefined && input.features.land[to] === expected[1]) score += 10;
    if (best === undefined || score > best.score)
      best = {
        triple: { from, through, to, via: middle.members },
        crossing: before.kind === LAND ? 'land-to-land' : 'sea-to-sea',
        score,
      };
  }
  return best === undefined ? undefined : { triple: best.triple, crossing: best.crossing };
}

function landIndexOf(
  geography: ResolvedGeography,
  end: ResolvedStrait['between'][number],
): number | undefined {
  const id = end.type === 'land' ? end.id : end.landId;
  if (id === undefined) return undefined;
  const index = geography.lands.findIndex((land) => land.id === id);
  return index < 0 ? undefined : index;
}

/**
 * When the line crosses no clean land-sea-land triple, look for a sea province that touches land
 * provinces of both declared lands near the strait's middle.
 */
function tripleBySearch(
  strait: ResolvedStrait,
  probe: readonly GeoPoint[],
  input: CrossingInput,
  expected: readonly [number | undefined, number | undefined],
): Triple | undefined {
  if (expected[0] === undefined || expected[1] === undefined) return undefined;
  const { width, height } = input;
  const midX = ((probe[0]!.x + probe[probe.length - 1]!.x) / 2) * width;
  const midY = ((probe[0]!.y + probe[probe.length - 1]!.y) / 2) * height;
  if (expected[0] === expected[1])
    return sameLandTriple(probe, input, expected[0], midX, midY, strait.width * width);
  const reach = Math.max(0.12 * width, strait.width * width * 4);
  let best: (Triple & { score: number }) | undefined;
  for (let through = 0; through < input.kind.length; through += 1) {
    if (input.kind[through] !== SEA) continue;
    const centre = centerOf(input.center, through);
    const d = distanceOnMap(centre.x, centre.y, midX, midY, width);
    if (d > reach) continue;
    let from: number | undefined;
    let to: number | undefined;
    for (const other of [...input.neighbors[through]!].sort((a, b) => a - b)) {
      if (input.kind[other] !== LAND) continue;
      if (input.features.land[other] === expected[0] && from === undefined) from = other;
      else if (input.features.land[other] === expected[1] && to === undefined) to = other;
    }
    if (from === undefined || to === undefined || input.neighbors[from]!.has(to)) continue;
    if (best === undefined || d < best.score)
      best = { from, through, to, via: [through], score: d };
  }
  return best === undefined
    ? undefined
    : { from: best.from, through: best.through, to: best.to, via: [best.through] };
}

/**
 * A crossing between two coasts of one land: the sea province nearest the strait's middle whose
 * land neighbours on that land include one near each end that do not touch each other.
 */
function sameLandTriple(
  probe: readonly GeoPoint[],
  input: CrossingInput,
  land: number,
  midX: number,
  midY: number,
  straitWidth: number,
): Triple | undefined {
  const { width, height } = input;
  const ends = [probe[0]!, probe[probe.length - 1]!].map(({ x, y }) => ({
    x: x * width,
    y: y * height,
  }));
  const reach = Math.max(0.12 * width, straitWidth * 4);
  let best: (Triple & { score: number }) | undefined;
  for (let through = 0; through < input.kind.length; through += 1) {
    if (input.kind[through] !== SEA) continue;
    const centre = centerOf(input.center, through);
    const d = distanceOnMap(centre.x, centre.y, midX, midY, width);
    if (d > reach) continue;
    const shores = [...input.neighbors[through]!]
      .filter((other) => input.kind[other] === LAND && input.features.land[other] === land)
      .sort((a, b) => a - b);
    const nearest = (end: { x: number; y: number }) => {
      let chosen: number | undefined;
      let distance = Number.POSITIVE_INFINITY;
      for (const shore of shores) {
        const c = centerOf(input.center, shore);
        const next = distanceOnMap(c.x, c.y, end.x, end.y, width);
        if (next < distance) {
          chosen = shore;
          distance = next;
        }
      }
      return chosen;
    };
    const from = nearest(ends[0]!);
    const to = nearest(ends[1]!);
    if (from === undefined || to === undefined || from === to || input.neighbors[from]!.has(to))
      continue;
    if (best === undefined || d < best.score)
      best = { from, through, to, via: [through], score: d };
  }
  return best === undefined
    ? undefined
    : { from: best.from, through: best.through, to: best.to, via: [best.through] };
}

function planModelStraits(input: CrossingInput, notes: CrossingNote[]): StraitCandidate[] {
  const out: StraitCandidate[] = [];
  const { width, height } = input;
  for (const strait of input.geography.straits) {
    const probe = straitProbe(input.geography, strait, width, height);
    if (probe.length < 2) {
      notes.push({
        code: 'MAP_STRAIT_UNRESOLVED',
        severity: 'warning',
        message: `Strait ${strait.id} has no usable line between its ends; no crossing was written`,
        details: { straitId: strait.id },
      });
      continue;
    }
    const pixels = pixelsAlong(probe, width, height);
    const sequence: number[] = [];
    const pixelsIn = new Map<number, number>();
    for (const pixel of pixels) {
      const province = input.view.pixel[pixel]!;
      pixelsIn.set(province, (pixelsIn.get(province) ?? 0) + 1);
      if (sequence[sequence.length - 1] !== province) sequence.push(province);
    }
    const expected: [number | undefined, number | undefined] = [
      landIndexOf(input.geography, strait.between[0]),
      landIndexOf(input.geography, strait.between[1]),
    ];
    let found = tripleAlong(sequence, pixelsIn, input, expected);
    if (found === undefined) {
      const searched = tripleBySearch(strait, probe, input, expected);
      if (searched !== undefined) found = { triple: searched, crossing: 'land-to-land' };
    }
    if (found === undefined) {
      notes.push({
        code: 'MAP_STRAIT_UNRESOLVED',
        severity: 'warning',
        message: `Strait ${strait.id} separates no two provinces through a single province between them; it needs a narrower channel or a path through one sea province`,
        details: { straitId: strait.id, provincesAlongLine: sequence.length },
      });
      continue;
    }
    out.push({
      id: strait.id,
      name: strait.name,
      rule: strait.rule,
      declaredWidth: strait.width,
      triple: found.triple,
      crossing: found.crossing,
      auto: false,
    });
  }
  return out;
}

/** Land provinces grouped by the landmass they belong to (connected over land borders). */
function landmasses(input: CrossingInput): Int32Array {
  const label = new Int32Array(input.kind.length).fill(-1);
  let next = 0;
  for (let start = 0; start < input.kind.length; start += 1) {
    if (input.kind[start] !== LAND || label[start]! >= 0) continue;
    const stack = [start];
    label[start] = next;
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const other of input.neighbors[current]!)
        if (input.kind[other] === LAND && label[other]! < 0) {
          label[other] = next;
          stack.push(other);
        }
    }
    next += 1;
  }
  return label;
}

/** Narrow channels the model did not declare: two landmasses a single sea province separates. */
function planAutoStraits(
  input: CrossingInput,
  taken: ReadonlySet<string>,
  maxGapPx: number,
  notes: CrossingNote[],
): StraitCandidate[] {
  const mass = landmasses(input);
  const pairs: Triple[] = [];
  for (let through = 0; through < input.kind.length; through += 1) {
    if (input.kind[through] !== SEA) continue;
    const byMass = new Map<number, number[]>();
    for (const other of [...input.neighbors[through]!].sort((a, b) => a - b))
      if (input.kind[other] === LAND) {
        const list = byMass.get(mass[other]!) ?? [];
        list.push(other);
        byMass.set(mass[other]!, list);
      }
    const masses = [...byMass.keys()].sort((a, b) => a - b);
    for (let i = 0; i < masses.length; i += 1)
      for (let j = i + 1; j < masses.length; j += 1)
        for (const from of byMass.get(masses[i]!)!)
          for (const to of byMass.get(masses[j]!)!)
            if (!taken.has(`${Math.min(from, to)}:${Math.max(from, to)}`))
              pairs.push({ from, through, to, via: [through] });
  }
  const wanted = new Set<number>();
  for (const pair of pairs) {
    wanted.add(pair.from * input.view.count + pair.through);
    wanted.add(pair.to * input.view.count + pair.through);
  }
  const contacts = collectContacts(input.view, wanted);
  const scored: Array<{ pair: (typeof pairs)[number]; gap: number }> = [];
  for (const pair of pairs) {
    const left = contacts.get(pair.from * input.view.count + pair.through);
    const right = contacts.get(pair.to * input.view.count + pair.through);
    if (left === undefined || right === undefined) continue;
    const approach = closestApproach(left, right, input.width, 200);
    if (approach !== undefined && approach.gap <= maxGapPx)
      scored.push({ pair, gap: approach.gap });
  }
  scored.sort(
    (a, b) =>
      a.gap - b.gap ||
      a.pair.from - b.pair.from ||
      a.pair.to - b.pair.to ||
      a.pair.through - b.pair.through,
  );
  const chosen: StraitCandidate[] = [];
  const used = new Set<string>();
  for (const { pair } of scored) {
    const key = `${Math.min(pair.from, pair.to)}:${Math.max(pair.from, pair.to)}`;
    if (used.has(key)) continue;
    if (chosen.length >= AUTO_STRAIT_LIMIT) {
      notes.push({
        code: 'MAP_STRAIT_AUTO_LIMIT',
        severity: 'warning',
        message: `More than ${AUTO_STRAIT_LIMIT} narrow channels were detected; only the ${AUTO_STRAIT_LIMIT} narrowest were written`,
        details: { limit: AUTO_STRAIT_LIMIT, maxGapPx },
      });
      break;
    }
    used.add(key);
    chosen.push({
      id: `auto_${pair.from + 1}_${pair.to + 1}`,
      name: undefined,
      rule: undefined,
      declaredWidth: undefined,
      triple: pair,
      crossing: 'land-to-land',
      auto: true,
    });
  }
  return chosen;
}

/** A canal for each sealed inland sea: a land province between it and the open sea. */
function planInlandSeaCanals(
  input: CrossingInput,
  connected: ReadonlySet<number>,
  notes: CrossingNote[],
): Array<StraitCandidate & { lake: number }> {
  const out: Array<StraitCandidate & { lake: number }> = [];
  if (input.inlandSeas.length === 0) return out;
  for (const lakeIndex of input.inlandSeas) {
    const lake = input.geography.lakes[lakeIndex]!;
    const members: number[] = [];
    for (let id = 0; id < input.kind.length; id += 1)
      if (input.kind[id] === SEA && input.features.lake[id] === lakeIndex) members.push(id);
    if (members.length === 0) continue;
    const inside = new Set(members);
    const body = new Set<number>(members);
    // Extend over sea provinces joined to the members; a body that reaches outside is not sealed.
    const stack = [...members];
    let reachesOcean = false;
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const other of input.neighbors[current]!)
        if (input.kind[other] === SEA && !body.has(other)) {
          if (input.features.lake[other] === lakeIndex) {
            body.add(other);
            inside.add(other);
            stack.push(other);
          } else reachesOcean = true;
        }
    }
    if (reachesOcean) {
      notes.push({
        code: 'MAP_INLAND_SEA_OPEN',
        severity: 'info',
        message: `Inland sea ${lake.id} touches the open sea; ships can sail between them and no canal was needed`,
        details: { lakeId: lake.id, provinces: body.size },
      });
      continue;
    }
    // A model strait that already joins the inland sea to another sea is the canal.
    if ([...body].some((province) => connected.has(province))) {
      notes.push({
        code: 'MAP_INLAND_SEA_CONNECTED',
        severity: 'info',
        message: `Inland sea ${lake.id} is joined to the open sea by a declared strait`,
        details: { lakeId: lake.id },
      });
      continue;
    }
    // The nearest sea beyond one land province, else beyond two (the canal's through province
    // then touches the inland sea only, as the base game's narrow crossings sometimes do).
    let best:
      { from: number; through: number; to: number; via: number[]; score: number } | undefined;
    const consider = (candidate: NonNullable<typeof best>): void => {
      if (best === undefined || candidate.score < best.score) best = candidate;
    };
    for (const sea of [...body].sort((a, b) => a - b)) {
      const here = centerOf(input.center, sea);
      for (const first of [...input.neighbors[sea]!].sort((a, b) => a - b)) {
        if (input.kind[first] !== LAND) continue;
        for (const far of [...input.neighbors[first]!].sort((a, b) => a - b)) {
          if (input.kind[far] === SEA && !body.has(far)) {
            const there = centerOf(input.center, far);
            consider({
              from: sea,
              through: first,
              to: far,
              via: [first],
              score: distanceOnMap(here.x, here.y, there.x, there.y, input.width),
            });
          } else if (input.kind[far] === LAND && far !== first) {
            for (const beyond of [...input.neighbors[far]!].sort((a, b) => a - b)) {
              if (input.kind[beyond] !== SEA || body.has(beyond)) continue;
              const there = centerOf(input.center, beyond);
              consider({
                from: sea,
                through: first,
                to: beyond,
                via: [first, far],
                score: 10_000 + distanceOnMap(here.x, here.y, there.x, there.y, input.width),
              });
            }
          }
        }
      }
    }
    if (best === undefined) {
      notes.push({
        code: 'MAP_INLAND_SEA_SEALED',
        severity: 'warning',
        message: `Inland sea ${lake.id} lies more than two land provinces from the open sea, so ships cannot leave it; declare a strait with a path from the lake across the land, or move the lake nearer the coast`,
        details: { lakeId: lake.id, provinces: body.size },
      });
      continue;
    }
    const chosen: NonNullable<typeof best> = best;
    out.push({
      id: `${lake.id}_canal`,
      name: lake.name === undefined ? undefined : `${lake.name} canal`,
      rule: 'open',
      declaredWidth: undefined,
      triple: {
        from: chosen.from,
        through: chosen.through,
        to: chosen.to,
        via: chosen.via,
      },
      crossing: 'sea-to-sea',
      auto: false,
      lake: lakeIndex,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ranges and passes

interface PairHit {
  wall: number;
  gate: Map<number, number>;
}

interface RangeScan {
  range: ResolvedRange;
  hits: Map<number, PairHit>;
  passes: ResolvedPass[];
}

function passHalfWindow(pass: ResolvedPass, width: number): number {
  return Math.max(6, pass.width * width * 0.75 + 4);
}

function scanRange(range: ResolvedRange, input: CrossingInput): RangeScan {
  const { width, height, view } = input;
  const grid = { width, height };
  const passes = range.passIds
    .map((id) => input.geography.get('pass', id))
    .filter((pass): pass is ResolvedPass => pass !== undefined);
  let halfWidthPx = 0;
  for (const half of range.path.halfWidth) halfWidthPx = Math.max(halfWidthPx, half * width);
  // A wall is straight and the partition cuts along it; a ridge crest may wander off the path.
  const band = range.profile === 'wall' ? 6 : Math.max(6, Math.min(40, 0.4 * halfWidthPx));
  const hits = new Map<number, PairHit>();
  const lengthPx = Math.max(1, range.path.length * width);
  const windows = passes.map((pass) => passHalfWindow(pass, width) / lengthPx);
  const inPass = (t: number): number => {
    for (const [position, pass] of passes.entries()) {
      let delta = Math.abs(t - pass.at);
      if (range.path.closed && delta > 0.5) delta = 1 - delta;
      if (delta <= windows[position]!) return position;
    }
    return -1;
  };
  const x0 = Math.max(0, Math.floor(range.path.bounds.x0 * width - band - 2));
  const x1 = Math.min(width - 2, Math.ceil(range.path.bounds.x1 * width + band + 2));
  const y0 = Math.max(0, Math.floor(range.path.bounds.y0 * height - band - 2));
  const y1 = Math.min(height - 1, Math.ceil(range.path.bounds.y1 * height + band + 2));
  const rows = 64;
  const shared = createBandStrip(grid, { y0: 0, y1: rows + 1 });
  for (const strip of rowStrips({ width, height: y1 + 1 }, rows)) {
    if (strip.y1 <= y0) continue;
    input.signal?.throwIfAborted();
    const extended = { y0: strip.y0, y1: Math.min(height, strip.y1 + 1) };
    const active = { ...shared, strip: extended };
    clearBandStrip(active);
    rasterizeBandStrip(range.path, grid, extended, band, active);
    for (let y = Math.max(strip.y0, y0); y < strip.y1 && y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        const cell = (y - extended.y0) * width + x;
        const p = y * width + x;
        if (active.distance[cell] === Infinity) continue;
        const a = view.pixel[p]!;
        if (input.kind[a] !== LAND) continue;
        const probe = (q: number, qCell: number): void => {
          const b = view.pixel[q]!;
          if (a === b || input.kind[b] !== LAND) return;
          const dp = active.distance[cell]!;
          const dq = active.distance[qCell]!;
          if (dq === Infinity) return;
          if (active.side[cell]! * active.side[qCell]! > 0) return;
          const t = dp <= dq ? active.t[cell]! : active.t[qCell]!;
          const key = pairKey(a, b, view.count);
          let hit = hits.get(key);
          if (hit === undefined) {
            hit = { wall: 0, gate: new Map() };
            hits.set(key, hit);
          }
          const pass = inPass(t);
          if (pass >= 0) hit.gate.set(pass, (hit.gate.get(pass) ?? 0) + 1);
          else hit.wall += 1;
        };
        if (x + 1 < width) probe(p + 1, cell + 1);
        if (y + 1 < extended.y1) probe(p + width, cell + width);
      }
  }
  return { range, hits, passes };
}

/** A pair is a wall crossing when enough of its border lies across the range's line. */
function isWallPair(hit: PairHit, stat: BorderStat | undefined): boolean {
  if (hit.wall < 2) return false;
  const total = stat?.count ?? hit.wall;
  return hit.wall >= 0.2 * total;
}

/** Border pixel pairs inside a pass window that free a pair: any border through the gate is the gate. */
const GATE_HITS = 1;

// ---------------------------------------------------------------------------------------------
// Access rules

function accessBlocks(access: AdjacencyRule['access']): string {
  const block = (
    name: string,
    values: { army: boolean; navy: boolean; submarine: boolean; trade: boolean },
  ): string =>
    [
      `\t${name} =`,
      '\t{',
      `\t\tarmy = ${values.army ? 'yes' : 'no'}`,
      `\t\tnavy = ${values.navy ? 'yes' : 'no'}`,
      `\t\tsubmarine = ${values.submarine ? 'yes' : 'no'}`,
      `\t\ttrade = ${values.trade ? 'yes' : 'no'}`,
      '\t}',
    ].join('\n');
  const army = access !== 'army-closed';
  const navy = access !== 'navy-closed';
  const held = { army: false, navy: false, submarine: navy, trade: false };
  const free = { army, navy, submarine: navy, trade: true };
  return [
    block('contested', held),
    block('enemy', held),
    block('friend', free),
    block('neutral', free),
  ].join('\n');
}

/** `adjacency_rules.txt` for the rules of a plan; a header comment stays when there are none. */
export function adjacencyRulesText(rules: readonly AdjacencyRule[]): string {
  if (rules.length === 0) return '# No straits or canals in this world yet.\n';
  const blocks = rules.map((rule) =>
    [
      `# ${rule.comment}`,
      'adjacency_rule =',
      '{',
      `\tname = "${rule.name}"`,
      '',
      accessBlocks(rule.access),
      '',
      `\trequired_provinces = { ${rule.required.join(' ')} }`,
      '',
      `\ticon = ${rule.icon}`,
      '\toffset = { 0 0 0 }',
      '}',
    ].join('\n'),
  );
  return `# Generated from the geography model: one rule for every named strait and canal.\n\n${blocks.join('\n\n')}\n`;
}

/** The rows of `adjacencies.csv` (header and terminator excluded) as text. */
export function adjacencyRowText(row: AdjacencyRow): string {
  const line =
    row.line === undefined
      ? '-1;-1;-1;-1'
      : `${row.line.startX};${row.line.startY};${row.line.stopX};${row.line.stopY}`;
  return `${row.from};${row.to};${row.type};${row.type === 'impassable' ? -1 : row.through};${line};${row.rule};${row.comment}`;
}

// ---------------------------------------------------------------------------------------------
// The plan

export function planCrossings(input: CrossingInput): CrossingPlan {
  const { geography, width, height } = input;
  const view = input.view;
  const notes: CrossingNote[] = [];
  const taken = new Set<string>();
  const seaCandidates: StraitCandidate[] = [];
  const modelStraits = planModelStraits(input, notes);
  for (const candidate of modelStraits) {
    const key = `${Math.min(candidate.triple.from, candidate.triple.to)}:${Math.max(candidate.triple.from, candidate.triple.to)}`;
    if (taken.has(key)) {
      notes.push({
        code: 'MAP_STRAIT_DUPLICATE',
        severity: 'warning',
        message: `Strait ${candidate.id} crosses the same two provinces as an earlier strait; its row was skipped`,
        details: { straitId: candidate.id },
      });
      continue;
    }
    taken.add(key);
    seaCandidates.push(candidate);
  }
  const joined = new Set<number>();
  for (const candidate of seaCandidates)
    if (candidate.crossing === 'sea-to-sea') {
      joined.add(candidate.triple.from);
      joined.add(candidate.triple.to);
    }
  const canals = planInlandSeaCanals(input, joined, notes);
  for (const canal of canals)
    taken.add(
      `${Math.min(canal.triple.from, canal.triple.to)}:${Math.max(canal.triple.from, canal.triple.to)}`,
    );
  const autos =
    input.autoStraits === undefined
      ? []
      : planAutoStraits(input, taken, input.autoStraits.maxGapPx, notes);
  const everySea = [...seaCandidates, ...canals, ...autos];

  // Closest approach of every crossing, from the shores that face the channel between them.
  const wanted = new Set<number>();
  for (const { triple } of everySea)
    for (const member of triple.via) {
      wanted.add(triple.from * view.count + member);
      wanted.add(triple.to * view.count + member);
    }
  const contacts = collectContacts(view, wanted);
  const shore = (province: number, via: readonly number[]): number[] =>
    via.flatMap((member) => contacts.get(province * view.count + member) ?? []);
  const rows: AdjacencyRow[] = [];
  const rules: AdjacencyRule[] = [];
  const usedRules = new Set<string>();
  for (const candidate of everySea) {
    const { from, through, to, via } = candidate.triple;
    const approach = closestApproach(shore(from, via), shore(to, via), width);
    const line =
      approach === undefined
        ? undefined
        : {
            startX: approach.from.x,
            startY: height - 1 - approach.from.y,
            stopX: approach.to.x,
            stopY: height - 1 - approach.to.y,
          };
    const comment = candidate.auto
      ? `Auto strait ${from + 1}-${to + 1}`
      : commentOf(candidate.name, candidate.id);
    let rule = '';
    if (!candidate.auto) {
      rule = ruleNameFor(candidate.id, usedRules);
      rules.push({
        name: rule,
        comment,
        access: candidate.rule ?? 'open',
        required: [...new Set([from + 1, to + 1, through + 1])].sort((a, b) => a - b),
        icon: candidate.crossing === 'land-to-land' ? through + 1 : from + 1,
      });
    }
    rows.push({
      from: from + 1,
      to: to + 1,
      type: 'sea',
      through: through + 1,
      ...(line === undefined ? {} : { line }),
      rule,
      comment,
    });
    if (!candidate.auto && approach !== undefined) {
      const limit = Math.max(
        STRAIT_NARROW_LIMIT_PX,
        candidate.declaredWidth === undefined ? 0 : 1.5 * candidate.declaredWidth * width,
      );
      if (candidate.crossing === 'land-to-land' && approach.gap > limit)
        notes.push({
          code: 'MAP_STRAIT_NOT_NARROW',
          severity: 'warning',
          message: `Strait ${candidate.id} is ${Math.round(approach.gap)} pixels wide where its shores are closest (about ${Math.round(approach.gap * 7.114)} km); the base game's widest crossing is 30 pixels. Narrow the channel in the model or accept the long hop`,
          details: {
            straitId: candidate.id,
            gapPx: Math.round(approach.gap),
            limitPx: Math.round(limit),
          },
        });
    }
  }

  // Ranges: impassable rows outside the passes, forts at the passes.
  const blockedPairs = new Map<number, string>();
  const gatePairs = new Map<number, number>();
  const passReports: PassReport[] = [];
  const forts: FortSite[] = [];
  const scanned: RangeScan[] = [];
  for (const range of geography.ranges) {
    const hasFort = range.passIds.some((id) => (geography.get('pass', id)?.fort ?? 0) > 0);
    if (range.barrier !== 'impassable' && !hasFort && range.barrier !== 'fort-line') continue;
    scanned.push(scanRange(range, input));
  }
  const rangeComment = (range: ResolvedRange): string => commentOf(range.name, range.id);
  for (const scan of scanned) {
    const { range, hits, passes } = scan;
    for (const [key, hit] of hits) {
      const stat = input.borders.get(key);
      let freed = false;
      for (const count of hit.gate.values()) if (count >= GATE_HITS) freed = true;
      if (freed) {
        gatePairs.set(key, hit.gate.size);
        continue;
      }
      if (range.barrier === 'impassable' && isWallPair(hit, stat) && !blockedPairs.has(key))
        blockedPairs.set(key, rangeComment(range));
    }
    for (const [position, pass] of passes.entries()) {
      const open: Array<[number, number, number]> = [];
      for (const [key, hit] of hits) {
        const count = hit.gate.get(position) ?? 0;
        if (count >= GATE_HITS) {
          const [a, b] = pairOf(key, view.count);
          open.push([a, b, count]);
        }
      }
      open.sort((x, y) => y[2] - x[2] || x[0] - y[0] || x[1] - y[1]);
      passReports.push({
        id: pass.id,
        range: range.id,
        open: open.slice(0, 4).map(([a, b]) => [a, b]),
      });
      if (open.length === 0) {
        notes.push({
          code: 'MAP_PASS_BLOCKED',
          severity: 'warning',
          message: `Pass ${pass.id} of ${range.id} joins no two land provinces: its gap lies over water, over a single province or outside the land; units cannot use it as a gate`,
          details: { passId: pass.id, rangeId: range.id },
        });
        continue;
      }
      if (pass.fort > 0) {
        const best = open[0]!;
        forts.push({ province: best[0], level: pass.fort, pass: pass.id });
        forts.push({ province: best[1], level: pass.fort, pass: pass.id });
      }
    }
  }
  // A freed pair is never blocked, whichever range blocked it first.
  for (const key of gatePairs.keys()) blockedPairs.delete(key);
  const impassable = [...blockedPairs]
    .map(([key, comment]) => {
      const [a, b] = pairOf(key, view.count);
      return { from: a + 1, to: b + 1, comment };
    })
    .sort((l, r) => l.from - r.from || l.to - r.to);
  const rowLimit = input.impassableLimit ?? IMPASSABLE_ROW_LIMIT;
  if (impassable.length > rowLimit)
    throw new ServiceError(
      'MAP_IMPASSABLE_ROW_LIMIT',
      `The impassable ranges need ${impassable.length} adjacency rows; the limit is ${rowLimit} (the base game has 93). Narrow the ranges, raise the province size or use barrier "fort-line"`,
      { rows: impassable.length, limit: rowLimit },
    );
  for (const { from, to, comment } of impassable)
    rows.push({ from, to, type: 'impassable', through: -1, rule: '', comment });

  // A wall that provinces straddle or that leaves a gap outside the declared passes.
  const blockedSet = new Set(blockedPairs.keys());
  for (const scan of scanned) {
    if (scan.range.barrier !== 'impassable') continue;
    const { range } = scan;
    const lengthPx = Math.max(1, range.path.length * width);
    const stepT = Math.min(0.25, 4 / lengthPx);
    let samples = 0;
    let open = 0;
    const gaps: number[] = [];
    for (let t = 0; t <= 1; t += stepT) {
      const sample = sampleAlong(range.path, geography.frame, t);
      const insidePass = scan.passes.some((pass) => {
        let delta = Math.abs(t - pass.at);
        if (range.path.closed && delta > 0.5) delta = 1 - delta;
        return delta <= (passHalfWindow(pass, width) + 4) / lengthPx;
      });
      if (insidePass) continue;
      const cx = sample.x * width;
      const cy = sample.y * height;
      const ax = Math.round(cx - sample.tangentY * 3);
      const ay = Math.round(cy + sample.tangentX * 3);
      const bx = Math.round(cx + sample.tangentY * 3);
      const by = Math.round(cy - sample.tangentX * 3);
      if (
        ax < 0 ||
        ay < 0 ||
        bx < 0 ||
        by < 0 ||
        ax >= width ||
        bx >= width ||
        ay >= height ||
        by >= height
      )
        continue;
      const a = view.pixel[ay * width + ax]!;
      const b = view.pixel[by * width + bx]!;
      if (input.kind[a] !== LAND || input.kind[b] !== LAND) continue;
      // A pair of provinces freed at a gate is a whole border; all of it counts as the gate.
      if (a !== b && gatePairs.has(pairKey(a, b, view.count))) continue;
      samples += 1;
      if (a === b || !blockedSet.has(pairKey(a, b, view.count))) {
        open += 1;
        gaps.push(Math.round(t * 1000) / 1000);
      }
    }
    if (open > 0)
      notes.push({
        code: 'MAP_RANGE_NOT_CLOSED',
        severity: 'warning',
        message: `Wall ${range.id} leaves ${open} of ${samples} sampled points open outside its declared passes (a province straddles the line, or the border does not follow it); those points can be crossed on foot`,
        details: {
          rangeId: range.id,
          samples,
          open,
          at: gaps.slice(0, 8),
        },
      });
  }

  notes.push({
    code: 'MAP_CROSSINGS_PLANNED',
    severity: 'info',
    message: `Wrote ${modelStraits.length > 0 ? seaCandidates.length : 0} model strait(s), ${canals.length} canal(s), ${autos.length} automatic strait(s) and ${impassable.length} impassable row(s) for ${scanned.filter((s) => s.range.barrier === 'impassable').length} wall range(s); ${passReports.length} pass(es) open, ${forts.length} fort site(s)`,
    details: {
      straits: seaCandidates.length,
      canals: canals.length,
      autoStraits: autos.length,
      impassableRows: impassable.length,
    },
  });
  return {
    rows,
    rules,
    notes,
    forts,
    passes: passReports,
    blocked: [...blockedPairs.keys()].map((key) => pairOf(key, view.count)),
    gates: [...gatePairs.keys()].map((key) => pairOf(key, view.count)),
    summary: {
      straits: seaCandidates.length,
      autoStraits: autos.length,
      canals: canals.length,
      impassableRows: impassable.length,
      ranges: scanned.length,
      passes: passReports.length,
    },
  };
}

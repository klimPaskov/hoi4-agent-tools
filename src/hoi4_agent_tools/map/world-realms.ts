/**
 * Workspace-owned countries in a generated world (ADR 0069): realm points and polygons resolved to
 * provinces, and the rule for land that no realm reached.
 */
import { ServiceError } from '../core/result.js';
import type { WorldRealms } from './world.js';

interface Point {
  x: number;
  y: number;
}
type Polygon = ReadonlyArray<Point>;

export interface RealmRaster {
  width: number;
  height: number;
  /** Province index of every pixel. */
  pixelProvince: ArrayLike<number>;
  provinceSize: ArrayLike<number>;
  isLand: (province: number) => boolean;
}

export interface RealmRules {
  /** Capital province of each realm, in list order. */
  capitals: number[];
  /** Provinces a realm must own: its capital, seeds and claims. */
  forced: Map<number, number>;
  /** Provinces each realm must not own. */
  excluded: Set<number>[];
  /** Land no realm owns. */
  unowned: Set<number>;
}

function inside(x: number, y: number, polygon: Polygon): boolean {
  let result = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!,
      b = polygon[previous]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** Land provinces with more than half their pixels inside any of the polygons. */
function coveredProvinces(polygons: readonly Polygon[], raster: RealmRaster): Set<number> {
  const counts = new Map<number, number>();
  const pixels = new Set<number>();
  for (const polygon of polygons) {
    const xs = polygon.map(({ x }) => x),
      ys = polygon.map(({ y }) => y);
    const left = Math.max(0, Math.floor(Math.min(...xs)));
    const right = Math.min(raster.width - 1, Math.ceil(Math.max(...xs)));
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(raster.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y += 1)
      for (let x = left; x <= right; x += 1) {
        const pixel = y * raster.width + x;
        if (pixels.has(pixel) || !inside(x + 0.5, y + 0.5, polygon)) continue;
        pixels.add(pixel);
        const province = raster.pixelProvince[pixel]!;
        counts.set(province, (counts.get(province) ?? 0) + 1);
      }
  }
  const covered = new Set<number>();
  for (const [province, count] of [...counts].sort((left, right) => left[0] - right[0]))
    if (raster.isLand(province) && count * 2 > raster.provinceSize[province]!)
      covered.add(province);
  return covered;
}

function pointProvince(tag: string, role: string, point: Point, raster: RealmRaster): number {
  const x = Math.floor(point.x),
    y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height)
    throw new ServiceError(
      'MAP_WORLD_REALM_POINT_OUTSIDE',
      `The ${role} of ${tag} lies outside the ${raster.width}x${raster.height} world`,
      { tag, role, point },
    );
  const province = raster.pixelProvince[y * raster.width + x]!;
  if (!raster.isLand(province))
    throw new ServiceError('MAP_WORLD_REALM_POINT_WATER', `The ${role} of ${tag} lies in water`, {
      tag,
      role,
      point,
    });
  return province;
}

/** Two points of different realms closer than this many pixels cannot get a province each. */
export const REALM_POINT_MIN_SEPARATION_PX = 10;

/** How far from a point in water the nearest land is searched, in pixels. */
const NEAREST_LAND_REACH_PX = 80;

export interface RealmPointProblem {
  code:
    | 'MAP_WORLD_REALM_POINT_OUTSIDE'
    | 'MAP_WORLD_REALM_POINT_WATER'
    | 'MAP_WORLD_REALM_POINT_CONFLICT'
    | 'MAP_WORLD_REALM_POINTS_TOO_CLOSE';
  tag: string;
  role: 'capital' | 'seed';
  point: Point;
  message: string;
  /** For a point in water: the nearest land pixel within reach. */
  nearestLand?: { x: number; y: number; distance: number };
  /** For a conflict or a pair too close: the other realm. */
  otherTag?: string;
  otherPoint?: Point;
  distance?: number;
}

export interface RealmPointRaster {
  width: number;
  height: number;
  /** 1 on land pixels. */
  land: (pixel: number) => boolean;
}

/**
 * Check every capital and seed against the generated surface before any province exists, and
 * return all problems at once: a point outside the frame or in water (with the nearest land), a
 * point inside the unowned area, its own exclusion or another realm's claim, and points of
 * different realms closer than `REALM_POINT_MIN_SEPARATION_PX`. Points of one realm may share a
 * province; points of different realms each get their own province (ADR 0073).
 */
export function checkRealmPoints(
  realms: WorldRealms,
  raster: RealmPointRaster,
): RealmPointProblem[] {
  const problems: RealmPointProblem[] = [];
  const points: Array<{ tag: string; role: 'capital' | 'seed'; point: Point; index: number }> = [];
  for (const [index, realm] of realms.list.entries()) {
    points.push({ tag: realm.tag, role: 'capital', point: realm.capital, index });
    for (const seed of realm.seeds ?? [])
      points.push({ tag: realm.tag, role: 'seed', point: seed, index });
  }
  const nearestLand = (point: Point) => {
    const cx = Math.floor(point.x);
    const cy = Math.floor(point.y);
    let best: { x: number; y: number; distance: number } | undefined;
    for (let radius = 1; radius <= NEAREST_LAND_REACH_PX; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1)
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
          if (!raster.land(y * raster.width + x)) continue;
          const distance = Math.hypot(dx, dy);
          if (best === undefined || distance < best.distance) best = { x, y, distance };
        }
      if (best !== undefined && best.distance <= radius) return best;
    }
    return best;
  };
  for (const { tag, role, point, index } of points) {
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) {
      problems.push({
        code: 'MAP_WORLD_REALM_POINT_OUTSIDE',
        tag,
        role,
        point,
        message: `The ${role} of ${tag} lies outside the ${raster.width}x${raster.height} world`,
      });
      continue;
    }
    if (!raster.land(y * raster.width + x)) {
      const near = nearestLand(point);
      problems.push({
        code: 'MAP_WORLD_REALM_POINT_WATER',
        tag,
        role,
        point,
        message: `The ${role} of ${tag} at (${x}, ${y}) lies in water${
          near === undefined
            ? ''
            : `; the nearest land is (${near.x}, ${near.y}), ${Math.round(near.distance)} px away`
        }`,
        ...(near === undefined ? {} : { nearestLand: near }),
      });
      continue;
    }
    const px = x + 0.5;
    const py = y + 0.5;
    const realm = realms.list[index]!;
    if (realms.unowned?.some((polygon) => inside(px, py, polygon)) === true)
      problems.push({
        code: 'MAP_WORLD_REALM_POINT_CONFLICT',
        tag,
        role,
        point,
        message: `The ${role} of ${tag} at (${x}, ${y}) lies in the unowned area`,
      });
    else if (realm.exclude?.some((polygon) => inside(px, py, polygon)) === true)
      problems.push({
        code: 'MAP_WORLD_REALM_POINT_CONFLICT',
        tag,
        role,
        point,
        message: `The ${role} of ${tag} at (${x}, ${y}) lies in its own exclusion`,
      });
    else
      for (const [otherIndex, other] of realms.list.entries()) {
        if (otherIndex === index) continue;
        if (other.claim?.some((polygon) => inside(px, py, polygon)) === true) {
          problems.push({
            code: 'MAP_WORLD_REALM_POINT_CONFLICT',
            tag,
            role,
            point,
            otherTag: other.tag,
            message: `The ${role} of ${tag} at (${x}, ${y}) lies in a claim of ${other.tag}`,
          });
          break;
        }
      }
  }
  // Points of different realms that are too close to each have a province of their own.
  for (let a = 0; a < points.length; a += 1)
    for (let b = a + 1; b < points.length; b += 1) {
      const left = points[a]!;
      const right = points[b]!;
      if (left.index === right.index) continue;
      const distance = Math.hypot(left.point.x - right.point.x, left.point.y - right.point.y);
      if (distance >= REALM_POINT_MIN_SEPARATION_PX) continue;
      problems.push({
        code: 'MAP_WORLD_REALM_POINTS_TOO_CLOSE',
        tag: left.tag,
        role: left.role,
        point: left.point,
        otherTag: right.tag,
        otherPoint: right.point,
        distance: Math.round(distance * 10) / 10,
        message: `The ${left.role} of ${left.tag} and the ${right.role} of ${right.tag} are ${Math.round(distance * 10) / 10} px apart; points of different realms need ${REALM_POINT_MIN_SEPARATION_PX} px to get a province each`,
      });
    }
  return problems;
}

/** One error for all point problems; the first one's code, every problem in `details.problems`. */
export function realmPointsError(problems: readonly RealmPointProblem[]): ServiceError {
  const first = problems[0]!;
  return new ServiceError(
    problems.length === 1 ? first.code : 'MAP_WORLD_REALM_POINTS_INVALID',
    problems.length === 1
      ? first.message
      : `${problems.length} realm points cannot be placed: ${problems
          .slice(0, 6)
          .map(({ message }) => message)
          .join('; ')}${problems.length > 6 ? '; ...' : ''}`,
    { problems: problems.slice(0, 500), count: problems.length },
  );
}

export function resolveRealmRules(realms: WorldRealms, raster: RealmRaster): RealmRules {
  const unowned =
    realms.unowned === undefined ? new Set<number>() : coveredProvinces(realms.unowned, raster);
  const excluded = realms.list.map((realm) =>
    realm.exclude === undefined ? new Set<number>() : coveredProvinces(realm.exclude, raster),
  );
  const forced = new Map<number, number>();
  const claimedBy = (province: number) => realms.list[forced.get(province)!]!.tag;
  const conflict = (tag: string, role: string, other: string, details: Record<string, unknown>) =>
    new ServiceError(
      'MAP_WORLD_REALM_POINT_CONFLICT',
      `The ${role} of ${tag} lies in land ${other}`,
      { tag, role, ...details },
    );
  const capitals: number[] = [];
  // Points first, so a claim that covers another realm's point names that point.
  for (const [index, realm] of realms.list.entries()) {
    for (const [role, point] of [
      ['capital', realm.capital] as const,
      ...(realm.seeds ?? []).map((seed) => ['seed', seed] as const),
    ]) {
      const province = pointProvince(realm.tag, role, point, raster);
      if (unowned.has(province))
        throw conflict(realm.tag, role, 'marked unowned', { point, province });
      if (excluded[index]!.has(province))
        throw conflict(realm.tag, role, 'its own exclusion covers', { point, province });
      const holder = forced.get(province);
      if (holder !== undefined && holder !== index)
        throw conflict(realm.tag, role, `that a point of ${claimedBy(province)} names`, {
          point,
          province,
          otherTag: claimedBy(province),
        });
      forced.set(province, index);
      if (role === 'capital') capitals.push(province);
    }
  }
  for (const [index, realm] of realms.list.entries()) {
    if (realm.claim === undefined) continue;
    for (const province of coveredProvinces(realm.claim, raster)) {
      const holder = forced.get(province);
      if (unowned.has(province) || excluded[index]!.has(province))
        throw new ServiceError(
          'MAP_WORLD_REALM_CLAIM_OVERLAP',
          `A claim of ${realm.tag} covers land that is ${unowned.has(province) ? 'marked unowned' : 'in its own exclusion'}`,
          { tag: realm.tag, province },
        );
      if (holder !== undefined && holder !== index)
        throw new ServiceError(
          'MAP_WORLD_REALM_CLAIM_OVERLAP',
          `A claim of ${realm.tag} covers land that ${claimedBy(province)} claims or names`,
          { tag: realm.tag, otherTag: claimedBy(province), province },
        );
      forced.set(province, index);
    }
  }
  return { capitals, forced, excluded, unowned };
}

/**
 * Land growth did not reach: a landmass that a realm already holds goes to the nearest realm that
 * may own it; a landmass without any realm follows the island rule.
 */
export function assignUnreachedRealmLand(input: {
  landIds: readonly number[];
  owner: Map<number, number>;
  unowned: Set<number>;
  capitals: readonly number[];
  excluded: readonly Set<number>[];
  islands: 'nearest' | 'one-owner' | 'unowned';
  part: (province: number) => number;
  center: (province: number) => Point;
}): void {
  const held = new Set<number>();
  for (const id of input.owner.keys()) held.add(input.part(id));
  const distance = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const nearest = (point: Point, allowed: (realm: number) => boolean) => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [realm, capital] of input.capitals.entries()) {
      if (!allowed(realm)) continue;
      const next = distance(point, input.center(capital));
      if (next < bestDistance) {
        best = realm;
        bestDistance = next;
      }
    }
    return best;
  };
  const pending = input.landIds.filter((id) => !input.owner.has(id) && !input.unowned.has(id));
  const partOwner = new Map<number, number>();
  if (input.islands === 'one-owner') {
    const members = new Map<number, number[]>();
    for (const id of pending)
      if (!held.has(input.part(id))) {
        const list = members.get(input.part(id)) ?? [];
        list.push(id);
        members.set(input.part(id), list);
      }
    for (const [part, ids] of members) {
      const mean = ids.reduce(
        (sum, id) => ({ x: sum.x + input.center(id).x, y: sum.y + input.center(id).y }),
        { x: 0, y: 0 },
      );
      partOwner.set(
        part,
        nearest({ x: mean.x / ids.length, y: mean.y / ids.length }, () => true),
      );
    }
  }
  for (const id of pending) {
    const allowed = (realm: number) => !input.excluded[realm]!.has(id);
    const island = !held.has(input.part(id));
    if (island && input.islands === 'unowned') {
      input.unowned.add(id);
      continue;
    }
    const preferred = island ? partOwner.get(input.part(id)) : undefined;
    const realm =
      preferred !== undefined && preferred >= 0 && allowed(preferred)
        ? preferred
        : nearest(input.center(id), allowed);
    if (realm < 0) input.unowned.add(id);
    else input.owner.set(id, realm);
  }
}

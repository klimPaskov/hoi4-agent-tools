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

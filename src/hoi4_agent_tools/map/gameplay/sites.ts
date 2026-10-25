/**
 * Where the model's sites stand among the generated provinces. A site is a point in the frame; the
 * generated coast moves a little from the polygon, so a site on a shore may fall in the sea. The
 * province is then the nearest land province found in rings of growing radius, which is
 * deterministic and never leaves the site's own landmass without a reason.
 */
import type { GeographySiteKind } from '../../schemas/geography.js';
import type { ResolvedSite } from '../geography/index.js';
import { LAND } from './facts.js';
import type { GameplayBase } from './prepare.js';

export interface LocatedSite {
  readonly site: ResolvedSite;
  /** Province index (0-based) the site belongs to, or undefined when it stands in water. */
  readonly province: number | undefined;
  /** True when the site had to move to the nearest land (it was not on land). */
  readonly moved: boolean;
}

/** The land province at a pixel, else the nearest one within `reach` pixels. */
export function landProvinceNear(
  base: GameplayBase,
  x: number,
  y: number,
  reach: number,
): { province: number; moved: boolean } | undefined {
  const { width, height } = base.input;
  const kind = base.input.provinces.kind;
  const pixel = base.view.pixel;
  const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const here = pixel[py * width + px]!;
  if (kind[here] === LAND) return { province: here, moved: false };
  for (let radius = 1; radius <= reach; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const yy = py + dy;
      if (yy < 0 || yy >= height) continue;
      // The square ring: whole rows at the top and bottom, two cells on the rows between.
      const step = Math.abs(dy) === radius ? 1 : 2 * radius;
      for (let dx = -radius; dx <= radius; dx += step) {
        const xx = (((px + dx) % width) + width) % width;
        const candidate = pixel[yy * width + xx]!;
        if (kind[candidate] === LAND) return { province: candidate, moved: true };
      }
    }
  }
  return undefined;
}

export function locateSites(base: GameplayBase): LocatedSite[] {
  const { width, height, geography } = base.input;
  const reach = Math.max(10, Math.round(width * 0.012));
  return geography.sites.map((site) => {
    if (site.onWater) return { site, province: undefined, moved: false };
    const found = landProvinceNear(base, site.at.x * width, site.at.y * height, reach);
    return {
      site,
      province: found?.province,
      moved: found?.moved ?? false,
    };
  });
}

/** Sites that become victory points, and the weight each kind gives to development. */
export const VICTORY_SITE_KINDS: ReadonlySet<GeographySiteKind> = new Set([
  'capital',
  'city',
  'fortress',
  'port',
]);

export const SITE_WEIGHT: Readonly<Record<GeographySiteKind, number>> = {
  capital: 1,
  city: 0.9,
  port: 0.7,
  fortress: 0.6,
  mine: 0.5,
  temple: 0.4,
  ruin: 0.2,
  landmark: 0.1,
};

/** Victory points of a site by importance 1 to 5. */
export const SITE_VICTORY_POINTS: readonly number[] = [3, 5, 8, 12, 20];

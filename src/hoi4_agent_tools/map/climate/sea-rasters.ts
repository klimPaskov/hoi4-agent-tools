/**
 * The model's seas as half-size rasters (ADR 0057): the depth class and kind each sea declares
 * and its ice cover, for the water colour map and the naval terrain of strategic regions.
 */
import type { ResolvedGeography } from '../geography/index.js';
import { scanAreaStrip } from '../geography/index.js';

/** Depth codes of `SeaRasters.depth`. */
export const SEA_DEPTH = { none: 0, shelf: 1, open: 2, abyss: 3, fjord: 4 } as const;

export interface SeaRasters {
  /** Half the map size. */
  readonly width: number;
  readonly height: number;
  /** `SEA_DEPTH` code per cell; `none` where no sea feature lies. */
  readonly depth: Uint8Array;
  /** Ice cover 0..255 per cell. */
  readonly ice: Uint8Array;
}

export function rasterizeSeas(geography: ResolvedGeography, width: number, height: number): SeaRasters {
  const mw = width / 2;
  const mh = height / 2;
  const depth = new Uint8Array(mw * mh);
  const ice = new Uint8Array(mw * mh);
  for (const sea of geography.seas) {
    const code =
      sea.seaKind === 'fjord'
        ? SEA_DEPTH.fjord
        : sea.depthClass === 'shelf'
          ? SEA_DEPTH.shelf
          : sea.depthClass === 'abyss'
            ? SEA_DEPTH.abyss
            : SEA_DEPTH.open;
    const cover = Math.round(sea.ice * 255);
    scanAreaStrip(sea.area, { width: mw, height: mh }, { y0: 0, y1: mh }, (y, x0, x1) => {
      depth.fill(code, y * mw + x0, y * mw + x1);
      if (cover > 0) ice.fill(cover, y * mw + x0, y * mw + x1);
    });
  }
  return { width: mw, height: mh, depth, ice };
}

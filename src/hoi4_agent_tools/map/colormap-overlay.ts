/**
 * The terrain shader's colour map overlay and its inverse (ADR 0057). `pdxmap.shader:317` computes
 * `diffuse = GetOverlay(diffuse, colormap, 0.75)`: both colours go to gamma space (`x ** 0.45`),
 * the colour map multiplies below 0.5 and screens above it, the result returns to linear space
 * (`x ** 2.2`) and mixes 75% with the atlas colour. Per channel the result is monotone in the
 * colour map value, so the colour map that makes a wanted colour over a given atlas colour has a
 * closed form. All values are 0..1 here.
 */
import { PowerTable } from './stable-math.js';

export const COLORMAP_OVERLAY_STRENGTH = 0.75;

const TO_GAMMA = new PowerTable(0.45);
const TO_LINEAR = new PowerTable(2.2);
const FROM_GAMMA = new PowerTable(1 / 0.45);

/** The colour the shader shows over atlas colour `atlas` (0..1) for colour map value `colour`. */
export function overlayForward(atlas: number, colour: number): number {
  const base = TO_GAMMA.at(atlas);
  const over = TO_GAMMA.at(colour);
  const mixed = over < 0.5 ? 2 * over * base : 1 - 2 * (1 - over) * (1 - base);
  return atlas * (1 - COLORMAP_OVERLAY_STRENGTH) + TO_LINEAR.at(mixed) * COLORMAP_OVERLAY_STRENGTH;
}

/** Darkest and brightest colour reachable over an atlas colour. */
export function overlayRange(atlas: number): readonly [number, number] {
  const low = atlas * (1 - COLORMAP_OVERLAY_STRENGTH);
  return [low, low + COLORMAP_OVERLAY_STRENGTH];
}

export interface OverlayInverse {
  /** Colour map value, 0..1. */
  readonly colour: number;
  /** False when the wanted colour lies outside `overlayRange(atlas)` and was clamped. */
  readonly reachable: boolean;
}

/**
 * The colour map value that shows `wanted` over `atlas`. A wanted colour outside the reachable
 * range gives the nearest reachable colour map value (pure black or white overlay) and
 * `reachable: false`.
 */
export function overlayInverse(atlas: number, wanted: number): OverlayInverse {
  const strength = COLORMAP_OVERLAY_STRENGTH;
  let linear = (wanted - atlas * (1 - strength)) / strength;
  let reachable = true;
  if (linear < 0) {
    linear = 0;
    reachable = false;
  } else if (linear > 1) {
    linear = 1;
    reachable = false;
  }
  const target = TO_GAMMA.at(linear);
  const base = TO_GAMMA.at(atlas);
  let over: number;
  if (target <= base && base > 0) over = target / (2 * base);
  else if (base < 1) over = 1 - (1 - target) / (2 * (1 - base));
  else over = target / 2;
  if (over < 0) over = 0;
  else if (over > 1) over = 1;
  return { colour: FROM_GAMMA.at(over), reachable };
}

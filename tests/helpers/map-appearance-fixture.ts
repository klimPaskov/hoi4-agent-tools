import sharp from 'sharp';

/**
 * A project-owned, synthetic reference picture for appearance measurements. Two continents touch
 * the east and west edges (so the wrapping seam cuts land), two strips of land touch the top and
 * bottom rows, and the land holds lakes of several sizes: one large, one medium, one pond below
 * the 60 pixel floor, one sea-coloured enclosed pond, and one lake that overlaps the open sea.
 */
export interface FixtureColor {
  r: number;
  g: number;
  b: number;
}

export const APPEARANCE_FIXTURE_COLORS = {
  sea: { r: 28, g: 84, b: 152 },
  plains: { r: 126, g: 176, b: 74 },
  forest: { r: 34, g: 104, b: 46 },
  desert: { r: 222, g: 190, b: 112 },
  mountain: { r: 136, g: 134, b: 130 },
  snow: { r: 246, g: 246, b: 250 },
  lake: { r: 112, g: 196, b: 238 },
} as const satisfies Record<string, FixtureColor>;

export const APPEARANCE_FIXTURE_PALETTE = (
  Object.keys(APPEARANCE_FIXTURE_COLORS) as Array<keyof typeof APPEARANCE_FIXTURE_COLORS>
).map((kind) => ({ kind, color: { ...APPEARANCE_FIXTURE_COLORS[kind] } }));

export interface AppearanceFixtureLake {
  name: string;
  x: number;
  y: number;
  radius: number;
}

/** Lake circles in picture pixels at 1,024 by 512. */
export const APPEARANCE_FIXTURE_LAKES: readonly AppearanceFixtureLake[] = [
  { name: 'large', x: 260, y: 250, radius: 34 },
  { name: 'medium', x: 720, y: 230, radius: 18 },
  { name: 'pond', x: 700, y: 300, radius: 4 },
  { name: 'sea-coloured', x: 400, y: 300, radius: 10 },
  { name: 'touching-sea', x: 480, y: 260, radius: 22 },
];

export function appearanceFixtureRgb(width = 1_024, height = 512): Buffer {
  const scaleX = width / 1_024;
  const scaleY = height / 512;
  const data = Buffer.alloc(width * height * 3);
  const put = (pixel: number, color: FixtureColor): void => {
    data[pixel * 3] = color.r;
    data[pixel * 3 + 1] = color.g;
    data[pixel * 3 + 2] = color.b;
  };
  const colors = APPEARANCE_FIXTURE_COLORS;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / scaleX;
      const v = (y + 0.5) / scaleY;
      const west = ((u - 230) / 260) ** 2 + ((v - 260) / 190) ** 2 <= 1;
      const east = ((u - 840) / 230) ** 2 + ((v - 230) / 170) ** 2 <= 1;
      const top = v < 18 && u >= 400 && u < 560;
      const bottom = v >= 494 && u >= 600 && u < 760;
      let color: FixtureColor = colors.sea;
      if (west || east || top || bottom) {
        color = colors.plains;
        if (west && ((u - 150) / 70) ** 2 + ((v - 215) / 60) ** 2 <= 1) color = colors.mountain;
        else if (west && v > 330) color = colors.desert;
        else if (west && u > 330) color = colors.forest;
        else if (east && v < 120) color = colors.snow;
        else if (east && u > 900) color = colors.forest;
        else if (east && v > 290) color = colors.desert;
      }
      for (const lake of APPEARANCE_FIXTURE_LAKES) {
        const inside = (u - lake.x) ** 2 + (v - lake.y) ** 2 <= lake.radius ** 2;
        if (inside) color = lake.name === 'sea-coloured' ? colors.sea : colors.lake;
      }
      put(y * width + x, color);
    }
  return data;
}

export async function appearanceFixturePng(width = 1_024, height = 512): Promise<Buffer> {
  return sharp(appearanceFixtureRgb(width, height), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

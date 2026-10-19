import sharp from 'sharp';
import type { ArtifactWrite } from '../../core/artifacts.js';
import { canonicalJson } from '../../core/canonical.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { RenderBudget } from '../../core/render-budget.js';
import { PACKAGE_VERSION } from '../../version.js';
import {
  GEOGRAPHY_FEATURE_KINDS,
  type ResolvedArea,
  type ResolvedFeature,
  type ResolvedGeography,
} from './model.js';
import type { PreparedGeography } from './preparation.js';
import {
  areaPixels,
  createBandStrip,
  rasterizeBandStrip,
  sampleAlong,
  scanAreaStrip,
  segmentCount,
  type RasterGrid,
} from './raster.js';

type Color = readonly [number, number, number];

const OVERLAY_MAX_WIDTH = 1_536;
const OVERLAY_MAX_HEIGHT = 1_024;
const LABEL_LIMIT = 320;

const colors = {
  openWater: [20, 36, 60] as Color,
  seaShelf: [52, 96, 134] as Color,
  seaOpen: [36, 68, 108] as Color,
  seaAbyss: [22, 44, 80] as Color,
  land: [138, 150, 100] as Color,
  lake: [90, 150, 205] as Color,
  river: [96, 170, 235] as Color,
  range: [120, 92, 64] as Color,
  rangeBarrier: [200, 60, 50] as Color,
  plateau: [220, 210, 170] as Color,
  volcano: [235, 90, 40] as Color,
  strait: [220, 90, 200] as Color,
  pass: [255, 224, 90] as Color,
  site: [250, 250, 250] as Color,
  road: [200, 190, 160] as Color,
  place: [250, 210, 120] as Color,
  region: [255, 255, 255] as Color,
  error: [255, 40, 40] as Color,
  warning: [255, 165, 0] as Color,
  edge: [0, 0, 0] as Color,
};

const biomeColors: Record<string, Color> = {
  forest: [40, 110, 56],
  desert: [214, 188, 112],
  marsh: [88, 140, 130],
  ice: [236, 242, 248],
  plains: [168, 190, 104],
  farmland: [196, 200, 90],
  jungle: [26, 92, 52],
  steppe: [190, 176, 110],
  tundra: [170, 184, 176],
};

// 5 by 7 glyphs, one 5-bit row per entry, so labels never depend on installed fonts.
const glyphs: Record<string, readonly number[]> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 0x1f],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
};

class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    background: Color,
  ) {
    this.data = new Uint8Array(width * height * 3);
    for (let index = 0; index < width * height; index++) this.data.set(background, index * 3);
  }

  blend(x: number, y: number, color: Color, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const base = (y * this.width + x) * 3;
    for (let channel = 0; channel < 3; channel++)
      this.data[base + channel] = Math.floor(
        (color[channel]! * alpha + this.data[base + channel]! * (255 - alpha) + 127) / 255,
      );
  }

  fillArea(area: ResolvedArea, color: Color, alpha = 255): void {
    const grid = { width: this.width, height: this.height };
    scanAreaStrip(area, grid, { y0: 0, y1: this.height }, (y, x0, x1) => {
      for (let x = x0; x < x1; x++) this.blend(x, y, color, alpha);
    });
  }

  outlineArea(area: ResolvedArea, color: Color, thickness = 1): void {
    for (const ring of [...area.outers, ...area.holes])
      for (let index = 0; index < ring.xs.length; index++) {
        const next = (index + 1) % ring.xs.length;
        this.line(
          ring.xs[index]! * this.width,
          ring.ys[index]! * this.height,
          ring.xs[next]! * this.width,
          ring.ys[next]! * this.height,
          color,
          thickness,
        );
      }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: Color, thickness = 1): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const half = Math.floor(thickness / 2);
    for (let step = 0; step <= steps; step++) {
      const x = Math.floor(x0 + ((x1 - x0) * step) / steps);
      const y = Math.floor(y0 + ((y1 - y0) * step) / steps);
      for (let dy = -half; dy < thickness - half; dy++)
        for (let dx = -half; dx < thickness - half; dx++) this.blend(x + dx, y + dy, color, 255);
    }
  }

  disc(cx: number, cy: number, radius: number, color: Color, alpha = 255): void {
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= radius * radius)
          this.blend(Math.floor(cx) + dx, Math.floor(cy) + dy, color, alpha);
  }

  /** An opaque two pixel ring, readable over any fill. */
  ring(cx: number, cy: number, radius: number, color: Color): void {
    const outer = radius * radius,
      inner = (radius - 2) * (radius - 2);
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const distance = dx * dx + dy * dy;
        if (distance <= outer && distance >= inner)
          this.blend(Math.floor(cx) + dx, Math.floor(cy) + dy, color, 255);
      }
  }

  square(cx: number, cy: number, half: number, color: Color): void {
    for (let dy = -half; dy <= half; dy++)
      for (let dx = -half; dx <= half; dx++)
        this.blend(Math.floor(cx) + dx, Math.floor(cy) + dy, color, 255);
  }

  /** Draw text; returns its pixel box. */
  text(
    text: string,
    cx: number,
    cy: number,
    scale: number,
  ): { x0: number; y0: number; x1: number; y1: number } {
    const label = text.toUpperCase().slice(0, 24);
    const width = label.length * 6 * scale - scale;
    const height = 7 * scale;
    const x0 = Math.max(0, Math.min(this.width - width, Math.floor(cx - width / 2)));
    const y0 = Math.max(0, Math.min(this.height - height, Math.floor(cy - height / 2)));
    for (const [pass, color] of [
      [1, [0, 0, 0] as Color],
      [0, [255, 255, 255] as Color],
    ] as const)
      for (let index = 0; index < label.length; index++) {
        const rows = glyphs[label.charAt(index)];
        if (rows === undefined) continue;
        for (let row = 0; row < 7; row++)
          for (let column = 0; column < 5; column++)
            if ((rows[row]! >> (4 - column)) & 1)
              for (let sy = 0; sy < scale; sy++)
                for (let sx = 0; sx < scale; sx++)
                  this.blend(
                    x0 + (index * 6 + column) * scale + sx + pass * scale,
                    y0 + row * scale + sy + pass * scale,
                    color,
                    255,
                  );
      }
    return { x0, y0, x1: x0 + width + scale, y1: y0 + height + scale };
  }
}

function seaColor(depth: string): Color {
  return depth === 'shelf' ? colors.seaShelf : depth === 'abyss' ? colors.seaAbyss : colors.seaOpen;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface GeographyOverlay {
  /** Packed 8-bit RGB, row by row. */
  rgb: Uint8Array;
  width: number;
  height: number;
  labels: number;
  legend: Array<{ layer: string; color: [number, number, number]; meaning: string }>;
}

const legend: GeographyOverlay['legend'] = [
  {
    layer: 'open-water',
    color: [...colors.openWater],
    meaning: 'Water that no sea, lake or land feature claims',
  },
  { layer: 'sea', color: [...colors.seaOpen], meaning: 'Sea; shelf is lighter and abyss darker' },
  { layer: 'land', color: [...colors.land], meaning: 'Land with no biome polygon on top' },
  ...Object.entries(biomeColors).map(([name, color]) => ({
    layer: `biome:${name}`,
    color: [...color] as [number, number, number],
    meaning: `Biome ${name}, drawn in ascending priority z`,
  })),
  { layer: 'plateau', color: [...colors.plateau], meaning: 'Plateau (light tint)' },
  { layer: 'lake', color: [...colors.lake], meaning: 'Lake' },
  {
    layer: 'river',
    color: [...colors.river],
    meaning: 'River through source, via points and mouth; width follows size',
  },
  {
    layer: 'range',
    color: [...colors.range],
    meaning: 'Mountain range footprint (half-width) with its crest line',
  },
  {
    layer: 'range-barrier',
    color: [...colors.rangeBarrier],
    meaning: 'Crest line of a range with an impassable or fort-line barrier',
  },
  { layer: 'pass', color: [...colors.pass], meaning: 'Pass position on its range' },
  { layer: 'volcano', color: [...colors.volcano], meaning: 'Volcano cone with crater' },
  { layer: 'strait', color: [...colors.strait], meaning: 'Strait between its two ends' },
  { layer: 'site', color: [...colors.site], meaning: 'Site; a larger square is a capital' },
  { layer: 'road', color: [...colors.road], meaning: 'Road (dashed line)' },
  {
    layer: 'place',
    color: [...colors.place],
    meaning: 'Named place: cape, bay, gulf, reef or landmark (ring)',
  },
  {
    layer: 'edge-band',
    color: [...colors.edge],
    meaning: 'Darkened default edge band where land is cut by the world wrap',
  },
  {
    layer: 'error',
    color: [...colors.error],
    meaning: 'Outline of a feature with an error diagnostic',
  },
  {
    layer: 'warning',
    color: [...colors.warning],
    meaning: 'Outline of a feature with a warning diagnostic',
  },
];

/** Draw the resolved model offline: shapes, ids, and red or orange outlines for defects. */
export function renderGeographyOverlay(
  geography: ResolvedGeography,
  diagnostics: readonly Diagnostic[],
  edgeBand: { westEastPx: number; northSouthPx: number },
): GeographyOverlay {
  const scale = Math.min(
    1,
    OVERLAY_MAX_WIDTH / geography.frame.width,
    OVERLAY_MAX_HEIGHT / geography.frame.height,
  );
  const width = Math.max(64, Math.round(geography.frame.width * scale));
  const height = Math.max(32, Math.round(geography.frame.height * scale));
  const canvas = new Canvas(width, height, colors.openWater);
  const grid: RasterGrid = { width, height };

  for (const sea of geography.seas) {
    canvas.fillArea(sea.area, seaColor(sea.depthClass));
    if (sea.ice > 0) canvas.fillArea(sea.area, biomeColors.ice!, Math.round(sea.ice * 160));
  }
  for (const land of geography.lands) canvas.fillArea(land.area, colors.land);
  for (const biome of geography.biomes)
    canvas.fillArea(biome.area, biomeColors[biome.biome] ?? colors.land, 200);
  for (const plateau of geography.plateaus) canvas.fillArea(plateau.area, colors.plateau, 80);
  for (const lake of geography.lakes) canvas.fillArea(lake.area, colors.lake);
  for (const region of geography.regions)
    if (region.area !== undefined) canvas.outlineArea(region.area, colors.region, 1);

  const strip = { y0: 0, y1: height };
  const band = createBandStrip(grid, strip);
  for (const range of geography.ranges) {
    const half = Math.max(...range.path.halfWidth) * width;
    rasterizeBandStrip(range.path, grid, strip, half, band);
    const b = range.path.bounds;
    const x0 = Math.max(0, Math.floor(b.x0 * width - half - 1));
    const x1 = Math.min(width - 1, Math.ceil(b.x1 * width + half + 1));
    const y0 = Math.max(0, Math.floor(b.y0 * height - half - 1));
    const y1 = Math.min(height - 1, Math.ceil(b.y1 * height + half + 1));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const cell = y * width + x;
        const distance = band.distance[cell]!;
        if (distance > half) continue;
        const local = sampleAlong(range.path, grid, band.t[cell]!).halfWidth * width;
        if (distance <= local) canvas.blend(x, y, colors.range, 150);
        band.distance[cell] = Infinity;
      }
    const centre = range.barrier === 'none' ? ([70, 52, 36] as Color) : colors.rangeBarrier;
    const segments = segmentCount(range.path);
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % range.path.xs.length;
      canvas.line(
        range.path.xs[segment]! * width,
        range.path.ys[segment]! * height,
        range.path.xs[next]! * width,
        range.path.ys[next]! * height,
        centre,
        1,
      );
    }
  }
  for (const road of geography.roads)
    for (let index = 0; index + 1 < road.path.xs.length; index++)
      if (index % 2 === 0)
        canvas.line(
          road.path.xs[index]! * width,
          road.path.ys[index]! * height,
          road.path.xs[index + 1]! * width,
          road.path.ys[index + 1]! * height,
          colors.road,
          1,
        );
  for (const river of geography.rivers) {
    const anchors: Array<{ x: number; y: number }> = [];
    if ('x' in river.source) anchors.push({ x: river.source.x, y: river.source.y });
    anchors.push(...river.via);
    if ('x' in river.mouth) anchors.push({ x: river.mouth.x, y: river.mouth.y });
    for (let index = 1; index < anchors.length; index++)
      canvas.line(
        anchors[index - 1]!.x * width,
        anchors[index - 1]!.y * height,
        anchors[index]!.x * width,
        anchors[index]!.y * height,
        colors.river,
        river.size >= 4 ? 3 : river.size >= 2 ? 2 : 1,
      );
  }
  for (const strait of geography.straits) {
    if (strait.path !== undefined) {
      for (let index = 1; index < strait.path.length; index++)
        canvas.line(
          strait.path[index - 1]!.x * width,
          strait.path[index - 1]!.y * height,
          strait.path[index]!.x * width,
          strait.path[index]!.y * height,
          colors.strait,
          2,
        );
      continue;
    }
    const [a, b] = strait.between.map((end) => {
      if (end.type === 'point') return { x: end.x, y: end.y };
      const land = geography.get('land', end.id);
      return land === undefined ? undefined : land.area.interior;
    });
    if (a !== undefined && b !== undefined)
      canvas.line(a.x * width, a.y * height, b.x * width, b.y * height, colors.strait, 1);
  }
  for (const pass of geography.passes)
    canvas.disc(pass.position.x * width, pass.position.y * height, 3, colors.pass);
  for (const volcano of geography.volcanoes) {
    canvas.disc(
      volcano.at.x * width,
      volcano.at.y * height,
      Math.max(3, volcano.radius * width),
      colors.volcano,
      140,
    );
    canvas.disc(
      volcano.at.x * width,
      volcano.at.y * height,
      Math.max(1, volcano.crater * width),
      [60, 20, 10],
      255,
    );
  }
  for (const site of geography.sites)
    canvas.square(
      site.at.x * width,
      site.at.y * height,
      site.siteKind === 'capital' ? 3 : 2,
      colors.site,
    );
  for (const place of geography.places)
    canvas.ring(place.at.x * width, place.at.y * height, 3, colors.place);

  // Edge band shading.
  const bandX = Math.round(edgeBand.westEastPx * scale);
  const bandY = Math.round(edgeBand.northSouthPx * scale);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (x < bandX || x >= width - bandX || y < bandY || y >= height - bandY)
        canvas.blend(x, y, colors.edge, 80);

  // Defect outlines.
  const worst = new Map<string, 'error' | 'warning'>();
  for (const diagnostic of diagnostics) {
    const featureId = diagnostic.details?.featureId;
    if (typeof featureId !== 'string') continue;
    if (diagnostic.severity === 'error' || diagnostic.severity === 'blocker')
      worst.set(featureId, 'error');
    else if (diagnostic.severity === 'warning' && !worst.has(featureId))
      worst.set(featureId, 'warning');
  }
  for (const [id, severity] of [...worst].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const feature = geography.find(id);
    if (feature === undefined) continue;
    const color = severity === 'error' ? colors.error : colors.warning;
    const area = areaOf(feature);
    if (area !== undefined) canvas.outlineArea(area, color, 2);
    else {
      const anchor = anchorOf(feature);
      if (anchor !== undefined) canvas.ring(anchor.x * width, anchor.y * height, 7, color);
    }
  }

  // Labels: larger features first, no overlaps, bounded count.
  const candidates = labelCandidates(geography);
  // Large text while the picture is sparse, small text once it would drown the map.
  const textScale = width >= 1_000 && candidates.length <= 80 ? 2 : 1;
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  let labels = 0;
  for (const candidate of candidates) {
    if (labels >= LABEL_LIMIT) break;
    const length = Math.min(24, candidate.id.length);
    const boxWidth = length * 6 * textScale;
    const cx = Math.max(boxWidth / 2, Math.min(width - boxWidth / 2, candidate.x * width));
    const cy = Math.max(7 * textScale, Math.min(height - 7 * textScale, candidate.y * height));
    const box = {
      x0: cx - boxWidth / 2 - 1,
      y0: cy - 4 * textScale,
      x1: cx + boxWidth / 2 + 1,
      y1: cy + 4 * textScale,
    };
    if (
      placed.some(
        (other) => box.x0 < other.x1 && other.x0 < box.x1 && box.y0 < other.y1 && other.y0 < box.y1,
      )
    )
      continue;
    placed.push(canvas.text(candidate.id, cx, cy, textScale));
    labels++;
  }

  return { rgb: canvas.data, width, height, labels, legend };
}

function areaOf(feature: ResolvedFeature): ResolvedArea | undefined {
  return 'area' in feature ? feature.area : undefined;
}

function anchorOf(feature: ResolvedFeature): { x: number; y: number } | undefined {
  switch (feature.kind) {
    case 'range': {
      const middle = Math.floor(feature.path.xs.length / 2);
      return { x: feature.path.xs[middle]!, y: feature.path.ys[middle]! };
    }
    case 'river': {
      const ends = [feature.source, ...feature.via, feature.mouth].filter(
        (end): end is { x: number; y: number } & typeof end => 'x' in end,
      );
      return ends[Math.floor(ends.length / 2)];
    }
    case 'volcano':
    case 'site':
    case 'place':
      return feature.at;
    case 'road': {
      const middle = Math.floor(feature.path.xs.length / 2);
      return { x: feature.path.xs[middle]!, y: feature.path.ys[middle]! };
    }
    case 'pass':
      return feature.position;
    case 'strait': {
      const first = feature.between[0];
      return first.type === 'point' ? { x: first.x, y: first.y } : undefined;
    }
    default:
      return undefined;
  }
}

interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  priority: number;
  size: number;
}

function labelCandidates(geography: ResolvedGeography): LabelCandidate[] {
  const list: LabelCandidate[] = [];
  const add = (
    feature: ResolvedFeature,
    priority: number,
    size: number,
    at?: { x: number; y: number },
  ) => {
    const point = at ?? areaOf(feature)?.interior ?? anchorOf(feature);
    if (point !== undefined) list.push({ id: feature.id, x: point.x, y: point.y, priority, size });
  };
  for (const land of geography.lands) add(land, 0, land.area.areaFraction);
  for (const sea of geography.seas) add(sea, 1, sea.area.areaFraction);
  for (const range of geography.ranges) add(range, 2, range.path.length);
  for (const lake of geography.lakes) add(lake, 3, lake.area.areaFraction);
  for (const river of geography.rivers) add(river, 4, river.anchorLength);
  for (const volcano of geography.volcanoes) add(volcano, 5, volcano.radius);
  for (const site of geography.sites) add(site, 6, site.importance);
  for (const place of geography.places) add(place, 7, 0);
  return list.sort(
    (a, b) =>
      a.priority - b.priority || b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function endLabel(end: { type: string; id?: string }): unknown {
  return end.type === 'point' ? 'point' : { [end.type]: end.id ?? null };
}

function featureReport(
  geography: ResolvedGeography,
  feature: ResolvedFeature,
): Record<string, unknown> {
  const frame = geography.frame;
  const base: Record<string, unknown> = {
    id: feature.id,
    kind: feature.kind,
    ...(feature.name === undefined ? {} : { name: feature.name }),
  };
  const area = areaOf(feature);
  if (area !== undefined) {
    base.areaFraction = round6(area.areaFraction);
    base.areaPixels = Math.round(areaPixels(area, frame));
    base.vertices = [...area.outers, ...area.holes].reduce((sum, ring) => sum + ring.xs.length, 0);
    base.polygons = area.outers.length;
    base.holes = area.holes.length;
    base.bounds = {
      x0: round6(area.bounds.x0),
      y0: round6(area.bounds.y0),
      x1: round6(area.bounds.x1),
      y1: round6(area.bounds.y1),
    };
    base.interior = { x: round6(area.interior.x), y: round6(area.interior.y) };
  }
  switch (feature.kind) {
    case 'sea':
      base.depthClass = feature.depthClass;
      break;
    case 'land':
      if (feature.regionId !== undefined) {
        base.region = feature.regionId;
        base.regionSource = feature.regionSource;
      }
      break;
    case 'region':
      base.landIds = feature.landIds;
      if (feature.terrain !== undefined) base.terrain = feature.terrain;
      if (feature.provincesPerState !== undefined)
        base.provincesPerState = feature.provincesPerState;
      if (feature.provinceAreaPx !== undefined) base.provinceAreaPx = feature.provinceAreaPx;
      break;
    case 'range':
      base.vertices = feature.path.xs.length;
      base.lengthPixels = Math.round(feature.path.length * frame.width);
      base.profile = feature.profile;
      base.barrier = feature.barrier;
      base.passes = feature.passIds;
      break;
    case 'pass':
      base.range = feature.rangeId;
      base.at = round6(feature.at);
      base.positionSource = feature.positionSource;
      base.position = { x: round6(feature.position.x), y: round6(feature.position.y) };
      break;
    case 'volcano':
      base.at = { x: round6(feature.at.x), y: round6(feature.at.y) };
      base.radiusPixels = Math.round(feature.radius * frame.width);
      if (feature.landId !== undefined) base.land = feature.landId;
      break;
    case 'river':
      base.size = feature.size;
      base.source = endLabel(feature.source);
      base.mouth = endLabel(feature.mouth);
      base.tributaries = feature.tributaryIds;
      base.anchorLengthPixels = Math.round(feature.anchorLength * frame.width);
      break;
    case 'lake':
      base.gameplay = feature.gameplay;
      if (feature.landId !== undefined) base.land = feature.landId;
      if (feature.outflowId !== undefined) base.outflow = feature.outflowId;
      break;
    case 'biome':
      base.biome = feature.biome;
      base.z = feature.z;
      break;
    case 'strait':
      base.ends = feature.ends;
      if (feature.path !== undefined) base.pathVertices = feature.path.length;
      base.between = feature.between.map((end) =>
        end.type === 'land'
          ? { land: end.id }
          : {
              x: round6(end.x),
              y: round6(end.y),
              ...(end.landId === undefined ? {} : { land: end.landId }),
            },
      );
      break;
    case 'site':
      base.siteKind = feature.siteKind;
      if (feature.onWater) base.onWater = true;
      if (feature.landId !== undefined) base.land = feature.landId;
      if (feature.regionId !== undefined) base.region = feature.regionId;
      if (feature.lakeId !== undefined) base.lake = feature.lakeId;
      break;
    case 'road':
      base.vertices = feature.path.xs.length;
      base.lengthPixels = Math.round(feature.path.length * frame.width);
      base.importance = feature.importance;
      break;
    case 'place':
      base.placeKind = feature.placeKind;
      base.surface = feature.surface;
      base.at = { x: round6(feature.at.x), y: round6(feature.at.y) };
      break;
    default:
      break;
  }
  return base;
}

/** The content of `map-geography-report.json`: resolved ids, areas, references and defects. */
export function buildGeographyReport(prepared: PreparedGeography): Record<string, unknown> {
  const geography = prepared.geography;
  const counts: Record<string, number> = {};
  for (const kind of GEOGRAPHY_FEATURE_KINDS) counts[kind] = geography.list(kind).length;
  const severities = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of prepared.diagnostics)
    if (diagnostic.severity === 'error' || diagnostic.severity === 'blocker') severities.error++;
    else severities[diagnostic.severity]++;
  return {
    schemaVersion: 1,
    offlineRepresentation: true,
    operationId: prepared.operationId,
    geographyVersion: 1,
    modelHash: geography.hash,
    valid: prepared.valid,
    source:
      prepared.source.kind === 'file'
        ? {
            kind: 'file',
            path: prepared.source.evidence.displayPath,
            bytes: prepared.source.bytes,
            sha256: prepared.source.sha256,
          }
        : { kind: 'inline', bytes: prepared.source.bytes, sha256: prepared.source.sha256 },
    frame: prepared.frame,
    edgeBand: prepared.edgeBand,
    hasReferenceImage: prepared.hasReference,
    synthesis:
      'not applied: this report validates the model; relief, rivers and biomes are synthesised from it by later stages',
    totals: { features: geography.featureCount, points: geography.pointCount },
    counts,
    climate: geography.climate,
    diagnosticCounts: severities,
    diagnostics: prepared.diagnostics.map(({ code, severity, message, details }) => ({
      code,
      severity,
      message,
      ...(details === undefined ? {} : { details }),
    })),
    features: geography.features().map((feature) => featureReport(geography, feature)),
    overlayLegend: legend,
  };
}

export interface GeographyArtifactInput {
  prepared: PreparedGeography;
  /** Distinguishes artifacts when one request holds several geography worlds. */
  ordinal: number;
  sourceHashes: Record<string, string>;
  budget?: RenderBudget;
  signal?: AbortSignal;
}

/** The overlay PNG and the JSON report, content-addressed by the artifact store. */
export async function buildGeographyArtifacts(
  input: GeographyArtifactInput,
): Promise<ArtifactWrite[]> {
  input.signal?.throwIfAborted();
  const { prepared } = input;
  const overlay = renderGeographyOverlay(
    prepared.geography,
    prepared.diagnostics,
    prepared.edgeBand,
  );
  (input.budget ?? new RenderBudget()).reserve(overlay.width, overlay.height, 'geography overlay');
  const png = await sharp(overlay.rgb, {
    raw: { width: overlay.width, height: overlay.height, channels: 3 },
  })
    .png()
    .toBuffer();
  input.signal?.throwIfAborted();
  const suffix = input.ordinal === 0 ? '' : `-${input.ordinal + 1}`;
  const provenance = {
    kind: 'map-geography',
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'map-geography.v1',
    sourceHashes: input.sourceHashes,
    renderProfile: { offline: true, width: overlay.width, height: overlay.height },
    metadata: {
      operationId: prepared.operationId,
      modelHash: prepared.geography.hash,
      binding:
        'offline drawing of the geography model; not a game screenshot and not a synthesised map',
    },
  };
  return [
    {
      name: `map-geography-overlay${suffix}.png`,
      mimeType: 'image/png',
      content: png,
      provenance,
      description:
        'Offline overlay of the geography model with feature ids; defects outlined in red and orange',
    },
    {
      name: `map-geography-report${suffix}.json`,
      mimeType: 'application/json',
      content: `${canonicalJson(buildGeographyReport(prepared))}\n`,
      provenance,
      description: 'Resolved ids, areas, references and diagnostics of the geography model',
    },
  ];
}

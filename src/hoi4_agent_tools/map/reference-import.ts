/**
 * Evidence for an imported reference (ADR 0067): what each registered sheet supplied, the class
 * shares of the interpreted picture and how far the geography model's land agrees with it.
 * Disagreement above the threshold is an error diagnostic, which blocks the write but leaves the
 * preview and its evidence available.
 */
import sharp from 'sharp';
import type { ArtifactWrite } from '../core/artifacts.js';
import { canonicalJson } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { PACKAGE_VERSION } from '../version.js';
import type { ResolvedGeography } from './geography/model.js';
import { rasterizeGeographyKind } from './relief/land.js';
import { REFERENCE_TERRAIN, type ReferenceWorldRaster } from './reference-world.js';
import type { SheetCoverage } from './reference-sheets.js';

export interface ImportAgreementThresholds {
  /** Below this land intersection over union the write is blocked. */
  minLandIou: number;
  /** Below this the agreement is reported as a warning. */
  warnLandIou: number;
}

/** Conservative defaults: block only on a gross mismatch, warn on any visible one. */
export const DEFAULT_IMPORT_AGREEMENT: ImportAgreementThresholds = {
  minLandIou: 0.85,
  warnLandIou: 0.95,
};

const CELL = 128;
const WORST_CELLS = 12;
const FEATURE_LIMIT = 64;
/** A point this many pixels from the drawing's coast still counts as on either side. */
const COAST_TOLERANCE_PX = 3;

export interface ImportAgreement {
  landIou: number;
  drawingLandPx: number;
  modelLandPx: number;
  bothLandPx: number;
  drawingOnlyLandPx: number;
  modelOnlyLandPx: number;
  thresholds: ImportAgreementThresholds;
  /** Grid cells of 128 pixels with the most disagreeing pixels, worst first. */
  worstCells: Array<{ x: number; y: number; drawingOnly: number; modelOnly: number }>;
  /** Model features the drawing places on the wrong surface. */
  features: Array<{ id: string; kind: string; issue: string; x: number; y: number }>;
  featureCount: number;
}

export interface ImportReport {
  operationId: string;
  width: number;
  height: number;
  registration?: { sheets: SheetCoverage[]; uncoveredPx: number };
  classes: { seaPx: number; lakePx: number; landPx: number; terrainPx: Record<string, number> };
  agreement?: ImportAgreement;
}

const TERRAIN_NAMES = Object.fromEntries(
  Object.entries(REFERENCE_TERRAIN).map(([name, index]) => [index, name]),
) as Record<number, string>;

function surfaceAt(surface: ReferenceWorldRaster, x: number, y: number): number | undefined {
  const px = Math.floor(x * surface.width);
  const py = Math.floor(y * surface.height);
  if (px < 0 || py < 0 || px >= surface.width || py >= surface.height) return undefined;
  return surface.kind[py * surface.width + px];
}

/** True when some pixel within the coast tolerance of the point has the wanted surface. */
function nearSurface(
  surface: ReferenceWorldRaster,
  x: number,
  y: number,
  wanted: (kind: number) => boolean,
): boolean {
  const cx = Math.floor(x * surface.width);
  const cy = Math.floor(y * surface.height);
  for (let dy = -COAST_TOLERANCE_PX; dy <= COAST_TOLERANCE_PX; dy += 1)
    for (let dx = -COAST_TOLERANCE_PX; dx <= COAST_TOLERANCE_PX; dx += 1) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= surface.width || py >= surface.height) continue;
      if (wanted(surface.kind[py * surface.width + px]!)) return true;
    }
  return false;
}

function measureAgreement(
  surface: ReferenceWorldRaster,
  geography: ResolvedGeography,
  seed: number,
  thresholds: ImportAgreementThresholds,
): ImportAgreement {
  const { width, height } = surface;
  const model = rasterizeGeographyKind(geography, { width, height, seed });
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const drawingOnlyCells = new Float64Array(columns * rows);
  const modelOnlyCells = new Float64Array(columns * rows);
  let drawingLand = 0;
  let modelLand = 0;
  let both = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const drawn = surface.kind[pixel] === 1;
      const modelled = model[pixel] === 1;
      if (drawn) drawingLand += 1;
      if (modelled) modelLand += 1;
      if (drawn && modelled) both += 1;
      else if (drawn || modelled) {
        const cell = Math.floor(y / CELL) * columns + Math.floor(x / CELL);
        if (drawn) drawingOnlyCells[cell] = drawingOnlyCells[cell]! + 1;
        else modelOnlyCells[cell] = modelOnlyCells[cell]! + 1;
      }
    }
  const union = drawingLand + modelLand - both;
  const worstCells = Array.from({ length: columns * rows }, (_, cell) => cell)
    .map((cell) => ({
      x: (cell % columns) * CELL,
      y: Math.floor(cell / columns) * CELL,
      drawingOnly: drawingOnlyCells[cell]!,
      modelOnly: modelOnlyCells[cell]!,
    }))
    .filter((cell) => cell.drawingOnly + cell.modelOnly > 0)
    .sort(
      (left, right) =>
        right.drawingOnly + right.modelOnly - (left.drawingOnly + left.modelOnly) ||
        left.y - right.y ||
        left.x - right.x,
    )
    .slice(0, WORST_CELLS);
  const features: ImportAgreement['features'] = [];
  const isLand = (kind: number) => kind === 1;
  const isWater = (kind: number) => kind !== 1;
  for (const site of geography.sites) {
    if (site.onWater || site.lakeId !== undefined) continue;
    if (!nearSurface(surface, site.at.x, site.at.y, isLand))
      features.push({ id: site.id, kind: 'site', issue: 'in the drawing’s water', ...site.at });
  }
  for (const volcano of geography.volcanoes)
    if (!nearSurface(surface, volcano.at.x, volcano.at.y, isLand))
      features.push({
        id: volcano.id,
        kind: 'volcano',
        issue: 'in the drawing’s water',
        ...volcano.at,
      });
  for (const river of geography.rivers) {
    const { source, mouth } = river;
    if (source.type === 'point' && surfaceAt(surface, source.x, source.y) !== 1)
      features.push({
        id: river.id,
        kind: 'river',
        issue: 'source in the drawing’s water',
        x: source.x,
        y: source.y,
      });
    if (mouth.type === 'point' && !nearSurface(surface, mouth.x, mouth.y, isWater))
      features.push({
        id: river.id,
        kind: 'river',
        issue: 'mouth on the drawing’s land',
        x: mouth.x,
        y: mouth.y,
      });
  }
  features.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    landIou: union === 0 ? 1 : Number((both / union).toFixed(4)),
    drawingLandPx: drawingLand,
    modelLandPx: modelLand,
    bothLandPx: both,
    drawingOnlyLandPx: drawingLand - both,
    modelOnlyLandPx: modelLand - both,
    thresholds,
    worstCells,
    features: features.slice(0, FEATURE_LIMIT),
    featureCount: features.length,
  };
}

export function buildImportReport(input: {
  operationId: string;
  surface: ReferenceWorldRaster;
  seed: number;
  registration?: { coverage: SheetCoverage[]; uncovered: number };
  geography?: ResolvedGeography;
  thresholds?: { minLandIou?: number | undefined; warnLandIou?: number | undefined };
}): { report: ImportReport; diagnostics: Diagnostic[] } {
  const { surface, operationId } = input;
  const terrainPx: Record<string, number> = {};
  let sea = 0;
  let lake = 0;
  let land = 0;
  for (let pixel = 0; pixel < surface.kind.length; pixel += 1) {
    const kind = surface.kind[pixel];
    if (kind === 0) sea += 1;
    else if (kind === 2) lake += 1;
    else {
      land += 1;
      const name = TERRAIN_NAMES[surface.terrain[pixel]!] ?? 'other';
      terrainPx[name] = (terrainPx[name] ?? 0) + 1;
    }
  }
  const thresholds: ImportAgreementThresholds = {
    minLandIou: input.thresholds?.minLandIou ?? DEFAULT_IMPORT_AGREEMENT.minLandIou,
    warnLandIou: input.thresholds?.warnLandIou ?? DEFAULT_IMPORT_AGREEMENT.warnLandIou,
  };
  const report: ImportReport = {
    operationId,
    width: surface.width,
    height: surface.height,
    ...(input.registration === undefined
      ? {}
      : {
          registration: {
            sheets: input.registration.coverage,
            uncoveredPx: input.registration.uncovered,
          },
        }),
    classes: { seaPx: sea, lakePx: lake, landPx: land, terrainPx },
    ...(input.geography === undefined
      ? {}
      : { agreement: measureAgreement(surface, input.geography, input.seed, thresholds) }),
  };
  const diagnostics: Diagnostic[] = [];
  for (const sheet of input.registration?.coverage ?? [])
    if (sheet.pixels === 0)
      diagnostics.push({
        code: 'MAP_REFERENCE_SHEET_HIDDEN',
        severity: 'warning',
        category: 'map',
        operationId,
        message: `Sheet ${sheet.id} supplies no world pixel: higher-order sheets cover it or it lies outside the frame`,
        details: { sheetId: sheet.id, hiddenPx: sheet.hidden },
      });
  const agreement = report.agreement;
  if (agreement !== undefined) {
    const severity =
      agreement.landIou < thresholds.minLandIou
        ? 'error'
        : agreement.landIou < thresholds.warnLandIou
          ? 'warning'
          : 'info';
    diagnostics.push({
      code: severity === 'error' ? 'MAP_IMPORT_SOURCES_DISAGREE' : 'MAP_IMPORT_SOURCES_AGREEMENT',
      severity,
      category: 'map',
      operationId,
      message: `The geography model's land and the reference's land overlap with intersection over union ${agreement.landIou} (block below ${thresholds.minLandIou}, warn below ${thresholds.warnLandIou}); ${agreement.drawingOnlyLandPx} pixels are land only in the reference and ${agreement.modelOnlyLandPx} only in the model. map-import-report.json lists the worst areas and map-import-alignment.png draws both coasts.`,
      details: {
        landIou: agreement.landIou,
        drawingOnlyLandPx: agreement.drawingOnlyLandPx,
        modelOnlyLandPx: agreement.modelOnlyLandPx,
        worstCells: agreement.worstCells.slice(0, 3),
      },
    });
    if (agreement.featureCount > 0)
      diagnostics.push({
        code: 'MAP_IMPORT_FEATURE_SURFACE',
        severity: 'warning',
        category: 'map',
        operationId,
        message: `${agreement.featureCount} model features lie on the wrong surface of the reference (a site or volcano in its water, a river source in water or mouth on land); see map-import-report.json`,
        details: { features: agreement.features.slice(0, 8) },
      });
  }
  return { report, diagnostics };
}

const CLASS_COLOURS: Record<number, readonly [number, number, number]> = {
  0: [150, 200, 90],
  1: [40, 120, 50],
  2: [220, 205, 120],
  3: [140, 120, 110],
  4: [235, 240, 245],
  5: [150, 40, 30],
  6: [150, 120, 70],
  7: [80, 130, 110],
  8: [30, 90, 40],
};

/**
 * Offline review drawings of the import, at most `maxSide` pixels per side: the classes, and the
 * registered picture with the reference coast in red and the model coast in yellow. They are
 * drawings of the tool's interpretation, never game images.
 */
export async function renderImportImages(input: {
  surface: ReferenceWorldRaster;
  registered: Buffer | undefined;
  geography?: ResolvedGeography;
  seed: number;
  maxSide: number;
}): Promise<{ classes: Buffer; alignment: Buffer }> {
  const { surface } = input;
  const { width, height } = surface;
  const scale = Math.min(1, input.maxSide / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const classes = Buffer.alloc(outWidth * outHeight * 3);
  const alignment = Buffer.alloc(outWidth * outHeight * 3);
  const registered =
    input.registered === undefined
      ? undefined
      : await sharp(input.registered)
          .resize(outWidth, outHeight, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer();
  const model =
    input.geography === undefined
      ? undefined
      : rasterizeGeographyKind(input.geography, { width, height, seed: input.seed });
  const landAt = (kind: ArrayLike<number>, x: number, y: number) =>
    kind[Math.min(height - 1, y) * width + Math.min(width - 1, x)] === 1;
  for (let oy = 0; oy < outHeight; oy += 1)
    for (let ox = 0; ox < outWidth; ox += 1) {
      const x = Math.min(width - 1, Math.floor(ox / scale));
      const y = Math.min(height - 1, Math.floor(oy / scale));
      const pixel = y * width + x;
      const target = (oy * outWidth + ox) * 3;
      const kind = surface.kind[pixel]!;
      const colour =
        kind === 0
          ? [30, 70, 160]
          : kind === 2
            ? [70, 170, 230]
            : CLASS_COLOURS[surface.terrain[pixel]!]!;
      classes.set(colour, target);
      const base = registered?.subarray(target, target + 3) ?? Buffer.from(colour);
      alignment[target] = Math.round(base[0]! * 0.6);
      alignment[target + 1] = Math.round(base[1]! * 0.6);
      alignment[target + 2] = Math.round(base[2]! * 0.6);
      const step = Math.max(1, Math.ceil(1 / scale));
      const coast = (raster: ArrayLike<number>) =>
        landAt(raster, x, y) !== landAt(raster, x + step, y) ||
        landAt(raster, x, y) !== landAt(raster, x, y + step);
      if (model !== undefined && coast(model)) alignment.set([255, 220, 0], target);
      if (coast(surface.kind)) alignment.set([255, 40, 40], target);
    }
  const encode = (data: Buffer) =>
    sharp(data, { raw: { width: outWidth, height: outHeight, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  return { classes: await encode(classes), alignment: await encode(alignment) };
}

/** One imported reference, prepared for its evidence artifacts. */
export interface PreparedImport {
  report: ImportReport;
  surface: ReferenceWorldRaster;
  registered?: Buffer;
  geography?: ResolvedGeography;
  seed: number;
  sourceHashes: Record<string, string>;
}

const IMPORT_IMAGE_MAX_SIDE = 2_048;

export async function buildImportArtifacts(
  prepared: PreparedImport,
  ordinal: number,
): Promise<ArtifactWrite[]> {
  const suffix = ordinal === 0 ? '' : `-${ordinal + 1}`;
  const images = await renderImportImages({
    surface: prepared.surface,
    registered: prepared.registered,
    ...(prepared.geography === undefined ? {} : { geography: prepared.geography }),
    seed: prepared.seed,
    maxSide: IMPORT_IMAGE_MAX_SIDE,
  });
  const provenance = {
    kind: 'map-import',
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'map-import.v1',
    sourceHashes: prepared.sourceHashes,
    renderProfile: { offline: true, maxSide: IMPORT_IMAGE_MAX_SIDE },
    metadata: {
      operationId: prepared.report.operationId,
      binding:
        'offline drawing of the interpreted reference and the geography model; not a game screenshot',
    },
  };
  const writes: ArtifactWrite[] = [
    {
      name: `map-import-report${suffix}.json`,
      mimeType: 'application/json',
      content: `${canonicalJson(prepared.report)}\n`,
      provenance,
    },
    {
      name: `map-import-classes${suffix}.png`,
      mimeType: 'image/png',
      content: images.classes,
      provenance,
    },
    {
      name: `map-import-alignment${suffix}.png`,
      mimeType: 'image/png',
      content: images.alignment,
      provenance,
    },
  ];
  if (prepared.registered !== undefined)
    writes.push({
      name: `map-import-registration${suffix}.png`,
      mimeType: 'image/png',
      content: prepared.registered,
      provenance,
    });
  return writes;
}

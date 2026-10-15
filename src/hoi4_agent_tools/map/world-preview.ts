import sharp from 'sharp';
import type { ArtifactProvenance, ArtifactWrite } from '../core/artifacts.js';
import { canonicalJson } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { RENDER_MAX_DECODED_PIXELS, RenderBudget } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { MapWorkspaceIndex } from './model.js';
import type { MapOperationPlan } from './operations.js';
import { previewGraphicalTerrain, previewPoliticalPalette } from './world-preview-style.js';

/** A rolled-back generation must never present the unchanged source map as a new world. */
export function generatedWorldOperationIds(
  plan: Pick<MapOperationPlan, 'operations' | 'diagnostics' | 'blockers'>,
): ReadonlySet<string> {
  const requested = new Set(
    plan.operations.filter(({ kind }) => kind === 'create_world').map(({ id }) => id),
  );
  const blocked = new Set(plan.blockers.map(({ operationId }) => operationId));
  return new Set(
    plan.diagnostics.flatMap(({ code, operationId }) =>
      code === 'MAP_WORLD_CREATED' &&
      operationId !== undefined &&
      requested.has(operationId) &&
      !blocked.has(operationId)
        ? [operationId]
        : [],
    ),
  );
}

export interface WorldPreviewReference {
  operationId: string;
  bytes: Buffer;
}

const terrainColors: Record<string, readonly [number, number, number]> = {
  plains: [151, 177, 104],
  hills: [128, 147, 98],
  mountain: [139, 139, 130],
  forest: [64, 115, 66],
  jungle: [40, 93, 56],
  marsh: [110, 154, 144],
  desert: [219, 194, 128],
  urban: [159, 144, 136],
  ocean: [40, 80, 116],
  lakes: [68, 127, 159],
  lake: [68, 127, 159],
  snow: [232, 235, 232],
};

// A fixed bitmap alphabet avoids machine-dependent installed fonts in preview labels.
const glyphs: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
};

function labelSvg(
  width: number,
  height: number,
  labels: Array<{ text: string; x: number; y: number }>,
): Buffer {
  const rectangles: string[] = [];
  for (const label of labels)
    for (let letter = 0; letter < label.text.length; letter += 1)
      for (const [y, row] of (glyphs[label.text[letter]!] ?? []).entries())
        for (let x = 0; x < row.length; x += 1)
          if (row[x] === '1')
            rectangles.push(
              `<rect x="${label.x + letter * 12 + x * 2}" y="${label.y + y * 2}" width="2" height="2"/>`,
            );
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g fill="#e8edf2">${rectangles.join('')}</g></svg>`,
  );
}

/** Bounded offline evidence, sampled directly from the generated map, never from the game. */
export async function buildWorldPreviewArtifacts(input: {
  index: MapWorkspaceIndex;
  references: readonly WorldPreviewReference[];
  diagnostics: readonly Diagnostic[];
  provenance: ArtifactProvenance;
  budget?: RenderBudget;
  signal?: AbortSignal;
}): Promise<ArtifactWrite[]> {
  input.signal?.throwIfAborted();
  const raster = input.index.raster;
  if (raster === undefined) return [];
  const scale = Math.min(1, 768 / raster.width, 512 / raster.height);
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  const panelWidth = Math.max(width, 128);
  const budget = input.budget ?? new RenderBudget();
  budget.reserve(width, height, 'world terrain preview');
  budget.reserve(width, height, 'world political preview');
  const terrain = Buffer.alloc(width * height * 3);
  const political = Buffer.alloc(width * height * 3);
  const ownerByProvince = new Map<number, string>();
  for (const state of input.index.states)
    for (const province of state.provinces) ownerByProvince.set(province, state.owner ?? 'unowned');
  const politicalPalette = previewPoliticalPalette(input.index, new Set(ownerByProvince.values()));
  const politicalColors = politicalPalette.colors;
  const graphical = previewGraphicalTerrain(input.index);
  const styleEvidence = {
    politicalColors: Object.fromEntries(politicalColors),
    politicalColorSources: Object.fromEntries(politicalPalette.sources),
    politicalColorFallback: { algorithm: 'stable-tag-sha256', tags: politicalPalette.fallbackTags },
    graphicalTerrain: {
      bitmapAvailable: graphical.terrain !== undefined,
      cityFootprintsAvailable: graphical.cities !== undefined,
      sourceFiles: graphical.sourceFiles,
      permanentSnowIndices: [...graphical.snowIndices].sort((a, b) => a - b),
      missingDefinitionsFallback:
        'generated-world vanilla terrain slots, then province definitions',
    },
  };
  for (let y = 0; y < height; y += 1) {
    input.signal?.throwIfAborted();
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(raster.width - 1, Math.floor(x / scale));
      const sourceY = Math.min(raster.height - 1, Math.floor(y / scale));
      const province = raster.provinceIds[sourceY * raster.width + sourceX]!;
      const definition = input.index.definitionsById.get(province);
      const land = definition?.type === 'land';
      const graphicalIndex = graphical.terrain?.paletteIndexAt(sourceX, sourceY);
      const graphicalType =
        graphicalIndex === undefined ? undefined : graphical.types.get(graphicalIndex);
      const snow = graphicalIndex !== undefined && graphical.snowIndices.has(graphicalIndex);
      const city = land && graphical.cities?.paletteIndexAt(sourceX, sourceY) === 15;
      const terrainColor =
        terrainColors[
          city ? 'urban' : snow && land ? 'snow' : (graphicalType ?? definition?.terrain ?? 'ocean')
        ] ?? terrainColors.plains!;
      const owner = ownerByProvince.get(province) ?? 'unowned';
      const politicalColor = land
        ? (politicalColors.get(owner) ?? [120, 120, 120])
        : terrainColors.ocean!;
      const shade = land
        ? Math.max(
            0.72,
            Math.min(
              1.2,
              1 +
                (input.index.heightAt(sourceX, sourceY) -
                  input.index.heightAt(Math.max(0, sourceX - 2), Math.max(0, sourceY - 2))) *
                  0.035,
            ),
          )
        : 1;
      for (let channel = 0; channel < 3; channel += 1) {
        terrain[(y * width + x) * 3 + channel] = Math.round(
          Math.min(255, terrainColor[channel]! * shade),
        );
        political[(y * width + x) * 3 + channel] = politicalColor[channel]!;
      }
      const neighbor =
        sourceX > 0 ? raster.provinceIds[sourceY * raster.width + sourceX - 1] : province;
      if (land && ownerByProvince.get(neighbor!) !== owner)
        political.fill(37, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  const raw = { width, height, channels: 3 as const };
  const [terrainPng, politicalPng] = await Promise.all([
    sharp(terrain, { raw }).png().toBuffer(),
    sharp(political, { raw }).png().toBuffer(),
  ]);
  const writes: ArtifactWrite[] = [];
  const references = input.references.length > 0 ? input.references : [undefined];
  for (const [referenceIndex, reference] of references.entries()) {
    input.signal?.throwIfAborted();
    budget.reserve(panelWidth, height, 'world reference preview');
    let referencePng: Buffer;
    try {
      referencePng =
        reference === undefined
          ? await sharp({
              create: { width: panelWidth, height, channels: 3, background: '#18212a' },
            })
              .png()
              .toBuffer()
          : await sharp(reference.bytes, {
              limitInputPixels: RENDER_MAX_DECODED_PIXELS,
              animated: false,
            })
              .resize(panelWidth, height, { fit: 'contain', background: '#18212a' })
              .png()
              .toBuffer();
    } catch {
      throw new ServiceError(
        'MAP_WORLD_PREVIEW_REFERENCE_INVALID',
        'The reference image could not be safely rendered',
      );
    }
    const gap = 12,
      header = 32,
      footer = 28;
    const combinedWidth = panelWidth * 3 + gap * 4;
    const combinedHeight = height + header + footer;
    budget.reserve(combinedWidth, combinedHeight, 'world side-by-side preview');
    const png = await sharp({
      create: { width: combinedWidth, height: combinedHeight, channels: 3, background: '#101820' },
    })
      .composite([
        { input: referencePng, left: gap, top: header },
        {
          input: terrainPng,
          left: panelWidth + gap * 2 + Math.floor((panelWidth - width) / 2),
          top: header,
        },
        {
          input: politicalPng,
          left: panelWidth * 2 + gap * 3 + Math.floor((panelWidth - width) / 2),
          top: header,
        },
        {
          input: labelSvg(combinedWidth, combinedHeight, [
            { text: reference === undefined ? 'GENERATED' : 'REFERENCE', x: gap, y: 9 },
            { text: 'TERRAIN', x: panelWidth + gap * 2, y: 9 },
            { text: 'POLITICAL', x: panelWidth * 2 + gap * 3, y: 9 },
            { text: 'OFFLINE GENERATED PREVIEW', x: gap, y: header + height + 8 },
          ]),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    writes.push({
      name:
        referenceIndex === 0
          ? 'map-world-preview.png'
          : `map-world-preview-${referenceIndex + 1}.png`,
      mimeType: 'image/png',
      content: png,
      provenance: {
        ...input.provenance,
        kind: 'map-world-preview',
        schemaVersion: 'map-world-preview.v1',
        renderProfile: {
          offline: true,
          panels: ['reference', 'terrain', 'political'],
          width,
          height,
        },
        metadata: {
          ...input.provenance.metadata,
          ...styleEvidence,
          operationId: reference?.operationId ?? null,
          binding: 'content-addressed offline world comparison evidence',
        },
      },
      description:
        'Offline side-by-side reference, generated terrain and political map; not an in-game screenshot',
    });
  }
  const provenance = {
    ...input.provenance,
    kind: 'map-world-preview',
    schemaVersion: 'map-world-preview.v1',
    metadata: {
      ...input.provenance.metadata,
      ...styleEvidence,
      binding: 'content-addressed offline world comparison evidence',
    },
  };
  writes.push(
    { name: 'map-world-terrain.png', mimeType: 'image/png', content: terrainPng, provenance },
    { name: 'map-world-political.png', mimeType: 'image/png', content: politicalPng, provenance },
    {
      name: 'map-world-preview.json',
      mimeType: 'application/json',
      content: `${canonicalJson({ schemaVersion: 1, offlineRepresentation: true, width: raster.width, height: raster.height, previewWidth: width, previewHeight: height, panelOrder: ['reference', 'terrain', 'political'], terrainLegend: terrainColors, ...styleEvidence, provinces: input.index.definitions.filter(({ id }) => id > 0).length, states: input.index.states.length, regions: input.index.regions.length, countries: [...new Set(input.index.states.flatMap(({ owner }) => (owner === undefined ? [] : [owner])))].sort(), referenceCount: input.references.length, warnings: input.diagnostics.filter(({ severity }) => severity === 'warning').map(({ code, message }) => ({ code, message })) })}\n`,
      provenance,
    },
  );
  return writes;
}

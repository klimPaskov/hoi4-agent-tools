import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { RenderBudget } from '../../src/hoi4_agent_tools/core/render-budget.js';
import {
  buildGeographyArtifacts,
  buildGeographyReport,
  renderGeographyOverlay,
  resolveGeography,
  type PreparedGeography,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  geographyModelSchema,
  type GeographyModelInput,
} from '../../src/hoi4_agent_tools/schemas/geography.js';
import { GEOGRAPHY_FIXTURE_FRAME, syntheticGeography } from '../helpers/geography-fixture.js';

function prepared(model: GeographyModelInput, frame = GEOGRAPHY_FIXTURE_FRAME): PreparedGeography {
  const resolution = resolveGeography(geographyModelSchema.parse(model), { frame });
  return {
    ...resolution,
    operationId: 'world',
    source: { kind: 'inline', bytes: 100, sha256: sha256Bytes(JSON.stringify(model)) },
    frame,
    hasReference: false,
  };
}

interface FeatureEntry {
  id: string;
  areaFraction: number;
  areaPixels: number;
  lengthPixels: number;
  between: unknown;
}

interface Report {
  modelHash: string;
  valid: boolean;
  diagnosticCounts: Record<string, number>;
  diagnostics: Array<{ code: string; severity: string; details?: Record<string, unknown> }>;
  features: FeatureEntry[];
}

async function decode(png: Buffer) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function count(
  image: { data: Buffer; channels: number },
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  let total = 0;
  for (let index = 0; index < image.data.length; index += image.channels)
    if (predicate(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!)) total++;
  return total;
}

describe('geography overlay and report', () => {
  it('produces a PNG overlay and a canonical JSON report', async () => {
    const writes = await buildGeographyArtifacts({
      prepared: prepared(syntheticGeography()),
      ordinal: 0,
      sourceHashes: { 'inline:geography': 'a'.repeat(64) },
    });
    expect(writes.map(({ name, mimeType }) => [name, mimeType])).toEqual([
      ['map-geography-overlay.png', 'image/png'],
      ['map-geography-report.json', 'application/json'],
    ]);
    const image = await decode(writes[0]!.content as Buffer);
    // 4096 by 2048 is drawn at 1536 pixels wide, keeping the aspect ratio.
    expect([image.width, image.height]).toEqual([1_536, 768]);
    expect(writes[0]!.provenance).toMatchObject({
      kind: 'map-geography',
      schemaVersion: 'map-geography.v1',
      sourceHashes: { 'inline:geography': 'a'.repeat(64) },
      metadata: { operationId: 'world' },
    });
    expect(writes[0]!.description).toMatch(/offline/iu);
    const report = JSON.parse(writes[1]!.content as string) as unknown as Report;
    expect(report).toMatchObject({
      schemaVersion: 1,
      offlineRepresentation: true,
      geographyVersion: 1,
      valid: true,
      frame: { width: 4096, height: 2048 },
      totals: { features: 16 },
      counts: {
        sea: 1,
        land: 2,
        region: 1,
        range: 1,
        pass: 1,
        volcano: 1,
        river: 2,
        lake: 1,
        biome: 3,
        strait: 1,
        site: 2,
        plateau: 0,
      },
      diagnosticCounts: { error: 0, warning: 0, info: 0 },
      source: { kind: 'inline', bytes: 100 },
    });
    expect(report.modelHash).toBe(prepared(syntheticGeography()).geography.hash);
    expect(writes[1]!.content as string).toMatch(/\n$/u);
  });

  it('lists every feature with its resolved id, area and references', () => {
    const report = buildGeographyReport(prepared(syntheticGeography())) as {
      features: FeatureEntry[];
    };
    const byId = new Map(report.features.map((feature) => [feature.id, feature]));
    expect(report.features.map((feature) => feature.id)).toHaveLength(16);
    const aldoria = byId.get('aldoria')!;
    expect(aldoria.areaPixels).toBe(Math.round(aldoria.areaFraction * 4096 * 2048));
    expect(aldoria.areaFraction).toBeGreaterThan(0.1);
    expect(aldoria).toMatchObject({
      region: 'old_realm',
      regionSource: 'containment',
      polygons: 1,
    });
    expect(byId.get('spine')).toMatchObject({ passes: ['spine_gap'], barrier: 'impassable' });
    expect(byId.get('spine')!.lengthPixels).toBeGreaterThan(500);
    expect(byId.get('silver')).toMatchObject({
      tributaries: ['tribute'],
      source: { lake: 'mirror' },
      mouth: 'point',
    });
    expect(byId.get('tribute')).toMatchObject({ mouth: { river: 'silver' } });
    expect(byId.get('aldor')).toMatchObject({
      land: 'aldoria',
      region: 'old_realm',
      siteKind: 'capital',
    });
    expect(byId.get('old_realm')).toMatchObject({ landIds: ['aldoria'] });
    expect(byId.get('brim_strait')!.between).toEqual([{ land: 'aldoria' }, { land: 'brim' }]);
    expect(byId.get('mirror')).toMatchObject({ land: 'aldoria', outflow: 'silver' });
    expect(byId.get('ember')).toMatchObject({ land: 'aldoria' });
  });

  it('is byte-for-byte deterministic', async () => {
    const run = async () =>
      (
        await buildGeographyArtifacts({
          prepared: prepared(syntheticGeography()),
          ordinal: 0,
          sourceHashes: {},
        })
      ).map(({ content }) => sha256Bytes(content));
    expect(await run()).toEqual(await run());
  });

  it('draws water, land and labels', () => {
    const overlay = renderGeographyOverlay(prepared(syntheticGeography()).geography, [], {
      westEastPx: 192,
      northSouthPx: 64,
    });
    expect(overlay.labels).toBeGreaterThan(5);
    expect(overlay.labels).toBeLessThanOrEqual(320);
    const pixel = (x: number, y: number) => {
      const index =
        (Math.floor(y * overlay.height) * overlay.width + Math.floor(x * overlay.width)) * 3;
      return [overlay.rgb[index]!, overlay.rgb[index + 1]!, overlay.rgb[index + 2]!];
    };
    // Open water outside every feature, land on the continent, sea in the sea.
    const openWater = pixel(0.3, 0.95);
    const sea = pixel(0.8, 0.8);
    const land = pixel(0.5, 0.7);
    expect(sea).not.toEqual(openWater);
    expect(land).not.toEqual(openWater);
    expect(land[1]!).toBeGreaterThan(land[2]!);
    expect(sea[2]!).toBeGreaterThan(sea[0]!);
    expect(overlay.legend.length).toBeGreaterThan(10);
  });

  it('outlines features that have errors in red and warnings in orange', async () => {
    const model = syntheticGeography();
    (model.sites ?? []).push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] });
    (model.regions ?? []).push({ id: 'empty_region' });
    const fine = prepared(syntheticGeography());
    const broken = prepared(model);
    expect(broken.valid).toBe(false);
    const red = (r: number, g: number, b: number) => r > 240 && g < 60 && b < 60;
    const orange = (r: number, g: number, b: number) => r > 240 && g > 150 && g < 180 && b < 30;
    const clean = await decode(
      (await buildGeographyArtifacts({ prepared: fine, ordinal: 0, sourceHashes: {} }))[0]!
        .content as Buffer,
    );
    const marked = await decode(
      (await buildGeographyArtifacts({ prepared: broken, ordinal: 0, sourceHashes: {} }))[0]!
        .content as Buffer,
    );
    expect(count(clean, red)).toBe(0);
    expect(count(marked, red)).toBeGreaterThan(50);
    // A warning on an area feature draws an orange outline.
    const warned = syntheticGeography();
    (warned.lands ?? []).push({
      id: 'shadow',
      polygons: [
        [
          [0.2, 0.3],
          [0.4, 0.3],
          [0.4, 0.5],
          [0.2, 0.5],
        ],
      ],
    });
    const orangeImage = await decode(
      (
        await buildGeographyArtifacts({ prepared: prepared(warned), ordinal: 0, sourceHashes: {} })
      )[0]!.content as Buffer,
    );
    expect(prepared(warned).diagnostics.map(({ code }) => code)).toContain(
      'MAP_GEOGRAPHY_LAND_OVERLAP',
    );
    expect(count(orangeImage, orange)).toBeGreaterThan(50);
    expect(count(clean, orange)).toBe(0);
  });

  it('reports defects in the report and marks the model invalid', () => {
    const model = syntheticGeography();
    (model.sites ?? []).push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] });
    const report = buildGeographyReport(prepared(model)) as unknown as Report;
    expect(report.valid).toBe(false);
    expect(report.diagnosticCounts).toMatchObject({ error: 1 });
    expect(report.diagnostics[0]).toMatchObject({
      code: 'MAP_GEOGRAPHY_SITE_IN_WATER',
      severity: 'error',
      details: { featureId: 'buoy' },
    });
  });

  it('numbers the artifacts of a second geography world', async () => {
    const writes = await buildGeographyArtifacts({
      prepared: prepared(syntheticGeography()),
      ordinal: 1,
      sourceHashes: {},
    });
    expect(writes.map(({ name }) => name)).toEqual([
      'map-geography-overlay-2.png',
      'map-geography-report-2.json',
    ]);
  });

  it('draws a 5,120 by 2,560 world with hundreds of features in a few seconds', async () => {
    const sites = Array.from({ length: 300 }, (_value, index) => ({
      id: `town${index}`,
      kind: 'city' as const,
      at: [0.2 + 0.001 * (index % 100), 0.3 + 0.01 * Math.floor(index / 100)] as [number, number],
    }));
    const model = { ...syntheticGeography(), sites };
    const started = Date.now();
    const writes = await buildGeographyArtifacts({
      prepared: prepared(model, { width: 5_120, height: 2_560 }),
      ordinal: 0,
      sourceHashes: {},
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    const image = await decode(writes[0]!.content as Buffer);
    expect(image.width).toBe(1_536);
  });

  it('refuses to draw past the render budget', async () => {
    const reserve = vi.fn(() => {
      throw new Error('RENDER_AGGREGATE_BLOCKED');
    });
    await expect(
      buildGeographyArtifacts({
        prepared: prepared(syntheticGeography()),
        ordinal: 0,
        sourceHashes: {},
        budget: { reserve } as unknown as RenderBudget,
      }),
    ).rejects.toThrow('RENDER_AGGREGATE_BLOCKED');
    expect(reserve).toHaveBeenCalledWith(1_536, 768, 'geography overlay');
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildGeographyArtifacts({
        prepared: prepared(syntheticGeography()),
        ordinal: 0,
        sourceHashes: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

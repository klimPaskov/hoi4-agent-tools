import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import {
  indexWithProposedChanges,
  planMapOperations,
  type MapOperation,
} from '../../src/hoi4_agent_tools/map/operations.js';
import { buildWorldPreviewArtifacts } from '../../src/hoi4_agent_tools/map/world-preview.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { RenderBudget } from '../../src/hoi4_agent_tools/core/render-budget.js';
import { previewPoliticalPalette } from '../../src/hoi4_agent_tools/map/world-preview-style.js';
import { createBmp } from '../../src/hoi4_agent_tools/map/bmp.js';

let index: MapWorkspaceIndex;
let reference: Buffer;
const provenance = {
  kind: 'test-preview',
  toolVersion: 'test',
  schemaVersion: 'test.v1',
  sourceHashes: {},
};

beforeAll(async () => {
  const planned = planMapOperations(MapWorkspaceIndex.build([]), [
    mapOperationSchema.parse({
      id: 'world',
      kind: 'create_world',
      width: 256,
      height: 256,
      seed: 3,
      countries: [{ tag: 'AUR', name: 'Aurelia' }],
    }) as MapOperation,
  ]);
  expect(planned.blockers).toEqual([]);
  index = planned.finalIndex;
  reference = await sharp({
    create: { width: 256, height: 128, channels: 3, background: '#204060' },
  })
    .png()
    .toBuffer();
});

describe('generated world preview evidence', () => {
  it('renders the exact active generated country colors instead of tag hashes', async () => {
    const colored = planMapOperations(MapWorkspaceIndex.build([]), [
      mapOperationSchema.parse({
        id: 'colors',
        kind: 'create_world',
        width: 256,
        height: 256,
        seed: 3,
        countries: [
          { tag: 'AUR', name: 'Aurelia', color: { r: 12, g: 34, b: 56 } },
          { tag: 'BOR', name: 'Borea', color: { r: 210, g: 80, b: 90 } },
        ],
      }) as MapOperation,
    ]).finalIndex;
    const artifacts = await buildWorldPreviewArtifacts({
      index: colored,
      references: [],
      diagnostics: [],
      provenance,
    });
    const pixels = await sharp(
      artifacts.find(({ name }) => name === 'map-world-political.png')!.content,
    )
      .removeAlpha()
      .raw()
      .toBuffer();
    const ownerFor = (id: number) => colored.stateForProvince(id)[0]?.owner;
    for (const [tag, color] of [
      ['AUR', [12, 34, 56]],
      ['BOR', [210, 80, 90]],
    ] as const) {
      const offset = colored.raster!.provinceIds.findIndex(
        (id, pixel) =>
          pixel % 256 > 0 &&
          colored.definitionsById.get(id)?.type === 'land' &&
          ownerFor(id) === tag &&
          ownerFor(colored.raster!.provinceIds[pixel - 1]!) === tag,
      );
      expect(offset).toBeGreaterThanOrEqual(0);
      expect([...pixels.subarray(offset * 3, offset * 3 + 3)]).toEqual(color);
    }
    const evidence = JSON.parse(
      String(artifacts.find(({ name }) => name === 'map-world-preview.json')!.content),
    ) as { politicalColors: Record<string, number[]>; politicalColorFallback: { tags: string[] } };
    expect(evidence.politicalColors).toEqual({ AUR: [12, 34, 56], BOR: [210, 80, 90] });
    expect(evidence.politicalColorFallback.tags).toEqual([]);
  });

  it('uses a deterministic, explicitly recorded fallback for unavailable country colors', async () => {
    expect(previewPoliticalPalette(index, new Set(['ZZZ']))).toEqual(
      previewPoliticalPalette(index, new Set(['ZZZ'])),
    );
    expect(previewPoliticalPalette(index, new Set(['ZZZ'])).fallbackTags).toEqual(['ZZZ']);
    const unavailable = indexWithProposedChanges(index, [
      {
        relativePath: 'common/country_tags/zz_world_countries.txt',
        content: Buffer.from('AUR = "../outside.txt"\n'),
      },
    ]);
    const artifacts = await buildWorldPreviewArtifacts({
      index: unavailable,
      references: [],
      diagnostics: [],
      provenance,
    });
    expect(
      artifacts.find(({ name }) => name === 'map-world-political.png')!.provenance.metadata,
    ).toMatchObject({
      politicalColorSources: {},
      politicalColorFallback: { algorithm: 'stable-tag-sha256', tags: ['AUR'] },
    });
    expect(
      await buildWorldPreviewArtifacts({
        index: unavailable,
        references: [],
        diagnostics: [],
        provenance,
      }),
    ).toEqual(artifacts);
  });

  it('shows graphical permanent snow over combat plains and the actual city footprint', async () => {
    const landPixels = [...index.raster!.provinceIds.entries()]
      .filter(([, id]) => index.definitionsById.get(id)?.terrain === 'plains')
      .slice(0, 3)
      .map(([pixel]) => pixel);
    expect(landPixels).toHaveLength(3);
    const terrain = new Uint8Array(256 * 256);
    terrain[landPixels[0]!] = 77;
    terrain[landPixels[1]!] = 19;
    const cities = new Uint8Array(256 * 256);
    cities[landPixels[2]!] = 15;
    const palette = Array.from({ length: 256 }, (_, value) => ({ r: value, g: value, b: value }));
    const bmp = (pixels: Uint8Array) =>
      createBmp({ width: 256, height: 256, bitsPerPixel: 8, palette, indexedPixels: pixels });
    const snowy = indexWithProposedChanges(index, [
      { relativePath: 'map/terrain.bmp', content: bmp(terrain) },
      { relativePath: 'map/cities.bmp', content: bmp(cities) },
      { relativePath: 'map/heightmap.bmp', content: bmp(new Uint8Array(256 * 256).fill(128)) },
      {
        relativePath: 'common/terrain/synthetic.txt',
        content: Buffer.from(
          'terrain = { plains = { type = plains color = { 0 } } snow_plain = { type = plains perm_snow = yes color = { 77 } } }\n',
        ),
      },
    ]);
    const artifacts = await buildWorldPreviewArtifacts({
      index: snowy,
      references: [],
      diagnostics: [],
      provenance,
    });
    const pixels = await sharp(
      artifacts.find(({ name }) => name === 'map-world-terrain.png')!.content,
    )
      .removeAlpha()
      .raw()
      .toBuffer();
    for (const pixel of landPixels.slice(0, 2)) {
      expect([...pixels.subarray(pixel * 3, pixel * 3 + 3)]).toEqual([232, 235, 232]);
      expect(snowy.definitionsById.get(snowy.raster!.provinceIds[pixel]!)!.terrain).toBe('plains');
    }
    expect([...pixels.subarray(landPixels[2]! * 3, landPixels[2]! * 3 + 3)]).toEqual([
      159, 144, 136,
    ]);
    expect(
      artifacts.find(({ name }) => name === 'map-world-terrain.png')!.provenance.metadata,
    ).toMatchObject({
      graphicalTerrain: {
        bitmapAvailable: true,
        cityFootprintsAvailable: true,
        permanentSnowIndices: [16, 19, 77],
      },
    });
  });

  it('preserves portrait map proportions and leaves enough room for panel labels', async () => {
    const portrait = planMapOperations(MapWorkspaceIndex.build([]), [
      mapOperationSchema.parse({
        id: 'portrait',
        kind: 'create_world',
        width: 256,
        height: 2048,
        countries: [{ tag: 'AUR', name: 'Aurelia' }],
      }) as MapOperation,
    ]).finalIndex;
    const artifacts = await buildWorldPreviewArtifacts({
      index: portrait,
      references: [{ operationId: 'portrait', bytes: reference }],
      diagnostics: [],
      provenance,
    });
    expect(await sharp(artifacts[0]!.content).metadata()).toMatchObject({
      width: 432,
      height: 572,
    });
    expect(await sharp(artifacts[1]!.content).metadata()).toMatchObject({ width: 64, height: 512 });
  });

  it('renders bounded deterministic reference, terrain and political panels with counts and warnings', async () => {
    const input = {
      index,
      references: [{ operationId: 'world', bytes: reference }],
      diagnostics: [
        {
          code: 'SYNTHETIC_WARNING',
          severity: 'warning' as const,
          category: 'map' as const,
          message: 'Synthetic refinement warning',
        },
      ],
      provenance,
    };
    const artifacts = await buildWorldPreviewArtifacts(input);
    expect(artifacts.map(({ name }) => name)).toEqual([
      'map-world-preview.png',
      'map-world-terrain.png',
      'map-world-political.png',
      'map-world-preview.json',
    ]);
    expect(await sharp(artifacts[0]!.content).metadata()).toMatchObject({
      width: 816,
      height: 316,
    });
    expect(await sharp(artifacts[1]!.content).metadata()).toMatchObject({
      width: 256,
      height: 256,
    });
    const evidence = JSON.parse(String(artifacts[3]!.content)) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      offlineRepresentation: true,
      width: 256,
      height: 256,
      panelOrder: ['reference', 'terrain', 'political'],
      referenceCount: 1,
      countries: ['AUR'],
      states: index.states.length,
      warnings: [{ code: 'SYNTHETIC_WARNING', message: 'Synthetic refinement warning' }],
    });
    expect(await buildWorldPreviewArtifacts(input)).toEqual(artifacts);
  });

  it('refuses undecodable reference images and observes cancellation', async () => {
    await expect(
      buildWorldPreviewArtifacts({
        index,
        references: [{ operationId: 'world', bytes: Buffer.from('not an image') }],
        diagnostics: [],
        provenance,
      }),
    ).rejects.toMatchObject({ code: 'MAP_WORLD_PREVIEW_REFERENCE_INVALID' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildWorldPreviewArtifacts({
        index,
        references: [],
        diagnostics: [],
        provenance,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('shares the existing aggregate render budget', async () => {
    const budget = new RenderBudget();
    budget.reserve(8192, 4096, 'earlier render one');
    budget.reserve(8192, 4096, 'earlier render two');
    await expect(
      buildWorldPreviewArtifacts({ index, references: [], diagnostics: [], provenance, budget }),
    ).rejects.toMatchObject({ code: 'RENDER_AGGREGATE_BLOCKED' });
  });
});

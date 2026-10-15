import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { prepareReferenceWorld } from '../../src/hoi4_agent_tools/map/reference-preparation.js';
import {
  extractReferenceWorld,
  type ReferenceWorldRaster,
} from '../../src/hoi4_agent_tools/map/reference-world.js';
import { extractReferenceLabels } from '../../src/hoi4_agent_tools/map/reference-labels.js';

vi.mock('../../src/hoi4_agent_tools/map/reference-world.js', () => ({
  extractReferenceWorld: vi.fn(),
}));
vi.mock('../../src/hoi4_agent_tools/map/reference-labels.js', () => ({
  extractReferenceLabels: vi.fn(),
}));

function raster(): ReferenceWorldRaster {
  const width = 256,
    height = 256,
    kind = new Uint8Array(width * height),
    country = new Uint16Array(kind.length);
  for (let y = 0; y < height; y++)
    for (let x = 64; x < 192; x++) {
      kind[y * width + x] = 1;
      country[y * width + x] = x < 128 ? 1 : 2;
    }
  return {
    width,
    height,
    sourceWidth: 32,
    sourceHeight: 64,
    referenceBounds: { x: 64, y: 0, width: 128, height: 256 },
    kind,
    country,
    terrain: new Uint8Array(kind.length),
    elevation: new Float32Array(kind.length),
    moisture: new Float32Array(kind.length),
    rivers: [],
    diagnostics: ['Synthetic extraction uncertainty.'],
    inferredCountries: [
      { id: 1, name: 'Region 1', color: { r: 150, g: 100, b: 50 } },
      { id: 2, name: 'Region 2', color: { r: 50, g: 150, b: 100 } },
    ],
  };
}

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-prepare-')),
    mod = path.join(base, 'mod');
  await mkdir(path.join(mod, 'references'), { recursive: true });
  const image = await sharp({
    create: { width: 32, height: 64, channels: 3, background: '#7fa35a' },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(mod, 'references/world.png'), image);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'reference', name: 'Reference', root: mod }],
    }),
  );
  return { resolver };
}

describe('reference preparation bridge', () => {
  beforeEach(() => {
    vi.mocked(extractReferenceWorld).mockResolvedValue(raster());
    vi.mocked(extractReferenceLabels).mockResolvedValue({
      warnings: ['Synthetic OCR uncertainty.'],
      labels: [
        { text: 'Aster', confidence: 95, x: 0.25, y: 0.5, width: 0.1, height: 0.03 },
        { text: 'Brum', confidence: 95, x: 0.75, y: 0.5, width: 0.1, height: 0.03 },
        { text: 'Azure Sea', confidence: 95, x: 0, y: 0.5, width: 0.1, height: 0.03 },
      ],
    });
  });

  it('supplies image-only world defaults, inferred countries and preserved sea names', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      reference: { imagePath: 'references/world.png' },
    });
    expect(extractReferenceWorld).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ width: 5632, height: 2048, seed: 1 }),
    );
    expect(vi.mocked(extractReferenceWorld).mock.calls.at(-1)![1].ignoreMasks).toHaveLength(3);
    expect(vi.mocked(extractReferenceLabels).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(extractReferenceWorld).mock.invocationCallOrder.at(-1)!,
    );
    expect(loaded.prepared.countries).toMatchObject([
      { tag: 'X01', name: 'Aster' },
      { tag: 'X02', name: 'Brum' },
    ]);
    expect(loaded.prepared.cities).toMatchObject([
      { name: 'Aster', x: 96, y: 128, countryTag: 'X01' },
      { name: 'Brum', x: 160, y: 128, countryTag: 'X02' },
    ]);
    expect(loaded.prepared.labels).toContainEqual({
      name: 'Azure Sea',
      x: 64,
      y: 128,
      kind: 'sea',
    });
    expect(loaded.prepared.diagnostics).toContain('Synthetic OCR uncertainty.');
    expect(loaded.images).toHaveLength(1);
  });

  it('uses reviewed labels and maps normalized positions through aspect-preserving bounds', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      countries: [
        { tag: 'AAA', name: 'Aster' },
        { tag: 'BBB', name: 'Brum' },
      ],
      reference: {
        imagePath: 'references/world.png',
        cities: [{ name: 'Port', x: 0.5, y: 0.5, countryTag: 'AAA' }],
        labels: [{ name: 'Reviewed State', x: 0.25, y: 0.5, kind: 'state' }],
      },
    });
    expect(loaded.prepared.cities).toEqual([{ name: 'Port', x: 128, y: 128, countryTag: 'AAA' }]);
    expect(loaded.prepared.labels).toContainEqual({
      name: 'Reviewed State',
      x: 96,
      y: 128,
      kind: 'state',
    });
    expect(loaded.prepared.labels.some(({ name }) => name === 'Aster')).toBe(false);
    expect(loaded.prepared.labels).toHaveLength(1);
    expect(loaded.prepared.labels.some(({ name }) => name === 'Brum' || name === 'Azure Sea')).toBe(
      false,
    );
  });

  it('treats an empty reviewed label set as explicit exclusion of OCR names', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      reference: { imagePath: 'references/world.png', labels: [] },
    });
    expect(loaded.prepared.labels).toEqual([]);
    expect(loaded.prepared.cities).toEqual([]);
    expect(loaded.prepared.countries.map(({ name }) => name)).toEqual(['Region 1', 'Region 2']);
    expect(vi.mocked(extractReferenceWorld).mock.calls.at(-1)![1].ignoreMasks).toHaveLength(3);
  });

  it('retains an unnamed political region rather than borrowing a neighboring country label', async () => {
    const { resolver } = await setup();
    vi.mocked(extractReferenceLabels).mockResolvedValue({
      warnings: [],
      labels: [{ text: 'Corvel', confidence: 95, x: 0.75, y: 0.5, width: 0.1, height: 0.03 }],
    });
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      reference: { imagePath: 'references/world.png' },
    });
    expect(loaded.prepared.countries).toMatchObject([
      { tag: 'X01', name: 'Region 1', color: { r: 150, g: 100, b: 50 } },
      { tag: 'X02', name: 'Corvel', color: { r: 50, g: 150, b: 100 } },
    ]);
    expect(loaded.prepared.cities).toEqual([{ name: 'Corvel', x: 160, y: 128, countryTag: 'X02' }]);
    expect(loaded.prepared.diagnostics).toContain(
      'Political region 1 had no reliable name label within its borders; Region 1 was retained.',
    );
  });

  it('promotes automatic capital anchors only inside their matching political color region', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      countries: [
        { tag: 'AAA', name: 'Aster', color: { r: 50, g: 150, b: 100 } },
        { tag: 'BBB', name: 'Brum', color: { r: 150, g: 100, b: 50 } },
      ],
      reference: { imagePath: 'references/world.png' },
    });
    expect(loaded.prepared.cities).toEqual([
      { name: 'Aster', x: 96, y: 128, countryTag: 'BBB' },
      { name: 'Brum', x: 160, y: 128, countryTag: 'AAA' },
    ]);
  });

  it('keeps explicit city tags intact for downstream political conflict validation', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      countries: [
        { tag: 'AAA', name: 'Aster', color: { r: 150, g: 100, b: 50 } },
        { tag: 'BBB', name: 'Brum', color: { r: 50, g: 150, b: 100 } },
      ],
      reference: {
        imagePath: 'references/world.png',
        cities: [{ name: 'Contradictory anchor', x: 0.75, y: 0.5, countryTag: 'AAA' }],
      },
    });
    expect(loaded.prepared.cities).toEqual([
      { name: 'Contradictory anchor', x: 160, y: 128, countryTag: 'AAA' },
    ]);
  });

  it('does not infer political capital tags for countries without a matching color', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      countries: [
        { tag: 'AAA', name: 'Aster' },
        { tag: 'BBB', name: 'Brum', color: { r: 255, g: 255, b: 255 } },
      ],
      reference: { imagePath: 'references/world.png' },
    });
    expect(loaded.prepared.cities).toEqual([
      { name: 'Aster', x: 96, y: 128 },
      { name: 'Brum', x: 160, y: 128 },
    ]);
  });

  it('rejects city country tags outside the generated country list', async () => {
    const { resolver } = await setup();
    await expect(
      prepareReferenceWorld(resolver, 'reference', {
        id: 'world',
        kind: 'create_world',
        countries: [{ tag: 'AAA', name: 'Aster' }],
        reference: {
          imagePath: 'references/world.png',
          cities: [{ name: 'Port', x: 0.5, y: 0.5, countryTag: 'BBB' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_CITY_COUNTRY_INVALID' });
  });

  it('rejects crop coordinates outside the original image before resampling', async () => {
    const { resolver } = await setup();
    await expect(
      prepareReferenceWorld(resolver, 'reference', {
        id: 'world',
        kind: 'create_world',
        reference: {
          imagePath: 'references/world.png',
          crop: { x: 30, y: 0, width: 4, height: 64 },
        },
      }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_CROP_BLOCKED' });
  });

  it('uses reviewed country names and prevents reviewed state labels from becoming cities', async () => {
    const { resolver } = await setup();
    const loaded = await prepareReferenceWorld(resolver, 'reference', {
      id: 'world',
      kind: 'create_world',
      reference: {
        imagePath: 'references/world.png',
        labels: [
          { name: 'Reviewed Country', kind: 'country', x: 0.25, y: 0.5 },
          { name: 'Reviewed State', kind: 'state', x: 0.75, y: 0.5 },
        ],
      },
    });
    expect(loaded.prepared.countries[0]!.name).toBe('Reviewed Country');
    expect(loaded.prepared.cities).toEqual([]);
    expect(loaded.prepared.labels).toContainEqual({
      name: 'Reviewed State',
      kind: 'state',
      x: 160,
      y: 128,
    });
  });
});

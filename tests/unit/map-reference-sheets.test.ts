import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/resolve.js';
import { buildImportReport } from '../../src/hoi4_agent_tools/map/reference-import.js';
import { prepareReferenceWorld } from '../../src/hoi4_agent_tools/map/reference-preparation.js';
import {
  applyAffine,
  invertAffine,
  registerSheets,
  sheetAffine,
  sheetWorkingSize,
  warpSheets,
} from '../../src/hoi4_agent_tools/map/reference-sheets.js';
import {
  REFERENCE_TERRAIN,
  type ReferencePaletteEntry,
} from '../../src/hoi4_agent_tools/map/reference-world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import {
  referenceSheetsDocumentSchema,
  type ReferenceSheetsDocument,
} from '../../src/hoi4_agent_tools/schemas/reference-sheets.js';

type Color = readonly [number, number, number];
const SEA: Color = [20, 60, 200];
const PLAINS: Color = [130, 205, 60];
const FOREST: Color = [20, 120, 40];
const DESERT: Color = [235, 205, 40];
const palette: ReferencePaletteEntry[] = [
  { kind: 'sea', color: { r: 20, g: 60, b: 200 } },
  { kind: 'plains', color: { r: 130, g: 205, b: 60 } },
  { kind: 'forest', color: { r: 20, g: 120, b: 40 } },
  { kind: 'desert', color: { r: 235, g: 205, b: 40 } },
];

/**
 * A synthetic three-sheet drawing, 600 x 400: sheet A (left third) holds an island of plains
 * whose west half is forest; sheet B (middle third) a desert island; sheet C (right third) an
 * island of plains with a forest east end. Each island fills the middle of its sheet.
 */
function drawing(x: number, y: number): Color {
  const sheet = Math.floor(x / 200);
  const u = (x % 200) / 200;
  const v = y / 400;
  if (u < 0.2 || u >= 0.8 || v < 0.25 || v >= 0.75) return SEA;
  if (sheet === 0) return u < 0.5 ? FOREST : PLAINS;
  if (sheet === 1) return DESERT;
  return u >= 0.6 ? FOREST : PLAINS;
}

async function png(width: number, height: number, color: (x: number, y: number) => Color) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) data.set(color(x, y), (y * width + x) * 3);
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * The world is 512 x 256. A goes to the west at half size, B stays in the middle, C is mirrored
 * into the east. One third of the drawing is 1/3 wide; at scale 0.5 it is 1/6 of the world.
 */
function document(overrides: Partial<ReferenceSheetsDocument> = {}): ReferenceSheetsDocument {
  return referenceSheetsDocumentSchema.parse({
    version: 1,
    source: { width: 600, height: 400 },
    sheets: [
      { id: 'A', box: [0, 0, 1 / 3, 1], anchor: [0, 0], target: [0.05, 0.25], scale: [0.5, 0.5] },
      { id: 'B', box: [1 / 3, 0, 2 / 3, 1], anchor: [1 / 3, 0], target: [0.4, 0], scale: [0.6, 1] },
      {
        id: 'C',
        box: [2 / 3, 0, 1, 1],
        anchor: [2 / 3, 0],
        target: [0.95, 0.25],
        scale: [-0.5, 0.5],
      },
    ],
    ...overrides,
  });
}

describe('sheet registration', () => {
  it('turns anchor, target and scale into an affine map and inverts it exactly', () => {
    const forward = sheetAffine(document().sheets[2]!);
    const inverse = invertAffine(forward)!;
    for (const [x, y] of [
      [2 / 3, 0],
      [0.9, 0.4],
      [1, 1],
    ] as const) {
      const [wx, wy] = applyAffine(forward, x, y);
      const [px, py] = applyAffine(inverse, wx, wy);
      expect(px).toBeCloseTo(x, 12);
      expect(py).toBeCloseTo(y, 12);
    }
    expect(applyAffine(forward, 2 / 3, 0)).toEqual([0.95, 0.25]);
    expect(applyAffine(forward, 1, 0)[0]).toBeCloseTo(0.95 - 0.5 / 3, 12);
    expect(invertAffine([1, 2, 0, 2, 4, 0])).toBeUndefined();
  });

  it('chooses the working size each sheet needs for one picture pixel per world pixel', () => {
    const size = sheetWorkingSize(
      document().sheets.map((sheet) => sheetAffine(sheet)),
      { width: 512, height: 256 },
    );
    expect(size).toEqual({ width: Math.ceil(0.6 * 512), height: 256 });
  });

  it('warps the sheets into the frame, mirrored where the scale is negative', async () => {
    const frame = { width: 512, height: 256 };
    const sheets = registerSheets(document(), frame, { width: 600, height: 400, sha256: 'x' });
    const { data } = await sharp(await png(600, 400, drawing))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const warped = warpSheets({ data, width: 600, height: 400 }, sheets, frame, {
      fill: 'sea',
      sampling: 'nearest',
    });
    const colourAt = (x: number, y: number) => [
      ...warped.rgb.subarray((y * 512 + x) * 3, (y * 512 + x) * 3 + 3),
    ];
    // Sheet A: world x from 0.05 to 0.05 + 1/6; its forest half lies west.
    expect(colourAt(Math.round(512 * (0.05 + 0.4 / 6)), 128)).toEqual([...FOREST]);
    expect(colourAt(Math.round(512 * (0.05 + 0.65 / 6)), 128)).toEqual([...PLAINS]);
    // Sheet C mirrored: its forest east end now lies west of its plains.
    const cLeft = 0.95 - 0.5 / 3;
    expect(colourAt(Math.round(512 * (cLeft + 0.3 / 6)), 128)).toEqual([...FOREST]);
    expect(colourAt(Math.round(512 * (cLeft + 0.6 / 6)), 128)).toEqual([...PLAINS]);
    expect(warped.coverage.map(({ id, pixels }) => [id, pixels > 0])).toEqual([
      ['A', true],
      ['B', true],
      ['C', true],
    ]);
    expect(warped.owner[5 * 512 + 2]).toBe(255);
    expect(warped.uncovered).toBeGreaterThan(0);
  });

  it('lets a clip keep a neighbour out and a higher order win an overlap', async () => {
    const frame = { width: 512, height: 256 };
    const overlapping = document({
      sheets: [
        { id: 'A', box: [0, 0, 0.5, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1], order: 0 },
        {
          id: 'B',
          box: [1 / 3, 0, 2 / 3, 1],
          anchor: [1 / 3, 0],
          target: [1 / 3, 0],
          scale: [1, 1],
          order: 1,
          clip: [
            [0.4, 0],
            [2 / 3, 0],
            [2 / 3, 1],
            [0.4, 1],
          ],
        },
      ],
    });
    const sheets = registerSheets(overlapping, frame, { width: 600, height: 400, sha256: 'x' });
    const { data } = await sharp(await png(600, 400, drawing))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const warped = warpSheets({ data, width: 600, height: 400 }, sheets, frame, {
      fill: 'sea',
      sampling: 'nearest',
    });
    // Between x 1/3 and 0.4 only A reaches (B's clip excludes it); from 0.4 to 0.5 B wins.
    expect(warped.owner[128 * 512 + Math.round(0.36 * 512)]).toBe(0);
    expect(warped.owner[128 * 512 + Math.round(0.45 * 512)]).toBe(1);
    expect(warped.coverage[0]!.hidden).toBeGreaterThan(0);
  });

  it('refuses ties, uncovered pixels under fill error, outside sheets, degenerate maps and another picture', async () => {
    const frame = { width: 128, height: 64 };
    const picture = { data: Buffer.alloc(60 * 40 * 3), width: 60, height: 40 };
    const tie = document({
      sheets: [
        { id: 'A', box: [0, 0, 0.6, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1], order: 0 },
        { id: 'B', box: [0.4, 0, 1, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1], order: 0 },
      ],
    });
    expect(() =>
      warpSheets(
        picture,
        registerSheets(tie, frame, { width: 600, height: 400, sha256: 'x' }),
        frame,
        {
          fill: 'sea',
          sampling: 'nearest',
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'MAP_REFERENCE_SHEETS_OVERLAP_ORDER' }));
    expect(() =>
      warpSheets(
        picture,
        registerSheets(document({ fill: 'error' }), frame, {
          width: 600,
          height: 400,
          sha256: 'x',
        }),
        frame,
        { fill: 'error', sampling: 'nearest' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'MAP_REFERENCE_SHEETS_UNCOVERED' }));
    const outside = document({
      sheets: [
        { id: 'A', box: [0, 0, 1, 1], anchor: [0, 0], target: [1.5, 0], scale: [1, 1], order: 0 },
      ],
    });
    expect(() =>
      registerSheets(outside, frame, { width: 600, height: 400, sha256: 'x' }),
    ).toThrowError(expect.objectContaining({ code: 'MAP_REFERENCE_SHEET_OUTSIDE' }));
    const flat = document({
      sheets: [{ id: 'A', box: [0, 0, 1, 1], affine: [1, 2, 0, 2, 4, 0], order: 0 }],
    });
    expect(() =>
      registerSheets(flat, frame, { width: 600, height: 400, sha256: 'x' }),
    ).toThrowError(expect.objectContaining({ code: 'MAP_REFERENCE_SHEET_DEGENERATE' }));
    expect(() =>
      registerSheets(document(), frame, { width: 601, height: 400, sha256: 'x' }),
    ).toThrowError(expect.objectContaining({ code: 'MAP_REFERENCE_SHEETS_SOURCE_MISMATCH' }));
    const hashed = document({ source: { width: 600, height: 400, sha256: 'a'.repeat(64) } });
    expect(() =>
      registerSheets(hashed, frame, { width: 600, height: 400, sha256: 'b'.repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: 'MAP_REFERENCE_SHEETS_SOURCE_MISMATCH' }));
  });

  it('rejects malformed sheet documents in the schema', () => {
    const base = {
      version: 1,
      sheets: [{ id: 'A', box: [0, 0, 1, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1] }],
    };
    expect(referenceSheetsDocumentSchema.safeParse(base).success).toBe(true);
    for (const sheet of [
      { id: 'A', box: [0.5, 0, 0.4, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1] },
      { id: 'A', box: [0, 0, 1, 1], anchor: [0, 0], target: [0, 0], scale: [0, 1] },
      { id: 'A', box: [0, 0, 1, 1], anchor: [0, 0], scale: [1, 1] },
      {
        id: 'A',
        box: [0, 0, 1, 1],
        anchor: [0, 0],
        target: [0, 0],
        scale: [1, 1],
        affine: [1, 0, 0, 0, 1, 0],
      },
      { id: 'A', box: [0, 0, 1.2, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1] },
      { id: '1A', box: [0, 0, 1, 1], anchor: [0, 0], target: [0, 0], scale: [1, 1] },
    ])
      expect(referenceSheetsDocumentSchema.safeParse({ ...base, sheets: [sheet] }).success).toBe(
        false,
      );
    expect(
      referenceSheetsDocumentSchema.safeParse({ ...base, sheets: [base.sheets[0], base.sheets[0]] })
        .success,
    ).toBe(false);
  });
});

async function workspace(files: Record<string, Buffer | string>) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-sheets-'));
  const mod = path.join(base, 'mod');
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(mod, relative)), { recursive: true });
    await writeFile(path.join(mod, relative), content);
  }
  await writeFile(path.join(base, 'outside.json'), JSON.stringify(document()));
  return WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'reference', name: 'Reference', root: mod }],
    }),
  );
}

function operation(reference: Record<string, unknown>) {
  return mapOperationSchema.parse({
    id: 'world',
    kind: 'create_world',
    width: 512,
    height: 256,
    reference: { imagePath: 'reference/drawing.png', palette, paletteMatch: 'exact', ...reference },
  }) as never;
}

describe('registered sheet references', () => {
  it('imports a three-sheet drawing from a sheet file into one frame-aligned surface', async () => {
    const resolver = await workspace({
      'reference/drawing.png': await png(600, 400, drawing),
      'reference/sheets.json': JSON.stringify(document()),
    });
    const loaded = await prepareReferenceWorld(
      resolver,
      'reference',
      operation({ sheetsPath: 'reference/sheets.json' }),
    );
    const { surface } = loaded.prepared;
    expect([surface.width, surface.height]).toEqual([512, 256]);
    const at = (x: number, y: number) => Math.round(y * 256) * 512 + Math.round(x * 512);
    expect(surface.kind[at(0.01, 0.5)]).toBe(0);
    expect(surface.terrain[at(0.05 + 0.4 / 6, 0.5)]).toBe(REFERENCE_TERRAIN.forest);
    expect(surface.terrain[at(0.4 + 0.5 * 0.2, 0.5)]).toBe(REFERENCE_TERRAIN.desert);
    expect(surface.terrain[at(0.95 - 0.5 / 3 + 0.3 / 6, 0.5)]).toBe(REFERENCE_TERRAIN.forest);
    expect(loaded.documents.map(({ displayPath }) => displayPath)).toEqual([
      'mod:reference/sheets.json',
    ]);
    expect(loaded.registration?.coverage.map(({ id }) => id)).toEqual(['A', 'B', 'C']);
    expect(loaded.previewBytes).toBeDefined();
    // A rerun gives the same surface.
    const again = await prepareReferenceWorld(
      resolver,
      'reference',
      operation({ sheetsPath: 'reference/sheets.json' }),
    );
    expect(Buffer.from(again.prepared.surface.kind)).toEqual(Buffer.from(surface.kind));
    expect(Buffer.from(again.prepared.surface.terrain)).toEqual(Buffer.from(surface.terrain));
  });

  it('refuses bad sheet files, traversal and unsupported combinations with precise codes', async () => {
    const resolver = await workspace({
      'reference/drawing.png': await png(600, 400, drawing),
      'reference/broken.json': '{ not json',
      'reference/wrong.json': JSON.stringify({ version: 2, sheets: [] }),
    });
    await expect(
      prepareReferenceWorld(
        resolver,
        'reference',
        operation({ sheetsPath: 'reference/broken.json' }),
      ),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_SHEETS_JSON_INVALID' });
    await expect(
      prepareReferenceWorld(
        resolver,
        'reference',
        operation({ sheetsPath: 'reference/wrong.json' }),
      ),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_SHEETS_INVALID' });
    await expect(
      prepareReferenceWorld(
        resolver,
        'reference',
        operation({ sheetsPath: 'reference/missing.json' }),
      ),
    ).rejects.toBeDefined();
    expect(() => operation({ sheetsPath: '../outside.json' })).toThrow();
    await expect(
      prepareReferenceWorld(
        resolver,
        'reference',
        operation({ sheets: document(), crop: { x: 0, y: 0, width: 300, height: 400 } }),
      ),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_SHEETS_UNSUPPORTED' });
    expect(() => operation({ sheets: document(), sheetsPath: 'reference/sheets.json' })).toThrow();
    expect(() => operation({ sheets: document(), fit: 'contain' })).toThrow();
  });
});

describe('import agreement', () => {
  it('measures land agreement, blocks below the threshold and names features on the wrong surface', async () => {
    const resolver = await workspace({
      'reference/drawing.png': await png(600, 400, drawing),
    });
    const loaded = await prepareReferenceWorld(
      resolver,
      'reference',
      operation({ sheets: document() }),
    );
    // The model draws only island B's land, so A and C are land only in the drawing.
    const geography = resolveGeography(
      {
        version: 1,
        lands: [
          {
            id: 'b_island',
            polygons: [
              [
                [0.4 + 0.6 * (0.2 / 3), 0.25],
                [0.4 + 0.6 * (0.8 / 3), 0.25],
                [0.4 + 0.6 * (0.8 / 3), 0.75],
                [0.4 + 0.6 * (0.2 / 3), 0.75],
              ],
            ],
          },
        ],
        sites: [{ id: 'drowned', kind: 'city', at: [0.3, 0.1] }],
      },
      { frame: { width: 512, height: 256 }, hasReference: true },
    ).geography;
    const built = buildImportReport({
      operationId: 'world',
      surface: loaded.prepared.surface,
      seed: 1,
      registration: loaded.registration!,
      geography,
    });
    const agreement = built.report.agreement!;
    // B's island covers 0.06 of the world; A's and C's 0.025 each: 0.06 / 0.11.
    expect(agreement.landIou).toBeGreaterThan(0.52);
    expect(agreement.landIou).toBeLessThan(0.57);
    expect(agreement.drawingOnlyLandPx).toBeGreaterThan(agreement.modelOnlyLandPx);
    expect(agreement.features).toEqual([expect.objectContaining({ id: 'drowned', kind: 'site' })]);
    expect(built.diagnostics.map(({ code, severity }) => [code, severity])).toEqual([
      ['MAP_IMPORT_SOURCES_DISAGREE', 'error'],
      ['MAP_IMPORT_FEATURE_SURFACE', 'warning'],
    ]);
    const lenient = buildImportReport({
      operationId: 'world',
      surface: loaded.prepared.surface,
      seed: 1,
      geography,
      thresholds: { minLandIou: 0.1, warnLandIou: 0.2 },
    });
    expect(lenient.diagnostics[0]).toMatchObject({
      code: 'MAP_IMPORT_SOURCES_AGREEMENT',
      severity: 'info',
    });
    expect(built.report.classes.landPx).toBeGreaterThan(0);
    expect(built.report.registration?.sheets).toHaveLength(3);
  });
});

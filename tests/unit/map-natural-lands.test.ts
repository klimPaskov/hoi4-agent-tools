import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  BORDER_PROVINCE_KIND,
  borderPlaneFromBytes,
} from '../../src/hoi4_agent_tools/map/border-quality.js';
import {
  computeNaturalLands,
  naturalLandProvinces,
  resolveNaturalLandsOptions,
  summarizeNaturalLands,
  type NaturalLandsInput,
  type NaturalLandsOptions,
  type NaturalLandsResult,
} from '../../src/hoi4_agent_tools/map/natural-lands.js';

/**
 * Synthetic grid maps: every cell of `cell` by `cell` pixels is one province, numbered row by row
 * from 1. Columns listed in `seaColumns` are one sea province per column, numbered after the land.
 */
interface GridOptions {
  columns: number;
  rows: number;
  cell?: number;
  seaColumns?: number[];
  terrain?: (column: number, row: number) => string;
  /** Height of a pixel; without it the map has no heightmap. */
  height?: (x: number, y: number, column: number, row: number) => number;
  /** River index of a pixel (255 is no river); without it the map has no rivers bitmap. */
  river?: (x: number, y: number) => number;
}

interface Grid {
  input: NaturalLandsInput;
  provinceAt: (column: number, row: number) => number;
}

function grid(options: GridOptions): Grid {
  const cell = options.cell ?? 10;
  const width = options.columns * cell;
  const height = options.rows * cell;
  const sea = new Set(options.seaColumns ?? []);
  const ids = new Map<string, number>();
  let next = 1;
  for (let row = 0; row < options.rows; row += 1)
    for (let column = 0; column < options.columns; column += 1)
      if (!sea.has(column)) ids.set(`${column}:${row}`, next++);
  for (const column of [...sea].sort((a, b) => a - b)) {
    for (let row = 0; row < options.rows; row += 1) ids.set(`${column}:${row}`, next);
    next += 1;
  }
  const count = next;
  const provinceAt = (column: number, row: number): number => ids.get(`${column}:${row}`)!;
  const provinceIds = new Int32Array(width * height);
  const kinds = new Uint8Array(count);
  const terrain: string[] = new Array<string>(count).fill('');
  const heights = new Uint8Array(width * height);
  const rivers = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const column = Math.floor(x / cell);
      const row = Math.floor(y / cell);
      const id = provinceAt(column, row);
      provinceIds[y * width + x] = id;
      kinds[id] = sea.has(column) ? BORDER_PROVINCE_KIND.sea : BORDER_PROVINCE_KIND.land;
      terrain[id] = sea.has(column) ? 'ocean' : (options.terrain?.(column, row) ?? 'plains');
      if (options.height !== undefined) heights[y * width + x] = options.height(x, y, column, row);
      if (options.river !== undefined) rivers[y * width + x] = options.river(x, y);
    }
  return {
    provinceAt,
    input: {
      width,
      height,
      provinceIds,
      provinceKinds: kinds,
      provinceTerrain: terrain,
      ...(options.height === undefined
        ? {}
        : { heights: borderPlaneFromBytes(width, height, heights) }),
      ...(options.river === undefined
        ? {}
        : { rivers: borderPlaneFromBytes(width, height, rivers) }),
    },
  };
}

function landOf(result: NaturalLandsResult, province: number) {
  return result.lands.find(({ provinces }) => provinces.includes(province))!;
}

const lands = (input: NaturalLandsInput, options?: NaturalLandsOptions) =>
  computeNaturalLands(input, options);

describe('natural lands', () => {
  it('splits two lands along a major river and not along a minor one', async () => {
    // A river on the last pixel column of column 2: every border between columns 2 and 3 touches
    // it. Sea columns at both ends keep the two sides from meeting across the wrapping seam.
    const make = (index: number) =>
      grid({ columns: 6, rows: 6, seaColumns: [0, 5], river: (x) => (x === 29 ? index : 255) });
    const { input, provinceAt } = make(8);
    const result = await lands(input);
    expect(result.lands.map(({ id, kind, provinces }) => [id, kind, provinces.length])).toEqual([
      ['L1', 'plains', 12],
      ['L3', 'plains', 12],
    ]);
    expect(landOf(result, provinceAt(2, 3)).id).toBe('L1');
    expect(landOf(result, provinceAt(3, 3)).id).toBe('L3');
    expect(result.lands[0]!.lines).toEqual([
      { land: 'L3', length: 60, river: 60, crest: 0, terrain: 0, impassable: 0, divide: 0 },
    ]);
    expect(result.inputs).toEqual({ heights: false, rivers: true });

    const minor = await lands(make(3).input);
    expect(minor.lands).toHaveLength(1);
    // A lower major index makes the same river major.
    expect((await lands(make(3).input, { riverMajorIndex: 3 })).lands).toHaveLength(2);
    // Index 12 and up are not river widths.
    expect((await lands(make(12).input)).lands).toHaveLength(1);
  });

  it('needs the river on the given share of a border', async () => {
    // The river runs along half of the shared border only.
    const { input } = grid({
      columns: 4,
      rows: 6,
      seaColumns: [0, 3],
      river: (x, y) => (x === 19 && y % 10 < 5 ? 8 : 255),
    });
    expect((await lands(input)).lands).toHaveLength(2);
    expect((await lands(input, { riverShare: 0.6 })).lands).toHaveLength(1);
  });

  it('splits two lands along a crest, and keeps a range whole unless asked', async () => {
    const ridge = (x: number) => (x === 29 || x === 30 ? 200 : 100);
    const { input } = grid({ columns: 6, rows: 6, seaColumns: [0, 5], height: ridge });
    const result = await lands(input, { minBasinProvinces: 100 });
    expect(result.lands.map(({ id, kind, provinces }) => [id, kind, provinces.length])).toEqual([
      ['L1', 'basin', 12],
      ['L3', 'basin', 12],
    ]);
    expect(result.lands[0]!.lines[0]).toMatchObject({ land: 'L3', crest: 60, river: 0 });
    // Below the threshold the ridge is no line.
    expect((await lands(input, { minBasinProvinces: 100, crestExcess: 120 })).lands).toHaveLength(
      1,
    );

    const mountains = grid({
      columns: 6,
      rows: 6,
      seaColumns: [0, 5],
      height: ridge,
      terrain: () => 'mountain',
    }).input;
    const range = await lands(mountains);
    expect(range.lands.map(({ kind, provinces }) => [kind, provinces.length])).toEqual([
      ['range', 24],
    ]);
    expect(range.lands[0]!.terrain).toEqual({ mountain: 1 });
    expect((await lands(mountains, { splitRangesAtCrests: true })).lands).toHaveLength(2);
  });

  it('makes a forest pocket its own land', async () => {
    const { input, provinceAt } = grid({
      columns: 6,
      rows: 6,
      terrain: (column, row) =>
        column >= 2 && column <= 4 && row >= 1 && row <= 3 ? 'forest' : 'plains',
    });
    const result = await lands(input);
    expect(result.counts).toMatchObject({ forest: 1, plains: 1 });
    const forest = landOf(result, provinceAt(3, 2));
    expect(forest).toMatchObject({ kind: 'forest', terrain: { forest: 1 } });
    expect(forest.provinces).toHaveLength(9);
    // Three cells of ten pixels on each of four sides.
    expect(forest.lines).toEqual([
      { land: 'L1', length: 120, river: 0, crest: 0, terrain: 120, impassable: 0, divide: 0 },
    ]);
    // A mod's own terrain category can be classed as forest too.
    const custom = grid({
      columns: 6,
      rows: 6,
      terrain: (column, row) =>
        column >= 2 && column <= 4 && row >= 1 && row <= 3 ? 'elder_wood' : 'plains',
    }).input;
    expect((await lands(custom)).lands).toHaveLength(1);
    const classed = await lands(custom, { terrainClasses: { elder_wood: 'forest' } });
    expect(classed.counts).toMatchObject({ forest: 1, plains: 1 });
    expect(classed.lands.find(({ kind }) => kind === 'forest')!.terrain).toEqual({
      elder_wood: 1,
    });
  });

  it('merges a small fragment into the neighbour across its weakest line', async () => {
    // Two plains split by a major river, and a two-province forest on the river's east bank: its
    // line to the west is river and terrain, to the east terrain only, so it joins the east.
    const { input, provinceAt } = grid({
      columns: 6,
      rows: 6,
      seaColumns: [0, 5],
      river: (x) => (x === 29 ? 8 : 255),
      terrain: (column, row) => (column === 3 && (row === 2 || row === 3) ? 'forest' : 'plains'),
    });
    const result = await lands(input);
    expect(result.lands).toHaveLength(2);
    const east = landOf(result, provinceAt(4, 0));
    expect(east.provinces).toEqual(expect.arrayContaining([provinceAt(3, 2), provinceAt(3, 3)]));
    expect(east.provinces).toHaveLength(12);
    expect(east.kind).toBe('plains');
    expect(east.terrain).toEqual({ forest: 0.1667, plains: 0.8333 });
    // A minimum of two keeps the pocket.
    expect((await lands(input, { minProvinces: 2 })).lands).toHaveLength(3);
    // An island below the minimum has no neighbour to join and is reported.
    const island = grid({ columns: 4, rows: 2, seaColumns: [1, 3] });
    const alone = await lands(island.input);
    expect(alone.lands.map(({ provinces }) => provinces.length)).toEqual([2, 2]);
    expect(alone.undersized).toEqual(['L1', 'L2']);
    expect(alone.lands.every(({ coast }) => coast)).toBe(true);
  });

  it('cuts a plain with no lines into drainage basins', async () => {
    // Sea on both sides, land rising to a divide between columns 4 and 5.
    const columnHeight = (column: number) => 100 + 10 * Math.min(column - 1, 8 - column);
    const { input, provinceAt } = grid({
      columns: 10,
      rows: 6,
      seaColumns: [0, 9],
      height: (_x, _y, column) => (column === 0 || column === 9 ? 0 : columnHeight(column)),
    });
    const result = await lands(input);
    expect(
      result.lands.map(({ kind, provinces, coast }) => [kind, provinces.length, coast]),
    ).toEqual([
      ['basin', 24, true],
      ['basin', 24, true],
    ]);
    const west = landOf(result, provinceAt(4, 0));
    expect(west.provinces).toEqual(
      [1, 2, 3, 4]
        .flatMap((column) => [0, 1, 2, 3, 4, 5].map((row) => provinceAt(column, row)))
        .sort((a, b) => a - b),
    );
    expect(west.lines).toEqual([
      {
        land: landOf(result, provinceAt(5, 0)).id,
        length: 60,
        river: 0,
        crest: 0,
        terrain: 0,
        impassable: 0,
        divide: 60,
      },
    ]);
    expect(west.meanHeight).toBe(115);
    // Without a heightmap the same plain has nothing to cut it.
    const flat = grid({ columns: 10, rows: 6, seaColumns: [0, 9] });
    expect((await lands(flat.input)).lands.map(({ kind }) => kind)).toEqual(['plains']);
  });

  it('splits a big basin at branch points of its drainage tree', async () => {
    // A valley down column 3 to its lowest cell at the bottom; the sides drain into it.
    const { input, provinceAt } = grid({
      columns: 7,
      rows: 6,
      height: (_x, _y, column, row) => 100 + 10 * Math.abs(column - 3) + 2 * (5 - row),
    });
    expect((await lands(input)).lands).toHaveLength(1);
    const split = await lands(input, { maxBasinProvinces: 21 });
    expect(split.lands.map(({ provinces }) => provinces.length)).toEqual([21, 21]);
    expect(landOf(split, provinceAt(0, 0)).provinces).toContain(provinceAt(6, 2));
    expect(landOf(split, provinceAt(0, 5)).provinces).toContain(provinceAt(3, 3));
    expect((await lands(input, { maxBasinProvinces: 12 })).lands).toHaveLength(6);
  });

  it('is deterministic and names each land after its smallest province', async () => {
    const make = () =>
      grid({
        columns: 8,
        rows: 8,
        seaColumns: [0],
        height: (x, y) => (x < 10 ? 0 : 90 + ((x * 7 + y * 13) % 23)),
        river: (x) => (x === 49 ? 7 : 255),
        terrain: (column, row) => (column >= 5 && row >= 5 ? 'forest' : 'plains'),
      }).input;
    const first = await lands(make());
    const second = await lands(make());
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    for (const land of first.lands) expect(land.id).toBe(`L${land.provinces[0]!}`);
    const ids = first.lands.map(({ provinces }) => provinces[0]!);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // Every land province is in exactly one land.
    const all = first.lands.flatMap(({ provinces }) => provinces);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(first.landProvinces);
    // Lines are symmetric.
    for (const land of first.lands)
      for (const line of land.lines) {
        const other = first.lands.find(({ id }) => id === line.land)!;
        expect(other.lines.find(({ land: back }) => back === land.id)).toMatchObject({
          length: line.length,
          river: line.river,
        });
      }
  });

  it('never puts the two sides of an impassable border in one land', async () => {
    // Two columns of three small plain provinces, sea either side: below the minimum they would
    // all merge into one land.
    const { input, provinceAt } = grid({ columns: 4, rows: 3, seaColumns: [0, 3] });
    expect((await lands(input)).lands).toHaveLength(1);
    const left = [0, 1, 2].map((row) => provinceAt(1, row));
    const right = [0, 1, 2].map((row) => provinceAt(2, row));

    // One impassable row: the land around its end is split between its two sides.
    const one = await lands({ ...input, impassablePairs: [[provinceAt(2, 0), provinceAt(1, 0)]] });
    expect(one.lands.map(({ provinces }) => provinces)).toEqual([left, right]);
    expect(one.lands[0]!.lines).toEqual([
      { land: 'L2', length: 30, river: 0, crest: 0, terrain: 0, impassable: 10, divide: 20 },
    ]);
    // Undersized, but they never merge across it.
    expect(one.undersized).toEqual(['L1', 'L2']);

    // A wall of impassable rows along the whole border.
    const wall = await lands({
      ...input,
      impassablePairs: [0, 1, 2].map((row) => [provinceAt(1, row), provinceAt(2, row)] as const),
    });
    expect(wall.lands.map(({ provinces }) => provinces)).toEqual([left, right]);
    expect(wall.lands[1]!.lines).toEqual([
      { land: 'L1', length: 30, river: 0, crest: 0, terrain: 0, impassable: 30, divide: 0 },
    ]);

    // Impassable land keeps to itself, but a border inside it is not a line.
    const three = grid({ columns: 5, rows: 2, seaColumns: [0, 4] });
    const middle = [0, 1].map((row) => three.provinceAt(2, row));
    const impassable = await lands({ ...three.input, impassableProvinces: middle });
    expect(impassable.lands.map(({ provinces }) => provinces.length)).toEqual([2, 2, 2]);
    expect(landOf(impassable, middle[0]!).provinces).toEqual(middle);

    // A wall drawn in the barrier plane (255) on the border between columns 1 and 2.
    const walls = new Uint8Array(input.width * input.height);
    for (let y = 0; y < input.height; y += 1) walls[y * input.width + 19] = 255;
    const drawn = await lands({
      ...input,
      walls: borderPlaneFromBytes(input.width, input.height, walls),
    });
    expect(drawn.lands.map(({ provinces }) => provinces)).toEqual([left, right]);
    expect(drawn.lands[0]!.lines[0]!.impassable).toBe(30);
    // A lower barrier value is no wall.
    walls.fill(150);
    expect(
      (await lands({ ...input, walls: borderPlaneFromBytes(input.width, input.height, walls) }))
        .lands,
    ).toHaveLength(1);
  });

  it('resolves land ids to provinces and summarises compactly', async () => {
    const { input } = grid({
      columns: 6,
      rows: 6,
      seaColumns: [0, 5],
      river: (x) => (x === 29 ? 8 : 255),
    });
    const result = await lands(input);
    expect(naturalLandProvinces(result, ['L3'])).toEqual([
      3, 4, 7, 8, 11, 12, 15, 16, 19, 20, 23, 24,
    ]);
    expect(() => naturalLandProvinces(result, ['L2'])).toThrow(
      expect.objectContaining({ code: 'MAP_NATURAL_LAND_UNKNOWN' }),
    );
    const summary = summarizeNaturalLands(result, []);
    expect(summary).toMatchObject({
      count: 2,
      landProvinces: 24,
      undersized: 0,
      truncated: false,
      lands: [
        { id: 'L1', kind: 'plains', provinces: 12, coast: true },
        { id: 'L3', kind: 'plains', provinces: 12, coast: true },
      ],
    });
  });

  it('refuses invalid options and inputs', async () => {
    for (const options of [
      { minProvinces: 0 },
      { minProvinces: 1.5 },
      { riverMajorIndex: 12 },
      { riverShare: 0 },
      { riverShare: 1.5 },
      { crestExcess: -1 },
      { crestExcess: Number.NaN },
      { maxBasinProvinces: 5 },
      { terrainClasses: { forest: 'woods' } },
    ] as NaturalLandsOptions[])
      expect(() => resolveNaturalLandsOptions(options), JSON.stringify(options)).toThrow(
        expect.objectContaining({ code: 'MAP_NATURAL_LANDS_OPTION_INVALID' }),
      );
    expect(resolveNaturalLandsOptions()).toEqual({
      minProvinces: 6,
      minBasinProvinces: 6,
      maxBasinProvinces: null,
      riverMajorIndex: 6,
      riverShare: 0.4,
      crestExcess: 3.5,
      splitRangesAtCrests: false,
      terrainClasses: {},
    });
    const { input } = grid({ columns: 2, rows: 2 });
    await expect(
      lands({ ...input, provinceIds: input.provinceIds.subarray(1) }),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      lands({ ...input, heights: borderPlaneFromBytes(2, 2, new Uint8Array(4)) }),
    ).rejects.toMatchObject({ code: 'MAP_NATURAL_LANDS_INPUT_INVALID' });
    const controller = new AbortController();
    controller.abort();
    await expect(lands(input, { signal: controller.signal })).rejects.toThrow();
  });
});

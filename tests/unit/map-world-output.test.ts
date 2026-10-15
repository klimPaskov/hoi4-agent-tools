import { describe, expect, it } from 'vitest';
import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';
import type { ReferenceWorldRaster } from '../../src/hoi4_agent_tools/map/reference-world.js';
import { generateWorld, type WorldSpec } from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

const context = {
  palettes: {},
  mapRoot: 'map',
  statesRoot: 'history/states',
  localisationRoot: 'localisation',
};
function spec(): WorldSpec {
  const width = 256,
    height = 256;
  const surface: ReferenceWorldRaster = {
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    referenceBounds: { x: 0, y: 0, width, height },
    kind: new Uint8Array(width * height),
    terrain: new Uint8Array(width * height),
    elevation: new Float32Array(width * height).fill(-0.1),
    moisture: new Float32Array(width * height).fill(0.5),
    country: new Uint16Array(width * height),
    rivers: [],
    diagnostics: [],
    inferredCountries: [
      { id: 1, name: 'Twin', color: { r: 170, g: 80, b: 60 } },
      { id: 2, name: 'Twin', color: { r: 70, g: 110, b: 170 } },
    ],
  };
  for (let y = 32; y < 224; y++)
    for (let x = 32; x < 224; x++) {
      const p = y * width + x;
      surface.kind[p] = 1;
      surface.terrain[p] = x < 128 ? 1 : 2;
      surface.elevation[p] = 0.1;
      surface.country[p] = x < 128 ? 1 : 2;
    }
  return {
    width,
    height,
    seed: 19,
    landCoverage: 0.4,
    continents: 1,
    landProvincePixels: 250,
    seaProvincePixels: 600,
    provincesPerState: 5,
    landProvincesPerRegion: 20,
    seaProvincesPerRegion: 10,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [
      { tag: 'AAA', name: 'Twin' },
      { tag: 'BBB', name: 'Twin' },
    ],
    referenceSurface: surface,
    referenceCities: [
      { name: 'Westhaven', x: 70, y: 100, countryTag: 'AAA' },
      { name: 'Eastwatch', x: 190, y: 150, countryTag: 'BBB' },
    ],
    referenceLabels: [
      { name: 'Western March', x: 70, y: 100, kind: 'state' },
      { name: 'Quiet Sea', x: 15, y: 15, kind: 'sea' },
    ],
  };
}

describe('world assets from interpreted geography', () => {
  it('writes basic recruitable starting armies, stockpiles and geography-scoped AI areas on request', () => {
    const world = generateWorld(
      { ...spec(), worldName: 'Example World', startingScenario: true },
      context,
    );
    const file = (name: string) =>
      world.files.find(({ relativePath }) => relativePath === name)!.content.toString('utf8');
    for (const tag of ['AAA', 'BBB']) {
      const history = world.files
        .find(({ relativePath }) => relativePath.startsWith(`history/countries/${tag} - `))!
        .content.toString('utf8');
      expect(history).toContain(`oob = "${tag}_world"`);
      expect(history).toContain(`name = "${tag}_WORLD_LEADER"`);
      expect(history).toContain('picture = "gfx/leaders/leader_unknown.dds" ideology = despotism');
      const units = file(`history/units/${tag}_world.txt`);
      expect(units.match(/division = \{/gu)).toHaveLength(2);
      expect(units.match(/infantry = \{/gu)).toHaveLength(6);
      expect(units).toContain('type = convoy amount = 100');
      expect(units).toContain('type = train_equipment_1 amount = 100');
      const capital = Number(/capital = (\d+)/u.exec(history)![1]);
      const state = world.files
        .find(({ relativePath }) => relativePath.startsWith(`history/states/${capital}-`))!
        .content.toString('utf8');
      const location = Number(/location = (\d+)/u.exec(units)![1]);
      expect(state).toContain(`owner = ${tag}`);
      expect(
        /provinces = \{([^}]+)\}/u.exec(state)![1]!.trim().split(/\s+/u).map(Number),
      ).toContain(location);
    }
    expect(file('common/on_actions/world.txt')).toContain('on_actions = { }');
    expect(file('common/ai_areas/world.txt')).toContain('strategic_regions');
    expect(file('common/countries/colors.txt')).toContain('AAA = { color = rgb');
    expect(file('common/countries/colors.txt')).toContain('color_ui = rgb');
    expect(file('localisation/replace/world_l_english.yml')).toContain(
      'WORLD_BOOKMARK_NAME: "Example World"',
    );
    const inherited = generateWorld(
      { ...spec(), startingScenario: true },
      { ...context, inheritedCountryTags: ['AAA', 'CCC'] },
    );
    const dormant = inherited.files.find(
      (f) => f.relativePath === 'history/countries/CCC - inactive world.txt',
    )!;
    expect(dormant.content.toString()).toMatch(/^#/u);
    expect(dormant.content.toString()).not.toContain('capital =');
    expect(
      inherited.files.some((f) => f.relativePath === 'history/countries/AAA - inactive world.txt'),
    ).toBe(false);
    expect(
      generateWorld(spec(), context).files.some(({ relativePath }) =>
        relativePath.startsWith('history/units/'),
      ),
    ).toBe(false);
  });

  it('densely numbers regions after absorbing small clusters and reports the written count', () => {
    const output = generateWorld(spec(), context);
    const ids = output.files
      .filter(({ relativePath }) => relativePath.startsWith('map/strategicregions/'))
      .map(({ content }) => Number(/\bid\s*=\s*(\d+)/u.exec(content.toString('utf8'))![1]))
      .sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    expect(output.summary.landRegions + output.summary.seaRegions).toBe(ids.length);
  });

  it('rejects grammar-breaking controls in external names while allowing Unicode and quotes', () => {
    for (const name of ['Bad\nname', 'Bad\rname', 'Bad\u0000name']) {
      expect(
        mapOperationSchema.safeParse({ kind: 'create_world', countries: [{ tag: 'AAA', name }] })
          .success,
      ).toBe(false);
      expect(
        mapOperationSchema.safeParse({
          kind: 'create_world',
          reference: { imagePath: 'world.png', labels: [{ name, x: 0.5, y: 0.5, kind: 'state' }] },
        }).success,
      ).toBe(false);
    }
    expect(
      mapOperationSchema.safeParse({
        kind: 'create_world',
        countries: [{ tag: 'AAA', name: 'Étoile "Coast"' }],
      }).success,
    ).toBe(true);
  });
  it('keeps political ownership, uniquely names country files and aligns cities to land', () => {
    const input = spec();
    const result = generateWorld(input, context);
    const files = new Map(result.files.map((file) => [file.relativePath, file.content]));
    expect(files.has('common/countries/AAA - Twin.txt')).toBe(true);
    expect(files.has('common/countries/BBB - Twin.txt')).toBe(true);
    expect(files.size).toBe(result.files.length);
    const provinces = BmpImage.decode(files.get('map/provinces.bmp')!);
    const cities = BmpImage.decode(files.get('map/cities.bmp')!);
    const definition = files.get('map/definition.csv')!.toString();
    const colorIds = new Map(
      definition
        .trim()
        .split(/\r?\n/u)
        .map((line) => {
          const row = line.split(';');
          return [`${row[1]},${row[2]},${row[3]}`, Number(row[0])] as const;
        }),
    );
    const owner = new Map<number, string>();
    const provinceLatitude = new Map<number, { y: number; count: number }>();
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const c = provinces.rgbAt(x, y);
        const id = colorIds.get(`${c.r},${c.g},${c.b}`)!;
        const sum = provinceLatitude.get(id) ?? { y: 0, count: 0 };
        sum.y += y;
        sum.count++;
        provinceLatitude.set(id, sum);
      }
    for (const file of result.files.filter(({ relativePath }) =>
      relativePath.startsWith('history/states/'),
    )) {
      const text = file.content.toString();
      const tag = /owner = (\w+)/u.exec(text)![1]!;
      for (const id of /provinces = \{ ([\d ]+) \}/u.exec(text)![1]!.trim().split(/\s+/u))
        owner.set(Number(id), tag);
    }
    for (const [x, tag] of [
      [70, 'AAA'],
      [190, 'BBB'],
    ] as const) {
      const c = provinces.rgbAt(x, 100);
      expect(owner.get(colorIds.get(`${c.r},${c.g},${c.b}`)!)).toBe(tag);
    }
    let developed = 0;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        if (cities.paletteIndexAt(x, y) !== 15) continue;
        developed++;
        expect(input.referenceSurface!.kind[y * 256 + x]).toBe(1);
      }
    expect(developed).toBeGreaterThan(10);
    expect(developed).toBeLessThan((256 * 256) / 8);
    const loc = files.get('localisation/replace/world_l_english.yml')!.toString();
    for (const city of input.referenceCities!) {
      const pixel = provinces.rgbAt(city.x, city.y);
      const id = colorIds.get(`${pixel.r},${pixel.g},${pixel.b}`)!;
      expect(loc).toContain(`VICTORY_POINTS_${id}: "${city.name}"`);
    }
    for (const name of ['Westhaven', 'Eastwatch', 'Western March', 'Quiet Sea'])
      expect(loc).toContain(name);
    expect(result.files.some(({ relativePath }) => relativePath.includes('Western March'))).toBe(
      true,
    );
    expect(result.files.some(({ relativePath }) => relativePath.includes('Quiet Sea'))).toBe(true);
    let northern = 0,
      southern = 0;
    for (const file of result.files.filter(({ relativePath }) =>
      relativePath.startsWith('map/strategicregions/'),
    )) {
      const text = file.content.toString();
      const members = /provinces=\{\s*([\d ]+)\s*\}/u
        .exec(text)![1]!
        .trim()
        .split(/\s+/u)
        .map(Number);
      const latitude =
        members.reduce(
          (sum, id) => sum + provinceLatitude.get(id)!.y / provinceLatitude.get(id)!.count,
          0,
        ) / members.length;
      const temperatures = [...text.matchAll(/temperature=\{ (-?[\d.]+) (-?[\d.]+) \}/gu)].map(
        (match) => Number(match[1]),
      );
      if (latitude < 90) {
        expect(temperatures[6]!).toBeGreaterThan(temperatures[0]!);
        northern++;
      }
      if (latitude > 165) {
        expect(temperatures[6]!).toBeLessThan(temperatures[0]!);
        southern++;
      }
    }
    expect(northern).toBeGreaterThan(0);
    expect(southern).toBeGreaterThan(0);
    expect(generateWorld(input, context)).toEqual(result);
  });

  it('refuses mismatched reference dimensions before allocating output files', () => {
    const input = spec();
    input.referenceSurface!.width = 512;
    expect(() => generateWorld(input, context)).toThrow(/Reference raster dimensions/u);
  });

  it('matches supplied countries to political colors independently of list order', () => {
    const input = spec();
    delete input.referenceCities;
    input.countries = [
      { tag: 'BBB', name: 'East', color: input.referenceSurface!.inferredCountries[1]!.color },
      { tag: 'AAA', name: 'West', color: input.referenceSurface!.inferredCountries[0]!.color },
    ];
    const result = generateWorld(input, context);
    const files = new Map(result.files.map((file) => [file.relativePath, file.content]));
    const bitmap = BmpImage.decode(files.get('map/provinces.bmp')!);
    for (const [x, expected] of [
      [70, 'AAA'],
      [190, 'BBB'],
    ] as const) {
      const color = bitmap.rgbAt(x, 100);
      const row = files
        .get('map/definition.csv')!
        .toString()
        .split(/\r?\n/u)
        .find(
          (line) => line.split(';').slice(1, 4).join(',') === `${color.r},${color.g},${color.b}`,
        )!;
      const id = Number(row.split(';')[0]);
      const state = result.files
        .filter(({ relativePath }) => relativePath.startsWith('history/states/'))
        .find(({ content }) =>
          /provinces = \{ ([\d ]+) \}/u
            .exec(content.toString())![1]!
            .trim()
            .split(/\s+/u)
            .map(Number)
            .includes(id),
        )!;
      expect(state.content.toString()).toContain(`owner = ${expected}`);
    }
    input.referenceCities = [{ name: 'Wrong coast', x: 70, y: 100, countryTag: 'BBB' }];
    expect(() => generateWorld(input, context)).toThrow(/different political regions/u);
  });
});

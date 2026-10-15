import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { buildWorldContext } from '../../src/hoi4_agent_tools/map/world-context.js';

function file(relativePath: string, content: string | Buffer, loadOrder = 0): ScannedFile {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    relativePath,
    absolutePath: `fixture:/${loadOrder}/${relativePath}`,
    displayPath: `fixture:${loadOrder}:${relativePath}`,
    rootKind: loadOrder === 0 ? 'game' : 'mod',
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function palette(offset = 0): RgbColor[] {
  return Array.from({ length: 256 }, (_, index) => ({
    r: index,
    g: (index + offset) % 256,
    b: 255 - index,
  }));
}

function bitmap(colors = palette()): Buffer {
  return createBmp({
    width: 2,
    height: 2,
    bitsPerPixel: 8,
    palette: colors,
    indexedPixels: new Uint8Array(4),
  });
}

describe('installed world context', () => {
  it('collects inherited country identifiers from active declarations only', () => {
    const context = buildWorldContext(
      MapWorkspaceIndex.build([
        file(
          'common/country_tags/synthetic.txt',
          'AAA = "countries/A.txt" bad_tag = "ignored.txt"',
        ),
        file('common/country_tags/other.txt', 'BBB = "countries/B.txt"'),
      ]),
    );
    expect(context.inheritedCountryTags).toEqual(['AAA', 'BBB']);
  });
  it('retains shadowed continent identifiers and rejects malformed keys', () => {
    const context = buildWorldContext(
      MapWorkspaceIndex.build([
        file('map/continent.txt', 'continents = { old_north old_south }'),
        file('map/continent.txt', 'continents = { world_continent_1 }', 1),
      ]),
    );
    expect(context.continentKeys).toEqual(['old_north', 'old_south', 'world_continent_1']);
    expect(() =>
      buildWorldContext(
        MapWorkspaceIndex.build([file('map/continent.txt', 'continents = { bad = value }')]),
      ),
    ).toThrow('scalar keys');
  });
  it('loads all four palettes and declared graphical terrain and state conventions', () => {
    const files = ['terrain', 'rivers', 'trees', 'cities'].map((name, index) =>
      file(`map/${name}.bmp`, bitmap(palette(index))),
    );
    files.push(
      file(
        'common/terrain/synthetic.txt',
        `
      categories = { hills = { color = { 180 190 200 } } }
      terrain = {
        desert_variant = { type = hills color = { 2 } }
        hills_blend = { type = hills color = { 17 } }
        terrain_0 = { type = plains color = { 0 5 } }
        snow = { type = plains color = { 19 } perm_snow = yes }
      }
    `,
      ),
    );
    files.push(
      file(
        'common/state_category/synthetic.txt',
        'state_categories = { rural = { local_building_slots = 2 } city = { local_building_slots = 4 } }',
      ),
    );
    const originals = files.map((entry) => entry.bytes.slice());
    const context = buildWorldContext(MapWorkspaceIndex.build(files));
    for (const [index, name] of (['terrain', 'rivers', 'trees', 'cities'] as const).entries())
      expect(context.palettes[name]).toEqual(palette(index));
    expect([...context.terrainIndex!]).toEqual([
      ['hills', 17],
      ['plains', 0],
    ]);
    expect([...context.stateCategories!]).toEqual(['city', 'rural']);
    expect(context).toMatchObject({
      mapRoot: 'map',
      statesRoot: 'history/states',
      localisationRoot: 'localisation',
    });
    for (const [index, entry] of files.entries()) expect(entry.bytes).toEqual(originals[index]);
  });

  it('respects active mod overrides and custom configured source roots', () => {
    const base = MapWorkspaceIndex.build(
      [
        file('alternate/terrain.bmp', bitmap()),
        file('alternate/terrain.bmp', bitmap(palette(33)), 1),
        file(
          'common/terrain/synthetic.txt',
          'terrain = { terrain_0 = { type = plains color = { 0 } } }',
        ),
        file(
          'common/terrain/synthetic.txt',
          'terrain = { plains = { type = plains color = { 43 } } }',
          1,
        ),
      ],
      { map: ['alternate'], states: ['custom/states'], localisation: ['custom/localisation'] },
    );
    const context = buildWorldContext(base);
    expect(context.palettes.terrain).toEqual(palette(33));
    expect(context.terrainIndex?.get('plains')).toBe(43);
    expect(context).toMatchObject({
      mapRoot: 'alternate',
      statesRoot: 'custom/states',
      localisationRoot: 'custom/localisation',
    });
  });

  it('uses stable active filename order for category overrides and ignores unrelated colors', () => {
    const files = [
      file(
        'common/terrain/z_override.txt',
        'terrain = { hills = { type = hills color = { 37 } } }',
      ),
      file(
        'common/terrain/a_base.txt',
        'categories = { hills = { color = { 255 0 255 } } } terrain = { hills = { type = hills color = { 17 } } }',
      ),
    ];
    const first = buildWorldContext(MapWorkspaceIndex.build(files));
    const second = buildWorldContext(MapWorkspaceIndex.build([...files].reverse()));
    expect(first.terrainIndex?.get('hills')).toBe(37);
    expect(second).toEqual(first);
  });

  it('retains fallback conventions when no installed sources were scanned', () => {
    expect(buildWorldContext(MapWorkspaceIndex.build([]))).toEqual({
      palettes: {},
      mapRoot: 'map',
      statesRoot: 'history/states',
      localisationRoot: 'localisation',
    });
  });

  it.each(['terrain', 'rivers', 'trees', 'cities'])(
    'rejects a malformed %s bitmap rather than inventing a palette',
    (name) => {
      expect(() =>
        buildWorldContext(
          MapWorkspaceIndex.build([file(`map/${name}.bmp`, Buffer.from('bad bitmap'))]),
        ),
      ).toThrow('malformed');
    },
  );

  it('rejects RGB and incomplete indexed palettes', () => {
    const rgb = createBmp({
      width: 2,
      height: 2,
      bitsPerPixel: 24,
      rgbPixels: Array.from({ length: 4 }, () => ({ r: 0, g: 0, b: 0 })),
    });
    expect(() =>
      buildWorldContext(MapWorkspaceIndex.build([file('map/terrain.bmp', rgb)])),
    ).toThrow('8-bit');
    expect(() =>
      buildWorldContext(
        MapWorkspaceIndex.build([file('map/rivers.bmp', bitmap(palette().slice(0, 16)))]),
      ),
    ).toThrow('256');
    const truncated = bitmap();
    truncated.writeUInt32LE(300, 46);
    expect(() =>
      buildWorldContext(MapWorkspaceIndex.build([file('map/trees.bmp', truncated)])),
    ).toThrow('malformed');
  });

  it('accepts valid 255-entry terrain and city palettes without discarding their colors', () => {
    const colors = palette().slice(0, 255);
    const context = buildWorldContext(
      MapWorkspaceIndex.build([
        file('map/terrain.bmp', bitmap(colors)),
        file('map/cities.bmp', bitmap(colors)),
      ]),
    );
    expect(context.palettes.terrain).toEqual(colors);
    expect(context.palettes.cities).toEqual(colors);
  });

  it('rejects missing palette entries referenced by graphical terrain definitions', () => {
    const base = MapWorkspaceIndex.build([
      file('map/terrain.bmp', bitmap(palette().slice(0, 255))),
      file(
        'common/terrain/synthetic.txt',
        'terrain = { plains = { type = plains color = { 255 } } }',
      ),
    ]);
    expect(() => buildWorldContext(base)).toThrow('missing terrain palette');
  });

  it('refuses a malformed active mod palette even if a lower root has a valid one', () => {
    const base = MapWorkspaceIndex.build([
      file('map/cities.bmp', bitmap()),
      file('map/cities.bmp', Buffer.from('broken'), 1),
    ]);
    expect(() => buildWorldContext(base)).toThrow('malformed');
  });

  it.each([
    'terrain = { plains = { type = plains color = { 256 } } }',
    'terrain = { plains = { type = plains color = { -1 } } }',
    'terrain = { plains = { type = plains color = { 0.5 } } }',
    'terrain = { plains = { type = plains color = { unknown } } }',
    'terrain = { plains = { type = plains color = { } } }',
    'terrain = { plains = { color = { 0 } } }',
    'terrain = { plains = yes }',
    'terrain = yes',
    'terrain = { unknown }',
    'terrain = { plains = { type = plains type = hills color = { 0 } } }',
    'terrain = { plains = { type = plains color = { 0 } }',
  ])('rejects unsupported or malformed graphical terrain: %s', (source) => {
    expect(() =>
      buildWorldContext(MapWorkspaceIndex.build([file('common/terrain/synthetic.txt', source)])),
    ).toThrow();
  });

  it.each([
    'state_categories = { rural = yes }',
    'state_categories = { }',
    'rural = { }',
    'state_categories = { rural = { }',
  ])('rejects malformed or empty state category conventions: %s', (source) => {
    expect(() =>
      buildWorldContext(
        MapWorkspaceIndex.build([file('common/state_category/synthetic.txt', source)]),
      ),
    ).toThrow();
  });
});

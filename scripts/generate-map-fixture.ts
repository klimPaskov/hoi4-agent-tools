import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';
import {
  canonicalize,
  compareCodeUnits,
  sha256Bytes,
} from '../src/hoi4_agent_tools/core/canonical.js';
import { createBmp, type RgbColor } from '../src/hoi4_agent_tools/map/bmp.js';

const fixtureRoot = path.resolve(import.meta.dirname, '..', 'fixtures', 'map');
const width = 256;
const height = 256;

const colors = {
  zero: { r: 0, g: 0, b: 0 },
  one: { r: 10, g: 0, b: 0 },
  two: { r: 0, g: 0, b: 200 },
  three: { r: 0, g: 160, b: 220 },
  four: { r: 0, g: 180, b: 0 },
} satisfies Record<string, RgbColor>;

async function prettyJson(value: unknown): Promise<string> {
  return format(JSON.stringify(canonicalize(value)), {
    parser: 'json',
    printWidth: 100,
    endOfLine: 'lf',
  });
}

function provinceBitmap(): Buffer {
  const pixels: RgbColor[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.push(
        x < 64 ? colors.one : x < 128 ? colors.four : x < 192 ? colors.two : colors.three,
      );
    }
  }
  return createBmp({
    width,
    height,
    bitsPerPixel: 24,
    dibSize: 124,
    rgbPixels: pixels,
  });
}

const stateOne = [
  '# Project-owned game-root state; comments and unknown blocks must survive targeted edits.',
  'state = {',
  '\tid = 1',
  '\tname = "STATE_1"',
  '\tmanpower = 1000',
  '\tstate_category = town',
  '\tresources = { steel = 10 }',
  '\tprovinces = { 1 4 }',
  '\tunknown_fixture_block = { preserve = yes }',
  '\thistory = {',
  '\t\towner = AAA',
  '\t\tadd_core_of = AAA',
  '\t\tvictory_points = { 1 5 }',
  '\t\tbuildings = {',
  '\t\t\tinfrastructure = 3',
  '\t\t\t1 = { arms_factory = 1 naval_base = 1 }',
  '\t\t\t4 = { bunker = 1 }',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

const locatorLine =
  'entity = { name = synthetic_map_entity locator = { name = synthetic_map_locator position = { 1 2 3 } } }';

const files = new Map<string, string | Buffer>([
  [
    'roots/game/map/default.map',
    [
      '# Lower root selects a differently named definition database for allocation evidence.',
      'definitions = "game_definitions.csv"',
      '',
    ].join('\n'),
  ],
  ['roots/game/map/game_definitions.csv', '20;90;91;92;land;false;plains;1\n'],
  [
    'roots/dependency/map/default.map',
    [
      '# Dependency root selects the active definition database by its own default.map.',
      'definitions = "definition.csv"',
      '',
    ].join('\n'),
  ],
  [
    'roots/mod/map/default.map',
    [
      '# Project-owned overlay selecting source databases from all three roots.',
      'definitions = "definition.csv"',
      'provinces = "provinces.bmp"',
      'adjacencies = "adjacencies.csv"',
      'positions = "positions.txt"',
      '',
    ].join('\n'),
  ],
  [
    'roots/dependency/map/definition.csv',
    [
      '0;0;0;0;sea;false;ocean;0',
      '1;10;0;0;land;true;plains;1',
      '2;0;0;200;land;true;plains;1',
      '3;0;160;220;sea;true;ocean;0',
      '4;0;180;0;land;false;forest;1',
      '',
    ].join('\n'),
  ],
  ['roots/game/map/provinces.bmp', provinceBitmap()],
  [
    'roots/game/map/adjacencies.csv',
    [
      'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment',
      '-1;-1;;-1;-1;-1;-1;-1;;',
      '',
    ].join('\n'),
  ],
  ['roots/game/map/supply_nodes.txt', '1 1\n'],
  ['roots/game/map/railways.txt', '1 3 1 4 2\n'],
  [
    'roots/game/map/buildings.txt',
    [
      '1;bunker;10;0;245;0;0',
      '1;naval_base_spawn;10;0;245;0;3',
      '1;bunker;70;0;245;0;0',
      '2;bunker;140;0;245;0;0',
      '',
    ].join('\n'),
  ],
  ['roots/game/map/unitstacks.txt', '1;0;10;0;245;0;0\n'],
  ['roots/game/map/weatherpositions.txt', '1;10;0;245;small\n1;140;0;245;big\n'],
  ['roots/game/history/states/1-GAME.txt', stateOne],
  [
    'roots/dependency/history/states/2-DEPENDENCY.txt',
    [
      'state = {',
      '\tid = 2',
      '\tname = "STATE_2"',
      '\tmanpower = 500',
      '\tstate_category = town',
      '\tprovinces = { 2 }',
      '\thistory = { owner = BBB add_core_of = BBB }',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'roots/mod/history/states/5-MOD.txt',
    [
      '# Empty project-owned state intentionally makes state IDs sparse across roots.',
      'state = {',
      '\tid = 5',
      '\tname = "STATE_5"',
      '\tmanpower = 50',
      '\tstate_category = rural',
      '\tprovinces = { }',
      '\thistory = { owner = CCC }',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'roots/dependency/map/strategicregions/1-REGION.txt',
    [
      'strategic_region = {',
      '\tid = 1',
      '\tname = "STRATEGICREGION_1"',
      '\tprovinces = { 1 2 3 4 }',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'roots/mod/map/strategicregions/2-REGION.txt',
    [
      'strategic_region = {',
      '\tid = 2',
      '\tname = "STRATEGICREGION_2"',
      '\tprovinces = { }',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'roots/game/localisation/english/game_map_l_english.yml',
    Buffer.from('\ufeffl_english:\nSTATE_1: "Game State"\n', 'utf8'),
  ],
  [
    'roots/dependency/localisation/english/dependency_map_l_english.yml',
    Buffer.from(
      '\ufeffl_english:\nSTATE_2: "Dependency State"\nSTRATEGICREGION_1: "Shared Region"\n',
      'utf8',
    ),
  ],
  [
    'roots/mod/localisation/english/mod_map_l_english.yml',
    Buffer.from(
      '\ufeffl_english:\nSTATE_3: "Created State"\nSTATE_4: "Explicit State"\nSTATE_5: "Mod State"\nSTRATEGICREGION_2: "Empty Region"\n',
      'utf8',
    ),
  ],
  ['roots/mod/gfx/entities/synthetic_map.asset', `${locatorLine}\n`],
  [
    'roots/mod/notes/untouched.txt',
    'This project-owned file is outside the map scan and must remain byte-identical.\n',
  ],
]);

const invalidVariants = {
  schemaVersion: 1,
  variants: [
    {
      id: 'unknown_bitmap_color',
      patches: [
        {
          kind: 'bitmap_rectangle',
          root: 'game',
          relativePath: 'map/provinces.bmp',
          minX: 70,
          minY: 10,
          maxX: 70,
          maxY: 10,
          color: { r: 255, g: 0, b: 255 },
        },
      ],
      expectedDiagnosticCodes: ['MAP_BITMAP_COLOR_UNREGISTERED'],
    },
    {
      id: 'orphan_definition',
      patches: [
        {
          kind: 'bitmap_replace_color',
          root: 'game',
          relativePath: 'map/provinces.bmp',
          from: colors.four,
          to: colors.one,
        },
      ],
      expectedDiagnosticCodes: ['MAP_DEFINITION_UNUSED'],
    },
    {
      id: 'disconnected_component',
      patches: [
        {
          kind: 'bitmap_rectangle',
          root: 'game',
          relativePath: 'map/provinces.bmp',
          minX: 80,
          minY: 20,
          maxX: 82,
          maxY: 22,
          color: colors.one,
        },
      ],
      expectedDiagnosticCodes: ['MAP_PROVINCE_DISCONNECTED_REVIEW'],
    },
    {
      id: 'enclosed_province_hole',
      patches: [
        {
          kind: 'bitmap_rectangle',
          root: 'game',
          relativePath: 'map/provinces.bmp',
          minX: 80,
          minY: 80,
          maxX: 90,
          maxY: 90,
          color: colors.two,
        },
      ],
      expectedDiagnosticCodes: ['MAP_PROVINCE_HOLE_REVIEW'],
    },
    {
      id: 'thin_corridor',
      patches: [
        {
          kind: 'bitmap_rectangle',
          root: 'game',
          relativePath: 'map/provinces.bmp',
          minX: 64,
          minY: 100,
          maxX: 95,
          maxY: 100,
          color: colors.one,
        },
      ],
      expectedDiagnosticCodes: ['MAP_PROVINCE_THIN_CORRIDOR_REVIEW'],
    },
    {
      id: 'invalid_references',
      patches: [
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'history/states/1-GAME.txt',
          search: '\tprovinces = { 1 4 }',
          replacement: '\tprovinces = { 1 4 999 }',
        },
        {
          kind: 'text_replace',
          root: 'dependency',
          relativePath: 'map/strategicregions/1-REGION.txt',
          search: '\tprovinces = { 1 2 3 4 }',
          replacement: '\tprovinces = { 1 2 3 4 999 }',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/adjacencies.csv',
          search: '-1;-1;;-1;-1;-1;-1;-1;;\n',
          replacement:
            '1;999;impassable;-1;-1;-1;-1;-1;;invalid endpoint\n-1;-1;;-1;-1;-1;-1;-1;;\n',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/supply_nodes.txt',
          search: '1 1\n',
          replacement: '1 999\n',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/railways.txt',
          search: '1 3 1 4 2\n',
          replacement: '1 3 1 4 999\n',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/buildings.txt',
          search: '1;bunker;10;0;245;0;0',
          replacement: '999;bunker;10;0;245;0;0',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/unitstacks.txt',
          search: '1;0;10;0;245;0;0',
          replacement: '999;0;10;0;245;0;0',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/weatherpositions.txt',
          search: '1;10;0;245;small',
          replacement: '999;10;0;245;small',
        },
        {
          kind: 'text_replace',
          root: 'mod',
          relativePath: 'gfx/entities/synthetic_map.asset',
          search: `${locatorLine}\n`,
          replacement: `${locatorLine}\n${locatorLine}\n`,
        },
      ],
      expectedDiagnosticCodes: [
        'MAP_STATE_PROVINCE_INVALID',
        'MAP_REGION_PROVINCE_INVALID',
        'MAP_ADJACENCY_PROVINCE_INVALID',
        'MAP_SUPPLY_NODE_INVALID',
        'MAP_RAILWAY_PROVINCE_INVALID',
        'MAP_BUILDING_POSITION_INVALID',
        'MAP_UNIT_POSITION_INVALID',
        'MAP_WEATHER_REGION_INVALID',
        'MAP_ENTITY_LOCATOR_DUPLICATE',
      ],
    },
    {
      id: 'localisation_coast_and_ports',
      patches: [
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'localisation/english/game_map_l_english.yml',
          search: 'STATE_1: "Game State"\n',
          replacement: '',
        },
        {
          kind: 'text_replace',
          root: 'dependency',
          relativePath: 'map/definition.csv',
          search: '1;10;0;0;land;true;plains;1',
          replacement: '1;10;0;0;land;false;plains;1',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'map/buildings.txt',
          search: '1;naval_base_spawn;10;0;245;0;3',
          replacement: '1;naval_base_spawn;10;0;245;0;4',
        },
        {
          kind: 'text_replace',
          root: 'game',
          relativePath: 'history/states/1-GAME.txt',
          search: '\t\t\t4 = { bunker = 1 }',
          replacement: '\t\t\t4 = { bunker = 1 naval_base = 1 }',
        },
      ],
      expectedDiagnosticCodes: [
        'MAP_STATE_LOCALISATION_MISSING',
        'MAP_COASTAL_MISMATCH',
        'MAP_PORT_ADJACENT_SEA_INVALID',
        'MAP_PORT_NOT_COASTAL',
        'MAP_PORT_LOCATOR_MISSING',
      ],
    },
  ],
};

files.set('invalid/invalid-variants.json', await prettyJson(invalidVariants));

const sourceFiles = [...files]
  .filter(([relativePath]) => relativePath.startsWith('roots/'))
  .map(([relativePath, content]) => {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const [, root, ...segments] = relativePath.split('/');
    return {
      root,
      relativePath: segments.join('/'),
      sha256: sha256Bytes(bytes),
      size: bytes.length,
    };
  })
  .sort((left, right) =>
    compareCodeUnits(`${left.root}/${left.relativePath}`, `${right.root}/${right.relativePath}`),
  );

const manifest = {
  schemaVersion: 1,
  dimensions: { width, height, bitsPerPixel: 24, dibSize: 124 },
  definitionIds: [0, 1, 2, 3, 4],
  stateIds: [1, 2, 5],
  strategicRegionIds: [1, 2],
  provincePixelCounts: { '1': 16_384, '2': 16_384, '3': 16_384, '4': 16_384 },
  activeSourceRoots: {
    defaultMap: 'mod',
    definitions: 'dependency',
    provinceBitmap: 'game',
  },
  sourceFiles,
  provinceBitmapSha256: sourceFiles.find(
    ({ root, relativePath }) => root === 'game' && relativePath === 'map/provinces.bmp',
  )?.sha256,
  invalidVariants: invalidVariants.variants.map(({ id, expectedDiagnosticCodes }) => ({
    id,
    expectedDiagnosticCodes,
  })),
};

files.set('fixture-manifest.json', await prettyJson(manifest));

for (const [relativePath, content] of files) {
  const target = path.join(fixtureRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

process.stderr.write(`Generated ${files.size} deterministic Agent Nudger fixture files.\n`);

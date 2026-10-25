import { describe, expect, it } from 'vitest';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import { generateWorld } from '../../src/hoi4_agent_tools/map/world.js';
import {
  adjacencyRows,
  landComponents,
  provinceMap,
  type ProvinceMapView,
} from '../helpers/gameplay-checks.js';
import {
  GAMEPLAY_HEIGHT,
  GAMEPLAY_WIDTH,
  gameplayGeography,
  gameplaySpec,
  gameplayWorld,
} from '../helpers/gameplay-fixture.js';
import { filesOf, indexOfFiles, plainContext } from '../helpers/map-appearance-world.js';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  geographyModelSchema,
  type GeographyModelInput,
} from '../../src/hoi4_agent_tools/schemas/geography.js';

const noteCodes = (world: ReturnType<typeof gameplayWorld>): string[] =>
  world.notes.map(({ code }) => code);

function withModel(edit: (model: GeographyModelInput) => void) {
  const model = gameplayGeography();
  edit(model);
  const geography = resolveGeography(model, {
    frame: { width: GAMEPLAY_WIDTH, height: GAMEPLAY_HEIGHT },
    hasReference: false,
  }).geography;
  return gameplaySpec({ geography });
}

describe('named straits and canals', () => {
  const world = gameplayWorld();
  const map = provinceMap(world);
  const rows = adjacencyRows(world);
  const sea = rows.filter(({ type }) => type === 'sea');

  it('writes each model strait as a named crossing with its rule', () => {
    const bright = sea.find(({ comment }) => comment === 'Bright Strait')!;
    expect(bright.rule).toBe('BRIGHT_STRAIT');
    expect(map.typeOf.get(bright.from)).toBe('land');
    expect(map.typeOf.get(bright.to)).toBe('land');
    expect(map.typeOf.get(bright.through)).toBe('sea');
    // The two shores are different lands: nothing joins them by land.
    const land = landComponents(map, () => true);
    expect(land.get(bright.from)).not.toBe(land.get(bright.to));
    // The crossing line lies on the map, y counted from the bottom.
    const [sx, sy, ex, ey] = bright.coordinates as [number, number, number, number];
    for (const x of [sx, ex]) expect(x).toBeGreaterThanOrEqual(0);
    for (const y of [sy, ey]) expect(y).toBeLessThan(GAMEPLAY_HEIGHT);
    const rules = filesOf(world).get('map/adjacency_rules.txt')!.toString('utf8');
    expect(rules).toContain('name = "BRIGHT_STRAIT"');
    // army-closed: no army may use it in any state, ships may.
    const friend = /friend =\s*\{([^}]*)\}/u.exec(rules.slice(rules.indexOf('BRIGHT_STRAIT')))![1]!;
    expect(friend).toContain('army = no');
    expect(friend).toContain('navy = yes');
    expect(rules).toContain(
      `required_provinces = { ${[bright.from, bright.through, bright.to].sort((a, b) => a - b).join(' ')} }`,
    );
  });

  it('writes a sea-to-sea canal from the inland sea through the isthmus', () => {
    const canal = sea.find(({ rule }) => rule === 'INNER_SEA_CANAL')!;
    expect(map.typeOf.get(canal.from)).toBe('sea');
    expect(map.typeOf.get(canal.to)).toBe('sea');
    expect(map.typeOf.get(canal.through)).toBe('land');
    // The inland sea is sea water inside Westmark, not a lake province.
    const inland = world.notes.find(({ code }) => code === 'MAP_INLAND_SEA_CREATED');
    expect(inland?.message).toContain('inner_sea');
    expect(map.typeOf.get(canal.from) === 'lake').toBe(false);
  });

  it('reports a strait whose shores are far apart and still writes it', () => {
    const note = world.notes.find(({ code }) => code === 'MAP_STRAIT_NOT_NARROW')!;
    expect(note.details).toMatchObject({ straitId: 'long_channel' });
    expect((note.details as { gapPx: number }).gapPx).toBeGreaterThan(48);
    expect(sea.some(({ comment }) => comment === 'Long Channel')).toBe(true);
    // The narrow one raises no such note.
    expect(
      world.notes.filter(
        ({ code, details }) =>
          code === 'MAP_STRAIT_NOT_NARROW' &&
          (details as { straitId?: string }).straitId === 'bright_strait',
      ),
    ).toEqual([]);
  });

  it('passes the existing adjacency and rule validators', () => {
    const result = validateMap(indexOfFiles(filesOf(world)));
    const bad = result.diagnostics.filter(
      ({ code, severity }) =>
        severity === 'error' && /ADJACENCY|IMPASSABLE|STRAIT|RULE/u.test(code),
    );
    expect(bad).toEqual([]);
  });

  it('detects narrow channels the model did not declare when asked', () => {
    const detected = generateWorld(gameplaySpec({ autoStraits: { maxGapPx: 24 } }), plainContext);
    const auto = adjacencyRows(detected).filter(({ comment }) => comment.startsWith('Auto strait'));
    expect(auto.length).toBeGreaterThan(0);
    for (const row of auto) {
      expect(row.rule).toBe('');
      expect(row.type).toBe('sea');
    }
    // Not asked for: none.
    expect(sea.some(({ comment }) => comment.startsWith('Auto strait'))).toBe(false);
  });

  it('warns about a strait that crosses no water and writes no row for it', () => {
    const spec = withModel((model) => {
      model.straits!.push({
        id: 'dry_cut',
        name: 'Dry Cut',
        path: [
          [0.18, 0.3],
          [0.26, 0.3],
        ],
      });
    });
    const built = generateWorld(spec, plainContext);
    expect(noteCodes(built)).toContain('MAP_STRAIT_UNRESOLVED');
    expect(adjacencyRows(built).some(({ comment }) => comment === 'Dry Cut')).toBe(false);
  });

  it('skips a duplicate strait over the same two provinces', () => {
    const spec = withModel((model) => {
      model.straits!.push({
        id: 'bright_again',
        name: 'Bright Again',
        path: [
          [0.45, 0.4],
          [0.52, 0.4],
        ],
      });
    });
    const built = generateWorld(spec, plainContext);
    expect(noteCodes(built)).toContain('MAP_STRAIT_DUPLICATE');
    expect(adjacencyRows(built).filter(({ comment }) => comment.startsWith('Bright'))).toHaveLength(
      1,
    );
  });
});

describe('a crossing between two coasts of one land', () => {
  it('writes a notch in the south coast as a land-to-land crossing', () => {
    const spec = withModel((model) => {
      model.straits!.push({
        id: 'notch_crossing',
        name: 'Notch Crossing',
        between: [
          [0.34, 0.76],
          [0.27, 0.76],
        ],
      });
    });
    const built = generateWorld(spec, plainContext);
    expect(noteCodes(built)).not.toContain('MAP_STRAIT_UNRESOLVED');
    const row = adjacencyRows(built).find(({ comment }) => comment === 'Notch Crossing')!;
    expect(row).toBeDefined();
    const map = provinceMap(built);
    expect(map.typeOf.get(row.from)).toBe('land');
    expect(map.typeOf.get(row.to)).toBe('land');
    expect(map.typeOf.get(row.through)).toBe('sea');
    expect(row.from).not.toBe(row.to);
  });

  it('still refuses two points of one land across no water', () => {
    const model = gameplayGeography();
    model.straits = [
      {
        id: 'dry_loop',
        between: [
          [0.12, 0.3],
          [0.2, 0.3],
        ],
      },
    ];
    const resolved = resolveGeography(geographyModelSchema.parse(model), {
      frame: { width: GAMEPLAY_WIDTH, height: GAMEPLAY_HEIGHT },
      hasReference: false,
    });
    expect(
      resolved.diagnostics.find(({ code }) => code === 'MAP_GEOGRAPHY_STRAIT_SAME_LAND'),
    ).toMatchObject({ severity: 'error' });
  });

  it('accepts bay as a sea kind and refuses an unknown one', () => {
    const model = gameplayGeography();
    model.seas![0]!.kind = 'bay';
    const resolved = resolveGeography(geographyModelSchema.parse(model), {
      frame: { width: GAMEPLAY_WIDTH, height: GAMEPLAY_HEIGHT },
      hasReference: false,
    });
    expect(resolved.geography.list('sea')[0]).toMatchObject({ seaKind: 'bay' });
    model.seas![0]!.kind = 'lagoon' as 'bay';
    expect(geographyModelSchema.safeParse(model).success).toBe(false);
  });
});

describe('the wall and its gates', () => {
  const world = gameplayWorld();
  const map = provinceMap(world);
  const rows = adjacencyRows(world);
  const walls = rows.filter(({ type }) => type === 'impassable');
  const blocked = new Set(walls.flatMap(({ from, to }) => [`${from}:${to}`, `${to}:${from}`]));
  const gatePairs = world.gameplay!.crossings.gates.map(([a, b]) => [a + 1, b + 1] as const);
  const gates = new Set(gatePairs.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]));

  function xOf(id: number, view: ProvinceMapView): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < view.ids.length; i += 7)
      if (view.ids[i] === id) {
        sum += i % view.width;
        n += 1;
      }
    return n === 0 ? -1 : sum / n;
  }

  it('writes well-formed impassable rows between touching land provinces', () => {
    expect(walls.length).toBeGreaterThan(8);
    for (const row of walls) {
      expect(row.through).toBe(-1);
      expect(row.coordinates).toEqual([-1, -1, -1, -1]);
      expect(row.rule).toBe('');
      expect(row.comment).toBe('Great Wall of Westmark');
      expect(map.neighbors.get(row.from)!.has(row.to)).toBe(true);
      expect(map.typeOf.get(row.from)).toBe('land');
      expect(map.typeOf.get(row.to)).toBe('land');
    }
    expect(new Set(walls.map(({ from, to }) => `${from}:${to}`)).size).toBe(walls.length);
  });

  it('is passable only at the gates: closing them splits the continent in two', () => {
    const west = (id: number): boolean => xOf(id, map) < GAMEPLAY_WIDTH * 0.3;
    const closed = landComponents(
      map,
      (a, b) => !blocked.has(`${a}:${b}`) && !gates.has(`${a}:${b}`),
    );
    const open = landComponents(map, (a, b) => !blocked.has(`${a}:${b}`));
    // Westmark's land provinces on the two sides of the wall.
    const westmark = [...map.typeOf]
      .filter(
        ([id, type]) => type === 'land' && xOf(id, map) >= 0 && xOf(id, map) < GAMEPLAY_WIDTH * 0.5,
      )
      .map(([id]) => id);
    const westSide = westmark.filter((id) => west(id) && xOf(id, map) < GAMEPLAY_WIDTH * 0.27);
    const eastSide = westmark.filter((id) => xOf(id, map) > GAMEPLAY_WIDTH * 0.33);
    expect(westSide.length).toBeGreaterThan(10);
    expect(eastSide.length).toBeGreaterThan(10);
    const westLabels = new Set(westSide.map((id) => closed.get(id)));
    const eastLabels = new Set(eastSide.map((id) => closed.get(id)));
    for (const label of westLabels) expect(eastLabels.has(label)).toBe(false);
    // Opening the gates joins them: one component holds provinces of both sides.
    const joined = westSide.some((id) =>
      eastSide.some((other) => open.get(id) === open.get(other)),
    );
    expect(joined).toBe(true);
  });

  it('keeps every gate open: each declared gate has a pair of provinces without a row', () => {
    const reports = world.gameplay!.crossings.passes;
    for (const id of ['north_gate', 'middle_gate', 'south_gate']) {
      const report = reports.find((pass) => pass.id === id)!;
      expect(report.open.length).toBeGreaterThan(0);
      for (const [a, b] of report.open) expect(blocked.has(`${a + 1}:${b + 1}`)).toBe(false);
    }
    expect(noteCodes(world)).not.toContain('MAP_PASS_BLOCKED');
    expect(noteCodes(world)).not.toContain('MAP_RANGE_NOT_CLOSED');
  });

  it('puts land forts at the gates and none on a fort-free pass', () => {
    const states = [...filesOf(world)]
      .filter(([name]) => name.startsWith('history/states/'))
      .map(([, bytes]) => bytes.toString('utf8'));
    const forts = states.flatMap((text) => [...text.matchAll(/(\d+) = \{[^}]*bunker = (\d+)/gu)]);
    const byProvince = new Map(forts.map((m) => [Number(m[1]), Number(m[2])]));
    const north = world.gameplay!.crossings.passes.find((pass) => pass.id === 'north_gate')!;
    for (const [a, b] of north.open.slice(0, 1)) {
      expect(byProvince.get(a + 1)).toBe(5);
      expect(byProvince.get(b + 1)).toBe(5);
    }
    expect(Math.max(...byProvince.values())).toBe(5);
    expect(byProvince.size).toBeGreaterThanOrEqual(4);
  });

  it('refuses a wall that needs more rows than the limit', () => {
    expect(() => generateWorld(gameplaySpec({ impassableRowLimit: 3 }), plainContext)).toThrow(
      expect.objectContaining({ code: 'MAP_IMPASSABLE_ROW_LIMIT' }) as Error,
    );
  });

  it('reports a wall that provinces straddle when the partition ignores it', () => {
    const { partition: _partition, ...withoutPartition } = gameplaySpec();
    const legacy = generateWorld(withoutPartition, plainContext);
    expect(noteCodes(legacy)).toContain('MAP_RANGE_NOT_CLOSED');
  });

  it('reports a pass whose gap lies over water', () => {
    const spec = withModel((model) => {
      model.ranges!.push({
        id: 'sea_wall',
        name: 'Sea Wall',
        profile: 'wall',
        barrier: 'impassable',
        path: [
          [0.1, 0.04],
          [0.25, 0.04],
        ],
        halfWidth: 0.006,
      });
      model.passes!.push({
        id: 'sea_gate',
        range: 'sea_wall',
        at: 0.5,
        width: 0.01,
        depth: 0.9,
      });
    });
    const built = generateWorld(spec, plainContext);
    const blockedNote = built.notes.find(({ code }) => code === 'MAP_PASS_BLOCKED');
    expect(blockedNote?.details).toMatchObject({ passId: 'sea_gate' });
  });

  it('keeps wall rows out of a map whose ranges declare no barrier', () => {
    const spec = withModel((model) => {
      for (const range of model.ranges!) range.barrier = 'none';
    });
    const built = generateWorld(spec, plainContext);
    expect(adjacencyRows(built).filter(({ type }) => type === 'impassable')).toEqual([]);
    expect(noteCodes(built)).not.toContain('MAP_RANGE_NOT_CLOSED');
  });
});

import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import type { TerritoryAtoms } from '../../src/hoi4_agent_tools/map/territory-graph.js';
import {
  growTerritory,
  TERRITORY_MAX_COUNTRIES,
  type TerritoryCountry,
} from '../../src/hoi4_agent_tools/map/territory.js';
import {
  atomNear,
  gridAtoms,
  provinceAtoms,
  scoreOwners,
  stateAtoms,
  territoryWorld,
  type TerritoryWorldFixture,
} from '../helpers/map-territory-fixture.js';

function expectCode(action: () => unknown, code: string): ServiceError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe(code);
    return error as ServiceError;
  }
  expect.fail(`expected ${code}`);
}

const country = (
  tag: string,
  seeds: number[],
  extra: Partial<TerritoryCountry> = {},
): TerritoryCountry => ({ tag, weight: 1, seeds, ...extra });

/** Connected pieces of one country's atoms on a graph. */
function pieces(atoms: TerritoryAtoms, owner: Int32Array, index: number): number {
  const seen = new Set<number>();
  let count = 0;
  for (let start = 0; start < atoms.count; start += 1) {
    if (owner[start] !== index || seen.has(start)) continue;
    count += 1;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const atom = stack.pop()!;
      for (
        let slot = atoms.graph.offsets[atom]!;
        slot < atoms.graph.offsets[atom + 1]!;
        slot += 1
      ) {
        const next = atoms.graph.to[slot]!;
        if (owner[next] === index && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }
  return count;
}

describe('territory growth on a grid with known rivers', () => {
  // 30 x 20 atoms; two rivers, one between columns 9 and 10 and one between columns 19 and 20.
  const atoms = gridAtoms({ width: 30, height: 20, riverColumns: [9, 19] });
  const at = (x: number, y: number): number => y * 30 + x;

  it('puts the border of three countries on the rivers although the seeds are off-centre', () => {
    // Plain nearest-seed borders would fall half-way between the seeds (columns 7 and 17).
    const countries = [
      country('AAA', [at(1, 10)]),
      country('BBB', [at(14, 10)]),
      country('CCC', [at(27, 10)]),
    ];
    const natural = growTerritory(atoms, countries, { jitter: 0 });
    const naive = growTerritory(atoms, countries, {
      barriers: 'none',
      jitter: 0,
      shareTolerance: 1,
    });
    const columnOwners = (owner: Int32Array): number[] =>
      Array.from({ length: 30 }, (_, x) => owner[at(x, 5)]!);
    expect(columnOwners(natural.owner).slice(0, 10)).toEqual(Array(10).fill(0));
    expect(columnOwners(natural.owner).slice(10, 20)).toEqual(Array(10).fill(1));
    expect(columnOwners(natural.owner).slice(20)).toEqual(Array(10).fill(2));
    // Without the rivers the borders fall half-way between the seeds, in columns 7 and 20.
    expect(columnOwners(naive.owner).slice(8, 10)).toEqual([1, 1]);
    expect(columnOwners(naive.owner).slice(18, 20)).toEqual([1, 1]);
    expect(natural.stats.naturalShare!).toBeGreaterThan(0.95);
    expect(naive.stats.naturalShare!).toBeLessThan(0.2);
    expect(natural.stats.maxShareError).toBeLessThanOrEqual(0.15);
  });

  it('grows connected territories from every seed and keeps the seeds', () => {
    const countries = [
      country('AAA', [at(2, 2)]),
      country('BBB', [at(25, 15)]),
      country('CCC', [at(15, 3)]),
    ];
    const result = growTerritory(atoms, countries);
    for (const [index, entry] of countries.entries()) {
      expect(result.owner[entry.seeds[0]!]).toBe(index);
      expect(pieces(atoms, result.owner, index)).toBe(1);
    }
    expect(result.stats.assignedAtoms).toBe(600);
    expect(result.stats.unownedAtoms).toBe(0);
    expect(result.origin).toEqual(result.owner);
  });

  it('is deterministic, and the seed changes where a featureless border runs', () => {
    const flat = gridAtoms({ width: 30, height: 20 });
    const countries = [country('AAA', [at(5, 10)]), country('BBB', [at(24, 10)])];
    const a = growTerritory(flat, countries, { seed: 3, jitter: 0.3 });
    const b = growTerritory(flat, countries, { seed: 3, jitter: 0.3 });
    const c = growTerritory(flat, countries, { seed: 4, jitter: 0.3 });
    expect(b.owner).toEqual(a.owner);
    expect(b.stats).toEqual(a.stats);
    expect(c.owner).not.toEqual(a.owner);
  });

  it('reaches target shares within the tolerance for unequal weights', () => {
    const flat = gridAtoms({ width: 40, height: 25 });
    const countries = [
      country('AAA', [12 * 1 + 5 * 40], { weight: 1 }),
      country('BBB', [20 + 12 * 40], { weight: 2 }),
      country('CCC', [35 + 20 * 40], { weight: 3 }),
      country('DDD', [3 + 22 * 40], { weight: 4 }),
    ];
    const result = growTerritory(flat, countries);
    for (const entry of result.stats.countries) expect(entry.shareError).toBeLessThanOrEqual(0.15);
    const shares = result.stats.countries.map(({ share }) => share);
    expect(shares[3]!).toBeGreaterThan(shares[2]!);
    expect(shares[2]!).toBeGreaterThan(shares[1]!);
    expect(shares[1]!).toBeGreaterThan(shares[0]!);
  });

  it('never gives a blocked atom to the country that may not own it', () => {
    const blocked = Array.from({ length: 20 }, (_, y) => at(14, y));
    const countries = [country('AAA', [at(3, 10)], { blocked }), country('BBB', [at(26, 10)])];
    const result = growTerritory(atoms, countries);
    for (const atom of blocked) expect(result.owner[atom]).not.toBe(0);
    expect(result.stats.unownedAtoms).toBe(0);
  });

  it('keeps forced atoms with their country and grows from them', () => {
    const forced = [at(25, 2), at(26, 2)];
    const countries = [country('AAA', [at(3, 10)], { forced }), country('BBB', [at(26, 10)])];
    const result = growTerritory(atoms, countries, { rules: { connectedMainland: false } });
    for (const atom of forced) expect(result.owner[atom]).toBe(0);
    // The forced atoms are an exclave of AAA in BBB's land.
    expect(result.stats.countries[0]!.pieces).toBeGreaterThanOrEqual(2);
  });

  it('joins a country cut in two by a corridor when the seeds are on its capital landmass', () => {
    // BBB's wedge splits AAA's two seeds; AAA's second seed must stay connected to its capital.
    const countries = [
      country('AAA', [at(2, 2), at(27, 2)], { weight: 1 }),
      country('BBB', [at(15, 3)], { weight: 6 }),
    ];
    const result = growTerritory(atoms, countries, { smoothing: { passes: 0 } });
    expect(pieces(atoms, result.owner, 0)).toBe(1);
    expect(result.stats.corridors).toBeGreaterThan(0);
  });

  it('places landmasses without a seed by the island policy', () => {
    // Two rows of atoms are sea; the strip below is an island of 30 x 4 atoms.
    const holes = new Set<number>();
    for (let y = 8; y < 10; y += 1) for (let x = 0; x < 30; x += 1) holes.add(y * 30 + x);
    const world = gridAtoms({ width: 30, height: 14, holes });
    const island = [10, 11, 12, 13].flatMap((y) =>
      Array.from({ length: 30 }, (_, x) => y * 30 + x),
    );
    const countries = [country('AAA', [3 * 30 + 3]), country('BBB', [3 * 30 + 26])];
    const options = { excluded: [...holes], jitter: 0 };
    const one = growTerritory(world, countries, {
      ...options,
      rules: { islandPolicy: 'one-owner' },
    });
    expect(new Set(island.map((atom) => one.owner[atom])).size).toBe(1);
    const nearest = growTerritory(world, countries, {
      ...options,
      rules: { islandPolicy: 'nearest' },
    });
    expect(island.every((atom) => nearest.owner[atom]! >= 0)).toBe(true);
    const none = growTerritory(world, countries, {
      ...options,
      rules: { islandPolicy: 'unowned' },
    });
    expect(island.every((atom) => none.owner[atom] === -1)).toBe(true);
    expect(none.stats.unownedAtoms).toBe(island.length);
  });

  it('grows a subject inside its overlord and merges relabelled territory', () => {
    const countries = [
      country('AAA', [at(3, 10)], { weight: 3 }),
      country('SUB', [at(6, 4)], { weight: 1, overlord: 'AAA' }),
      country('BBB', [at(26, 10)], { weight: 3 }),
      country('CCC', [at(26, 2)], { weight: 1, mergeInto: 'BBB' }),
    ];
    const result = growTerritory(atoms, countries, { barriers: 'none', jitter: 0 });
    const bloc = new Int32Array(atoms.count);
    for (let atom = 0; atom < atoms.count; atom += 1)
      bloc[atom] = result.origin[atom] === 0 || result.origin[atom] === 1 ? 0 : 1;
    // The overlord and its subject form one piece, and the subject has its share inside it.
    expect(pieces(atoms, bloc, 0)).toBe(1);
    expect(result.owner[at(6, 4)]).toBe(1);
    expect(result.stats.countries[1]!.shareError).toBeLessThanOrEqual(0.3);
    expect(result.stats.countries[0]!.shareError).toBeLessThanOrEqual(0.15);
    // CCC's land is relabelled BBB in the owner, and stays CCC in the origin.
    expect(result.owner[at(26, 2)]).toBe(2);
    expect(result.origin[at(26, 2)]).toBe(3);
    expect(result.owner.includes(3)).toBe(false);
  });

  it('refuses requests that cannot be satisfied, with the reason', () => {
    const base = [country('AAA', [at(3, 3)]), country('BBB', [at(20, 10)])];
    expectCode(() => growTerritory(atoms, []), 'MAP_TERRITORY_COUNTRIES_MISSING');
    expectCode(
      () => growTerritory(atoms, [country('AAA', [at(1, 1)]), country('AAA', [at(2, 2)])]),
      'MAP_TERRITORY_TAG_DUPLICATE',
    );
    expectCode(() => growTerritory(atoms, [country('aa', [1])]), 'MAP_TERRITORY_TAG_INVALID');
    expectCode(
      () => growTerritory(atoms, [{ tag: 'AAA', weight: 0, seeds: [1] }]),
      'MAP_TERRITORY_WEIGHT_INVALID',
    );
    expectCode(() => growTerritory(atoms, [country('AAA', [])]), 'MAP_TERRITORY_SEED_MISSING');
    expectCode(() => growTerritory(atoms, [country('AAA', [9_999])]), 'MAP_TERRITORY_ATOM_UNKNOWN');
    expectCode(
      () => growTerritory(atoms, [country('AAA', [at(3, 3)]), country('BBB', [at(3, 3)])]),
      'MAP_TERRITORY_FORCED_CONFLICT',
    );
    expectCode(
      () =>
        growTerritory(atoms, [
          country('AAA', [at(3, 3)], { forced: [at(4, 4)] }),
          country('BBB', [at(2, 2)], { forced: [at(4, 4)] }),
        ]),
      'MAP_TERRITORY_FORCED_CONFLICT',
    );
    expectCode(
      () => growTerritory(atoms, [country('AAA', [at(3, 3)], { blocked: [at(3, 3)] })]),
      'MAP_TERRITORY_FORCED_BLOCKED',
    );
    expectCode(
      () =>
        growTerritory(atoms, [country('AAA', [at(3, 3)], { overlord: 'ZZZ' }), ...base.slice(1)]),
      'MAP_TERRITORY_OVERLORD_INVALID',
    );
    expectCode(
      () =>
        growTerritory(atoms, [
          country('AAA', [at(3, 3)], { overlord: 'BBB' }),
          country('BBB', [at(20, 10)], { overlord: 'AAA' }),
        ]),
      'MAP_TERRITORY_OVERLORD_INVALID',
    );
    expectCode(
      () => growTerritory(atoms, [country('AAA', [at(3, 3)], { mergeInto: 'AAA' })]),
      'MAP_TERRITORY_MERGE_INVALID',
    );
    expectCode(
      () => growTerritory(atoms, base, { shareTolerance: 5 }),
      'MAP_TERRITORY_OPTION_INVALID',
    );
    expectCode(
      () => growTerritory(atoms, base, { smoothing: { passes: 99 } }),
      'MAP_TERRITORY_OPTION_INVALID',
    );
    expectCode(
      () => growTerritory(atoms, base, { excluded: [at(3, 3)] }),
      'MAP_TERRITORY_SEED_UNAVAILABLE',
    );
  });

  it('refuses a blocked wall that cuts a forced piece off from the capital', () => {
    // BBB may not own column 14, and AAA's forced atom sits behind BBB's seed row.
    const wall = Array.from({ length: 20 }, (_, y) => at(14, y));
    const countries = [
      country('AAA', [at(3, 10)], { forced: [at(26, 10)] }),
      country('BBB', [at(20, 10)]),
    ];
    // AAA's own path east is blocked for AAA itself.
    const error = expectCode(
      () => growTerritory(atoms, [{ ...countries[0]!, blocked: wall }, countries[1]!]),
      'MAP_TERRITORY_FORCED_UNREACHABLE',
    );
    expect(error.message).toContain('cuts it off');
  });

  it('accepts 512 countries and refuses 513', () => {
    const big = gridAtoms({ width: 36, height: 30 });
    const make = (n: number): TerritoryCountry[] =>
      Array.from({ length: n }, (_, i) => ({
        tag: `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))}`,
        weight: 1,
        seeds: [i * 2],
      }));
    expect(TERRITORY_MAX_COUNTRIES).toBe(512);
    const result = growTerritory(big, make(512), { smoothing: { passes: 1 } });
    expect(result.stats.countries).toHaveLength(512);
    expect(result.stats.unownedAtoms).toBe(0);
    for (let index = 0; index < 512; index += 1) expect(result.owner[index * 2]).toBe(index);
    expectCode(() => growTerritory(big, make(513)), 'MAP_TERRITORY_TOO_MANY_COUNTRIES');
  });

  it('honours an abort signal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      growTerritory(atoms, [country('AAA', [0]), country('BBB', [599])], {
        signal: controller.signal,
      }),
    ).toThrow();
  });
});

describe('territory growth on a partitioned world with rivers and ridges', () => {
  let fixture: TerritoryWorldFixture | undefined;
  const prepare = async (): Promise<TerritoryWorldFixture> => (fixture ??= await territoryWorld());

  it('finds more natural country borders than the nearest-seed baseline, on states and provinces', async () => {
    const world = await prepare();
    const seedsAt = [
      [0.25, 0.4],
      [0.33, 0.62],
      [0.5, 0.3],
      [0.62, 0.45],
      [0.8, 0.7],
    ] as const;
    const results: Array<{ unit: string; natural: number; naive: number; share: number }> = [];
    for (const [unit, atoms] of [
      ['state', stateAtoms(world)],
      ['province', provinceAtoms(world)],
    ] as const) {
      const countries = seedsAt.map(([fx, fy], index) =>
        country(
          `C${String.fromCharCode(65 + index)}${String.fromCharCode(65 + index)}`,
          [atomNear(atoms, fx, fy)],
          {
            weight: 1,
          },
        ),
      );
      const natural = growTerritory(atoms, countries, { seed: 5 });
      const naive = growTerritory(atoms, countries, { barriers: 'none', seed: 5 });
      const scoreNatural = scoreOwners(world, atoms, natural.owner);
      const scoreNaive = scoreOwners(world, atoms, naive.owner);
      results.push({
        unit,
        natural: scoreNatural.enrichment!,
        naive: scoreNaive.enrichment!,
        share: scoreNatural.naturalShare! - scoreNaive.naturalShare!,
      });
      expect(natural.stats.unownedAtoms).toBe(0);
      expect(scoreNatural.borderEdges).toBeGreaterThan(100);
    }
    for (const entry of results) {
      expect(entry.natural, `${entry.unit} enrichment`).toBeGreaterThan(entry.naive);
      expect(entry.share, `${entry.unit} natural share`).toBeGreaterThan(0);
    }
    const province = results.find(({ unit }) => unit === 'province')!;
    expect(province.natural).toBeGreaterThan(province.naive * 1.1);
  });

  it('smoothing never raises the artificial border and keeps every country in one piece', async () => {
    const world = await prepare();
    const atoms = provinceAtoms(world);
    const countries = [
      [0.25, 0.4],
      [0.5, 0.3],
      [0.8, 0.7],
    ].map(([fx, fy], index) => country(`S${index}S`, [atomNear(atoms, fx!, fy!)]));
    const rough = growTerritory(atoms, countries, { smoothing: { passes: 0 } });
    const smooth = growTerritory(atoms, countries, {
      smoothing: { passes: 6, maxShareChange: 0.2 },
    });
    expect(smooth.stats.smoothingMoves).toBeGreaterThan(0);
    expect(scoreOwners(world, atoms, smooth.owner).enrichment!).toBeGreaterThanOrEqual(
      scoreOwners(world, atoms, rough.owner).enrichment!,
    );
    for (let index = 0; index < 3; index += 1)
      expect(smooth.stats.countries[index]!.pieces).toBeLessThanOrEqual(
        smooth.stats.countries[index]!.landmasses + 0,
      );
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import type { MapOperationPlan } from '../../src/hoi4_agent_tools/map/operations.js';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import {
  generatedWorld,
  plan,
  removeTerritoryWorkspaces,
  spreadStates,
  stateAtDepth,
} from '../helpers/map-territory-world.js';

let world: Awaited<ReturnType<typeof generatedWorld>>;
let index: MapWorkspaceIndex;
let seeds: number[];

beforeAll(async () => {
  world = await generatedWorld();
  index = world.index;
  seeds = spreadStates(index, 5);
}, 120_000);
afterAll(removeTerritoryWorkspaces);

const TAGS = ['EEA', 'EEB', 'EEC', 'EED', 'EEE'];

function countries(extra: (position: number) => Record<string, unknown> = () => ({})) {
  return seeds.map((state, position) => ({
    tag: TAGS[position]!,
    weight: 1 + (position % 2),
    seeds: [{ state }],
    ...extra(position),
  }));
}

function assign(extra: Record<string, unknown> = {}, on: MapWorkspaceIndex = index) {
  return plan(on, [
    {
      id: 'territory',
      kind: 'assign_territory',
      countries: countries(),
      seed: 3,
      borderQuality: 'off',
      ...extra,
    },
  ]);
}

const hashOf = (result: MapOperationPlan): string =>
  sha256Bytes(
    Buffer.concat(
      result.changes.map(({ relativePath, content }) =>
        Buffer.concat([Buffer.from(relativePath), Buffer.from(content ?? [])]),
      ),
    ),
  );

const blockerCodes = (result: MapOperationPlan): string[] =>
  result.blockers.map(({ code }) => code);

describe('assign_territory by state', () => {
  it('gives every state to one of the countries and keeps the result valid', () => {
    const result = assign();
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    expect(new Set(final.states.map(({ owner }) => owner))).toEqual(new Set(TAGS));
    // Every state is in one piece of its country's list and controllers follow owners.
    for (const state of final.states) expect(state.controller).toBe(state.owner);
    const errors = validateMap(final).diagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    expect(errors).toEqual([]);
    expect(
      result.changes.every(({ relativePath }) => relativePath.startsWith('history/states/')),
    ).toBe(true);
    // The seeds belong to their countries.
    for (const [position, state] of seeds.entries())
      expect(final.statesById.get(state)?.owner).toBe(TAGS[position]);
  });

  it('reports the border statistics and beats the distance-only baseline', () => {
    const result = assign();
    const report = result.territory![0]!;
    expect(report.kind).toBe('assign_territory');
    expect(report.unit).toBe('state');
    expect(report.stats!.countries).toHaveLength(5);
    expect(report.stats!.assignedAtoms).toBe(index.states.length);
    expect(report.score.enrichment!).toBeGreaterThan(report.baseline!.enrichment!);
    expect(report.score.naturalShare!).toBeGreaterThanOrEqual(report.baseline!.naturalShare!);
    const info = result.diagnostics.find(({ code }) => code === 'MAP_TERRITORY_ASSIGNED');
    expect(info?.severity).toBe('info');
    expect(info?.message).toContain('Natural share of country borders');
  });

  it('is deterministic for a seed', () => {
    expect(hashOf(assign())).toBe(hashOf(assign()));
  });

  it('writes cores and claims as asked', () => {
    const result = assign({
      ownership: { cores: 'owner', claims: 'clear' },
      countries: countries((position) =>
        position === 0
          ? { claims: { stateIds: [seeds[1]!] }, cores: { stateIds: [seeds[2]!] } }
          : {},
      ),
    });
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    for (const state of final.states) {
      expect(state.cores).toContain(state.owner);
      expect(state.claims.filter((tag) => tag !== 'EEA')).toEqual([]);
    }
    expect(final.statesById.get(seeds[1]!)?.claims).toEqual(['EEA']);
    expect(final.statesById.get(seeds[2]!)?.cores).toEqual(expect.arrayContaining(['EEA', 'EEC']));
  });

  it('leaves the states outside the scope alone', () => {
    const inScope = index.states.filter(({ id }) => id % 2 === 0).map(({ id }) => id);
    const result = assign({
      scope: { stateIds: inScope },
      countries: countries().map((entry, position) => ({
        ...entry,
        seeds: [{ state: inScope[position * 4]! }],
      })),
    });
    expect(result.blockers).toEqual([]);
    for (const state of index.states.filter(({ id }) => id % 2 === 1))
      expect(result.finalIndex.statesById.get(state.id)?.owner).toBe(state.owner);
  });

  it('never gives a blocked state to the country that may not own it', () => {
    const blocked = index.states
      .filter(({ id }) => id % 3 === 0 && !seeds.includes(id))
      .map(({ id }) => id);
    const result = assign({
      countries: countries((position) =>
        position === 1 ? { blocked: { stateIds: blocked } } : {},
      ),
    });
    expect(result.blockers).toEqual([]);
    for (const id of blocked) expect(result.finalIndex.statesById.get(id)?.owner).not.toBe('EEB');
  });

  it('keeps forced states with their country', () => {
    const forced = index.states.filter(({ id }) => id % 11 === 0).map(({ id }) => id);
    const result = assign({
      rules: { connectedMainland: false },
      countries: countries((position) =>
        position === 3 ? { forced: { stateIds: forced.filter((id) => !seeds.includes(id)) } } : {},
      ),
    });
    expect(result.blockers).toEqual([]);
    for (const id of forced.filter((state) => !seeds.includes(state)))
      expect(result.finalIndex.statesById.get(id)?.owner).toBe('EED');
  });

  it('accepts a point or a province as a seed', () => {
    const state = index.statesById.get(seeds[0]!)!;
    const province = state.provinces.find((id) => index.definitionsById.get(id)?.type === 'land')!;
    const geometry = index.raster!.geometry.get(province)!;
    const byPoint = assign({
      countries: countries().map((entry, position) =>
        position === 0
          ? {
              ...entry,
              seeds: [
                {
                  x: Math.round(geometry.centerX),
                  y: Math.round(geometry.centerY),
                },
              ],
            }
          : entry,
      ),
    });
    // The centre of a province is not always inside it; either a clear result or a precise error.
    if (byPoint.blockers.length === 0)
      expect(byPoint.finalIndex.statesById.get(seeds[0]!)?.owner).toBe('EEA');
    const byProvince = assign({
      countries: countries().map((entry, position) =>
        position === 0 ? { ...entry, seeds: [{ province }] } : entry,
      ),
    });
    expect(byProvince.blockers).toEqual([]);
    expect(byProvince.finalIndex.statesById.get(seeds[0]!)?.owner).toBe('EEA');
  });

  it('refuses a seed in water, an unknown state, and seeds that clash', () => {
    const sea = index.definitions.find(({ type }) => type === 'sea')!;
    expect(
      blockerCodes(assign({ countries: [{ tag: 'EEA', seeds: [{ province: sea.id }] }] })),
    ).toEqual(['MAP_TERRITORY_SEED_IN_WATER']);
    const raster = index.raster!;
    const seaPixel = raster.provinceIds.findIndex(
      (id) => index.definitionsById.get(id)?.type === 'sea',
    );
    expect(seaPixel).toBeGreaterThanOrEqual(0);
    const inSea = assign({
      countries: [
        {
          tag: 'EEA',
          seeds: [{ x: seaPixel % raster.width, y: Math.floor(seaPixel / raster.width) }],
        },
      ],
    });
    expect(blockerCodes(inSea)).toEqual(['MAP_TERRITORY_SEED_IN_WATER']);
    expect(inSea.blockers[0]!.message).toContain(
      `at (${seaPixel % raster.width}, ${Math.floor(seaPixel / raster.width)})`,
    );
    expect(
      blockerCodes(assign({ countries: [{ tag: 'EEA', seeds: [{ state: 99_999 }] }] })),
    ).toEqual(['MAP_TERRITORY_STATE_UNKNOWN']);
    expect(
      blockerCodes(
        assign({
          countries: [
            { tag: 'EEA', seeds: [{ state: seeds[0]! }] },
            { tag: 'EEB', seeds: [{ state: seeds[0]! }] },
          ],
        }),
      ),
    ).toEqual(['MAP_TERRITORY_FORCED_CONFLICT']);
    expect(
      blockerCodes(assign({ countries: [{ tag: 'EEA', seeds: [{ x: 99_999, y: 0 }] }] })),
    ).toEqual(['MAP_TERRITORY_POINT_OUTSIDE_MAP']);
  });

  it('refuses a blocked region that cuts a forced state off from its capital', () => {
    // EEA may own nothing but its capital and a forced state two states away on the same landmass.
    const target = stateAtDepth(index, seeds[0]!, 2);
    expect(target).not.toBe(seeds[0]);
    const wall = index.states
      .filter(({ id }) => id !== seeds[0] && id !== target && id !== seeds[2])
      .map(({ id }) => id);
    const result = assign({
      countries: [
        {
          tag: 'EEA',
          seeds: [{ state: seeds[0]! }],
          forced: { stateIds: [target] },
          blocked: { stateIds: wall },
        },
        { tag: 'EEB', seeds: [{ state: seeds[2]! }] },
      ],
    });
    expect(blockerCodes(result)).toEqual(['MAP_TERRITORY_FORCED_UNREACHABLE']);
    expect(result.changes).toEqual([]);
  });

  it('refuses stateSize with whole states, and an empty selection of countries', () => {
    expect(blockerCodes(assign({ stateSize: { min: 3 } }))).toEqual([
      'MAP_TERRITORY_STATE_SIZE_NEEDS_PROVINCE_UNIT',
    ]);
    expect(() => assign({ countries: [] })).toThrow();
  });

  it('refuses unknown provinces, regions, scope states and tags in the request', () => {
    expect(
      blockerCodes(
        assign({
          countries: countries((position) =>
            position === 0 ? { forced: { provinceIds: [999_999] } } : {},
          ),
        }),
      ),
    ).toEqual(['MAP_TERRITORY_PROVINCE_UNKNOWN']);
    expect(
      blockerCodes(
        assign({
          countries: countries((position) =>
            position === 1 ? { blocked: { regionIds: [99_999] } } : {},
          ),
        }),
      ),
    ).toEqual(['MAP_TERRITORY_REGION_UNKNOWN']);
    expect(blockerCodes(assign({ scope: { stateIds: [99_999] } }))).toEqual([
      'MAP_TERRITORY_SCOPE_UNKNOWN',
    ]);
    expect(
      blockerCodes(
        assign({ countries: countries((position) => (position === 2 ? { overlord: 'ZZZ' } : {})) }),
      ),
    ).toEqual(['MAP_TERRITORY_OVERLORD_INVALID']);
    expect(
      blockerCodes(
        assign({
          countries: countries((position) => (position === 2 ? { mergeInto: TAGS[2]! } : {})),
        }),
      ),
    ).toEqual(['MAP_TERRITORY_MERGE_INVALID']);
    expect(
      blockerCodes(
        assign({
          countries: [
            { tag: 'EEA', seeds: [{ state: seeds[0]! }] },
            { tag: 'EEA', seeds: [{ state: seeds[1]! }] },
          ],
        }),
      ),
    ).toEqual(['MAP_TERRITORY_TAG_DUPLICATE']);
  });

  it('refuses forced and blocked land that contradicts itself, naming the state', () => {
    const own = assign({
      countries: countries((position) =>
        position === 0 ? { blocked: { stateIds: [seeds[0]!] } } : {},
      ),
    });
    expect(blockerCodes(own)).toEqual(['MAP_TERRITORY_FORCED_BLOCKED']);
    expect(own.blockers[0]!.message).toMatch(new RegExp(`^State ${seeds[0]!} `, 'u'));
    expect(own.blockers[0]!.details).toMatchObject({ stateId: seeds[0], tag: 'EEA' });
    const contested = index.states.find(({ id }) => !seeds.includes(id))!.id;
    const twice = assign({
      countries: countries((position) =>
        position < 2 ? { forced: { stateIds: [contested] } } : {},
      ),
    });
    expect(blockerCodes(twice)).toEqual(['MAP_TERRITORY_FORCED_CONFLICT']);
    expect(twice.blockers[0]!.details).toMatchObject({ stateId: contested, tags: ['EEA', 'EEB'] });
    expect(twice.changes).toEqual([]);
  });

  it('refuses a seed in land declared unowned or outside the scope', () => {
    const unowned = assign({ unowned: { stateIds: [seeds[3]!] } });
    expect(blockerCodes(unowned)).toEqual(['MAP_TERRITORY_SEED_UNAVAILABLE']);
    expect(unowned.blockers[0]!.details).toMatchObject({ stateId: seeds[3], tag: 'EED' });
    const outside = assign({
      scope: { stateIds: index.states.map(({ id }) => id).filter((id) => id !== seeds[4]) },
    });
    expect(blockerCodes(outside)).toEqual(['MAP_TERRITORY_SEED_UNAVAILABLE']);
    expect(outside.blockers[0]!.message).toMatch(new RegExp(`^State ${seeds[4]!} `, 'u'));
  });

  it('leaves land declared unowned without an owner, or as it was when asked to keep it', () => {
    const free = index.states.filter(({ id }) => !seeds.includes(id) && id % 7 === 0);
    expect(free.length).toBeGreaterThan(0);
    const cleared = assign({ unowned: { stateIds: free.map(({ id }) => id) } });
    expect(cleared.blockers).toEqual([]);
    for (const { id } of free) {
      const state = cleared.finalIndex.statesById.get(id)!;
      expect(state.owner).toBeUndefined();
      expect(state.controller).toBeUndefined();
    }
    const report = cleared.territory![0]!;
    expect(report.stats!.unownedAtoms).toBeGreaterThanOrEqual(free.length);
    const kept = assign({
      unowned: { stateIds: free.map(({ id }) => id) },
      ownership: { unowned: 'keep' },
    });
    expect(kept.blockers).toEqual([]);
    for (const state of free)
      expect(kept.finalIndex.statesById.get(state.id)?.owner).toBe(state.owner);
  });

  it('rejects requests beyond the schema limits before planning', () => {
    const operation = (extra: Record<string, unknown>) => ({
      id: 'territory',
      kind: 'assign_territory',
      countries: countries(),
      ...extra,
    });
    const rejected = (value: unknown) => !mapOperationSchema.safeParse(value).success;
    expect(rejected(operation({}))).toBe(false);
    const many = Array.from({ length: 513 }, (_, position) => ({
      tag: `T${String(position).padStart(2, '0')}`.slice(0, 3),
      seeds: [{ state: seeds[0]! }],
    }));
    expect(rejected(operation({ countries: many }))).toBe(true);
    expect(
      rejected(
        operation({
          countries: [{ tag: 'EEA', seeds: Array.from({ length: 65 }, () => ({ state: 1 })) }],
        }),
      ),
    ).toBe(true);
    expect(rejected(operation({ countries: [{ tag: 'eea', seeds: [{ state: 1 }] }] }))).toBe(true);
    expect(rejected(operation({ countries: [{ tag: 'EEA', seeds: [] }] }))).toBe(true);
    expect(
      rejected(operation({ countries: [{ tag: 'EEA', weight: 0, seeds: [{ state: 1 }] }] })),
    ).toBe(true);
    expect(rejected(operation({ countries: [{ tag: 'EEA', seeds: [{ x: -1, y: 0 }] }] }))).toBe(
      true,
    );
    expect(rejected(operation({ smoothing: { passes: 21 } }))).toBe(true);
    expect(rejected(operation({ shareTolerance: 0 }))).toBe(true);
    expect(rejected(operation({ unknownField: true }))).toBe(true);
    expect(
      rejected({
        id: 'bulk',
        kind: 'update_states',
        updates: Array.from({ length: 5_001 }, (_, position) => ({
          stateId: position + 1,
          changes: { owner: 'EEA' },
        })),
      }),
    ).toBe(true);
    expect(rejected({ id: 'bulk', kind: 'update_states', updates: [] })).toBe(true);
    expect(
      rejected({ id: 'again', kind: 'repartition_states', countries: ['EEA'], extra: 1 }),
    ).toBe(true);
  });
});

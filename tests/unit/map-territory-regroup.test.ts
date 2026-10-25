import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEVEL_STATE_BUILDINGS,
  type MapWorkspaceIndex,
} from '../../src/hoi4_agent_tools/map/model.js';
import { apportion } from '../../src/hoi4_agent_tools/map/state-restructure.js';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import {
  generatedWorld,
  plan,
  removeTerritoryWorkspaces,
  spreadStates,
} from '../helpers/map-territory-world.js';

let world: Awaited<ReturnType<typeof generatedWorld>>;
let index: MapWorkspaceIndex;
let seeds: number[];

beforeAll(async () => {
  world = await generatedWorld();
  index = world.index;
  seeds = spreadStates(index, 4);
}, 120_000);
afterAll(removeTerritoryWorkspaces);

const TAGS = ['EEA', 'EEB', 'EEC', 'EED'];

function countries() {
  return seeds.map((state, position) => ({
    tag: TAGS[position]!,
    weight: 1 + (position % 2),
    seeds: [{ state }],
  }));
}

/** Totals that every regrouping must conserve. */
function totals(on: MapWorkspaceIndex) {
  const resources = new Map<string, number>();
  const buildings = new Map<string, number>();
  let manpower = 0;
  let victoryPoints = 0;
  let provinceBuildings = 0;
  for (const state of on.states) {
    manpower += state.manpower;
    for (const [resource, amount] of state.resources)
      resources.set(resource, Math.round(((resources.get(resource) ?? 0) + amount) * 100) / 100);
    for (const [building, amount] of state.stateBuildings)
      if (!LEVEL_STATE_BUILDINGS.has(building))
        buildings.set(building, (buildings.get(building) ?? 0) + amount);
    victoryPoints += state.victoryPoints.reduce((sum, { value }) => sum + value, 0);
    provinceBuildings += [...state.provinceBuildings.values()].reduce(
      (sum, built) => sum + [...built.values()].reduce((inner, value) => inner + value, 0),
      0,
    );
  }
  return {
    manpower,
    resources: Object.fromEntries([...resources].sort()),
    buildings: Object.fromEntries([...buildings].sort()),
    victoryPoints,
    provinceBuildings,
  };
}

function expectConsistent(final: MapWorkspaceIndex): void {
  const errors = validateMap(final).diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  expect(errors).toEqual([]);
  // Every land province lies in exactly one state, and every state in one strategic region.
  const seen = new Map<number, number>();
  for (const state of final.states) {
    expect(new Set(state.provinces.map((id) => final.regionForProvince(id)[0]?.id)).size).toBe(1);
    for (const province of state.provinces) {
      expect(seen.has(province), `province ${province} in two states`).toBe(false);
      seen.set(province, state.id);
    }
  }
}

describe('apportion', () => {
  it('shares whole units exactly and decimals in hundredths', () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(7, [5, 0, 0])).toEqual([7, 0, 0]);
    expect(apportion(0, [3, 4])).toEqual([0, 0]);
    expect(apportion(1, [1, 1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(1);
    const shares = apportion(10.55, [1, 2, 4]);
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(10.55);
    expect(apportion(5, [])).toEqual([]);
  });
});

describe('assign_territory by province', () => {
  const run = (extra: Record<string, unknown> = {}) =>
    plan(index, [
      {
        id: 'territory',
        kind: 'assign_territory',
        unit: 'province',
        countries: countries(),
        seed: 2,
        borderQuality: 'off',
        ...extra,
      },
    ]);

  it('cuts states along the new borders, keeps the map valid and conserves every total', () => {
    const result = run();
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    expectConsistent(final);
    expect(totals(final)).toEqual(totals(index));
    expect(new Set(final.states.map(({ owner }) => owner))).toEqual(new Set(TAGS));
    const report = result.territory![0]!;
    expect(report.unit).toBe('province');
    expect(report.states.created.length).toBeGreaterThan(0);
    expect(final.states.length).toBeGreaterThan(index.states.length);
    // Province owners match the assignment: every province of a state shares its owner.
    for (const state of final.states) expect(state.controller).toBe(state.owner);
    // New states are named and localised.
    for (const id of report.states.created) {
      const created = final.statesById.get(id)!;
      expect(created.name).toBe(`STATE_${id}`);
      expect(final.localisationByKey.get(`l_english:${created.name}`)?.[0]?.entry.value).toMatch(
        /\(\d+\)$/u,
      );
    }
    expect(result.allocations.length).toBe(report.states.created.length);
  });

  it('puts country borders on more natural lines than distance alone, by state and by province', () => {
    const provinceResult = run();
    const stateResult = plan(index, [
      {
        id: 'territory',
        kind: 'assign_territory',
        countries: countries(),
        seed: 2,
        borderQuality: 'off',
      },
    ]);
    const byProvince = provinceResult.territory![0]!.score;
    const byState = stateResult.territory![0]!.score;
    // Both beat distance alone; the province unit may cut states, so its borders are at least
    // as natural as the generator's own state borders allow (about 1.6 and above here).
    expect(byState.enrichment!).toBeGreaterThan(stateResult.territory![0]!.baseline!.enrichment!);
    expect(byProvince.enrichment!).toBeGreaterThan(
      provinceResult.territory![0]!.baseline!.enrichment! + 0.3,
    );
    expect(byProvince.enrichment!).toBeGreaterThan(1.6);
  });

  it('joins fragments below the minimum state size to a neighbour of the same owner', () => {
    const loose = run();
    const joined = run({ stateSize: { min: 3, max: 12 } });
    expect(joined.blockers).toEqual([]);
    expectConsistent(joined.finalIndex);
    expect(totals(joined.finalIndex)).toEqual(totals(index));
    const small = (final: MapWorkspaceIndex) =>
      final.states.filter(({ provinces }) => provinces.length < 3).length;
    expect(small(joined.finalIndex)).toBeLessThanOrEqual(small(loose.finalIndex));
  });

  it('refuses a maximum below the minimum', () => {
    expect(run({ stateSize: { min: 5, max: 3 } }).blockers.map(({ code }) => code)).toEqual([
      'MAP_TERRITORY_STATE_SIZE_INVALID',
    ]);
  });
});

describe('repartition_states', () => {
  const run = (extra: Record<string, unknown> = {}, on: MapWorkspaceIndex = index) =>
    plan(on, [
      {
        id: 'regroup',
        kind: 'repartition_states',
        provincesPerState: { min: 3, target: 5, max: 8 },
        borderQuality: 'off',
        ...extra,
      },
    ]);

  it('regroups the states of every owner without losing anything', () => {
    const result = run();
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    expectConsistent(final);
    expect(totals(final)).toEqual(totals(index));
    // Owners keep the land they had.
    const ownerOf = (on: MapWorkspaceIndex) =>
      on.states
        .flatMap((state) => state.provinces.map((id) => [id, state.owner] as const))
        .sort((a, b) => a[0] - b[0]);
    expect(ownerOf(final)).toEqual(ownerOf(index));
    for (const state of final.states) expect(state.provinces.length).toBeLessThanOrEqual(8);
    const report = result.territory![0]!;
    expect(report.kind).toBe('repartition_states');
    expect(report.before).toBeDefined();
    expect(report.score.borderEdges).toBeGreaterThan(0);
    expect(result.diagnostics.map(({ code }) => code)).toContain('MAP_TERRITORY_REPARTITIONED');
  });

  it('is deterministic and leaves a second regrouping nearly unchanged', () => {
    const first = run();
    const second = run({}, first.finalIndex);
    expect(second.blockers).toEqual([]);
    expect(second.territory![0]!.states.created.length).toBe(0);
    expect(second.territory![0]!.states.removed.length).toBe(0);
    expect(first.finalIndex.states.map(({ provinces }) => provinces.join())).toEqual(
      run().finalIndex.states.map(({ provinces }) => provinces.join()),
    );
  });

  it('limits the regrouping to the listed owners', () => {
    const result = run({ countries: ['AAA'] });
    expect(result.blockers).toEqual([]);
    const final = result.finalIndex;
    const other = (on: MapWorkspaceIndex) =>
      on.states
        .filter(({ owner }) => owner !== 'AAA')
        .map(({ id, provinces }) => `${id}:${provinces.join()}`);
    expect(other(final)).toEqual(other(index));
  });

  it('refuses a contradictory size range and an empty selection', () => {
    expect(
      run({ provincesPerState: { min: 9, target: 5, max: 3 } }).blockers.map(({ code }) => code),
    ).toEqual(['MAP_TERRITORY_STATE_SIZE_INVALID']);
    expect(run({ countries: ['ZZZ'] }).blockers.map(({ code }) => code)).toEqual([
      'MAP_TERRITORY_NOTHING_TO_REPARTITION',
    ]);
    expect(run({ stateIds: [99_999] }).blockers.map(({ code }) => code)).toEqual([
      'MAP_TERRITORY_STATE_UNKNOWN',
    ]);
  });
});

describe('update_states', () => {
  it('equals the same updates one at a time and refuses a repeated state', () => {
    const picks = index.states.slice(0, 40);
    const updates = picks.map((state, position) => ({
      stateId: state.id,
      changes: {
        owner: TAGS[position % 4]!,
        controller: TAGS[position % 4]!,
        cores: [TAGS[position % 4]!],
      },
    }));
    const bulk = plan(index, [{ id: 'bulk', kind: 'update_states', updates }]);
    const single = plan(
      index,
      updates.map(({ stateId, changes }) => ({
        id: `one-${stateId}`,
        kind: 'update_state',
        stateId,
        changes,
      })),
    );
    expect(bulk.blockers).toEqual([]);
    const content = (result: typeof bulk) =>
      new Map(
        result.changes.map(({ relativePath, content }) => [
          relativePath,
          Buffer.from(content ?? []).toString(),
        ]),
      );
    expect(content(bulk)).toEqual(content(single));
    const repeated = plan(index, [
      { id: 'bulk', kind: 'update_states', updates: [updates[0]!, updates[0]!] },
    ]);
    expect(repeated.blockers.map(({ code }) => code)).toEqual(['MAP_UPDATE_STATES_DUPLICATE']);
    const unknown = plan(index, [
      {
        id: 'bulk',
        kind: 'update_states',
        updates: [updates[0]!, { stateId: 99_999, changes: { owner: 'EEA' } }],
      },
    ]);
    expect(unknown.blockers.map(({ code }) => code)).toEqual(['MAP_STATE_NOT_FOUND']);
    expect(unknown.changes).toEqual([]);
  });
});

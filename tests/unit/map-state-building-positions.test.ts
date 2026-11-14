import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import {
  generatedWorld,
  plan,
  removeTerritoryWorkspaces,
  spreadStates,
} from '../helpers/map-territory-world.js';

let index: MapWorkspaceIndex;
let seeds: number[];

beforeAll(async () => {
  const world = await generatedWorld();
  index = world.index;
  seeds = spreadStates(index, 3);
}, 120_000);
afterAll(removeTerritoryWorkspaces);

/** Building types every state of the generated world has: the state-level ones. */
function stateLevelBuildings(on: MapWorkspaceIndex): Set<string> {
  const byState = new Map<number, Set<string>>();
  for (const { stateId, building } of on.buildingPositions) {
    const set = byState.get(stateId) ?? new Set<string>();
    set.add(building);
    byState.set(stateId, set);
  }
  const sets = on.states.map(({ id }) => byState.get(id) ?? new Set<string>());
  return new Set([...(sets[0] ?? [])].filter((building) => sets.every((set) => set.has(building))));
}

/** States of an index that lack one of the given building types, with what they lack. */
function lacking(on: MapWorkspaceIndex, wanted: ReadonlySet<string>): Record<number, string[]> {
  const byState = new Map<number, Set<string>>();
  for (const { stateId, building } of on.buildingPositions) {
    const set = byState.get(stateId) ?? new Set<string>();
    set.add(building);
    byState.set(stateId, set);
  }
  const result: Record<number, string[]> = {};
  for (const { id } of on.states) {
    const missing = [...wanted].filter((building) => !byState.get(id)?.has(building));
    if (missing.length > 0) result[id] = missing.sort();
  }
  return result;
}

describe('state building positions after state changes (issue 193)', () => {
  // ZIN K128, 14 November 2026: 65 created and 74 reshaped states had no air base, rocket site or
  // gun emplacement line, and the game reported each one.
  it('gives a created state every state-level building line', () => {
    const wanted = stateLevelBuildings(index);
    expect(wanted.size).toBeGreaterThan(3);
    const source = index.states.find(({ provinces }) => provinces.length > 2)!;
    const result = plan(index, [
      {
        id: 'carve',
        kind: 'create_state',
        sourceStateId: source.id,
        provinceIds: [source.provinces.find((id) => id !== source.capital)!],
        name: 'CARVED',
        localisation: {
          method: 'upsert',
          language: 'l_english',
          value: 'Carved',
          file: 'localisation/english/world_l_english.yml',
        },
      },
    ]);
    expect(result.blockers).toEqual([]);
    expect(lacking(result.finalIndex, wanted)).toEqual({});
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'MAP_STATE_BUILDING_POSITIONS_ADDED',
    );
  });

  it('gives the states of a province-unit regrouping every state-level building line', () => {
    const wanted = stateLevelBuildings(index);
    const result = plan(index, [
      {
        id: 'territory',
        kind: 'assign_territory',
        unit: 'province',
        stateSize: { min: 2, max: 4 },
        countries: seeds.map((state, position) => ({
          tag: ['AAA', 'BBB', 'CCC'][position]!,
          seeds: [{ state }],
        })),
        seed: 3,
        borderQuality: 'off',
      },
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.finalIndex.states.length).not.toBe(index.states.length);
    expect(lacking(result.finalIndex, wanted)).toEqual({});
  });

  it('adds nothing when no state changed', () => {
    const state = index.states[0]!;
    const result = plan(index, [
      { id: 'pop', kind: 'update_state', stateId: state.id, changes: { manpower: 1234 } },
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'MAP_STATE_BUILDING_POSITIONS_ADDED',
    );
    expect(result.changes.some(({ relativePath }) => relativePath.endsWith('buildings.txt'))).toBe(
      false,
    );
  });
});

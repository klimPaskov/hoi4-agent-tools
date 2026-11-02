import { expect, it } from 'vitest';
import { compactMapSemanticDiff } from '../../src/hoi4_agent_tools/map/tool-operations.js';
import {
  boundedPositionDiffs,
  MAP_DIFF_POSITION_RECORD_LIMIT,
  type MapSemanticDiff,
} from '../../src/hoi4_agent_tools/map/render.js';

it('bounds the aggregate world diff while retaining full counts and truncation evidence', () => {
  const records = Array.from({ length: 100 }, (_, i) => ({
    key: String(i),
    before: 'a'.repeat(600),
    after: 'b'.repeat(600),
  }));
  const semantic: MapSemanticDiff = {
    definitions: records.map((r, id) => ({ ...r, id })),
    stateMembership: [],
    regionMembership: [],
    states: records,
    ports: records,
    buildingPositions: records,
    unitPositions: records,
    weatherPositions: records,
    entityLocators: records,
    supplyNodes: records,
    railways: records,
    adjacencies: records,
    normalAdjacencies: records,
    supplyNodesChanged: true,
    railwaysChanged: true,
    adjacenciesChanged: true,
    normalAdjacenciesChanged: true,
  };
  const compact = compactMapSemanticDiff(semantic);
  expect(Buffer.byteLength(JSON.stringify(compact.semantic))).toBeLessThanOrEqual(8192);
  expect(compact.counts.definitions).toBe(100);
  expect(compact.counts.states).toBe(100);
  expect(compact.truncated).toBe(true);
  expect(semantic.states).toHaveLength(100);
});

it('lists at most the position-change limit per kind in the review artifact and counts the rest', () => {
  const records = (length: number) =>
    Array.from({ length }, (_, index) => ({ key: `1:0:${index}`, before: 'a', after: 'b' }));
  const semantic: MapSemanticDiff = {
    definitions: [],
    stateMembership: [],
    regionMembership: [],
    states: records(3),
    ports: [],
    buildingPositions: records(MAP_DIFF_POSITION_RECORD_LIMIT),
    unitPositions: records(MAP_DIFF_POSITION_RECORD_LIMIT + 500),
    weatherPositions: records(MAP_DIFF_POSITION_RECORD_LIMIT + 1),
    entityLocators: [],
    supplyNodes: [],
    railways: [],
    adjacencies: [],
    normalAdjacencies: [],
    supplyNodesChanged: false,
    railwaysChanged: false,
    adjacenciesChanged: false,
    normalAdjacenciesChanged: false,
  };
  const bounded = boundedPositionDiffs(semantic);
  expect(bounded.semantic.unitPositions).toHaveLength(MAP_DIFF_POSITION_RECORD_LIMIT);
  expect(bounded.semantic.weatherPositions).toHaveLength(MAP_DIFF_POSITION_RECORD_LIMIT);
  expect(bounded.semantic.buildingPositions).toBe(semantic.buildingPositions);
  expect(bounded.semantic.states).toBe(semantic.states);
  expect(bounded.positionChanges).toEqual({
    unitPositions: {
      total: MAP_DIFF_POSITION_RECORD_LIMIT + 500,
      listed: MAP_DIFF_POSITION_RECORD_LIMIT,
    },
    weatherPositions: {
      total: MAP_DIFF_POSITION_RECORD_LIMIT + 1,
      listed: MAP_DIFF_POSITION_RECORD_LIMIT,
    },
  });
  // The full diff stays untouched for the inline summary.
  expect(semantic.unitPositions).toHaveLength(MAP_DIFF_POSITION_RECORD_LIMIT + 500);
  expect(boundedPositionDiffs({ ...semantic, unitPositions: [], weatherPositions: [] })).toEqual({
    semantic: { ...semantic, unitPositions: [], weatherPositions: [] },
  });
});

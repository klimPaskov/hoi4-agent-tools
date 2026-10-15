import { expect, it } from 'vitest';
import { compactMapSemanticDiff } from '../../src/hoi4_agent_tools/map/tool-operations.js';
import type { MapSemanticDiff } from '../../src/hoi4_agent_tools/map/render.js';

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

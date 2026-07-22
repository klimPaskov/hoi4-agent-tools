import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  customWeightedPoolManifestSchema,
  probabilityScenarioSetSchema,
  probabilitySequenceInputSchema,
  probabilitySimulateInputSchema,
  probabilitySweepInputSchema,
} from '../../src/hoi4_agent_tools/schemas/probability.js';

const root = path.resolve(import.meta.dirname, '../..', 'examples', 'probability');

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, name), 'utf8')) as unknown;
}

describe('published probability examples', () => {
  it('matches the callable MCP argument and manifest schemas', async () => {
    const cases = [
      [probabilityScenarioSetSchema, 'event-mtth-scenarios.json'],
      [probabilityScenarioSetSchema, 'focus-route-scenarios.json'],
      [customWeightedPoolManifestSchema, 'adaptive-event-pool.json'],
      [probabilitySimulateInputSchema, 'event-mtth-simulate-input.json'],
      [probabilitySweepInputSchema, 'focus-route-sweep-input.json'],
      [probabilitySequenceInputSchema, 'adaptive-event-sequence-input.json'],
    ] as const;

    for (const [schema, name] of cases) {
      const result = schema.safeParse(await json(name));
      expect(result.success, `${name}: ${result.error?.message ?? ''}`).toBe(true);
    }
  });
});

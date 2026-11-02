import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  measureOrthogonalConnectors,
  orthogonalConnector,
} from '../../src/hoi4_agent_tools/focus/quality/orthogonal.js';
import { qualityGraphOf, type FixtureFocus } from '../helpers/focus-quality-fixture.js';

interface ParityCounts {
  crossings: number;
  stemsThroughPlaques: number;
  mergedBars: number;
}

interface ParityCase {
  name: string;
  focuses: FixtureFocus[];
  expected: ParityCounts;
  old: ParityCounts;
}

// The same file is checked by the Rust engine (engine/crates/focus/tests/connector_parity.rs), so
// the TypeScript and Rust connector models must give the same counts.
const vector = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      'engine',
      'crates',
      'focus',
      'tests',
      'fixtures',
      'connector-parity.json',
    ),
    'utf8',
  ),
) as { cases: ParityCase[] };

describe('connector model parity vector', () => {
  it.each(vector.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const measurement = measureOrthogonalConnectors(qualityGraphOf(entry.focuses));
    expect(measurement.notEvaluated).toBeUndefined();
    expect({
      crossings: measurement.crossings.length,
      stemsThroughPlaques: measurement.stemsThroughPlaques.length,
      mergedBars: measurement.mergedBars.length,
    }).toEqual(entry.expected);
  });

  it('includes multi-row cases where the earlier model counted differently', () => {
    const differing = vector.cases.filter(
      (entry) => JSON.stringify(entry.expected) !== JSON.stringify(entry.old),
    );
    expect(differing.length).toBeGreaterThanOrEqual(3);
    for (const entry of differing) {
      const rows = entry.focuses.map(({ y }) => y);
      expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThanOrEqual(2);
    }
  });

  it('places the bar just under the parent and the long vertical in the child column', () => {
    const connector = orthogonalConnector({ id: 'p', x: 0, y: 0 }, { id: 'c', x: 2, y: 3 });
    expect(connector.stemFrom).toBeCloseTo(0.14, 10);
    expect(connector.barY).toBeCloseTo(0.28, 10);
    expect(connector.dropTo).toBeCloseTo(2.34, 10);
    expect([connector.barFrom, connector.barTo]).toEqual([0, 2]);
  });

  it('names the plaque the child vertical passes, not one in the parent column', () => {
    const measurement = measureOrthogonalConnectors(
      qualityGraphOf([
        { id: 'top', x: 0, y: 0 },
        { id: 'left', x: 0, y: 1 },
        { id: 'right', x: 2, y: 1 },
        { id: 'bottom', x: 2, y: 2, needs: ['top'] },
      ]),
    );
    expect(measurement.stemsThroughPlaques).toEqual([{ edgeIndex: 0, focusId: 'right' }]);
  });
});

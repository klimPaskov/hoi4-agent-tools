import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { analyzeTechnologySource } from '../../src/hoi4_agent_tools/technology/source-analysis.js';

function technologyFile(layout: string | undefined): ScannedFile {
  const field = layout === undefined ? '' : `\t\tforce_use_small_tech_layout = ${layout}\n`;
  const bytes = Buffer.from(
    `technologies = {\n\tsynthetic_tech = {\n\t\tresearch_cost = 1\n${field}\t}\n}\n`,
  );
  return {
    absolutePath: '/synthetic/common/technologies/synthetic.txt',
    displayPath: 'common/technologies/synthetic.txt',
    relativePath: 'common/technologies/synthetic.txt',
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function layoutFindings(layout: string | undefined) {
  const fragment = analyzeTechnologySource(technologyFile(layout), { helperIds: new Set() });
  const technology = fragment.technologies.find(({ id }) => id === 'synthetic_tech');
  expect(technology).toBeDefined();
  return technology!.unsupportedFields.filter(
    ({ field }) => field === 'force_use_small_tech_layout',
  );
}

describe('technology layout size', () => {
  it.each([
    ['no field', undefined],
    ['a literal yes', 'yes'],
    ['a literal no', 'no'],
  ])('reports nothing unsupported for %s', (_name, layout) => {
    expect(layoutFindings(layout)).toEqual([]);
  });

  it('reports an expression that is not a literal yes or no', () => {
    expect(layoutFindings('@small_layout')).toEqual([
      expect.objectContaining({
        field: 'force_use_small_tech_layout',
        expression: '@small_layout',
        reason: 'The technology layout-size expression is not a literal yes or no',
      }),
    ]);
  });
});

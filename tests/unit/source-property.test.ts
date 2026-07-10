import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyReplacements,
  assignments,
  parseClausewitz,
  serializeUnchanged,
} from '../../src/hoi4_agent_tools/core/source/index.js';

const identifier = fc.stringMatching(/^[a-z][a-z0-9_]{0,16}$/u);
const atom = fc.stringMatching(/^[A-Za-z0-9_@.:-]{1,24}$/u);

describe('lossless source model properties', () => {
  it('round-trips arbitrary safe unknown fields, duplicate keys, comments, BOMs, and newlines byte-for-byte', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: identifier,
            value: atom,
            nested: fc.boolean(),
            comment: fc.boolean(),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.constantFrom('\n', '\r\n'),
        fc.boolean(),
        (entries, newline, bom) => {
          const rows = entries.map(({ key, value, nested, comment }) => {
            const assignment = nested ? `${key} = { raw = ${value} }` : `${key} = ${value}`;
            return `\t${assignment}${comment ? ' # preserved' : ''}`;
          });
          const source = Buffer.from(
            `${bom ? '\ufeff' : ''}# generated property case${newline}root = {${newline}${rows.join(newline)}${newline}}${newline}`,
            'utf8',
          );
          const document = parseClausewitz(source, 'fixture:property.txt');
          expect(document.diagnostics).toEqual([]);
          expect(serializeUnchanged(document)).toEqual(source);
          for (const token of document.tokens) {
            expect(token.start).toBeLessThanOrEqual(token.end);
            expect(token.line).toBeGreaterThan(0);
            expect(token.column).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('changes only the selected scalar range', () => {
    fc.assert(
      fc.property(atom, atom, atom, (before, after, neighbor) => {
        const source = Buffer.from(
          `root = { value = ${before} neighbor = ${neighbor} # keep\r\n}\r\n`,
        );
        const document = parseClausewitz(source, 'fixture:rewrite.txt');
        const root = assignments(document.root, 'root')[0];
        if (root?.value.type !== 'block') return false;
        const value = assignments(root.value, 'value')[0]?.value;
        if (value === undefined) return false;
        const output = applyReplacements(document, [
          { start: value.start, end: value.end, text: after, description: 'property rewrite' },
        ]);
        const expected = Buffer.concat([
          source.subarray(0, value.start),
          Buffer.from(after),
          source.subarray(value.end),
        ]);
        expect(output).toEqual(expected);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

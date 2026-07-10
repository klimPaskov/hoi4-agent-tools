import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  canonicalJson,
  canonicalize,
  compareCodeUnits,
  sha256Bytes,
} from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  hasBlockingDiagnostics,
  sortDiagnostics,
} from '../../src/hoi4_agent_tools/core/diagnostics.js';
import { binaryDiff } from '../../src/hoi4_agent_tools/core/diff.js';
import {
  DETERMINISTIC_TOOL_FONT_HASH,
  DeterministicSvgTextRenderer,
} from '../../src/hoi4_agent_tools/core/svg-text.js';

describe('core utility edge behavior', () => {
  it('normalizes negative zero and rejects unsupported canonical JSON values', () => {
    expect(canonicalize(-0)).toBe(0);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrowError(/non-finite/iu);
    expect(() => canonicalize(Symbol('unsupported'))).toThrowError(/symbol/iu);
  });

  it('orders canonically distinct Unicode keys independently of insertion order', () => {
    const first = { 'e\u0301': 'decomposed', é: 'composed' };
    const reversed = Object.fromEntries(Object.entries(first).reverse());
    expect(canonicalJson(first)).toBe(canonicalJson(reversed));
  });

  it('totally orders canonically equivalent but distinct Unicode source paths', () => {
    const decomposed = 'common/national_focus/cafe\u0301.txt';
    const composed = 'common/national_focus/caf\u00e9.txt';
    expect(compareCodeUnits(decomposed, composed)).toBeLessThan(0);
    expect(compareCodeUnits(composed, decomposed)).toBeGreaterThan(0);

    const sorted = sortDiagnostics([
      {
        code: 'FOCUS_COMPOSED',
        severity: 'warning',
        category: 'reference',
        message: 'Composed path',
        location: {
          path: composed,
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
      },
      {
        code: 'FOCUS_DECOMPOSED',
        severity: 'warning',
        category: 'reference',
        message: 'Decomposed path',
        location: {
          path: decomposed,
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
      },
    ]);
    expect(sorted.map((diagnostic) => diagnostic.location?.path)).toEqual([decomposed, composed]);
  });

  it('recognizes blocker diagnostics and reports unchanged binary buffers', () => {
    expect(
      hasBlockingDiagnostics([
        {
          code: 'BLOCKED',
          severity: 'blocker',
          category: 'security',
          message: 'Operation blocked',
        },
      ]),
    ).toBe(true);
    expect(binaryDiff(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toEqual({
      oldSize: 2,
      newSize: 2,
      changedBytes: 0,
    });
  });

  it('rasterizes pinned project-font glyph paths to a portable byte golden', async () => {
    const renderer = new DeterministicSvgTextRenderer();
    const label = renderer.render('Agent 42 \u00b7 \u0391\u0411', {
      x: 12,
      y: 45,
      fontSize: 28,
      weight: 700,
      fill: '#f5f2e8',
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64"><defs>${renderer.definitions()}</defs><rect width="240" height="64" fill="#17202a"/>${label}</svg>`;
    expect(svg).not.toMatch(/<text\b|font-family=/u);
    expect(svg).toContain(`data-font-sha256="${DETERMINISTIC_TOOL_FONT_HASH}"`);
    const rasterize = async (): Promise<Buffer> =>
      sharp(Buffer.from(svg, 'utf8'))
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer();
    const first = await rasterize();
    const second = await rasterize();
    expect(second.equals(first)).toBe(true);
    expect(sha256Bytes(first)).toBe(
      '84c31ef9c0c18106bdebe6d418f1ef49d3f7cf60854c99d9dd801429c5635095',
    );
  });
});

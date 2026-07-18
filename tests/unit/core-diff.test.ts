import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { unifiedTextDiff } from '../../src/hoi4_agent_tools/core/diff.js';
import { comparePngImages } from '../../src/hoi4_agent_tools/core/image-diff.js';

describe('shared source diffs', () => {
  function expectTransforms(oldLines: string[], newLines: string[]): void {
    const diff = unifiedTextDiff(
      oldLines.length === 0 ? '' : `${oldLines.join('\n')}\n`,
      newLines.length === 0 ? '' : `${newLines.join('\n')}\n`,
      'a/file.txt',
      'b/file.txt',
      { maxMatrixCells: 1 },
    );
    const rows = diff.split('\n').slice(3);
    const rebuilt: string[] = [];
    let oldIndex = 0;
    for (const row of rows) {
      const marker = row[0];
      const content = row.slice(1);
      if (marker === ' ' || marker === '-') {
        expect(content).toBe(oldLines[oldIndex]);
        oldIndex += 1;
      }
      if (marker === ' ' || marker === '+') rebuilt.push(content);
    }
    expect(oldIndex).toBe(oldLines.length);
    expect(rebuilt).toEqual(newLines);
  }

  it('reports exact line counts without phantom trailing lines', () => {
    expect(unifiedTextDiff('', 'line\n', 'a/file.txt', 'b/file.txt')).toBe(
      ['--- a/file.txt', '+++ b/file.txt', '@@ -1,0 +1,1 @@', '+line'].join('\n'),
    );
    expect(unifiedTextDiff('old\r\n', 'new\r\n', 'a/file.txt', 'b/file.txt')).toContain(
      '@@ -1,1 +1,1 @@',
    );
  });

  it('handles CR-only source deterministically', () => {
    const first = unifiedTextDiff('one\rtwo\r', 'one\rthree\r', 'a/file.txt', 'b/file.txt');
    const second = unifiedTextDiff('one\rtwo\r', 'one\rthree\r', 'a/file.txt', 'b/file.txt');
    expect(first).toBe(second);
    expect(first).toContain(' one');
    expect(first).toContain('-two');
    expect(first).toContain('+three');
  });

  it('uses a deterministic exact patience diff above the matrix threshold and honors cancellation', () => {
    const oldText = `${Array.from({ length: 20_000 }, (_unused, index) => `line-${index}`).join('\n')}\n`;
    const newText = oldText.replace('line-5000\n', 'line-5000-updated\n');
    const first = unifiedTextDiff(oldText, newText, 'a/file.txt', 'b/file.txt', {
      maxMatrixCells: 4,
    });
    const second = unifiedTextDiff(oldText, newText, 'a/file.txt', 'b/file.txt', {
      maxMatrixCells: 4,
    });
    expect(first).toBe(second);
    expect(first).toContain('-line-5000');
    expect(first).toContain('+line-5000-updated');
    expect(first).toContain(' line-19999');

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      unifiedTextDiff('old\n', 'new\n', 'a/file.txt', 'b/file.txt', {
        signal: controller.signal,
      }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
  });

  it('reconstructs exact target lines across duplicate-heavy large diff partitions', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const oldLines = Array.from(
        { length: 80 + (seed % 17) },
        (_unused, index) => `token-${(index * 7 + seed) % 23}`,
      );
      const newLines = oldLines
        .filter((_line, index) => (index + seed) % 11 !== 0)
        .flatMap((line, index) =>
          (index * 5 + seed) % 13 === 0 ? [line, `insert-${seed}-${index}`] : [line],
        );
      if (seed % 3 === 0) newLines.reverse();
      expectTransforms(oldLines, newLines);
    }
  });
});

describe('shared bitmap diffs', () => {
  it('yields to the event loop and observes cancellation during exact pixel comparison', async () => {
    const image = await sharp({
      create: {
        width: 1_024,
        height: 1_024,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 1 },
      },
    })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const controller = new AbortController();
    let polls = 0;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'throwIfAborted') {
          return () => {
            polls += 1;
            if (polls === 3) setTimeout(() => controller.abort(), 0);
            target.throwIfAborted();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(comparePngImages(image, image, 8, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(polls).toBeGreaterThan(3);
  });
});

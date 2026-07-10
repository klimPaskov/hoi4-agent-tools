import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { unifiedTextDiff } from '../../src/hoi4_agent_tools/core/diff.js';
import { comparePngImages } from '../../src/hoi4_agent_tools/core/image-diff.js';

describe('shared source diffs', () => {
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

  it('refuses an exact diff above its memory bound and honors cancellation', () => {
    expect(() =>
      unifiedTextDiff('one\ntwo\n', 'three\nfour\n', 'a/file.txt', 'b/file.txt', {
        maxMatrixCells: 4,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DIFF_COMPLEXITY_LIMIT' }));

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      unifiedTextDiff('old\n', 'new\n', 'a/file.txt', 'b/file.txt', {
        signal: controller.signal,
      }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
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

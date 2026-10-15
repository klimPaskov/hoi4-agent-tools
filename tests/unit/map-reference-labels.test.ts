import sharp from 'sharp';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { DeterministicSvgTextRenderer } from '../../src/hoi4_agent_tools/core/svg-text.js';
import {
  extractReferenceLabels,
  parseReferenceLabelTsv,
} from '../../src/hoi4_agent_tools/map/reference-labels.js';

const header =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (text: string, confidence = 95, left = 100, line = 1): string =>
  `5\t1\t1\t1\t${line}\t1\t${left}\t100\t80\t20\t${confidence}\t${text}`;

describe('reference image labels', () => {
  it('groups nearby words and normalizes label centres, sorting by image position', () => {
    const result = parseReferenceLabelTsv(
      [header, word('North'), word('Harbor', 97, 190), word('Aurora', 96, 400, 2)].join('\n'),
      1000,
      500,
    );
    expect(result.warnings).toEqual([]);
    expect(result.labels).toEqual([
      { text: 'North Harbor', confidence: 96, x: 0.185, y: 0.22, width: 0.17, height: 0.04 },
      { text: 'Aurora', confidence: 96, x: 0.44, y: 0.22, width: 0.08, height: 0.04 },
    ]);
  });

  it('does not merge distinct distant city labels on the same OCR line', () => {
    expect(
      parseReferenceLabelTsv(
        [header, word('Aurora'), word('Brindle', 95, 500)].join('\n'),
        1000,
        500,
      ).labels.map((label) => label.text),
    ).toEqual(['Aurora', 'Brindle']);
  });

  it('suppresses uncertain, malformed, numeric and out-of-bounds text with warnings', () => {
    const result = parseReferenceLabelTsv(
      [
        header,
        word('Guess', 20),
        word('123', 98),
        word('Outside', 98, 980),
        word('NaN', Number.NaN),
        word('<script>', 99),
      ].join('\n'),
      1000,
      500,
    );
    expect(result.labels).toEqual([]);
    expect(result.warnings.join(' ')).toContain('omitted');
    expect(result.warnings.join(' ')).toContain('No reliable English labels');
  });

  it('bounds engine output and invalid dimensions', () => {
    expect(parseReferenceLabelTsv('x'.repeat(2 * 1024 * 1024 + 1), 100, 100).labels).toEqual([]);
    expect(parseReferenceLabelTsv(header, Number.NaN, 100).warnings).toContain(
      'Reference text output exceeded safe bounds.',
    );
  });

  it('does not turn the readable half of an uncertain multiword name into a new place', () => {
    expect(
      parseReferenceLabelTsv([header, word('North'), word('Harbor', 30, 190)].join('\n'), 1000, 500)
        .labels,
    ).toEqual([]);
  });

  it('rejects URL bytes and vector images without launching OCR', async () => {
    expect(
      (await extractReferenceLabels(Buffer.from('https://example.invalid/image.png'))).labels,
    ).toEqual([]);
    const result = await extractReferenceLabels(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'),
    );
    expect(result.warnings).toEqual([
      'Reference text recognition requires a supported raster image.',
    ]);
  });

  it('terminates stalled initialization and bounds concurrent worker allocation', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    let started: (() => void) | undefined;
    const firstPacket = new Promise<void>((resolve) => {
      started = resolve;
    });
    const messages = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => {
      started?.();
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = extractReferenceLabels(png);
      const firstFailure = expect(first).rejects.toMatchObject({
        code: 'MAP_REFERENCE_OCR_TIMEOUT',
        details: { retryable: true },
      });
      await expect(extractReferenceLabels(png)).rejects.toMatchObject({
        code: 'MAP_REFERENCE_OCR_BUSY',
        details: { retryable: true },
      });
      await firstPacket;
      await vi.advanceTimersByTimeAsync(30_001);
      await firstFailure;
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      messages.mockRestore();
      terminate.mockRestore();
    }
  });

  it('refuses failed initialization, terminates its worker, and permits a later successful unreadable image', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    let fail = true;
    const messages = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      raw: unknown,
    ) {
      const packet = raw as { jobId: string; action: string };
      queueMicrotask(() =>
        this.emit('message', {
          jobId: packet.jobId,
          status: fail ? 'reject' : 'resolve',
          data: fail
            ? 'Private OCR failure details'
            : packet.action === 'recognize'
              ? { tsv: header }
              : {},
        }),
      );
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      await expect(extractReferenceLabels(png)).rejects.toMatchObject({
        code: 'MAP_REFERENCE_OCR_UNAVAILABLE',
        details: { retryable: true },
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      fail = false;
      const unreadable = await extractReferenceLabels(png);
      expect(unreadable.labels).toEqual([]);
      expect(unreadable.warnings).toContain(
        'No reliable English labels were readable in the reference image.',
      );
      expect(terminate).toHaveBeenCalledTimes(2);
    } finally {
      messages.mockRestore();
      terminate.mockRestore();
    }
  });

  it('refuses worker crashes and terminates their threads without exposing engine details', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const messages = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
    ) {
      queueMicrotask(() => this.emit('error', new Error('Private engine path and data')));
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      await expect(extractReferenceLabels(png)).rejects.toMatchObject({
        code: 'MAP_REFERENCE_OCR_UNAVAILABLE',
        details: { retryable: true },
      });
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      messages.mockRestore();
      terminate.mockRestore();
    }
  });

  it('recognizes original synthetic names offline with the pinned worker protocol', async () => {
    const renderer = new DeterministicSvgTextRenderer();
    const country = renderer.render('AURORA', { x: 150, y: 130, fontSize: 54, fill: '#111111' });
    const city = renderer.render('Brindle', { x: 470, y: 340, fontSize: 36, fill: '#111111' });
    const png = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><defs>${renderer.definitions()}</defs><rect width="900" height="500" fill="#f3e4be"/>${country}${city}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'));
    try {
      const result = await extractReferenceLabels(png);
      expect(result.labels.map((label) => label.text)).toEqual(['AURORA', 'Brindle']);
      expect(result.labels[0]!.x).toBeGreaterThan(0.15);
      expect(result.labels[0]!.x).toBeLessThan(0.5);
      expect(result.labels[1]!.y).toBeGreaterThan(0.55);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

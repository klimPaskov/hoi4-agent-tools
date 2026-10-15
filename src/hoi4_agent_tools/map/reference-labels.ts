/** Offline English OCR for reference artwork. No image paths, URLs, commands or model paths
 * are accepted from callers. The pinned Tesseract worker protocol is used directly because
 * its public createWorker promise hides the worker handle until initialization completes;
 * owning the thread from creation lets us terminate stalled initialization as well as OCR.
 * The synthetic integration test must pass before changing the pinned OCR dependencies.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { z } from 'zod';
import { compareCodeUnits } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';

export interface ReferenceLabel {
  text: string;
  /** Tesseract confidence, 0..100; it is evidence, not a correctness guarantee. */
  confidence: number;
  /** Centre and extent in normalized top-left image coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferenceLabelResult {
  labels: ReferenceLabel[];
  warnings: string[];
}

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_OCR_SIDE = 2560;
const MAX_LABELS = 512;
const MAX_TSV_BYTES = 2 * 1024 * 1024;
const OCR_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);
let active = false;

function hasRasterSignature(image: Buffer): boolean {
  return (
    image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    image.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii')) ||
    (image.subarray(0, 4).toString('ascii') === 'RIFF' &&
      image.subarray(8, 12).toString('ascii') === 'WEBP') ||
    image.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    image.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
  );
}

const packetSchema = z.object({
  jobId: z.string(),
  status: z.enum(['resolve', 'reject', 'progress']),
  data: z.unknown(),
});

interface OcrWord {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Validate and normalize the engine's TSV instead of trusting its untyped nested output. */
export function parseReferenceLabelTsv(
  tsv: string,
  width: number,
  height: number,
): ReferenceLabelResult {
  if (
    Buffer.byteLength(tsv) > MAX_TSV_BYTES ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { labels: [], warnings: ['Reference text output exceeded safe bounds.'] };
  }
  const lines = new Map<string, OcrWord[]>();
  const uncertainLines = new Set<string>();
  let rejected = 0;
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    if (!row.trim()) continue;
    const fields = row.split('\t');
    if (fields[0] !== '5') continue;
    const key = fields.slice(1, 5).join(':');
    const text = fields.slice(11).join(' ').normalize('NFC').trim();
    const [left, top, wordWidth, wordHeight, confidence] = fields.slice(6, 11).map(Number);
    if (
      fields.length < 12 ||
      !text ||
      left === undefined ||
      top === undefined ||
      wordWidth === undefined ||
      wordHeight === undefined ||
      confidence === undefined ||
      ![left, top, wordWidth, wordHeight, confidence].every(Number.isFinite) ||
      left < 0 ||
      top < 0 ||
      wordWidth <= 0 ||
      wordHeight <= 0 ||
      left + wordWidth > width ||
      top + wordHeight > height ||
      confidence < 70 ||
      confidence > 100 ||
      !/^[\p{L}\p{M}\d][\p{L}\p{M}\d.,'’()-]*$/u.test(text) ||
      text.length > 80
    ) {
      rejected++;
      uncertainLines.add(key);
      continue;
    }
    const group = lines.get(key) ?? [];
    group.push({ text, confidence, left, top, width: wordWidth, height: wordHeight });
    lines.set(key, group);
  }
  const labels: ReferenceLabel[] = [];
  for (const [key, words] of lines) {
    // A readable half of an uncertain multiword name is not a reliable place name.
    if (uncertainLines.has(key)) continue;
    words.sort((a, b) => a.left - b.left || a.top - b.top);
    const groups: OcrWord[][] = [];
    for (const word of words) {
      const group = groups.at(-1);
      const previous = group?.at(-1);
      if (
        !previous ||
        word.left - (previous.left + previous.width) > 2.5 * Math.max(previous.height, word.height)
      ) {
        groups.push([word]);
      } else group!.push(word);
    }
    for (const group of groups) {
      const text = group.map((word) => word.text).join(' ');
      const confidence = group.reduce((sum, word) => sum + word.confidence, 0) / group.length;
      if (confidence < 80 || text.length < 2 || text.length > 80 || !/[\p{L}]/u.test(text)) {
        rejected++;
        continue;
      }
      const left = Math.min(...group.map((word) => word.left));
      const top = Math.min(...group.map((word) => word.top));
      const right = Math.max(...group.map((word) => word.left + word.width));
      const bottom = Math.max(...group.map((word) => word.top + word.height));
      labels.push({
        text,
        confidence: Math.round(confidence * 100) / 100,
        x: (left + right) / (2 * width),
        y: (top + bottom) / (2 * height),
        width: (right - left) / width,
        height: (bottom - top) / height,
      });
    }
  }
  labels.sort((a, b) => a.y - b.y || a.x - b.x || compareCodeUnits(a.text, b.text));
  const warnings: string[] = [];
  if (rejected > 0)
    warnings.push(`${rejected} uncertain or invalid reference text fragment(s) were omitted.`);
  if (labels.length > MAX_LABELS) warnings.push('Reference text was limited to 512 labels.');
  if (labels.length === 0)
    warnings.push('No reliable English labels were readable in the reference image.');
  return { labels: labels.slice(0, MAX_LABELS), warnings };
}

/** One active OCR thread per process; contention is retryable instead of changing generated
 * names. No queue retains reference image bytes. Worker stdout is never forwarded.
 */
export async function extractReferenceLabels(image: Buffer): Promise<ReferenceLabelResult> {
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > MAX_BYTES) {
    return { labels: [], warnings: ['Reference text image exceeded safe byte bounds.'] };
  }
  if (!hasRasterSignature(image)) {
    return {
      labels: [],
      warnings: ['Reference text recognition requires a supported raster image.'],
    };
  }
  if (active)
    throw new ServiceError(
      'MAP_REFERENCE_OCR_BUSY',
      'Offline reference text recognition is busy; retry the request.',
      { retryable: true },
    );
  active = true;
  let worker: Worker | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const decoded = sharp(image, { limitInputPixels: MAX_PIXELS, animated: false });
    const metadata = await decoded.metadata();
    if (
      !['png', 'jpeg', 'webp', 'tiff', 'gif'].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height
    ) {
      return {
        labels: [],
        warnings: ['Reference text recognition requires a supported raster image.'],
      };
    }
    const { data: png, info } = await decoded
      .flatten({ background: '#ffffff' })
      .resize(MAX_OCR_SIDE, MAX_OCR_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    // Paths resolve only fixed, installed, shrinkwrap-pinned package resources. Missing model
    // data fails closed; we never let Tesseract choose its default remote language URL.
    const model = await readFile(
      require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
    );
    worker = new Worker(require.resolve('tesseract.js/src/worker-script/node/index.js'), {
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
      execArgv: [],
    });
    // Drain diagnostics without forwarding OCR input, recognized names, paths or stdout.
    worker.stdout.resume();
    worker.stderr.resume();
    const currentWorker = worker;
    let sequence = 0;
    let rejectPending: ((error: Error) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ServiceError(
              'MAP_REFERENCE_OCR_TIMEOUT',
              'Offline reference text recognition exceeded its time limit; retry the request.',
              { retryable: true },
            ),
          ),
        OCR_TIMEOUT_MS,
      );
    });
    currentWorker.on('error', () => rejectPending?.(new Error('OCR worker failed')));
    currentWorker.on('exit', () => rejectPending?.(new Error('OCR worker exited')));
    const send = (action: string, payload: Record<string, unknown>): Promise<unknown> => {
      const jobId = `reference-${sequence++}`;
      return new Promise((resolve, reject) => {
        rejectPending = reject;
        const receive = (raw: unknown): void => {
          const packet = packetSchema.safeParse(raw);
          if (!packet.success || packet.data.jobId !== jobId || packet.data.status === 'progress')
            return;
          currentWorker.off('message', receive);
          rejectPending = undefined;
          if (packet.data.status === 'reject') reject(new Error('OCR recognition failed'));
          else resolve(packet.data.data);
        };
        currentWorker.on('message', receive);
        currentWorker.postMessage({ workerId: 'reference-labels', jobId, action, payload });
      });
    };
    const recognize = async (): Promise<unknown> => {
      await send('load', { options: { lstmOnly: true, logging: false } });
      await send('loadLanguage', {
        langs: [{ code: 'eng', data: model }],
        options: { cacheMethod: 'none', gzip: true, lstmOnly: true },
      });
      await send('initialize', { langs: 'eng', oem: 1, config: {} });
      await send('setParameters', {
        params: { tessedit_pageseg_mode: '11', user_defined_dpi: '300' },
      });
      return send('recognize', { image: png, options: {}, output: { text: false, tsv: true } });
    };
    const result = await Promise.race([recognize(), timeout]);
    const output = z.object({ tsv: z.string().max(MAX_TSV_BYTES) }).safeParse(result);
    if (!output.success) throw new Error('Unsupported OCR output');
    return parseReferenceLabelTsv(output.data.tsv, info.width, info.height);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'MAP_REFERENCE_OCR_UNAVAILABLE',
      'Offline reference text recognition could not complete; verify the installed OCR dependencies and retry the request.',
      { retryable: true },
    );
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (worker) await worker.terminate();
    } finally {
      active = false;
    }
  }
}

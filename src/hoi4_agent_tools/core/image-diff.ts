import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { canonicalJson } from './canonical.js';
import { assertRenderDimensions, RenderBudget, RENDER_MAX_PIXELS } from './render-budget.js';
import { ServiceError } from './result.js';

export interface PngComparisonResult {
  width: number;
  height: number;
  changedPixels: number;
  changedRatio: number;
  png: Buffer;
  json: string;
}

const IMAGE_DIFF_YIELD_PIXELS = 65_536;

async function yieldImageDiff(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}

async function imageMetadata(png: Buffer, label: string): Promise<Metadata> {
  try {
    return await sharp(png, { limitInputPixels: RENDER_MAX_PIXELS }).metadata();
  } catch (error) {
    if (error instanceof Error && /pixel limit/iu.test(error.message)) {
      throw new ServiceError(
        'RENDER_PIXELS_BLOCKED',
        `${label} exceeds the fixed per-artifact pixel ceiling`,
        { label, maximumPixels: RENDER_MAX_PIXELS },
      );
    }
    throw error;
  }
}

async function normalizeImage(
  png: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  label: string,
): Promise<Buffer> {
  assertRenderDimensions(sourceWidth, sourceHeight, `${label} input`);
  assertRenderDimensions(width, height, `${label} normalized plane`);
  return sharp(png, { limitInputPixels: RENDER_MAX_PIXELS })
    .ensureAlpha()
    .extend({
      right: Math.max(0, width - sourceWidth),
      bottom: Math.max(0, height - sourceHeight),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer();
}

/** Deterministic transparent review baseline for a newly created renderable target. */
export async function createTransparentPng(
  width: number,
  height: number,
  label: string,
  budget = new RenderBudget(),
): Promise<Buffer> {
  assertRenderDimensions(width, height, label);
  budget.reserve(width, height, label);
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
    limitInputPixels: RENDER_MAX_PIXELS,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

/** Deterministic exact-channel PNG comparison shared by every workbench. */
export async function comparePngImages(
  leftPng: Buffer,
  rightPng: Buffer,
  threshold = 8,
  signal?: AbortSignal,
  budget = new RenderBudget(),
): Promise<PngComparisonResult> {
  signal?.throwIfAborted();
  const [leftMetadata, rightMetadata] = await Promise.all([
    imageMetadata(leftPng, 'left comparison PNG'),
    imageMetadata(rightPng, 'right comparison PNG'),
  ]);
  const leftWidth = leftMetadata.width;
  const leftHeight = leftMetadata.height;
  const rightWidth = rightMetadata.width;
  const rightHeight = rightMetadata.height;
  assertRenderDimensions(leftWidth, leftHeight, 'left comparison PNG');
  assertRenderDimensions(rightWidth, rightHeight, 'right comparison PNG');
  const width = Math.max(leftWidth, rightWidth);
  const height = Math.max(leftHeight, rightHeight);
  budget.reserve(width, height, 'left comparison normalized plane');
  budget.reserve(width, height, 'right comparison normalized plane');
  budget.reserve(width, height, 'comparison diff plane');
  const [left, right] = await Promise.all([
    normalizeImage(leftPng, leftWidth, leftHeight, width, height, 'left comparison PNG'),
    normalizeImage(rightPng, rightWidth, rightHeight, width, height, 'right comparison PNG'),
  ]);
  signal?.throwIfAborted();
  const output = Buffer.alloc(width * height * 4);
  let changedPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (pixel > 0 && pixel % IMAGE_DIFF_YIELD_PIXELS === 0) await yieldImageDiff(signal);
    const offset = pixel * 4;
    const delta = Math.max(
      Math.abs(left.readUInt8(offset) - right.readUInt8(offset)),
      Math.abs(left.readUInt8(offset + 1) - right.readUInt8(offset + 1)),
      Math.abs(left.readUInt8(offset + 2) - right.readUInt8(offset + 2)),
      Math.abs(left.readUInt8(offset + 3) - right.readUInt8(offset + 3)),
    );
    if (delta > threshold) {
      changedPixels += 1;
      output[offset] = 255;
      output[offset + 1] = 58;
      output[offset + 2] = 94;
      output[offset + 3] = 255;
    } else {
      const luminance = Math.round(
        (left.readUInt8(offset) + left.readUInt8(offset + 1) + left.readUInt8(offset + 2)) / 3,
      );
      output[offset] = luminance;
      output[offset + 1] = luminance;
      output[offset + 2] = luminance;
      output[offset + 3] = 96;
    }
  }
  assertRenderDimensions(width, height, 'comparison diff Sharp raster');
  const png = await sharp(output, {
    raw: { width, height, channels: 4 },
    limitInputPixels: RENDER_MAX_PIXELS,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  signal?.throwIfAborted();
  const changedRatio = changedPixels / (width * height);
  return {
    width,
    height,
    changedPixels,
    changedRatio,
    png,
    json: `${canonicalJson({
      offline: true,
      width,
      height,
      changedPixels,
      changedRatio,
      threshold,
    })}\n`,
  };
}

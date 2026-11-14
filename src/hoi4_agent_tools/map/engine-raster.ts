import { spawnSync } from 'node:child_process';
import { z } from 'zod/v4';
import { compareCodeUnits } from '../core/canonical.js';
import { locateEngineBinary } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { rgbKey, type BmpImage } from './bmp.js';
import type { ProvinceDefinition, ProvinceGeometry, ProvinceRaster } from './model.js';

/**
 * The province raster from the shared Rust engine (`hoi4-engine map-provinces`, ADR 0084): the
 * province of every pixel, each province's extent, the neighbour graph, seam-only pairs, colours
 * without a definition, coastal provinces and the geometry checks' parts, holes and thin runs.
 * The engine reproduces `buildProvinceRaster` and the TypeScript geometry checks exactly,
 * iteration order included; `scripts/map-raster-parity.ts` compares them on real maps.
 *
 * The call is synchronous because the map model is built in one synchronous pass. It sends the
 * decoded bitmap's bytes and pixel offsets and reads one frame back. A missing engine is
 * `ENGINE_UNAVAILABLE`; nothing falls back to TypeScript.
 */

export const MAP_PROVINCES_REQUEST_SCHEMA = 'hoi4-map-provinces-request/1';
const MAP_PROVINCES_TIMEOUT_MS = 120_000;
const RESPONSE_JSON_MAX_BYTES = 256 * 1024 * 1024;

const count = z.number().int().min(0);
const id = z.number().int();
const responseSchema = z
  .object({
    schema: z.literal('hoi4-map-provinces/1'),
    width: count,
    height: count,
    geometry: z.array(z.tuple([id, count, count, count, count, count, count, count])),
    adjacency: z.array(z.tuple([id, z.array(id)])),
    seamOnlyPairs: z.array(z.tuple([id, id])),
    unknownColors: z.array(z.tuple([count, count, count, count])),
    unknownColorCount: count,
    coastal: z.array(id),
    components: z.array(z.tuple([id, count])),
    holes: z.array(z.tuple([id, z.number().int()])),
    thin: z.array(id),
  })
  .strict();

const frameSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown(), payload: count }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.looseObject({ code: z.string(), message: z.string() }),
    })
    .strict(),
]);

function packed(key: string): number {
  const [r, g, b] = key.split(',').map(Number);
  return ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0);
}

export function engineProvinceRaster(
  bitmap: BmpImage,
  definitionsByColor: ReadonlyMap<string, ProvinceDefinition>,
  definitionsById: ReadonlyMap<number, ProvinceDefinition>,
): ProvinceRaster {
  const located = locateEngineBinary();
  if (!('path' in located))
    throw new ServiceError('ENGINE_UNAVAILABLE', located.message, { reason: located.reason });
  const header = `${JSON.stringify({
    schema: MAP_PROVINCES_REQUEST_SCHEMA,
    width: bitmap.width,
    height: bitmap.height,
    topDown: bitmap.topDown,
    bitsPerPixel: bitmap.bitsPerPixel,
    pixelOffset: bitmap.pixelOffset,
    rowStride: bitmap.rowStride,
    palette: bitmap.palette.map(({ r, g, b }) => [r, g, b]),
    colors: [...definitionsByColor].map(([key, definition]) => [packed(key), definition.id]),
    types: [...definitionsById].map(([provinceId, definition]) => [provinceId, definition.type]),
    payload: bitmap.bytes.length,
  })}\n`;
  const script = /\.(?:c|m)?js$/iu.test(located.path);
  const child = spawnSync(
    script ? process.execPath : located.path,
    script ? [located.path, 'map-provinces'] : ['map-provinces'],
    {
      input: Buffer.concat([Buffer.from(header, 'utf8'), bitmap.bytes]),
      maxBuffer: bitmap.width * bitmap.height * 4 + RESPONSE_JSON_MAX_BYTES,
      timeout: MAP_PROVINCES_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    },
  );
  const unavailable = (message: string): ServiceError =>
    new ServiceError('ENGINE_UNAVAILABLE', message, { reason: 'invalid_output' });
  if (child.error !== undefined)
    throw new ServiceError(
      'ENGINE_UNAVAILABLE',
      `hoi4-engine map-provinces: ${child.error.message}`,
      {
        reason: 'spawn_failed',
      },
    );
  const stdout = child.stdout;
  const newline = stdout.indexOf(0x0a);
  if (newline < 0)
    throw unavailable(
      `hoi4-engine map-provinces gave no answer (exit ${child.status ?? 'none'}): ${child.stderr.toString('utf8').slice(-300)}`,
    );
  const frame = frameSchema.safeParse(JSON.parse(stdout.subarray(0, newline).toString('utf8')));
  if (!frame.success) throw unavailable('hoi4-engine map-provinces answered an unknown frame');
  if (!frame.data.ok) {
    const { code, message, ...details } = frame.data.error;
    // The engine names a bad palette index the way BmpImage.rgbAt does.
    if (code === 'MAP_BMP_PALETTE_INDEX_INVALID') throw new ServiceError(code, message, details);
    throw new ServiceError('MAP_ENGINE_REQUEST_INVALID', message, { code });
  }
  const response = responseSchema.safeParse(frame.data.result);
  const payload = stdout.subarray(newline + 1);
  if (
    !response.success ||
    response.data.width !== bitmap.width ||
    response.data.height !== bitmap.height ||
    payload.length !== frame.data.payload ||
    payload.length !== bitmap.width * bitmap.height * 4
  )
    throw unavailable('hoi4-engine map-provinces answered out of shape');
  const result = response.data;
  // Copied so the ids are aligned, whatever offset the payload has in the output buffer.
  const provinceIds = new Int32Array(
    payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length),
  );
  const geometry = new Map<number, ProvinceGeometry>();
  for (const [provinceId, pixelCount, minX, minY, maxX, maxY, sumX, sumY] of result.geometry)
    geometry.set(provinceId, {
      id: provinceId,
      pixelCount,
      minX,
      minY,
      maxX,
      maxY,
      centerX: sumX / pixelCount,
      centerY: sumY / pixelCount,
    });
  const color = (rgb: number) => ({ r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff });
  return {
    width: result.width,
    height: result.height,
    provinceIds,
    adjacency: new Map(
      result.adjacency.map(([provinceId, others]) => [provinceId, new Set(others)]),
    ),
    seamOnlyPairs: new Set(result.seamOnlyPairs.map(([low, high]) => `${low}:${high}`)),
    geometry,
    unknownColors: result.unknownColors
      .map(([rgb, pixels, firstX, firstY]) => ({
        color: color(rgb),
        count: pixels,
        firstX,
        firstY,
      }))
      .sort((left, right) => compareCodeUnits(rgbKey(left.color), rgbKey(right.color))),
    unknownColorCount: result.unknownColorCount,
    coastalProvinceIds: new Set(result.coastal),
    topology: {
      components: new Map(result.components),
      holes: new Map(result.holes),
      thin: new Set(result.thin),
    },
  };
}

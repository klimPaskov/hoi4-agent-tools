import path from 'node:path';
import { z } from 'zod/v4';
import { afterAll, describe, expect, it } from 'vitest';
import { ResidentEngine } from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { callEngineOperation } from '../../src/hoi4_agent_tools/core/engine-operation.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  MAP_ENGINE_PAYLOAD_LIMIT,
  MAP_VALIDATE_OP,
  mapValidateAnswerSchema,
  mapValidateRequest,
} from '../../src/hoi4_agent_tools/map/engine-validation.js';
import type { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';

const sourceRoots = { map: ['map'], states: ['history/states'], localisation: ['localisation'] };

function file(relativePath: string, bytes: Buffer): ScannedFile {
  return {
    absolutePath: path.resolve('mod', relativePath),
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: 'a'.repeat(64),
    bytes,
  };
}

function index(files: ScannedFile[], statesById = new Map<number, unknown>()): MapWorkspaceIndex {
  return { sourceFiles: files, sourceRoots, statesById } as unknown as MapWorkspaceIndex;
}

describe('map.validate requests', () => {
  it('sends a scanned file as its path and checksum, and only a file held in memory as bytes', () => {
    const a = file('map/definition.csv', Buffer.from('0;0;0;0;land;false;unknown;0\n'));
    const b = {
      ...file('map/provinces.bmp', Buffer.from('BM')),
      absolutePath: 'virtual://map/provinces.bmp',
    };
    const baseline = index([], new Map([[3, {}]]));
    Object.assign(baseline, { provinceBitmap: { bytes: Buffer.from('old') } });
    const { body, payload } = mapValidateRequest(index([a, b]), {
      operationId: 'op-1',
      baseline,
      diagnosticLimit: 50_000,
    });
    expect(payload.toString()).toBe('BMold');
    expect(body.files).toEqual([
      {
        displayPath: 'mod:map/definition.csv',
        relativePath: 'map/definition.csv',
        rootKind: 'mod',
        loadOrder: 1,
        size: a.bytes.length,
        sha256: a.sha256,
        path: a.absolutePath,
      },
      expect.objectContaining({ displayPath: 'mod:map/provinces.bmp', length: 2 }),
    ]);
    expect((body.files as Record<string, unknown>[])[1]).not.toHaveProperty('path');
    expect(body.options).toEqual(
      expect.objectContaining({
        operationId: 'op-1',
        diagnosticLimit: 50_000,
        baseline: { stateIds: [3], provinceBitmapLength: 3 },
      }),
    );
  });

  it('refuses a map larger than one engine request instead of cutting it', () => {
    const huge = {
      ...file('map/provinces.bmp', Buffer.alloc(0)),
      absolutePath: 'virtual://map/provinces.bmp',
    };
    Object.defineProperty(huge, 'bytes', { value: { length: MAP_ENGINE_PAYLOAD_LIMIT + 1 } });
    expect(() => mapValidateRequest(index([huge]))).toThrowError(
      expect.objectContaining({ code: 'MAP_ENGINE_PAYLOAD_LIMIT' }),
    );
  });
});

/** 24-bit bottom-up bitmap of 64 x 64 pixel provinces, each with its own colour. */
function provinceGrid(width: number, height: number): { bitmap: Buffer; definitions: string } {
  const block = 64;
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + rowBytes * height, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(rowBytes * height, 34);
  const pixels = Buffer.alloc(rowBytes * height);
  const across = width / block;
  const colorOf = (id: number): [number, number, number] => [id & 255, (id >> 8) & 255, 1];
  for (let y = 0; y < height; y += 1) {
    const row = (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorOf(1 + Math.floor(y / block) * across + Math.floor(x / block));
      pixels[row + x * 3] = b;
      pixels[row + x * 3 + 1] = g;
      pixels[row + x * 3 + 2] = r;
    }
  }
  const lines = ['0;0;0;0;sea;false;ocean;0'];
  for (let id = 1; id <= across * (height / block); id += 1) {
    const [r, g, b] = colorOf(id);
    lines.push(`${id};${r};${g};${b};land;false;plains;1`);
  }
  return { bitmap: Buffer.concat([header, pixels]), definitions: `${lines.join('\n')}\n` };
}

describe('map.validate cancellation on the resident engine', () => {
  const engine = new ResidentEngine();
  afterAll(() => engine.close());

  it('answers a protocol cancellation promptly, delivers no late result and keeps the engine usable', async () => {
    const { bitmap, definitions } = provinceGrid(4096, 2048);
    const request = mapValidateRequest(
      index([
        {
          ...file('map/provinces.bmp', bitmap),
          absolutePath: 'virtual://map/provinces.bmp',
        },
        {
          ...file('map/definition.csv', Buffer.from(definitions)),
          absolutePath: 'virtual://map/definition.csv',
        },
      ]),
      {},
    );
    const validate = (signal?: AbortSignal) =>
      callEngineOperation({
        op: MAP_VALIDATE_OP,
        body: request.body,
        payload: request.payload,
        result: z.object({ format: z.literal('json') }).strict(),
        engine,
        options: { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) },
      });
    const answerOf = (payload: Buffer) =>
      mapValidateAnswerSchema.parse(JSON.parse(payload.toString('utf8')));

    // The uncancelled call is the reference, and it must take long enough to cancel in flight.
    const started = performance.now();
    const reference = answerOf((await validate()).payload);
    const referenceMs = performance.now() - started;
    expect(referenceMs).toBeGreaterThan(300);

    const controller = new AbortController();
    let delivered = false;
    const cancelled = validate(controller.signal).then(
      () => {
        delivered = true;
      },
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delivered).toBe(false);
    const abortedAt = performance.now();
    controller.abort(new Error('abort requested by the protocol'));
    const error = await cancelled;
    expect(performance.now() - abortedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/abort/u);

    // The same engine answers the next validation correctly, and the late answer of the
    // cancelled call was dropped rather than delivered.
    const next = answerOf((await validate()).payload);
    expect(next).toEqual(reference);
    expect(delivered).toBe(false);
  }, 180_000);
});

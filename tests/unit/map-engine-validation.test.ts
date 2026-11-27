import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  MAP_ENGINE_PAYLOAD_LIMIT,
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

import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  readReferenceImageSource,
  REFERENCE_SOURCE_MAX_BYTES,
  REFERENCE_WORKING_MAX_SIDE,
} from '../../src/hoi4_agent_tools/core/bounded-source.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  TransactionManager,
  readDependenciesFromScannedFiles,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import * as sourceScanner from '../../src/hoi4_agent_tools/core/scanner.js';
import { mapRewriteRequestSchema } from '../../src/hoi4_agent_tools/schemas/map-requests.js';

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-source-'));
  const mod = path.join(base, 'mod');
  await mkdir(path.join(mod, 'references'), { recursive: true });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'reference', name: 'Reference', root: mod }],
    }),
  );
  return { base, mod, resolver };
}

describe('reference image source authorization and provenance', () => {
  it('accepts an image-only world request and defaults preview and identity', () => {
    const request = mapRewriteRequestSchema.parse({
      operations: [{ kind: 'create_world', reference: { imagePath: 'references/world.png' } }],
      preview: true,
    });
    expect(request.operations[0]).toMatchObject({
      id: 'world',
      kind: 'create_world',
      reference: { imagePath: 'references/world.png' },
    });
    expect(request.preview).toBe(true);
    expect(request.workspaceId).toBe('current');
    expect(request.operations[0]).not.toHaveProperty('countries');
    expect(request.operations[0]).not.toHaveProperty('width');
    expect(request.operations[0]).not.toHaveProperty('provincesPerState');
    expect(request.operations[0]).not.toHaveProperty('landProvincesPerRegion');
    expect(request.operations[0]).not.toHaveProperty('seaProvincesPerRegion');
    expect(request.operations[0]).not.toHaveProperty('rivers');
  });

  it.each([
    '../world.png',
    'C:\\world.png',
    'https://example.com/world.png',
    'references/map.svg',
    'references/a.png:stream',
  ])('rejects unsafe public image path %s', (imagePath) => {
    expect(
      mapRewriteRequestSchema.safeParse({
        operations: [{ kind: 'create_world', reference: { imagePath } }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown controls and out-of-range normalized annotations', () => {
    expect(
      mapRewriteRequestSchema.safeParse({
        operations: [
          { kind: 'create_world', reference: { imagePath: 'map.png', relocations: [] } },
        ],
      }).success,
    ).toBe(false);
    expect(
      mapRewriteRequestSchema.safeParse({
        operations: [
          {
            kind: 'create_world',
            reference: { imagePath: 'map.png', cities: [{ name: 'City', x: 1.1, y: 0.5 }] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('reduces a large original while binding its original hash and leaving it unchanged', async () => {
    const { mod, resolver } = await setup();
    const original = await sharp({
      create: { width: 4096, height: 2048, channels: 3, background: '#235b89' },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(mod, 'references/world.png'), original);
    const loaded = await readReferenceImageSource(resolver, 'reference', 'references/world.png');
    expect(loaded.originalWidth).toBe(4096);
    expect(loaded.workingWidth).toBe(REFERENCE_WORKING_MAX_SIDE);
    expect(loaded.source.sha256).toBe(sha256Bytes(original));
    expect(loaded.source.size).toBe(original.length);
    expect(sha256Bytes(loaded.bytes)).not.toBe(loaded.source.sha256);
    expect(await readFile(path.join(mod, 'references/world.png'))).toEqual(original);
  });

  it('rejects traversal, an escaping directory junction and malformed images', async () => {
    const { base, mod, resolver } = await setup();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'world.png'), 'not an image');
    await symlink(
      outside,
      path.join(mod, 'references/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      readReferenceImageSource(resolver, 'reference', 'references/escape/world.png'),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FOUND_IN_ROOTS' });
    await expect(
      readReferenceImageSource(resolver, 'reference', '../outside/world.png'),
    ).rejects.toThrow();
    await expect(
      readReferenceImageSource(resolver, 'reference', 'references/escape/world.png', 'intruder'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
    await writeFile(path.join(mod, 'references/bad.png'), 'invalid raster');
    await expect(
      readReferenceImageSource(resolver, 'reference', 'references/bad.png'),
    ).rejects.toMatchObject({ code: 'REFERENCE_IMAGE_DECODE_FAILED' });
  });

  it('rejects oversized source before reading and honors cancellation', async () => {
    const { mod, resolver } = await setup();
    const largePath = path.join(mod, 'references/large.png');
    await writeFile(largePath, 'synthetic oversized source metadata');
    const originalPrepare = sourceScanner.prepareSource;
    const oversized = vi
      .spyOn(sourceScanner, 'prepareSource')
      .mockImplementationOnce(async (...args) => {
        const source = await originalPrepare(...args);
        Object.defineProperty(source.metadata, 'size', { value: REFERENCE_SOURCE_MAX_BYTES + 1 });
        return source;
      });
    try {
      await expect(
        readReferenceImageSource(resolver, 'reference', 'references/large.png'),
      ).rejects.toMatchObject({ code: 'SOURCE_BYTE_LIMIT' });
      const controller = new AbortController();
      controller.abort();
      await expect(
        readReferenceImageSource(
          resolver,
          'reference',
          'references/large.png',
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow();
    } finally {
      oversized.mockRestore();
    }
  });

  it('rejects a reference changed after hashing but before decoding completes', async () => {
    const { mod, resolver } = await setup();
    const original = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#235b89' },
    })
      .png()
      .toBuffer();
    const replacement = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#445566' },
    })
      .png()
      .toBuffer();
    const target = path.join(mod, 'references/world.png');
    await writeFile(target, original);
    const verifySource = sourceScanner.verifySource;
    const spy = vi
      .spyOn(sourceScanner, 'verifySource')
      .mockImplementationOnce(async (root, source) => {
        await writeFile(target, replacement);
        return verifySource(root, source);
      });
    try {
      await expect(
        readReferenceImageSource(resolver, 'reference', 'references/world.png'),
      ).rejects.toMatchObject({ code: 'SCAN_SOURCE_CHANGED' });
    } finally {
      spy.mockRestore();
    }
  });

  it('checks the original image hash before applying a transaction', async () => {
    const { mod, resolver } = await setup();
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#235b89' },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(mod, 'references/world.png'), image);
    const loaded = await readReferenceImageSource(resolver, 'reference', 'references/world.png');
    const manager = new TransactionManager(resolver);
    const validation = async () => ({
      diagnostics: [],
      checks: [{ id: 'source-test', passed: true, message: 'Synthetic check' }],
    });
    const planned = await manager.plan({
      workspaceId: 'reference',
      operationKind: 'reference-test',
      operations: [
        { id: 'world', kind: 'create_world', summary: 'Synthetic source test', data: {} },
      ],
      changes: [
        { relativePath: 'probe.txt', content: Buffer.from('after'), operationIds: ['world'] },
      ],
      readDependencies: readDependenciesFromScannedFiles([loaded.source]),
      validate: validation,
    });
    await writeFile(
      path.join(mod, 'references/world.png'),
      Buffer.concat([image, Buffer.from('changed')]),
    );
    await expect(
      manager.apply('reference', planned.transactionId, planned.planHash, {
        postValidate: validation,
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_SOURCE_STALE' });
    await expect(readFile(path.join(mod, 'probe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

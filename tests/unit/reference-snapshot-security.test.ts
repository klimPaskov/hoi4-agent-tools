import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  readReferenceImageSource,
  REFERENCE_SOURCE_MAX_BYTES,
} from '../../src/hoi4_agent_tools/core/bounded-source.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import * as sourceScanner from '../../src/hoi4_agent_tools/core/scanner.js';

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-snapshot-test-')),
    mod = path.join(base, 'mod'),
    state = path.join(base, 'state');
  await mkdir(path.join(mod, 'references'), { recursive: true });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: state,
      workspaces: [{ id: 'reference', name: 'Reference', root: mod }],
    }),
  );
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#235b89' } })
    .png()
    .toBuffer();
  await writeFile(path.join(mod, 'references/world.png'), image);
  return { base, mod, state, resolver, image };
}

async function snapshots(state: string) {
  return (await readdir(state)).filter((name) => name.includes('reference-snapshot-'));
}

describe('reference decode snapshots', () => {
  it('rejects disguised SVG bytes before entering the decoder stage', async () => {
    const { mod, state, resolver } = await setup();
    await writeFile(
      path.join(mod, 'references/world.png'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="file:///unrelated.png"/></svg>',
    );
    const spy = vi.spyOn(sourceScanner, 'verifySource');
    try {
      await expect(
        readReferenceImageSource(resolver, 'reference', 'references/world.png'),
      ).rejects.toMatchObject({ code: 'REFERENCE_IMAGE_DECODE_FAILED' });
      expect(spy).not.toHaveBeenCalled();
      expect(await snapshots(state)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  it('preserves transparent borders for the extractor ocean-background policy', async () => {
    const { mod, state, resolver } = await setup();
    const pixels = Buffer.from([
      255, 255, 255, 0, 80, 160, 60, 255, 255, 255, 255, 0, 255, 255, 255, 0,
    ]);
    await writeFile(
      path.join(mod, 'references/world.png'),
      await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
        .png()
        .toBuffer(),
    );
    const loaded = await readReferenceImageSource(resolver, 'reference', 'references/world.png');
    const decoded = await sharp(loaded.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.channels).toBe(4);
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[7]).toBe(255);
    expect(await snapshots(state)).toEqual([]);
  });
  it('decodes a complete private copy and removes it after success', async () => {
    const { state, resolver, image } = await setup();
    const loaded = await readReferenceImageSource(resolver, 'reference', 'references/world.png');
    expect(loaded.source.sha256).toBe(sha256Bytes(image));
    expect([...(await sharp(loaded.bytes).raw().toBuffer()).subarray(0, 3)]).toEqual([35, 91, 137]);
    expect(await snapshots(state)).toEqual([]);
  });
  it('decodes only authorized FD bytes across a source-path ABA junction swap', async () => {
    const { base, mod, state, resolver, image } = await setup();
    const outside = path.join(base, 'outside'),
      sourceDirectory = path.join(mod, 'references'),
      savedDirectory = path.join(mod, 'saved-references');
    await mkdir(outside);
    await writeFile(
      path.join(outside, 'world.png'),
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#cc2211' } })
        .png()
        .toBuffer(),
    );
    let moved = false,
      linked = false;
    const restore = async () => {
      if (linked) {
        if (process.platform === 'win32') await rmdir(sourceDirectory);
        else await unlink(sourceDirectory);
        linked = false;
      }
      if (moved) {
        await rename(savedDirectory, sourceDirectory);
        moved = false;
      }
    };
    const originalVerify = sourceScanner.verifySource;
    let hookFailure: unknown;
    const spy = vi
      .spyOn(sourceScanner, 'verifySource')
      .mockImplementationOnce(async (root, source) => {
        try {
          await originalVerify(root, source);
          // Windows refuses renaming a directory with an open child. Once copying is complete,
          // close that original descriptor to exercise the pathname race permitted on POSIX.
          await source.handle.close();
          await rename(sourceDirectory, savedDirectory);
          moved = true;
          await symlink(
            outside,
            sourceDirectory,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          linked = true;
        } catch (error) {
          hookFailure = error;
          throw error;
        }
      })
      .mockImplementationOnce(async (root, source) => {
        try {
          await restore();
          await originalVerify(root, source);
        } catch (error) {
          hookFailure = error;
          throw error;
        }
      });
    try {
      const loaded = await readReferenceImageSource(resolver, 'reference', 'references/world.png');
      expect(loaded.source.sha256).toBe(sha256Bytes(image));
      const pixels = await sharp(loaded.bytes).raw().toBuffer();
      expect([...pixels.subarray(0, 3)]).toEqual([35, 91, 137]);
      expect(await snapshots(state)).toEqual([]);
    } catch (error) {
      if (hookFailure instanceof Error) throw hookFailure;
      throw error;
    } finally {
      await restore();
      spy.mockRestore();
    }
  });

  it('removes the private copy on decode failure and cancellation after copying', async () => {
    const { mod, state, resolver } = await setup();
    await writeFile(path.join(mod, 'references/bad.png'), 'not a raster');
    await expect(
      readReferenceImageSource(resolver, 'reference', 'references/bad.png'),
    ).rejects.toMatchObject({ code: 'REFERENCE_IMAGE_DECODE_FAILED' });
    expect(await snapshots(state)).toEqual([]);
    const controller = new AbortController(),
      originalVerify = sourceScanner.verifySource;
    const spy = vi
      .spyOn(sourceScanner, 'verifySource')
      .mockImplementationOnce(async (root, source) => {
        await originalVerify(root, source);
        controller.abort();
      });
    try {
      await expect(
        readReferenceImageSource(
          resolver,
          'reference',
          'references/world.png',
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(await snapshots(state)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('checks the original byte ceiling before creating any snapshot without allocating a large fixture', async () => {
    const { state, resolver } = await setup();
    const originalPrepare = sourceScanner.prepareSource;
    const spy = vi
      .spyOn(sourceScanner, 'prepareSource')
      .mockImplementationOnce(async (root, relativePath, signal) => {
        const source = await originalPrepare(root, relativePath, signal);
        source.metadata.size = REFERENCE_SOURCE_MAX_BYTES + 1;
        return source;
      });
    try {
      await expect(
        readReferenceImageSource(resolver, 'reference', 'references/world.png'),
      ).rejects.toMatchObject({ code: 'SOURCE_BYTE_LIMIT' });
      expect(await snapshots(state)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a snapshot parent exposed through a writable workspace capability', async () => {
    const { mod, resolver } = await setup(),
      state = resolver.serverState()!;
    const descriptor = Object.getOwnPropertyDescriptor(state, 'root')!;
    Object.defineProperty(state, 'root', { ...descriptor, value: path.join(mod, 'references') });
    try {
      await expect(
        readReferenceImageSource(resolver, 'reference', 'references/world.png'),
      ).rejects.toMatchObject({ code: 'REFERENCE_SNAPSHOT_UNSAFE' });
      expect(await readdir(path.join(mod, 'references'))).toEqual(['world.png']);
    } finally {
      Object.defineProperty(state, 'root', descriptor);
    }
  });
});

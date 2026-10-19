import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import * as sourceScanner from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  readDependenciesFromScannedFiles,
  TransactionManager,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  GEOGRAPHY_DEFAULT_FRAME,
  GEOGRAPHY_REFERENCE_FRAME,
  prepareGeography,
  readGeographyModelSource,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import { GEOGRAPHY_SOURCE_MAX_BYTES } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { syntheticGeography } from '../helpers/geography-fixture.js';

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-geography-source-'));
  const mod = path.join(base, 'mod');
  await mkdir(path.join(mod, 'geography'), { recursive: true });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'geo', name: 'Geography', root: mod }],
    }),
  );
  return { base, mod, resolver };
}

async function writeModel(mod: string, name = 'geography/world.json', text?: string) {
  const bytes = Buffer.from(text ?? JSON.stringify(syntheticGeography(), null, 2), 'utf8');
  await writeFile(path.join(mod, name), bytes);
  return bytes;
}

describe('geography model source (geographyPath)', () => {
  it('binds the hash of the exact bytes it parsed and leaves the file unchanged', async () => {
    const { mod, resolver } = await setup();
    const bytes = await writeModel(mod);
    const loaded = await readGeographyModelSource(resolver, 'geo', 'geography/world.json');
    expect(loaded.evidence.sha256).toBe(sha256Bytes(bytes));
    expect(loaded.evidence).toMatchObject({
      displayPath: 'mod:geography/world.json',
      relativePath: 'geography/world.json',
      rootKind: 'mod',
      size: bytes.length,
    });
    expect(loaded.bytes).toBe(bytes.length);
    expect(loaded.model.lands?.map(({ id }) => id)).toEqual(['aldoria', 'brim']);
    expect(await readFile(path.join(mod, 'geography/world.json'))).toEqual(bytes);
  });

  it('reads a UTF-8 byte order mark and backslash paths', async () => {
    const { mod, resolver } = await setup();
    await writeModel(
      mod,
      'geography/bom.json',
      String.fromCharCode(0xfeff) + JSON.stringify(syntheticGeography()),
    );
    const loaded = await readGeographyModelSource(resolver, 'geo', 'geography\\bom.json');
    expect(loaded.evidence.relativePath).toBe('geography/bom.json');
    expect(loaded.model.version).toBe(1);
  });

  it('rejects traversal, absolute and non-json paths before touching the disk', async () => {
    const { base, mod, resolver } = await setup();
    await writeFile(path.join(base, 'outside.json'), JSON.stringify(syntheticGeography()));
    await writeModel(mod, 'geography/world.png');
    await expect(readGeographyModelSource(resolver, 'geo', '../outside.json')).rejects.toThrow();
    await expect(
      readGeographyModelSource(resolver, 'geo', path.join(base, 'outside.json')),
    ).rejects.toThrow();
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/world.png'),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_PATH_INVALID' });
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/world.json:stream'),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_PATH_INVALID' });
  });

  it('rejects a directory junction that escapes the workspace', async () => {
    const { base, mod, resolver } = await setup();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'world.json'), JSON.stringify(syntheticGeography()));
    await symlink(
      outside,
      path.join(mod, 'geography/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/escape/world.json'),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FOUND_IN_ROOTS' });
  });

  it('rejects another principal, a missing file and a directory', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod);
    await mkdir(path.join(mod, 'geography/folder.json'));
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/world.json', 'intruder'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/missing.json'),
    ).rejects.toThrow();
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/folder.json'),
    ).rejects.toThrow();
  });

  it('rejects empty and oversized sources without parsing them', async () => {
    const { mod, resolver } = await setup();
    await writeFile(path.join(mod, 'geography/empty.json'), '');
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/empty.json'),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_SOURCE_TOO_LARGE' });
    const padding = Buffer.alloc(GEOGRAPHY_SOURCE_MAX_BYTES + 1, 0x20);
    await writeFile(path.join(mod, 'geography/large.json'), padding);
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/large.json'),
    ).rejects.toMatchObject({
      code: 'MAP_GEOGRAPHY_SOURCE_TOO_LARGE',
      details: { limit: GEOGRAPHY_SOURCE_MAX_BYTES },
    });
  });

  it('rejects invalid JSON and schema violations with a path to the problem', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod, 'geography/broken.json', '{ "version": 1, ');
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/broken.json'),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_JSON_INVALID' });
    const bad = syntheticGeography() as unknown as { lands: Array<Record<string, unknown>> };
    bad.lands[0]!.elevationBase = 1.5;
    await writeModel(mod, 'geography/bad.json', JSON.stringify(bad));
    const failure = await readGeographyModelSource(resolver, 'geo', 'geography/bad.json').catch(
      (error: unknown) => error as { code: string; details: { issues: Array<{ path: string }> } },
    );
    expect(failure).toMatchObject({ code: 'MAP_GEOGRAPHY_SCHEMA_INVALID' });
    expect(
      (failure as { details: { issues: Array<{ path: string }> } }).details.issues[0]!.path,
    ).toBe('lands.0.elevationBase');
    await writeModel(mod, 'geography/unknown.json', '{"version":1,"__proto__":{"admin":true}}');
    const polluted = await readGeographyModelSource(resolver, 'geo', 'geography/unknown.json');
    // A prototype key in the file never reaches the parsed model or Object.prototype.
    expect(Object.prototype.hasOwnProperty.call(polluted.model, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(polluted.model)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    await writeModel(mod, 'geography/extra.json', '{"version":1,"constructor":{"admin":true}}');
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/extra.json'),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_SCHEMA_INVALID' });
    await writeModel(mod, 'geography/array.json', '[]');
    await expect(
      readGeographyModelSource(resolver, 'geo', 'geography/array.json'),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_SCHEMA_INVALID' });
  });

  it('honours cancellation', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod);
    const controller = new AbortController();
    controller.abort();
    await expect(
      readGeographyModelSource(
        resolver,
        'geo',
        'geography/world.json',
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it('rejects a file replaced while it was being read', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod);
    const target = path.join(mod, 'geography/world.json');
    const verifySource = sourceScanner.verifySource;
    const spy = vi
      .spyOn(sourceScanner, 'verifySource')
      .mockImplementationOnce(async (root, source) => {
        await writeFile(target, JSON.stringify({ version: 1 }));
        return verifySource(root, source);
      });
    try {
      await expect(
        readGeographyModelSource(resolver, 'geo', 'geography/world.json'),
      ).rejects.toMatchObject({ code: 'SCAN_SOURCE_CHANGED' });
    } finally {
      spy.mockRestore();
    }
  });

  it('blocks a transaction when the file changed after it was read', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod);
    const loaded = await readGeographyModelSource(resolver, 'geo', 'geography/world.json');
    const manager = new TransactionManager(resolver);
    const validation = async () => ({
      diagnostics: [],
      checks: [{ id: 'geography-test', passed: true, message: 'Synthetic check' }],
    });
    const planned = await manager.plan({
      workspaceId: 'geo',
      operationKind: 'geography-test',
      operations: [{ id: 'world', kind: 'create_world', summary: 'Synthetic', data: {} }],
      changes: [
        { relativePath: 'probe.txt', content: Buffer.from('after'), operationIds: ['world'] },
      ],
      readDependencies: readDependenciesFromScannedFiles([loaded.evidence]),
      validate: validation,
    });
    await writeFile(
      path.join(mod, 'geography/world.json'),
      JSON.stringify({ ...syntheticGeography(), name: 'Edited after planning' }),
    );
    await expect(
      manager.apply('geo', planned.transactionId, planned.planHash, { postValidate: validation }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_SOURCE_STALE' });
    await expect(readFile(path.join(mod, 'probe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('geography preparation for create_world', () => {
  it('resolves a file model against the operation size and reports its source', async () => {
    const { mod, resolver } = await setup();
    const bytes = await writeModel(mod);
    const prepared = await prepareGeography(resolver, 'geo', {
      id: 'world',
      width: 4096,
      height: 2048,
      geographyPath: 'geography/world.json',
    });
    expect(prepared.valid).toBe(true);
    expect(prepared.frame).toEqual({ width: 4096, height: 2048 });
    expect(prepared.source).toMatchObject({ kind: 'file', sha256: sha256Bytes(bytes) });
    expect(prepared.operationId).toBe('world');
    expect(prepared.geography.featureCount).toBe(16);
  });

  it('takes the frame from the defaults of create_world', async () => {
    const { resolver } = await setup();
    const inline = await prepareGeography(resolver, 'geo', {
      id: 'a',
      geography: syntheticGeography(),
    });
    expect(inline.frame).toEqual(GEOGRAPHY_DEFAULT_FRAME);
    expect(inline.source.kind).toBe('inline');
    const withImage = await prepareGeography(resolver, 'geo', {
      id: 'b',
      geography: syntheticGeography(),
      reference: { imagePath: 'ref.png' },
    });
    expect(withImage.frame).toEqual(GEOGRAPHY_REFERENCE_FRAME);
    expect(withImage.hasReference).toBe(true);
    const sized = await prepareGeography(resolver, 'geo', {
      id: 'c',
      geography: syntheticGeography(),
      width: 2048,
    });
    expect(sized.frame).toEqual({ width: 2048, height: 512 });
  });

  it('keeps the same hash for the same model inline or in a file', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod);
    const operation = { id: 'world', width: 4096, height: 2048 };
    const file = await prepareGeography(resolver, 'geo', {
      ...operation,
      geographyPath: 'geography/world.json',
    });
    const inline = await prepareGeography(resolver, 'geo', {
      ...operation,
      geography: syntheticGeography(),
    });
    expect(file.geography.hash).toBe(inline.geography.hash);
    expect(file.source.sha256).not.toBe(inline.source.sha256);
  });

  it('refuses both sources at once', async () => {
    const { mod, resolver } = await setup();
    await writeModel(mod);
    await expect(
      prepareGeography(resolver, 'geo', {
        id: 'world',
        geography: syntheticGeography(),
        geographyPath: 'geography/world.json',
      }),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_SOURCE_AMBIGUOUS' });
  });

  it('refuses an inline model over the byte limit', async () => {
    const { resolver } = await setup();
    const sites = Array.from({ length: 4_000 }, (_value, index) => ({
      id: `site${index}`,
      kind: 'city' as const,
      at: [0.5, 0.5] as [number, number],
      note: 'x'.repeat(500),
      tags: Array.from({ length: 16 }, (_tag, tagIndex) => `tag-${tagIndex}-${'y'.repeat(40)}`),
    }));
    await expect(
      prepareGeography(resolver, 'geo', { id: 'world', geography: { version: 1, sites } }),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_SOURCE_TOO_LARGE' });
  });

  it('returns defects as diagnostics rather than throwing', async () => {
    const { resolver } = await setup();
    const prepared = await prepareGeography(resolver, 'geo', {
      id: 'world',
      geography: { version: 1 },
    });
    expect(prepared.valid).toBe(false);
    expect(prepared.diagnostics.map(({ code }) => code)).toContain('MAP_GEOGRAPHY_NO_LAND');
    expect(prepared.diagnostics.every(({ operationId }) => operationId === 'world')).toBe(true);
  });
});

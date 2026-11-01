import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  matchWorldNames,
  prepareWorldNames,
  WORLD_NAMES_SOURCE_MAX_BYTES,
} from '../../src/hoi4_agent_tools/map/world-names.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-world-names-'));
  const mod = path.join(base, 'mod');
  await mkdir(path.join(mod, 'names'), { recursive: true });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'names', name: 'Names', root: mod }],
    }),
  );
  return { base, mod, resolver };
}

const names = { states: [{ at: { x: 1, y: 1 }, name: 'Shire' }] };

describe('caller names source (namesPath)', () => {
  it('binds the hash of the exact bytes it parsed and leaves the file unchanged', async () => {
    const { mod, resolver } = await setup();
    const bytes = Buffer.from(
      `${String.fromCharCode(0xfeff)}${JSON.stringify(names, null, 2)}`,
      'utf8',
    );
    await writeFile(path.join(mod, 'names/world.json'), bytes);
    const loaded = (await prepareWorldNames(resolver, 'names', {
      namesPath: String.raw`names\world.json`,
    }))!;
    expect(loaded.names).toEqual(names);
    expect(loaded.source).toMatchObject({
      kind: 'file',
      sha256: sha256Bytes(bytes),
      evidence: { displayPath: 'mod:names/world.json', relativePath: 'names/world.json' },
    });
    expect(await readFile(path.join(mod, 'names/world.json'))).toEqual(bytes);
  });

  it('hashes inline names and returns nothing without names', async () => {
    const { resolver } = await setup();
    expect(await prepareWorldNames(resolver, 'names', {})).toBeUndefined();
    expect((await prepareWorldNames(resolver, 'names', { names }))!.source).toEqual({
      kind: 'inline',
      bytes: Buffer.byteLength(canonicalJson(names)),
      sha256: sha256Bytes(canonicalJson(names)),
    });
  });

  it('refuses both sources, bad paths, bad JSON, schema errors and oversized files', async () => {
    const { base, mod, resolver } = await setup();
    const code = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject;
    await code(prepareWorldNames(resolver, 'names', { names, namesPath: 'names/world.json' }))({
      code: 'MAP_NAMES_SOURCE_AMBIGUOUS',
    });
    await code(prepareWorldNames(resolver, 'names', { namesPath: 'names/world.txt' }))({
      code: 'MAP_NAMES_PATH_INVALID',
    });
    await writeFile(path.join(base, 'outside.json'), JSON.stringify(names));
    await expect(
      prepareWorldNames(resolver, 'names', { namesPath: '../outside.json' }),
    ).rejects.toThrow();
    await writeFile(path.join(mod, 'names/broken.json'), '{');
    await code(prepareWorldNames(resolver, 'names', { namesPath: 'names/broken.json' }))({
      code: 'MAP_NAMES_JSON_INVALID',
    });
    await writeFile(
      path.join(mod, 'names/wrong.json'),
      JSON.stringify({ states: [{ name: 'x' }] }),
    );
    await code(prepareWorldNames(resolver, 'names', { namesPath: 'names/wrong.json' }))({
      code: 'MAP_NAMES_INVALID',
      details: { issues: [expect.objectContaining({ path: 'states.0.at' })] },
    });
    await writeFile(
      path.join(mod, 'names/huge.json'),
      Buffer.alloc(WORLD_NAMES_SOURCE_MAX_BYTES + 1, 32),
    );
    await code(prepareWorldNames(resolver, 'names', { namesPath: 'names/huge.json' }))({
      code: 'MAP_NAMES_SOURCE_TOO_LARGE',
    });
  });

  it('is refused by the operation schema when given twice or with unknown fields', () => {
    const base = { id: 'world', kind: 'create_world' };
    expect(mapOperationSchema.safeParse({ ...base, names }).success).toBe(true);
    expect(mapOperationSchema.safeParse({ ...base, namesPath: 'names/world.json' }).success).toBe(
      true,
    );
    expect(
      mapOperationSchema.safeParse({ ...base, names, namesPath: 'names/world.json' }).success,
    ).toBe(false);
    expect(mapOperationSchema.safeParse({ ...base, namesPath: '../world.json' }).success).toBe(
      false,
    );
    expect(mapOperationSchema.safeParse({ ...base, names: { cities: [] } }).success).toBe(false);
  });

  it('treats a pixel outside the world as unmatched', () => {
    const matched = matchWorldNames(
      { states: [{ at: { x: 9, y: 0 }, name: 'Off' }] },
      { width: 2, height: 1, pixel: Int32Array.from([0, 0]), stateOf: () => 1, regionOf: () => 1 },
    );
    expect(matched.states.size).toBe(0);
    expect(matched.unmatched).toEqual([{ kind: 'state', x: 9, y: 0, name: 'Off' }]);
  });
});

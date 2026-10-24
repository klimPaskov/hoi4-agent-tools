import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { generateWorld, type WorldSpec } from '../../src/hoi4_agent_tools/map/world.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { plainContext, syntheticRaster, worldSpec } from '../helpers/map-appearance-world.js';

async function nudger(): Promise<AgentNudger> {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-partition-'));
  const mod = path.join(base, 'mod');
  await mkdir(mod);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'state'),
      workspaces: [{ id: 'w', name: 'W', root: mod }],
    }),
  );
  return new AgentNudger(resolver);
}

function world(extra: Record<string, unknown>) {
  return [
    {
      id: 'world',
      kind: 'create_world',
      width: 512,
      height: 256,
      seed: 4,
      rivers: 12,
      landProvincePixels: 150,
      countries: [{ tag: 'AAA', name: 'Aster' }],
      ...extra,
    },
  ] as never;
}

async function plan(extra: Record<string, unknown>) {
  const preview = await (
    await nudger()
  ).previewRewriteWithDiff({
    workspaceId: 'w',
    operations: world(extra),
  });
  const files = new Map(
    preview.plan.changes
      .filter((change) => change.content !== null)
      .map((change) => [change.relativePath, Buffer.from(change.content!)] as const),
  );
  return { preview, files };
}

const sha = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

describe('create_world partition option through the planner', () => {
  it('keeps old requests byte-identical and treats "legacy" as the default', async () => {
    const plain = await plan({});
    const legacy = await plan({ partition: 'legacy' });
    expect(plain.preview.plan.blockers).toEqual([]);
    expect([...legacy.files.keys()].sort()).toEqual([...plain.files.keys()].sort());
    for (const [file, bytes] of plain.files)
      expect(sha(legacy.files.get(file)!), file).toBe(sha(bytes));
  });

  it('writes a valid world with the feature-aware partition and different provinces', async () => {
    const legacy = await plan({});
    const aware = await plan({ partition: 'feature-aware' });
    expect(aware.preview.plan.blockers).toEqual([]);
    expect(aware.preview.validation.passed).toBe(true);
    expect(sha(aware.files.get('map/provinces.bmp')!)).not.toBe(
      sha(legacy.files.get('map/provinces.bmp')!),
    );
    const rows = (files: Map<string, Buffer>): string[] =>
      files
        .get('map/definition.csv')!
        .toString('utf8')
        .split('\r\n')
        .filter((line) => line !== '');
    expect(rows(aware.files).length).toBeGreaterThan(20);
    // A repeat gives the same world.
    const again = await plan({ partition: 'feature-aware' });
    for (const [file, bytes] of aware.files)
      expect(sha(again.files.get(file)!), file).toBe(sha(bytes));
  });

  it('accepts partition tuning for the feature-aware partition and refuses it for legacy', async () => {
    const tuned = await plan({
      partition: 'feature-aware',
      partitionTuning: {
        landArea: { fertile: 60, hills: 150, mountain: 300, waste: 400 },
        provincesPerState: [3, 8],
        barrierStrength: 30,
      },
    });
    expect(tuned.preview.plan.blockers).toEqual([]);
    const refused = await plan({ partitionTuning: { barrierStrength: 30 } });
    expect(refused.preview.plan.blockers[0]?.code).toBe(
      'MAP_PARTITION_TUNING_REQUIRES_FEATURE_AWARE',
    );
    expect(refused.preview.validation.passed).toBe(false);
  });

  it.each([
    [{ landArea: { fertile: 900, hills: 100 } }, 'MAP_PARTITION_AREA_BANDS_CONTRADICTORY'],
    [{ provincesPerState: [9, 3] }, 'MAP_PARTITION_STATE_SIZE_CONTRADICTORY'],
    [{ regionSize: [40, 10] }, 'MAP_PARTITION_REGION_SIZE_CONTRADICTORY'],
    [{ minProvincePixels: 1_000 }, 'MAP_PARTITION_MAP_TOO_SMALL'],
  ])('refuses the tuning %j before writing anything', async (partitionTuning, code) => {
    const refused = await plan({ partition: 'feature-aware', partitionTuning });
    expect(refused.preview.plan.blockers[0]?.code).toBe(code);
    expect(refused.preview.validation.passed).toBe(false);
  });
});

describe('create_world partition in the operation schema', () => {
  const base = { kind: 'create_world' } as const;
  it('accepts the two partitions and the documented tuning', () => {
    for (const partition of ['legacy', 'feature-aware'])
      expect(mapOperationSchema.safeParse({ ...base, partition }).success).toBe(true);
    expect(
      mapOperationSchema.safeParse({
        ...base,
        partition: 'feature-aware',
        partitionTuning: {
          landArea: { fertile: 90, hills: 250, mountain: 600, waste: 900 },
          seaArea: { coastal: 800, open: 5_000 },
          provincesPerState: [6, 12],
          regionSize: [20, 45],
          barrierStrength: 24,
          minProvincePixels: 40,
          narrowStraitPx: 24,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown values, fractions, out-of-range numbers and extra keys', () => {
    expect(mapOperationSchema.safeParse({ ...base, partition: 'voronoi' }).success).toBe(false);
    for (const partitionTuning of [
      { landArea: { fertile: 10 } },
      { landArea: { fertile: 90.5 } },
      { landArea: { swamp: 90 } },
      { seaArea: { open: 300_000 } },
      { provincesPerState: [1, 2, 3] },
      { provincesPerState: [0, 4] },
      { regionSize: [2, 900] },
      { barrierStrength: 61 },
      { barrierStrength: -1 },
      { minProvincePixels: 5 },
      { narrowStraitPx: 100 },
      { surprise: true },
    ])
      expect(mapOperationSchema.safeParse({ ...base, partitionTuning }).success).toBe(false);
  });
});

describe('generateWorld with the feature-aware partition', () => {
  function spec(extra: Partial<WorldSpec> = {}): WorldSpec {
    const surface = syntheticRaster(512, 256, {
      at: (x, y) => {
        if ((x - 256) ** 2 + (y - 128) ** 2 <= 14 ** 2) return 2;
        const dx = (x - 256) / 200;
        const dy = (y - 128) / 90;
        return dx * dx + dy * dy <= 1 ? 1 : 0;
      },
      terrain: (x) => (x < 200 ? 3 : x < 320 ? 0 : 1),
    });
    return worldSpec(surface, {
      landProvincePixels: 120,
      seaProvincePixels: 800,
      countries: [
        { tag: 'AAA', name: 'Alpha' },
        { tag: 'BBB', name: 'Beta' },
      ],
      ...extra,
    });
  }

  it('is the legacy world unless it is asked for, and different when asked', () => {
    const legacy = generateWorld(spec(), plainContext);
    // Pinned from the integration branch before the feature-aware partition existed: a change
    // here means the legacy partition changed.
    const pinned = (name: string): string =>
      sha(legacy.files.find((file) => file.relativePath === name)!.content);
    expect(pinned('map/provinces.bmp')).toBe(
      'a87bd6c49c9c80e1db16e5af2facb0518a38d6b8c1a74ac3b9ee72f9ae8d6ccc',
    );
    expect(pinned('map/definition.csv')).toBe(
      'e80cadbc7015d9ba5c991e8c5946afff266749b22ece790ce2bb78d6a9c741e4',
    );
    const same = generateWorld(spec({ partition: { mode: 'legacy' } }), plainContext);
    expect(same.files.map((f) => sha(f.content))).toEqual(legacy.files.map((f) => sha(f.content)));
    const aware = generateWorld(spec({ partition: { mode: 'feature-aware' } }), plainContext);
    expect(aware.summary.landProvinces).toBeGreaterThan(20);
    expect(aware.summary.states).toBeGreaterThan(3);
    expect(aware.files.map((f) => sha(f.content))).not.toEqual(
      legacy.files.map((f) => sha(f.content)),
    );
    expect(aware.notes.map(({ code }) => code)).not.toContain('MAP_PARTITION_PROVINCE_COUNT_HIGH');
  });

  it('honours the requested states per province and regions', () => {
    const aware = generateWorld(
      spec({
        provincesPerState: 4,
        landProvincesPerRegion: 12,
        partition: { mode: 'feature-aware', tuning: { provincesPerState: [3, 6] } },
      }),
      plainContext,
    );
    const perState = aware.summary.landProvinces / aware.summary.states;
    expect(perState).toBeGreaterThan(2);
    expect(perState).toBeLessThan(7);
    expect(aware.summary.landRegions).toBeGreaterThan(1);
  });

  it('refuses a request that plans more provinces than the engine and text tables allow', () => {
    expect(() =>
      generateWorld(
        spec({
          width: 1_024,
          height: 512,
          landProvincePixels: 60,
          seaProvincePixels: 200,
          partition: {
            mode: 'feature-aware',
            tuning: {
              landArea: { fertile: 20, hills: 20, mountain: 20, waste: 20 },
              minProvincePixels: 20,
            },
          },
          referenceSurface: syntheticRaster(1_024, 512, { at: () => 1 }),
        }),
        plainContext,
      ),
    ).toThrow(/21,000/u);
  });
});

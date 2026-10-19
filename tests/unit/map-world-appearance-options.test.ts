import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { measureAppearance } from '../helpers/map-appearance-metrics.js';

async function nudger(): Promise<AgentNudger> {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-appearance-options-'));
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
      rivers: 0,
      countries: [{ tag: 'AAA', name: 'Aster' }],
      ...extra,
    },
  ] as never;
}

describe('create_world appearance options through the planner', () => {
  it('writes the sea band, frame borders and calibrated colour map and validates them', async () => {
    const service = await nudger();
    const preview = await service.previewRewriteWithDiff({
      workspaceId: 'w',
      operations: world({ edge: {}, ambientFrame: true, look: 'fertile' }),
    });
    expect(preview.plan.blockers).toEqual([]);
    const files = new Map(
      preview.plan.changes
        .filter((change) => change.content !== null)
        .map((change) => [change.relativePath, Buffer.from(change.content!)] as const),
    );
    const metrics = measureAppearance(files);
    expect(metrics.seam.landRowsTouchingSeam).toBe(0);
    expect(metrics.frameBorders.map(({ z }) => z)).toEqual([256 + 142, -140, 256 + 82]);
    expect(metrics.landColourMap.meanValue).toBeLessThan(100);
    expect(preview.validation.diagnostics.map(({ code }) => code)).not.toContain(
      'MAP_EDGE_LAND_CUT',
    );
    expect(preview.validation.passed).toBe(true);
  });

  it('keeps old requests on the previous colour map and seam behaviour', async () => {
    const service = await nudger();
    const preview = await service.previewRewriteWithDiff({
      workspaceId: 'w',
      operations: world({}),
    });
    const files = new Map(
      preview.plan.changes
        .filter((change) => change.content !== null)
        .map((change) => [change.relativePath, Buffer.from(change.content!)] as const),
    );
    expect(files.get('map/ambient_object.txt')!.toString()).toMatch(/^# No ambient objects/u);
    expect(measureAppearance(files).landColourMap.meanValue).toBeGreaterThan(100);
  });

  it.each([
    [{ look: 'custom' }, 'MAP_LOOK_CUSTOM_PALETTE_REQUIRED'],
    [{ look: 'arid', colormap: { profile: 'legacy' } }, 'MAP_LOOK_REQUIRES_CALIBRATED_COLORMAP'],
    [{ edge: { bandPx: 200 } }, 'MAP_EDGE_BAND_TOO_WIDE'],
    [{ edge: { mode: 'rim', rimPx: 500 } }, 'MAP_EDGE_BAND_TOO_WIDE'],
  ])('refuses %j before writing anything', async (extra, code) => {
    const service = await nudger();
    const preview = await service.previewRewriteWithDiff({
      workspaceId: 'w',
      operations: world(extra),
    });
    expect(preview.plan.blockers[0]?.code).toBe(code);
    expect(preview.validation.passed).toBe(false);
  });
});

describe('edge and ambient frame in the operation schema', () => {
  const base = { kind: 'create_world' } as const;
  it('accepts the documented modes and sizes', () => {
    for (const edge of [
      {},
      { mode: 'sea-band', bandPx: 192, polarPx: 64 },
      { mode: 'rim', rimPx: 160 },
      { mode: 'none' },
    ])
      expect(mapOperationSchema.safeParse({ ...base, edge, ambientFrame: true }).success).toBe(
        true,
      );
  });

  it('rejects unknown modes, tiny or huge sizes, fractions and extra keys', () => {
    for (const edge of [
      { mode: 'wall' },
      { bandPx: 4 },
      { bandPx: 5_000 },
      { bandPx: 12.5 },
      { polarPx: -1 },
      { rimPx: 8 },
      { fade: true },
    ])
      expect(mapOperationSchema.safeParse({ ...base, edge }).success).toBe(false);
    expect(mapOperationSchema.safeParse({ ...base, ambientFrame: 'yes' }).success).toBe(false);
  });
});

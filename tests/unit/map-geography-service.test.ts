import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import type { MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';
import { syntheticGeography } from '../helpers/geography-fixture.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-geography-service-'));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const mod = path.join(base, 'mod');
  const game = path.join(base, 'game');
  await cp(path.resolve('fixtures', 'map', 'roots', 'mod'), mod, { recursive: true });
  await cp(path.resolve('fixtures', 'map', 'roots', 'game'), game, { recursive: true });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'state'),
      workspaces: [{ id: 'geo', name: 'Geography service', root: mod, gameRoot: game }],
    }),
  );
  return { mod, nudger: new AgentNudger(resolver) };
}

const operation = (extra: Record<string, unknown>) =>
  ({ id: 'world', kind: 'create_world', width: 4096, height: 2048, ...extra }) as MapOperation;

describe('geography model in the map service', () => {
  it('records the digest of an inline model, not the model, and binds the plan hash to it', async () => {
    const { nudger } = await setup();
    const model = syntheticGeography();
    const planned = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geography: model })],
    });
    const recorded = planned.transaction.operations[0]!.data.geography;
    expect(recorded).toEqual({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
      bytes: expect.any(Number) as number,
    });
    expect(JSON.stringify(planned.transaction)).not.toContain('aldoria');
    expect(planned.plan.blockers.map(({ code }) => code)).toEqual([
      'MAP_RIVER_UNREACHABLE_MOUTH',
    ]);
    const edited = syntheticGeography();
    edited.lands![0]!.name = 'Aldoria the Great';
    const other = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geography: edited })],
    });
    expect(other.transaction.planHash).not.toBe(planned.transaction.planHash);
    const same = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geography: syntheticGeography() })],
    });
    expect(same.transaction.operations[0]!.data.geography).toEqual(recorded);
  });

  it('adds a geography file as a read dependency of the plan', async () => {
    const { mod, nudger } = await setup();
    await mkdir(path.join(mod, 'geography'), { recursive: true });
    const file = path.join(mod, 'geography', 'world.json');
    await writeFile(file, JSON.stringify(syntheticGeography()));
    const planned = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geographyPath: 'geography/world.json' })],
    });
    expect(planned.transaction.readDependencies).toContainEqual({
      rootKind: 'mod',
      loadOrder: expect.any(Number) as number,
      relativePath: 'geography/world.json',
      sha256: sha256Bytes(await readFile(file)),
    });
    expect(planned.plan.blockers.map(({ code }) => code)).toEqual([
      'MAP_RIVER_UNREACHABLE_MOUTH',
    ]);
    // The same plan after the file changed is a different plan.
    await writeFile(
      file,
      JSON.stringify({ ...syntheticGeography(), description: 'Edited after planning' }),
    );
    const replanned = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geographyPath: 'geography/world.json' })],
    });
    expect(replanned.transaction.planHash).not.toBe(planned.transaction.planHash);
  });

  it('carries the model diagnostics into the plan and stores the overlay with it', async () => {
    const { nudger } = await setup();
    const model = syntheticGeography();
    model.regions?.push({ id: 'ghost' });
    const planned = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geography: model })],
    });
    expect(planned.plan.diagnostics.map(({ code }) => code)).toContain(
      'MAP_GEOGRAPHY_REGION_EMPTY',
    );
    const withOverlay = await nudger.previewRewriteWithDiff({
      workspaceId: 'geo',
      operations: [operation({ geography: model })],
    });
    expect(withOverlay.artifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['map-geography-overlay.png', 'map-geography-report.json']),
    );
  });

  it('blocks an invalid model before synthesis and says so', async () => {
    const { nudger } = await setup();
    const planned = await nudger.plan({
      workspaceId: 'geo',
      operations: [operation({ geography: { version: 1 } })],
    });
    expect(planned.plan.blockers.map(({ code }) => code)).toEqual(['MAP_GEOGRAPHY_INVALID']);
    expect(planned.validation.passed).toBe(false);
  });

  it('refuses both sources and an unprepared model', async () => {
    const { mod, nudger } = await setup();
    await writeFile(path.join(mod, 'world.json'), JSON.stringify(syntheticGeography()));
    await expect(
      nudger.plan({
        workspaceId: 'geo',
        operations: [operation({ geography: syntheticGeography(), geographyPath: 'world.json' })],
      }),
    ).rejects.toMatchObject({ code: 'MAP_GEOGRAPHY_SOURCE_AMBIGUOUS' });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generatedWorld,
  removeTerritoryWorkspaces,
  spreadStates,
  workspaceOf,
} from '../helpers/map-territory-world.js';

let world: Awaited<ReturnType<typeof generatedWorld>>;
let seeds: number[];

beforeAll(async () => {
  world = await generatedWorld();
  seeds = spreadStates(world.index, 4);
}, 120_000);
afterAll(removeTerritoryWorkspaces);

const TAGS = ['EEA', 'EEB', 'EEC', 'EED'];

function operation(extra: Record<string, unknown>) {
  return {
    id: 'territory',
    kind: 'assign_territory',
    seed: 2,
    countries: seeds.map((state, position) => ({ tag: TAGS[position], seeds: [{ state }] })),
    ...extra,
  };
}

async function preview(operations: unknown[]) {
  return world.workspace.nudger.previewRewriteWithDiff({
    workspaceId: 'territory',
    operations: operations as never,
  });
}

describe('border quality of a territory assignment', () => {
  it('reports the measured borders and writes the complete territory report', async () => {
    const result = await preview([operation({ borderQuality: 'report' })]);
    expect(result.plan.blockers).toEqual([]);
    const report = result.plan.territory![0]!;
    const country = report.borderQuality.verdicts!.find(({ layer }) => layer === 'country')!;
    expect(country.status).toBe('ok');
    expect(country.enrichment).not.toBeNull();
    const codes = result.diagnostics.map(({ code }) => code);
    expect(codes).toContain('MAP_BORDER_QUALITY_MEASURED');
    expect(codes).toContain('MAP_TERRITORY_ASSIGNED');
    expect(result.artifacts.map(({ name }) => name)).toContain('map-territory-report.json');
  });

  it('measures nothing when the mode is off', async () => {
    const result = await preview([operation({ borderQuality: 'off' })]);
    expect(result.plan.territory![0]!.borderQuality.verdicts).toBeUndefined();
    expect(result.diagnostics.map(({ code }) => code)).not.toContain('MAP_BORDER_QUALITY_MEASURED');
  });

  it('blocks the write in enforce mode when the targets are missed, and says where', async () => {
    const result = await preview([
      operation({ borderQuality: 'enforce', borderTargets: { minEnrichment: 50 } }),
    ]);
    expect(result.plan.blockers.map(({ code }) => code)).toEqual([
      'MAP_TERRITORY_BORDER_ARTIFICIAL',
    ]);
    expect(result.plan.blockers[0]!.message).toContain('enrichment');
    expect(result.validation.passed).toBe(false);
  });

  it('lets an enforced assignment through when the targets are met', async () => {
    const result = await preview([
      operation({
        borderQuality: 'enforce',
        borderTargets: { minEnrichment: 0.5, maxStraightness: 1 },
      }),
    ]);
    expect(result.plan.blockers).toEqual([]);
    expect(result.validation.passed).toBe(true);
  });

  it('measures state borders after a repartition and compares them with the borders before', async () => {
    const result = await preview([
      {
        id: 'regroup',
        kind: 'repartition_states',
        provincesPerState: { min: 3, target: 5, max: 8 },
        borderQuality: 'report',
      },
    ]);
    expect(result.plan.blockers).toEqual([]);
    const report = result.plan.territory![0]!;
    expect(report.before).toBeDefined();
    expect(report.borderQuality.verdicts!.map(({ layer }) => layer)).toEqual(['state']);
  });
});

describe('border quality of a new world', () => {
  const world = (extra: Record<string, unknown>) => ({
    id: 'world',
    kind: 'create_world',
    width: 512,
    height: 256,
    seed: 4,
    rivers: 12,
    landProvincePixels: 150,
    countries: [
      { tag: 'AAA', name: 'Aster' },
      { tag: 'BBB', name: 'Brum' },
    ],
    ...extra,
  });

  it('refuses enforce for the legacy partition, with the reason', async () => {
    const empty = await workspaceOf(new Map([['descriptor.mod', 'name="World"\n']]));
    const result = await empty.nudger.previewRewriteWithDiff({
      workspaceId: 'territory',
      operations: [world({ borderQuality: 'enforce' })] as never,
    });
    expect(result.plan.blockers.map(({ code }) => code)).toEqual([
      'MAP_BORDER_QUALITY_ENFORCE_NEEDS_FEATURE_AWARE',
    ]);
  });

  it('measures a feature-aware world in report mode and changes nothing without the option', async () => {
    const empty = await workspaceOf(new Map([['descriptor.mod', 'name="World"\n']]));
    const measured = await empty.nudger.previewRewriteWithDiff({
      workspaceId: 'territory',
      operations: [world({ partition: 'feature-aware', borderQuality: 'report' })] as never,
    });
    expect(measured.plan.blockers).toEqual([]);
    expect(measured.diagnostics.map(({ code }) => code)).toContain('MAP_BORDER_QUALITY_MEASURED');
    const plain = await empty.nudger.previewRewriteWithDiff({
      workspaceId: 'territory',
      operations: [world({ partition: 'feature-aware' })] as never,
    });
    expect(plain.diagnostics.map(({ code }) => code)).not.toContain('MAP_BORDER_QUALITY_MEASURED');
    const files = (preview: typeof plain) =>
      new Map(
        preview.plan.changes.map(({ relativePath, content }) => [
          relativePath,
          Buffer.from(content ?? []).toString('base64'),
        ]),
      );
    expect(files(measured)).toEqual(files(plain));
  });
});

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  inspectHelperExpansion,
  type HelperExpansionInventory,
} from '../../src/hoi4_agent_tools/core/helper-expansion.js';
import { EventChainViewer } from '../../src/hoi4_agent_tools/event/service.js';
import { TechnologyTreeViewer } from '../../src/hoi4_agent_tools/technology/service.js';
import { eventInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/event.js';
import { technologyInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/technology.js';
import { helperExpansionFixture } from '../helpers/helper-expansion-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const value = await helperExpansionFixture();
  cleanup.push(value.dispose);
  return value;
}
interface Report {
  records: Array<{
    id: string;
    kind: string;
    rootId: string;
    path: string[];
    scopeEvidence?: { declaredScope?: string; resolvedScope: string };
  }>;
  edges: Array<{
    id: string;
    evidence: {
      kind: string;
      edge?: { conditions: unknown[] };
      access?: { name: string; scope: string };
      reference?: { technologyId?: string };
    };
  }>;
}

describe('event and technology helper continuation evidence', () => {
  it.each(['event', 'technology'] as const)(
    'streams bounded %s evidence without first enumerating an exponential helper closure',
    async (domain) => {
      const setup = await fixture();
      const levels = 22;
      const helpers = Array.from(
        { length: levels },
        (_, level) =>
          `page_${level} = { if = { limit = { has_country_flag = left } page_${level + 1} = yes } if = { limit = { has_country_flag = right } page_${level + 1} = yes } }`,
      );
      await writeFile(
        path.join(setup.mod, 'common/scripted_effects/pages.txt'),
        `page_entry = { page_0 = yes }\n${helpers.join('\n')}\npage_${levels} = { country_event = { id = pages.2 } set_technology = { page_tech = 1 } }`,
      );
      const inspect = async (helperExpansion = {}) => {
        const engine = await setup.engine();
        const input = {
          workspaceId: 'pages',
          mode: 'helper_expansion' as const,
          helperExpansion: { maxRecords: 128, maxWork: 2_048, ...helperExpansion },
        };
        return domain === 'event'
          ? new EventChainViewer(engine).inspect(input)
          : new TechnologyTreeViewer(engine).analyze(input);
      };
      const first = await inspect();
      const second = await inspect({ continuationUri: first.helperExpansion!.continuationUri });
      expect(first.helperExpansion).toMatchObject({
        records: 128,
        finished: false,
        complete: false,
      });
      expect(second.helperExpansion).toMatchObject({
        records: 128,
        totalRecords: 256,
        finished: false,
      });
      const firstIds = new Set((first.report as Report).records.map(({ id }) => id));
      expect((second.report as Report).records.every(({ id }) => !firstIds.has(id))).toBe(true);
      expect(first.reportJson.length).toBeLessThan(2_000_000);
    },
  );

  it.each(['event', 'technology'] as const)(
    'does not mark a depth-truncated materialized %s graph complete and can inspect the deeper helper path explicitly',
    async (domain) => {
      const setup = await fixture();
      const helpers = Array.from(
        { length: 70 },
        (_, index) => `deep_${index} = { deep_${index + 1} = yes }`,
      );
      await writeFile(
        path.join(setup.mod, 'common/scripted_effects/pages.txt'),
        `page_entry = { deep_0 = yes }\n${helpers.join('\n')}\ndeep_70 = { country_event = { id = pages.2 } set_technology = { page_tech = 1 } }`,
      );
      const engine = await setup.engine();
      const materialized =
        domain === 'event'
          ? await new EventChainViewer(engine).inspect({ workspaceId: 'pages', mode: 'lint' })
          : await new TechnologyTreeViewer(engine).analyze({ workspaceId: 'pages', mode: 'lint' });
      expect(materialized.graph.complete).toBe(false);
      const input = {
        workspaceId: 'pages',
        mode: 'helper_expansion' as const,
        helperExpansion: { maxDepth: 128, maxRecords: 5_000, maxWork: 100_000 },
      };
      const expanded =
        domain === 'event'
          ? await new EventChainViewer(engine).inspect(input)
          : await new TechnologyTreeViewer(engine).analyze(input);
      expect(expanded.helperExpansion).toMatchObject({
        finished: true,
        complete: true,
        depthStops: 0,
      });
    },
  );

  it('rehydrates a chunked continuation and rejects changed on-disk cursor bytes', async () => {
    const setup = await fixture();
    const engine = new CoreEngine(await WorkspaceResolver.create(setup.configuration), {
      artifacts: new ArtifactStore(33_554_432, 5_000, 8_192),
    });
    const roots = Array.from(
      { length: 100 },
      (_, index) => `root-${String(index).padStart(3, '0')}-${'x'.repeat(120)}`,
    );
    const inventory: HelperExpansionInventory = {
      domain: 'event',
      sourceRevision: 'a'.repeat(64),
      sourceComplete: true,
      sourceHashes: {},
      roots,
      branches: ['helper'],
      edges: roots.map((id) => ({ id, from: 'entry', to: 'helper', evidence: {} })),
    };
    const first = await inspectHelperExpansion(engine, 'pages', inventory, {
      rootIds: roots,
      maxRecords: 1,
    });
    const cursor = first.artifacts[1]!;
    expect(JSON.parse(await readFile(cursor.path, 'utf8'))).toMatchObject({
      type: 'hoi4-agent.chunked-artifact',
    });
    const second = await inspectHelperExpansion(await setup.engine(), 'pages', inventory, {
      continuationUri: cursor.uri,
      maxRecords: 1,
    });
    expect(second.summary).toMatchObject({ totalRecords: 2, complete: false });
    await writeFile(cursor.path, '{}');
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, { continuationUri: cursor.uri }),
    ).rejects.toThrow();
  });

  it.each(['event', 'technology'] as const)(
    'recreates the %s service between pages and preserves every structural conditional path and leaf',
    async (domain) => {
      const setup = await fixture();
      const inspect = async (helperExpansion = {}) => {
        const engine = await setup.engine();
        const input = { workspaceId: 'pages', mode: 'helper_expansion' as const, helperExpansion };
        return domain === 'event'
          ? new EventChainViewer(engine).inspect(input)
          : new TechnologyTreeViewer(engine).analyze(input);
      };
      const full = await inspect({ maxRecords: 5_000, maxWork: 100_000 });
      expect(full.helperExpansion).toMatchObject({
        finished: true,
        complete: true,
        sourceComplete: true,
      });
      expect(full.helperExpansion!.cycles).toBeGreaterThan(0);
      const expected = full.report as Report;
      const records: Report['records'] = [];
      const edges = new Map<string, Report['edges'][number]>();
      let continuationUri: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const output = await inspect({
          maxRecords: 2,
          maxWork: 7,
          ...(continuationUri === undefined ? {} : { continuationUri }),
        });
        const report = output.report as Report;
        records.push(...report.records);
        for (const edge of report.edges) edges.set(edge.id, edge);
        expect(report.records.length).toBeLessThanOrEqual(2);
        if (output.helperExpansion!.finished) {
          expect(output.helperExpansion!.complete).toBe(true);
          break;
        }
        continuationUri = output.helperExpansion!.continuationUri;
        expect(continuationUri).toMatch(/^hoi4-agent:\/\//u);
      }
      expect(records).toEqual(expected.records);
      expect([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...expected.edges].sort((a, b) => a.id.localeCompare(b.id)),
      );
      const leaf = expected.edges.find(({ evidence }) =>
        domain === 'event'
          ? evidence.access?.name === 'page_ready'
          : evidence.reference?.technologyId === 'page_tech',
      );
      expect(leaf).toBeDefined();
      if (domain === 'event')
        expect(
          expected.records
            .filter(({ kind, path }) => kind === 'terminal' && path.at(-1) === leaf!.id)
            .map(({ scopeEvidence }) => scopeEvidence),
        ).toEqual([
          expect.objectContaining({ declaredScope: 'unknown', resolvedScope: 'country' }),
          expect.objectContaining({ declaredScope: 'unknown', resolvedScope: 'country' }),
        ]);
      expect(
        expected.records.filter(
          ({ kind, path }) => kind === 'terminal' && path.at(-1) === leaf!.id,
        ),
      ).toHaveLength(2);
      if (domain === 'event')
        expect(
          expected.edges.filter(({ evidence }) => (evidence.edge?.conditions.length ?? 0) > 0)
            .length,
        ).toBeGreaterThan(1);
      const depth = await inspect({ maxDepth: 1, maxRecords: 5_000, maxWork: 100_000 });
      expect(depth.helperExpansion).toMatchObject({ finished: true, complete: false });
      expect(depth.helperExpansion!.depthStops).toBeGreaterThan(0);
      for (const [relative, original] of setup.sources)
        expect(await readFile(path.join(setup.mod, relative), 'utf8')).toBe(original);
    },
  );

  it.each(['event', 'technology'] as const)(
    'rejects stale %s continuation after an external same-length source edit',
    async (domain) => {
      const setup = await fixture();
      const engine = await setup.engine();
      const inspect = (helperExpansion = {}) =>
        domain === 'event'
          ? new EventChainViewer(engine).inspect({
              workspaceId: 'pages',
              mode: 'helper_expansion',
              helperExpansion,
            })
          : new TechnologyTreeViewer(engine).analyze({
              workspaceId: 'pages',
              mode: 'helper_expansion',
              helperExpansion,
            });
      const output = await inspect({ maxRecords: 1 });
      const source = path.join(setup.mod, 'common/scripted_effects/pages.txt');
      await writeFile(source, (await readFile(source, 'utf8')).replace('page_ready', 'page_later'));
      await expect(
        inspect({ continuationUri: output.helperExpansion!.continuationUri }),
      ).rejects.toMatchObject({ code: 'HELPER_CONTINUATION_STALE' });
    },
  );

  it('binds continuations to principal, domain, root selection, depth, and a validated authenticated resource', async () => {
    const setup = await fixture();
    const engine = await setup.engine();
    const inventory: HelperExpansionInventory = {
      domain: 'event',
      sourceRevision: 'a'.repeat(64),
      sourceComplete: true,
      sourceHashes: {},
      roots: ['root'],
      branches: ['helper'],
      edges: [
        { id: 'root', from: 'entry', to: 'helper', evidence: {} },
        { id: 'leaf', from: 'helper', to: 'exit', evidence: {} },
      ],
    };
    const result = await inspectHelperExpansion(
      engine,
      'pages',
      inventory,
      { maxRecords: 1, rootIds: ['root'] },
      'alice',
    );
    const next = { continuationUri: result.summary.continuationUri! };
    await expect(
      inspectHelperExpansion(await setup.engine(), 'pages', inventory, next, 'alice'),
    ).resolves.toMatchObject({ summary: { finished: true, complete: true } });
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, next, 'bob'),
    ).rejects.toMatchObject({ code: 'HELPER_CONTINUATION_SCOPE_MISMATCH' });
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, next, 'denied'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INACCESSIBLE' });
    await expect(
      inspectHelperExpansion(
        engine,
        'pages',
        { ...inventory, domain: 'technology' },
        next,
        'alice',
      ),
    ).rejects.toMatchObject({ code: 'HELPER_CONTINUATION_SCOPE_MISMATCH' });
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, { ...next, maxDepth: 1 }, 'alice'),
    ).rejects.toMatchObject({ code: 'HELPER_CONTINUATION_QUERY_MISMATCH' });
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, { ...next, rootIds: ['leaf'] }, 'alice'),
    ).rejects.toMatchObject({ code: 'HELPER_CONTINUATION_QUERY_MISMATCH' });
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, { rootIds: ['leaf'] }, 'alice'),
    ).rejects.toMatchObject({ code: 'HELPER_ROOT_UNKNOWN' });
    await expect(
      inspectHelperExpansion(
        engine,
        'pages',
        inventory,
        { continuationUri: result.artifacts[0]!.uri },
        'alice',
      ),
    ).rejects.toMatchObject({ code: 'HELPER_CONTINUATION_INVALID' });
    await expect(
      inspectHelperExpansion(engine, 'pages', inventory, {}, 'alice', AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const cancelled = await inspectHelperExpansion(engine, 'pages', inventory, next, 'alice');
    expect(cancelled.summary.finished).toBe(true);
    const partial = await inspectHelperExpansion(
      engine,
      'pages',
      { ...inventory, sourceComplete: false },
      {},
      'alice',
    );
    expect(partial.summary).toMatchObject({
      finished: true,
      complete: false,
      sourceComplete: false,
    });
  });

  it('accepts only dedicated helper-mode bounds and rejects silently ignored filters', () => {
    for (const schema of [eventInspectRequestSchema, technologyInspectRequestSchema]) {
      expect(
        schema.safeParse({
          workspaceId: 'pages',
          mode: 'helper_expansion',
          helperExpansion: { maxRecords: 1 },
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ workspaceId: 'pages', mode: 'scan', helperExpansion: {} }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ workspaceId: 'pages', mode: 'helper_expansion', maxDepth: 3 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          workspaceId: 'pages',
          mode: 'helper_expansion',
          helperExpansion: { maxWork: 100_001 },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          workspaceId: 'pages',
          mode: 'helper_expansion',
          helperExpansion: { command: 'ignored' },
        }).success,
      ).toBe(false);
    }
  });
});

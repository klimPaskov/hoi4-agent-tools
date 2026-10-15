import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createBmp } from '../../src/hoi4_agent_tools/map/bmp.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import * as validation from '../../src/hoi4_agent_tools/map/validation.js';
import * as operations from '../../src/hoi4_agent_tools/map/operations.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';

describe('new worlds in a fresh mod layered over game data', () => {
  it('reports the original generation blocker when the workspace has no prior raster', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-empty-world-'));
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [{ id: 'empty', name: 'Empty', root: mod }],
      }),
    );
    const result = await new AgentNudger(resolver).previewRewriteWithDiff({
      workspaceId: 'empty',
      operations: [
        {
          id: 'failed',
          kind: 'create_world',
          width: 256,
          height: 256,
          countries: [
            { tag: 'AAA', name: 'One' },
            { tag: 'AAA', name: 'Duplicate' },
          ],
        },
      ],
    });
    expect(result.validation.passed).toBe(false);
    expect(result.plan.blockers[0]?.code).toBe('MAP_WORLD_COUNTRY_TAG_INVALID');
    expect(result.bundle.changedProvinceIds).toEqual([]);
    expect(result.artifacts.map((a) => a.name)).toEqual([
      'map-validation.json',
      'map-generation-failure.json',
    ]);
  });
  it('retains source dependencies without validating or rendering the unrelated game baseline', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-fresh-world-')),
      mod = path.join(base, 'mod'),
      game = path.join(base, 'game');
    await mkdir(mod);
    await mkdir(path.join(game, 'map'), { recursive: true });
    await writeFile(
      path.join(game, 'map/default.map'),
      'definitions = "definition.csv"\nprovinces = "provinces.bmp"\n',
    );
    await writeFile(
      path.join(game, 'map/definition.csv'),
      '0;0;0;0;sea;false;ocean;0\n1;0;0;200;sea;false;ocean;0\n',
    );
    await writeFile(
      path.join(game, 'map/provinces.bmp'),
      createBmp({
        width: 256,
        height: 256,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: 256 * 256 }, () => ({ r: 0, g: 0, b: 200 })),
      }),
    );
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'state'),
        workspaces: [
          { id: 'fresh', name: 'Fresh', root: mod, gameRoot: game, includeGameDlc: false },
        ],
      }),
    );
    const nudger = new AgentNudger(resolver),
      spy = vi.spyOn(validation, 'validateMapAsync');
    try {
      const preview = await nudger.previewRewriteWithDiff({
        workspaceId: 'fresh',
        operations: [
          {
            id: 'world',
            kind: 'create_world',
            width: 256,
            height: 256,
            seed: 2,
            rivers: 0,
            countries: [{ tag: 'AAA', name: 'Aster' }],
          },
        ],
      });
      expect(preview.plan.blockers).toEqual([]);
      expect(preview.artifacts.some(({ name }) => name.startsWith('map-before.'))).toBe(false);
      expect(preview.beforeBundle).toBeUndefined();
      expect(preview.bundle.semantic.definitions).toEqual([]);
      expect(preview.filesScanned).toContain('game:map/provinces.bmp');
      expect(preview.artifacts.some(({ name }) => name === 'map-validation.json')).toBe(true);
      expect(spy.mock.calls.some(([index]) => index.provinceBitmapFile?.rootKind === 'game')).toBe(
        false,
      );
      const snapshot = await nudger.scan('fresh');
      const failed = vi.spyOn(operations, 'planMapOperationsAsync').mockResolvedValue({
        changes: [],
        allocations: [],
        diagnostics: [],
        operations: [],
        blockers: [
          {
            code: 'MAP_WORLD_UNREPRESENTABLE_TOPOLOGY',
            message: 'Synthetic failure',
            operationId: 'failed',
          },
        ],
        finalIndex: snapshot.index,
      });
      try {
        const failure = await nudger.previewRewriteWithDiff({
          workspaceId: 'fresh',
          operations: [{ id: 'failed', kind: 'create_world' }],
        });
        expect(failure.bundle.changedProvinceIds).toEqual([]);
        expect(failure.artifacts.map((a) => a.name)).toEqual([
          'map-validation.json',
          'map-generation-failure.json',
        ]);
      } finally {
        failed.mockRestore();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])(
    'journals repeated warnings with complete bounded evidence and retains hard failures (%s)',
    async (hardFailures) => {
      const base = await mkdtemp(path.join(tmpdir(), 'hoi4-warning-journal-')),
        mod = path.join(base, 'mod');
      await mkdir(mod);
      const resolver = await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(base, 'state'),
          workspaces: [{ id: 'warnings', name: 'Warnings', root: mod }],
        }),
      );
      const nudger = new AgentNudger(resolver);
      const diagnostics: Diagnostic[] = Array.from({ length: 500 }, (_, index) => ({
        code: 'MAP_REPEATED_WARNING',
        severity: 'warning',
        category: 'map',
        message: `Synthetic warning ${index}`,
      }));
      if (hardFailures)
        diagnostics.push(
          { code: 'MAP_ERROR', severity: 'error', category: 'map', message: 'First error' },
          { code: 'MAP_ERROR', severity: 'error', category: 'map', message: 'Second error' },
        );
      const planSpy = vi.spyOn(operations, 'planMapOperationsAsync').mockResolvedValue({
        changes: [
          {
            relativePath: 'probe.txt',
            content: Buffer.from('synthetic'),
            operationIds: ['world'],
          },
        ],
        diagnostics: [
          {
            code: 'MAP_WORLD_CREATED',
            severity: 'info',
            category: 'map',
            message: 'Synthetic plan information',
          },
        ],
        blockers: [],
        allocations: [],
        operations: [{ id: 'world', kind: 'create_world', summary: 'Synthetic world', data: {} }],
        finalIndex: MapWorkspaceIndex.build([]),
      });
      const validationSpy = vi
        .spyOn(validation, 'validateMapAsync')
        .mockResolvedValue({ passed: !hardFailures, checks: [], diagnostics });
      try {
        const planned = await nudger.plan({
          workspaceId: 'warnings',
          operations: [{ id: 'world', kind: 'create_world' }],
        });
        expect(planned.transaction.validation.passed).toBe(!hardFailures);
        expect(
          planned.transaction.diagnostics.filter(({ code }) => code === 'MAP_WORLD_CREATED'),
        ).toHaveLength(1);
        expect(
          planned.transaction.diagnostics.find(({ code }) => code === 'MAP_REPEATED_WARNING'),
        ).toMatchObject({ details: { occurrenceCount: 500 } });
        expect(
          planned.transaction.diagnostics.filter(({ severity }) => severity === 'error'),
        ).toHaveLength(hardFailures ? 2 : 0);
        const report = planned.transaction.artifacts.find(
          ({ name }) => name === 'map-validation.json',
        )!;
        const stored = await nudger.artifacts.readLogical(resolver.get('warnings'), report.uri, {
          mimeType: 'application/json',
          maxBytes: 2_000_000,
          maxChunks: 2,
        });
        const parsed = JSON.parse(stored.bytes.toString('utf8')) as {
          diagnosticCount: number;
          diagnostics: Diagnostic[];
          counts: { warning: number };
        };
        expect(parsed.diagnosticCount).toBe(hardFailures ? 503 : 501);
        expect(parsed.counts.warning).toBe(500);
        expect(parsed.diagnostics.filter(({ severity }) => severity === 'error')).toHaveLength(
          hardFailures ? 2 : 0,
        );
      } finally {
        planSpy.mockRestore();
        validationSpy.mockRestore();
      }
    },
  );
});

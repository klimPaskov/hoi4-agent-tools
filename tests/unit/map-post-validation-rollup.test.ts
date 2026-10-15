import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { postValidateTransaction } from '../../src/hoi4_agent_tools/core/domain-validation.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';

describe('post-write map validation warning evidence', () => {
  it.each([0, 105])(
    'summarizes repeated warnings and preserves failure semantics with %s errors',
    async (errorCount) => {
      const base = await mkdtemp(path.join(tmpdir(), 'hoi4-map-post-rollup-')),
        mod = path.join(base, 'mod');
      await mkdir(path.join(mod, 'map'), { recursive: true });
      await writeFile(path.join(mod, 'map/probe.txt'), 'value = 1\n');
      const resolver = await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(base, 'state'),
          workspaces: [{ id: 'post', name: 'Post', root: mod }],
        }),
      );
      const engine = new CoreEngine(resolver);
      const transaction = await engine.transactions.plan({
        workspaceId: 'post',
        operationKind: 'agent-nudger-map-changes',
        operations: [
          { id: 'world', kind: 'create_world', summary: 'Synthetic post-validation', data: {} },
        ],
        changes: [
          {
            relativePath: 'map/probe.txt',
            content: Buffer.from('value = 2\n'),
            operationIds: ['world'],
          },
        ],
        validate: async () => ({
          diagnostics: [],
          checks: [
            {
              id: 'synthetic-proposed-check',
              passed: true,
              message: 'Synthetic fixture bytes validated',
            },
          ],
        }),
      });
      await writeFile(path.join(mod, 'map/probe.txt'), 'value = 2\n');
      const diagnostics: Diagnostic[] = Array.from({ length: 500 }, (_, index) => ({
        code: 'MAP_WARNING',
        severity: 'warning',
        category: 'map',
        message: `Warning ${index}`,
      }));
      diagnostics.push(
        ...Array.from({ length: errorCount }, (_, index): Diagnostic => ({
          code: 'MAP_ERROR',
          severity: 'error',
          category: 'map',
          message: `Error ${index}`,
        })),
      );
      const validateSpy = vi.spyOn(AgentNudger.prototype, 'validate').mockResolvedValue({
        snapshot: {
          workspaceId: 'post',
          revision: '0'.repeat(64),
          files: [],
          index: MapWorkspaceIndex.build([]),
        },
        validation: { passed: errorCount === 0, diagnostics, checks: [] },
      });
      try {
        const result = await postValidateTransaction(engine, transaction, undefined, undefined);
        expect(result.artifacts).toHaveLength(1);
        const report = await engine.artifacts.readLogical(
          resolver.get('post'),
          result.artifacts[0]!.uri,
          { mimeType: 'application/json', maxBytes: 2_000_000, maxChunks: 2 },
        );
        const parsed = JSON.parse(report.bytes.toString('utf8')) as {
          diagnosticCount: number;
          diagnostics: Diagnostic[];
        };
        expect(parsed.diagnosticCount).toBe(500 + errorCount);
        expect(parsed.diagnostics.filter(({ severity }) => severity === 'error')).toHaveLength(
          errorCount,
        );
        if (errorCount === 0) {
          expect(result.diagnostics).toHaveLength(1);
          expect(result.diagnostics[0]).toMatchObject({
            code: 'MAP_WARNING',
            details: { occurrenceCount: 500 },
          });
          expect(result.checks.every(({ passed }) => passed)).toBe(true);
        } else {
          expect(result.diagnostics.some(({ severity }) => severity === 'blocker')).toBe(true);
          expect(result.checks.some(({ passed }) => !passed)).toBe(true);
          expect(result.diagnostics.at(-1)).toMatchObject({ details: { omittedHard: 6 } });
        }
      } finally {
        validateSpy.mockRestore();
      }
    },
  );
});

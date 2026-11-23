import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const operations = [{ id: 'op-1', kind: 'test', summary: 'test edit', data: {} }];
const passed = () =>
  Promise.resolve({
    diagnostics: [],
    checks: [{ id: 'synthetic', passed: true, message: 'Synthetic check passed' }],
  });

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-refused-rollback-'));
  const mod = path.join(base, 'mod');
  await mkdir(path.join(mod, 'common'), { recursive: true });
  for (const name of ['one', 'two', 'three'])
    await writeFile(path.join(mod, 'common', `${name}.txt`), `${name} = before\n`);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    }),
  );
  return { mod, manager: new TransactionManager(resolver) };
}

/** Every file below `root` whose name marks it as a rollback backup. */
async function backups(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.backup'))
      found.push(
        path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
      );
  return found.sort();
}

/**
 * Applies three edits while another writer appends to `common/two.txt` before post-write
 * validation, which then fails. Rollback must refuse: the appended bytes are not this
 * transaction's.
 */
async function refusedRollback() {
  const { mod, manager } = await setup();
  const plan = await manager.plan({
    workspaceId: 'test',
    operationKind: 'test',
    operations,
    changes: ['one', 'two', 'three'].map((name) => ({
      relativePath: `common/${name}.txt`,
      content: Buffer.from(`${name} = after\n`),
      operationIds: ['op-1'],
    })),
    validate: passed,
  });
  const refusal = await manager
    .apply('test', plan.transactionId, plan.planHash, {
      postValidate: async () => {
        await writeFile(path.join(mod, 'common', 'two.txt'), 'two = after\nlane = appended\n');
        return {
          diagnostics: [],
          checks: [{ id: 'synthetic', passed: false, message: 'Hash check failed' }],
        };
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  return { mod, manager, plan, refusal };
}

describe('a refused rollback', () => {
  it('removes the backups of files still at their after-bytes and names the rest', async () => {
    const { mod, manager, plan, refusal } = await refusedRollback();
    expect(refusal).toBeInstanceOf(ServiceError);
    expect(refusal).toMatchObject({
      code: 'TRANSACTION_ROLLBACK_STALE',
      details: { retainedBackupCount: 1, retainedBackups: ['common/two.txt'] },
    });
    // The applied files keep their result and lose their backups; the other writer's bytes stay.
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('one = after\n');
    expect(await readFile(path.join(mod, 'common', 'three.txt'), 'utf8')).toBe('three = after\n');
    expect(await readFile(path.join(mod, 'common', 'two.txt'), 'utf8')).toBe(
      'two = after\nlane = appended\n',
    );
    expect(await backups(path.join(mod, 'common'))).toEqual([
      `two.txt.hoi4-agent-${plan.transactionId}.backup`,
    ]);
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'failed',
      rollbackStatus: 'failed',
    });
  });

  it('lets its owner discard the failed journal and its remaining backups', async () => {
    const { mod, manager, plan } = await refusedRollback();
    await expect(
      manager.discardFailed('test', plan.transactionId, 'someone-else'),
    ).rejects.toThrow();
    await expect(manager.discardFailed('test', plan.transactionId)).resolves.toEqual({
      removedBackups: 1,
      retainedBackups: [],
    });
    expect(await backups(path.join(mod, 'common'))).toEqual([]);
    await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
    });
    expect(await readFile(path.join(mod, 'common', 'two.txt'), 'utf8')).toBe(
      'two = after\nlane = appended\n',
    );
  });

  it('refuses to discard a journal that did not fail', async () => {
    const { manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('one = after\n'),
          operationIds: ['op-1'],
        },
      ],
      validate: passed,
    });
    await expect(manager.discardFailed('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_STATE_INVALID',
    });
    await manager.apply('test', plan.transactionId, plan.planHash, { postValidate: passed });
    await expect(manager.discardFailed('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_STATE_INVALID',
    });
  });

  it.each([
    ['reclaims', 'at', 'two = after\n', true],
    ['keeps', 'not at', 'two = after\nlane = appended\n', false],
  ] as const)(
    '%s an expired failed journal when the workspace is %s its after-state',
    async (_verb, _relation, twoBytes, reclaimed) => {
      const { mod, manager, plan } = await refusedRollback();
      await writeFile(path.join(mod, 'common', 'two.txt'), twoBytes);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.expiresAt) + 1);
      try {
        // Planning prunes expired journals.
        await manager.plan({
          workspaceId: 'test',
          operationKind: 'test',
          operations,
          changes: [
            {
              relativePath: 'common/one.txt',
              content: Buffer.from('one = later\n'),
              operationIds: ['op-1'],
            },
          ],
          validate: passed,
        });
        if (reclaimed) {
          await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
            code: 'TRANSACTION_NOT_FOUND',
          });
          expect(await backups(path.join(mod, 'common'))).toEqual([]);
        } else {
          await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
            state: 'failed',
          });
          expect(await backups(path.join(mod, 'common'))).toHaveLength(1);
        }
      } finally {
        clock.mockRestore();
      }
    },
  );
});

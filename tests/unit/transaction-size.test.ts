import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  TRANSACTION_MAX_BATCH_FILES,
  TRANSACTION_MAX_FILES,
  TRANSACTION_MAX_PENDING_FILES,
  transactionBatchSize,
} from '../../src/hoi4_agent_tools/core/transaction-limits.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const checks = async () => ({
  diagnostics: [],
  checks: [{ id: 'synthetic', passed: true, message: 'Synthetic fixture' }],
});
const operations = [{ id: 'apply', kind: 'test', summary: 'Whole-tree apply', data: {} }];

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-transaction-size-'));
  const mod = path.join(base, 'mod');
  await mkdir(mod);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'state'),
      workspaces: [{ id: 'size', name: 'Size', root: mod }],
    }),
  );
  return { mod, manager: new TransactionManager(resolver) };
}

const changes = (count: number, round: string) =>
  Array.from({ length: count }, (_, index) => ({
    relativePath: `common/content/${Math.floor(index / 400)}/file_${index}.txt`,
    content: Buffer.from(`round = ${round}\nindex = ${index}\n`),
    operationIds: ['apply'],
  }));

describe('transaction size (ZR-5)', () => {
  it('keeps 16-file batches for ordinary rewrites and bounds the manifest writes of large ones', () => {
    expect(transactionBatchSize(1)).toBe(TRANSACTION_MAX_PENDING_FILES);
    expect(transactionBatchSize(1_024)).toBe(TRANSACTION_MAX_PENDING_FILES);
    expect(transactionBatchSize(5_051)).toBe(79);
    expect(Math.ceil(12_000 / transactionBatchSize(12_000))).toBeLessThanOrEqual(64);
    expect(transactionBatchSize(TRANSACTION_MAX_FILES)).toBeLessThanOrEqual(
      TRANSACTION_MAX_BATCH_FILES,
    );
  });

  it('names the exceeded limit and the remedy', async () => {
    const { manager } = await setup();
    const failure = await manager
      .plan({
        workspaceId: 'size',
        operationKind: 'test',
        operations,
        changes: changes(TRANSACTION_MAX_FILES + 1, 'over'),
        validate: checks,
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error & { code: string },
      );
    expect(failure).toMatchObject({ code: 'TRANSACTION_STRUCTURE_LIMIT' });
    if (failure === undefined) return;
    expect(failure.message).toContain(
      `${TRANSACTION_MAX_FILES + 1} files (limit ${TRANSACTION_MAX_FILES})`,
    );
    expect(failure.message).toContain('split the change');
  });

  it('applies more than 5,000 files in one transaction and rolls all of them back on failure', async () => {
    const { mod, manager } = await setup();
    const count = 5_051;
    const first = await manager.plan({
      workspaceId: 'size',
      operationKind: 'test',
      operations,
      changes: changes(count, 'one'),
      validate: checks,
    });
    await manager.apply('size', first.transactionId, first.planHash, { postValidate: checks });
    const second = await manager.plan({
      workspaceId: 'size',
      operationKind: 'test',
      operations,
      changes: changes(count, 'two'),
      validate: checks,
    });
    await expect(
      manager.apply('size', second.transactionId, second.planHash, {
        postValidate: () => Promise.reject(new Error('injected post-write failure')),
      }),
    ).rejects.toBeDefined();
    for (const index of [0, 2_525, count - 1])
      expect(
        await readFile(
          path.join(mod, `common/content/${Math.floor(index / 400)}/file_${index}.txt`),
          'utf8',
        ),
      ).toBe(`round = one\nindex = ${index}\n`);
    expect((await readdir(path.join(mod, 'common/content'))).length).toBe(Math.ceil(count / 400));
  }, 1_800_000);
});

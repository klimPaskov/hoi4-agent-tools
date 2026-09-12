import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { currentJobOwner } from '../../src/hoi4_agent_tools/core/job-store.js';
import {
  JobTransactions,
  type JobWriteCompletion,
} from '../../src/hoi4_agent_tools/core/job-transactions.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(content = 'value = after\n') {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-job-transactions-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'common'), { recursive: true });
  const target = path.join(mod, 'common', 'test.txt');
  await writeFile(target, 'value = before\n');
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    }),
  );
  const engine = new CoreEngine(resolver);
  const jobs = await JobService.create(resolver);
  const record = (
    await jobs.submit('test', {
      toolName: 'hoi4.focus_rewrite',
      arguments: {},
      mutation: true,
      requestKey: 'rewrite-1',
    })
  ).record;
  const scope = jobs.scope('test');
  const owner = currentJobOwner();
  await jobs.store.claim(scope, record.id, owner);
  const transaction = await engine.transactions.plan({
    workspaceId: 'test',
    operationKind: 'test',
    operations: [{ id: 'test', kind: 'test', summary: 'Synthetic core write', data: {} }],
    changes: [
      {
        relativePath: 'common/test.txt',
        content: Buffer.from(content),
        operationIds: ['test'],
      },
    ],
    validate: async () => ({
      diagnostics: [],
      checks: [{ id: 'synthetic', message: 'Synthetic core plan', passed: true }],
    }),
  });
  return {
    target,
    engine,
    jobs,
    scope,
    owner,
    record,
    transaction,
    execution: new JobTransactions(engine, jobs),
  };
}

describe('background transaction boundary', () => {
  it('does not apply a planned transaction while settling an execution-admission failure', async () => {
    const { target, engine, jobs, scope, owner, record, transaction, execution } = await fixture();
    await jobs.store.updateOwned(scope, record.id, owner.token, {
      transaction: { transactionId: transaction.transactionId, planHash: transaction.planHash },
      status: 'reconciling',
    });
    const apply = vi.spyOn(engine.transactions, 'apply');
    expect(
      await execution.reconcile('test', record.id, owner.token, undefined, undefined, false),
    ).toMatchObject({ status: 'failed', failure: { code: 'JOB_REWRITE_NOT_APPLIED' } });
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
  });
  it('records actual post-validation restoration without replaying a failed rewrite', async () => {
    const { target, engine, owner, record, transaction, execution } =
      await fixture('invalid = {\n');
    const apply = vi.spyOn(engine.transactions, 'apply');
    expect(await execution.execute('test', record.id, owner.token, transaction)).toMatchObject({
      status: 'failed',
      failure: { code: 'JOB_REWRITE_RESTORED' },
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
  });

  it('retrieves a committed journal outcome without invoking apply again', async () => {
    const { target, engine, jobs, scope, owner, record, transaction, execution } = await fixture();
    await jobs.store.updateOwned(scope, record.id, owner.token, {
      transaction: { transactionId: transaction.transactionId, planHash: transaction.planHash },
      status: 'reconciling',
    });
    await engine.transactions.apply('test', transaction.transactionId, transaction.planHash, {
      postValidate: async () => ({
        diagnostics: [],
        checks: [{ id: 'synthetic', passed: true, message: 'Synthetic post-validation' }],
      }),
    });
    const apply = vi.spyOn(engine.transactions, 'apply');
    expect(await execution.reconcile('test', record.id, owner.token)).toMatchObject({
      status: 'completed',
      result: { execution: 'applied', reconciled: true },
    });
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('value = after\n');
  });
  it('binds the authenticated journal before apply and records the completed result', async () => {
    const { target, engine, jobs, owner, record, transaction, execution } = await fixture();
    const recipe = { mode: 'apply', filesScanned: 1 };
    const original = engine.transactions.apply.bind(engine.transactions);
    const apply = vi.spyOn(engine.transactions, 'apply').mockImplementation(async (...args) => {
      expect(await jobs.get('test', record.id)).toMatchObject({
        transaction: {
          transactionId: transaction.transactionId,
          planHash: transaction.planHash,
        },
        writeRecipe: recipe,
      });
      return original(...args);
    });
    const result = await execution.execute(
      'test',
      record.id,
      owner.token,
      transaction,
      undefined,
      undefined,
      recipe,
      async (outcome, reconciled, persistedRecipe) => ({
        exact: true,
        outcome: outcome.outcome,
        reconciled,
        recipe: persistedRecipe ?? null,
      }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      result: {
        exact: true,
        outcome: 'applied',
        reconciled: false,
        recipe,
      },
    });
    expect(await readFile(target, 'utf8')).toBe('value = after\n');
    expect(apply).toHaveBeenCalledTimes(1);
    const journal = await engine.transactions.status('test', transaction.transactionId);
    expect(
      journal.executionArtifacts?.some(({ name }) => name.endsWith('.execution-validation.json')),
    ).toBe(true);
  });

  it('reconciles a lost result publication after commit without applying twice', async () => {
    const { target, engine, jobs, owner, record, transaction, execution } = await fixture();
    const recipe = { mode: 'apply', filesScanned: 1 };
    const apply = vi.spyOn(engine.transactions, 'apply');
    const update = jobs.store.updateOwned.bind(jobs.store);
    let failedPublication = false;
    vi.spyOn(jobs.store, 'updateOwned').mockImplementation(async (...args) => {
      if (args[3].status === 'completed' && !failedPublication) {
        failedPublication = true;
        throw new ServiceError('TEST_RESULT_DISCONNECT', 'Injected result publication failure');
      }
      return update(...args);
    });
    const completion: JobWriteCompletion = async (outcome, reconciled, persistedRecipe) => ({
      exact: true,
      outcome: outcome.outcome,
      reconciled,
      recipe: persistedRecipe ?? null,
    });
    expect(
      await execution.execute(
        'test',
        record.id,
        owner.token,
        transaction,
        undefined,
        undefined,
        recipe,
        completion,
      ),
    ).toMatchObject({
      status: 'completed',
      result: { exact: true, outcome: 'applied', reconciled: true, recipe },
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await readFile(target, 'utf8')).toBe('value = after\n');
  });

  it('resumes a bound planned transaction and does not create a replacement plan', async () => {
    const { engine, jobs, scope, owner, record, transaction, execution } = await fixture();
    await jobs.store.updateOwned(scope, record.id, owner.token, {
      transaction: { transactionId: transaction.transactionId, planHash: transaction.planHash },
      status: 'reconciling',
    });
    const plan = vi.spyOn(engine.transactions, 'plan');
    expect(await execution.reconcile('test', record.id, owner.token)).toMatchObject({
      status: 'completed',
      result: { execution: 'applied' },
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it('honors durable cancellation before source application', async () => {
    const { target, engine, jobs, owner, record, transaction, execution } = await fixture();
    await jobs.cancel('test', record.id);
    const apply = vi.spyOn(engine.transactions, 'apply');
    expect(await execution.execute('test', record.id, owner.token, transaction)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
  });

  it('rejects mismatched scope and stale execution tokens before touching source', async () => {
    const { target, engine, owner, record, transaction, execution } = await fixture();
    const apply = vi.spyOn(engine.transactions, 'apply');
    await expect(
      execution.execute('test', record.id, currentJobOwner().token, transaction),
    ).rejects.toMatchObject({ code: 'JOB_OWNER_CHANGED' });
    await expect(
      execution.execute('test', record.id, owner.token, { ...transaction, principal: 'other' }),
    ).rejects.toMatchObject({ code: 'JOB_TRANSACTION_SCOPE_MISMATCH' });
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
  });
});

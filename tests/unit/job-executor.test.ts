import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';
import { JobExecutor, JobOperations } from '../../src/hoi4_agent_tools/core/job-executor.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { currentJobOwner } from '../../src/hoi4_agent_tools/core/job-store.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-job-executor-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'common'), { recursive: true });
  const target = path.join(mod, 'common', 'test.txt');
  await writeFile(target, 'value = before\n');
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      maxConcurrentTools: 1,
      maxSharedTools: 1,
      workspaces: [{ id: 'test', name: 'Synthetic executor', root: mod }],
    }),
  );
  const engine = new CoreEngine(resolver);
  const jobs = await JobService.create(resolver);
  const operations = new JobOperations();
  return { target, engine, jobs, operations, executor: new JobExecutor(engine, jobs, operations) };
}
const emptyInput = z.object({}).strict();
const request = {
  toolName: 'hoi4.focus_inspect',
  mutation: false,
  arguments: {},
  requestKey: 'inspect-1',
};

describe('typed job execution', () => {
  it('keeps cancellation responsive while another job owns the only execution slot', async () => {
    const { jobs, operations, executor } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    operations.registerRead(request.toolName, emptyInput, async (_, context) => {
      calls += 1;
      entered();
      await delay(30_000, undefined, { signal: context.signal });
      return {};
    });
    const first = (await jobs.submit('test', request)).record;
    const firstRun = executor.run('test', first.id);
    await started;
    const second = (await jobs.submit('test', { ...request, requestKey: 'waiting' })).record;
    const secondRun = executor.run('test', second.id);
    try {
      await vi.waitFor(
        async () => {
          expect((await jobs.get('test', second.id)).status).toBe('running');
        },
        { timeout: 5000 },
      );
      await jobs.cancel('test', second.id);
      expect(await secondRun).toMatchObject({ status: 'cancelled' });
      expect(calls).toBe(1);
      expect((await jobs.get('test', first.id)).status).toBe('running');
    } finally {
      await jobs.cancel('test', first.id);
      await firstRun;
      await secondRun;
    }
  });
  it('runs a shared-core scan once for concurrent claimants and persists progress and output', async () => {
    const { engine, jobs, operations, executor } = await fixture();
    let calls = 0;
    operations.registerRead(request.toolName, emptyInput, async (_, context) => {
      calls += 1;
      const snapshot = await context.engine.scan(
        context.workspaceId,
        { patterns: ['common/test.txt'] },
        context.principal,
        context.signal,
      );
      await context.progress({
        completed: snapshot.files.length,
        message: 'Scanned synthetic source',
      });
      return {
        revision: snapshot.revision,
        files: snapshot.files.map(({ relativePath }) => relativePath),
      };
    });
    const { record } = await jobs.submit('test', request);
    const other = new JobExecutor(engine, jobs, operations);
    await Promise.all([executor.run('test', record.id), other.run('test', record.id)]);
    expect(calls).toBe(1);
    expect(await jobs.get('test', record.id)).toMatchObject({
      status: 'completed',
      progress: { completed: 1 },
      result: { files: ['common/test.txt'] },
    });
    expect((await executor.run('test', record.id)).status).toBe('completed');
    expect(calls).toBe(1);
  });

  it('finalizes a staged read result after its prior worker stops without rerunning analysis', async () => {
    const { jobs, operations, executor } = await fixture();
    let calls = 0;
    operations.registerRead(request.toolName, emptyInput, async () => {
      calls += 1;
      return { rerun: true };
    });
    const { record } = await jobs.submit('test', request);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await once(child, 'spawn');
    const owner = { ...currentJobOwner(), pid: child.pid! };
    const claimed = await jobs.store.claim(jobs.scope('test'), record.id, owner);
    const result = { recovered: true };
    await jobs.store.updateOwned(jobs.scope('test'), record.id, owner.token, {
      result,
      checkpoint: {
        sourceRevision: 'a'.repeat(64),
        cursor: 'result-ready',
        resultHash: hashCanonical(result),
      },
    });
    const stopped = once(child, 'close');
    child.kill();
    await stopped;

    expect(await executor.run('test', claimed.record.id)).toMatchObject({
      status: 'completed',
      result,
    });
    expect(calls).toBe(0);
  });

  it('cancels admitted work through durable control traffic and releases capacity', async () => {
    const { jobs, operations, executor } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    operations.registerRead(request.toolName, emptyInput, async (_, context) => {
      entered();
      await delay(30_000, undefined, { signal: context.signal });
      return { unreachable: true };
    });
    const { record } = await jobs.submit('test', request);
    const running = executor.run('test', record.id);
    await started;
    expect((await jobs.list('test')).records).toHaveLength(1);
    await jobs.cancel('test', record.id);
    expect(await running).toMatchObject({ status: 'cancelled', cancelRequested: true });
    operations.registerRead('hoi4.event_inspect', emptyInput, async () => ({ passed: true }));
    const next = (
      await jobs.submit('test', { ...request, toolName: 'hoi4.event_inspect', requestKey: 'next' })
    ).record;
    expect(await executor.run('test', next.id)).toMatchObject({
      status: 'completed',
      result: { passed: true },
    });
  });

  it('validates arguments and write classification without executing an incompatible operation', async () => {
    const { jobs, operations, executor } = await fixture();
    let calls = 0;
    operations.registerRead(request.toolName, emptyInput, async () => {
      calls += 1;
      return {};
    });
    const invalid = (await jobs.submit('test', { ...request, arguments: { unexpected: true } }))
      .record;
    expect(await executor.run('test', invalid.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'JOB_EXECUTION_FAILED' },
    });
    const mismatched = (
      await jobs.submit('test', { ...request, mutation: true, requestKey: 'write' })
    ).record;
    await expect(executor.run('test', mismatched.id)).rejects.toMatchObject({
      code: 'JOB_OPERATION_MISMATCH',
    });
    expect(calls).toBe(0);
  });

  it('executes prepared rewrites through the shared transaction boundary exactly once', async () => {
    const { target, jobs, operations, executor } = await fixture();
    let prepared = 0;
    operations.registerWrite(
      'hoi4.focus_rewrite',
      emptyInput,
      async (_, context) => {
        prepared += 1;
        return {
          transaction: await context.engine.transactions.plan({
            workspaceId: context.workspaceId,
            operationKind: 'test',
            operations: [{ id: 'change', kind: 'test', summary: 'Synthetic write', data: {} }],
            changes: [
              {
                relativePath: 'common/test.txt',
                content: Buffer.from('value = after\n'),
                operationIds: ['change'],
              },
            ],
            validate: async () => ({
              diagnostics: [],
              checks: [{ id: 'synthetic', passed: true, message: 'Synthetic core validation' }],
            }),
          }),
          recipe: { mode: 'apply', filesScanned: 1 },
        };
      },
      async (_, execution, reconciled, recipe) => ({
        exact: true,
        execution: execution.outcome,
        reconciled,
        recipe: recipe ?? null,
      }),
    );
    const write = {
      toolName: 'hoi4.focus_rewrite',
      mutation: true,
      arguments: {},
      requestKey: 'write',
    };
    const { record } = await jobs.submit('test', write);
    const completed = await executor.run('test', record.id);
    expect(completed.failure).toBeUndefined();
    expect(completed).toMatchObject({
      status: 'completed',
      result: {
        exact: true,
        execution: 'applied',
        reconciled: false,
        recipe: { mode: 'apply', filesScanned: 1 },
      },
    });
    const retried = await jobs.submit('test', write);
    expect(await executor.run('test', retried.record.id)).toMatchObject({ status: 'completed' });
    expect(prepared).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('value = after\n');
  });

  it('reclaims a committed rewrite after worker death and finalizes it without replanning', async () => {
    const { target, engine, jobs, operations, executor } = await fixture();
    let prepared = 0;
    operations.registerWrite(
      'hoi4.focus_rewrite',
      emptyInput,
      async () => {
        prepared += 1;
        throw new Error('A committed transaction must never be replanned');
      },
      async (_input, execution, reconciled, recipe) => ({
        exact: true,
        execution: execution.outcome,
        reconciled,
        recipe: recipe ?? null,
      }),
    );
    const { record } = await jobs.submit('test', {
      toolName: 'hoi4.focus_rewrite',
      mutation: true,
      arguments: {},
      requestKey: 'recover-committed-write',
    });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await once(child, 'spawn');
    const owner = { ...currentJobOwner(), pid: child.pid! };
    await jobs.store.claim(jobs.scope('test'), record.id, owner);
    const transaction = await engine.transactions.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations: [{ id: 'change', kind: 'test', summary: 'Synthetic crash recovery', data: {} }],
      changes: [
        {
          relativePath: 'common/test.txt',
          content: Buffer.from('value = recovered\n'),
          operationIds: ['change'],
        },
      ],
      validate: async () => ({
        diagnostics: [],
        checks: [{ id: 'synthetic', passed: true, message: 'Synthetic plan validated' }],
      }),
    });
    const recipe = { mode: 'national', treeId: 'recovered_tree' };
    await jobs.store.updateOwned(jobs.scope('test'), record.id, owner.token, {
      transaction: { transactionId: transaction.transactionId, planHash: transaction.planHash },
      writeRecipe: recipe,
    });
    await engine.transactions.apply('test', transaction.transactionId, transaction.planHash, {
      postValidate: async () => ({
        diagnostics: [],
        checks: [{ id: 'synthetic-post', passed: true, message: 'Synthetic source validated' }],
      }),
    });
    const stopped = once(child, 'close');
    child.kill();
    await stopped;

    expect(await executor.run('test', record.id)).toMatchObject({
      status: 'completed',
      result: {
        exact: true,
        execution: 'applied',
        reconciled: true,
        recipe,
      },
    });
    expect(prepared).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('value = recovered\n');
  });
});

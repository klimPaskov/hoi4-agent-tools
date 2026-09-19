import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  JobStore,
  currentJobOwner,
  jobRetentionExpired,
  jobTaskTiming,
  publishJobRecord,
  type JobRecord,
  type JobRequest,
  type JobScope,
  type JobUpdate,
} from '../../src/hoi4_agent_tools/core/job-store.js';
import { ServerState } from '../../src/hoi4_agent_tools/core/server-state.js';
import { PACKAGE_VERSION } from '../../src/hoi4_agent_tools/version.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const scope: JobScope = {
  workspaceId: 'synthetic',
  workspaceIdentity: 'a'.repeat(64),
  rootFingerprint: 'b'.repeat(64),
  principal: 'alice',
};
const request: JobRequest = {
  toolName: 'hoi4.focus_rewrite',
  arguments: { relativePath: 'common/national_focus/tree.txt' },
  mutation: true,
  requestKey: 'clean-layout-1',
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-job-store-'));
  roots.push(root);
  const state = await ServerState.create(path.join(root, 'state'));
  return { root, state, store: await JobStore.create(state) };
}

async function writeAuthenticatedRecord(state: ServerState, record: JobRecord) {
  const directory = path.join(state.root, 'jobs', hashCanonical(record.scope));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${record.id}.json`);
  await writeFile(
    file,
    canonicalJson({
      record,
      authenticationTag: state.authenticateJournal({ kind: 'job-record.v1', record }),
    }),
  );
  return file;
}

/** A committed pre-hardening receipt, without using the current ID derivation. */
async function legacyReceipt(state: ServerState, toolVersion = PACKAGE_VERSION) {
  const now = new Date().toISOString();
  const record: JobRecord = {
    version: 1,
    id: `job_${hashCanonical({ scope, key: request.requestKey })}`,
    revision: 3,
    scope,
    request,
    requestHash: hashCanonical({ scope, request, toolVersion }),
    toolVersion,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    cancelRequested: false,
    result: { execution: 'applied', receipt: 'retained-original-result' },
  };
  return { record, file: await writeAuthenticatedRecord(state, record) };
}

describe('persistent job records', () => {
  it('retries only finite Windows sharing violations during atomic publication', async () => {
    const waits: number[] = [];
    let attempts = 0;
    await publishJobRecord('temporary', 'target', {
      platform: 'win32',
      publish: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    expect(attempts).toBe(3);
    expect(waits).toEqual([10, 10]);

    const busy = Object.assign(new Error('still busy'), { code: 'EBUSY' });
    await expect(
      publishJobRecord('temporary', 'target', {
        platform: 'win32',
        maxAttempts: 2,
        publish: async () => {
          throw busy;
        },
        wait: async () => undefined,
      }),
    ).rejects.toBe(busy);

    let nonWindowsAttempts = 0;
    await expect(
      publishJobRecord('temporary', 'target', {
        platform: 'linux',
        publish: async () => {
          nonWindowsAttempts += 1;
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        },
        wait: async () => undefined,
      }),
    ).rejects.toThrow('permission denied');
    expect(nonWindowsAttempts).toBe(1);
  });

  it('admits one execution owner and fences other attempts even when they share a PID', async () => {
    const { state, store } = await fixture();
    const { record } = await store.submit(scope, request);
    const owners = Array.from({ length: 16 }, () => currentJobOwner());
    const stores = await Promise.all(owners.map(() => JobStore.create(state)));
    const attempts = await Promise.allSettled(
      stores.map((value, index) => value.claim(scope, record.id, owners[index]!)),
    );
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const claimed = await store.get(scope, record.id);
    const other = owners.find(({ token }) => token !== claimed.owner!.token)!;
    await expect(
      store.updateOwned(scope, record.id, other.token, {
        progress: { completed: 1, message: 'stale' },
      }),
    ).rejects.toMatchObject({ code: 'JOB_OWNER_CHANGED' });
    expect(
      await store.updateOwned(scope, record.id, claimed.owner!.token, {
        progress: { completed: 1, message: 'owned' },
      }),
    ).toMatchObject({ progress: { completed: 1 } });
  });

  it('reclaims a stopped child process into reconciliation without replaying its request', async () => {
    const { store } = await fixture();
    const { record } = await store.submit(scope, request);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await once(child, 'spawn');
    try {
      const childOwner = { ...currentJobOwner(), pid: child.pid! };
      await store.claim(scope, record.id, childOwner);
      await expect(store.claim(scope, record.id, currentJobOwner())).rejects.toMatchObject({
        code: 'JOB_OWNER_ACTIVE',
      });
      const stopped = once(child, 'close');
      child.kill();
      await stopped;
      const parent = currentJobOwner();
      const recovered = await store.claim(scope, record.id, parent);
      expect(recovered).toMatchObject({
        recovery: true,
        record: { status: 'reconciling', owner: parent },
      });
      expect(recovered.record.request).toEqual(request);
      await expect(
        store.updateOwned(scope, record.id, childOwner.token, {
          status: 'failed',
          failure: { code: 'LATE', message: 'late child reply' },
        }),
      ).rejects.toMatchObject({ code: 'JOB_OWNER_CHANGED' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'close');
        child.kill();
        await stopped;
      }
    }
  });

  it('does not take over unverifiable remote ownership or restart terminal records', async () => {
    const { store } = await fixture();
    const { record } = await store.submit(scope, request);
    const remote = { ...currentJobOwner(), host: 'unverifiable-external-host.invalid' };
    await store.claim(scope, record.id, remote);
    await expect(store.claim(scope, record.id, currentJobOwner())).rejects.toMatchObject({
      code: 'JOB_OWNER_UNRESOLVED',
    });
    await store.updateOwned(scope, record.id, remote.token, {
      status: 'completed',
      result: { execution: 'applied' },
    });
    await expect(store.claim(scope, record.id, currentJobOwner())).rejects.toMatchObject({
      code: 'JOB_TERMINAL',
    });
  });
  it('does not create a job when cancellation precedes admission', async () => {
    const { store } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(store.submit(scope, request, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect((await store.submit(scope, request)).created).toBe(true);
  });

  it('rejects linked job directories without modifying the destination', async (context) => {
    const { state, root } = await fixture();
    await rm(path.join(state.root, 'jobs'), { recursive: true });
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel.txt'), 'untouched');
    try {
      await symlink(
        outside,
        path.join(state.root, 'jobs'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    await expect(JobStore.create(state)).rejects.toMatchObject({ code: 'JOB_RECORD_UNSAFE' });
    expect(await readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched');
  });
  it('deduplicates concurrent submissions across independent store instances and reopening', async () => {
    const { state, store } = await fixture();
    const stores = await Promise.all(Array.from({ length: 16 }, () => JobStore.create(state)));
    const results = await Promise.all(stores.map((value) => value.submit(scope, request)));
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ record }) => record.id)).size).toBe(1);
    const first = results[0]!.record;
    const reopened = await JobStore.create(await ServerState.create(state.root));
    expect(await reopened.get(scope, first.id)).toEqual(first);
    expect(await store.submit(scope, request)).toEqual({ record: first, created: false });
  });

  it('derives keyed IDs from private server state and a separate cryptographic domain', async () => {
    const first = await fixture();
    const second = await fixture();
    const { record } = await first.store.submit(scope, request);
    expect(record.id).toBe(
      `job_${first.state.authenticateJournal({
        kind: 'job-id.v2',
        scope,
        key: request.requestKey,
      })}`,
    );
    expect(record.id).not.toBe(`job_${hashCanonical({ scope, key: request.requestKey })}`);
    expect(record.id).not.toBe(
      `job_${first.state.authenticateJournal({ scope, key: request.requestKey })}`,
    );
    expect((await second.store.submit(scope, request)).record.id).not.toBe(record.id);
    const reopened = await JobStore.create(await ServerState.create(first.state.root));
    expect(await reopened.submit(scope, request)).toEqual({ record, created: false });
  });

  it('retains one pre-hardening committed receipt across concurrent retries and reopening', async () => {
    const { state, store } = await fixture();
    const { record, file } = await legacyReceipt(state);
    const originalBytes = await readFile(file);
    const stores = await Promise.all(
      Array.from({ length: 16 }, async () => JobStore.create(await ServerState.create(state.root))),
    );
    const results = await Promise.all(stores.map((value) => value.submit(scope, request)));
    for (const retry of results) expect(retry).toEqual({ record, created: false });
    expect(
      await store.submit(scope, {
        ...request,
        protocolTask: { ttl: 60_000, pollInterval: 250 },
      }),
    ).toEqual({ record, created: false });
    expect(await readFile(file)).toEqual(originalBytes);
    expect((await store.list(scope)).records).toEqual([record]);
  });

  it.each(['inputs', 'tool', 'version'] as const)(
    'rejects conflicting %s when retrying a pre-hardening receipt',
    async (changed) => {
      const { state, store } = await fixture();
      const { record, file } = await legacyReceipt(
        state,
        changed === 'version' ? '0.0.0-previous' : PACKAGE_VERSION,
      );
      const originalBytes = await readFile(file);
      const conflicting = {
        ...request,
        ...(changed === 'inputs' ? { arguments: { relativePath: 'other.txt' } } : {}),
        ...(changed === 'tool' ? { toolName: 'hoi4.gui_rewrite' } : {}),
      };
      await expect(store.submit(scope, conflicting)).rejects.toMatchObject({
        code: 'JOB_REQUEST_KEY_CONFLICT',
      });
      expect(await readFile(file)).toEqual(originalBytes);
      expect((await store.list(scope)).records).toEqual([record]);
    },
  );

  it.each(['authentication', 'json', 'request-hash'] as const)(
    'does not create a new execution when a legacy receipt has invalid %s',
    async (damage) => {
      const { state, store } = await fixture();
      const { record, file } = await legacyReceipt(state);
      if (damage === 'json') await writeFile(file, '{broken');
      else if (damage === 'authentication')
        await writeFile(file, canonicalJson({ record, authenticationTag: '0'.repeat(64) }));
      else await writeAuthenticatedRecord(state, { ...record, requestHash: '0'.repeat(64) });
      const damagedBytes = await readFile(file);
      await expect(store.submit(scope, request)).rejects.toMatchObject({
        code: 'JOB_RECORD_INVALID',
      });
      expect(await readFile(file)).toEqual(damagedBytes);
      const newId = `job_${state.authenticateJournal({
        kind: 'job-id.v2',
        scope,
        key: request.requestKey,
      })}`;
      await expect(store.get(scope, newId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    },
  );

  it('refuses to select or merge two retained records for the same retry key', async () => {
    const { state, store } = await fixture();
    const { record: current } = await store.submit(scope, request);
    const { record: legacy, file } = await legacyReceipt(state);
    const originalBytes = await readFile(file);
    await expect(store.submit(scope, request)).rejects.toMatchObject({
      code: 'JOB_REQUEST_KEY_AMBIGUOUS',
    });
    expect(await store.get(scope, current.id)).toEqual(current);
    expect(await store.get(scope, legacy.id)).toEqual(legacy);
    expect(await readFile(file)).toEqual(originalBytes);
  });

  it.each(['current', 'legacy'] as const)(
    'does not bypass a damaged %s record by selecting another generation',
    async (generation) => {
      const { state, store } = await fixture();
      const { record: current } = await store.submit(scope, request);
      const { record: legacy } = await legacyReceipt(state);
      const damaged = generation === 'current' ? current : legacy;
      const retained = generation === 'current' ? legacy : current;
      const file = path.join(state.root, 'jobs', hashCanonical(scope), `${damaged.id}.json`);
      await writeFile(file, canonicalJson({ record: damaged, authenticationTag: '0'.repeat(64) }));
      const damagedBytes = await readFile(file);
      await expect(store.submit(scope, request)).rejects.toMatchObject({
        code: 'JOB_RECORD_INVALID',
      });
      expect(await store.get(scope, retained.id)).toEqual(retained);
      expect(await readFile(file)).toEqual(damagedBytes);
    },
  );

  it('deduplicates a rewrite independently of protocol polling and retention hints', async () => {
    const { store } = await fixture();
    const keyed = { ...request, requestKey: 'transport-independent-rewrite' };
    const first = await store.submit(scope, {
      ...keyed,
      protocolTask: { ttl: 60_000, pollInterval: 250 },
    });
    const second = await store.submit(scope, {
      ...keyed,
      protocolTask: { ttl: 120_000, pollInterval: 1_000 },
    });
    expect(second).toEqual({ record: first.record, created: false });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'renews only visibility for an expired %s rewrite on an exact concurrent retry',
    async (status) => {
      const { state, store } = await fixture();
      const keyed = { ...request, protocolTask: { ttl: 1_000, pollInterval: 250 } };
      const { record } = await store.submit(scope, keyed);
      const running = await store.update(scope, record.id, record.revision, { status: 'running' });
      const original = await store.update(scope, record.id, running.revision, {
        status,
        ...(status === 'completed' ? { result: { execution: 'applied' } } : {}),
        ...(status === 'failed'
          ? { failure: { code: 'TEST_FAILURE', message: 'Retained failure' } }
          : {}),
      });
      const now = Date.parse(original.updatedAt) + 1_001;
      expect(Date.parse(original.createdAt) + jobTaskTiming(original).ttl!).toBe(
        Date.parse(original.updatedAt) + keyed.protocolTask.ttl,
      );
      vi.spyOn(Date, 'now').mockReturnValue(now);
      expect(jobRetentionExpired(original)).toBe(true);
      expect(await store.get(scope, original.id)).toEqual(original);
      await expect(
        store.submit(scope, { ...keyed, arguments: { changed: true } }),
      ).rejects.toMatchObject({ code: 'JOB_REQUEST_KEY_CONFLICT' });
      expect(await store.get(scope, original.id)).toEqual(original);
      const stores = await Promise.all(Array.from({ length: 8 }, () => JobStore.create(state)));
      const retried = await Promise.all(
        stores.map((value) =>
          value.submit(scope, {
            ...keyed,
            protocolTask: { ttl: 60_000, pollInterval: 500 },
          }),
        ),
      );
      const renewed = retried[0]!.record;
      for (const retry of retried) expect(retry).toEqual({ record: renewed, created: false });
      const { taskVisibility, revision, ...preserved } = renewed;
      expect({ ...preserved, revision: original.revision }).toEqual(original);
      expect(revision).toBe(original.revision + 1);
      expect(taskVisibility).toEqual({
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      });
      expect(jobTaskTiming(renewed)).toEqual({
        lastUpdatedAt: new Date(now).toISOString(),
        ttl: now + 60_000 - Date.parse(original.createdAt),
      });
      expect(jobRetentionExpired(renewed, now + 59_999)).toBe(false);
      expect(jobRetentionExpired(renewed, now + 60_000)).toBe(true);
      const reopened = await JobStore.create(await ServerState.create(state.root));
      expect(await reopened.get(scope, original.id)).toEqual(renewed);
      // Metadata reads and non-task receipts do not silently renew a task's visibility.
      vi.mocked(Date.now).mockReturnValue(now + 60_001);
      expect(await reopened.submit(scope, request)).toEqual({ record: renewed, created: false });
      await expect(reopened.claim(scope, original.id, currentJobOwner())).rejects.toMatchObject({
        code: 'JOB_TERMINAL',
      });
    },
  );

  it('does not renew expired read-only records or allow generic visibility updates', async () => {
    const { store } = await fixture();
    const keyed = {
      toolName: 'hoi4.event_inspect',
      arguments: {},
      mutation: false,
      requestKey: 'retained-read',
      protocolTask: { ttl: 1_000, pollInterval: 250 },
    };
    const { record } = await store.submit(scope, keyed);
    const running = await store.update(scope, record.id, record.revision, { status: 'running' });
    const original = await store.update(scope, record.id, running.revision, {
      status: 'completed',
      result: { read: true },
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.updatedAt) + 1_001);
    expect(await store.submit(scope, keyed)).toEqual({ record: original, created: false });
    expect(jobRetentionExpired(original)).toBe(true);
    await expect(
      store.update(scope, original.id, original.revision, {
        taskVisibility: { renewedAt: new Date().toISOString(), expiresAt: null },
      } as unknown as JobUpdate),
    ).rejects.toThrow();
    expect(await store.get(scope, original.id)).toEqual(original);
  });

  it.each(['read-only', 'non-terminal', 'reversed-range', 'pre-execution'] as const)(
    'rejects authenticated but structurally invalid %s task-visibility metadata',
    async (invalid) => {
      const { state, store } = await fixture();
      const { record } = await store.submit(scope, {
        ...request,
        mutation: invalid !== 'read-only',
        protocolTask: { ttl: 1_000, pollInterval: 250 },
      });
      const running = await store.update(scope, record.id, record.revision, { status: 'running' });
      const original =
        invalid === 'non-terminal'
          ? running
          : await store.update(scope, record.id, running.revision, {
              status: 'completed',
              result: { retained: true },
            });
      const now = Date.parse(original.updatedAt);
      await writeAuthenticatedRecord(state, {
        ...original,
        taskVisibility: {
          renewedAt: new Date(now + (invalid === 'pre-execution' ? -1 : 1)).toISOString(),
          expiresAt: new Date(now + (invalid === 'reversed-range' ? 0 : 60_000)).toISOString(),
        },
      });
      await expect(store.get(scope, record.id)).rejects.toMatchObject({
        code: 'JOB_RECORD_INVALID',
      });
    },
  );

  it('rejects changed inputs under the same request key and requires keys for writes', async () => {
    const { store } = await fixture();
    await store.submit(scope, request);
    await expect(
      store.submit(scope, { ...request, arguments: { relativePath: 'other.txt' } }),
    ).rejects.toMatchObject({ code: 'JOB_REQUEST_KEY_CONFLICT' });
    const { requestKey: _key, ...withoutKey } = request;
    await expect(store.submit(scope, withoutKey)).rejects.toThrow();
    const first = await store.submit(scope, { ...withoutKey, mutation: false });
    const second = await store.submit(scope, { ...withoutKey, mutation: false });
    expect(first.record.id).not.toBe(second.record.id);
  });

  it('isolates principals, workspaces, and changed root bindings', async () => {
    const { store } = await fixture();
    const { record } = await store.submit(scope, request);
    for (const changed of [
      { ...scope, principal: 'bob' },
      { ...scope, workspaceIdentity: 'c'.repeat(64) },
      { ...scope, rootFingerprint: 'd'.repeat(64) },
    ]) {
      await expect(store.get(changed, record.id)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
      const other = await store.submit(changed, request);
      expect(other.record.id).not.toBe(record.id);
    }
    await expect(store.get(scope, '../outside')).rejects.toThrow();
  });

  it('serializes updates and persists immutable transaction and result-recipe bindings', async () => {
    const { state, store } = await fixture();
    const { record } = await store.submit(scope, request);
    const second = await JobStore.create(state);
    const raced = await Promise.allSettled([
      store.update(scope, record.id, 1, { status: 'running' }),
      second.update(scope, record.id, 1, { status: 'running' }),
    ]);
    expect(raced.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(raced.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'JOB_REVISION_CONFLICT' },
    });
    const binding = {
      transactionId: 'txn_00000000-0000-0000-0000-000000000001',
      planHash: 'e'.repeat(64),
    };
    await expect(
      store.update(scope, record.id, 2, { writeRecipe: { mode: 'apply' } }),
    ).rejects.toThrow('A write result recipe requires a bound mutation transaction');
    const recipe = { mode: 'apply', filesScanned: 7 };
    const bound = await store.update(scope, record.id, 2, {
      transaction: binding,
      writeRecipe: recipe,
    });
    expect((await second.get(scope, record.id)).transaction).toEqual(binding);
    expect((await second.get(scope, record.id)).writeRecipe).toEqual(recipe);
    await expect(
      store.update(scope, record.id, bound.revision, {
        transaction: { ...binding, planHash: 'f'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'JOB_TRANSACTION_CONFLICT' });
    await expect(
      store.update(scope, record.id, bound.revision, {
        transaction: undefined,
      } as unknown as JobUpdate),
    ).rejects.toMatchObject({ code: 'JOB_TRANSACTION_CONFLICT' });
    await expect(
      store.update(scope, record.id, bound.revision, {
        writeRecipe: { ...recipe, filesScanned: 8 },
      }),
    ).rejects.toMatchObject({ code: 'JOB_WRITE_RECIPE_CONFLICT' });
  });

  it('preserves cancellation requests and cannot restart terminal jobs', async () => {
    const { store } = await fixture();
    let { record } = await store.submit(scope, request);
    record = await store.update(scope, record.id, record.revision, {
      status: 'running',
      cancelRequested: true,
    });
    await expect(
      store.update(scope, record.id, record.revision, { cancelRequested: false }),
    ).rejects.toMatchObject({ code: 'JOB_STATE_CONFLICT' });
    // A cancellation may arrive after a write committed: its actual result wins.
    record = await store.update(scope, record.id, record.revision, {
      status: 'completed',
      result: { execution: 'applied' },
    });
    await expect(
      store.update(scope, record.id, record.revision, { status: 'running' }),
    ).rejects.toMatchObject({ code: 'JOB_STATE_CONFLICT' });
    expect((await store.submit(scope, request)).record).toEqual(record);
  });

  it('rejects invalid outcomes, identity patches, read-only bindings, and progress', async () => {
    const { store } = await fixture();
    let { record } = await store.submit(scope, {
      toolName: 'hoi4.focus_inspect',
      arguments: {},
      mutation: false,
    });
    record = await store.update(scope, record.id, 1, { status: 'running' });
    for (const patch of [
      { status: 'completed' },
      { status: 'failed' },
      { progress: { completed: 2, total: 1, message: 'invalid' } },
      {
        transaction: {
          transactionId: 'txn_00000000-0000-0000-0000-000000000001',
          planHash: 'e'.repeat(64),
        },
      },
      { scope: { ...scope, principal: 'bob' } },
    ]) {
      await expect(
        store.update(scope, record.id, record.revision, patch as JobUpdate),
      ).rejects.toThrow();
      expect(await store.get(scope, record.id)).toEqual(record);
    }
  });

  it('rejects tampered records and keeps the last record when an update exceeds its byte budget', async () => {
    const { state, store } = await fixture();
    const { record } = await store.submit(scope, request);
    const bounded = await JobStore.create(state, 2048);
    await expect(
      bounded.update(scope, record.id, 1, {
        progress: { completed: 0, message: 'x'.repeat(3000) },
      }),
    ).rejects.toMatchObject({ code: 'JOB_RECORD_LIMIT' });
    expect(await store.get(scope, record.id)).toEqual(record);
    const file = path.join(state.root, 'jobs', hashCanonical(scope), `${record.id}.json`);
    const bytes = JSON.parse(await readFile(file, 'utf8')) as { record: { status: string } };
    bytes.record.status = 'running';
    await writeFile(file, JSON.stringify(bytes));
    await expect(store.get(scope, record.id)).rejects.toMatchObject({ code: 'JOB_RECORD_INVALID' });
  });
});

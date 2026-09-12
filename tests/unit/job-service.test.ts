import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-job-service-'));
  roots.push(root);
  const workspaces = [];
  for (const id of ['first', 'second', 'game']) {
    const folder = path.join(root, id);
    await mkdir(folder);
    workspaces.push({
      id,
      name: id,
      root: folder,
      kind: id === 'game' ? 'game' : 'mod',
      ...(id === 'game'
        ? {
            artifactRoot: path.join(root, 'storage', 'game-artifacts'),
            cacheRoot: path.join(root, 'storage', 'game-cache'),
          }
        : {}),
    });
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      storageRoots: [path.join(root, 'storage')],
      workspaces,
      http: {
        principals: [
          { principal: 'alice', workspaceIds: ['first', 'game'] },
          { principal: 'bob', workspaceIds: ['first', 'second'] },
        ],
      },
    }),
  );
  return JobService.create(resolver);
}
const request = { toolName: 'hoi4.focus_inspect', arguments: {}, mutation: false };

describe('authorized persistent job service', () => {
  it('authorizes every lookup, list, submission and cancellation through the resolver', async () => {
    const service = await fixture();
    const { record } = await service.submit('first', request, 'alice');
    await expect(service.submit('second', request, 'alice')).rejects.toThrow();
    await expect(service.get('first', record.id, 'bob')).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    await expect(service.cancel('first', record.id, 'bob')).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    expect((await service.list('first', 'bob')).records).toEqual([]);
    await expect(service.list('second', 'alice')).rejects.toThrow();
    expect((await service.get('first', record.id, 'alice')).status).toBe('queued');
  });

  it('rejects background writes to read-only game roots', async () => {
    const service = await fixture();
    await expect(
      service.submit(
        'game',
        { toolName: 'hoi4.focus_rewrite', arguments: {}, mutation: true, requestKey: 'rewrite' },
        'alice',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_WRITE_DISABLED' });
    expect((await service.submit('game', request, 'alice')).record.status).toBe('queued');
  });

  it('paginates all authorized jobs without retaining another workspace or skipping records', async () => {
    const service = await fixture();
    const expected: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      expected.push(
        (await service.submit('first', { ...request, requestKey: `case-${index}` }, 'alice')).record
          .id,
      );
    }
    await service.submit('second', request, 'bob');
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await service.list('first', 'alice', {
        limit: 3,
        ...(after === undefined ? {} : { after }),
      });
      expect(page.records.length).toBeLessThanOrEqual(3);
      found.push(...page.records.map(({ id }) => id));
      after = page.next;
    } while (after !== undefined);
    expect(found).toEqual(expected.sort());
    await expect(service.list('first', 'alice', { limit: 101 })).rejects.toMatchObject({
      code: 'JOB_PAGE_INVALID',
    });
  });

  it('makes queued cancellation terminal and running cancellation durable without inventing an outcome', async () => {
    const service = await fixture();
    const { record } = await service.submit('first', request, 'alice');
    const cancelled = await service.cancel('first', record.id, 'alice');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(await service.cancel('first', record.id, 'alice')).toEqual(cancelled);
    const second = (await service.submit('first', request, 'alice')).record;
    await service.store.update(service.scope('first', 'alice'), second.id, 1, {
      status: 'running',
    });
    expect(await service.cancel('first', second.id, 'alice')).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });
  });

  it('expires retained read tasks while preserving mutation retry receipts', async () => {
    const service = await fixture();
    const read = (
      await service.submit(
        'first',
        {
          ...request,
          requestKey: 'expiring-read',
          protocolTask: { ttl: 1, pollInterval: 250 },
        },
        'alice',
      )
    ).record;
    await service.cancel('first', read.id, 'alice');
    await delay(10);
    await expect(service.get('first', read.id, 'alice')).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    await expect(service.store.get(service.scope('first', 'alice'), read.id)).rejects.toMatchObject(
      {
        code: 'JOB_NOT_FOUND',
      },
    );

    const writeRequest = {
      toolName: 'hoi4.focus_rewrite',
      arguments: { value: 'same' },
      mutation: true as const,
      requestKey: 'durable-write-receipt',
      protocolTask: { ttl: 1, pollInterval: 250 },
    };
    const write = (await service.submit('first', writeRequest, 'alice')).record;
    await service.cancel('first', write.id, 'alice');
    await delay(10);
    expect(await service.get('first', write.id, 'alice')).toMatchObject({
      id: write.id,
      status: 'cancelled',
      requestHash: write.requestHash,
    });
    expect(await service.submit('first', writeRequest, 'alice')).toMatchObject({
      created: false,
      record: { id: write.id, status: 'cancelled' },
    });
    await expect(
      service.submit('first', { ...writeRequest, arguments: { value: 'different' } }, 'alice'),
    ).rejects.toMatchObject({ code: 'JOB_REQUEST_KEY_CONFLICT' });
  });
});

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const valid = async () => ({
  diagnostics: [],
  checks: [{ id: 'synthetic', passed: true, message: 'Synthetic fixture' }],
});
const operations = [{ id: 'test', kind: 'test', summary: 'Synthetic batch', data: {} }];
async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-batch-'));
  const mod = path.join(base, 'mod');
  await mkdir(mod);
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(base, 'state'),
    workspaces: [{ id: 'batch', name: 'Batch', root: mod }],
  });
  const configPath = path.join(base, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const resolver = await WorkspaceResolver.create(config);
  return { base, mod, configPath, resolver, manager: new TransactionManager(resolver) };
}
async function runCrash(configPath: string, request: object): Promise<number | null> {
  const requestPath = path.join(path.dirname(configPath), 'crash.json');
  await writeFile(requestPath, JSON.stringify({ configPath, ...request }));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve('tests/helpers/transaction-crash-child.ts'), requestPath],
      { stdio: 'ignore', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function rewriteAuthenticatedJournal(
  resolver: WorkspaceResolver,
  transactionId: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<string> {
  const workspace = resolver.get('batch');
  const file = path.join(workspace.cacheRoot, 'transactions', transactionId, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  update(manifest);
  manifest.revision = Number(manifest.revision) + 1;
  const {
    integrityHash: _integrityHash,
    authenticationTag: _authenticationTag,
    ...integrityPayload
  } = manifest;
  manifest.integrityHash = hashCanonical(integrityPayload);
  const { authenticationTag: _oldTag, ...authenticationPayload } = manifest;
  const state = resolver.serverState()!;
  manifest.authenticationTag = state.authenticateJournal(authenticationPayload);
  await writeFile(file, canonicalJson(manifest));
  await state.recordJournalSuccessor({
    workspaceIdentity: workspace.workspaceIdentity,
    transactionId,
    revision: Number(manifest.revision),
    authenticationTag: String(manifest.authenticationTag),
    manifestHash: hashCanonical(manifest),
  });
  return file;
}

describe('authenticated write-ahead replacement batches', () => {
  it.each(['intent', 'backup', 'replace', 'checkpoint'] as const)(
    'recovers a mixed create/update/delete batch after a crash at %s',
    async (crash) => {
      const { mod, configPath, manager } = await setup();
      await writeFile(path.join(mod, 'b-update.txt'), 'before update\n');
      await writeFile(path.join(mod, 'c-delete.txt'), 'before delete\n');
      expect(
        await runCrash(configPath, {
          crash,
          changes: [
            { relativePath: 'a-create.txt', content: 'created\n' },
            { relativePath: 'b-update.txt', content: 'after update\n' },
            { relativePath: 'c-delete.txt', content: null },
          ],
        }),
      ).toBe(73);
      const recovered = await manager.recover('batch');
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        version: 2,
        state: 'rolled_back',
        rollbackStatus: 'applied',
        pendingFiles: [],
      });
      await expect(readFile(path.join(mod, 'a-create.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path.join(mod, 'b-update.txt'), 'utf8')).toBe('before update\n');
      expect(await readFile(path.join(mod, 'c-delete.txt'), 'utf8')).toBe('before delete\n');
      expect(
        (await readdir(mod)).filter((name) => name.endsWith('.stage') || name.endsWith('.backup')),
      ).toEqual([]);
    },
  );

  it('keeps a matching external creation on an untouched pending path', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'batch',
      operationKind: 'batch-test',
      operations,
      changes: [
        {
          relativePath: 'new.txt',
          content: Buffer.from('matching bytes\n'),
          operationIds: ['test'],
        },
      ],
      validate: valid,
    });
    await expect(
      manager.apply('batch', plan.transactionId, plan.planHash, {
        postValidate: valid,
        hooks: {
          afterBatchIntent: async () => {
            await writeFile(path.join(mod, 'new.txt'), 'matching bytes\n');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_STALE' });
    expect(await readFile(path.join(mod, 'new.txt'), 'utf8')).toBe('matching bytes\n');
    expect(await manager.status('batch', plan.transactionId)).toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
    });
  });

  it('refuses rollback over an external edit after a source rename', async () => {
    const { mod, manager } = await setup();
    await writeFile(path.join(mod, 'existing.txt'), 'before\n');
    const plan = await manager.plan({
      workspaceId: 'batch',
      operationKind: 'batch-test',
      operations,
      changes: [
        { relativePath: 'existing.txt', content: Buffer.from('after\n'), operationIds: ['test'] },
      ],
      validate: valid,
    });
    await expect(
      manager.apply('batch', plan.transactionId, plan.planHash, {
        postValidate: valid,
        hooks: {
          afterReplace: async () => {
            await writeFile(path.join(mod, 'existing.txt'), 'external edit\n');
            throw new Error('Synthetic failure');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ROLLBACK_STALE' });
    expect(await readFile(path.join(mod, 'existing.txt'), 'utf8')).toBe('external edit\n');
  });

  it.each(['b-update.txt', 'c-delete.txt'])(
    'recovers a source rename for %s before its batch checkpoint',
    async (crashPath) => {
      const { mod, configPath, manager } = await setup();
      await writeFile(path.join(mod, 'b-update.txt'), 'before update\n');
      await writeFile(path.join(mod, 'c-delete.txt'), 'before delete\n');
      expect(
        await runCrash(configPath, {
          crash: 'replace',
          crashPath,
          changes: [
            { relativePath: 'a-create.txt', content: 'created\n' },
            { relativePath: 'b-update.txt', content: 'after update\n' },
            { relativePath: 'c-delete.txt', content: null },
          ],
        }),
      ).toBe(73);
      expect(await manager.recover('batch')).toMatchObject([
        { state: 'rolled_back', rollbackStatus: 'applied' },
      ]);
      await expect(readFile(path.join(mod, 'a-create.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path.join(mod, 'b-update.txt'), 'utf8')).toBe('before update\n');
      expect(await readFile(path.join(mod, 'c-delete.txt'), 'utf8')).toBe('before delete\n');
    },
  );

  it('reads and applies a version-one journal without inserting pending defaults', async () => {
    const { resolver, manager, mod } = await setup();
    await writeFile(path.join(mod, 'old.txt'), 'before\n');
    const plan = await manager.plan({
      workspaceId: 'batch',
      operationKind: 'legacy-test',
      operations,
      changes: [
        { relativePath: 'old.txt', content: Buffer.from('after\n'), operationIds: ['test'] },
      ],
      validate: valid,
    });
    await rewriteAuthenticatedJournal(resolver, plan.transactionId, (manifest) => {
      manifest.version = 1;
      const payload = manifest.planPayload as Record<string, unknown>;
      payload.version = 1;
      manifest.planHash = hashCanonical(payload);
      delete manifest.pendingFiles;
    });
    const legacy = await manager.status('batch', plan.transactionId);
    expect(Object.hasOwn(legacy, 'pendingFiles')).toBe(false);
    const applied = await manager.apply('batch', legacy.transactionId, legacy.planHash, {
      postValidate: valid,
    });
    expect(applied).toMatchObject({ version: 1, state: 'applied' });
    expect(Object.hasOwn(applied, 'pendingFiles')).toBe(false);
    expect(await readFile(path.join(mod, 'old.txt'), 'utf8')).toBe('after\n');
  });

  it.each(['identity', 'truncate'] as const)(
    'rejects tampered pending %s before recovering any source',
    async (tamper) => {
      const { mod, configPath, resolver, manager } = await setup();
      expect(
        await runCrash(configPath, {
          crash: 'intent',
          changes: [{ relativePath: 'a-create.txt', content: 'created\n' }],
        }),
      ).toBe(73);
      const journals = path.join(resolver.get('batch').cacheRoot, 'transactions');
      const transactionId = (await readdir(journals))[0]!;
      const file = path.join(journals, transactionId, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      if (tamper === 'truncate') manifest.pendingFiles = [];
      else
        (
          manifest.pendingFiles as Array<{ stagedIdentity: { inode: string } }>
        )[0]!.stagedIdentity.inode = '999';
      const { integrityHash: _hash, authenticationTag: _tag, ...payload } = manifest;
      manifest.integrityHash = hashCanonical(payload);
      await writeFile(file, canonicalJson(manifest));
      await expect(manager.recover('batch')).rejects.toMatchObject({
        code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
      });
      await expect(readFile(path.join(mod, 'a-create.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('rejects replay of a signed pending revision after batch completion', async () => {
    const { mod, resolver, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'batch',
      operationKind: 'replay-test',
      operations,
      changes: [
        { relativePath: 'new.txt', content: Buffer.from('created\n'), operationIds: ['test'] },
      ],
      validate: valid,
    });
    const file = path.join(
      resolver.get('batch').cacheRoot,
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    let old: Buffer | undefined;
    await manager.apply('batch', plan.transactionId, plan.planHash, {
      postValidate: valid,
      hooks: {
        afterBatchIntent: async () => {
          old = await readFile(file);
        },
      },
    });
    await writeFile(file, old!);
    await expect(manager.status('batch', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_REPLAY',
    });
    expect(await readFile(path.join(mod, 'new.txt'), 'utf8')).toBe('created\n');
  });
});

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/hoi4_agent_tools/core/artifacts.js';
import {
  canonicalJson,
  hashCanonical,
  sha256Bytes,
} from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import {
  TransactionManager,
  transactionRootFingerprint,
  type ApplyTransactionOptions,
  type PlanTransactionInput,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-transaction-'));
  const mod = path.join(base, 'mod');
  await mkdir(path.join(mod, 'common'), { recursive: true });
  await writeFile(path.join(mod, 'common', 'one.txt'), 'value = before\n');
  await writeFile(path.join(mod, 'map.bmp'), Buffer.from([0x42, 0x4d, 1, 2, 3, 4]));
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(base, 'server-state'),
    workspaces: [{ id: 'test', name: 'Test', root: mod }],
  });
  const resolver = await WorkspaceResolver.create(config);
  return { base, mod, resolver, manager: testManager(new TransactionManager(resolver)) };
}

const operations = [{ id: 'op-1', kind: 'test', summary: 'test edit', data: {} }];
const validDryRun: PlanTransactionInput['validate'] = () =>
  Promise.resolve({
    diagnostics: [],
    checks: [{ id: 'test-dry-run', passed: true, message: 'Synthetic plan validated' }],
  });
const validPostWrite: ApplyTransactionOptions['postValidate'] = () =>
  Promise.resolve({
    diagnostics: [],
    checks: [{ id: 'test-post-write', passed: true, message: 'Synthetic apply validated' }],
  });

type TestPlanInput = Omit<PlanTransactionInput, 'validate'> & {
  validate?: PlanTransactionInput['validate'];
};
type TestApplyOptions = Omit<ApplyTransactionOptions, 'postValidate'> & {
  postValidate?: ApplyTransactionOptions['postValidate'];
};

function testManager(core: TransactionManager) {
  return {
    core,
    plan: (input: TestPlanInput) =>
      core.plan({ ...input, validate: input.validate ?? validDryRun }),
    apply: (
      workspaceId: string,
      transactionId: string,
      expectedPlanHash: string,
      options: TestApplyOptions = {},
    ) =>
      core.apply(workspaceId, transactionId, expectedPlanHash, {
        ...options,
        postValidate: options.postValidate ?? validPostWrite,
      }),
    status: core.status.bind(core),
    recover: core.recover.bind(core),
  };
}

async function updateJournal(
  resolver: WorkspaceResolver,
  manifestPath: string,
  update: (manifest: Record<string, unknown>) => void,
  recordProtectedHead = true,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  update(manifest);
  manifest.revision = Number(manifest.revision) + 1;
  const {
    integrityHash: _integrityHash,
    authenticationTag: _authenticationTag,
    ...integrityPayload
  } = manifest;
  manifest.integrityHash = hashCanonical(integrityPayload);
  const { authenticationTag: _oldAuthenticationTag, ...authenticationPayload } = manifest;
  const serverState = resolver.serverState();
  if (serverState === undefined) throw new Error('missing test server state');
  manifest.authenticationTag = serverState.authenticateJournal(authenticationPayload);
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  const workspace = resolver.get(String(manifest.workspaceId));
  if (recordProtectedHead) {
    await serverState.recordJournalSuccessor({
      workspaceIdentity: workspace.workspaceIdentity,
      transactionId: String(manifest.transactionId),
      revision: Number(manifest.revision),
      authenticationTag: String(manifest.authenticationTag),
      manifestHash: hashCanonical(manifest),
    });
  }
}

async function tamperJournal(
  manifestPath: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  update(manifest);
  const {
    integrityHash: _integrityHash,
    authenticationTag: _authenticationTag,
    ...integrityPayload
  } = manifest;
  manifest.integrityHash = hashCanonical(integrityPayload);
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

describe('transaction manager', () => {
  it.runIf(process.platform !== 'win32')(
    'keeps case-distinct POSIX workspace roots bound to distinct fingerprints',
    async () => {
      const { resolver } = await setup();
      const workspace = resolver.get('test');
      const upper = {
        ...workspace,
        roots: workspace.roots.map((root, index) =>
          index === 0 ? { ...root, path: '/tmp/CaseSensitive/Mod' } : root,
        ),
      };
      const lower = {
        ...workspace,
        roots: workspace.roots.map((root, index) =>
          index === 0 ? { ...root, path: '/tmp/CaseSensitive/mod' } : root,
        ),
      };
      expect(transactionRootFingerprint(upper)).not.toBe(transactionRootFingerprint(lower));
    },
  );

  it('binds principal-scoped crash recovery to the manifest owner', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-principal-recovery-'));
    const mod = path.join(base, 'mod');
    await mkdir(path.join(mod, 'common'), { recursive: true });
    await writeFile(path.join(mod, 'common', 'one.txt'), 'before\n');
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
      http: {
        principals: [
          { principal: 'alice', workspaceIds: ['test'] },
          { principal: 'bob', workspaceIds: ['test'] },
        ],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const manager = testManager(new TransactionManager(resolver));
    const plan = await manager.plan({
      workspaceId: 'test',
      principal: 'alice',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('after\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await updateJournal(resolver, manifestPath, (manifest) => {
      manifest.state = 'applying';
    });
    await expect(manager.recover('test', 'bob')).rejects.toMatchObject({
      code: 'TRANSACTION_PRINCIPAL_MISMATCH',
    });
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('before\n');
    await expect(manager.recover('test', 'alice')).resolves.toMatchObject([
      { transactionId: plan.transactionId, state: 'rolled_back' },
    ]);
  });

  it('requires explicit dry-run and post-write validation callbacks', async () => {
    const { mod, manager } = await setup();
    const change = {
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('after\n'),
          operationIds: ['op-1'],
        },
      ],
    };
    await expect(
      manager.core.plan(change as unknown as PlanTransactionInput),
    ).rejects.toMatchObject({ code: 'TRANSACTION_DRY_RUN_VALIDATION_REQUIRED' });
    await expect(
      manager.core.plan({
        ...change,
        validate: () => Promise.resolve({ diagnostics: [], checks: [] }),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_DRY_RUN_VALIDATION_REQUIRED' });

    const plan = await manager.plan(change);
    await expect(
      manager.core.apply(
        'test',
        plan.transactionId,
        plan.planHash,
        undefined as unknown as ApplyTransactionOptions,
      ),
    ).rejects.toMatchObject({ code: 'TRANSACTION_POST_VALIDATION_REQUIRED' });
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = before\n');
    await expect(
      manager.core.apply('test', plan.transactionId, plan.planHash, {
        postValidate: () => Promise.resolve({ diagnostics: [], checks: [] }),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_POST_VALIDATION_REQUIRED' });
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = before\n');
  });

  it('does not retain diff artifacts when dry-run validation rejects a plan', async () => {
    const { resolver } = await setup();
    const artifactStore = new ArtifactStore();
    const manager = testManager(new TransactionManager(resolver, artifactStore));
    const workspace = resolver.get('test');
    const change = {
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('rejected proposal\n'),
          operationIds: ['op-1'],
        },
      ],
    };

    expect(await artifactStore.list(workspace)).toHaveLength(0);
    await expect(
      manager.plan({
        ...change,
        validate: async () => ({ diagnostics: [], checks: [] }),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_DRY_RUN_VALIDATION_REQUIRED' });
    expect(await artifactStore.list(workspace)).toHaveLength(0);

    await expect(
      manager.plan({
        ...change,
        validate: async () => {
          throw new Error('validator unavailable');
        },
      }),
    ).rejects.toThrow('validator unavailable');
    expect(await artifactStore.list(workspace)).toHaveLength(0);
  });

  it('rejects a transaction cache descendant that escapes through a symlink or junction', async () => {
    const { base, mod, manager } = await setup();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    try {
      await symlink(
        outside,
        path.join(mod, '.hoi4-agent', 'cache', 'transactions'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from('must not escape\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PATH_GENERATED_ROOT_ESCAPE' });
  });

  it('rejects transaction targets inside generated server storage', async () => {
    const { manager } = await setup();
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: '.hoi4-agent/cache/locks/write.lock/evil.txt',
            content: Buffer.from('must be rejected\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PATH_GENERATED_STORAGE_RESERVED' });
  });

  it('rejects distinct relative paths that resolve to one transaction target', async () => {
    const { manager } = await setup();
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from('first alias\n'),
            operationIds: ['op-1'],
          },
          {
            relativePath: 'common//one.txt',
            content: Buffer.from('second alias\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_DUPLICATE_FILE' });
  });

  it.runIf(process.platform === 'win32')(
    'rejects case aliases on a case-insensitive Windows workspace',
    async () => {
      const { manager } = await setup();
      await expect(
        manager.plan({
          workspaceId: 'test',
          operationKind: 'test',
          operations,
          changes: [
            {
              relativePath: 'common/one.txt',
              content: Buffer.from('first case\n'),
              operationIds: ['op-1'],
            },
            {
              relativePath: 'COMMON/ONE.TXT',
              content: Buffer.from('second case\n'),
              operationIds: ['op-1'],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_DUPLICATE_FILE' });
    },
  );

  it('dry-runs, requires hash-bound apply, and writes text and binary atomically', async () => {
    const { base, mod, manager } = await setup();
    const originalText = await readFile(path.join(mod, 'common', 'one.txt'));
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('value = after\n'),
          operationIds: ['op-1'],
        },
        {
          relativePath: 'map.bmp',
          content: Buffer.from([0x42, 0x4d, 9, 8, 7, 6]),
          operationIds: ['op-1'],
        },
      ],
      validate: async () => ({
        diagnostics: [],
        checks: [{ id: 'memory', passed: true, message: 'valid' }],
      }),
    });
    expect(JSON.stringify(plan.artifacts)).not.toContain(base);
    expect(plan.artifacts.every((artifact) => !('path' in artifact))).toBe(true);
    expect(plan.files.every(({ diffArtifact }) => !('path' in diffArtifact!))).toBe(true);
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(originalText);
    await expect(manager.apply('test', plan.transactionId, 'bad-hash')).rejects.toThrow();
    const applied = await manager.apply('test', plan.transactionId, plan.planHash, {
      postValidate: async () => ({
        diagnostics: [],
        checks: [{ id: 'post', passed: true, message: 'valid' }],
      }),
    });
    expect(applied.state).toBe('applied');
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = after\n');
    expect(await readFile(path.join(mod, 'map.bmp'))).toEqual(
      Buffer.from([0x42, 0x4d, 9, 8, 7, 6]),
    );
  });

  it('rejects stale source after planning', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('planned\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(path.join(mod, 'common', 'one.txt'), 'external edit\n');
    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_STALE',
    });
  });

  it('rechecks source immediately before replacement after staging work', async () => {
    const { mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('planned bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await expect(
      manager.apply('test', plan.transactionId, plan.planHash, {
        hooks: {
          afterStage: async () => writeFile(target, 'edit during staging\n'),
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ROLLBACK_STALE' });
    expect(await readFile(target, 'utf8')).toBe('edit during staging\n');
  });

  it('rejects a plan when a read-only game or dependency source changes', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-read-dependency-'));
    const mod = path.join(base, 'mod');
    const game = path.join(base, 'game');
    await mkdir(path.join(mod, 'common'), { recursive: true });
    await mkdir(path.join(game, 'map'), { recursive: true });
    const target = path.join(mod, 'common', 'one.txt');
    const source = path.join(game, 'map', 'definition.csv');
    await writeFile(target, 'before\n');
    const sourceBefore = Buffer.from('1;1;2;3;land;false;plains;1\n');
    await writeFile(source, sourceBefore);
    const config = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        {
          id: 'test',
          name: 'Test',
          root: mod,
          gameRoot: game,
        },
      ],
    });
    const manager = testManager(new TransactionManager(await WorkspaceResolver.create(config)));
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      readDependencies: [
        {
          rootKind: 'game',
          loadOrder: 0,
          relativePath: 'map/definition.csv',
          sha256: sha256Bytes(sourceBefore),
        },
      ],
      changes: [
        { relativePath: 'common/one.txt', content: Buffer.from('after\n'), operationIds: ['op-1'] },
      ],
    });
    await writeFile(source, '1;4;5;6;land;false;hills;1\n');

    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_SOURCE_STALE',
    });
    expect(await readFile(target, 'utf8')).toBe('before\n');
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'planned',
    });
  });

  it('rejects expired plans', async () => {
    const { manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('expired\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.expiresAt) + 1);
    try {
      await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
        code: 'TRANSACTION_EXPIRED',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('binds a transaction to its planning principal', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-principal-'));
    const mod = path.join(base, 'mod');
    await mkdir(path.join(mod, 'common'), { recursive: true });
    await writeFile(path.join(mod, 'common', 'one.txt'), 'before\n');
    const config = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
      http: {
        tokens: [
          { principal: 'alice', tokenEnv: 'ALICE_TOKEN', workspaceIds: ['test'] },
          { principal: 'bob', tokenEnv: 'BOB_TOKEN', workspaceIds: ['test'] },
        ],
      },
    });
    const manager = testManager(new TransactionManager(await WorkspaceResolver.create(config)));
    const plan = await manager.plan({
      workspaceId: 'test',
      principal: 'alice',
      operationKind: 'test',
      operations,
      changes: [
        { relativePath: 'common/one.txt', content: Buffer.from('after\n'), operationIds: ['op-1'] },
      ],
    });
    await expect(
      manager.apply('test', plan.transactionId, plan.planHash, { principal: 'bob' }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_PRINCIPAL_MISMATCH' });
    await expect(manager.status('test', plan.transactionId, 'bob')).rejects.toMatchObject({
      code: 'TRANSACTION_PRINCIPAL_MISMATCH',
    });
  });

  it('restores all files when apply fails between replacements', async () => {
    const { mod, manager } = await setup();
    const originalText = await readFile(path.join(mod, 'common', 'one.txt'));
    const originalBitmap = await readFile(path.join(mod, 'map.bmp'));
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('changed\n'),
          operationIds: ['op-1'],
        },
        { relativePath: 'map.bmp', content: Buffer.from([0x42, 0x4d, 5]), operationIds: ['op-1'] },
      ],
    });
    await expect(
      manager.apply('test', plan.transactionId, plan.planHash, {
        hooks: {
          afterReplace: async (_relativePath, index) => {
            if (index === 0) throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_APPLY_FAILED' });
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(originalText);
    expect(await readFile(path.join(mod, 'map.bmp'))).toEqual(originalBitmap);
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
      failure: { code: 'TRANSACTION_APPLY_FAILED', message: 'Transaction apply failed' },
    });
  });

  it('never overwrites an unknown concurrent edit during automatic rollback', async () => {
    const { base, mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('transaction bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await expect(
      manager.apply('test', plan.transactionId, plan.planHash, {
        hooks: {
          afterReplace: async () => {
            await writeFile(target, 'external concurrent edit\n');
            throw new Error(`sensitive path: ${base}`);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ROLLBACK_STALE' });
    expect(await readFile(target, 'utf8')).toBe('external concurrent edit\n');
    const status = await manager.status('test', plan.transactionId);
    expect(status).toMatchObject({
      state: 'failed',
      rollbackStatus: 'failed',
      failure: {
        code: 'TRANSACTION_ROLLBACK_STALE',
        message: 'Automatic rollback could not safely complete',
      },
    });
    expect(JSON.stringify(status)).not.toContain(base);
  });

  it('fails recovery closed when source no longer matches before or after bytes', async () => {
    const { mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('interrupted bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(target, 'unknown later bytes\n');
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await updateJournal(resolver, manifestPath, (manifest) => {
      manifest.state = 'applying';
      manifest.appliedFiles = ['common/one.txt'];
    });

    await expect(manager.recover('test')).rejects.toMatchObject({
      code: 'TRANSACTION_ROLLBACK_STALE',
    });
    expect(await readFile(target, 'utf8')).toBe('unknown later bytes\n');
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'failed',
      rollbackStatus: 'failed',
      failure: { code: 'TRANSACTION_ROLLBACK_STALE' },
    });
  });

  it('blocks a dry run with failed validation', async () => {
    const { manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('invalid\n'),
          operationIds: ['op-1'],
        },
      ],
      validate: async () => ({
        diagnostics: [],
        checks: [{ id: 'invalid', passed: false, message: 'invalid' }],
      }),
    });
    expect(plan.validation.passed).toBe(false);
    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_VALIDATION_BLOCKED',
    });
  });

  it('recovers an interrupted applying journal to the exact before state', async () => {
    const { mod, resolver, manager } = await setup();
    const original = await readFile(path.join(mod, 'common', 'one.txt'));
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('interrupted after bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(path.join(mod, 'common', 'one.txt'), 'interrupted after bytes\n');
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await updateJournal(resolver, manifestPath, (interrupted) => {
      interrupted.state = 'applying';
      interrupted.appliedFiles = ['common/one.txt'];
    });
    const recovered = await manager.recover('test');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ state: 'rolled_back', rollbackStatus: 'applied' });
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(original);
  });

  it('resumes a rolling-back blob restore after the target was unlinked', async () => {
    const { mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const original = await readFile(target);
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('applied before interrupted rollback\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await manager.apply('test', plan.transactionId, plan.planHash);
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await updateJournal(resolver, manifestPath, (manifest) => {
      manifest.state = 'rolling_back';
    });
    await rm(target);

    await expect(manager.recover('test')).resolves.toMatchObject([
      { transactionId: plan.transactionId, state: 'rolled_back', rollbackStatus: 'applied' },
    ]);
    expect(await readFile(target)).toEqual(original);
  });

  it('requires an intact before blob when recovering a missing rollback target', async () => {
    const { mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('applied before corrupt rollback\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await manager.apply('test', plan.transactionId, plan.planHash);
    const beforeBlob = plan.files[0]?.beforeBlob;
    if (beforeBlob === null || beforeBlob === undefined) throw new Error('missing before blob');
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await updateJournal(resolver, manifestPath, (manifest) => {
      manifest.state = 'rolling_back';
    });
    await writeFile(
      path.join(mod, '.hoi4-agent', 'cache', 'transactions', plan.transactionId, beforeBlob),
      'corrupt',
    );
    await rm(target);

    await expect(manager.recover('test')).rejects.toMatchObject({
      code: 'TRANSACTION_BLOB_INTEGRITY_FAILED',
    });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'failed',
      rollbackStatus: 'failed',
      failure: { code: 'TRANSACTION_BLOB_INTEGRITY_FAILED' },
    });
  });

  it('clears a crashed-process lock and recovers a configured workspace after restart', async () => {
    const { mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const original = await readFile(target);
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('interrupted after bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(target, 'interrupted after bytes\n');
    const cacheRoot = path.join(mod, '.hoi4-agent', 'cache');
    const manifestPath = path.join(cacheRoot, 'transactions', plan.transactionId, 'manifest.json');
    await updateJournal(resolver, manifestPath, (interrupted) => {
      interrupted.state = 'applying';
      interrupted.appliedFiles = ['common/one.txt'];
    });
    const lock = path.join(cacheRoot, 'locks', 'write.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({
        transactionId: plan.transactionId,
        pid: 2_147_483_647,
        host: hostname().toLowerCase(),
        instanceId: 'crashed-instance',
        processStartedAt: '2000-01-01T00:00:00.000Z',
      }),
    );

    const restartedConfiguration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(path.dirname(mod), 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(restartedConfiguration));
    await engine.initialize();

    expect(await readFile(target)).toEqual(original);
    await expect(engine.transactions.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
      failure: { code: 'TRANSACTION_RECOVERED' },
    });
  });

  it('does not clear a lock owned by a live process during recovery', async () => {
    const { mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const original = await readFile(target);
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('interrupted after bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(target, 'interrupted after bytes\n');
    const cacheRoot = path.join(mod, '.hoi4-agent', 'cache');
    const manifestPath = path.join(cacheRoot, 'transactions', plan.transactionId, 'manifest.json');
    await updateJournal(resolver, manifestPath, (interrupted) => {
      interrupted.state = 'applying';
      interrupted.appliedFiles = ['common/one.txt'];
    });
    const lock = path.join(cacheRoot, 'locks', 'write.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({
        transactionId: plan.transactionId,
        pid: process.pid,
        host: hostname().toLowerCase(),
        instanceId: 'live-instance',
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      }),
    );

    await expect(manager.recover('test')).rejects.toMatchObject({ code: 'TRANSACTION_LOCKED' });
    expect(await readFile(target, 'utf8')).toBe('interrupted after bytes\n');
    await rm(lock, { recursive: true, force: true });
    await expect(manager.recover('test')).resolves.toHaveLength(1);
    expect(await readFile(target)).toEqual(original);
  });

  it('clears an aged ownerless acquisition lock but not a fresh one', async () => {
    const { mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('applied after ownerless crash\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const lock = path.join(mod, '.hoi4-agent', 'cache', 'locks', 'write.lock');
    await mkdir(lock, { recursive: true });

    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_LOCKED',
    });
    expect(await readFile(target, 'utf8')).toBe('value = before\n');

    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await expect(manager.apply('test', plan.transactionId, plan.planHash)).resolves.toMatchObject({
      state: 'applied',
    });
    expect(await readFile(target, 'utf8')).toBe('applied after ownerless crash\n');
  });

  it('does not clear a lock whose owner belongs to another host', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('must remain planned\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const lock = path.join(mod, '.hoi4-agent', 'cache', 'locks', 'write.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({
        transactionId: plan.transactionId,
        pid: 2_147_483_647,
        host: 'different-host.example',
        instanceId: 'remote-instance',
        processStartedAt: '2000-01-01T00:00:00.000Z',
      }),
    );

    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_LOCKED',
    });
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = before\n');
  });

  it('recomputes the plan hash and rejects a changed persisted file set', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('planned bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await tamperJournal(manifestPath, (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      files[0]!.relativePath = 'common/tampered.txt';
    });

    await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
    });
    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
    });
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = before\n');
  });

  it('does not recover from a journal whose hash-bound plan was changed', async () => {
    const { mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('interrupted bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(target, 'interrupted bytes\n');
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await tamperJournal(manifestPath, (manifest) => {
      manifest.state = 'applying';
      manifest.appliedFiles = ['common/one.txt'];
      const files = manifest.files as Array<Record<string, unknown>>;
      files[0]!.relativePath = 'common/tampered.txt';
    });

    await expect(manager.recover('test')).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
    });
    expect(await readFile(target, 'utf8')).toBe('interrupted bytes\n');
  });

  it('rejects expiry extension even when every public hash is recomputed', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('expiry-bound\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await tamperJournal(manifestPath, (manifest) => {
      manifest.expiresAt = '2999-01-01T00:00:00.000Z';
    });
    await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
    });
  });

  it('rejects a forged plan and matching public integrity hashes', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('authenticated-plan\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await tamperJournal(manifestPath, (manifest) => {
      const planPayload = manifest.planPayload as Record<string, unknown>;
      const payloadFiles = planPayload.files as Array<Record<string, unknown>>;
      payloadFiles[0]!.relativePath = 'common/forged.txt';
      const files = manifest.files as Array<Record<string, unknown>>;
      files[0]!.relativePath = 'common/forged.txt';
      manifest.planHash = hashCanonical(planPayload);
    });
    await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
    });
  });

  it('rejects replay of an authenticated planned revision after automatic recovery', async () => {
    const { mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('replay-protected\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    const plannedManifest = await readFile(manifestPath);
    await writeFile(target, 'replay-protected\n');
    await updateJournal(resolver, manifestPath, (manifest) => {
      manifest.state = 'applying';
      manifest.appliedFiles = ['common/one.txt'];
    });
    await expect(manager.recover('test')).resolves.toMatchObject([
      { transactionId: plan.transactionId, state: 'rolled_back', rollbackStatus: 'applied' },
    ]);
    await writeFile(manifestPath, plannedManifest);

    await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_REPLAY',
    });
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
  });

  it('rejects unauthenticated tampering before restart recovery', async () => {
    const { base, mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('tampered-recovery\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(target, 'tampered-recovery\n');
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await tamperJournal(manifestPath, (manifest) => {
      manifest.state = 'applying';
      manifest.appliedFiles = ['common/one.txt'];
    });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    const restarted = new CoreEngine(await WorkspaceResolver.create(configuration));
    await expect(restarted.initialize()).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
    });
    expect(await readFile(target, 'utf8')).toBe('tampered-recovery\n');
  });

  it('reconciles only an authenticated immediate successor after a cache-first crash', async () => {
    const { base, mod, resolver, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('cache-first-crash\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await writeFile(target, 'cache-first-crash\n');
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    await updateJournal(
      resolver,
      manifestPath,
      (manifest) => {
        manifest.state = 'applying';
        manifest.appliedFiles = ['common/one.txt'];
      },
      false,
    );
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    const restarted = new CoreEngine(await WorkspaceResolver.create(configuration));
    const workspace = restarted.resolver.get('test');
    const headDirectory = path.join(
      base,
      'server-state',
      'transaction-heads',
      workspace.workspaceIdentity.slice(0, 2),
      workspace.workspaceIdentity,
      plan.transactionId,
    );
    const headBeforeStatus = await readdir(headDirectory);
    await expect(restarted.transactions.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_HEAD_RECONCILIATION_REQUIRED',
    });
    expect(await readdir(headDirectory)).toEqual(headBeforeStatus);
    await restarted.initialize();
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
    await expect(restarted.transactions.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
    });
  });

  it('cancels an in-flight pure transaction status load without changing its head', async () => {
    const { manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('status-cancellation\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const controller = new AbortController();
    const pending = manager.status('test', plan.transactionId, undefined, controller.signal);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      revision: 1,
      state: 'planned',
    });
  });

  it('serves bounded transaction-manifest ranges from verified canonical bytes', async () => {
    const { manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('manifest-range\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const first = await manager.core.readManifestRange('test', plan.transactionId, {
      offset: 0,
      length: 32,
    });
    const second = await manager.core.readManifestRange('test', plan.transactionId, {
      offset: 32,
      length: 32,
    });
    expect(first.totalSize).toBe(second.totalSize);
    expect(first.totalSize).toBeGreaterThan(64);
    expect(Buffer.concat([first.bytes, second.bytes]).toString('utf8')).toContain('{');
    await expect(
      manager.core.readManifestRange('test', plan.transactionId, {
        offset: 0,
        length: 1_048_577,
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_RANGE_INVALID' });
  });

  it('refuses an oversized planted transaction manifest before parsing it', async () => {
    const { mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('oversized-manifest\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const manifestPath = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      plan.transactionId,
      'manifest.json',
    );
    const validManifest = await readFile(manifestPath);
    await writeFile(
      manifestPath,
      Buffer.concat([validManifest, Buffer.alloc(16_777_217 - validManifest.length, 0x20)]),
    );
    await expect(manager.status('test', plan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_MANIFEST_LIMIT',
    });
  });

  it.each(['checks', 'diagnostics'] as const)(
    'rolls back when post-write %s would overflow the authenticated manifest',
    async (overflow) => {
      const { mod, manager } = await setup();
      const target = path.join(mod, 'common', 'one.txt');
      const plan = await manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from(`post-${overflow}-overflow\n`),
            operationIds: ['op-1'],
          },
        ],
        validate: async () => ({
          checks:
            overflow === 'checks'
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: `plan-check-${index}`,
                  passed: true,
                  message: 'bounded',
                }))
              : [{ id: 'plan-check', passed: true, message: 'bounded' }],
          diagnostics:
            overflow === 'diagnostics'
              ? Array.from({ length: 100 }, (_, index) => ({
                  code: `PLAN_WARNING_${index}`,
                  severity: 'warning' as const,
                  category: 'validation' as const,
                  message: 'bounded',
                }))
              : [],
        }),
      });
      await expect(
        manager.apply('test', plan.transactionId, plan.planHash, {
          postValidate: async () => ({
            checks: [{ id: 'post-check', passed: true, message: 'bounded' }],
            diagnostics:
              overflow === 'diagnostics'
                ? [
                    {
                      code: 'POST_WARNING',
                      severity: 'warning' as const,
                      category: 'validation' as const,
                      message: 'bounded',
                    },
                  ]
                : [],
          }),
        }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_STRUCTURE_LIMIT' });
      expect(await readFile(target, 'utf8')).toBe('value = before\n');
      const persisted = await manager.status('test', plan.transactionId);
      expect(persisted).toMatchObject({ state: 'rolled_back', rollbackStatus: 'applied' });
      expect(persisted.validation.checks.length).toBe(overflow === 'checks' ? 100 : 1);
      expect(persisted.diagnostics).toHaveLength(overflow === 'diagnostics' ? 100 : 0);
    },
  );

  it.each([
    'beforeManifestCacheWrite',
    'afterManifestCacheWrite',
    'beforeProtectedHeadCommit',
    'afterProtectedHeadCommit',
  ] as const)('rolls back without a revision gap after %s failure', async (boundary) => {
    const { mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('fault-boundary\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    let injected = false;
    const fault = async () => {
      if (injected) return;
      injected = true;
      throw new Error(`injected ${boundary}`);
    };
    await expect(
      manager.apply('test', plan.transactionId, plan.planHash, {
        hooks: { [boundary]: fault },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_APPLY_FAILED' });
    expect(await readFile(target, 'utf8')).toBe('value = before\n');
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
      revision: expect.any(Number),
    });
  });

  it('fails closed when proposed bytes are corrupt before apply', async () => {
    const { mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    const original = await readFile(target);
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('proposed bytes\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const afterBlob = plan.files[0]?.afterBlob;
    if (afterBlob === null || afterBlob === undefined) throw new Error('missing after blob');
    await writeFile(
      path.join(mod, '.hoi4-agent', 'cache', 'transactions', plan.transactionId, afterBlob),
      'corrupt',
    );

    await expect(manager.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_BLOB_INTEGRITY_FAILED',
    });
    expect(await readFile(target)).toEqual(original);
    await expect(manager.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'rolled_back',
      rollbackStatus: 'applied',
    });
  });

  it('enforces journal count and byte budgets before persisting a plan', async () => {
    const { resolver } = await setup();
    const artifactStore = new ArtifactStore();
    const countLimited = testManager(
      new TransactionManager(resolver, artifactStore, 3600, 16_777_216, 1),
    );
    await countLimited.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('first retained plan\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const retainedArtifacts = await artifactStore.list(resolver.get('test'));
    expect(retainedArtifacts).toHaveLength(1);
    await expect(
      countLimited.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from('second retained plan\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_JOURNAL_LIMIT' });
    expect(await artifactStore.list(resolver.get('test'))).toEqual(retainedArtifacts);

    const byteSetup = await setup();
    const byteArtifactStore = new ArtifactStore();
    const byteLimited = testManager(
      new TransactionManager(byteSetup.resolver, byteArtifactStore, 3600, 1_048_576, 128),
    );
    await expect(
      byteLimited.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.alloc(1_048_576, 0x61),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_JOURNAL_LIMIT' });
    expect(await byteArtifactStore.list(byteSetup.resolver.get('test'))).toHaveLength(0);
  });

  it('reclaims applied journals at autonomous admission', async () => {
    const { mod, resolver } = await setup();
    const manager = testManager(new TransactionManager(resolver, undefined, 3600, 16_777_216, 1));
    const appliedPlan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('autonomous applied\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await manager.apply('test', appliedPlan.transactionId, appliedPlan.planHash);
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from('autonomous next\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).resolves.toMatchObject({ state: 'planned' });
    await expect(manager.status('test', appliedPlan.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
    });
    await expect(readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).resolves.toBe(
      'autonomous applied\n',
    );
  });

  it('finishes a rename-first autonomous reclaim after restart', async () => {
    const { base, mod, resolver } = await setup();
    const manager = testManager(new TransactionManager(resolver, undefined, 3600, 16_777_216, 1));
    const applied = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('applied before reclaim crash\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await manager.apply('test', applied.transactionId, applied.planHash);

    const transactionsDirectory = path.join(mod, '.hoi4-agent', 'cache', 'transactions');
    await rename(
      path.join(transactionsDirectory, applied.transactionId),
      path.join(transactionsDirectory, `.reclaiming-${applied.transactionId}`),
    );

    const restartedConfiguration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    const restarted = new CoreEngine(await WorkspaceResolver.create(restartedConfiguration));
    await expect(restarted.initialize()).resolves.toBeUndefined();
    await expect(readdir(transactionsDirectory)).resolves.not.toContain(applied.transactionId);
    await expect(readdir(transactionsDirectory)).resolves.not.toContain(
      `.reclaiming-${applied.transactionId}`,
    );
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from('planned after reclaim recovery\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).resolves.toMatchObject({ state: 'planned' });
    await expect(readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).resolves.toBe(
      'applied before reclaim crash\n',
    );
  });

  it('prunes only expired safe terminal or planned journals before admission', async () => {
    const { resolver } = await setup();
    const manager = testManager(new TransactionManager(resolver, undefined, 60, 16_777_216, 1));
    const first = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('expiring plan\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.expiresAt) + 1);
    try {
      await expect(
        manager.plan({
          workspaceId: 'test',
          operationKind: 'test',
          operations,
          changes: [
            {
              relativePath: 'common/one.txt',
              content: Buffer.from('replacement plan\n'),
              operationIds: ['op-1'],
            },
          ],
        }),
      ).resolves.toMatchObject({ state: 'planned' });
      await expect(manager.status('test', first.transactionId)).rejects.toMatchObject({
        code: 'TRANSACTION_NOT_FOUND',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('binds plans to subsystem source-root configuration', async () => {
    const { base, mod, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('configuration-bound plan\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const changedConfiguration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        {
          id: 'test',
          name: 'Test',
          root: mod,
          roots: { focus: ['custom/focus'] },
        },
      ],
    });
    const restarted = testManager(
      new TransactionManager(await WorkspaceResolver.create(changedConfiguration)),
    );
    await expect(restarted.apply('test', plan.transactionId, plan.planHash)).rejects.toMatchObject({
      code: 'TRANSACTION_ROOT_CHANGED',
    });
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = before\n');
  });

  it('persists a private journal key and only the latest protected revision', async () => {
    const { base, mod, resolver, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('latest-head\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await manager.apply('test', plan.transactionId, plan.planHash);
    const key = await lstat(path.join(base, 'server-state', 'journal-hmac.key'));
    expect(key.isFile()).toBe(true);
    expect(key.size).toBe(32);
    if (process.platform !== 'win32') expect(key.mode & 0o777).toBe(0o600);

    const workspace = resolver.get('test');
    const headDirectory = path.join(
      base,
      'server-state',
      'transaction-heads',
      workspace.workspaceIdentity.slice(0, 2),
      workspace.workspaceIdentity,
      plan.transactionId,
    );
    expect((await readdir(headDirectory)).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    const restartedConfiguration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    const restarted = new TransactionManager(
      await WorkspaceResolver.create(restartedConfiguration),
    );
    await expect(restarted.status('test', plan.transactionId)).resolves.toMatchObject({
      state: 'applied',
    });
  });

  it('removes protected heads before pruning and rejects reintroduced cache manifests', async () => {
    const { mod, resolver } = await setup();
    const manager = testManager(new TransactionManager(resolver, undefined, 60, 16_777_216, 1));
    const first = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('orphaned-plan\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const firstDirectory = path.join(
      mod,
      '.hoi4-agent',
      'cache',
      'transactions',
      first.transactionId,
    );
    const savedManifest = await readFile(path.join(firstDirectory, 'manifest.json'));
    const workspace = resolver.get('test');
    await resolver
      .serverState()!
      .removeJournalHead(workspace.workspaceIdentity, first.transactionId);
    await expect(manager.status('test', first.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_HEAD_MISSING',
    });

    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [
          {
            relativePath: 'common/one.txt',
            content: Buffer.from('replacement-plan\n'),
            operationIds: ['op-1'],
          },
        ],
      }),
    ).resolves.toMatchObject({ state: 'planned' });
    await mkdir(firstDirectory, { recursive: true });
    await writeFile(path.join(firstDirectory, 'manifest.json'), savedManifest);
    await expect(manager.status('test', first.transactionId)).rejects.toMatchObject({
      code: 'TRANSACTION_HEAD_MISSING',
    });
  });

  it('bounds protected server state under repeated expiry churn', async () => {
    const { resolver } = await setup();
    const manager = testManager(new TransactionManager(resolver, undefined, 60, 16_777_216, 1));
    const clock = vi.spyOn(Date, 'now');
    let now = Date.now();
    clock.mockImplementation(() => now);
    try {
      for (let index = 0; index < 6; index += 1) {
        await manager.plan({
          workspaceId: 'test',
          operationKind: 'test',
          operations,
          changes: [
            {
              relativePath: 'common/one.txt',
              content: Buffer.from(`churn-${index}\n`),
              operationIds: ['op-1'],
            },
          ],
        });
        now += 61_000;
      }
      await expect(
        resolver
          .serverState()!
          .listJournalHeadTransactionIds(resolver.get('test').workspaceIdentity),
      ).resolves.toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('cleans a protected head whose cache journal is absent', async () => {
    const { mod, resolver, manager } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: Buffer.from('missing-cache\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    await rm(path.join(mod, '.hoi4-agent', 'cache', 'transactions', plan.transactionId), {
      recursive: true,
    });
    await expect(manager.recover('test')).resolves.toEqual([]);
    await expect(
      resolver.serverState()!.listJournalHeadTransactionIds(resolver.get('test').workspaceIdentity),
    ).resolves.toEqual([]);
  });

  it('rejects transaction collections beyond compact review limits', async () => {
    const { manager } = await setup();
    const change = {
      relativePath: 'common/one.txt',
      content: Buffer.from('bounded\n'),
      operationIds: ['op-1'],
    };
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations: Array.from({ length: 1_001 }, (_, index) => ({
          id: `op-${index}`,
          kind: 'test',
          summary: 'bounded',
          data: {},
        })),
        changes: [change],
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_STRUCTURE_LIMIT' });
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: Array.from({ length: 1_001 }, () => change),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_STRUCTURE_LIMIT' });
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [change],
        validate: async () => ({
          diagnostics: [],
          checks: Array.from({ length: 101 }, (_, index) => ({
            id: `check-${index}`,
            passed: true,
            message: 'bounded',
          })),
        }),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_STRUCTURE_LIMIT' });
    await expect(
      manager.plan({
        workspaceId: 'test',
        operationKind: 'test',
        operations,
        changes: [change],
        artifacts: Array.from({ length: 513 }, (_, index) => ({
          uri: `https://example.test/${index}`,
          name: `artifact-${index}`,
          mimeType: 'application/json',
        })),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_STRUCTURE_LIMIT' });
  });

  it('renders legacy source diffs with the detected encoding', async () => {
    const { mod, manager } = await setup();
    const target = path.join(mod, 'common', 'one.txt');
    await writeFile(target, iconv.encode('# café\r\nvalue = before\r\n', 'windows-1252'));
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: iconv.encode('# cafè\r\nvalue = after\r\n', 'windows-1252'),
          operationIds: ['op-1'],
        },
      ],
    });
    const artifact = plan.files[0]?.diffArtifact;
    if (artifact?.sha256 === undefined) throw new Error('missing source diff artifact');
    const diff = await readFile(
      path.join(
        mod,
        '.hoi4-agent',
        'artifacts',
        artifact.sha256.slice(0, 2),
        artifact.sha256,
        artifact.name,
      ),
      'utf8',
    );
    expect(diff).toContain('-# café');
    expect(diff).toContain('+# cafè');
    expect(diff).not.toContain('�');
    expect(diff).toContain('@@ -1,2 +1,2 @@');
  });

  it('describes create and delete diff provenance with hashes separated from absence state', async () => {
    const { resolver, manager } = await setup();
    const created = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/created.txt',
          content: Buffer.from('created\n'),
          operationIds: ['op-1'],
        },
      ],
    });
    const deleted = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        {
          relativePath: 'common/one.txt',
          content: null,
          operationIds: ['op-1'],
        },
      ],
    });
    const createdDiff = created.files[0]?.diffArtifact;
    const deletedDiff = deleted.files[0]?.diffArtifact;
    if (createdDiff === undefined || deletedDiff === undefined) throw new Error('missing diff');
    const workspace = resolver.get('test');
    const artifactStore = new ArtifactStore();
    await expect(artifactStore.describe(workspace, createdDiff.uri)).resolves.toMatchObject({
      provenance: {
        sourceHashes: { after: sha256Bytes(Buffer.from('created\n')) },
        metadata: { beforeState: 'missing', afterState: 'present' },
      },
    });
    await expect(artifactStore.describe(workspace, deletedDiff.uri)).resolves.toMatchObject({
      provenance: {
        sourceHashes: { before: sha256Bytes(Buffer.from('value = before\n')) },
        metadata: { beforeState: 'present', afterState: 'deleted' },
      },
    });
  });
});

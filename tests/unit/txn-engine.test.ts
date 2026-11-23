import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { canonicalJson, hashCanonical, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { callEngineOperation } from '../../src/hoi4_agent_tools/core/engine-operation.js';
import { ResidentEngine } from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  TransactionManager,
  transactionRootFingerprint,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

// ADR 0091, packet P2: the engine's atomic rewrite engine (`txn.apply`, `txn.recover`) writes the
// TypeScript journal format under the same key, heads and lock. A journal either side leaves
// interrupted is recovered by the other, and both reach the same bytes and refusal codes on a
// shared set of synthetic plans.

const engineAvailable = process.env.HOI4_ENGINE !== undefined;
const roots: string[] = [];
const engines: ResidentEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const appliedSchema = z.object({ changedPaths: z.array(z.string()) }).strict();
const recoveredSchema = z.object({ recovered: z.number().int().min(0) }).strict();
const operations = [{ id: 'op-1', kind: 'test', summary: 'test edit', data: {} }];
const checks = [{ id: 'test-check', passed: true, message: 'Synthetic plan validated' }];

/** The starting files of every fixture: CRLF text, a UTF-8 BOM and binary bytes. */
const START: Record<string, Buffer> = {
  'common/one.txt': Buffer.from('value = before\r\n'),
  'common/bom.txt': Buffer.from('﻿bom = 1\n'),
  'map.bmp': Buffer.from([0x42, 0x4d, 1, 2, 3, 4]),
};

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-txn-engine-'));
  roots.push(base);
  const mod = path.join(base, 'mod');
  for (const [relative, bytes] of Object.entries(START)) {
    await mkdir(path.dirname(path.join(mod, relative)), { recursive: true });
    await writeFile(path.join(mod, relative), bytes);
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Txn engine fixture', root: mod }],
    }),
  );
  const workspace = resolver.get('test');
  const serverState = resolver.serverState();
  if (serverState === undefined) throw new Error('missing test server state');
  const journalKey = (await readFile(path.join(serverState.root, 'journal-hmac.key'))).toString(
    'hex',
  );
  const binding = {
    workspaceId: 'test',
    workspaceIdentity: workspace.workspaceIdentity,
    rootFingerprint: transactionRootFingerprint(workspace),
    modRoot: workspace.modRoot,
    cacheRoot: workspace.cacheRoot,
    artifactRoot: workspace.artifactRoot,
    serverStateRoot: serverState.root,
    journalKey,
  };
  return { mod, resolver, workspace, manager: new TransactionManager(resolver), binding };
}

interface Change {
  path: string;
  before: Buffer | null;
  after: Buffer | null;
}

function engineApply(
  binding: Record<string, unknown>,
  changes: Change[],
  engine?: ResidentEngine,
): Promise<string[]> {
  return callEngineOperation({
    op: 'txn.apply',
    body: {
      ...binding,
      operationKind: 'test',
      changes: changes.map((change) => ({
        path: change.path,
        beforeSha256: change.before === null ? null : sha256Bytes(change.before),
        afterSize: change.after?.length ?? null,
      })),
    },
    payload: Buffer.concat(changes.flatMap((change) => (change.after === null ? [] : [change.after]))),
    result: appliedSchema,
    ...(engine === undefined ? {} : { engine }),
  }).then(({ result }) => result.changedPaths);
}

async function engineRecover(binding: Record<string, unknown>): Promise<number> {
  const { result } = await callEngineOperation({
    op: 'txn.recover',
    body: binding,
    result: recoveredSchema,
  });
  return result.recovered;
}

async function typescriptApply(
  manager: TransactionManager,
  changes: Change[],
  between?: () => Promise<void>,
): Promise<void> {
  const plan = await manager.plan({
    workspaceId: 'test',
    operationKind: 'test',
    operations,
    changes: changes.map((change) => ({
      relativePath: change.path,
      content: change.after,
      operationIds: ['op-1'],
    })),
    validate: () => Promise.resolve({ diagnostics: [], checks }),
  });
  await between?.();
  await manager.apply('test', plan.transactionId, plan.planHash, {
    postValidate: () => Promise.resolve({ diagnostics: [], checks }),
  });
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, full).replaceAll(path.sep, '/');
    if (relative.startsWith('.hoi4-agent/')) continue;
    files[relative] = (await readFile(full)).toString('hex');
  }
  return files;
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'OK';
  } catch (error) {
    return error instanceof ServiceError ? error.code : String(error);
  }
}

/** Ported from `updateJournal` of `transactions.test.ts`: an authenticated successor revision. */
async function updateJournal(
  resolver: WorkspaceResolver,
  manifestPath: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  update(manifest);
  manifest.revision = Number(manifest.revision) + 1;
  const { integrityHash: _i, authenticationTag: _a, ...integrityPayload } = manifest;
  manifest.integrityHash = hashCanonical(integrityPayload);
  const { authenticationTag: _t, ...authenticationPayload } = manifest;
  const serverState = resolver.serverState()!;
  manifest.authenticationTag = serverState.authenticateJournal(authenticationPayload);
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  await serverState.recordJournalSuccessor({
    workspaceIdentity: resolver.get('test').workspaceIdentity,
    transactionId: String(manifest.transactionId),
    revision: Number(manifest.revision),
    authenticationTag: String(manifest.authenticationTag),
    manifestHash: hashCanonical(manifest),
  });
}

/** The synthetic plans both engines run, each from the same starting files. */
const PARITY_CASES: Array<{
  name: string;
  changes: Change[];
  /** An edit made after the plan read its sources. */
  edit?: [string, Buffer];
}> = [
  {
    name: 'edit CRLF text, keep a BOM, write binary',
    changes: [
      { path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('value = after\r\n') },
      { path: 'common/bom.txt', before: START['common/bom.txt']!, after: Buffer.from('﻿bom = 2\n') },
      { path: 'map.bmp', before: START['map.bmp']!, after: Buffer.from([0x42, 0x4d, 9, 9]) },
    ],
  },
  {
    name: 'create in a new folder and delete',
    changes: [
      { path: 'events/new/created.txt', before: null, after: Buffer.from('created = yes\n') },
      { path: 'common/bom.txt', before: START['common/bom.txt']!, after: null },
    ],
  },
  {
    name: 'a source edited after planning',
    changes: [{ path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('x\n') }],
    edit: ['common/one.txt', Buffer.from('edited by the modder\n')],
  },
  {
    name: 'one file twice',
    changes: [
      { path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('a\n') },
      { path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('b\n') },
    ],
  },
  {
    name: 'two spellings of one file',
    changes: [
      { path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('a\n') },
      { path: 'common/./one.txt', before: START['common/one.txt']!, after: Buffer.from('b\n') },
    ],
  },
  {
    name: 'a parent segment',
    changes: [{ path: '../escape.txt', before: null, after: Buffer.from('x\n') }],
  },
  {
    name: 'generated storage',
    changes: [{ path: '.hoi4-agent/cache/x.txt', before: null, after: Buffer.from('x\n') }],
  },
  {
    name: 'a device name',
    changes: [{ path: 'common/nul.txt', before: null, after: Buffer.from('x\n') }],
  },
  {
    name: 'nothing changes',
    changes: [{ path: 'common/one.txt', before: START['common/one.txt']!, after: START['common/one.txt']! }],
  },
];

describe.skipIf(!engineAvailable)('the engine rewrite journal (txn.apply, txn.recover)', () => {
  it.each(PARITY_CASES)('reaches the TypeScript outcome: $name', async ({ changes, edit }) => {
    const typescript = await setup();
    const engine = await setup();
    const editFile = async (mod: string) => {
      if (edit !== undefined) await writeFile(path.join(mod, edit[0]), edit[1]);
    };
    const typescriptCode = await codeOf(
      typescriptApply(typescript.manager, changes, () => editFile(typescript.mod)),
    );
    await editFile(engine.mod);
    // A plan that changes nothing is refused by the two-call manager and answered with no
    // changed paths by the one-call engine; both leave every file as it was.
    const engineCode = await codeOf(engineApply(engine.binding, changes));
    expect(engineCode).toBe(typescriptCode === 'TRANSACTION_NO_CHANGES' ? 'OK' : typescriptCode);
    expect(await snapshot(engine.mod)).toEqual(await snapshot(typescript.mod));
  });

  it('recovers a journal the TypeScript manager left interrupted', async () => {
    const { mod, resolver, manager, binding, workspace } = await setup();
    const plan = await manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        { relativePath: 'common/one.txt', content: Buffer.from('interrupted\n'), operationIds: ['op-1'] },
      ],
      validate: () => Promise.resolve({ diagnostics: [], checks }),
    });
    await writeFile(path.join(mod, 'common', 'one.txt'), 'interrupted\n');
    const manifestPath = path.join(workspace.cacheRoot, 'transactions', plan.transactionId, 'manifest.json');
    await updateJournal(resolver, manifestPath, (manifest) => {
      manifest.state = 'applying';
      manifest.appliedFiles = ['common/one.txt'];
    });
    expect(await engineRecover(binding)).toBe(1);
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(START['common/one.txt']);
    // The engine's successor revision is authenticated and protected: the manager reads it.
    expect(await manager.status('test', plan.transactionId)).toMatchObject({ state: 'rolled_back', rollbackStatus: 'applied' });
    expect(await manager.recover('test')).toEqual([]);
  });

  it('leaves a journal the TypeScript manager recovers when the engine crashes', async () => {
    const { mod, manager, binding } = await setup();
    const crashing = new ResidentEngine({ env: { ...process.env, HOI4_TXN_TEST_ABORT_AFTER_REPLACE: '0' } });
    engines.push(crashing);
    const changes: Change[] = [
      { path: 'common/bom.txt', before: START['common/bom.txt']!, after: Buffer.from('replaced\n') },
      { path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('never\n') },
    ];
    await expect(engineApply(binding, changes, crashing)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect((await readFile(path.join(mod, 'common', 'bom.txt'))).toString()).toBe('replaced\n');
    // The crashed engine left its lock and an applying journal; the manager clears the lock of
    // the dead process and restores the files.
    const recovered = await manager.recover('test');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ state: 'rolled_back', rollbackStatus: 'applied' });
    expect(await snapshot(mod)).toEqual(
      Object.fromEntries(Object.entries(START).map(([relative, bytes]) => [relative, bytes.toString('hex')]).sort()),
    );
  });

  it('shares the workspace lock with the TypeScript manager', async () => {
    const { mod, binding, workspace } = await setup();
    const lock = path.join(workspace.cacheRoot, 'locks', 'write.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      `${canonicalJson({
        transactionId: 'txn_00000000-0000-0000-0000-000000000000',
        pid: process.pid,
        host: hostname().toLowerCase(),
        instanceId: 'instance_test',
        processStartedAt: new Date().toISOString(),
      })}\n`,
    );
    const changes: Change[] = [{ path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('x\n') }];
    expect(await codeOf(engineApply(binding, changes))).toBe('TRANSACTION_LOCKED');
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(START['common/one.txt']);
  });

  it('refuses a wrong, short or missing journal key and writes nothing', async () => {
    const { mod, binding } = await setup();
    const changes: Change[] = [{ path: 'common/one.txt', before: START['common/one.txt']!, after: Buffer.from('x\n') }];
    for (const journalKey of ['00', binding.journalKey.slice(2), undefined]) {
      const { journalKey: _key, ...rest } = binding;
      const code = await codeOf(engineApply(journalKey === undefined ? rest : { ...rest, journalKey }, changes));
      expect(['SERVER_STATE_KEY_INVALID', 'ENGINE_UNAVAILABLE']).toContain(code);
    }
    // A key of the right length but not the server's: the engine's journal is refused by the
    // manager, which holds the real key.
    const wrong = { ...binding, journalKey: 'ab'.repeat(32) };
    expect(await engineApply(wrong, changes)).toEqual(['common/one.txt']);
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(Buffer.from('x\n'));
    const crashing = new ResidentEngine({ env: { ...process.env, HOI4_TXN_TEST_ABORT_AFTER_REPLACE: '0' } });
    engines.push(crashing);
    const back: Change[] = [{ path: 'common/one.txt', before: Buffer.from('x\n'), after: Buffer.from('y\n') }];
    await expect(engineApply(wrong, back, crashing)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect(await codeOf(engineRecover(binding))).toBe('TRANSACTION_MANIFEST_AUTHENTICATION_FAILED');
    expect(await readFile(path.join(mod, 'common', 'one.txt'))).toEqual(Buffer.from('y\n'));
  });
});

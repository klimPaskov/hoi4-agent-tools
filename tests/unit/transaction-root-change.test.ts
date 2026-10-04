import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

const operations = [{ id: 'op-1', kind: 'test', summary: 'test edit', data: {} }];
const checks = (id: string) =>
  Promise.resolve({ diagnostics: [], checks: [{ id, passed: true, message: 'Synthetic check' }] });

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-transaction-root-change-'));
  roots.push(base);
  const mod = path.join(base, 'mod');
  const game = path.join(base, 'game');
  await mkdir(path.join(mod, 'common'), { recursive: true });
  await mkdir(path.join(game, 'common'), { recursive: true });
  await writeFile(path.join(mod, 'common', 'one.txt'), 'value = before\n');
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(base, 'server-state'),
    workspaces: [{ id: 'test', name: 'Test', root: mod, gameRoot: game }],
  });
  const resolve = () => WorkspaceResolver.create(config);
  const resolver = await resolve();
  const manager = new TransactionManager(resolver);
  const plan = (content: string) =>
    manager.plan({
      workspaceId: 'test',
      operationKind: 'test',
      operations,
      changes: [
        { relativePath: 'common/one.txt', content: Buffer.from(content), operationIds: ['op-1'] },
      ],
      validate: () => checks('dry-run'),
    });
  const journal = (transactionId: string) =>
    path.join(mod, '.hoi4-agent', 'cache', 'transactions', transactionId, 'manifest.json');
  // Installing a DLC folder adds a source layer and changes the workspace root fingerprint.
  const installDlc = async () => {
    await mkdir(path.join(game, 'dlc', 'dlc001_example'), { recursive: true });
    await writeFile(path.join(game, 'dlc', 'dlc001_example', 'dlc001.dlc'), 'name = "Example"\n');
  };
  return { mod, resolver, manager, plan, journal, installDlc, resolve };
}

/** Rewrite an authenticated journal as an earlier server state would have left it. */
async function rewriteJournal(
  resolver: WorkspaceResolver,
  manifestPath: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  update(manifest);
  manifest.revision = Number(manifest.revision) + 1;
  const { integrityHash: _integrity, authenticationTag: _tag, ...integrityPayload } = manifest;
  manifest.integrityHash = hashCanonical(integrityPayload);
  const { authenticationTag: _old, ...authenticationPayload } = manifest;
  const state = resolver.serverState()!;
  manifest.authenticationTag = state.authenticateJournal(authenticationPayload);
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  await state.recordJournalSuccessor({
    workspaceIdentity: resolver.get('test').workspaceIdentity,
    transactionId: String(manifest.transactionId),
    revision: Number(manifest.revision),
    authenticationTag: String(manifest.authenticationTag),
    manifestHash: hashCanonical(manifest),
  });
}

describe('transaction journals after a workspace root change', () => {
  it('starts the server when finished journals predate a new DLC source layer', async () => {
    const { manager, plan, installDlc, resolve, mod } = await setup();
    const applied = await plan('value = applied\n');
    await manager.apply('test', applied.transactionId, applied.planHash, {
      postValidate: () => checks('post-write'),
    });
    await plan('value = planned only\n');
    await installDlc();
    const changed = await resolve();
    expect(changed.get('test').dlcLayers.map(({ folder }) => folder)).toEqual(['dlc001_example']);
    await expect(new TransactionManager(changed).recover('test')).resolves.toEqual([]);
    await expect(new CoreEngine(changed).initialize()).resolves.toBeUndefined();
    expect(await readFile(path.join(mod, 'common', 'one.txt'), 'utf8')).toBe('value = applied\n');
  });

  it('still refuses to replay an interrupted journal against changed roots', async () => {
    const { resolver, plan, journal, installDlc, resolve } = await setup();
    const interrupted = await plan('value = interrupted\n');
    await rewriteJournal(resolver, journal(interrupted.transactionId), (manifest) => {
      manifest.state = 'applying';
      manifest.appliedFiles = ['common/one.txt'];
    });
    await installDlc();
    await expect(new TransactionManager(await resolve()).recover('test')).rejects.toMatchObject({
      code: 'TRANSACTION_ROOT_CHANGED',
    });
  });

  it('removes expired finished journals from earlier roots so they leave the quota', async () => {
    const { resolver, plan, journal, installDlc, resolve, mod } = await setup();
    const expired = await plan('value = expired\n');
    const current = await plan('value = kept\n');
    await rewriteJournal(resolver, journal(expired.transactionId), (manifest) => {
      manifest.expiresAt = new Date(Date.now() - 60_000).toISOString();
    });
    await installDlc();
    const manager = new TransactionManager(await resolve());
    const directory = path.join(mod, '.hoi4-agent', 'cache', 'transactions');
    await (
      manager as unknown as {
        pruneExpiredJournals(workspace: unknown, directory: string): Promise<void>;
      }
    ).pruneExpiredJournals((await resolve()).get('test'), directory);
    const remaining = await readdir(directory);
    expect(remaining).not.toContain(expired.transactionId);
    expect(remaining).toContain(current.transactionId);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { callEngineOperation } from '../../src/hoi4_agent_tools/core/engine-operation.js';
import { transactionRootFingerprint } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { planCharacterWrite } from '../../src/hoi4_agent_tools/characters/write-plan.js';
import { planDecisionWrite } from '../../src/hoi4_agent_tools/decision/write-plan.js';
import { planDoctrineWrite } from '../../src/hoi4_agent_tools/doctrine/write-plan.js';
import { planEventWrite } from '../../src/hoi4_agent_tools/event/write-plan.js';
import { planIdeaWrite } from '../../src/hoi4_agent_tools/ideas/write-plan.js';
import { planTechWrite } from '../../src/hoi4_agent_tools/technology/write-plan.js';

// ADR 0089, packet P10 with P2: the plan each script writer answers is a file's new bytes, and
// the engine's rewrite engine (`txn.apply`) writes those bytes after its stale-source check, the
// same path every domain rewrite takes. Each writer's plan applies, and a source that changed
// after the writer read it is refused without a write.

const engineAvailable = process.env.HOI4_ENGINE !== undefined;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const appliedSchema = z.object({ changedPaths: z.array(z.string()) }).strict();

interface Case {
  name: string;
  path: string;
  source: string;
  plan: (source: { bytes: Buffer; path: string }) => Promise<{ text: string }>;
}

const CASES: Case[] = [
  {
    name: 'idea',
    path: 'common/ideas/test.txt',
    source: 'ideas = {\n\tcountry = {\n\t\tfirst = {\n\t\t\tpicture = first\n\t\t}\n\t}\n}\n',
    plan: (source) =>
      planIdeaWrite(source, { operation: 'replace', id: 'first', body: 'picture = changed' }),
  },
  {
    name: 'character',
    path: 'common/characters/test.txt',
    source: 'characters = {\n\tTST_first = {\n\t\tname = TST_first\n\t}\n}\n',
    plan: (source) =>
      planCharacterWrite(source, { operation: 'replace', id: 'TST_first', body: 'name = other' }),
  },
  {
    name: 'decision',
    path: 'common/decisions/test.txt',
    source: 'tst_category = {\n\ttst_first = {\n\t\tcost = 50\n\t}\n}\n',
    plan: (source) =>
      planDecisionWrite(source, { operation: 'replace', id: 'tst_first', body: 'cost = 60' }),
  },
  {
    name: 'doctrine',
    path: 'common/doctrines/tracks/test.txt',
    source: 'tst_track_a = {\n\tname = TST_TRACK_A\n}\n',
    plan: (source) =>
      planDoctrineWrite(source, { operation: 'replace', id: 'tst_track_a', body: 'name = X' }),
  },
  {
    name: 'tech',
    path: 'common/technologies/test.txt',
    source: 'technologies = {\n\ttst_tech_a = {\n\t\tresearch_cost = 1.5\n\t}\n}\n',
    plan: (source) =>
      planTechWrite(source, {
        operation: 'replace',
        id: 'tst_tech_a',
        body: 'research_cost = 2',
      }),
  },
  {
    name: 'event',
    path: 'events/test.txt',
    source: 'add_namespace = tst\n\ncountry_event = {\n\tid = tst.1\n\ttitle = tst.1.t\n}\n',
    plan: (source) =>
      planEventWrite(source, { operation: 'replace', id: 'tst.1', body: 'title = tst.1.new' }),
  },
];

async function setup(relativePath: string, source: string) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-script-write-txn-'));
  roots.push(base);
  const mod = path.join(base, 'mod');
  await mkdir(path.dirname(path.join(mod, relativePath)), { recursive: true });
  await writeFile(path.join(mod, relativePath), source);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Script writer fixture', root: mod }],
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
  return { mod, binding };
}

function apply(
  binding: Record<string, unknown>,
  relativePath: string,
  before: Buffer,
  after: Buffer,
): Promise<string[]> {
  return callEngineOperation({
    op: 'txn.apply',
    body: {
      ...binding,
      operationKind: 'script_write',
      changes: [{ path: relativePath, beforeSha256: sha256Bytes(before), afterSize: after.length }],
    },
    payload: after,
    result: appliedSchema,
  }).then(({ result }) => result.changedPaths);
}

describe.skipIf(!engineAvailable)('script writer plans through the rewrite engine', () => {
  for (const item of CASES) {
    it(`applies the ${item.name} writer's plan and refuses it once the source changed`, async () => {
      const { mod, binding } = await setup(item.path, item.source);
      const before = Buffer.from(item.source, 'utf8');
      const plan = await item.plan({ bytes: before, path: item.path });
      expect(plan.text).not.toBe(item.source);
      const after = Buffer.from(plan.text, 'utf8');

      expect(await apply(binding, item.path, before, after)).toEqual([item.path]);
      expect(await readFile(path.join(mod, item.path), 'utf8')).toBe(plan.text);

      // A second apply from the old bytes is a stale source: nothing is written.
      await expect(
        apply(binding, item.path, before, Buffer.from('other = 1\n')),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/STALE|SOURCE/u) as unknown,
      });
      expect(await readFile(path.join(mod, item.path), 'utf8')).toBe(plan.text);
    });
  }
});

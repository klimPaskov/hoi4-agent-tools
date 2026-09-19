import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { currentJobOwner, type JobRecord } from '../../src/hoi4_agent_tools/core/job-store.js';
import type { JobExecutionContext } from '../../src/hoi4_agent_tools/core/job-executor.js';
import { jobAnalysisCheckpoints } from '../../src/hoi4_agent_tools/core/analysis-checkpoints.js';
import { hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-analysis-checkpoint-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    artifactMaxBytes: 16 * 1024 * 1024,
    artifactMaxSingleBytes: 1024 * 1024,
    artifactMaxEntries: 6,
    workspaces: [{ id: 'test', name: 'Synthetic checkpoints', root: mod }],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  await engine.persistentAnalysisCache;
  const jobs = await JobService.create(resolver);
  const scope = jobs.scope('test');
  const record = (
    await jobs.submit('test', { toolName: 'hoi4.event_inspect', arguments: {}, mutation: false })
  ).record;
  const owner = currentJobOwner();
  await jobs.store.claim(scope, record.id, owner);
  const contextFor = (checkpoint?: JobRecord['checkpoint']): JobExecutionContext => ({
    engine,
    workspaceId: 'test',
    principal: undefined,
    signal: new AbortController().signal,
    checkpoint,
    progress: async (progress) => {
      await jobs.store.updateOwned(scope, record.id, owner.token, { progress });
    },
    saveCheckpoint: async (checkpoint) => {
      await jobs.store.updateOwned(scope, record.id, owner.token, { checkpoint });
    },
    stageResult: async () => {
      throw new Error('This test does not stage results');
    },
  });
  return { root, resolver, engine, jobs, scope, record, owner, contextFor };
}

const key = 'a'.repeat(64);
const revision = 'b'.repeat(64);
const stateSchema = z.object({ frontier: z.string() }).strict();
const provenance = {
  kind: 'checkpoint-retention-test',
  toolVersion: 'test',
  schemaVersion: '1',
  sourceHashes: {},
};

describe('authenticated dependency checkpoints', () => {
  it('protects a chunked active frontier across engine instances and releases it after termination', async () => {
    const { resolver, jobs, scope, record, owner, contextFor } = await fixture();
    const state = { frontier: 'source-bound-frontier'.repeat(60_000) };
    await jobAnalysisCheckpoints(contextFor()).save(key, revision, state, 4, 10);
    const saved = (await jobs.get('test', record.id)).checkpoint!;
    expect(saved.resources).toHaveLength(3);
    const otherEngine = new CoreEngine(await WorkspaceResolver.create(resolver.config()));
    await otherEngine.persistentAnalysisCache;
    const workspace = otherEngine.resolver.get('test');
    for (let index = 0; index < 10; index++)
      await otherEngine.artifacts.put(
        workspace,
        `noise-${index}.json`,
        'application/json',
        JSON.stringify({ index }),
        provenance,
      );
    expect(
      await jobAnalysisCheckpoints({ ...contextFor(saved), engine: otherEngine }).load(
        key,
        revision,
        stateSchema,
      ),
    ).toEqual(state);
    expect(await jobs.store.checkpointResources(scope)).toEqual(new Set(saved.resources));
    await jobs.store.updateOwned(scope, record.id, owner.token, {
      status: 'completed',
      result: {},
    });
    for (let index = 10; index < 18; index++)
      await otherEngine.artifacts.put(
        workspace,
        `noise-${index}.json`,
        'application/json',
        JSON.stringify({ index }),
        provenance,
      );
    expect(await jobs.store.checkpointResources(scope)).toEqual(new Set());
    await expect(otherEngine.artifacts.read(workspace, saved.resourceUri!)).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_FOUND',
    });
  });

  it('rejects mismatched commitments and ignores unrelated source revisions without loading them', async () => {
    const { jobs, record, contextFor } = await fixture();
    const checkpoints = jobAnalysisCheckpoints(contextFor());
    await checkpoints.save(key, revision, { frontier: 'retained' }, 1, 2);
    const saved = (await jobs.get('test', record.id)).checkpoint!;
    expect(await checkpoints.load(key, 'c'.repeat(64), stateSchema)).toBeUndefined();
    expect(await checkpoints.load('c'.repeat(64), revision, stateSchema)).toBeUndefined();
    await expect(
      jobAnalysisCheckpoints(contextFor({ ...saved, stateHash: 'c'.repeat(64) })).load(
        key,
        revision,
        stateSchema,
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CHECKPOINT_INVALID' });
    await expect(
      jobAnalysisCheckpoints(contextFor({ ...saved, stateHash: undefined })).load(
        key,
        revision,
        stateSchema,
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CHECKPOINT_INVALID' });
  });

  it('retains the previous checkpoint if publishing its replacement job record fails', async () => {
    const { engine, jobs, record, contextFor } = await fixture();
    await jobAnalysisCheckpoints(contextFor()).save(key, revision, { frontier: 'before' }, 0, 2);
    const saved = (await jobs.get('test', record.id)).checkpoint!;
    const before = await engine.artifacts.list(engine.resolver.get('test'));
    await expect(
      jobAnalysisCheckpoints({
        ...contextFor(saved),
        saveCheckpoint: async () => {
          throw new Error('synthetic failed publication');
        },
      }).save(key, revision, { frontier: 'after' }, 1, 2),
    ).rejects.toThrow('synthetic failed publication');
    expect(await engine.artifacts.list(engine.resolver.get('test'))).toEqual(before);
    expect(
      await jobAnalysisCheckpoints(contextFor(saved)).load(key, revision, stateSchema),
    ).toEqual({ frontier: 'before' });
  });

  it('fails retention closed for a tampered pin and does not borrow pins from a changed workspace identity', async () => {
    const { root, jobs, scope, record, contextFor } = await fixture();
    await jobAnalysisCheckpoints(contextFor()).save(key, revision, { frontier: 'private' }, 0, 1);
    expect(
      await jobs.store.checkpointResources({ ...scope, workspaceIdentity: 'c'.repeat(64) }),
    ).toEqual(new Set());
    const file = path.join(root, 'state', 'jobs', hashCanonical(scope), `${record.id}.json`);
    const original = await readFile(file, 'utf8');
    const envelope = JSON.parse(original) as { record: JobRecord; authenticationTag: string };
    envelope.record.checkpoint!.resources = ['hoi4-agent://workspace/other/artifact/forged'];
    await writeFile(file, JSON.stringify(envelope));
    await expect(jobs.store.checkpointResources(scope)).rejects.toMatchObject({
      code: 'JOB_RECORD_INVALID',
    });
    await writeFile(file, original);
  });

  it('rejects an unrecognized record filename instead of treating it as an eviction pin', async () => {
    const { root, jobs, scope, record } = await fixture();
    const scopeRoot = path.join(root, 'state', 'jobs', hashCanonical(scope));
    await writeFile(
      path.join(scopeRoot, record.id),
      await readFile(path.join(scopeRoot, `${record.id}.json`)),
    );
    await expect(jobs.store.checkpointResources(scope)).rejects.toMatchObject({
      code: 'JOB_RECORD_UNSAFE',
    });
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { JobExecutor, JobOperations } from '../../src/hoi4_agent_tools/core/job-executor.js';
import { registerEventJobs } from '../../src/hoi4_agent_tools/event/job-operations.js';
import { registerTechnologyJobs } from '../../src/hoi4_agent_tools/technology/job-operations.js';
import { jobOwnerLiveness, type JobRecord } from '../../src/hoi4_agent_tools/core/job-store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('production dependency worker recovery', () => {
  it.each([
    { domain: 'event', editSources: false },
    { domain: 'event', editSources: true },
    { domain: 'technology', editSources: false },
    { domain: 'technology', editSources: true },
  ] as const)(
    'recovers an interrupted $domain helper job and matches clean analysis, sources changed=$editSources',
    async ({ domain, editSources }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'hoi4-dependency-worker-'));
      roots.push(root);
      const mod = path.join(root, 'mod');
      await mkdir(path.join(mod, 'events'), { recursive: true });
      await mkdir(path.join(mod, 'common/scripted_effects'), { recursive: true });
      const eventPath = path.join(mod, 'events/checkpoint.txt');
      const helperPath = path.join(mod, 'common/scripted_effects/checkpoint.txt');
      await writeFile(
        eventPath,
        'add_namespace = checkpoint\ncountry_event = { id = checkpoint.1 is_triggered_only = yes immediate = { batch_root = yes } }\ncountry_event = { id = checkpoint.2 is_triggered_only = yes }\n',
      );
      const technologyPath = path.join(mod, 'common/technologies/checkpoint.txt');
      if (domain === 'technology') {
        await mkdir(path.dirname(technologyPath), { recursive: true });
        await writeFile(
          technologyPath,
          'technologies = { checkpoint_alpha = { research_cost = 1 start_year = 1936 } checkpoint_beta = { research_cost = 1 start_year = 1938 } }\n',
        );
      }
      const helpers = Array.from({ length: 2_500 }, (_, index) => `branch_${index}`);
      const outcome =
        domain === 'event'
          ? 'country_event = { id = checkpoint.2 }'
          : 'add_tech_bonus = { bonus = 0.5 uses = 1 technology = checkpoint_beta }';
      await writeFile(
        helperPath,
        `batch_root = { ${helpers.map((name) => `${name} = yes`).join('\n')} }\n${helpers.map((name) => `${name} = { ${outcome} }`).join('\n')}`,
      );
      const sourcePath = domain === 'event' ? eventPath : technologyPath;
      const eventBefore = await readFile(eventPath);
      const sourceBefore = [await readFile(sourcePath), await readFile(helperPath)];
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        maxSharedTools: 1,
        workspaces: [{ id: 'test', name: 'Synthetic dependency recovery', root: mod }],
      });
      const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
      const jobs = await JobService.create(engine.resolver);
      const request = {
        toolName: domain === 'event' ? 'hoi4.event_inspect' : 'hoi4.tech_inspect',
        mutation: false,
        arguments: { workspaceId: 'test', mode: 'lint' },
        requestKey: 'interrupted-helper-walk',
      };
      const { record } = await jobs.submit('test', request);
      const host = await JobWorkerHost.create(engine, jobs);
      const running = host.run('test', record.id);
      let interrupted: JobRecord | undefined;
      try {
        await vi.waitFor(
          async () => {
            const current = await jobs.get('test', record.id);
            expect(current.checkpoint?.cursor).toMatch(/^analysis:/u);
            expect(current.owner?.pid).toBeGreaterThan(0);
            expect(current.owner!.pid).not.toBe(process.pid);
            interrupted = current;
          },
          { timeout: 120_000, interval: 5 },
        );
        if (editSources) {
          if (domain === 'event') {
            sourceBefore[0] = Buffer.from(
              `${sourceBefore[0]!.toString('utf8')}country_event = { id = checkpoint.3 is_triggered_only = yes }\n`,
            );
            sourceBefore[1] = Buffer.from(
              sourceBefore[1]!.toString('utf8').replace('id = checkpoint.2', 'id = checkpoint.3'),
            );
          } else {
            sourceBefore[0] = Buffer.from(
              sourceBefore[0]!
                .toString('utf8')
                .replace(
                  /\}\s*$/u,
                  'checkpoint_gamma = { research_cost = 2 start_year = 1940 } }\n',
                ),
            );
            sourceBefore[1] = Buffer.from(
              sourceBefore[1]!
                .toString('utf8')
                .replace('technology = checkpoint_beta', 'technology = checkpoint_gamma'),
            );
          }
          await writeFile(sourcePath, sourceBefore[0]);
          await writeFile(helperPath, sourceBefore[1]);
        }
        // Only the proven owner of this test-created job is stopped; no application/service process is targeted.
        const owner = interrupted!.owner!;
        process.kill(owner.pid);
        await vi.waitFor(() => expect(jobOwnerLiveness(owner)).toBe('dead'), {
          timeout: 5_000,
          interval: 10,
        });
        const completed = await running;
        expect(completed.status, JSON.stringify(completed.failure)).toBe('completed');
        expect(completed.owner!.pid).not.toBe(owner.pid);
        expect(completed.result).toMatchObject({ structuredContent: { status: 'ok' } });
        const other = new CoreEngine(await WorkspaceResolver.create(configuration));
        const operations = new JobOperations();
        (domain === 'event' ? registerEventJobs : registerTechnologyJobs)(operations, other);
        const clean = (await jobs.submit('test', { ...request, requestKey: 'clean-reference' }))
          .record;
        const checkpointWrites = vi.spyOn(jobs.store, 'updateOwned');
        const expected = await new JobExecutor(other, jobs, operations).run('test', clean.id);
        const sourceRevisions = [
          ...new Set(
            checkpointWrites.mock.calls.flatMap(([, id, , update]) =>
              id === clean.id && update.checkpoint?.cursor.startsWith('analysis:')
                ? [update.checkpoint.sourceRevision]
                : [],
            ),
          ),
        ];
        // A dependency checkpoint binds the source scan; technology's final graph revision
        // additionally binds its selected assets and definitions, so these are distinct identities.
        expect(sourceRevisions).toHaveLength(1);
        if (editSources)
          expect(sourceRevisions).not.toContain(interrupted!.checkpoint!.sourceRevision);
        else expect(sourceRevisions).toContain(interrupted!.checkpoint!.sourceRevision);
        expect(completed.result).toEqual(expected.result);
        expect(await readFile(sourcePath)).toEqual(sourceBefore[0]);
        expect(await readFile(helperPath)).toEqual(sourceBefore[1]);
        if (domain === 'technology') expect(await readFile(eventPath)).toEqual(eventBefore);
      } finally {
        await jobs.cancel('test', record.id);
        await running;
      }
    },
  );
});

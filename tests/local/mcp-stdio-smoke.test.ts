import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  helpfulErrorProblems,
  launchSmokeServer,
  successProblems,
  writeSmokeConfig,
  type SmokeServer,
} from '../helpers/mcp-stdio-smoke.js';
import {
  ALL_TOOLS,
  discoverSubjects,
  readOnlyCalls,
  wrongFieldCalls,
  type SmokeSubjects,
} from '../helpers/smoke-calls.js';
import { SmokeLedger } from '../helpers/smoke-ledger.js';

/**
 * End-to-end stdio smoke against the installed game and a real external mod. Every call is
 * read-only: the game is read through an empty mod, and the real mod's rewrite tools only
 * receive wrong-field calls, which fail argument validation before anything can be written.
 * Opt in with HOI4_GAME_ROOT and HOI4_EXTERNAL_MOD_ROOT; HOI4_SMOKE_REPORT names a markdown file
 * that receives the per-tool coverage table.
 */

const gameRoot = process.env.HOI4_GAME_ROOT;
const modRoot = process.env.HOI4_EXTERNAL_MOD_ROOT;
const local = gameRoot === undefined || modRoot === undefined ? describe.skip : describe;

const MAP_SUBJECTS = {
  lookup: { lookupOnly: true, stateIds: [64], provinceIds: [3000] },
  render: { layer: 'state', tile: { x: 2600, y: 300, width: 256, height: 256 } },
};

local('local stdio smoke: installed game and external mod', () => {
  const ledger = new SmokeLedger();
  let temporary = '';
  let server: SmokeServer;
  let vanilla: { subjects: SmokeSubjects; missing: string[] };
  let mod: { subjects: SmokeSubjects; missing: string[] };

  beforeAll(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-local-smoke-'));
    const emptyMod = path.join(temporary, 'vanilla-mod');
    await mkdir(emptyMod, { recursive: true });
    await writeFile(path.join(emptyMod, 'descriptor.mod'), 'name="Installed game smoke"\n');
    const dependencies = (process.env.HOI4_DEPENDENCY_ROOTS ?? '')
      .split(path.delimiter)
      .filter(Boolean);
    vanilla = await discoverSubjects(gameRoot!, 'vanilla');
    mod = await discoverSubjects(modRoot!, 'mod');
    for (const found of [vanilla, mod]) found.subjects.map = MAP_SUBJECTS;
    const config = await writeSmokeConfig(path.join(temporary, 'config'), [
      { id: 'vanilla', name: 'Installed game', root: emptyMod, gameRoot },
      {
        id: 'mod',
        name: 'External mod',
        root: modRoot,
        gameRoot,
        ...(dependencies.length === 0 ? {} : { dependencyRoots: dependencies }),
      },
    ]);
    server = await launchSmokeServer(config, process.env.HOI4_SMOKE_STDIO_ENTRY);
  }, 600_000);

  afterAll(async () => {
    await server.close();
    await ledger.write(process.env.HOI4_SMOKE_REPORT, 'Installed game and external mod', ALL_TOOLS);
    if (temporary !== '') await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
  });

  it('advertises exactly the current 28 tools', () => {
    expect([...server.toolNames].sort()).toEqual([...ALL_TOOLS].sort());
  });

  const readOnlyTools = ALL_TOOLS.filter(
    (tool) =>
      ![
        'hoi4.focus_rewrite',
        'hoi4.gui_rewrite',
        'hoi4.map_rewrite',
        'hoi4.job_inspect',
        'hoi4.job_cancel',
      ].includes(tool),
  );
  for (const target of ['vanilla', 'mod'] as const) {
    for (const tool of readOnlyTools) {
      it(`answers ${tool} on the ${target} fixture`, async () => {
        const found = target === 'vanilla' ? vanilla : mod;
        expect(found.missing, `subjects not found in the ${target} files`).toEqual([]);
        const failures: string[] = [];
        if (tool === 'hoi4.reference_read') {
          const searched = await server.call(
            'hoi4.reference_search',
            `${target}: select a cited section`,
            {
              workspaceId: found.subjects.workspaceId,
              query: found.subjects.documentationQuery,
              limit: 1,
            },
          );
          expect(successProblems(searched)).toEqual([]);
          const hit = (
            searched.structured.data as { results?: Array<{ id: string; revision: string }> }
          ).results?.[0];
          expect(hit, 'the installed documentation answers the search').toBeDefined();
          const result = await server.call(tool, `${target}: read the first hit`, {
            workspaceId: found.subjects.workspaceId,
            id: hit!.id,
            revision: hit!.revision,
            maxLines: 20,
          });
          const problems = successProblems(result);
          ledger.record(result, 'success', problems);
          expect(problems).toEqual([]);
          return;
        }
        const calls = readOnlyCalls(found.subjects).filter((call) => call.tool === tool);
        expect(calls.length, `${tool} has a real source subject`).toBeGreaterThan(0);
        for (const call of calls) {
          const result = await server.call(call.tool, `${target}: ${call.label}`, call.args);
          const problems = successProblems(result, [
            ...(call.tolerate ?? []),
            ...(target === 'mod' ? ['SCENARIO_SOURCE_STALE'] : []),
          ]);
          ledger.record(result, 'success', problems);
          if (problems.length > 0) failures.push(`${call.label}: ${problems.join('; ')}`);
        }
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
  }

  it('inspects and cancels a background job created through a native task', async () => {
    const created = await server.client.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'mod', treeId: mod.subjects.focusTreeId },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 600_000 } },
    );
    const jobId = /job_[a-f0-9]{64}/u.exec(created.task.taskId)?.[0];
    expect(jobId, `task id ${created.task.taskId} carries its job id`).toBeDefined();
    await vi.waitFor(
      async () => {
        expect((await server.client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
          'completed',
        );
      },
      { timeout: 600_000, interval: 250 },
    );
    const inspected = await server.call('hoi4.job_inspect', 'result of a finished job', {
      workspaceId: 'mod',
      jobId: jobId!,
    });
    const inspectedProblems = successProblems(inspected);
    ledger.record(inspected, 'job', inspectedProblems);
    expect(inspectedProblems).toEqual([]);
    expect(inspected.structured.code).toBe('FOCUS_INSPECTED');
    const cancelled = await server.call('hoi4.job_cancel', 'cancel a job that already completed', {
      workspaceId: 'mod',
      jobId: jobId!,
    });
    const cancelledProblems = successProblems(cancelled);
    ledger.record(cancelled, 'job', cancelledProblems);
    expect(cancelledProblems).toEqual([]);
  }, 900_000);

  it('explains one wrong field per tool on the real mod without writing anything', async () => {
    const failures: string[] = [];
    for (const call of wrongFieldCalls('mod')) {
      const result = await server.call(call.tool, `wrong field ${call.field}`, call.args);
      const problems = helpfulErrorProblems(result, call.field);
      ledger.record(result, 'wrong-field', problems);
      if (problems.length > 0) failures.push(`${call.tool}: ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

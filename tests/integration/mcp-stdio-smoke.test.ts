import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  readOnlyCalls,
  wrongFieldCalls,
  type SmokeSubjects,
} from '../helpers/smoke-calls.js';
import { buildSyntheticSmokeWorkspace } from '../helpers/smoke-fixture.js';
import { SmokeLedger } from '../helpers/smoke-ledger.js';
import { runWorldFlow } from '../helpers/smoke-world.js';

/**
 * End-to-end smoke over the real stdio entry point: every exposed tool is called once with a
 * realistic agent-style argument shape, once with a deliberately wrong field, and the map
 * operations run against a generated world. The same tool list is checked against the local
 * suite (`tests/local/mcp-stdio-smoke.test.ts`) that targets the installed game and a real mod.
 */

const ledger = new SmokeLedger();
let temporary = '';
let server: SmokeServer;
let rewriteGuiMod = '';
let rewriteFocusMod = '';

const subjects: SmokeSubjects = {
  workspaceId: 'smoke',
  documentationQuery: 'add_political_power',
  eventId: 'synthetic_alpha.1',
  eventNamespace: 'synthetic_alpha',
  eventFile: 'events/synthetic_alpha_01.txt',
  focusFile: 'common/national_focus/synthetic_acceptance.txt',
  focusTreeId: 'synthetic_acceptance_tree',
  guiWindow: 'synthetic_gui_window',
  decision: {
    id: 'synthetic_decision_00_choice',
    file: 'common/decisions/synthetic_probability_decisions.txt',
  },
  scriptedEffect: {
    id: 'synthetic_focus_reward_effect',
    file: 'common/scripted_effects/synthetic_acceptance.txt',
  },
  technology: { id: 'synthetic_tech_0001', folder: 'synthetic_folder_00' },
  probability: {
    path: 'common/decisions/synthetic_probability_decisions.txt',
    candidates: ['synthetic_decision_00_choice'],
    state: { has_war: false, 'variable.pressure': 80 },
  },
};

beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-stdio-smoke-'));
  const { mod, game, userRoot } = await buildSyntheticSmokeWorkspace(
    path.join(temporary, 'synthetic'),
  );
  // One copy per rewrite so a rewrite is judged on its own fixture, not on the other's findings.
  rewriteFocusMod = path.join(temporary, 'rewrite-focus-mod');
  rewriteGuiMod = path.join(temporary, 'rewrite-gui-mod');
  await cp(path.resolve('fixtures', 'focus', 'workspace'), rewriteFocusMod, { recursive: true });
  await cp(path.resolve('fixtures', 'gui', 'workspace'), rewriteGuiMod, { recursive: true });
  const worldMod = path.join(temporary, 'world-mod');
  const worldGame = path.join(temporary, 'world-game');
  await cp(path.resolve('fixtures', 'map', 'roots', 'game'), worldGame, { recursive: true });
  await mkdir(worldMod, { recursive: true });
  await writeFile(path.join(worldMod, 'descriptor.mod'), 'name="Smoke world"\n');
  const config = await writeSmokeConfig(
    path.join(temporary, 'config'),
    [
      { id: 'smoke', name: 'Smoke fixture', root: mod, gameRoot: game, includeGameDlc: false },
      { id: 'rewrite_focus', name: 'Smoke focus rewrite copy', root: rewriteFocusMod },
      { id: 'rewrite_gui', name: 'Smoke GUI rewrite copy', root: rewriteGuiMod },
      { id: 'world', name: 'Smoke world', root: worldMod, gameRoot: worldGame },
    ],
    { gameUserRoot: userRoot },
  );
  server = await launchSmokeServer(config);
}, 300_000);

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- beforeAll may have failed before the server started
  await server?.close();
  await ledger.write(process.env.HOI4_SMOKE_REPORT, 'Synthetic fixture', ALL_TOOLS);
  if (temporary !== '') await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
});

describe('stdio smoke: synthetic fixture', () => {
  it('exposes exactly the documented tool list', () => {
    expect([...server.toolNames].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('answers a realistic call to every read-only tool within bounds', async () => {
    const failures: string[] = [];
    let searchHit: { id: string; revision: string } | undefined;
    for (const call of readOnlyCalls(subjects)) {
      const result = await server.call(call.tool, call.label, call.args);
      const problems = successProblems(result, call.tolerate);
      ledger.record(result, 'success', problems);
      if (problems.length > 0)
        failures.push(`${call.tool} (${call.label}): ${problems.join('; ')}`);
      if (call.tool === 'hoi4.reference_search' && problems.length === 0) {
        const first = (
          result.structured.data as { results?: Array<{ id: string; revision: string }> }
        ).results?.[0];
        if (first !== undefined) searchHit = first;
      }
    }
    expect(searchHit, 'reference_search found nothing to read').toBeDefined();
    const read = await server.call('hoi4.reference_read', 'read the first search hit', {
      workspaceId: 'smoke',
      id: searchHit!.id,
      revision: searchHit!.revision,
      maxLines: 10,
    });
    const readProblems = successProblems(read);
    ledger.record(read, 'success', readProblems);
    if (readProblems.length > 0) failures.push(`hoi4.reference_read: ${readProblems.join('; ')}`);
    expect(failures).toEqual([]);
  }, 900_000);

  it('rewrites a temporary copy: compact a focus tree and create a GUI window', async () => {
    const compact = await server.call('hoi4.focus_rewrite', 'compact an existing tree', {
      workspaceId: 'rewrite_focus',
      relativePath: subjects.focusFile,
      treeId: subjects.focusTreeId,
      layoutMode: 'compact',
    });
    const compactProblems = successProblems(compact);
    ledger.record(compact, 'rewrite', compactProblems);
    expect(compactProblems).toEqual([]);

    const helper = {
      version: 1,
      root: {
        id: 'smoke_window',
        kind: 'column',
        name: 'smoke_window',
        width: 320,
        height: 200,
        children: [],
      },
    };
    const created = await server.call('hoi4.gui_rewrite', 'create a window from helpers', {
      workspaceId: 'rewrite_gui',
      mode: 'helpers',
      relativePath: 'interface/smoke_window.gui',
      windowName: 'smoke_window',
      scenario: { id: 'smoke', resolution: { width: 640, height: 360 } },
      helper,
    });
    const createdProblems = successProblems(created);
    ledger.record(created, 'rewrite', createdProblems);
    expect(createdProblems).toEqual([]);
    expect(
      await readFile(path.join(rewriteGuiMod, 'interface', 'smoke_window.gui'), 'utf8'),
    ).toContain('smoke_window');
  }, 900_000);

  it('creates, reshapes and repairs a generated world', async () => {
    const rows = await runWorldFlow(server, path.join(temporary, 'world-mod'), 'world');
    for (const { result, kind, problems } of rows) ledger.record(result, kind, problems);
    expect(rows.flatMap(({ problems }) => problems)).toEqual([]);
  }, 1_800_000);

  it('inspects and cancels a background job created through a native task', async () => {
    const created = await server.client.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'smoke', treeId: subjects.focusTreeId },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 120_000 } },
    );
    const jobId = /job_[a-f0-9]{64}/u.exec(created.task.taskId)?.[0];
    expect(jobId, `task id ${created.task.taskId} carries its job id`).toBeDefined();
    await vi.waitFor(
      async () => {
        expect((await server.client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
          'completed',
        );
      },
      { timeout: 240_000, interval: 250 },
    );
    const inspected = await server.call('hoi4.job_inspect', 'result of a finished job', {
      workspaceId: 'smoke',
      jobId: jobId!,
    });
    const inspectedProblems = successProblems(inspected);
    ledger.record(inspected, 'job', inspectedProblems);
    expect(inspectedProblems).toEqual([]);
    expect(inspected.structured.code).toBe('FOCUS_INSPECTED');
    const cancelled = await server.call('hoi4.job_cancel', 'cancel a job that already completed', {
      workspaceId: 'smoke',
      jobId: jobId!,
    });
    const cancelledProblems = successProblems(cancelled);
    ledger.record(cancelled, 'job', cancelledProblems);
    expect(cancelledProblems).toEqual([]);
  }, 900_000);

  it('explains one wrong field per tool with the field name and a working example', async () => {
    const failures: string[] = [];
    for (const call of wrongFieldCalls('smoke')) {
      const result = await server.call(call.tool, `wrong field ${call.field}`, call.args);
      const problems = helpfulErrorProblems(result, call.field);
      ledger.record(result, 'wrong-field', problems);
      if (problems.length > 0) failures.push(`${call.tool}: ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
  }, 900_000);

  it('covers every exposed tool with a success and a wrong-field call', () => {
    const coverage = ledger.coverage(ALL_TOOLS, ['wrong-field']);
    expect([...coverage].filter(([, covered]) => !covered).map(([tool]) => tool)).toEqual([]);
    const succeeded = new Set(
      ledger.rows.filter((row) => row.kind !== 'wrong-field' && row.passed).map((row) => row.tool),
    );
    expect(ALL_TOOLS.filter((tool) => !succeeded.has(tool))).toEqual([]);
  });
});

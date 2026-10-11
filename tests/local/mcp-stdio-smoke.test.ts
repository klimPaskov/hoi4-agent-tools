import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    server = await launchSmokeServer(config);
  }, 600_000);

  afterAll(async () => {
    await server.close();
    await ledger.write(process.env.HOI4_SMOKE_REPORT, 'Installed game and external mod', ALL_TOOLS);
    if (temporary !== '') await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
  });

  for (const target of ['vanilla', 'mod'] as const) {
    it(`answers a realistic read-only call to every inspect tool on the ${target} fixture`, async () => {
      const found = target === 'vanilla' ? vanilla : mod;
      const failures: string[] = [];
      let searchHit: { id: string; revision: string } | undefined;
      for (const call of readOnlyCalls(found.subjects)) {
        const result = await server.call(call.tool, `${target}: ${call.label}`, call.args);
        // A mod under active development can change between a suite's two source snapshots.
        const problems = successProblems(result, [
          ...(call.tolerate ?? []),
          ...(target === 'mod' ? ['SCENARIO_SOURCE_STALE'] : []),
        ]);
        ledger.record(result, 'success', problems);
        if (problems.length > 0)
          failures.push(`${call.tool} (${call.label}): ${problems.join('; ')}`);
        if (call.tool === 'hoi4.reference_search' && problems.length === 0)
          searchHit = (
            result.structured.data as { results?: Array<{ id: string; revision: string }> }
          ).results?.[0];
      }
      expect(searchHit, 'the installed documentation answers the search').toBeDefined();
      const read = await server.call('hoi4.reference_read', `${target}: read the first hit`, {
        workspaceId: found.subjects.workspaceId,
        id: searchHit!.id,
        revision: searchHit!.revision,
        maxLines: 20,
      });
      const readProblems = successProblems(read);
      ledger.record(read, 'success', readProblems);
      if (readProblems.length > 0) failures.push(`hoi4.reference_read: ${readProblems.join('; ')}`);
      expect(failures).toEqual([]);
      // A target without a subject for some tool is reported, not silently skipped.
      expect(found.missing, `subjects not found in the ${target} files`).toEqual([]);
    }, 1_800_000);
  }

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

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineCheckReport } from '../../src/hoi4_agent_tools/core/engine-check.js';
import { guardedFiles, inventedNames } from '../../src/hoi4_agent_tools/reference/script-guard.js';
import { scriptGuardDataSchema } from '../../src/hoi4_agent_tools/schemas/modder-tools.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function mod(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-guard-'));
  cleanup.push(root);
  const modRoot = path.join(root, 'mod');
  await mkdir(path.join(modRoot, 'events'), { recursive: true });
  await mkdir(path.join(modRoot, 'common', 'ideas'), { recursive: true });
  await writeFile(path.join(modRoot, 'events', 'new.txt'), 'add_namespace = new\n');
  await writeFile(path.join(modRoot, 'common', 'ideas', 'old.txt'), 'ideas = {}\n');
  await writeFile(path.join(modRoot, 'descriptor.mod'), 'name="Guard"\n');
  const old = new Date(Date.now() - 3 * 3600_000);
  await utimes(path.join(modRoot, 'common', 'ideas', 'old.txt'), old, old);
  return modRoot;
}

function report(findings: EngineCheckReport['findings']): EngineCheckReport {
  return {
    schema: 'hoi4-engine-report/1',
    engine_version: '0.1.0',
    verdict: 'fail',
    inputs: {
      layers: [
        { kind: 'game', name: 'game', path: 'game', replace_paths: [] },
        { kind: 'mod', name: 'Guard', path: 'mod', replace_paths: [] },
      ],
    },
    summary: { errors: findings.length, warnings: 0, infos: 0, by_code: {} },
    stats: {},
    overrides: [],
    findings,
  };
}

const finding = (code: string, subject: string, file: string, line: number, layer = 'Guard') => ({
  code,
  severity: 'error' as const,
  message: `${subject} is invented`,
  path: file,
  layer,
  line,
  column: 1,
  subject,
});

describe('script guard', () => {
  it('guards the files changed in the window, newest first', async () => {
    const modRoot = await mod();
    expect(await guardedFiles(modRoot, { sinceMinutes: 120 })).toEqual({
      files: ['events/new.txt'],
      candidates: 1,
    });
    const wide = await guardedFiles(modRoot, { sinceMinutes: 600 });
    expect(wide.files).toEqual(['events/new.txt', 'common/ideas/old.txt']);
  });

  it('guards named files and refuses paths outside the mod', async () => {
    const modRoot = await mod();
    expect(
      await guardedFiles(modRoot, { paths: ['mod:common/ideas/old.txt'], sinceMinutes: 120 }),
    ).toEqual({ files: ['common/ideas/old.txt'], candidates: 1 });
    await expect(
      guardedFiles(modRoot, { paths: ['../outside.txt'], sinceMinutes: 120 }),
    ).rejects.toMatchObject({ code: 'SCRIPT_GUARD_PATH_OUTSIDE_MOD' });
    await expect(
      guardedFiles(modRoot, {
        paths: [path.join(modRoot, 'events', 'new.txt')],
        sinceMinutes: 120,
      }),
    ).rejects.toMatchObject({ code: 'SCRIPT_GUARD_PATH_OUTSIDE_MOD' });
    await expect(
      guardedFiles(modRoot, { paths: ['events/missing.txt'], sinceMinutes: 120 }),
    ).rejects.toMatchObject({ code: 'SCRIPT_GUARD_FILE_NOT_FOUND' });
  });

  it("reports only invented names in the guarded files of the mod's own layer", () => {
    const result = inventedNames(
      report([
        finding('REF_UNKNOWN_EFFECT', 'add_politcal_power', 'events/new.txt', 6),
        finding('LINT_UNKNOWN_MODIFIER', 'stabilty_factor', 'events/new.txt', 9),
        // Another file, another layer and another kind of finding are not the agent's.
        finding('REF_UNKNOWN_EFFECT', 'old_name', 'events/other.txt', 2),
        finding('REF_UNKNOWN_TRIGGER', 'game_name', 'events/new.txt', 3, 'game'),
        finding('LINT_FLAG_NEVER_SET', 'country:x', 'events/new.txt', 4),
      ]),
      ['events/new.txt'],
      1,
      [
        // Script validation adds what the engine does not read; a name both report counts once.
        {
          name: 'has_stabilty',
          kind: 'trigger',
          path: 'events/new.txt',
          line: 5,
          suggestion: 'has_stability',
          message: 'unresolved',
        },
        {
          name: 'add_politcal_power',
          kind: 'effect',
          path: 'events/new.txt',
          line: 6,
          message: 'unresolved',
        },
      ],
    );
    expect(scriptGuardDataSchema.safeParse(result).success).toBe(true);
    expect(result.verdict).toBe('invented');
    expect(result.counts).toEqual({ effect: 1, trigger: 1, modifier: 1 });
    expect(result.invented.map(({ name, line }) => `${line}:${name}`)).toEqual([
      '5:has_stabilty',
      '6:add_politcal_power',
      '9:stabilty_factor',
    ]);
    expect(result.files).toEqual([{ path: 'events/new.txt', invented: 3 }]);
  });

  it('is clean when nothing in the guarded files is invented', () => {
    const result = inventedNames(report([]), ['events/new.txt'], 3);
    expect(result).toMatchObject({ verdict: 'clean', filesChecked: 1, filesOmitted: 2 });
  });
});

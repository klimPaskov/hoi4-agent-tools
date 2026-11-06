import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedWorkspace } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  errorExplanations,
  explainErrors,
  splitLogLine,
} from '../../src/hoi4_agent_tools/reference/error-explain.js';
import { locateLogSource } from '../../src/hoi4_agent_tools/reference/error-log.js';
import { explainErrorDataSchema } from '../../src/hoi4_agent_tools/schemas/modder-tools.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<ResolvedWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-explain-'));
  cleanup.push(root);
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await mkdir(path.join(mod, 'events'), { recursive: true });
  await mkdir(path.join(game, 'common', 'scorers'), { recursive: true });
  await writeFile(
    path.join(mod, 'events', 'my_events.txt'),
    [
      'namespace = my',
      'country_event = {',
      '  id = my.1',
      '  trigger = {',
      '    stability > 0.5',
      '  }',
      '}',
    ].join('\n'),
  );
  await writeFile(path.join(game, 'common', 'scorers', 'scorer.txt'), 'scorer = { POL = yes }\n');
  return { modRoot: mod, gameRoot: game, dependencyRoots: [] } as unknown as ResolvedWorkspace;
}

const documented = {
  effect: new Set(['clr_country_flag', 'set_country_flag', 'add_political_power']),
  trigger: new Set(['has_stability', 'has_country_flag', 'has_war']),
  modifier: new Set(['stability_factor']),
};

describe('error.log explanations', () => {
  it('has unique ids, valid patterns and every placeholder filled by its pattern', () => {
    const ids = errorExplanations.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of errorExplanations) {
      const groups = new Set([...entry.pattern.matchAll(/\(\?<([a-z]+)>/gu)].map((m) => m[1]));
      for (const text of [entry.rule, entry.fix])
        for (const [, name] of text.matchAll(/\{([a-z]+)\}/gu))
          expect(groups.has(name), `${entry.id} uses {${name}}`).toBe(true);
    }
  });

  it('splits a wrapped parser error into its messages, each with its own line', () => {
    expect(
      splitLogLine(
        '[18:03:16][no_game_date]: Error: "Collection game:scope must define a name: game:scope, near line: 11 Unknown trigger-type: operators, near line: 12" in file: "common/decisions/a.txt" near line: 14',
      ),
    ).toEqual([
      {
        message: 'Collection game:scope must define a name: game:scope, near line: 11',
        file: 'common/decisions/a.txt',
        line: 11,
      },
      {
        message: 'Unknown trigger-type: operators, near line: 12',
        file: 'common/decisions/a.txt',
        line: 12,
      },
    ]);
    expect(splitLogLine('[18:02:52][no_game_date]: No localisation for my_key')).toEqual([
      { message: 'No localisation for my_key' },
    ]);
  });

  it('locates the line in the forms the game writes it', () => {
    expect(locateLogSource("Invalid trigger 'x' in events/a.txt line : 12", [])).toEqual({
      relativePath: 'events/a.txt',
      line: 12,
    });
    expect(locateLogSource('common/scripted_effects/b.txt:377: advisor role ...', [])).toEqual({
      relativePath: 'common/scripted_effects/b.txt',
      line: 377,
    });
    // The words before a bare path are not part of it.
    expect(locateLogSource('Something odd in events/c.txt line: 2', [])).toEqual({
      relativePath: 'events/c.txt',
      line: 2,
    });
  });

  it('explains an invented trigger with its rule, location, excerpt and closest names', async () => {
    const result = await explainErrors(
      {
        workspaceId: 'current',
        line: "[18:03:16][no_game_date]: Invalid trigger 'stability' in events/my_events.txt line : 5",
      },
      {
        workspace: await workspace(),
        documented,
        helpers: { effect: new Set(), trigger: new Set() },
      },
    );
    expect(explainErrorDataSchema.safeParse(result).success).toBe(true);
    const [explanation] = result.explanations;
    expect(explanation).toMatchObject({
      matched: 'catalogue',
      id: 'invalid_trigger',
      category: 'trigger',
      subject: 'stability',
      suggestions: ['has_stability'],
      source: { relativePath: 'events/my_events.txt', line: 5, layer: 'mod' },
      next: { tool: 'hoi4.script_validate', arguments: { path: 'events/my_events.txt' } },
    });
    expect(explanation!.source!.excerpt?.map(({ line }) => line)).toEqual([3, 4, 5, 6, 7]);
    expect(explanation!.note).toContain('does not list `stability`');
    expect(result.explained).toBe(1);
  });

  it('says when an effect is documented, so the problem is where it is used', async () => {
    const result = await explainErrors(
      { workspaceId: 'current', line: "Invalid effect 'has_war' in events/my_events.txt line : 2" },
      { workspace: await workspace(), documented },
    );
    expect(result.explanations[0]).toMatchObject({
      documentedAs: ['trigger'],
      note: expect.stringContaining('documented trigger, not an effect'),
    });
  });

  it('marks an error of the game files as the game, and gives a tag no command names', async () => {
    const result = await explainErrors(
      {
        workspaceId: 'current',
        line: "Invalid trigger 'POL' in common/scorers/scorer.txt line : 1",
      },
      { workspace: await workspace(), documented },
    );
    expect(result.explanations[0]).toMatchObject({
      source: { layer: 'game' },
      note: expect.stringContaining('The game files cause this line'),
    });
    expect(result.explanations[0]).not.toHaveProperty('suggestions');
  });

  it('falls back to a reviewed known mistake, then to the category', async () => {
    const result = await explainErrors(
      {
        workspaceId: 'current',
        lines: [
          'Event is triggered only, but does not have a 1 base-factor',
          'Something no entry describes',
        ],
      },
      { workspace: await workspace() },
    );
    expect(result.explanations.map(({ matched }) => matched)).toEqual(['catalogue', 'category']);
    expect(result.explained).toBe(1);
  });
});

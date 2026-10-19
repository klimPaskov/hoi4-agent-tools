import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  documentedCommandNames,
  installedEffectCommands,
} from '../../src/hoi4_agent_tools/core/game-documentation.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { analyzeEventSource } from '../../src/hoi4_agent_tools/event/source-analysis.js';
import { importFocusTrees } from '../../src/hoi4_agent_tools/focus/importer.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// An effect a later game version could add; the built-in list cannot know it.
const futureEffect = 'add_future_patch_effect';
const documentation = `## Table of Content
* [add_political_power](#add_political_power)
## Effects for scope COUNTRY
## add_political_power
Adds political power.
## ${futureEffect}\r
Added by a later patch.
`;

function eventFile(source: string): ScannedFile {
  const bytes = Buffer.from(source, 'utf8');
  return {
    absolutePath: '/fixture/events/future.txt',
    displayPath: 'fixture:events/future.txt',
    relativePath: 'events/future.txt',
    rootKind: 'fixture',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('installed game documentation', () => {
  it('reads command headings but not section or table-of-contents lines', () => {
    expect([...documentedCommandNames(documentation)].sort()).toEqual([
      futureEffect,
      'add_political_power',
    ]);
  });

  it('loads the installed effect list and reports nothing when it is absent', async () => {
    const game = await mkdtemp(path.join(os.tmpdir(), 'hoi4-game-docs-'));
    roots.push(game);
    expect(await installedEffectCommands(game)).toBeUndefined();
    expect(await installedEffectCommands(undefined)).toBeUndefined();
    await mkdir(path.join(game, 'documentation'));
    await writeFile(path.join(game, 'documentation', 'effects_documentation.md'), documentation);
    const loaded = await installedEffectCommands(game);
    expect(loaded?.names.has(futureEffect)).toBe(true);
    expect(loaded?.sha256).toBe(sha256Bytes(Buffer.from(documentation)));
  });

  it('treats a newly documented effect as native in event and focus analysis', () => {
    const source = `country_event = {
\tid = future.1
\tis_triggered_only = yes
\timmediate = { ${futureEffect} = yes }
\toption = { name = future.1.a }
}
`;
    const missing = (documented?: ReadonlySet<string>) =>
      analyzeEventSource(eventFile(source), {
        knownEventIds: new Set(['future.1']),
        ...(documented === undefined ? {} : { documentedEffectKeys: documented }),
      })
        .unresolved.filter(({ kind }) => kind === 'missing_helper')
        .map(({ expression }) => expression);
    expect(missing()).toEqual([futureEffect]);
    expect(missing(new Set([futureEffect]))).toEqual([]);

    const focus = parseClausewitz(
      Buffer.from(
        `focus_tree = { id = future_tree focus = { id = future_focus x = 0 y = 0 completion_reward = { ${futureEffect} = { amount = 1 } } } }`,
      ),
      'fixture:common/national_focus/future.txt',
    );
    const helperTargets = (nativeEffects?: ReadonlySet<string>) =>
      importFocusTrees(focus, nativeEffects === undefined ? {} : { nativeEffects })
        .plans.flatMap(({ focuses }) => focuses)
        .flatMap(({ links }) => links)
        .filter(({ kind }) => kind === 'helper')
        .map(({ target }) => target);
    expect(helperTargets()).toEqual([futureEffect]);
    expect(helperTargets(new Set([futureEffect]))).toEqual([]);
  });
});

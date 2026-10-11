import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  VERIFIED_GAME_CHECKSUM,
  VERIFIED_GAME_RAW_VERSION,
} from '../../src/hoi4_agent_tools/probability/model.js';

/**
 * The project-owned workspace behind the CI stdio smoke suite: the focus, GUI, technology,
 * event and probability acceptance fixtures merged into one mod, beside a small stand-in game
 * folder whose documentation is just large enough for the reference and script-validation tools.
 */

const fixtureRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures');

const EFFECT_NAMES = [
  'add_political_power',
  'add_stability',
  'set_country_flag',
  'clr_country_flag',
  'country_event',
  'add_ideas',
] as const;
const TRIGGER_NAMES = [
  'has_war',
  'is_major',
  'has_country_flag',
  'check_variable',
  'always',
] as const;

function documentation(title: string, scope: string, names: readonly string[]): string {
  return [
    `# ${title}`,
    '',
    '## Table of Content',
    '',
    `* [COUNTRY](#${title.toLowerCase()}-for-scope-country)`,
    '',
    `## ${title} for scope ${scope}`,
    '',
    ...names.map((name) => `* [${name}](#${name})`),
    '',
    ...names.flatMap((name) => [
      `## ${name}`,
      '',
      `* Supported Scopes: ${scope}`,
      '* Supported Targets: none',
      '',
      '```',
      `${name.replaceAll('_', ' ')} for the smoke fixture`,
      '```',
      '',
    ]),
  ].join('\n');
}

export async function buildSyntheticSmokeWorkspace(
  directory: string,
): Promise<{ mod: string; game: string; userRoot: string }> {
  const mod = path.join(directory, 'mod');
  const game = path.join(directory, 'game');
  const userRoot = path.join(directory, 'user');
  await mkdir(mod, { recursive: true });
  for (const name of ['focus', 'gui', 'technology', 'event', 'probability'])
    await cp(path.join(fixtureRoot, name, 'workspace'), mod, { recursive: true, force: false });
  // The focus and GUI fixtures name their localisation file alike; keep both.
  await cp(
    path.join(
      fixtureRoot,
      'gui',
      'workspace',
      'localisation',
      'english',
      'synthetic_acceptance_l_english.yml',
    ),
    path.join(mod, 'localisation', 'english', 'synthetic_gui_l_english.yml'),
  );
  await mkdir(path.join(mod, 'paradox_wiki'), { recursive: true });
  await writeFile(
    path.join(mod, 'paradox_wiki', 'Event modding - Hearts of Iron 4 Wiki.md'),
    '# Event modding\n\n## Events\n\nUse country_event to fire an event and add_political_power in an option.\n',
  );
  await mkdir(path.join(game, 'documentation'), { recursive: true });
  // The probability tools only run against the game version their adapters were verified for.
  await writeFile(
    path.join(game, 'launcher-settings.json'),
    JSON.stringify({
      version: `Smoke fixture v${VERIFIED_GAME_RAW_VERSION}.a000 (${VERIFIED_GAME_CHECKSUM})`,
      rawVersion: VERIFIED_GAME_RAW_VERSION,
    }),
  );
  await writeFile(
    path.join(game, 'documentation', 'effects_documentation.md'),
    documentation('Effects', 'COUNTRY', EFFECT_NAMES),
  );
  await writeFile(
    path.join(game, 'documentation', 'triggers_documentation.md'),
    documentation('Triggers', 'COUNTRY', TRIGGER_NAMES),
  );
  await mkdir(path.join(userRoot, 'logs'), { recursive: true });
  await writeFile(
    path.join(userRoot, 'logs', 'error.log'),
    [
      '[09:15:02][persistent.cpp:48]: Error: "Unexpected token: }, near line: 12" in file: "events/synthetic_alpha_01.txt" near line: 14',
      '[09:15:03][localisation.cpp:300]: Missing localisation key: synthetic_alpha.1.t',
      '[09:15:04][gfx.cpp:22]: Texture file not found: "gfx/interface/missing.dds"',
      '',
    ].join('\n'),
  );
  return { mod, game, userRoot };
}

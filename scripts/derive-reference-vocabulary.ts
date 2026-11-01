import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { textTerms } from '../src/hoi4_agent_tools/reference/ranking.js';
import { localisationVocabulary } from '../src/hoi4_agent_tools/reference/vocabulary.js';

/**
 * Mines player words that script spells differently from an installed game's localisation.
 *
 * `EFFECT_`, `TRIGGER_` and `MODIFIER_` keys name a script command or modifier, and their
 * text is what a player reads for it: `MODIFIER_ARMY_DEFENCE_FACTOR` reads "Division
 * Defense". A text word that recurs with a key word the text never uses, in both
 * directions often enough, is the player's word for that script word. Only script words
 * that appear in documented command names are kept. The output is compared with
 * `localisationVocabulary`; review a difference before changing that list.
 */
const MIN_PAIRS = 3;
const MIN_PLAYER_SHARE = 0.5;
const MIN_SCRIPT_SHARE = 0.3;
const files = ['effects_l_english.yml', 'triggers_l_english.yml', 'modifiers_l_english.yml'];
const gameRoot = process.argv[2];
if (gameRoot === undefined) {
  process.stderr.write('Usage: tsx scripts/derive-reference-vocabulary.ts GAME_ROOT\n');
  process.exit(2);
}

const entry = /^\s*([A-Za-z0-9_.]+):\d*\s*"(.*)"\s*(?:#.*)?$/u;
const keyNoise = /(^|_)(?:NOT|NO|YES|TT|DESC|TOOLTIP|DETAILED|HEADER)(?=_|$)/gu;
const plainText = (text: string) =>
  text
    .replaceAll('\\n', ' ')
    .replace(/\$[^$]*\$/gu, ' ')
    .replace(/§./gu, ' ')
    .replace(/£\S*/gu, ' ')
    .replace(/\[[^\]]*\]/gu, ' ')
    .replace(/@\S*/gu, ' ');
const words = (text: string) => new Set(textTerms(text).filter((term) => !term.includes('_')));

const surfaces = new Map<string, Map<string, number>>();
function remember(text: string): void {
  for (const raw of text.toLowerCase().match(/[a-z]+/gu) ?? []) {
    const [stem] = textTerms(raw);
    if (stem === undefined) continue;
    const forms = surfaces.get(stem) ?? new Map<string, number>();
    forms.set(raw, (forms.get(raw) ?? 0) + 1);
    surfaces.set(stem, forms);
  }
}
const surface = (stem: string) =>
  [...(surfaces.get(stem) ?? new Map([[stem, 1]]))].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]![0];

const pairs: Array<{ key: Set<string>; text: Set<string> }> = [];
const phrases: Array<{ command: string; text: string }> = [];
for (const name of files) {
  const content = await readFile(path.join(gameRoot, 'localisation', 'english', name), 'utf8');
  for (const line of (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(
    /\r?\n/u,
  )) {
    const match = entry.exec(line);
    const prefix = match === null ? null : /^(?:EFFECT|TRIGGER|MODIFIER)_/u.exec(match[1]!);
    if (match === null || prefix === null) continue;
    const key = match[1]!.slice(prefix[0].length).replace(keyNoise, '_').replaceAll('_', ' ');
    const text = plainText(match[2]!);
    remember(key);
    remember(text);
    // A placeholder between two words leaves a fragment ("becomes $TYPE$ of"), not a phrase.
    const runs = match[2]!
      .replaceAll('\\n', ' ')
      .replace(/§.|£\S*/gu, ' ')
      .split(/\S*\$[^$]*\$\S*|\[[^\]]*\]|@\S*/u)
      .map((run) => (run.toLowerCase().match(/[a-z]+/gu) ?? []).join(' '))
      .filter(Boolean);
    if (runs.length === 1)
      phrases.push({ command: key.trim().toLowerCase().split(/\s+/u).join('_'), text: runs[0]! });
    const pair = { key: words(key), text: words(text) };
    if (pair.key.size > 0 && pair.text.size > 0) pairs.push(pair);
  }
}

// Script words that documented command names use; anything else cannot reach a heading.
const documented = new Set<string>();
const commands = new Set<string>();
for (const name of ['effects_documentation.md', 'triggers_documentation.md'])
  for (const line of (await readFile(path.join(gameRoot, 'documentation', name), 'utf8')).split(
    /\r?\n/u,
  )) {
    const heading = /^## ([a-z0-9_]+)$/u.exec(line);
    if (heading === null) continue;
    commands.add(heading[1]!);
    for (const word of words(heading[1]!.replaceAll('_', ' '))) documented.add(word);
  }

// A short tooltip for a documented command is the player's whole phrase for it: the
// `has_war` trigger reads "At war".
// One word, or words that only say "add" or "at least", would attach a command to every
// question that uses them.
const generic = new Set(
  textTerms(
    'add remove activate set create not all following active effect end least most more less',
  ),
);
const named = new Map<string, Set<string>>();
for (const { command, text } of phrases) {
  const length = text.split(' ').length;
  const content = [...words(text)].filter((word) => !generic.has(word));
  if (!commands.has(command) || content.length === 0 || length < 2 || length > 3) continue;
  const commandsForText = named.get(text) ?? new Set<string>();
  commandsForText.add(command);
  named.set(text, commandsForText);
}

const textCount = new Map<string, number>();
const keyCount = new Map<string, number>();
const together = new Map<string, number>();
for (const { key, text } of pairs) {
  for (const word of text) textCount.set(word, (textCount.get(word) ?? 0) + 1);
  for (const word of key) keyCount.set(word, (keyCount.get(word) ?? 0) + 1);
  for (const player of text)
    if (!key.has(player))
      for (const script of key)
        if (!text.has(script))
          together.set(`${player} ${script}`, (together.get(`${player} ${script}`) ?? 0) + 1);
}
const derived = [...together]
  .map(([pair, count]) => {
    const [player, script] = pair.split(' ') as [string, string];
    return {
      player: surface(player),
      script: surface(script),
      pairs: count,
      playerShare: count / textCount.get(player)!,
      scriptShare: count / keyCount.get(script)!,
      documented: documented.has(script),
    };
  })
  .filter(
    ({ pairs: count, playerShare, scriptShare, documented: known }) =>
      known &&
      count >= MIN_PAIRS &&
      playerShare >= MIN_PLAYER_SHARE &&
      scriptShare >= MIN_SCRIPT_SHARE,
  )
  .sort((left, right) => right.pairs - left.pairs || left.player.localeCompare(right.player));

const committed = new Set(
  localisationVocabulary.map(({ player, script }) => `${player} ${script}`),
);
const mined = new Set([
  ...derived.map(({ player, script }) => `${player} ${script}`),
  ...[...named].map(([player, names]) => `${player} ${[...names][0]!}`),
]);
process.stdout.write(
  `${JSON.stringify(
    {
      entries: pairs.length,
      derived: derived.map(({ playerShare, scriptShare, ...row }) => ({
        ...row,
        playerShare: Number(playerShare.toFixed(2)),
        scriptShare: Number(scriptShare.toFixed(2)),
        committed: committed.has(`${row.player} ${row.script}`),
      })),
      phrases: [...named]
        .filter(([, names]) => names.size === 1)
        .map(([player, names]) => ({
          player,
          script: [...names][0]!,
          committed: committed.has(`${player} ${[...names][0]!}`),
        }))
        .sort((left, right) => left.script.localeCompare(right.script)),
      committedButNotDerived: [...committed].filter((pair) => !mined.has(pair)),
    },
    null,
    2,
  )}\n`,
);

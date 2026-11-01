import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Bytes } from '../core/canonical.js';
import { isWithin } from '../core/workspace.js';

/**
 * The words a player reads for script commands and modifiers.
 *
 * The game's English localisation names each command's tooltip after it: `TRIGGER_IS_COASTAL`
 * reads "Is coastal", `TRIGGER_HAS_IDEA_COUNTRY` reads "Has national spirit", and
 * `MODIFIER_SUPPLY_CONSUMPTION_FACTOR` reads "Supply Consumption". These are the words a
 * modder uses to describe the command, so search adds them to the command's entries.
 */
const files = ['effects_l_english.yml', 'triggers_l_english.yml', 'modifiers_l_english.yml'];
const MAX_FILE_BYTES = 2_000_000;
const entry = /^\s*([A-Za-z0-9_.]+):\d*\s*"(.*)"\s*(?:#.*)?$/u;
// Negated and descriptive variants of a key describe the same command.
const keyNoise = /(?:^|_)(?:NOT|NO|YES|TT|DESC|TOOLTIP|DETAILED|HEADER)(?=_|$)/gu;

export interface GameText {
  revision: string;
  /** Lowercase key without its `EFFECT_`, `TRIGGER_` or `MODIFIER_` prefix, to its texts. */
  texts: ReadonlyMap<string, readonly string[]>;
}

const empty: GameText = { revision: 'none', texts: new Map() };
const cache = new Map<string, { stamp: string; text: GameText }>();

/** Plain words of a localisation value, without formatting codes or placeholders. */
export function plainLocalisation(value: string): string {
  return value
    .replaceAll('\\n', ' ')
    .replace(/\$[^$]*\$/gu, ' ')
    .replace(/§.|£\S*/gu, ' ')
    .replace(/\[[^\]]*\]|@\S*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export async function readGameText(gameRoot: string | undefined): Promise<GameText> {
  if (gameRoot === undefined) return empty;
  let root: string;
  try {
    root = await realpath(path.join(gameRoot, 'localisation', 'english'));
  } catch {
    return empty;
  }
  if (!isWithin(await realpath(gameRoot), root)) return empty;
  const stamps: string[] = [];
  const paths: string[] = [];
  for (const name of files) {
    try {
      const file = path.join(root, name);
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) continue;
      stamps.push(`${name}:${metadata.size}:${metadata.mtimeMs}:${metadata.ino}`);
      paths.push(file);
    } catch {
      // A missing file leaves its commands without in-game text.
    }
  }
  const stamp = stamps.join('|');
  const known = cache.get(root);
  if (known?.stamp === stamp) return known.text;
  const texts = new Map<string, string[]>();
  const hashes: string[] = [];
  for (const file of paths) {
    const bytes = await readFile(file);
    hashes.push(sha256Bytes(bytes));
    const content = bytes.toString('utf8');
    for (const line of (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(
      /\r?\n/u,
    )) {
      const match = entry.exec(line);
      const prefix = match === null ? null : /^(?:EFFECT|TRIGGER|MODIFIER)_/u.exec(match[1]!);
      if (match === null || prefix === null) continue;
      const key = match[1]!
        .slice(prefix[0].length)
        .replace(keyNoise, '')
        .replace(/__+/gu, '_')
        .replace(/^_|_$/gu, '')
        .toLowerCase();
      const value = plainLocalisation(match[2]!);
      if (key.length === 0 || value.length === 0) continue;
      const list = texts.get(key) ?? [];
      list.push(value);
      texts.set(key, list);
    }
  }
  const text = { revision: sha256Bytes(Buffer.from(hashes.join('\n'), 'utf8')), texts };
  cache.set(root, { stamp, text });
  return text;
}

/**
 * The game texts for each command name: an exact key, or the longest command that a key
 * extends at an underscore (`has_idea_country` describes `has_idea`).
 */
export function commandTexts(commands: ReadonlySet<string>, text: GameText): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, values] of text.texts) {
    let name = key;
    while (!commands.has(name)) {
      const cut = name.lastIndexOf('_');
      if (cut <= 0) break;
      name = name.slice(0, cut);
    }
    if (!commands.has(name)) continue;
    result.set(name, [...(result.get(name) ?? []), ...values]);
  }
  return result;
}

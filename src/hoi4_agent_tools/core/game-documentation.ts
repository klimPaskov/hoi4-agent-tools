import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Bytes } from './canonical.js';

/** Command names documented by the installed game, with a hash that identifies the source. */
export interface DocumentedCommands {
  names: ReadonlySet<string>;
  sha256: string;
}

/** `## name` headings of an installed `*_documentation.md` file. */
export function documentedCommandNames(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^## ([a-z_][a-z0-9_]*)[ \t]*\r?$/gmu)].map((match) => match[1]!),
  );
}

/**
 * Read the effect names the installed game documents. Each game version ships this file, so
 * effects added by a later patch are recognized without a tool update. Absent or unreadable
 * documentation returns `undefined` and callers fall back to their built-in list.
 */
export async function installedEffectCommands(
  gameRoot: string | undefined,
): Promise<DocumentedCommands | undefined> {
  if (gameRoot === undefined) return undefined;
  try {
    const bytes = await readFile(path.join(gameRoot, 'documentation', 'effects_documentation.md'));
    const names = documentedCommandNames(bytes.toString('utf8'));
    return names.size === 0 ? undefined : { names, sha256: sha256Bytes(bytes) };
  } catch {
    return undefined;
  }
}

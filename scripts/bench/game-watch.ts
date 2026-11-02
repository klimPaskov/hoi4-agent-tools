import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { glob } from 'glob';
import { documentedEffects, renderNativeEffects } from '../generate-native-effects.js';

/**
 * The nightly game-update watcher (watch and report). It records the installed game's build and
 * a hash of every heading of its own documentation. When the build or the documentation changes
 * it reports what changed, regenerates what can be derived from the game's files into the
 * benchmark data folder for review, and lists what a person or agent must re-check. It reads
 * the game's files only, never starts the game, and changes nothing in a repository or package.
 */

const run = promisify(execFile);
const NATIVE_EFFECTS = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'hoi4_agent_tools',
  'focus',
  'native-effects.ts',
);

export interface GameBuild {
  rawVersion: string;
  version: string;
  /** Per documentation file: heading -> first 16 hex characters of the section's SHA-256. */
  docs: Record<string, Record<string, string>>;
}

export interface GameUpdate {
  status: 'recorded' | 'unchanged' | 'changed';
  build: GameBuild;
  previous?: Pick<GameBuild, 'rawVersion' | 'version'>;
  files: { added: string[]; removed: string[]; changed: string[] };
  headings: Array<{ file: string; added: string[]; removed: string[]; changed: string[] }>;
  nativeEffects?: { added: string[]; removed: string[]; proposed: string };
  wikiStatus?: string;
  recheck: string[];
}

function sections(markdown: string): Record<string, string> {
  const result: Record<string, string> = {};
  let heading = '(preamble)';
  let lines: string[] = [];
  const flush = (): void => {
    const text = lines.join('\n').trim();
    if (text !== '' || heading !== '(preamble)')
      result[heading] = createHash('sha256').update(text).digest('hex').slice(0, 16);
  };
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    flush();
    heading = match[1]!;
    lines = [];
  }
  flush();
  return result;
}

export async function readGameBuild(gameRoot: string): Promise<GameBuild> {
  const settings = JSON.parse(
    await readFile(path.join(gameRoot, 'launcher-settings.json'), 'utf8'),
  ) as { rawVersion?: string; version?: string };
  const files = (
    await glob(['documentation/*.md', 'common/**/_documentation.md'], {
      cwd: gameRoot,
      nodir: true,
      posix: true,
    })
  ).sort();
  const docs: GameBuild['docs'] = {};
  for (const file of files)
    docs[file] = sections(await readFile(path.join(gameRoot, file), 'utf8'));
  return { rawVersion: settings.rawVersion ?? 'unknown', version: settings.version ?? '', docs };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

export function diffBuilds(
  previous: GameBuild,
  next: GameBuild,
): Pick<GameUpdate, 'files' | 'headings'> {
  const before = new Set(Object.keys(previous.docs));
  const after = new Set(Object.keys(next.docs));
  const headings: GameUpdate['headings'] = [];
  const changed: string[] = [];
  for (const file of sorted(after)) {
    if (!before.has(file)) continue;
    const old = previous.docs[file]!;
    const now = next.docs[file]!;
    const added = sorted(Object.keys(now).filter((heading) => !(heading in old)));
    const removed = sorted(Object.keys(old).filter((heading) => !(heading in now)));
    const edited = sorted(
      Object.keys(now).filter((heading) => heading in old && old[heading] !== now[heading]),
    );
    if (added.length + removed.length + edited.length === 0) continue;
    changed.push(file);
    headings.push({ file, added, removed, changed: edited });
  }
  return {
    files: {
      added: sorted([...after].filter((file) => !before.has(file))),
      removed: sorted([...before].filter((file) => !after.has(file))),
      changed,
    },
    headings,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The kit's wiki review status, read-only; absent when the kit is not checked out here. */
async function wikiStatus(): Promise<string | undefined> {
  const kit =
    process.env.HOI4_KIT_ROOT ??
    path.resolve(import.meta.dirname, '..', '..', '..', 'agentic-hoi4-modding');
  const script = path.join(kit, '.tools', 'wiki', 'wiki_status.py');
  if (!(await exists(script))) return undefined;
  for (const python of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    try {
      const { stdout } = await run(python, ['-B', script], {
        cwd: kit,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 300_000,
      });
      return stdout.trim();
    } catch (error) {
      const output = (error as { stdout?: string }).stdout;
      // wiki_status.py exits non-zero when pages are stale; its report is still the answer.
      if (typeof output === 'string' && output.trim() !== '') return output.trim();
    }
  }
  return undefined;
}

/**
 * Compares the installed build with the recorded one, writes what changed into
 * `<dataRoot>/game-update/<build>/`, then records the installed build as current.
 */
export async function watchGame(gameRoot: string, dataRoot: string): Promise<GameUpdate> {
  const build = await readGameBuild(gameRoot);
  const recordFile = path.join(dataRoot, 'game-build.json');
  let previous: GameBuild | undefined;
  try {
    previous = JSON.parse(await readFile(recordFile, 'utf8')) as GameBuild;
  } catch {
    previous = undefined;
  }
  await mkdir(dataRoot, { recursive: true });
  const empty = { files: { added: [], removed: [], changed: [] }, headings: [] };
  if (previous === undefined) {
    await writeFile(recordFile, `${JSON.stringify(build)}\n`);
    return { status: 'recorded', build, ...empty, recheck: [] };
  }
  const diff = diffBuilds(previous, build);
  const same =
    previous.rawVersion === build.rawVersion &&
    previous.version === build.version &&
    diff.files.added.length + diff.files.removed.length + diff.files.changed.length === 0;
  if (same) return { status: 'unchanged', build, ...empty, recheck: [] };

  const folder = path.join(dataRoot, 'game-update', build.rawVersion);
  await mkdir(folder, { recursive: true });
  const effects = documentedEffects(
    await readFile(path.join(gameRoot, 'documentation', 'effects_documentation.md'), 'utf8'),
  );
  const proposed = path.join(folder, 'native-effects.ts');
  await writeFile(proposed, renderNativeEffects(effects, build.rawVersion));
  const current = new Set(
    [...(await readFile(NATIVE_EFFECTS, 'utf8')).matchAll(/^\s+'([a-z0-9_]+)',$/gmu)].map(
      (match) => match[1]!,
    ),
  );
  const generated = new Set(effects);
  const nativeEffects = {
    added: effects.filter((name) => !current.has(name)),
    removed: sorted([...current].filter((name) => !generated.has(name))),
    proposed,
  };
  const wiki = await wikiStatus();
  const recheck = [
    'Benchmark answers on vanilla whose outcome moved with the build (listed under the changed corpus in the report).',
    'Probability adapters (src/hoi4_agent_tools/probability/adapters.ts and VERIFIED_GAME_* in model.ts): hand-kept, re-verify against the changed documentation.',
    `Native-effects fallback list: ${nativeEffects.added.length} added, ${nativeEffects.removed.length} removed; review the regenerated ${path.basename(proposed)} and run scripts/generate-native-effects.ts in a PR.`,
    'Known-mistake rules and the script-validation scope-link table (src/hoi4_agent_tools/reference): hand-kept.',
    'Lookup vocabulary derived from localisation (reference_search): regenerate with its generator once it exists.',
    wiki === undefined
      ? 'Kit wiki pages: run the kit tool .tools/wiki/wiki_status.py (the kit is not checked out next to this repository).'
      : 'Kit wiki pages: see the wiki_status.py report.',
  ];
  const update: GameUpdate = {
    status: 'changed',
    build,
    previous: { rawVersion: previous.rawVersion, version: previous.version },
    ...diff,
    nativeEffects,
    ...(wiki === undefined ? {} : { wikiStatus: wiki }),
    recheck,
  };
  await writeFile(path.join(folder, 'report.md'), gameUpdateMarkdown(update));
  await writeFile(
    path.join(dataRoot, `game-build-${previous.rawVersion}.json`),
    `${JSON.stringify(previous)}\n`,
  );
  await writeFile(recordFile, `${JSON.stringify(build)}\n`);
  return update;
}

export function gameUpdateMarkdown(update: GameUpdate): string {
  if (update.status === 'recorded')
    return `## Game build\n\nRecorded ${update.build.version || update.build.rawVersion} as the watched build.\n`;
  if (update.status === 'unchanged')
    return `## Game build\n\n${update.build.version || update.build.rawVersion}, unchanged since the last run.\n`;
  const lines = [
    '## Game build changed',
    '',
    `${update.previous?.version ?? ''} (${update.previous?.rawVersion ?? ''}) -> ${update.build.version || update.build.rawVersion}. Nothing in a repository, mod or package was changed.`,
    '',
    `- Documentation files added: ${update.files.added.join(', ') || 'none'}`,
    `- Documentation files removed: ${update.files.removed.join(', ') || 'none'}`,
    `- Documentation files changed: ${update.files.changed.join(', ') || 'none'}`,
    ...update.headings.flatMap(({ file, added, removed, changed }) => [
      `  - ${file}: ${[
        added.length > 0 ? `added ${added.join(', ')}` : '',
        removed.length > 0 ? `removed ${removed.join(', ')}` : '',
        changed.length > 0 ? `changed ${changed.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')}`,
    ]),
    ...(update.nativeEffects === undefined
      ? []
      : [
          `- Native effects regenerated for review: ${update.nativeEffects.added.length} new (${update.nativeEffects.added.slice(0, 20).join(', ')}), ${update.nativeEffects.removed.length} gone (${update.nativeEffects.removed.slice(0, 20).join(', ')}).`,
        ]),
    '',
    '### To re-check',
    '',
    ...update.recheck.map((item) => `- ${item}`),
    ...(update.wikiStatus === undefined
      ? []
      : ['', '### Kit wiki status', '', '```text', update.wikiStatus.slice(0, 6000), '```']),
    '',
  ];
  return lines.join('\n');
}

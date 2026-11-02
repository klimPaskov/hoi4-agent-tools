import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Corpus } from './schema.js';

/**
 * Finds the benchmark corpora on this machine and pins what was measured: the game build, the
 * Git commit of a mod repository, the Workshop manifest of a Workshop item, and a content hash
 * over every script, interface and localisation file. Nothing here writes to a corpus.
 */

const run = promisify(execFile);
const HOI4_APP_ID = '394360';
/** Files whose content decides what the tools answer; images and sound do not. */
const HASHED_EXTENSIONS = new Set([
  '.txt',
  '.gui',
  '.gfx',
  '.yml',
  '.mod',
  '.lua',
  '.csv',
  '.map',
  '.asset',
  '.md',
]);
/** The folders the game loads; tooling, docs and agent worktrees in a mod repository are not hashed. */
const GAME_DIRECTORIES = new Set([
  'common',
  'events',
  'history',
  'interface',
  'localisation',
  'map',
  'gfx',
  'music',
  'sound',
  'portraits',
  'tutorial',
  'dlc',
]);

export interface LocatedCorpus {
  corpus: Corpus;
  /** The workspace root the server is configured with; absent when unavailable. */
  root?: string;
  unavailable?: string;
}

export interface CorpusPin {
  id: string;
  /** One line that changes whenever the measured content can change. */
  identity: string;
  version?: string;
  gitCommit?: string;
  gitDirtyFiles?: number;
  workshopManifest?: string;
  workshopUpdated?: number;
  contentHash?: string;
  files?: number;
  bytes?: number;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function steamRoots(): string[] {
  const home = os.homedir();
  return [
    ...(process.env.HOI4_STEAM_ROOT === undefined ? [] : [process.env.HOI4_STEAM_ROOT]),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    path.join(home, 'Library', 'Application Support', 'Steam'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
  ];
}

/** Every Steam library folder, read from each Steam root's `libraryfolders.vdf`. */
export async function steamLibraries(): Promise<string[]> {
  const libraries: string[] = [];
  for (const root of steamRoots()) {
    if (!(await isDirectory(path.join(root, 'steamapps')))) continue;
    libraries.push(root);
    try {
      const vdf = await readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/gu))
        libraries.push(match[1]!.replaceAll('\\\\', '\\'));
    } catch {
      // A Steam root without a library list has only itself.
    }
  }
  const unique: string[] = [];
  for (const library of libraries) {
    const resolved = path.resolve(library);
    if (!unique.some((known) => known.toLowerCase() === resolved.toLowerCase()))
      unique.push(resolved);
  }
  return unique;
}

export async function findGameRoot(): Promise<string | undefined> {
  const candidates = [
    ...(process.env.HOI4_GAME_ROOT === undefined ? [] : [process.env.HOI4_GAME_ROOT]),
    ...(await steamLibraries()).map((library) =>
      path.join(library, 'steamapps', 'common', 'Hearts of Iron IV'),
    ),
  ];
  for (const candidate of candidates) if (await isDirectory(candidate)) return candidate;
  return undefined;
}

/** The game's user-data folder (`logs/`, `mod/`). */
export async function findUserRoot(): Promise<string | undefined> {
  const home = os.homedir();
  const folder = path.join('Paradox Interactive', 'Hearts of Iron IV');
  const candidates = [
    ...(process.env.HOI4_USER_ROOT === undefined ? [] : [process.env.HOI4_USER_ROOT]),
    ...(process.env.OneDrive === undefined
      ? []
      : [path.join(process.env.OneDrive, 'Documents', folder)]),
    path.join(home, 'Documents', folder),
    path.join(home, '.local', 'share', folder),
  ];
  for (const candidate of candidates)
    if (await isDirectory(path.join(candidate, 'mod'))) return candidate;
  return undefined;
}

export async function locateCorpus(corpus: Corpus): Promise<LocatedCorpus> {
  if (corpus.kind === 'synthetic') return { corpus };
  if (corpus.kind === 'game') {
    const root = await findGameRoot();
    return root === undefined
      ? { corpus, unavailable: 'The installed game was not found (set HOI4_GAME_ROOT).' }
      : { corpus, root };
  }
  if (corpus.kind === 'mod') {
    const modRoot =
      process.env.HOI4_MOD_ROOT ??
      ((await findUserRoot()) === undefined
        ? undefined
        : path.join((await findUserRoot())!, 'mod'));
    const root = modRoot === undefined ? undefined : path.join(modRoot, corpus.folder ?? corpus.id);
    return root !== undefined && (await isDirectory(root))
      ? { corpus, root }
      : { corpus, unavailable: `Mod folder ${corpus.folder ?? corpus.id} is not installed.` };
  }
  for (const library of await steamLibraries()) {
    const root = path.join(
      library,
      'steamapps',
      'workshop',
      'content',
      HOI4_APP_ID,
      corpus.workshopId ?? '',
    );
    if (corpus.workshopId !== undefined && (await isDirectory(root))) return { corpus, root };
  }
  return { corpus, unavailable: `Workshop item ${corpus.workshopId ?? '?'} is not subscribed.` };
}

async function textFiles(root: string, relative = ''): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && (relative !== '' || GAME_DIRECTORIES.has(entry.name)))
        found.push(...(await textFiles(root, child)));
    } else if (
      entry.isFile() &&
      (relative !== '' || entry.name === 'descriptor.mod') &&
      HASHED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    )
      found.push(child);
  }
  return found;
}

/** Per-file digests from an earlier run, keyed by relative path: [size, mtimeMs, sha256]. */
export type HashCache = Record<string, [number, number, string]>;

/**
 * SHA-256 over the sorted relative paths, sizes and per-file SHA-256 of every hashed file under
 * `root`. Opening a file costs several milliseconds on Windows, so files are read in parallel
 * and a file whose size and modification time match `cache` is not read again.
 */
export async function contentHash(
  root: string,
  cache: HashCache = {},
): Promise<{ hash: string; files: number; bytes: number; cache: HashCache }> {
  const files = (await textFiles(root)).sort();
  const next: HashCache = {};
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const file = files[cursor++]!;
      const absolute = path.join(root, file);
      const info = await stat(absolute);
      const known = cache[file];
      if (known?.[0] === info.size && known[1] === info.mtimeMs) {
        next[file] = known;
        continue;
      }
      const digest = createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex');
      next[file] = [info.size, info.mtimeMs, digest];
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const [size, , digest] = next[file]!;
    bytes += size;
    hash.update(`${file}\0${size}\0${digest}\n`);
  }
  return { hash: hash.digest('hex'), files: files.length, bytes, cache: next };
}

async function git(root: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-c', 'core.autocrlf=false', '-C', root, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function workshopManifest(
  root: string,
  id: string,
): Promise<{ manifest?: string; updated?: number }> {
  const acf = path.join(root, '..', '..', '..', `appworkshop_${HOI4_APP_ID}.acf`);
  try {
    const text = await readFile(acf, 'utf8');
    const block = new RegExp(`"${id}"\\s*\\{([^}]*)\\}`, 'u').exec(text)?.[1] ?? '';
    const manifest = /"manifest"\s+"([^"]+)"/u.exec(block)?.[1];
    const updated = /"timeupdated"\s+"([0-9]+)"/u.exec(block)?.[1];
    return {
      ...(manifest === undefined ? {} : { manifest }),
      ...(updated === undefined ? {} : { updated: Number(updated) }),
    };
  } catch {
    return {};
  }
}

async function descriptorVersion(root: string): Promise<string | undefined> {
  try {
    const descriptor = await readFile(path.join(root, 'descriptor.mod'), 'utf8');
    return /^\s*version\s*=\s*"([^"]*)"/mu.exec(descriptor)?.[1];
  } catch {
    return undefined;
  }
}

async function gameVersion(root: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(
      await readFile(path.join(root, 'launcher-settings.json'), 'utf8'),
    ) as {
      rawVersion?: string;
    };
    return settings.rawVersion;
  } catch {
    return undefined;
  }
}

/** What was measured, so a later run can tell a regression from a changed corpus. */
export async function pinCorpus(
  located: LocatedCorpus,
  hashContent: boolean,
  cacheDirectory?: string,
): Promise<CorpusPin> {
  const { corpus, root } = located;
  if (root === undefined) return { id: corpus.id, identity: 'unavailable' };
  const pin: CorpusPin = { id: corpus.id, identity: '' };
  if (corpus.kind === 'game') {
    const version = await gameVersion(root);
    if (version !== undefined) pin.version = version;
  } else {
    const version = await descriptorVersion(root);
    if (version !== undefined) pin.version = version;
  }
  if (corpus.kind === 'mod') {
    const head = (await git(root, 'rev-parse', 'HEAD'))?.trim();
    if (head !== undefined && head !== '') {
      pin.gitCommit = head;
      const status = await git(root, 'status', '--porcelain', '--untracked-files=no');
      pin.gitDirtyFiles = status === undefined ? 0 : status.split('\n').filter(Boolean).length;
    }
  }
  if (corpus.kind === 'workshop' && corpus.workshopId !== undefined) {
    const { manifest, updated } = await workshopManifest(root, corpus.workshopId);
    if (manifest !== undefined) pin.workshopManifest = manifest;
    if (updated !== undefined) pin.workshopUpdated = updated;
  }
  if (hashContent) {
    const cacheFile =
      cacheDirectory === undefined ? undefined : path.join(cacheDirectory, `${corpus.id}.json`);
    let cache: HashCache = {};
    if (cacheFile !== undefined)
      try {
        cache = JSON.parse(await readFile(cacheFile, 'utf8')) as HashCache;
      } catch {
        // No cache yet: every file is read.
      }
    const content = await contentHash(root, cache);
    if (cacheFile !== undefined) {
      await mkdir(cacheDirectory!, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(content.cache));
    }
    pin.contentHash = content.hash;
    pin.files = content.files;
    pin.bytes = content.bytes;
  }
  pin.identity = [
    pin.version ?? '',
    pin.gitCommit ?? '',
    pin.workshopManifest ?? '',
    pin.contentHash ?? '',
  ].join('|');
  return pin;
}

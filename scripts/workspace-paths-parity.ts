import { lstat, mkdir, mkdtemp, opendir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { sharedResidentEngine } from '../src/hoi4_agent_tools/core/resident-engine.js';
import { ServiceError } from '../src/hoi4_agent_tools/core/result.js';
import {
  canonicalPath,
  isPortablePathSegment,
  isWithin,
  WorkspaceResolver,
  type ResolvedRoot,
  type ResolvedWorkspace,
} from '../src/hoi4_agent_tools/core/workspace.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * Parity check for the canonical-path checks on the shared Rust engine (ADR 0089, step 2, first
 * piece). On the installed game and each benchmark mod it resolves workspace-relative paths with
 * `WorkspaceResolver.resolvePath`, which now asks `hoi4-engine paths.resolve`, and with the
 * TypeScript resolution it replaced (kept below), and diffs the answer: the real path and root, or
 * the refusal code. Nothing is written: a write resolution only names the path.
 *
 *   npx tsx scripts/workspace-paths-parity.ts [--corpus vanilla,zin] [--max-files 40000] [--out FILE]
 *
 * The paths are every file of each root (every n-th when a root has more than `--max-files`), a
 * missing file beside each sampled one, and a fixed set of unsafe spellings. Each path is resolved
 * for read in every root, and every tenth one also for write and per root kind. The engine is
 * `HOI4_ENGINE` or the bundled binary. Exit status 1 when anything differs.
 */

const { values } = parseArgs({
  options: {
    corpus: { type: 'string' },
    out: { type: 'string' },
    'max-files': { type: 'string', default: '40000' },
  },
});
const maxFiles = Number(values['max-files']);
const located = locateEngineBinary();
if (!('path' in located)) {
  process.stderr.write(`${located.message}\n`);
  process.exit(2);
}

// The TypeScript resolution before ADR 0089, unchanged apart from taking the workspace directly.
function legacyAssertRelative(relativePath: string): void {
  if (relativePath.length === 0)
    throw new ServiceError('PATH_EMPTY', 'Workspace-relative path cannot be empty');
  if (relativePath.includes('\0')) throw new ServiceError('PATH_NUL', 'Path contains a NUL byte');
  if (path.isAbsolute(relativePath))
    throw new ServiceError('PATH_ABSOLUTE_REJECTED', 'Only workspace-relative paths are accepted');
  const segments = relativePath.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..'))
    throw new ServiceError('PATH_TRAVERSAL', 'Parent path segments are not allowed');
  if (segments.some((segment) => segment.includes(':')))
    throw new ServiceError(
      'PATH_ALTERNATE_STREAM',
      'Colon characters and alternate data streams are not allowed',
    );
  if (
    segments.some(
      (segment) => segment !== '.' && segment.length > 0 && !isPortablePathSegment(segment),
    )
  )
    throw new ServiceError(
      'PATH_WINDOWS_DEVICE',
      'Portable paths cannot contain device names, control characters, or ambiguous characters',
    );
}

async function exists(value: string): Promise<boolean> {
  return lstat(value).then(
    () => true,
    () => false,
  );
}

const overlap = (left: string, right: string) => isWithin(left, right) || isWithin(right, left);

async function legacyResolvePath(
  workspace: ResolvedWorkspace,
  relativePath: string,
  access: 'read' | 'write',
  rootKinds?: readonly string[],
): Promise<{ path: string; root: ResolvedRoot }> {
  legacyAssertRelative(relativePath);
  const firstSegment = path.posix
    .normalize(relativePath.replaceAll('\\', '/'))
    .split('/')
    .find((segment) => segment !== '.' && segment.length > 0)
    ?.toLowerCase();
  if (firstSegment === '.hoi4-agent')
    throw new ServiceError('PATH_GENERATED_STORAGE_RESERVED', 'reserved');
  const roots = workspace.roots.filter(
    (root) =>
      (rootKinds === undefined || rootKinds.includes(root.kind)) &&
      (access === 'read' || root.writable),
  );
  for (const root of roots.sort((a, b) => b.loadOrder - a.loadOrder)) {
    const candidate = await canonicalPath(path.join(root.path, relativePath));
    if (!isWithin(root.path, candidate)) continue;
    if (access === 'read' && !(await exists(candidate))) continue;
    if (
      root.kind === 'mod' &&
      (overlap(workspace.artifactRoot, candidate) || overlap(workspace.cacheRoot, candidate))
    )
      throw new ServiceError('PATH_GENERATED_STORAGE_RESERVED', 'reserved');
    if (access === 'write') {
      const existingParent = await canonicalPath(path.dirname(candidate));
      if (!isWithin(root.path, existingParent)) continue;
    }
    return { path: candidate, root };
  }
  throw new ServiceError(
    access === 'write' ? 'PATH_WRITE_OUTSIDE_ROOTS' : 'PATH_NOT_FOUND_IN_ROOTS',
    'unresolved',
  );
}

type Outcome = string;

async function outcome(run: () => Promise<{ path: string; root: ResolvedRoot }>): Promise<Outcome> {
  try {
    const { path: resolved, root } = await run();
    return `ok ${root.kind}:${root.loadOrder} ${resolved}`;
  } catch (error) {
    if (error instanceof ServiceError) return `refused ${error.code}`;
    return `error ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/** Every file below `root`, as workspace-relative POSIX paths, without following links. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const directory = await opendir(path.join(root, relative)).catch(() => undefined);
    if (directory === undefined) continue;
    for await (const entry of directory) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else found.push(child);
    }
  }
  return found.sort();
}

const UNSAFE = [
  '',
  '../outside.txt',
  '..\\outside.txt',
  'common/../../outside.txt',
  '/etc/passwd',
  'C:/Windows/win.ini',
  'C:\\Windows\\win.ini',
  '\\\\server\\share\\x',
  'file.txt:stream',
  'CON',
  'con.txt',
  'CONIN$',
  'COM¹.txt',
  'LPT9',
  'com10.txt',
  'bad|name.txt',
  'bad?name.txt',
  'folder/name. ',
  'folder/name.',
  'a\u0001b.txt',
  'nul\0byte.txt',
  '.hoi4-agent/cache/x.txt',
  './.hoi4-agent/x.txt',
  '.\\.hoi4-agent/x.txt',
  '.HOI4-AGENT/artifacts/x.txt',
  'descriptor.mod',
  './descriptor.mod',
  'DESCRIPTOR.MOD',
  'common//ideas',
  'common/./ideas',
  'common\\ideas',
  '.',
  './',
];

const allCorpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic');
const corpora = allCorpora.filter(
  ({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id),
);
// The game is every mod's base root, also when `--corpus` leaves the vanilla corpus out.
const game = (await locateCorpus(allCorpora.find(({ kind }) => kind === 'game')!)).root;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-paths-parity-'));
const report: Record<string, unknown> = {};
let differs = false;
try {
  for (const corpus of corpora) {
    const found = await locateCorpus(corpus);
    if (found.root === undefined) {
      process.stderr.write(`${corpus.id}: ${found.unavailable ?? 'not found'}\n`);
      report[corpus.id] = { unavailable: found.unavailable };
      continue;
    }
    let root = found.root;
    const gameRoot = corpus.kind === 'game' ? found.root : game;
    if (corpus.kind === 'game') {
      root = path.join(temporary, 'vanilla-mod');
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'descriptor.mod'), 'name="Parity vanilla"\n');
    }
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state', corpus.id),
        workspaces: [
          {
            id: 'parity',
            name: corpus.name,
            root,
            ...(gameRoot === undefined ? {} : { gameRoot }),
          },
        ],
      }),
    );
    const workspace = resolver.get('parity');
    const paths = new Set<string>(UNSAFE);
    const sampled: Record<string, { files: number; sampled: number }> = {};
    for (const sourceRoot of workspace.roots) {
      const files = await listFiles(sourceRoot.path);
      const step = Math.max(1, Math.ceil(files.length / maxFiles));
      const picked = files.filter((_, index) => index % step === 0);
      sampled[`${sourceRoot.kind}:${sourceRoot.loadOrder}`] = {
        files: files.length,
        sampled: picked.length,
      };
      for (const file of picked) {
        paths.add(file);
        paths.add(`${path.posix.dirname(file)}/parity_missing_${path.posix.basename(file)}`);
      }
    }
    let compared = 0;
    const differences: string[] = [];
    const started = performance.now();
    let index = 0;
    for (const relativePath of paths) {
      const variants: Array<['read' | 'write', string[] | undefined]> = [['read', undefined]];
      if (index++ % 10 === 0)
        variants.push(
          ['write', undefined],
          ['read', ['mod']],
          ['read', ['game']],
          ['write', ['mod']],
        );
      for (const [access, kinds] of variants) {
        const [before, after] = [
          await outcome(() => legacyResolvePath(workspace, relativePath, access, kinds)),
          await outcome(() =>
            resolver.resolvePath(
              'parity',
              relativePath,
              access,
              kinds as Parameters<WorkspaceResolver['resolvePath']>[3],
            ),
          ),
        ];
        compared += 1;
        if (before !== after) {
          differs = true;
          if (differences.length < 40)
            differences.push(
              `${JSON.stringify(relativePath)} ${access} ${kinds?.join(',') ?? '*'}: ${before} != ${after}`,
            );
        }
      }
    }
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    report[corpus.id] = { roots: sampled, paths: paths.size, compared, seconds, differences };
    process.stderr.write(
      `${corpus.id}: ${compared} resolutions of ${paths.size} paths in ${seconds} s, ${differences.length} differences\n`,
    );
    for (const line of differences) process.stderr.write(`  ${line}\n`);
  }
} finally {
  sharedResidentEngine().close();
  await rm(temporary, { recursive: true, force: true });
}
const text = `${JSON.stringify({ engine: located.source, report }, null, 2)}\n`;
if (values.out !== undefined) await writeFile(values.out, text);
process.stdout.write(text);
process.exit(differs ? 1 : 0);

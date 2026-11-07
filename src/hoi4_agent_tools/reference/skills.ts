import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sha256Bytes } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import {
  SKILL_FILE_PATTERN,
  SKILL_NAME_PATTERN,
  SKILL_TEXT_BYTES,
  type SkillData,
  type SkillRequest,
} from '../schemas/skill.js';

// Skills are served from the mod, as HOI4 Mod Setup installed them. Its lock records the kit
// revision and the hash of every installed file, so a file whose bytes differ is reported as
// edited and not served unless the caller accepts local edits. A mod without a lock gets its
// installed skills marked unpinned.

export const SETUP_LOCK_PATH = '.hoi4-mod-setup/install.lock.json';
const LOCK_BYTES = 8 * 1024 * 1024;
const SKILL_FILE_BYTES = 4 * 1024 * 1024;
/** Setup installs one copy per client; the agent-neutral copy wins. */
const SKILL_ROOTS = ['.agents/skills', '.claude/skills'] as const;
const FILES_PER_SKILL = 64;

type SkillState = 'pinned' | 'edited' | 'missing' | 'unpinned';
interface SkillFile {
  file: string;
  path: string;
  pinnedSha256: string | null;
}
interface Inventory {
  kit: SkillData['kit'];
  skills: Map<string, SkillFile[]>;
}

export async function listSkills(
  workspace: ResolvedWorkspace,
  signal?: AbortSignal,
): Promise<SkillData> {
  const inventory = await readInventory(workspace.modRoot, signal);
  const skills: NonNullable<SkillData['skills']> = [];
  let drifted = 0;
  for (const [name, files] of [...inventory.skills].sort(([a], [b]) => a.localeCompare(b))) {
    signal?.throwIfAborted();
    const states = await Promise.all(
      files.map(async (entry) => (await readSkillFile(workspace.modRoot, entry)).state),
    );
    const state = worst(states);
    if (state === 'edited' || state === 'missing') drifted += 1;
    const main = files.find(({ file }) => file === 'SKILL.md');
    const description =
      main === undefined ? '' : await frontmatterDescription(workspace.modRoot, main);
    skills.push({ name, description, files: files.length, state });
  }
  return { kit: inventory.kit, skills: skills.slice(0, 128), drifted };
}

export async function loadSkill(
  workspace: ResolvedWorkspace,
  request: SkillRequest & { name: string },
  signal?: AbortSignal,
): Promise<SkillData> {
  const inventory = await readInventory(workspace.modRoot, signal);
  const files = inventory.skills.get(request.name);
  if (files === undefined)
    throw new ServiceError(
      'SKILL_NOT_FOUND',
      `The mod has no skill named ${request.name}; call hoi4.skill without a name to list them`,
      { name: request.name },
    );
  const entry = files.find(({ file }) => file === request.file);
  if (entry === undefined)
    throw new ServiceError(
      'SKILL_FILE_NOT_FOUND',
      `The skill ${request.name} has no file ${request.file}`,
      { name: request.name, files: files.map(({ file }) => file).slice(0, 32) },
    );
  const read = await readSkillFile(workspace.modRoot, entry);
  if (read.bytes === undefined)
    throw new ServiceError(
      'SKILL_FILE_MISSING',
      `The Setup lock names ${entry.path}, but the file is not in the mod; rerun HOI4 Mod Setup to restore it`,
      { path: entry.path },
    );
  if (read.state === 'edited' && !request.acceptLocalEdits)
    throw new ServiceError(
      'SKILL_TEXT_DRIFTED',
      `${entry.path} differs from the kit revision ${inventory.kit?.revision ?? ''} the mod pins (sha256 ${read.sha256} instead of ${entry.pinnedSha256 ?? ''}); rerun HOI4 Mod Setup to restore it, or pass acceptLocalEdits to read the edited text`,
      { path: entry.path, sha256: read.sha256, pinnedSha256: entry.pinnedSha256 },
    );
  if (request.offset > read.bytes.length)
    throw new ServiceError(
      'SKILL_OFFSET_INVALID',
      `offset ${request.offset} is past the end of ${entry.path} (${read.bytes.length} bytes)`,
    );
  const end = pageEnd(read.bytes, request.offset);
  return {
    kit: inventory.kit,
    skill: {
      name: request.name,
      file: entry.file,
      path: entry.path,
      state: read.state,
      sha256: read.sha256!,
      pinnedSha256: entry.pinnedSha256,
      bytes: read.bytes.length,
      offset: request.offset,
      nextOffset: end < read.bytes.length ? end : null,
      text: read.bytes.subarray(request.offset, end).toString('utf8'),
      otherFiles: files
        .map(({ file }) => file)
        .filter((file) => file !== entry.file)
        .slice(0, 64),
    },
    drifted: read.state === 'edited' ? 1 : 0,
  };
}

/** The whole text of one skill file for a resource read, with the same drift rule. */
export async function readSkillText(
  workspace: ResolvedWorkspace,
  name: string,
  file: string,
  signal?: AbortSignal,
): Promise<{ text: string; sha256: string; state: SkillState; kit: SkillData['kit'] }> {
  const inventory = await readInventory(workspace.modRoot, signal);
  const entry = inventory.skills.get(name)?.find((candidate) => candidate.file === file);
  if (entry === undefined)
    throw new ServiceError('SKILL_NOT_FOUND', `The mod has no skill file ${name}/${file}`);
  const read = await readSkillFile(workspace.modRoot, entry);
  if (read.bytes === undefined)
    throw new ServiceError('SKILL_FILE_MISSING', `${entry.path} is not in the mod`);
  if (read.state === 'edited')
    throw new ServiceError(
      'SKILL_TEXT_DRIFTED',
      `${entry.path} differs from the kit revision the mod pins; read it with hoi4.skill and acceptLocalEdits`,
    );
  return {
    text: read.bytes.toString('utf8'),
    sha256: read.sha256!,
    state: read.state,
    kit: inventory.kit,
  };
}

/** Skill names the mod has, for resource listing. */
export async function skillNames(workspace: ResolvedWorkspace, signal?: AbortSignal) {
  return [...(await readInventory(workspace.modRoot, signal)).skills.keys()].sort();
}

async function readInventory(modRoot: string, signal?: AbortSignal): Promise<Inventory> {
  const lock = await readLock(modRoot);
  signal?.throwIfAborted();
  return lock === undefined ? installedInventory(modRoot, signal) : lockedInventory(lock);
}

interface LockFile {
  source: {
    repository: string;
    revision: string;
    release?: unknown;
    manifest_sha256: string;
  };
  /** Entries are untrusted mod content, checked one by one. */
  files: unknown[];
}
interface UntrustedLock {
  source?: {
    repository?: unknown;
    revision?: unknown;
    release?: unknown;
    manifest_sha256?: unknown;
  };
  files?: unknown;
}

async function readLock(modRoot: string): Promise<LockFile | undefined> {
  const lockPath = path.join(modRoot, SETUP_LOCK_PATH);
  let bytes: Buffer;
  try {
    const info = await lstat(lockPath);
    if (!info.isFile()) return undefined;
    if (info.size > LOCK_BYTES)
      throw new ServiceError('SKILL_LOCK_INVALID', `${SETUP_LOCK_PATH} is larger than 8 MB`);
    bytes = await readFile(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ServiceError('SKILL_LOCK_INVALID', `${SETUP_LOCK_PATH} is not valid JSON`);
  }
  const lock = parsed as UntrustedLock | null;
  const source = lock?.source;
  if (
    lock === null ||
    typeof source?.repository !== 'string' ||
    typeof source.revision !== 'string' ||
    typeof source.manifest_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(source.manifest_sha256) ||
    !Array.isArray(lock.files)
  )
    throw new ServiceError(
      'SKILL_LOCK_INVALID',
      `${SETUP_LOCK_PATH} lacks the source revision, manifest hash or file list`,
    );
  return lock as unknown as LockFile;
}

function lockedInventory(lock: LockFile): Inventory {
  const byRoot = new Map<string, Map<string, SkillFile[]>>();
  for (const raw of lock.files) {
    const entry = raw as { path?: unknown; installed_sha256?: unknown } | null;
    if (
      typeof entry?.path !== 'string' ||
      typeof entry.installed_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.installed_sha256)
    )
      continue;
    const located = locate(entry.path);
    if (located === undefined) continue;
    const skills = byRoot.get(located.root) ?? new Map<string, SkillFile[]>();
    byRoot.set(located.root, skills);
    const files = skills.get(located.name) ?? [];
    skills.set(located.name, files);
    if (files.length < FILES_PER_SKILL)
      files.push({ file: located.file, path: entry.path, pinnedSha256: entry.installed_sha256 });
  }
  return {
    kit: {
      repository: lock.source.repository.slice(0, 200),
      revision: lock.source.revision.slice(0, 64),
      release: typeof lock.source.release === 'string' ? lock.source.release.slice(0, 64) : null,
      manifestSha256: lock.source.manifest_sha256,
    },
    skills: merged(byRoot),
  };
}

async function installedInventory(modRoot: string, signal?: AbortSignal): Promise<Inventory> {
  const byRoot = new Map<string, Map<string, SkillFile[]>>();
  for (const root of SKILL_ROOTS) {
    let names: string[];
    try {
      names = await readdir(path.join(modRoot, root));
    } catch {
      continue;
    }
    const skills = new Map<string, SkillFile[]>();
    byRoot.set(root, skills);
    for (const name of names.filter((candidate) => SKILL_NAME_PATTERN.test(candidate))) {
      signal?.throwIfAborted();
      const files = (await filesBelow(path.join(modRoot, root, name)))
        .filter((file) => SKILL_FILE_PATTERN.test(file))
        .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)))
        .slice(0, FILES_PER_SKILL);
      if (!files.includes('SKILL.md')) continue;
      skills.set(
        name,
        files.map((file) => ({ file, path: `${root}/${name}/${file}`, pinnedSha256: null })),
      );
    }
  }
  return { kit: null, skills: merged(byRoot) };
}

async function filesBelow(directory: string, prefix = '', depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isFile()) found.push(relative);
    else if (entry.isDirectory())
      found.push(
        ...(await filesBelow(path.join(directory, entry.name), `${relative}/`, depth + 1)),
      );
  }
  return found;
}

/** Every skill once, taken from the first root in SKILL_ROOTS that has it. */
function merged(byRoot: Map<string, Map<string, SkillFile[]>>): Map<string, SkillFile[]> {
  const skills = new Map<string, SkillFile[]>();
  for (const root of SKILL_ROOTS)
    for (const [name, files] of byRoot.get(root) ?? [])
      if (!skills.has(name) && files.some(({ file }) => file === 'SKILL.md'))
        skills.set(name, files);
  return skills;
}

function locate(lockPath: string): { root: string; name: string; file: string } | undefined {
  for (const root of SKILL_ROOTS) {
    if (!lockPath.startsWith(`${root}/`)) continue;
    const rest = lockPath.slice(root.length + 1);
    const slash = rest.indexOf('/');
    if (slash < 0) return undefined;
    const name = rest.slice(0, slash);
    const file = rest.slice(slash + 1);
    if (SKILL_NAME_PATTERN.test(name) && SKILL_FILE_PATTERN.test(file)) return { root, name, file };
  }
  return undefined;
}

async function readSkillFile(
  modRoot: string,
  entry: SkillFile,
): Promise<{ state: SkillState; bytes?: Buffer; sha256?: string }> {
  const absolute = path.join(modRoot, ...entry.path.split('/'));
  let bytes: Buffer;
  try {
    // A link could point outside the mod, so the real path must stay inside it.
    const [real, root] = await Promise.all([realpath(absolute), realpath(modRoot)]);
    const relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new ServiceError('SKILL_PATH_OUTSIDE_MOD', `${entry.path} resolves outside the mod`);
    const info = await lstat(real);
    if (!info.isFile() || info.size > SKILL_FILE_BYTES) return { state: 'missing' };
    bytes = await readFile(real);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    return { state: 'missing' };
  }
  const sha256 = sha256Bytes(bytes);
  const state =
    entry.pinnedSha256 === null ? 'unpinned' : sha256 === entry.pinnedSha256 ? 'pinned' : 'edited';
  return { state, bytes, sha256 };
}

async function frontmatterDescription(modRoot: string, entry: SkillFile): Promise<string> {
  const read = await readSkillFile(modRoot, entry);
  if (read.bytes === undefined) return '';
  const head = read.bytes.subarray(0, 4096).toString('utf8');
  const match = /^---\r?\n[\s\S]*?^description:\s*(.+?)\s*$/mu.exec(head);
  const text = (match?.[1] ?? '').replace(/^["']|["']$/gu, '');
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function worst(states: readonly SkillState[]): SkillState {
  for (const state of ['missing', 'edited', 'unpinned'] as const)
    if (states.includes(state)) return state;
  return 'pinned';
}

/** The end of one page: at most SKILL_TEXT_BYTES, cut after a line break when one fits. */
function pageEnd(bytes: Buffer, offset: number): number {
  const limit = offset + SKILL_TEXT_BYTES;
  if (limit >= bytes.length) return bytes.length;
  const newline = bytes.lastIndexOf(0x0a, limit - 1);
  if (newline >= offset) return newline + 1;
  // No line break in the page: back off to the start of a UTF-8 character.
  let end = limit;
  while (end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

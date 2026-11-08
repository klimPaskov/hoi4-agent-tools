import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { SOURCE_MAX_BYTES } from '../core/source/limits.js';
import { isWithin, type ResolvedWorkspace } from '../core/workspace.js';
import { localisationEngineResponseSchema } from '../schemas/localisation.js';
import {
  LOCALISATION_LANGUAGES,
  type LocalisationFix,
  type LocalisationWriteRequest,
} from '../schemas/localisation-write.js';
import {
  appendEntries,
  classifyLine,
  decodeLocBytes,
  detectStyle,
  documentChanged,
  encodeLocDocument,
  endsWithLoneBackslash,
  escapeLocText,
  formatEntryLine,
  newLocDocument,
  NEW_FILE_STYLE,
  repairValue,
  scanDocument,
  type LocDocument,
  type ScannedDocument,
} from './write-format.js';

// ---------------------------------------------------------------------------------------------
// Result of planning

export type ChangeKind =
  | 'add_key'
  | 'replace_key'
  | 'override_key'
  | 'create_file'
  | 'add_bom'
  | 'reencode_utf16'
  | 'fix_quote'
  | 'copy_missing_key';

export interface PlannedChange {
  kind: ChangeKind;
  key?: string;
  line?: number;
}

export interface PlannedFile {
  /** Mod-relative path with forward slashes. */
  path: string;
  action: 'create' | 'update';
  document: LocDocument;
  before: Buffer | null;
  after: Buffer;
  changes: PlannedChange[];
}

export interface PlanSkipped {
  key: string;
  reason: string;
}

export interface PlanUnfixable {
  kind: string;
  path?: string;
  key?: string;
  reason: string;
}

export interface LocalisationPlan {
  files: PlannedFile[];
  skipped: PlanSkipped[];
  unfixable: PlanUnfixable[];
  notes: string[];
  /** Mod files whose content the plan depends on, for the stale-source check at apply time. */
  consulted: Array<{ path: string; sha256: string }>;
  counts: {
    keysAdded: number;
    keysReplaced: number;
    keysOverridden: number;
    bomsAdded: number;
    quotesFixed: number;
    keysCopied: number;
  };
}

export type UndefinedKeyReport =
  | { available: true; keys: Array<{ key: string; path?: string }>; total: number }
  | { available: false; reason: string };

export interface PlanOptions {
  workspace: ResolvedWorkspace;
  signal?: AbortSignal;
  /** Keys the script uses that no language defines. The default asks the engine. */
  undefinedKeys?: () => Promise<UndefinedKeyReport>;
}

// ---------------------------------------------------------------------------------------------
// Paths

const MAX_FILES = 20_000;
const MAX_DEPTH = 16;
const LAYER_FILE_LIMIT = 16 * 1024 * 1024;

function invalidPath(field: string, value: string, message: string): ServiceError {
  return new ServiceError('LOCALISATION_PATH_INVALID', `${field}: ${message}`, {
    field,
    path: value.slice(0, 200),
  });
}

/**
 * A mod-relative path under `localisation/`, normalised to forward slashes. Absolute paths,
 * drive letters, parent segments, NUL bytes and anything outside `localisation/` are refused.
 */
export function normalizeLocalisationPath(value: string, field: string): string {
  if (value.includes('\0')) throw invalidPath(field, value, 'contains a NUL byte');
  if (/^[A-Za-z]:/u.test(value) || value.startsWith('/') || value.startsWith('\\'))
    throw invalidPath(field, value, 'must be relative to the mod, not an absolute path');
  const parts = value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw invalidPath(field, value, 'parent segments (..) are not allowed');
  if (parts[0] !== 'localisation')
    throw invalidPath(field, value, "must be inside the mod's localisation/ folder");
  for (const part of parts)
    if (!/^[A-Za-z0-9_. -]+$/u.test(part) || /[. ]$/u.test(part))
      throw invalidPath(field, value, `"${part.slice(0, 80)}" is not a usable file or folder name`);
  return parts.join('/');
}

function languageFileSuffix(language: string): string {
  return `_l_${language}.yml`;
}

function languageOfFile(relativePath: string): string | null {
  const match = /_l_([a-z_]+)\.yml$/iu.exec(relativePath);
  const language = match?.[1]?.toLowerCase();
  return language !== undefined && (LOCALISATION_LANGUAGES as readonly string[]).includes(language)
    ? language
    : null;
}

function inReplaceFolder(relativePath: string): boolean {
  return relativePath.split('/').slice(1, -1).includes('replace');
}

// ---------------------------------------------------------------------------------------------
// Reading the mod's localisation

interface ModFile {
  path: string;
  bytes: Buffer | undefined;
  sha256: string | undefined;
  tooLarge: boolean;
  document: LocDocument | undefined;
  scan: ScannedDocument | undefined;
  language: string | null;
  replace: boolean;
}

async function walkYml(
  directory: string,
  relative: string,
  depth: number,
  out: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  entries.sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of entries) {
    // A link could lead out of the folder; the localisation tree is plain files and folders.
    if (entry.isSymbolicLink()) continue;
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory())
      await walkYml(path.join(directory, entry.name), next, depth + 1, out, signal);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.yml')) {
      out.push(next);
      if (out.length > MAX_FILES)
        throw new ServiceError(
          'LOCALISATION_TOO_MANY_FILES',
          `The localisation folder holds more than ${MAX_FILES} files`,
        );
    }
  }
}

async function localisationFolder(rootPath: string): Promise<string | undefined> {
  const folder = path.join(rootPath, 'localisation');
  let status;
  try {
    status = await lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) return undefined;
  const real = await realpath(folder);
  return isWithin(rootPath, real) ? folder : undefined;
}

async function readModFiles(
  workspace: ResolvedWorkspace,
  signal: AbortSignal | undefined,
): Promise<Map<string, ModFile>> {
  const files = new Map<string, ModFile>();
  const folder = await localisationFolder(workspace.modRoot);
  if (folder === undefined) return files;
  const paths: string[] = [];
  await walkYml(folder, 'localisation', 0, paths, signal);
  for (const relative of paths) {
    signal?.throwIfAborted();
    const absolute = path.join(workspace.modRoot, ...relative.split('/'));
    const status = await lstat(absolute);
    const language = languageOfFile(relative);
    const base = { path: relative, language, replace: inReplaceFolder(relative) };
    if (status.size > SOURCE_MAX_BYTES) {
      files.set(relative, {
        ...base,
        bytes: undefined,
        sha256: undefined,
        tooLarge: true,
        document: undefined,
        scan: undefined,
      });
      continue;
    }
    const bytes = await readFile(absolute);
    const document = decodeLocBytes(bytes);
    files.set(relative, {
      ...base,
      bytes,
      sha256: sha256Bytes(bytes),
      tooLarge: false,
      document,
      scan: document === undefined ? undefined : scanDocument(document),
    });
  }
  return files;
}

/** Which of `wanted` the game, its DLC or a dependency define in `language`. */
async function keysFromOtherLayers(
  workspace: ResolvedWorkspace,
  language: string,
  wanted: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  const suffix = languageFileSuffix(language);
  for (const root of workspace.roots) {
    if (root.kind !== 'game' && root.kind !== 'dlc' && root.kind !== 'dependency') continue;
    const folder = await localisationFolder(root.path);
    if (folder === undefined) continue;
    const paths: string[] = [];
    await walkYml(folder, 'localisation', 0, paths, signal);
    for (const relative of paths) {
      if (!relative.toLowerCase().endsWith(suffix)) continue;
      signal?.throwIfAborted();
      const absolute = path.join(root.path, ...relative.split('/'));
      const status = await lstat(absolute);
      if (status.size > LAYER_FILE_LIMIT) continue;
      const text = (await readFile(absolute)).toString('utf8');
      for (const match of text.matchAll(/^[ \t]*([A-Za-z0-9_.-]+):/gmu)) {
        const key = match[1]!;
        if (wanted.has(key)) found.add(key);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Working copies

interface WorkFile {
  path: string;
  document: LocDocument;
  before: Buffer | null;
  changes: PlannedChange[];
}

class WorkSet {
  private readonly files = new Map<string, WorkFile>();
  constructor(private readonly mod: ReadonlyMap<string, ModFile>) {}

  existing(relative: string): WorkFile | undefined {
    const known = this.files.get(relative);
    if (known !== undefined) return known;
    const file = this.mod.get(relative);
    if (file?.document === undefined || file.bytes === undefined) return undefined;
    const work: WorkFile = {
      path: relative,
      document: file.document,
      before: file.bytes,
      changes: [],
    };
    this.files.set(relative, work);
    return work;
  }

  create(relative: string): WorkFile {
    const work: WorkFile = {
      path: relative,
      document: newLocDocument(),
      before: null,
      changes: [{ kind: 'create_file' }],
    };
    this.files.set(relative, work);
    return work;
  }

  planned(): PlannedFile[] {
    return [...this.files.values()]
      .filter(({ document }) => documentChanged(document))
      .sort((a, b) => compareCodeUnits(a.path, b.path))
      .map((work) => ({
        path: work.path,
        action: work.before === null ? ('create' as const) : ('update' as const),
        document: work.document,
        before: work.before,
        after: encodeLocDocument(work.document),
        changes: work.changes,
      }));
  }
}

function emptyPlan(mod: ReadonlyMap<string, ModFile>): LocalisationPlan {
  return {
    files: [],
    skipped: [],
    unfixable: [],
    notes: [],
    consulted: [...mod.values()]
      .filter((file) => file.sha256 !== undefined)
      .map((file) => ({ path: file.path, sha256: file.sha256! })),
    counts: {
      keysAdded: 0,
      keysReplaced: 0,
      keysOverridden: 0,
      bomsAdded: 0,
      quotesFixed: 0,
      keysCopied: 0,
    },
  };
}

function modFolderName(workspace: ResolvedWorkspace): string {
  const name = path.basename(workspace.modRoot).replace(/[^A-Za-z0-9_.-]+/gu, '_');
  return name.replace(/^[._-]+/u, '') || 'mod';
}

function defaultTargetPath(
  workspace: ResolvedWorkspace,
  language: string,
  replace: boolean,
): string {
  const name = modFolderName(workspace);
  return replace
    ? `localisation/${language}/replace/${name}_replace${languageFileSuffix(language)}`
    : `localisation/${language}/${name}${languageFileSuffix(language)}`;
}

/** The file to append to: the mod's file with the most keys for the language, else a new one. */
function pickTarget(
  workspace: ResolvedWorkspace,
  mod: ReadonlyMap<string, ModFile>,
  language: string,
  replace: boolean,
): { path: string; create: boolean } {
  let best: { path: string; count: number } | undefined;
  for (const file of [...mod.values()].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    if (file.language !== language || file.replace !== replace) continue;
    if (!file.scan?.headers.some((header) => header.language === language)) continue;
    const count = file.scan.entries.filter((entry) => entry.language === language).length;
    if (best === undefined || count > best.count) best = { path: file.path, count };
  }
  if (best !== undefined) return { path: best.path, create: false };
  const fallback = defaultTargetPath(workspace, language, replace);
  if (mod.has(fallback))
    throw new ServiceError(
      'LOCALISATION_TARGET_UNSUITABLE',
      `${fallback} exists but cannot take new keys (not valid UTF-8 or no l_${language}: header); run mode "fix" first or pass file`,
      { path: fallback },
    );
  return { path: fallback, create: true };
}

// ---------------------------------------------------------------------------------------------
// Mode add

interface Definition {
  path: string;
  lineIndex: number;
  value: string;
  prefix: string;
  tail: string;
}

export async function planAdd(
  options: PlanOptions,
  input: Pick<LocalisationWriteRequest, 'entries' | 'language' | 'file' | 'replace'>,
): Promise<LocalisationPlan> {
  const { workspace, signal } = options;
  const language = input.language;
  const entries = input.entries ?? [];
  let explicit: string | undefined;
  if (input.file !== undefined) {
    explicit = normalizeLocalisationPath(input.file, 'file');
    if (!explicit.endsWith(languageFileSuffix(language)) || explicit.split('/').length < 2)
      throw invalidPath(
        'file',
        input.file,
        `must be a localisation/ path ending in ${languageFileSuffix(language)}`,
      );
  }
  const mod = await readModFiles(workspace, signal);
  const plan = emptyPlan(mod);
  const work = new WorkSet(mod);

  const definitions = new Map<string, Definition[]>();
  for (const file of mod.values()) {
    if (file.language !== language || file.scan === undefined) continue;
    for (const scanned of file.scan.entries) {
      if (scanned.language !== language) continue;
      const list = definitions.get(scanned.entry.key) ?? [];
      list.push({
        path: file.path,
        lineIndex: scanned.lineIndex,
        value: scanned.entry.value,
        prefix: scanned.entry.prefix,
        tail: scanned.entry.tail,
      });
      definitions.set(scanned.entry.key, list);
    }
  }

  const undefinedInMod = new Set(
    entries.filter(({ key }) => !definitions.has(key)).map(({ key }) => key),
  );
  const elsewhere = await keysFromOtherLayers(workspace, language, undefinedInMod, signal);

  const fresh: Array<{ key: string; raw: string; override: boolean }> = [];
  for (const entry of entries) {
    const raw = escapeLocText(entry.text);
    if (endsWithLoneBackslash(raw)) {
      plan.skipped.push({
        key: entry.key,
        reason: 'the text ends with a backslash that would escape the closing quote',
      });
      continue;
    }
    const existing = definitions.get(entry.key);
    if (existing === undefined) {
      fresh.push({ key: entry.key, raw, override: elsewhere.has(entry.key) });
      continue;
    }
    const differing = existing.filter(({ value }) => value !== raw);
    if (differing.length === 0) {
      plan.skipped.push({
        key: entry.key,
        reason: 'unchanged: the mod already defines it with this text',
      });
      continue;
    }
    if (!input.replace) {
      const first = differing[0]!;
      plan.skipped.push({
        key: entry.key,
        reason: `defined in ${first.path}:${first.lineIndex + 1} with different text; set replace to true to rewrite it`,
      });
      continue;
    }
    for (const definition of differing) {
      const target = work.existing(definition.path);
      if (target === undefined) continue;
      const line = target.document.lines[definition.lineIndex]!;
      line.content = `${definition.prefix}"${raw}"${definition.tail}`;
      target.changes.push({ kind: 'replace_key', key: entry.key, line: definition.lineIndex + 1 });
      plan.counts.keysReplaced += 1;
    }
  }

  // Group the new keys by target file, keeping the request's order.
  const groups = new Map<string, { create: boolean; items: typeof fresh }>();
  const targetOf = (override: boolean): { path: string; create: boolean } => {
    if (explicit !== undefined) {
      const file = mod.get(explicit);
      if (file === undefined) return { path: explicit, create: true };
      const scan = file.scan;
      if (scan === undefined)
        throw new ServiceError(
          'LOCALISATION_FILE_ENCODING',
          `${explicit} is not valid UTF-8 or UTF-16; run mode "fix" or recreate it before adding keys`,
          { path: explicit },
        );
      if (scan.headers.length > 0 && !scan.headers.some((header) => header.language === language))
        throw new ServiceError(
          'LOCALISATION_FILE_HEADER',
          `${explicit} has no l_${language}: header`,
          { path: explicit },
        );
      return { path: explicit, create: false };
    }
    return pickTarget(workspace, mod, language, override);
  };
  for (const item of fresh) {
    const target = targetOf(item.override);
    const group = groups.get(target.path) ?? { create: target.create, items: [] };
    group.items.push(item);
    groups.set(target.path, group);
  }
  const overridePaths = new Set<string>();
  for (const [targetPath, group] of [...groups].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const file = group.create ? work.create(targetPath) : work.existing(targetPath)!;
    const style = group.create ? NEW_FILE_STYLE : detectStyle(file.document);
    const lines = appendEntries(
      file.document,
      language,
      group.items.map(({ key, raw }) => formatEntryLine(style, key, raw)),
    );
    for (const [index, item] of group.items.entries()) {
      file.changes.push({
        kind: item.override ? 'override_key' : 'add_key',
        key: item.key,
        line: lines[index]!,
      });
      if (item.override) {
        plan.counts.keysOverridden += 1;
        overridePaths.add(targetPath);
      } else plan.counts.keysAdded += 1;
    }
    if (!group.create && file.document.target === 'utf8')
      plan.notes.push(
        `${targetPath} has no byte order mark, so the game ignores it; run mode "fix".`,
      );
  }
  if (plan.counts.keysOverridden > 0) {
    const names = fresh.filter(({ override }) => override).map(({ key }) => key);
    const inReplace = [...overridePaths].every((target) => inReplaceFolder(target));
    plan.notes.push(
      `${names.length} key(s) are defined by the game or a dependency (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}): the new entries override them${inReplace ? ' from a replace folder, which the game loads with priority' : `, but ${[...overridePaths].join(', ')} is not in a replace folder, so the game may keep its own text and list the key twice in text.log`}.`,
    );
  }
  plan.files = work.planned();
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Mode fix

export async function planFix(
  options: PlanOptions,
  input: Pick<LocalisationWriteRequest, 'fixes' | 'paths'>,
): Promise<LocalisationPlan> {
  const { workspace, signal } = options;
  const fixes = new Set<LocalisationFix>(input.fixes);
  const mod = await readModFiles(workspace, signal);
  const plan = emptyPlan(mod);
  const work = new WorkSet(mod);

  // `paths` limit which files change. A path is a file or a folder under localisation/.
  const filters = (input.paths ?? []).map((value) => ({
    value,
    path: normalizeLocalisationPath(value, 'paths'),
  }));
  const allowed = (relative: string): boolean =>
    filters.length === 0 ||
    filters.some(({ path: filter }) => relative === filter || relative.startsWith(`${filter}/`));
  for (const filter of filters)
    if (
      ![...mod.keys()].some(
        (candidate) => candidate === filter.path || candidate.startsWith(`${filter.path}/`),
      )
    )
      plan.unfixable.push({
        kind: 'path',
        path: filter.path,
        reason: 'no localisation file matches this path',
      });

  for (const file of [...mod.values()].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    if (!allowed(file.path) || (!fixes.has('bom') && !fixes.has('quotes'))) continue;
    if (file.document === undefined) {
      plan.unfixable.push({
        kind: 'encoding',
        path: file.path,
        reason: file.tooLarge
          ? 'the file is larger than the supported size'
          : 'the file is not valid UTF-8 or UTF-16, so its encoding is unclear',
      });
      continue;
    }
    const target = work.existing(file.path)!;
    const document = target.document;
    if (fixes.has('bom') && document.lines.length > 0 && document.encoding !== 'utf8-bom') {
      document.target = 'utf8-bom';
      target.changes.push({ kind: document.encoding === 'utf8' ? 'add_bom' : 'reencode_utf16' });
      plan.counts.bomsAdded += 1;
    }
    if (fixes.has('quotes') && file.language !== null) {
      for (const [index, line] of document.lines.entries()) {
        const kind = classifyLine(line.content);
        if (kind.kind !== 'broken') continue;
        const repair = repairValue(kind, document.lines[index + 1]?.content);
        if (repair.fixed) {
          line.content = repair.content;
          target.changes.push({ kind: 'fix_quote', key: kind.key, line: index + 1 });
          plan.counts.quotesFixed += 1;
        } else
          plan.unfixable.push({
            kind: 'quote',
            path: file.path,
            key: kind.key,
            reason: `line ${index + 1}: ${repair.reason}`,
          });
      }
    }
  }

  if (fixes.has('missing_languages')) await planMissingLanguages(options, mod, work, plan, allowed);
  plan.files = work.planned();
  return plan;
}

async function planMissingLanguages(
  options: PlanOptions,
  mod: ReadonlyMap<string, ModFile>,
  work: WorkSet,
  plan: LocalisationPlan,
  allowed: (relative: string) => boolean,
): Promise<void> {
  const { workspace, signal } = options;
  // The mod's English keys in file order; the first definition of a key wins.
  const english = new Map<string, { value: string; replace: boolean }>();
  const defined = new Map<string, Set<string>>();
  for (const file of [...mod.values()].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    if (file.language === null || file.scan === undefined) continue;
    for (const scanned of file.scan.entries) {
      if (scanned.language !== file.language) continue;
      const keys = defined.get(file.language) ?? new Set<string>();
      keys.add(scanned.entry.key);
      defined.set(file.language, keys);
      if (file.language === 'english' && !english.has(scanned.entry.key))
        english.set(scanned.entry.key, { value: scanned.entry.value, replace: file.replace });
    }
  }
  if (english.size > 0) {
    for (const language of LOCALISATION_LANGUAGES) {
      if (language === 'english') continue;
      const have = defined.get(language) ?? new Set<string>();
      // A language the mod supports holds at least a quarter of its English keys
      // (the rule hoi4.localisation_inspect uses).
      if (have.size * 4 < english.size) continue;
      const missing = [...english].filter(([key]) => !have.has(key));
      if (missing.length === 0) continue;
      // The game's own translation of a key the mod overrides in English must not be hidden.
      const elsewhere = await keysFromOtherLayers(
        workspace,
        language,
        new Set(missing.map(([key]) => key)),
        signal,
      );
      for (const replace of [false, true]) {
        const items = missing.filter(
          ([key, info]) => info.replace === replace && !elsewhere.has(key),
        );
        if (items.length === 0) continue;
        const target = pickTarget(workspace, mod, language, replace);
        if (!allowed(target.path)) continue;
        const file = target.create ? work.create(target.path) : work.existing(target.path)!;
        const style = target.create ? NEW_FILE_STYLE : detectStyle(file.document);
        const lines = appendEntries(
          file.document,
          language,
          items.map(([key, info]) => formatEntryLine(style, key, info.value)),
        );
        for (const [index, [key]] of items.entries())
          file.changes.push({ kind: 'copy_missing_key', key, line: lines[index]! });
        plan.counts.keysCopied += items.length;
      }
    }
  }

  const report = await (options.undefinedKeys ?? (() => engineUndefinedKeys(workspace, signal)))();
  if (report.available) {
    for (const item of report.keys)
      plan.unfixable.push({
        kind: 'undefined_key',
        ...(item.path === undefined ? {} : { path: item.path }),
        key: item.key,
        reason:
          'script uses this key and no language defines it; the fixer never invents text, so use mode "add" with the text',
      });
    if (report.total > report.keys.length)
      plan.notes.push(
        `${report.total} keys are used by script and defined nowhere; the first ${report.keys.length} are listed.`,
      );
  } else
    plan.notes.push(
      `Keys that script uses and no language defines were not checked: the engine is unavailable (${report.reason}).`,
    );
}

async function engineUndefinedKeys(
  workspace: ResolvedWorkspace,
  signal: AbortSignal | undefined,
): Promise<UndefinedKeyReport> {
  try {
    const result = await runEngineCommand(
      'localisation',
      {
        ...(workspace.gameRoot === undefined ? {} : { game: workspace.gameRoot }),
        mod: workspace.modRoot,
        dependencies: workspace.dependencyRoots,
        includeDlc: workspace.dlcLayers.length > 0,
        mode: 'audit',
        limit: 50,
      },
      localisationEngineResponseSchema,
      { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) },
    );
    if (!result.available) return { available: false, reason: result.reason };
    if (result.outcome === 'invalid_request')
      return { available: false, reason: result.error.code };
    const audit = result.response.audit;
    const keys = (audit?.problems ?? [])
      .filter(({ code, key }) => code === 'LOC_KEY_UNDEFINED' && key !== null)
      .map(({ key, path: problemPath }) => ({
        key: key!,
        ...(problemPath !== '' &&
        !path.isAbsolute(problemPath) &&
        !/^[A-Za-z]:/u.test(problemPath) &&
        problemPath.length <= 1024
          ? { path: problemPath.replaceAll('\\', '/') }
          : {}),
      }));
    return {
      available: true,
      keys,
      total: Math.max(keys.length, audit?.counts.LOC_KEY_UNDEFINED ?? 0),
    };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { available: false, reason: 'engine_error' };
  }
}

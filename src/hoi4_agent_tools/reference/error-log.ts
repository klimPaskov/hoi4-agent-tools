import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod/v4';
import { ServiceError } from '../core/result.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import type { errorLogDataSchema, errorLogRequestSchema } from '../schemas/mod-tools.js';

/**
 * Reads the game's own `logs/error.log` and turns it into located, grouped findings. The log
 * is found from the user-data folder (configured, the parent of the mod folder, or the
 * platform default); no client-supplied path is ever read.
 */

type Input = z.infer<typeof errorLogRequestSchema>;
type Output = z.infer<typeof errorLogDataSchema>;
type Entry = Output['entries'][number];
type Category = Entry['category'];

/** The newest part of a very large log is read; the game writes it anew on every launch. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_CHARACTERS = 600;
const SOURCE_EXTENSIONS = 'txt|gui|gfx|yml|csv|asset|lua|mod|shader|fxh|json|map|bmp|dds|tga|png';
const headerPattern = /^\[(\d{2}:\d{2}:\d{2})\]\[([^\]:]+?)(?:\.cpp)?(?::\d+)?\]:\s?(.*)$/u;
const quotedFilePattern = new RegExp(
  `(?:in |)file:?\\s*"([^"]+\\.(?:${SOURCE_EXTENSIONS}))"`,
  'giu',
);
const barePathPattern = new RegExp(
  `((?:[A-Za-z]:)?[\\w .\\-/\\\\]*?(?:common|events|history|interface|gfx|localisation|localisation_synced|map|music|sound|portraits|tutorial)[/\\\\][^\\s"',;:]+?\\.(?:${SOURCE_EXTENSIONS}))\\b`,
  'gu',
);
const linePattern = /(?:near\s+)?line:?\s*(\d{1,7})/giu;

/** Rules in order; the first that matches classifies an entry. */
const categoryRules: ReadonlyArray<readonly [Category, RegExp]> = [
  [
    'syntax',
    /unexpected (?:token|end)|missing (?:closing |opening )?(?:brace|bracket)|parse error|malformed|unbalanced/iu,
  ],
  [
    'duplicate',
    /duplicate|already (?:exists|defined|registered)|defined (?:twice|multiple times)/iu,
  ],
  ['localisation', /locali[sz]/iu],
  ['effect', /\beffect\b/iu],
  ['trigger', /\btrigger\b|\bcondition\b/iu],
  ['scope', /\bscope\b/iu],
  ['graphics', /texture|sprite|\.dds|\.tga|\.png|gfx|\bfont\b|\bmesh\b|\bentity\b|animation/iu],
  ['interface', /\bgui\b|window|\bwidget\b|scripted ?gui/iu],
  ['map', /province|strategic ?region|\bstate\b|adjacenc|supply|railway|\bmap\b/iu],
  [
    'missing_reference',
    /not found|unknown|doesn'?t exist|does not exist|invalid|missing|could not find|failed to (?:find|load)/iu,
  ],
];
const moduleCategories: ReadonlyArray<readonly [RegExp, Category]> = [
  [/locali[sz]/iu, 'localisation'],
  [/^(?:effect|effectbase|effects)/iu, 'effect'],
  [/^(?:trigger|triggerbase|triggers)/iu, 'trigger'],
  [/gfx|texture|sprite|font|graphic/iu, 'graphics'],
  [/gui|window|widget/iu, 'interface'],
  [/province|map|state|region|supply|railway|adjacenc/iu, 'map'],
  [/persistent|parse|pdx_?data|script/iu, 'syntax'],
];

/** What to do about each kind of entry; names the tool that narrows it down. */
const categoryHints: Readonly<Record<Category, string>> = {
  syntax:
    'Check braces, quotes and assignments near the named line; hoi4.script_validate with the file path pinpoints it.',
  duplicate:
    'Two active definitions share a name: rename one, or remove the copy that overrides the other.',
  localisation:
    'Add the key to a UTF-8 with BOM .yml under localisation/<language>/ (key: "Text", no :0), or correct the key name.',
  effect:
    'Check that the effect exists and takes these arguments in this scope: hoi4.script_validate on the file, hoi4.reference_search for its documentation.',
  trigger:
    'Check that the trigger exists and takes these arguments in this scope: hoi4.script_validate on the file, hoi4.reference_search for its documentation.',
  scope:
    'A command runs in the wrong scope: check the enclosing scope changes with hoi4.script_validate.',
  graphics:
    'Register the sprite in a .gfx file, and check the texture path, file name case and DDS format.',
  interface:
    'Check the .gui element and sprite names; hoi4.gui_inspect shows the window and its missing assets.',
  map: 'Check the named province, state or region with hoi4.map_inspect; map errors can stop the game loading without debug mode.',
  missing_reference:
    'The named object is not defined in any active layer: hoi4.source_lookup confirms, then define it or fix the name.',
  other: 'Read the message and the named file; hoi4.source_lookup locates the definition.',
};

/** Reduce a message to its shape: names, numbers, quoted values and paths become placeholders. */
export function errorLogPattern(message: string): string {
  return (
    message
      .toLowerCase()
      .replace(/"[^"]*"/gu, '<v>')
      .replace(new RegExp(`[\\w./\\\\:-]+\\.(?:${SOURCE_EXTENSIONS})\\b`, 'gu'), '<file>')
      .replace(/\b[a-z_][\w]*\.\d+\b/gu, '<id>')
      // snake_case script names (keys, effects, sprites) differ between otherwise equal messages.
      .replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gu, '<name>')
      .replace(/-?\b\d+(?:\.\d+)?\b/gu, '<n>')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 300)
  );
}

interface LaunchRecord {
  modifiedAt: string;
  entries: Record<string, { category: Category; message: string; relativePath?: string }>;
}

interface LaunchHistory {
  previous?: LaunchRecord;
  current?: LaunchRecord;
}

const HISTORY_FILE = 'error-log-history.json';
const MAX_HISTORY_ENTRIES = 5_000;

function entryKey(module: string, message: string): string {
  return createHash('sha256').update(`${module}\0${message}`).digest('hex').slice(0, 24);
}

async function readHistory(file: string): Promise<LaunchHistory> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remember the entries of each log this server reads, keyed by the log's write time, so the
 * next launch's log can say which errors are new and which a fix removed. The history lives
 * in the server's own cache folder, never in the mod.
 */
async function compareWithPreviousLaunch(
  workspace: ResolvedWorkspace,
  modifiedAt: string,
  entries: ReadonlyArray<{
    module: string;
    message: string;
    category: Category;
    relativePath?: string;
  }>,
): Promise<{ previous?: LaunchRecord; current: LaunchRecord }> {
  const file = path.join(workspace.cacheRoot, HISTORY_FILE);
  const history = await readHistory(file);
  const current: LaunchRecord = { modifiedAt, entries: {} };
  for (const entry of entries.slice(0, MAX_HISTORY_ENTRIES))
    current.entries[entryKey(entry.module, entry.message)] = {
      category: entry.category,
      message: entry.message.slice(0, 300),
      ...(entry.relativePath === undefined ? {} : { relativePath: entry.relativePath }),
    };
  if (history.current?.modifiedAt === modifiedAt)
    return { ...(history.previous === undefined ? {} : { previous: history.previous }), current };
  const next: LaunchHistory = {
    ...(history.current === undefined ? {} : { previous: history.current }),
    current,
  };
  try {
    await mkdir(workspace.cacheRoot, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, file);
  } catch {
    // The comparison is a convenience; an unwritable cache leaves the read itself intact.
  }
  return { ...(next.previous === undefined ? {} : { previous: next.previous }), current };
}

function classify(module: string, message: string): Category {
  for (const [category, pattern] of categoryRules)
    if (category !== 'missing_reference' && pattern.test(message)) return category;
  for (const [pattern, category] of moduleCategories) if (pattern.test(module)) return category;
  return categoryRules.at(-1)![1].test(message) ? 'missing_reference' : 'other';
}

/** The user-data folder that holds `logs/`, in order of preference. */
function userDataCandidates(workspace: ResolvedWorkspace, configured?: string): string[] {
  const candidates: string[] = [];
  if (configured !== undefined) candidates.push(path.resolve(configured));
  const modParent = path.dirname(workspace.modRoot);
  if (path.basename(modParent).toLowerCase() === 'mod') candidates.push(path.dirname(modParent));
  const home = os.homedir();
  const userFolder = path.join('Paradox Interactive', 'Hearts of Iron IV');
  if (process.platform === 'win32') {
    if (process.env.OneDrive !== undefined)
      candidates.push(path.join(process.env.OneDrive, 'Documents', userFolder));
    candidates.push(path.join(home, 'Documents', userFolder));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Documents', userFolder));
  } else {
    candidates.push(path.join(home, '.local', 'share', userFolder));
  }
  return [...new Set(candidates)];
}

async function readTail(file: string, size: number): Promise<{ text: string; truncated: boolean }> {
  const start = Math.max(0, size - MAX_LOG_BYTES);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    // Drop the partial first line of a truncated read.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

interface Located {
  relativePath: string;
  line?: number;
}

/** The last source file a message names, relative to its source root, and its line. */
function locate(message: string, roots: readonly string[]): Located | undefined {
  const files = [
    ...[...message.matchAll(quotedFilePattern)].map((match) => match[1]!),
    ...[...message.matchAll(barePathPattern)].map((match) => match[1]!.trim()),
  ];
  const raw = files.at(-1);
  if (raw === undefined) return undefined;
  let normalized = raw.replaceAll('\\', '/').replace(/^\.\//u, '');
  for (const root of roots) {
    const prefix = `${root.replaceAll('\\', '/').replace(/\/$/u, '')}/`;
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  // Paths under any mod folder are made relative to that mod.
  const modMatch = /\/mod\/[^/]+\/(.+)$/u.exec(normalized);
  if (modMatch !== null && path.isAbsolute(raw)) normalized = modMatch[1]!;
  const lines = [...message.matchAll(linePattern)].map((match) => Number(match[1]));
  return { relativePath: normalized, ...(lines.length === 0 ? {} : { line: lines.at(-1)! }) };
}

async function layerOf(
  workspace: ResolvedWorkspace,
  relativePath: string,
  logModified: number,
): Promise<{ layer: NonNullable<Entry['source']>['layer']; changedSinceLog: boolean }> {
  const layers: Array<[NonNullable<Entry['source']>['layer'], string]> = [
    ['mod', workspace.modRoot],
    ...workspace.dependencyRoots.map((root): [NonNullable<Entry['source']>['layer'], string] => [
      'dependency',
      root,
    ]),
    ...(workspace.gameRoot === undefined
      ? []
      : [['game', workspace.gameRoot] as [NonNullable<Entry['source']>['layer'], string]]),
  ];
  for (const [layer, root] of layers) {
    const candidate = path.resolve(root, relativePath);
    if (!candidate.startsWith(path.resolve(root) + path.sep)) continue;
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile() === true) return { layer, changedSinceLog: info.mtimeMs > logModified };
  }
  return { layer: 'unknown', changedSinceLog: false };
}

export async function readErrorLog(
  workspace: ResolvedWorkspace,
  input: Input,
  configuredUserRoot?: string,
  signal?: AbortSignal,
): Promise<Output> {
  let found: { file: string; size: number; modified: number } | undefined;
  for (const root of userDataCandidates(workspace, configuredUserRoot)) {
    const file = path.join(root, 'logs', 'error.log');
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile() === true) {
      found = { file, size: info.size, modified: info.mtimeMs };
      break;
    }
  }
  if (found === undefined)
    throw new ServiceError(
      'ERROR_LOG_NOT_FOUND',
      'No logs/error.log was found in the game user-data folder; launch the game once, or set gameUserRoot in the server configuration',
    );
  signal?.throwIfAborted();
  const { text, truncated } = await readTail(found.file, found.size);
  const roots = [workspace.modRoot, ...workspace.dependencyRoots, workspace.gameRoot ?? ''].filter(
    Boolean,
  );
  // Join continuation lines to the entry they belong to.
  const raw: Array<{ time?: string; module: string; message: string; logLine: number }> = [];
  text.split(/\r?\n/u).forEach((line, index) => {
    const header = headerPattern.exec(line);
    if (header !== null)
      raw.push({ time: header[1]!, module: header[2]!, message: header[3]!, logLine: index + 1 });
    else if (line.trim() !== '' && raw.length > 0) raw.at(-1)!.message += ` ${line.trim()}`;
    else if (line.trim() !== '') raw.push({ module: '', message: line.trim(), logLine: index + 1 });
  });
  const grouped = new Map<string, Entry & { order: number }>();
  for (const [order, item] of raw.entries()) {
    signal?.throwIfAborted();
    const message = item.message.slice(0, MAX_MESSAGE_CHARACTERS);
    const key = `${item.module}\0${message}`;
    const existing = grouped.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const located = locate(message, roots);
    const source =
      located === undefined
        ? undefined
        : {
            relativePath: located.relativePath.slice(0, 1024),
            ...(located.line === undefined ? {} : { line: located.line }),
            ...(await layerOf(workspace, located.relativePath, found.modified)),
          };
    grouped.set(key, {
      category: classify(item.module, message),
      module: item.module.slice(0, 128),
      message,
      count: 1,
      firstLogLine: item.logLine,
      ...(item.time === undefined ? {} : { time: item.time }),
      ...(source === undefined ? {} : { source }),
      order,
    });
  }
  const layerRank = { mod: 0, dependency: 1, unknown: 2, game: 3 } as const;
  const all = [...grouped.values()].sort(
    (left, right) =>
      layerRank[left.source?.layer ?? 'unknown'] - layerRank[right.source?.layer ?? 'unknown'] ||
      left.order - right.order,
  );
  const selected = all.filter(
    (entry) =>
      (input.scope === 'all' ||
        (input.scope === 'mod' && entry.source?.layer === 'mod') ||
        (input.scope === 'unlocated' && entry.source === undefined)) &&
      (input.category === undefined || entry.category === input.category) &&
      (input.query === undefined ||
        entry.message.toLowerCase().includes(input.query.toLowerCase()) ||
        entry.source?.relativePath.toLowerCase().includes(input.query.toLowerCase()) === true),
  );
  const launches = await compareWithPreviousLaunch(
    workspace,
    new Date(found.modified).toISOString(),
    all.map((entry) => ({
      module: entry.module,
      message: entry.message,
      category: entry.category,
      ...(entry.source === undefined ? {} : { relativePath: entry.source.relativePath }),
    })),
  );
  const previousKeys =
    launches.previous === undefined ? undefined : new Set(Object.keys(launches.previous.entries));
  const currentKeys = new Set(Object.keys(launches.current.entries));
  const patterns = new Map<
    string,
    { category: Category; distinct: number; entries: number; example: string }
  >();
  for (const entry of selected) {
    const pattern = errorLogPattern(entry.message);
    const totals = patterns.get(pattern) ?? {
      category: entry.category,
      distinct: 0,
      entries: 0,
      example: entry.message,
    };
    totals.distinct += 1;
    totals.entries += entry.count;
    patterns.set(pattern, totals);
  }
  const categories = new Map<Category, { entries: number; distinct: number }>();
  for (const entry of selected) {
    const totals = categories.get(entry.category) ?? { entries: 0, distinct: 0 };
    totals.entries += entry.count;
    totals.distinct += 1;
    categories.set(entry.category, totals);
  }
  const page = selected.slice(input.offset, input.offset + input.limit);
  return {
    log: {
      path: 'user:logs/error.log',
      modifiedAt: new Date(found.modified).toISOString(),
      bytes: found.size,
      truncated,
      entries: raw.length,
    },
    scope: input.scope,
    totalEntries: selected.reduce((sum, entry) => sum + entry.count, 0),
    distinctEntries: selected.length,
    modEntries: all.filter((entry) => entry.source?.layer === 'mod').length,
    changedSinceLog: all.filter((entry) => entry.source?.changedSinceLog === true).length,
    categories: [...categories]
      .map(([category, totals]) => ({ category, ...totals, hint: categoryHints[category] }))
      .sort((left, right) => right.entries - left.entries),
    patterns: [...patterns]
      .filter(([, totals]) => totals.distinct > 1)
      .sort(([, left], [, right]) => right.distinct - left.distinct || right.entries - left.entries)
      .slice(0, 8)
      .map(([pattern, totals]) => ({ pattern, ...totals })),
    ...(launches.previous === undefined || previousKeys === undefined
      ? {}
      : {
          sinceLastLaunch: {
            previousLogAt: launches.previous.modifiedAt,
            newEntries: [...currentKeys].filter((key) => !previousKeys.has(key)).length,
            persistingEntries: [...currentKeys].filter((key) => previousKeys.has(key)).length,
            resolvedEntries: [...previousKeys].filter((key) => !currentKeys.has(key)).length,
            resolvedExamples: Object.entries(launches.previous.entries)
              .filter(([key]) => !currentKeys.has(key))
              .slice(0, 5)
              .map(([, entry]) => entry),
          },
        }),
    entries: page.map(({ order: _order, ...entry }) => ({
      ...entry,
      ...(previousKeys === undefined
        ? {}
        : { new: !previousKeys.has(entryKey(entry.module, entry.message)) }),
    })),
    offset: input.offset,
    ...(input.offset + page.length < selected.length
      ? { nextOffset: input.offset + page.length }
      : {}),
  };
}

import { open, stat } from 'node:fs/promises';
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
      .map(([category, totals]) => ({ category, ...totals }))
      .sort((left, right) => right.entries - left.entries),
    entries: page.map(({ order: _order, ...entry }) => entry),
    offset: input.offset,
    ...(input.offset + page.length < selected.length
      ? { nextOffset: input.offset + page.length }
      : {}),
  };
}

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod/v4';
import { globFiles } from '../core/file-glob.js';
import { checkedLayerName, type EngineCheckReport } from '../core/engine-check.js';
import { ServiceError } from '../core/result.js';
import type { scriptGuardDataSchema, scriptGuardRequestSchema } from '../schemas/modder-tools.js';

/**
 * `hoi4.script_guard`: every effect, trigger and modifier in the files an agent wrote, checked
 * against the installed game's documentation and the scripted helpers and modifiers the loaded
 * files define. The engine's whole-mod check (`hoi4-engine check`) makes the judgement; this
 * picks the agent's files and reports what nothing documents or defines.
 */

type Input = z.infer<typeof scriptGuardRequestSchema>;
type Output = z.infer<typeof scriptGuardDataSchema>;

/** The engine codes for a name that nothing documents or defines, by the kind of name. */
const INVENTED: Readonly<Record<string, 'effect' | 'trigger' | 'modifier'>> = {
  REF_UNKNOWN_EFFECT: 'effect',
  REF_UNKNOWN_TRIGGER: 'trigger',
  LINT_UNKNOWN_MODIFIER: 'modifier',
};

/** Script and modifier files an agent writes; other files hold no effects or triggers. */
const SCRIPT_PATTERNS = ['events/**/*.txt', 'common/**/*.txt', 'history/**/*.txt'];
const MAX_FILES = 200;
const MAX_INVENTED = 40;

function normalized(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^mod:/u, '').replace(/^\.\//u, '');
}

/**
 * The files to guard: the named ones, or the mod's script files changed in the last
 * `sinceMinutes`. File times decide, not Git, so a mod's repository settings never run.
 */
export async function guardedFiles(
  modRoot: string,
  input: Pick<Input, 'paths' | 'sinceMinutes'>,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<{ files: string[]; candidates: number }> {
  if (input.paths !== undefined) {
    const files: string[] = [];
    for (const requested of input.paths) {
      const relative = normalized(requested);
      const absolute = path.resolve(modRoot, relative);
      if (path.isAbsolute(relative) || !absolute.startsWith(path.resolve(modRoot) + path.sep))
        throw new ServiceError(
          'SCRIPT_GUARD_PATH_OUTSIDE_MOD',
          `Pass paths inside the mod, such as events/my_events.txt, not ${requested}`,
        );
      const info = await stat(absolute).catch(() => undefined);
      if (info?.isFile() !== true)
        throw new ServiceError('SCRIPT_GUARD_FILE_NOT_FOUND', `The mod has no file ${relative}`);
      files.push(relative);
    }
    return { files: [...new Set(files)], candidates: files.length };
  }
  const since = now - input.sinceMinutes * 60_000;
  const all = await globFiles(SCRIPT_PATTERNS, {
    cwd: modRoot,
    caseSensitive: false,
    ...(signal === undefined ? {} : { signal }),
  });
  const changed: Array<{ file: string; modified: number }> = [];
  for (const file of all) {
    const info = await stat(path.join(modRoot, file)).catch(() => undefined);
    if (info !== undefined && info.mtimeMs >= since) changed.push({ file, modified: info.mtimeMs });
  }
  changed.sort((left, right) => right.modified - left.modified);
  return {
    files: changed.slice(0, MAX_FILES).map(({ file }) => normalized(file)),
    candidates: changed.length,
  };
}

/** A name in a guarded file that nothing documents or defines. */
export interface InventedName {
  name: string;
  kind: 'effect' | 'trigger' | 'modifier';
  path: string;
  line: number;
  context?: string;
  suggestion?: string;
  message: string;
}

/**
 * The invented names in the guarded files: the engine's findings, plus the names script
 * validation could not resolve, such as a trigger compared with `>`, which the engine's check
 * does not read as a command. A name both report counts once.
 */
export function inventedNames(
  report: EngineCheckReport,
  files: readonly string[],
  candidates: number,
  unresolved: readonly InventedName[] = [],
): Output {
  const layer = checkedLayerName(report);
  const wanted = new Set(files.map((file) => file.toLowerCase()));
  const found: InventedName[] = report.findings
    .filter(
      (finding) =>
        INVENTED[finding.code] !== undefined &&
        finding.layer === layer &&
        wanted.has(normalized(finding.path).toLowerCase()),
    )
    .map((finding) => ({
      name: finding.subject ?? '',
      kind: INVENTED[finding.code]!,
      path: normalized(finding.path),
      line: Math.max(1, finding.line),
      ...(finding.context === undefined ? {} : { context: finding.context }),
      ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
      message: finding.message,
    }));
  const seen = new Set(found.map(({ path: file, line, name }) => `${file}\0${line}\0${name}`));
  for (const name of unresolved) {
    const key = `${normalized(name.path)}\0${name.line}\0${name.name}`;
    if (seen.has(key) || !wanted.has(normalized(name.path).toLowerCase())) continue;
    seen.add(key);
    found.push({ ...name, path: normalized(name.path) });
  }
  found.sort(
    (left, right) =>
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || left.line - right.line,
  );
  const counts = { effect: 0, trigger: 0, modifier: 0 };
  const perFile = new Map<string, number>();
  for (const name of found) {
    counts[name.kind] += 1;
    perFile.set(name.path, (perFile.get(name.path) ?? 0) + 1);
  }
  return {
    verdict: found.length === 0 ? 'clean' : 'invented',
    filesChecked: files.length,
    filesOmitted: Math.max(0, candidates - files.length),
    counts,
    files: files.map((file) => ({ path: file, invented: perFile.get(file) ?? 0 })).slice(0, 50),
    invented: found.slice(0, MAX_INVENTED).map((name) => ({
      name: name.name.slice(0, 256),
      kind: name.kind,
      path: name.path.slice(0, 1024),
      line: name.line,
      ...(name.context === undefined ? {} : { context: name.context.slice(0, 256) }),
      ...(name.suggestion === undefined ? {} : { suggestion: name.suggestion.slice(0, 256) }),
      message: name.message.slice(0, 300),
    })),
    inventedOmitted: Math.max(0, found.length - MAX_INVENTED),
  };
}

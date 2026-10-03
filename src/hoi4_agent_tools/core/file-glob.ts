import path from 'node:path';
import { escape, globIterate, hasMagic, Ignore, unescape } from 'glob';
import { lstat, readdir } from 'node:fs/promises';
import { ServiceError } from './result.js';

export interface FileGlobOptions {
  cwd: string;
  ignore?: readonly string[];
  caseSensitive?: boolean;
  signal?: AbortSignal;
}

function validatePatterns(patterns: readonly string[]): void {
  if (patterns.length > 8192)
    throw new ServiceError('SCAN_PATTERN_LIMIT', 'Too many source glob patterns');
  let wildcardCount = 0;
  for (const pattern of patterns) {
    if (Buffer.byteLength(pattern, 'utf8') > 4096)
      throw new ServiceError('SCAN_PATTERN_LIMIT', 'Source glob pattern exceeds its byte limit');
    if (
      pattern.startsWith('/') ||
      /^[A-Za-z]:/u.test(pattern) ||
      pattern.split('/').includes('..') ||
      pattern.includes('\0')
    )
      throw new ServiceError(
        'SCAN_PATTERN_ESCAPE',
        'Source glob patterns must stay relative to the authorized root',
      );
    let depth = 0;
    const groups: Array<{ start: number; choices: number }> = [];
    let expansions = 1;
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index];
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === '{') {
        if (++depth > 8)
          throw new ServiceError(
            'SCAN_PATTERN_LIMIT',
            'Source glob brace nesting exceeds its limit',
          );
        groups.push({ start: index + 1, choices: 1 });
      }
      if (character === ',' && groups.length > 0) groups.at(-1)!.choices++;
      if (character === '}') {
        depth = Math.max(0, depth - 1);
        const group = groups.pop();
        if (group === undefined) continue;
        const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/u.exec(
          pattern.slice(group.start, index),
        );
        if (range !== null) {
          const first = /^-?\d+$/u.test(range[1]!) ? Number(range[1]) : range[1]!.charCodeAt(0);
          const last = /^-?\d+$/u.test(range[2]!) ? Number(range[2]) : range[2]!.charCodeAt(0);
          const step = Math.abs(Number(range[3] ?? 1));
          group.choices = Math.floor(Math.abs(last - first) / step) + 1;
        }
        expansions *= group.choices;
        if (!Number.isSafeInteger(expansions) || expansions > 128)
          throw new ServiceError('SCAN_PATTERN_LIMIT', 'Source glob expansion exceeds its limit');
      }
    }
    // Validate brace complexity before invoking the glob parser, which can expand braces.
    if (hasMagic(pattern, { magicalBraces: true }) && ++wildcardCount > 512)
      throw new ServiceError('SCAN_PATTERN_LIMIT', 'Too many wildcard source glob patterns');
  }
}

/** Relative, cancellable enumeration without traversing symbolic-link directories. */
export async function* iterateFiles(
  patterns: readonly string[],
  options: FileGlobOptions,
): AsyncGenerator<string> {
  validatePatterns(patterns);
  validatePatterns(options.ignore ?? []);
  options.signal?.throwIfAborted();
  const nocase = options.caseSensitive === false;
  const excluded = new Ignore([...(options.ignore ?? [])], { nocase });
  const seen = new Set<string>();
  const allowedPatterns: string[] = [];
  for (const pattern of new Set(patterns)) {
    let current = options.cwd;
    let allowed = true;
    let literal = true;
    let finalIsFile = false;
    for (const part of pattern.split('/')) {
      if (hasMagic(part, { magicalBraces: true })) {
        literal = false;
        break;
      }
      let name = unescape(part);
      let candidate = path.resolve(current, name);
      const relative = path.relative(options.cwd, candidate).replaceAll('\\', '/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        throw new ServiceError(
          'SCAN_PATTERN_ESCAPE',
          'Literal glob prefix escaped its authorized root',
        );
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
        )
          throw error;
        if (!nocase) {
          allowed = false;
          break;
        }
        try {
          name =
            (await readdir(current)).find((entry) => entry.toLowerCase() === name.toLowerCase()) ??
            name;
          candidate = path.resolve(current, name);
          metadata = await lstat(candidate);
        } catch {
          allowed = false;
          break;
        }
      }
      if (metadata.isSymbolicLink()) {
        allowed = false;
        break;
      }
      finalIsFile = metadata.isFile();
      current = candidate;
    }
    if (!allowed) continue;
    if (literal) {
      if (!finalIsFile) continue;
      const relative = path.relative(options.cwd, current).replaceAll('\\', '/');
      if (
        excluded.relative.some((rule) => rule.match(relative)) ||
        excluded.absolute.some((rule) => rule.match(current))
      )
        continue;
      options.signal?.throwIfAborted();
      if (!seen.has(relative)) {
        seen.add(relative);
        yield relative;
      }
    } else allowedPatterns.push(pattern);
  }
  if (allowedPatterns.length === 0) return;
  const matches = globIterate(allowedPatterns, {
    cwd: options.cwd,
    withFileTypes: true,
    nodir: true,
    dot: false,
    follow: false,
    nocase,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ignore: {
      ignored: (entry) => entry.isSymbolicLink() || excluded.ignored(entry),
      childrenIgnored: (entry) => entry.isSymbolicLink() || excluded.childrenIgnored(entry),
    },
  });
  for await (const entry of matches) {
    options.signal?.throwIfAborted();
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const relative = path.relative(options.cwd, entry.fullpath()).replaceAll('\\', '/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
      throw new ServiceError('SCAN_PATTERN_ESCAPE', 'Glob result escaped its authorized root');
    if (!seen.has(relative)) {
      seen.add(relative);
      yield relative;
    }
  }
}

export async function globFiles(
  patterns: readonly string[],
  options: FileGlobOptions,
): Promise<string[]> {
  const files: string[] = [];
  for await (const file of iterateFiles(patterns, options)) files.push(file);
  return files;
}

export function escapeFileGlob(relativePath: string): string {
  return escape(relativePath, { magicalBraces: true });
}

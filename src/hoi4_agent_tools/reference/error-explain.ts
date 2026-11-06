import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { ResolvedWorkspace } from '../core/workspace.js';
import { errorLogCategorySchema } from '../schemas/mod-tools.js';
import type { explainErrorDataSchema, explainErrorRequestSchema } from '../schemas/modder-tools.js';
import catalogueFile from './error-explanations.json' with { type: 'json' };
import { categoryHints, classifyLogMessage, locateLogSource, sourceLayerOf } from './error-log.js';
import { knownMistakeForLogMessage } from './known-mistakes.js';
import { nearestNames } from './suggestions.js';
import type { DocumentedNames } from './documented-commands.js';

/**
 * `hoi4.explain_error`: one `error.log` line to the rule it breaks, where in the source, and the
 * fix. The explanations are a reviewed catalogue (`error-explanations.json`), each written from a
 * message shape the game's own log produced or from the documentation, never guessed. A message
 * no entry matches still gets its category's hint, its source location and, when it names a
 * command, whether the game documents it and the closest documented names.
 */

type Input = z.infer<typeof explainErrorRequestSchema>;
type Output = z.infer<typeof explainErrorDataSchema>;
type Explanation = Output['explanations'][number];

const explanationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/u),
    category: errorLogCategorySchema,
    pattern: z.string().min(1).max(300),
    rule: z.string().min(1).max(400),
    fix: z.string().min(1).max(400),
    evidence: z.string().min(1).max(300),
  })
  .strict();

const catalogueSchema = z
  .object({
    version: z.literal(1),
    reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    explanations: z.array(explanationSchema).min(1),
  })
  .strict()
  .superRefine((catalogue, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of catalogue.explanations.entries()) {
      if (seen.has(entry.id))
        context.addIssue({
          code: 'custom',
          path: ['explanations', index, 'id'],
          message: 'duplicate id',
        });
      seen.add(entry.id);
      try {
        new RegExp(entry.pattern, 'u');
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['explanations', index, 'pattern'],
          message: 'invalid pattern',
        });
      }
    }
  });

export type ErrorExplanationEntry = z.infer<typeof explanationSchema>;

/** The reviewed catalogue, validated once; a malformed file fails when the server loads. */
export const errorExplanations: ReadonlyArray<ErrorExplanationEntry & { regex: RegExp }> =
  catalogueSchema
    .parse(catalogueFile)
    .explanations.map((entry) => ({ ...entry, regex: new RegExp(entry.pattern, 'u') }));

const headerPattern = /^\s*\[[^\]]*\](?:\[[^\]]*\])?:\s?/u;
const wrapperPattern =
  /^Error:\s*"(?<inner>[\s\S]+?)"\s*in file:\s*"(?<file>[^"]+)"\s*near line:\s*(?<line>\d+)\s*$/u;
/** One message inside a wrapper ends at its own `near line: N`. */
const innerMessagePattern = /[\s\S]*?near line:\s*\d+/gu;

export interface LogPart {
  message: string;
  file?: string;
  line?: number;
}

/**
 * The messages of one log line. The game wraps parser errors as `Error: "<messages>" in file:
 * "<file>" near line: <n>`, with one or more messages, each ending in its own `near line`.
 */
export function splitLogLine(raw: string): LogPart[] {
  const message = raw.replace(headerPattern, '').replace(/\s+/gu, ' ').trim();
  const wrapped = wrapperPattern.exec(message);
  if (wrapped?.groups === undefined) return message === '' ? [] : [{ message }];
  const file = wrapped.groups.file!;
  const inner = wrapped.groups.inner!.trim();
  const parts = [...inner.matchAll(innerMessagePattern)].map((match) => match[0].trim());
  const messages = parts.length === 0 ? [inner] : parts;
  return messages.map((part) => {
    const own = /near line:\s*(\d+)\s*$/u.exec(part);
    return { message: part, file, line: Number(own?.[1] ?? wrapped.groups!.line) };
  });
}

function fill(template: string, groups: Readonly<Record<string, string | undefined>>): string {
  return template.replace(/\{([a-z]+)\}/gu, (whole, name: string) => groups[name] ?? whole);
}

export interface ExplainContext {
  workspace: ResolvedWorkspace;
  documented?: DocumentedNames;
  /** Scripted effects and triggers the loaded files define. */
  helpers?: { effect: ReadonlySet<string>; trigger: ReadonlySet<string> };
  signal?: AbortSignal;
}

const MAX_EXCERPT_LINES = 5;
const MAX_EXCERPT_CHARACTERS = 200;

async function excerptOf(
  root: string,
  relativePath: string,
  line: number,
): Promise<Array<{ line: number; text: string }> | undefined> {
  const file = path.resolve(root, relativePath);
  if (!file.startsWith(path.resolve(root) + path.sep)) return undefined;
  const info = await stat(file).catch(() => undefined);
  if (info?.isFile() !== true || info.size > 8 * 1024 * 1024) return undefined;
  const lines = (await readFile(file, 'utf8')).replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, first + MAX_EXCERPT_LINES - 1);
  const excerpt: Array<{ line: number; text: string }> = [];
  for (let number = first; number <= last; number += 1)
    excerpt.push({ line: number, text: lines[number - 1]!.slice(0, MAX_EXCERPT_CHARACTERS) });
  return excerpt.length === 0 ? undefined : excerpt;
}

/** Whether the game documents a name, and the closest documented names of the kind expected. */
function commandFacts(
  name: string,
  expected: 'effect' | 'trigger' | undefined,
  context: ExplainContext,
): Pick<Explanation, 'documentedAs' | 'definedBy' | 'suggestions'> {
  const documented = context.documented;
  if (documented === undefined) return {};
  const documentedAs = (['effect', 'trigger', 'modifier'] as const).filter((kind) =>
    documented[kind].has(name),
  );
  const helpers = context.helpers;
  const definedBy =
    helpers === undefined
      ? []
      : (['effect', 'trigger'] as const)
          .filter((kind) => helpers[kind].has(name))
          .map((kind) => (kind === 'effect' ? 'scripted_effect' : 'scripted_trigger'));
  const pool =
    expected === undefined
      ? [...documented.effect, ...documented.trigger]
      : [...documented[expected], ...(helpers?.[expected] ?? [])];
  const close = nearestNames(name, pool, { limit: 3 });
  // A value read as a trigger usually has a `has_` trigger that tests it.
  const prefixed = `has_${name}`;
  const suggestions =
    expected === 'trigger' && documented.trigger.has(prefixed)
      ? [prefixed, ...close.filter((candidate) => candidate !== prefixed)].slice(0, 3)
      : close;
  return {
    ...(documentedAs.length === 0 ? {} : { documentedAs }),
    ...(definedBy.length === 0 ? {} : { definedBy }),
    ...(suggestions.length === 0 ? {} : { suggestions }),
  };
}

function expectedKind(id: string): 'effect' | 'trigger' | undefined {
  if (id === 'invalid_effect' || id === 'unknown_effect_type') return 'effect';
  if (id === 'invalid_trigger' || id === 'unknown_trigger_type') return 'trigger';
  return undefined;
}

const SCRIPT_FOLDERS = /^(?:events|common|history)\//u;
/** `an effect`, `a trigger`. */
function withArticle(word: string): string {
  return `${/^[aeiou]/u.test(word) ? 'an' : 'a'} ${word}`;
}

const COUNTRY_TAG = /^[A-Z][A-Z0-9]{2}$/u;

async function explainPart(part: LogPart, context: ExplainContext): Promise<Explanation> {
  const { workspace } = context;
  const matched = errorExplanations.find((entry) => entry.regex.test(part.message));
  const groups =
    (matched === undefined ? undefined : matched.regex.exec(part.message)?.groups) ?? {};
  const known = knownMistakeForLogMessage(part.message);
  const roots = [workspace.modRoot, ...workspace.dependencyRoots, workspace.gameRoot ?? ''].filter(
    Boolean,
  );
  const located =
    groups.file !== undefined
      ? locateLogSource(`file: "${groups.file}"`, roots)
      : part.file !== undefined
        ? locateLogSource(`file: "${part.file}"`, roots)
        : locateLogSource(part.message, roots);
  const line = Number(groups.line ?? part.line ?? located?.line ?? Number.NaN);
  const layer =
    located === undefined ? undefined : await sourceLayerOf(workspace, located.relativePath);
  const source =
    located === undefined || layer === undefined
      ? undefined
      : {
          relativePath: located.relativePath.slice(0, 1024),
          ...(Number.isFinite(line) && line > 0 ? { line } : {}),
          layer: layer.layer,
        };
  const excerpt =
    source?.line === undefined || layer?.root === undefined
      ? undefined
      : await excerptOf(layer.root, source.relativePath, source.line);
  const subject = groups.name ?? groups.key ?? groups.tag;
  // A country tag is not a misspelled command, so it gets no command suggestions.
  const facts =
    subject === undefined || !/^[A-Za-z_][\w.]*$/u.test(subject) || COUNTRY_TAG.test(subject)
      ? {}
      : commandFacts(subject, expectedKind(matched?.id ?? ''), context);
  const category = matched?.category ?? classifyLogMessage('', part.message);
  const next =
    source?.layer === 'mod' && SCRIPT_FOLDERS.test(source.relativePath)
      ? { tool: 'hoi4.script_validate', arguments: { path: source.relativePath } }
      : undefined;
  const note = noteFor(subject, expectedKind(matched?.id ?? ''), facts, source?.layer, {
    documented: context.documented !== undefined,
    helpers: context.helpers !== undefined,
  });
  return {
    message: part.message.slice(0, 600),
    category,
    ...(matched === undefined
      ? known === undefined
        ? {
            matched: 'category' as const,
            rule: 'No reviewed explanation matches this message; the advice for its category follows.',
            fix: categoryHints[category],
          }
        : { matched: 'known_mistake' as const, id: known.id, rule: known.mistake, fix: known.fix }
      : {
          matched: 'catalogue' as const,
          id: matched.id,
          rule: fill(matched.rule, groups),
          fix: fill(matched.fix, groups),
        }),
    ...(subject === undefined ? {} : { subject: subject.slice(0, 256) }),
    ...facts,
    ...(source === undefined
      ? {}
      : { source: { ...source, ...(excerpt === undefined ? {} : { excerpt }) } }),
    ...(note === undefined ? {} : { note }),
    ...(next === undefined ? {} : { next }),
  };
}

/** What the documentation and the loaded files say about the subject, in one sentence. */
function noteFor(
  subject: string | undefined,
  expected: 'effect' | 'trigger' | undefined,
  facts: Pick<Explanation, 'documentedAs' | 'definedBy'>,
  layer: string | undefined,
  known: { documented: boolean; helpers: boolean },
): string | undefined {
  if (layer === 'game')
    return 'The game files cause this line, not the mod: it appears without the mod too, unless the mod replaces that file.';
  if (subject === undefined || expected === undefined) return undefined;
  if (COUNTRY_TAG.test(subject))
    return `\`${subject}\` looks like a country tag: a tag scope works only where the block accepts a scope change, and only for a tag that common/country_tags/ defines.`;
  if (!known.documented) return undefined;
  const other = expected === 'effect' ? 'trigger' : 'effect';
  if (facts.definedBy !== undefined)
    return `\`${subject}\` is a scripted helper that a loaded file defines: check that the file defining it loads without errors and that it is used as ${withArticle(expected)}.`;
  if (facts.documentedAs?.includes(expected) === true)
    return `\`${subject}\` is a documented ${expected}, so the problem is where it is used: a scope it does not support, or a block that does not accept it.`;
  if (facts.documentedAs?.includes(other) === true)
    return `\`${subject}\` is a documented ${other}, not ${withArticle(expected)}: move it to ${withArticle(other)} block.`;
  if (facts.documentedAs?.includes('modifier') === true)
    return `\`${subject}\` is a modifier: it belongs in a modifier block, not among ${expected}s.`;
  return known.helpers
    ? `The game's documentation does not list \`${subject}\`, and no loaded file defines it as a scripted ${expected}.`
    : `The game's documentation does not list \`${subject}\`.`;
}

export async function explainErrors(input: Input, context: ExplainContext): Promise<Output> {
  const lines = input.lines ?? (input.line === undefined ? [] : [input.line]);
  const explanations: Explanation[] = [];
  for (const raw of lines) {
    context.signal?.throwIfAborted();
    for (const part of splitLogLine(raw)) {
      if (explanations.length >= 20) break;
      explanations.push(await explainPart(part, context));
    }
  }
  return {
    explanations,
    explained: explanations.filter(({ matched }) => matched !== 'category').length,
    catalogue: errorExplanations.length,
  };
}

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { globFiles } from '../core/file-glob.js';
import { compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import { isWithin, type ResolvedWorkspace } from '../core/workspace.js';
import type { z } from 'zod/v4';
import type {
  referenceContextRequestSchema,
  referenceReadRequestSchema,
  referenceSearchRequestSchema,
  referenceSourceSchema,
  referenceSearchDataSchema,
  referenceReadDataSchema,
  referenceContextDataSchema,
} from '../schemas/reference.js';
import {
  prepareSource,
  verifySource,
  readBoundedFile,
  type PreparedSource,
} from '../core/scanner.js';
import { decodeSource } from '../core/source/encoding.js';
import { readBoundedJsonLines } from './lines.js';
import { RankingIndex, sectionTerms, type SectionTerms } from './ranking.js';

type SourceKind = z.infer<typeof referenceSourceSchema>;
type SearchInput = z.infer<typeof referenceSearchRequestSchema>;
type ReadInput = z.infer<typeof referenceReadRequestSchema>;
type ContextInput = z.infer<typeof referenceContextRequestSchema>;
export type ReferenceSearchResult = z.infer<typeof referenceSearchDataSchema>;
export type ReferenceReadResult = z.infer<typeof referenceReadDataSchema>;
export type ReferenceContextResult = z.infer<typeof referenceContextDataSchema>;

const MAX_FILES = 512;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 32_000_000;
const MAX_SECTIONS = 20_000;
const MAX_REFERENCE_METADATA_BYTES = 24_000;
const PHRASE_CANDIDATES = 60;
const EXACT_HEADING_SCORE = 1000;
const sourceOrder: Record<SourceKind, number> = { game_doc: 0, wiki: 1, script_doc: 2 };

function referenceText(bytes: Buffer): string {
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    const payload = Buffer.from(bytes.subarray(2));
    if (payload.length % 2 !== 0)
      throw new ServiceError(
        'REFERENCE_ENCODING_INVALID',
        'UTF-16 reference text has an incomplete code unit',
      );
    if (bytes[0] === 0xfe) payload.swap16();
    return payload.toString('utf16le');
  }
  return decodeSource(bytes).text;
}

export interface ReferenceSection {
  id: string;
  revision: string;
  source: SourceKind;
  title: string;
  heading: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  authority: string;
}

interface IndexedSection extends ReferenceSection {
  lines: string[];
  terms: SectionTerms;
}

/** The citation fields of a section, without its indexed text or term statistics. */
export function publicReferenceSection(
  section: ReferenceSection & { lines?: unknown; terms?: unknown },
): ReferenceSection {
  const { lines: _lines, terms: _terms, ...citation } = section;
  return citation;
}

interface RankedSection {
  section: IndexedSection;
  score: number;
  excerpt: string;
  matchLine: number;
}

interface CachedFile {
  revision: string;
  bytes: number;
  sections: IndexedSection[];
}

interface SourceRoot {
  kind: SourceKind;
  root: string;
  patterns: string[];
  authority: string;
}

interface ReferenceInventory {
  sections: IndexedSection[];
  coverage: Record<
    SourceKind,
    { files: number; sections: number; unavailable: boolean; included: boolean }
  >;
  skipped: number;
}

/** Up to three non-empty lines from `first`, trimmed to the 300-character excerpt bound. */
function snippet(lines: readonly string[], first = 0): string {
  return lines
    .slice(first, first + 3)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

// A Markdown table row whose first cell names a command, trigger, modifier, or on action.
const identifierRow = /^\|\s*`?([A-Za-z_][A-Za-z0-9_@.:]*)`?\s*\|/u;
const tableSeparator = /^\|\s*:?-{3,}/u;

interface Fence {
  character: string;
  length: number;
  info: string;
}

/** A closing fence repeats the opening character at least as often and has no info string. */
function fenceMarker(line: string): Fence | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return undefined;
  const marker = match[1]!;
  return { character: marker[0]!, length: marker.length, info: match[2]!.trim() };
}

function sectionize(
  root: SourceRoot,
  filePath: string,
  content: string,
  revision: string,
): IndexedSection[] {
  const lines = content.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const relative = path.relative(root.root, filePath).replaceAll('\\', '/');
  const title = path
    .basename(filePath)
    .replace(/\.(md|log)$/iu, '')
    .replaceAll('_', ' ')
    .replace(/ - Hearts of Iron 4 Wiki$/u, '');
  const headings: Array<{ heading: string; start: number }> = [];
  const rows: Array<{ heading: string; start: number }> = [];
  let fence: Fence | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = fenceMarker(line);
    if (fence === undefined && marker !== undefined) {
      fence = marker;
      continue;
    }
    if (fence !== undefined) {
      if (
        marker?.character === fence.character &&
        marker.length >= fence.length &&
        marker.info === ''
      )
        fence = undefined;
      continue;
    }
    const row = identifierRow.exec(line);
    if (row !== null && !tableSeparator.test(lines[index + 1] ?? ''))
      rows.push({ heading: row[1]!, start: index });
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match)
      headings.push({ heading: match[2]!.replace(/<a\b[^>]*><\/a>/gu, '').trim(), start: index });
    else if (
      root.kind === 'script_doc' &&
      filePath.toLowerCase().endsWith('.log') &&
      /^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(line.trim()) &&
      !/^\s/u.test(line) &&
      /^\s+\S/u.test(lines[index + 1] ?? '')
    ) {
      headings.push({ heading: line.trim(), start: index });
    }
  }
  if (headings.length === 0 || headings[0]!.start > 0)
    headings.unshift({ heading: title, start: 0 });
  const section = (heading: string, start: number, end: number): IndexedSection => {
    const sectionLines = lines.slice(start, end);
    const id = sha256Bytes(
      Buffer.from(`${root.kind}\0${relative}\0${start + 1}\0${heading}`, 'utf8'),
    );
    return {
      id,
      revision,
      source: root.kind,
      title,
      heading: heading.slice(0, 512),
      path: filePath,
      startLine: start + 1,
      endLine: end,
      excerpt: snippet(sectionLines),
      authority: root.authority,
      lines: sectionLines,
      terms: sectionTerms(title, heading, sectionLines),
    };
  };
  // Heading sections come first, so a page's opening section still names the page. Table
  // rows follow as one-line sections that cite one exact command or modifier entry.
  return [
    ...headings.map((current, index) =>
      section(current.heading, current.start, headings[index + 1]?.start ?? lines.length),
    ),
    ...rows.map((row) => section(row.heading, row.start, row.start + 1)),
  ];
}

function sourceRoots(workspace: ResolvedWorkspace): SourceRoot[] {
  const gameRoot =
    workspace.gameRoot ?? (workspace.registration.kind === 'game' ? workspace.modRoot : undefined);
  return [
    ...(gameRoot === undefined
      ? []
      : [
          {
            kind: 'game_doc' as const,
            root: gameRoot,
            patterns: ['documentation/**/*.md', 'common/**/*documentation.md'],
            authority: 'Installed game documentation',
          },
        ]),
    {
      kind: 'wiki',
      root: workspace.wikiRoot ?? path.join(workspace.modRoot, 'paradox_wiki'),
      patterns: ['**/*.md'],
      authority: 'Offline Paradox Wiki snapshot',
    },
    {
      kind: 'script_doc',
      root: workspace.scriptDocsRoot ?? path.join(workspace.modRoot, 'script_docs'),
      patterns: ['**/*.md', '**/*.log'],
      authority: 'User-provided game script documentation',
    },
  ];
}

const surfaceNames: Record<ContextInput['surface'], string[]> = {
  general: ['Data structures', 'Triggers', 'Effects', 'Modifiers', 'Scopes'],
  event: [
    'Event modding',
    'Data structures',
    'Effects',
    'Triggers',
    'Scopes',
    'On actions',
    'Localisation',
  ],
  decision: ['Decision modding', 'Effects', 'Triggers', 'Scopes', 'Localisation'],
  idea: ['Idea modding', 'Modifiers', 'Localisation'],
  focus: ['National focus modding', 'AI focuses', 'Effects', 'Triggers', 'Localisation'],
  technology: ['Technology modding', 'Equipment modding', 'Modifiers', 'Localisation'],
  gui: [
    'Interface modding',
    'Scripted GUI modding',
    'Graphical asset modding',
    'Localisation',
    'Scopes',
  ],
  map: [
    'Map modding',
    'State modding',
    'Strategic region modding',
    'Bookmark modding',
    'Localisation',
  ],
  localisation: ['Localisation', 'Data structures'],
  ai: ['AI modding', 'AI focuses', 'Triggers', 'Scopes'],
};
const gameDocNames: Record<ContextInput['surface'], string[]> = {
  general: ['documentation/script_concept_documentation'],
  event: [
    'documentation/effects_documentation',
    'documentation/triggers_documentation',
    'common/on_actions/_documentation',
  ],
  decision: ['common/decisions/_documentation', 'documentation/effects_documentation'],
  idea: ['documentation/modifiers_documentation'],
  focus: [
    'documentation/effects_documentation',
    'documentation/triggers_documentation',
    'common/focus_inlay_windows/documentation',
  ],
  technology: ['common/units/equipment/_documentation', 'documentation/modifiers_documentation'],
  gui: ['common/scripted_guis/_documentation'],
  map: ['common/map_modes/documentation', 'common/strategic_locations/documentation'],
  localisation: [
    'documentation/loc_formatter_documentation',
    'documentation/loc_objects_documentation',
  ],
  ai: ['common/ai_strategy/_documentation', 'documentation/triggers_documentation'],
};

/** A workspace-private, read-only reference index over explicitly known local roots. */
export class ReferenceService {
  readonly #cache = new Map<string, CachedFile>();
  readonly #indexes = new Map<string, RankingIndex>();
  #cacheBytes = 0;

  private retain(key: string, value: CachedFile): void {
    this.#cacheBytes -= this.#cache.get(key)?.bytes ?? 0;
    this.#cache.delete(key);
    this.#cache.set(key, value);
    this.#cacheBytes += value.bytes;
    while (this.#cacheBytes > MAX_TOTAL_BYTES || this.#cache.size > 1_024) {
      const oldest = this.#cache.entries().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest[0]);
      this.#cacheBytes -= oldest[1].bytes;
    }
  }

  async inventory(
    workspace: ResolvedWorkspace,
    signal?: AbortSignal,
    sources?: readonly SourceKind[],
  ): Promise<ReferenceInventory> {
    const sections: IndexedSection[] = [];
    const coverage: ReferenceInventory['coverage'] = {
      game_doc: {
        files: 0,
        sections: 0,
        unavailable: true,
        included: sources === undefined || sources.includes('game_doc'),
      },
      wiki: {
        files: 0,
        sections: 0,
        unavailable: true,
        included: sources === undefined || sources.includes('wiki'),
      },
      script_doc: {
        files: 0,
        sections: 0,
        unavailable: true,
        included: sources === undefined || sources.includes('script_doc'),
      },
    };
    let skipped = 0;
    let bytes = 0;
    for (const root of sourceRoots(workspace)) {
      if (sources !== undefined && !sources.includes(root.kind)) continue;
      signal?.throwIfAborted();
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root.root);
      } catch {
        coverage[root.kind].unavailable = true;
        continue;
      }
      const configuredAuthorityRoot =
        root.kind === 'game_doc'
          ? root.root
          : root.kind === 'wiki'
            ? (workspace.wikiRoot ?? workspace.modRoot)
            : (workspace.scriptDocsRoot ?? workspace.modRoot);
      if (!isWithin(configuredAuthorityRoot, canonicalRoot)) {
        throw new ServiceError(
          'REFERENCE_ROOT_ESCAPE',
          'Reference root resolves outside its configured workspace',
        );
      }
      coverage[root.kind].unavailable = false;
      const names = await globFiles(root.patterns, {
        cwd: canonicalRoot,
        caseSensitive: false,
        ...(signal === undefined ? {} : { signal }),
      });
      names.sort(compareCodeUnits);
      for (let offset = 0; offset < names.length; offset += 8) {
        signal?.throwIfAborted();
        if (coverage[root.kind].files >= MAX_FILES || sections.length >= MAX_SECTIONS) {
          skipped += names.length - offset;
          break;
        }
        const readRoot = { path: canonicalRoot };
        const prepared = await Promise.allSettled(
          names.slice(offset, offset + 8).map((name) => prepareSource(readRoot, name, signal)),
        );
        const opened = prepared.flatMap((entry) =>
          entry.status === 'fulfilled' ? [entry.value] : [],
        );
        try {
          signal?.throwIfAborted();
          for (const entry of prepared) {
            if (entry.status !== 'rejected') continue;
            if (entry.reason instanceof ServiceError && entry.reason.code === 'SCAN_ROOT_ESCAPE') {
              skipped++;
              continue;
            }
            throw new ServiceError(
              'REFERENCE_SOURCE_CHANGED',
              'Reference path changed while opening it; retry the request',
            );
          }
          const admittedSources: PreparedSource[] = [];
          for (const source of opened) {
            if (
              !source.metadata.isFile() ||
              source.metadata.size > MAX_FILE_BYTES ||
              bytes + source.metadata.size > MAX_TOTAL_BYTES ||
              coverage[root.kind].files >= MAX_FILES
            ) {
              skipped++;
              continue;
            }
            bytes += source.metadata.size;
            coverage[root.kind].files++;
            admittedSources.push(source);
          }
          const reads = await Promise.allSettled(
            admittedSources.map(async (source) => {
              const content = await readBoundedFile(source.handle, source.metadata.size, signal);
              await verifySource(readRoot, source);
              if (content.length !== source.metadata.size)
                throw new ServiceError(
                  'REFERENCE_SOURCE_CHANGED',
                  'Reference changed while it was being read; retry the request',
                );
              return content;
            }),
          );
          signal?.throwIfAborted();
          const failed = reads.find((entry) => entry.status === 'rejected');
          if (failed?.status === 'rejected')
            throw new ServiceError(
              'REFERENCE_SOURCE_CHANGED',
              'Reference changed while it was being read; retry the request',
            );
          for (const [index, read] of reads.entries()) {
            if (read.status !== 'fulfilled') continue;
            const canonical = admittedSources[index]!.canonicalPath;
            const content = read.value;
            const key = `${root.kind}:${canonicalRoot}:${canonical}`;
            const revision = sha256Bytes(content);
            let cached = this.#cache.get(key);
            if (cached?.revision !== revision)
              cached = {
                revision,
                bytes: content.length,
                sections: sectionize(root, canonical, referenceText(content), revision),
              };
            this.retain(key, cached);
            const admitted = cached.sections.slice(0, MAX_SECTIONS - sections.length);
            if (admitted.length < cached.sections.length) skipped++;
            sections.push(...admitted);
            coverage[root.kind].sections += admitted.length;
          }
        } finally {
          await Promise.all(opened.map(({ handle }) => handle.close()));
        }
      }
    }
    return { sections, coverage, skipped };
  }

  async search(
    workspace: ResolvedWorkspace,
    input: SearchInput,
    signal?: AbortSignal,
  ): Promise<ReferenceSearchResult> {
    const inventory = await this.inventory(workspace, signal, input.sources);
    const { ranked: matches, describe } = this.rank(inventory.sections, input.query);
    const results = matches.slice(0, input.limit).map((match) => {
      const { section, score, excerpt, matchLine } = describe(match);
      return { ...this.publicSection(section), score, excerpt, matchLine };
    });
    const requested = results.length;
    while (
      Buffer.byteLength(JSON.stringify(results), 'utf8') > MAX_REFERENCE_METADATA_BYTES &&
      results.length > 1
    )
      results.pop();
    if (Buffer.byteLength(JSON.stringify(results), 'utf8') > MAX_REFERENCE_METADATA_BYTES)
      throw new ServiceError(
        'REFERENCE_RESPONSE_TOO_LARGE',
        'Reference metadata exceeds the bounded reply',
      );
    return {
      results,
      total: matches.length,
      omitted: matches.length - results.length,
      limitedByBytes: results.length < requested,
      coverage: inventory.coverage,
      skipped: inventory.skipped,
    };
  }

  /** One index per distinct set of section revisions; IDF depends on the whole inventory. */
  private rankingIndex(sections: readonly IndexedSection[]): RankingIndex {
    const parts: string[] = [];
    let previous: IndexedSection | undefined;
    for (const section of sections) {
      if (previous?.path !== section.path || previous.revision !== section.revision)
        parts.push(`${section.source}\0${section.path}\0${section.revision}`);
      previous = section;
    }
    const key = sha256Bytes(Buffer.from(parts.join('\n'), 'utf8'));
    const cached = this.#indexes.get(key);
    if (cached !== undefined) {
      this.#indexes.delete(key);
      this.#indexes.set(key, cached);
      return cached;
    }
    const index = new RankingIndex(sections.map(({ terms }) => terms));
    this.#indexes.set(key, index);
    while (this.#indexes.size > 4) {
      const oldest = this.#indexes.keys().next().value;
      if (oldest === undefined) break;
      this.#indexes.delete(oldest);
    }
    return index;
  }

  private rank(sections: readonly IndexedSection[], question: string) {
    const index = this.rankingIndex(sections);
    const plan = index.plan(question);
    const scored: Array<{ section: IndexedSection; score: number }> = [];
    for (const section of sections) {
      const score = index.score(plan, section.terms, section.heading);
      if (score !== undefined) scored.push({ section, score: Math.round(score * 1000) / 1000 });
    }
    // Installed documentation precedes the wiki when both describe a command equally well.
    const order = (left: (typeof scored)[number], right: (typeof scored)[number]) =>
      right.score - left.score ||
      sourceOrder[left.section.source] - sourceOrder[right.section.source] ||
      compareCodeUnits(left.section.path, right.section.path) ||
      left.section.startLine - right.section.startLine;
    scored.sort(order);
    // Phrase adjacency is costlier to measure, so it only reorders the leading candidates.
    const leading = scored.slice(0, PHRASE_CANDIDATES);
    for (const entry of leading)
      entry.score =
        Math.round((entry.score + index.phraseBonus(plan, entry.section.lines)) * 1000) / 1000;
    leading.sort(order);
    scored.splice(0, leading.length, ...leading);
    // An exact table row ranked above the section containing it is the sharper citation.
    const rows = new Map<string, number[]>();
    const ranked = scored.filter(({ section }) => {
      const above = rows.get(section.path) ?? [];
      if (
        section.lines.length > 1 &&
        above.some((line) => line > section.startLine && line < section.endLine + 1)
      )
        return false;
      if (section.lines.length === 1) rows.set(section.path, [...above, section.startLine]);
      return true;
    });
    // The same command documented in several sources says little new after its first
    // citation. Later copies wait behind distinct answers unless they match exactly.
    const named = new Set<string>();
    const distinct: typeof ranked = [];
    const repeated: typeof ranked = [];
    for (const entry of ranked) {
      const key = entry.section.heading.toLowerCase();
      if (named.has(key) && entry.score < EXACT_HEADING_SCORE) repeated.push(entry);
      else distinct.push(entry);
      named.add(key);
    }
    ranked.splice(0, ranked.length, ...distinct, ...repeated);
    return {
      ranked,
      describe: ({ section, score }: { section: IndexedSection; score: number }): RankedSection => {
        const offset = index.bestLine(plan, section.lines);
        return {
          section,
          score,
          excerpt: snippet(section.lines, offset),
          matchLine: section.startLine + offset,
        };
      },
    };
  }

  async read(
    workspace: ResolvedWorkspace,
    input: ReadInput,
    signal?: AbortSignal,
  ): Promise<ReferenceReadResult> {
    let source = input.source;
    if (source === undefined) {
      for (const cached of this.#cache.values()) {
        const section = cached.sections.find(({ id }) => id === input.id);
        if (section !== undefined) {
          source = section.source;
          break;
        }
      }
    }
    const inventory = await this.inventory(
      workspace,
      signal,
      source === undefined ? undefined : [source],
    );
    const section = inventory.sections.find(({ id }) => id === input.id);
    if (section === undefined)
      throw new ServiceError(
        'REFERENCE_SECTION_UNKNOWN',
        'Reference section is not in this workspace',
      );
    if (section.revision !== input.revision)
      throw new ServiceError('REFERENCE_REVISION_STALE', 'Reference source changed; search again', {
        currentRevision: section.revision,
      });
    const startLine = input.startLine ?? section.startLine;
    const selected = readBoundedJsonLines(
      section.lines,
      section.startLine,
      startLine,
      input.startColumn ?? 1,
      input.maxLines,
      8_000,
      8_192,
    );
    return {
      ...this.publicSection(section),
      sectionStartLine: section.startLine,
      sectionEndLine: section.endLine,
      startLine,
      startColumn: input.startColumn ?? 1,
      ...selected,
    };
  }

  async context(
    workspace: ResolvedWorkspace,
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<ReferenceContextResult> {
    const inventory = await this.inventory(workspace, signal);
    const wanted = surfaceNames[input.surface];
    const ranking =
      input.question === undefined ? undefined : this.rank(inventory.sections, input.question);
    const ranked = ranking?.ranked ?? [];
    const required: Array<{ name: string; section: IndexedSection }> = [];
    const missing: string[] = [];
    const includeRequired = (name: string, section: IndexedSection | undefined) => {
      if (section === undefined) {
        missing.push(name);
        return;
      }
      const matching = ranked.find(
        (entry) => entry.section.path === section.path && entry.section.source === section.source,
      );
      required.push({ name, section: matching?.section ?? section });
    };
    for (const name of [...new Set(wanted)]) {
      const section = inventory.sections.find(
        (entry) => entry.source === 'wiki' && entry.title.toLowerCase() === name.toLowerCase(),
      );
      includeRequired(name, section);
    }
    for (const name of gameDocNames[input.surface]) {
      const section = inventory.sections.find(
        (entry) =>
          entry.source === 'game_doc' &&
          entry.path.replaceAll('\\', '/').toLowerCase().endsWith(`${name}.md`),
      );
      includeRequired(name, section);
    }
    const questionOrder = new Map(ranked.map(({ section }, index) => [section.id, index]));
    const byQuestion = (left: (typeof required)[number], right: (typeof required)[number]) =>
      (questionOrder.get(left.section.id) ?? Number.MAX_SAFE_INTEGER) -
      (questionOrder.get(right.section.id) ?? Number.MAX_SAFE_INTEGER);
    const game = required.filter(({ section }) => section.source === 'game_doc').sort(byQuestion);
    const wiki = required.filter(({ section }) => section.source === 'wiki').sort(byQuestion);
    const seen = new Set<string>();
    const prioritized = [
      ...[...game.slice(0, 1), ...wiki.slice(0, 1), ...game.slice(1), ...wiki.slice(1)].map(
        ({ section }) => section,
      ),
      ...ranked.slice(0, 5).map(({ section }) => section),
    ].filter((section) => {
      if (seen.has(section.id)) return false;
      seen.add(section.id);
      return true;
    });
    const selected = prioritized.slice(0, input.limit);
    const requestedCount = selected.length;
    while (
      Buffer.byteLength(
        JSON.stringify(selected.map((section) => this.publicSection(section))),
        'utf8',
      ) > MAX_REFERENCE_METADATA_BYTES &&
      selected.length > 1
    )
      selected.pop();
    if (
      Buffer.byteLength(
        JSON.stringify(selected.map((section) => this.publicSection(section))),
        'utf8',
      ) > MAX_REFERENCE_METADATA_BYTES
    )
      throw new ServiceError(
        'REFERENCE_RESPONSE_TOO_LARGE',
        'Reference metadata exceeds the bounded reply',
      );
    return {
      surface: input.surface,
      sections: selected.map((section) => {
        const match = ranked.find((entry) => entry.section.id === section.id);
        if (match === undefined || ranking === undefined) return this.publicSection(section);
        const { excerpt, matchLine } = ranking.describe(match);
        return { ...this.publicSection(section), excerpt, matchLine };
      }),
      omitted: Math.max(0, prioritized.length - selected.length),
      limitedByBytes: selected.length < requestedCount,
      omittedSources: required
        .filter(
          ({ section }) =>
            !selected.some(
              (entry) => entry.path === section.path && entry.source === section.source,
            ),
        )
        .map(({ name }) => name),
      missing,
      coverage: inventory.coverage,
      skipped: inventory.skipped,
    };
  }

  private publicSection(section: IndexedSection): ReferenceSection {
    return publicReferenceSection(section);
  }
}

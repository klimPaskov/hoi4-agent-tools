import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
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
import { readBoundedLines } from './lines.js';
import { readBoundedFile } from '../core/scanner.js';

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
  coverage: Record<SourceKind, { files: number; sections: number; unavailable: boolean }>;
  skipped: number;
}

const searchStopWords = new Set([
  'a',
  'an',
  'and',
  'at',
  'be',
  'can',
  'come',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'of',
  'the',
  'to',
  'where',
  'with',
  'work',
]);

function normalizeTerm(term: string): string {
  if (term === 'dated') return 'date';
  if (term.endsWith('ies') && term.length > 5) return `${term.slice(0, -3)}y`;
  if (term.endsWith('ses') && term.length > 5) return term.slice(0, -2);
  if (term.endsWith('s') && term.length > 4) return term.slice(0, -1);
  return term;
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9_.:-]+/gu) ?? [])
        .map(normalizeTerm)
        .filter((term) => /[a-z0-9]/u.test(term) && !searchStopWords.has(term)),
    ),
  ];
}

function containsTerm(text: string, term: string): boolean {
  if (term.length > 2) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, 'u').test(text);
}

function snippet(lines: readonly string[], terms: readonly string[] = []): string {
  let matching = -1;
  let best = -1;
  for (const [index, line] of lines.entries()) {
    const count = terms.filter((term) => containsTerm(line.toLowerCase(), term)).length;
    if (count > best) {
      matching = index;
      best = count;
    }
  }
  const selected = lines
    .slice(Math.max(0, matching), Math.max(0, matching) + 3)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return selected.slice(0, 300);
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
    .replace(/\.(md|log)$/u, '')
    .replaceAll('_', ' ')
    .replace(/ - Hearts of Iron 4 Wiki$/u, '');
  const headings: Array<{ heading: string; start: number }> = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match)
      headings.push({ heading: match[2]!.replace(/<a\b[^>]*><\/a>/gu, '').trim(), start: index });
    else if (
      root.kind === 'script_doc' &&
      filePath.endsWith('.log') &&
      /^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(line.trim()) &&
      !/^\s/u.test(line) &&
      /^\s+\S/u.test(lines[index + 1] ?? '')
    ) {
      headings.push({ heading: line.trim(), start: index });
    }
  }
  if (headings.length === 0 || headings[0]!.start > 0)
    headings.unshift({ heading: title, start: 0 });
  return headings.map((current, index) => {
    const end = headings[index + 1]?.start ?? lines.length;
    const sectionLines = lines.slice(current.start, end);
    const id = sha256Bytes(
      Buffer.from(`${root.kind}\0${relative}\0${current.start + 1}\0${current.heading}`, 'utf8'),
    );
    return {
      id,
      revision,
      source: root.kind,
      title,
      heading: current.heading.slice(0, 512),
      path: filePath,
      startLine: current.start + 1,
      endLine: end,
      excerpt: snippet(sectionLines),
      authority: root.authority,
      lines: sectionLines,
    };
  });
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

  async inventory(workspace: ResolvedWorkspace, signal?: AbortSignal): Promise<ReferenceInventory> {
    const sections: IndexedSection[] = [];
    const coverage: ReferenceInventory['coverage'] = {
      game_doc: { files: 0, sections: 0, unavailable: true },
      wiki: { files: 0, sections: 0, unavailable: true },
      script_doc: { files: 0, sections: 0, unavailable: true },
    };
    let skipped = 0;
    let bytes = 0;
    for (const root of sourceRoots(workspace)) {
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
      const names = await fg(root.patterns, {
        cwd: canonicalRoot,
        onlyFiles: true,
        followSymbolicLinks: false,
        dot: false,
      });
      names.sort(compareCodeUnits);
      for (const name of names) {
        signal?.throwIfAborted();
        if (coverage[root.kind].files >= MAX_FILES || sections.length >= MAX_SECTIONS) {
          skipped++;
          continue;
        }
        const candidate = path.join(canonicalRoot, name);
        const canonical = await realpath(candidate);
        if (!isWithin(canonicalRoot, canonical)) {
          skipped++;
          continue;
        }
        const metadata = await stat(canonical);
        if (metadata.size > MAX_FILE_BYTES || bytes + metadata.size > MAX_TOTAL_BYTES) {
          skipped++;
          continue;
        }
        bytes += metadata.size;
        coverage[root.kind].files++;
        const key = `${root.kind}:${canonicalRoot}:${canonical}`;
        const handle = await open(canonical, 'r');
        let content: Buffer;
        try {
          const opened = await handle.stat();
          const resolvedAfterOpen = await realpath(canonical);
          const current = await stat(resolvedAfterOpen);
          if (
            !opened.isFile() ||
            !isWithin(canonicalRoot, resolvedAfterOpen) ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino
          ) {
            throw new ServiceError(
              'REFERENCE_SOURCE_CHANGED',
              'Reference path changed while opening it; retry the request',
            );
          }
          content = await readBoundedFile(
            handle,
            Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - bytes + metadata.size),
            signal,
          );
        } finally {
          await handle.close();
        }
        bytes += content.length - metadata.size;
        const revision = sha256Bytes(content);
        let cached = this.#cache.get(key);
        if (cached?.revision !== revision) {
          cached = {
            revision,
            bytes: content.length,
            sections: sectionize(root, canonical, content.toString('utf8'), revision),
          };
        }
        this.retain(key, cached);
        const admitted = cached.sections.slice(0, MAX_SECTIONS - sections.length);
        if (admitted.length < cached.sections.length) skipped++;
        sections.push(...admitted);
        coverage[root.kind].sections += admitted.length;
      }
    }
    return { sections, coverage, skipped };
  }

  async search(
    workspace: ResolvedWorkspace,
    input: SearchInput,
    signal?: AbortSignal,
  ): Promise<ReferenceSearchResult> {
    const inventory = await this.inventory(workspace, signal);
    const matches = this.rank(inventory.sections, input.query, input.sources);
    return {
      results: matches.slice(0, input.limit).map(({ section, score, excerpt }) => ({
        ...this.publicSection(section),
        score,
        excerpt,
      })),
      total: matches.length,
      coverage: inventory.coverage,
      skipped: inventory.skipped,
    };
  }

  private rank(
    sections: readonly IndexedSection[],
    question: string,
    sources?: readonly SourceKind[],
  ) {
    const query = question.toLowerCase();
    const terms = queryTerms(query);
    return sections
      .flatMap((section) => {
        if (sources !== undefined && !sources.includes(section.source)) return [];
        const title = section.title.toLowerCase();
        const heading = section.heading.toLowerCase();
        const body = section.lines.join('\n').toLowerCase();
        let matched = 0;
        let score = 0;
        for (const term of terms) {
          const inTitle = containsTerm(title, term);
          const inHeading = containsTerm(heading, term);
          const inBody = containsTerm(body, term);
          if (!inTitle && !inHeading && !inBody) continue;
          matched++;
          score += (inTitle ? 24 : 0) + (inHeading ? 18 : 0) + (inBody ? 3 : 0);
        }
        if (matched < Math.max(1, Math.ceil(terms.length * 0.6))) return [];
        if (heading === query) score += 100;
        else if (heading.includes(query)) score += 70;
        if (body.includes(query)) score += 30;
        return [{ section, score, excerpt: snippet(section.lines, terms) }];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareCodeUnits(left.section.path, right.section.path) ||
          left.section.startLine - right.section.startLine,
      );
  }

  async read(
    workspace: ResolvedWorkspace,
    input: ReadInput,
    signal?: AbortSignal,
  ): Promise<ReferenceReadResult> {
    const inventory = await this.inventory(workspace, signal);
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
    const selected = readBoundedLines(
      section.lines,
      section.startLine,
      startLine,
      input.startColumn ?? 1,
      input.maxLines,
      8_000,
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
    const ranked =
      input.question === undefined ? [] : this.rank(inventory.sections, input.question);
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
    return {
      surface: input.surface,
      sections: selected.map((section) => ({
        ...this.publicSection(section),
        excerpt:
          ranked.find((entry) => entry.section.id === section.id)?.excerpt ?? section.excerpt,
      })),
      omitted: Math.max(0, prioritized.length - input.limit),
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
    const { lines: _lines, ...publicSection } = section;
    return publicSection;
  }
}

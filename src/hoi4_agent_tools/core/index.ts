import { compareCodeUnits } from './canonical.js';
import { ServiceError } from './result.js';
import path from 'node:path';
import type { Diagnostic, SourceLocation } from './diagnostics.js';
import { sortDiagnostics } from './diagnostics.js';
import type { ScannedFile } from './scanner.js';
import { engineSymbolIndex, engineSymbolIndexSync } from './engine-index.js';
import {
  parseClausewitz,
  firstScalar,
  sourcePartialLimitDiagnostics,
  type SourceDocument,
} from './source/index.js';

export type SymbolKind =
  | 'focus_tree'
  | 'focus'
  | 'continuous_focus_palette'
  | 'continuous_focus'
  | 'decision'
  | 'decision_category'
  | 'event'
  | 'idea'
  | 'leader'
  | 'formable'
  | 'scripted_effect'
  | 'scripted_trigger'
  | 'script_constant'
  | 'mtth_variable'
  | 'ai_strategy'
  | 'ai_strategy_plan'
  | 'sprite'
  | 'texture'
  | 'gui_element'
  | 'scripted_gui'
  | 'technology'
  | 'technology_folder'
  | 'technology_category'
  | 'technology_tag'
  | 'equipment'
  | 'equipment_module'
  | 'sub_unit'
  | 'unit_category'
  | 'building'
  | 'ability'
  | 'combat_tactic'
  | 'doctrine_folder'
  | 'grand_doctrine'
  | 'doctrine_track'
  | 'subdoctrine'
  | 'localisation'
  | 'variable'
  | 'flag'
  | 'event_target'
  | 'state'
  | 'province'
  | 'province_color'
  | 'strategic_region'
  | 'adjacency'
  | 'supply_node'
  | 'railway';

export interface SymbolRecord {
  kind: SymbolKind;
  id: string;
  path: string;
  rootKind: ScannedFile['rootKind'];
  loadOrder: number;
  location?: SourceLocation;
  metadata: Record<string, unknown>;
  overridden: boolean;
  sourceShadowed: boolean;
}

export interface ReferenceRecord {
  kind: string;
  from: string;
  toKind: SymbolKind;
  to: string;
  path: string;
  location?: SourceLocation;
}

/** One file's records from `hoi4-engine index-files` (ADR 0085). */
export interface EngineIndexFileAnswer {
  symbols: Array<[SymbolKind, string, SourceLocation | null, Record<string, unknown>]>;
  references: Array<[string, string, SymbolKind, string, SourceLocation]>;
  diagnostics: Diagnostic[];
  /** The ceiling diagnostics that make the index skip the file. */
  skip: Diagnostic[] | null;
  /** A table or nesting ceiling made the index incomplete. */
  incomplete: boolean;
}

/** A file the index asks the engine about, with what the engine needs to know of it. */
export interface EngineIndexFileRequest {
  file: ScannedFile;
  /** A `definition.csv` the index selected. */
  definitionFile: boolean;
  /** The workspace owns it, so its parser diagnostics are reported. */
  owned: boolean;
  /** A higher layer replaces it, so its diagnostics and references are dropped. */
  shadowed: boolean;
}

/** The order the index visits files in: by load order, then by display path. */
export function engineIndexOrder(files: readonly ScannedFile[]): ScannedFile[] {
  return [...files].sort(
    (a, b) => a.loadOrder - b.loadOrder || compareCodeUnits(a.displayPath, b.displayPath),
  );
}

export interface IndexSkippedSource {
  path: string;
  relativePath: string;
  rootKind: ScannedFile['rootKind'];
  loadOrder: number;
  sha256: string;
  reasonCodes: string[];
  possibleSymbolKinds: SymbolKind[];
}

// A current HOI4 installation plus one feature-rich mod exceeds 250k symbols
// before the higher-precedence mod roots are reached. Keep the inventory
// bounded, but leave enough headroom for the supported game build and a large
// external workspace so valid mod symbols are never discarded behind vanilla.
const INDEX_RECORD_LIMIT = 2_000_000;
const INDEX_DIAGNOSTIC_LIMIT = 10_000;
const INDEX_RELATED_LOCATION_LIMIT = 100;
export const INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT = 100;

function possibleSymbolKinds(
  file: ScannedFile,
  definitionFiles: ReadonlySet<string>,
): SymbolKind[] {
  const sourcePath = file.relativePath.replaceAll('\\', '/').toLowerCase();
  const kinds = new Set<SymbolKind>();
  if (sourcePath.endsWith('.yml') || sourcePath.endsWith('.yaml')) kinds.add('localisation');
  if (definitionFiles.has(file.displayPath) || path.posix.basename(sourcePath) === 'default.map') {
    kinds.add('province');
    kinds.add('province_color');
  }
  if (sourcePath.endsWith('adjacencies.csv')) kinds.add('adjacency');
  if (sourcePath.endsWith('supply_nodes.txt')) kinds.add('supply_node');
  if (sourcePath.endsWith('railways.txt')) kinds.add('railway');
  if (sourcePath.endsWith('.gfx')) {
    kinds.add('sprite');
    kinds.add('texture');
  }
  if (sourcePath.endsWith('.gui')) kinds.add('gui_element');
  if (sourcePath.endsWith('.txt')) {
    if (sourcePath.startsWith('common/technologies/')) kinds.add('technology');
    if (sourcePath.startsWith('common/technology_tags/')) {
      kinds.add('technology_folder');
      kinds.add('technology_category');
      kinds.add('technology_tag');
    }
    if (sourcePath.startsWith('common/units/equipment/modules/')) kinds.add('equipment_module');
    else if (sourcePath.startsWith('common/units/equipment/')) kinds.add('equipment');
    else if (sourcePath.startsWith('common/units/')) kinds.add('sub_unit');
    if (sourcePath.startsWith('common/unit_tags/')) kinds.add('unit_category');
    if (sourcePath.startsWith('common/buildings/')) kinds.add('building');
    if (sourcePath.startsWith('common/abilities/')) kinds.add('ability');
    if (
      sourcePath === 'common/combat_tactics.txt' ||
      sourcePath.startsWith('common/combat_tactics/')
    )
      kinds.add('combat_tactic');
    if (sourcePath.startsWith('common/doctrines/folders/')) kinds.add('doctrine_folder');
    if (sourcePath.startsWith('common/doctrines/grand_doctrines/')) kinds.add('grand_doctrine');
    if (sourcePath.startsWith('common/doctrines/tracks/')) kinds.add('doctrine_track');
    if (sourcePath.startsWith('common/doctrines/subdoctrines/')) kinds.add('subdoctrine');
    if (/(?:^|\/)focus(?:es)?(?:\/|$)|national_focus|continuous_focus/u.test(sourcePath)) {
      kinds.add('focus_tree');
      kinds.add('focus');
      kinds.add('continuous_focus_palette');
      kinds.add('continuous_focus');
    }
    if (sourcePath.startsWith('events/')) kinds.add('event');
    if (sourcePath.startsWith('common/scripted_effects/')) kinds.add('scripted_effect');
    if (sourcePath.startsWith('common/scripted_triggers/')) kinds.add('scripted_trigger');
    if (sourcePath.startsWith('common/script_constants/')) kinds.add('script_constant');
    if (sourcePath.startsWith('common/mtth/')) kinds.add('mtth_variable');
    if (sourcePath.startsWith('common/ai_strategy/')) kinds.add('ai_strategy');
    if (sourcePath.startsWith('common/ai_strategy_plans/')) kinds.add('ai_strategy_plan');
    if (sourcePath.startsWith('common/decisions/')) {
      kinds.add('decision');
      kinds.add('decision_category');
      kinds.add('formable');
    }
    if (sourcePath.startsWith('common/ideas/')) kinds.add('idea');
    if (sourcePath.startsWith('common/characters/')) kinds.add('leader');
    if (sourcePath.startsWith('common/scripted_guis/')) kinds.add('scripted_gui');
    if (/(?:^|\/)history\/states\//u.test(sourcePath)) kinds.add('state');
    if (/(?:^|\/)strategicregions\//u.test(sourcePath)) kinds.add('strategic_region');
  }
  return [...kinds].sort((left, right) => compareCodeUnits(left, right));
}

function normalizedRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function sourceIdentity(file: Pick<ScannedFile, 'rootKind' | 'loadOrder'>): string {
  return `${file.rootKind}:${file.loadOrder}`;
}

function isWorkspaceOwnedSource(file: Pick<ScannedFile, 'rootKind'> | undefined): boolean {
  return file?.rootKind === 'mod' || file?.rootKind === 'fixture';
}

interface DefinitionSelection {
  selected: Set<string>;
  skipped: Array<{ file: ScannedFile; diagnostics: Diagnostic[] }>;
}

function selectedDefinitionFiles(files: readonly ScannedFile[]): DefinitionSelection {
  const defaults = files.filter(
    ({ relativePath }) => path.posix.basename(normalizedRelative(relativePath)) === 'default.map',
  );
  const directories = [
    ...new Set(
      defaults.map(({ relativePath }) => path.posix.dirname(normalizedRelative(relativePath))),
    ),
  ];
  const parsedDefaults = new Map<string, SourceDocument>();
  const skippedDefaults = new Map<string, { file: ScannedFile; diagnostics: Diagnostic[] }>();
  const parseDefault = (file: ScannedFile): SourceDocument | undefined => {
    if (skippedDefaults.has(file.displayPath)) return undefined;
    const cached = parsedDefaults.get(file.displayPath);
    if (cached !== undefined) return cached;
    const document = parseClausewitz(file.bytes, file.displayPath);
    const limitDiagnostics = sourcePartialLimitDiagnostics(document.diagnostics);
    if (limitDiagnostics.length > 0) {
      skippedDefaults.set(file.displayPath, { file, diagnostics: limitDiagnostics });
      return undefined;
    }
    parsedDefaults.set(file.displayPath, document);
    return document;
  };
  const activeSelector = new Map<string, string>();
  const activeSelectorDecided = new Set<string>();
  const blockedActiveSelector = new Set<string>();
  for (const file of [...defaults].sort(
    (left, right) =>
      right.loadOrder - left.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
  )) {
    const directory = path.posix.dirname(normalizedRelative(file.relativePath));
    if (activeSelectorDecided.has(directory)) continue;
    activeSelectorDecided.add(directory);
    const document = parseDefault(file);
    if (document === undefined) {
      blockedActiveSelector.add(directory);
      continue;
    }
    activeSelector.set(
      directory,
      firstScalar(document.root, 'definitions')?.value ?? 'definition.csv',
    );
  }

  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const group = groups.get(sourceIdentity(file)) ?? [];
    group.push(file);
    groups.set(sourceIdentity(file), group);
  }
  const selected = new Set<string>();
  for (const group of groups.values()) {
    const byRelative = new Map(
      group.map((file) => [normalizedRelative(file.relativePath), file] as const),
    );
    for (const directory of directories) {
      if (blockedActiveSelector.has(directory)) continue;
      const defaultMap = byRelative.get(path.posix.join(directory, 'default.map'));
      const document = defaultMap === undefined ? undefined : parseDefault(defaultMap);
      if (defaultMap !== undefined && document === undefined) continue;
      const selector =
        (document === undefined ? undefined : firstScalar(document.root, 'definitions')?.value) ??
        activeSelector.get(directory) ??
        'definition.csv';
      const definition = byRelative.get(
        normalizedRelative(path.posix.join(directory, selector).replaceAll('\\', '/')),
      );
      if (definition !== undefined) selected.add(definition.displayPath);
    }
  }
  for (const file of files) {
    const relativePath = normalizedRelative(file.relativePath);
    if (
      path.posix.basename(relativePath) === 'definition.csv' &&
      !directories.includes(path.posix.dirname(relativePath))
    ) {
      selected.add(file.displayPath);
    }
  }
  return { selected, skipped: [...skippedDefaults.values()] };
}

export class SymbolIndex {
  readonly symbols: SymbolRecord[] = [];
  readonly references: ReferenceRecord[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly skippedSources: IndexSkippedSource[] = [];
  readonly files = new Map<string, ScannedFile>();
  readonly #active = new Map<string, SymbolRecord>();
  readonly #definitionFiles = new Set<string>();
  readonly #skippedSourcePaths = new Set<string>();
  readonly #skippedPossibleSymbolKinds = new Set<SymbolKind>();
  #currentFileShadowed = false;
  #complete = true;
  #skippedSourceCount = 0;
  #symbolLimitReported = false;
  #referenceLimitReported = false;
  #diagnosticsTruncated = false;

  /**
   * The index of `files` from the shared engine's per-file records (`hoi4-engine index-files`,
   * ADR 0085): the engine parses and walks each file, and this side keeps the bookkeeping across
   * files exactly as `build` does. `answers` lines up with `engineIndexOrder(files)`.
   */
  static fromEngine(
    files: readonly ScannedFile[],
    answers: readonly EngineIndexFileAnswer[],
  ): SymbolIndex {
    const index = new SymbolIndex();
    const definitionSelection = selectedDefinitionFiles(files);
    for (const displayPath of definitionSelection.selected) index.#definitionFiles.add(displayPath);
    for (const skipped of definitionSelection.skipped) {
      index.recordSkippedSource(skipped.file, skipped.diagnostics);
    }
    const ordered = engineIndexOrder(files);
    if (answers.length !== ordered.length)
      throw new ServiceError(
        'ENGINE_UNAVAILABLE',
        'hoi4-engine index-files answered out of shape',
        {
          reason: 'invalid_output',
        },
      );
    for (const [position, file] of ordered.entries()) {
      const answer = answers[position]!;
      index.files.set(file.displayPath, file);
      index.#currentFileShadowed = file.shadowedBy !== undefined;
      if (answer.skip !== null) {
        index.recordSkippedSource(file, answer.skip);
        continue;
      }
      index.addDiagnostics(answer.diagnostics);
      for (const [kind, id, location, metadata] of answer.symbols)
        index.addSymbol({
          kind,
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          ...(location === null ? {} : { location }),
          metadata,
        });
      for (const [kind, from, toKind, to, location] of answer.references)
        index.addReference({ kind, from, toKind, to, path: file.displayPath, location });
      if (answer.incomplete) index.#complete = false;
    }
    index.finalize();
    return index;
  }

  /** The files `fromEngine` sends to the engine, in the index's order, with their options. */
  static engineRequestFiles(files: readonly ScannedFile[]): EngineIndexFileRequest[] {
    const definitions = selectedDefinitionFiles(files).selected;
    return engineIndexOrder(files).map((file) => ({
      file,
      definitionFile: definitions.has(file.displayPath),
      owned: isWorkspaceOwnedSource(file),
      shadowed: file.shadowedBy !== undefined,
    }));
  }

  /** The shared index of `files` from a one-shot engine (ADR 0085). */
  static build(files: readonly ScannedFile[]): SymbolIndex {
    return engineSymbolIndexSync(files);
  }

  /** The shared index of `files` from the resident engine (ADR 0085). */
  static buildAsync(files: readonly ScannedFile[], signal?: AbortSignal): Promise<SymbolIndex> {
    return engineSymbolIndex(files, signal);
  }

  get complete(): boolean {
    return this.#complete;
  }

  get skippedSourceCount(): number {
    return this.#skippedSourceCount;
  }

  get skippedPossibleSymbolKinds(): readonly SymbolKind[] {
    return [...this.#skippedPossibleSymbolKinds].sort((left, right) =>
      compareCodeUnits(left, right),
    );
  }

  isSourceSkipped(path: string): boolean {
    return this.#skippedSourcePaths.has(path);
  }

  hasSkippedSourceForKind(kind: SymbolKind): boolean {
    return this.#skippedPossibleSymbolKinds.has(kind);
  }

  find(kind: SymbolKind, id: string): SymbolRecord | undefined {
    return this.#active.get(`${kind}:${id}`);
  }

  findAll(kind: SymbolKind, id?: string): SymbolRecord[] {
    return this.symbols.filter(
      (symbol) => symbol.kind === kind && (id === undefined || symbol.id === id),
    );
  }

  rebuild(files: readonly ScannedFile[]): SymbolIndex {
    return SymbolIndex.build(files);
  }

  unresolvedReferences(): ReferenceRecord[] {
    return this.references.filter(
      (reference) => this.find(reference.toKind, reference.to) === undefined,
    );
  }

  private recordSkippedSource(file: ScannedFile, diagnostics: readonly Diagnostic[]): void {
    if (file.shadowedBy !== undefined || this.#skippedSourcePaths.has(file.displayPath)) return;
    const candidates = possibleSymbolKinds(file, this.#definitionFiles);
    // Files outside indexed HOI4 domains may still match broad text globs. A parsing ceiling in one
    // of those files does not make the symbol inventory partial.
    if (candidates.length === 0) return;
    this.#skippedSourcePaths.add(file.displayPath);
    this.#complete = false;
    this.#skippedSourceCount += 1;
    const reasonCodes = [...new Set(diagnostics.map(({ code }) => code))].sort((left, right) =>
      compareCodeUnits(left, right),
    );
    for (const kind of candidates) this.#skippedPossibleSymbolKinds.add(kind);
    if (this.skippedSources.length >= INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT) return;
    const skipped: IndexSkippedSource = {
      path: file.displayPath,
      relativePath: file.relativePath,
      rootKind: file.rootKind,
      loadOrder: file.loadOrder,
      sha256: file.sha256,
      reasonCodes,
      possibleSymbolKinds: candidates,
    };
    this.skippedSources.push(skipped);
    const location = diagnostics.find(({ location }) => location !== undefined)?.location;
    this.addDiagnostic({
      code: 'INDEX_SOURCE_SKIPPED_LIMIT',
      severity: 'warning',
      category: 'reference',
      message: `Shared inventory skipped ${file.displayPath} because it exceeds a source parsing limit`,
      ...(location === undefined ? {} : { location }),
      details: {
        path: file.displayPath,
        reasonCodes,
        possibleSymbolKinds: candidates,
      },
    });
  }

  /** Record parser coverage without allocating symbols for a domain that builds its own graph. */
  recordSourceCoverage(file: ScannedFile, diagnostics: readonly Diagnostic[]): boolean {
    const limits = sourcePartialLimitDiagnostics(diagnostics);
    if (limits.length > 0) {
      this.recordSkippedSource(file, limits);
      return false;
    }
    if (isWorkspaceOwnedSource(file) && file.shadowedBy === undefined)
      this.addDiagnostics(diagnostics);
    return true;
  }

  private addSymbol(record: Omit<SymbolRecord, 'overridden' | 'sourceShadowed'>): void {
    if (this.symbols.length >= INDEX_RECORD_LIMIT) {
      this.#complete = false;
      this.#skippedPossibleSymbolKinds.add(record.kind);
      if (!this.#symbolLimitReported) {
        this.#symbolLimitReported = true;
        this.addDiagnostic({
          code: 'INDEX_SYMBOL_LIMIT',
          severity: 'blocker',
          category: 'reference',
          message: 'Shared symbol index exceeds the configured record limit',
          details: { limit: INDEX_RECORD_LIMIT },
        });
      }
      return;
    }
    this.symbols.push({
      ...record,
      overridden: this.#currentFileShadowed,
      sourceShadowed: this.#currentFileShadowed,
    });
  }

  private addReference(record: ReferenceRecord): void {
    if (this.references.length >= INDEX_RECORD_LIMIT) {
      this.#complete = false;
      if (!this.#referenceLimitReported) {
        this.#referenceLimitReported = true;
        this.addDiagnostic({
          code: 'INDEX_REFERENCE_LIMIT',
          severity: 'blocker',
          category: 'reference',
          message: 'Shared reference index exceeds the configured record limit',
          details: { limit: INDEX_RECORD_LIMIT },
        });
      }
      return;
    }
    this.references.push(record);
  }

  private addDiagnostic(diagnostic: Diagnostic): void {
    if (this.#diagnosticsTruncated) return;
    if (this.diagnostics.length < INDEX_DIAGNOSTIC_LIMIT) {
      this.diagnostics.push(diagnostic);
      return;
    }
    this.diagnostics[INDEX_DIAGNOSTIC_LIMIT - 1] = {
      code: 'INDEX_DIAGNOSTICS_TRUNCATED',
      severity: 'blocker',
      category: 'reference',
      message: 'Shared index diagnostics exceeded the configured output limit',
      details: { limit: INDEX_DIAGNOSTIC_LIMIT },
    };
    this.#diagnosticsTruncated = true;
  }

  private addDiagnostics(diagnostics: readonly Diagnostic[]): void {
    for (const diagnostic of diagnostics) this.addDiagnostic(diagnostic);
  }

  private finalize(): void {
    if (this.#skippedSourceCount > this.skippedSources.length) {
      this.addDiagnostic({
        code: 'INDEX_SKIPPED_SOURCE_LIST_TRUNCATED',
        severity: 'warning',
        category: 'reference',
        message: 'Shared inventory skipped more sources than the bounded source list can retain',
        details: {
          skippedSourceCount: this.#skippedSourceCount,
          retained: this.skippedSources.length,
          limit: INDEX_SKIPPED_SOURCE_SAMPLE_LIMIT,
        },
      });
    }
    if (
      this.#symbolLimitReported &&
      !this.diagnostics.some(({ code }) => code === 'INDEX_SYMBOL_LIMIT')
    ) {
      this.addDiagnostic({
        code: 'INDEX_SYMBOL_LIMIT',
        severity: 'blocker',
        category: 'reference',
        message: 'Shared symbol index exceeds the configured record limit',
        details: { limit: INDEX_RECORD_LIMIT },
      });
    }
    if (
      this.#referenceLimitReported &&
      !this.diagnostics.some(({ code }) => code === 'INDEX_REFERENCE_LIMIT')
    ) {
      this.addDiagnostic({
        code: 'INDEX_REFERENCE_LIMIT',
        severity: 'blocker',
        category: 'reference',
        message: 'Shared reference index exceeds the configured record limit',
        details: { limit: INDEX_RECORD_LIMIT },
      });
    }
    const groups = new Map<string, SymbolRecord[]>();
    for (const symbol of this.symbols) {
      const key = `${symbol.kind}:${symbol.id}`;
      const group = groups.get(key) ?? [];
      group.push(symbol);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      group.sort((a, b) => b.loadOrder - a.loadOrder || compareCodeUnits(a.path, b.path));
      const candidates = group.filter(({ sourceShadowed }) => !sourceShadowed);
      if (candidates.length === 0) continue;
      const active = candidates[0]!;
      this.#active.set(key, active);
      const additiveCategory =
        active.kind === 'decision_category' ||
        active.kind === 'technology_category' ||
        active.kind === 'gui_element' ||
        active.kind === 'texture';
      for (const candidate of group) {
        candidate.overridden = additiveCategory ? candidate.sourceShadowed : candidate !== active;
      }
      const sameLevel = candidates.filter(({ loadOrder }) => loadOrder === active.loadOrder);
      if (
        !additiveCategory &&
        sameLevel.length > 1 &&
        sameLevel.some((candidate) => isWorkspaceOwnedSource(this.files.get(candidate.path)))
      ) {
        this.addDiagnostic({
          code: 'INDEX_SYMBOL_COLLISION',
          severity: 'error',
          category: 'reference',
          message: `Multiple active definitions for ${key}`,
          ...(active.location === undefined ? {} : { location: active.location }),
          related: sameLevel
            .slice(1, INDEX_RELATED_LOCATION_LIMIT + 1)
            .flatMap(({ location }) => (location === undefined ? [] : [location])),
        });
      }
    }
    for (const reference of this.unresolvedReferences().filter((candidate) =>
      isWorkspaceOwnedSource(this.files.get(candidate.path)),
    )) {
      const mayResolveFromSkippedSource = this.#skippedPossibleSymbolKinds.has(reference.toKind);
      this.addDiagnostic({
        code: mayResolveFromSkippedSource
          ? 'INDEX_UNRESOLVED_REFERENCE_PARTIAL'
          : 'INDEX_UNRESOLVED_REFERENCE',
        severity: mayResolveFromSkippedSource ? 'warning' : 'error',
        category: 'reference',
        message: mayResolveFromSkippedSource
          ? `The partial shared inventory cannot resolve ${reference.toKind} reference ${reference.to}; a skipped source could define it`
          : `Unresolved ${reference.toKind} reference: ${reference.to}`,
        ...(reference.location === undefined ? {} : { location: reference.location }),
        details: {
          referenceKind: reference.kind,
          toKind: reference.toKind,
          from: reference.from,
          ...(mayResolveFromSkippedSource ? { skippedSourceCount: this.#skippedSourceCount } : {}),
        },
      });
    }
    const sorted = sortDiagnostics(this.diagnostics);
    this.diagnostics.splice(0, this.diagnostics.length, ...sorted);
  }
}

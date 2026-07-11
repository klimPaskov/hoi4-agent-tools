import { compareCodeUnits } from './canonical.js';
import path from 'node:path';
import type { Diagnostic, SourceLocation } from './diagnostics.js';
import { sortDiagnostics } from './diagnostics.js';
import type { ScannedFile } from './scanner.js';
import {
  parseClausewitz,
  parseLocalisation,
  assignments,
  childBlocks,
  firstScalar,
  locationFor,
  sourcePartialLimitDiagnostics,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_NESTING,
  nodeLocation,
  type BlockNode,
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
  | 'sprite'
  | 'texture'
  | 'gui_element'
  | 'scripted_gui'
  | 'localisation'
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

export interface IndexSkippedSource {
  path: string;
  relativePath: string;
  rootKind: ScannedFile['rootKind'];
  loadOrder: number;
  sha256: string;
  reasonCodes: string[];
  possibleSymbolKinds: SymbolKind[];
}

const guiElementKeys = new Set([
  'containerWindowType',
  'windowType',
  'iconType',
  'buttonType',
  'instantTextBoxType',
  'textBoxType',
  'gridBoxType',
  'listboxType',
  'smoothListboxType',
  'scrollbarType',
  'checkboxType',
  'editBoxType',
  'OverlappingElementsBoxType',
]);

const eventBlockKeys = new Set([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

const decisionCategoryFields = new Set([
  'allowed',
  'available',
  'icon',
  'picture',
  'priority',
  'scripted_gui',
  'target_root_trigger',
  'visible',
  'visible_when_empty',
]);

// A current HOI4 installation plus one feature-rich mod exceeds 250k symbols
// before the higher-precedence mod roots are reached. Keep the inventory
// bounded, but leave enough headroom for the supported game build and a large
// external workspace so valid mod symbols are never discarded behind vanilla.
const INDEX_RECORD_LIMIT = 500_000;
const INDEX_DIAGNOSTIC_LIMIT = 10_000;
const INDEX_RELATED_LOCATION_LIMIT = 100;
const INDEX_TABLE_RECORD_LIMIT = 100_000;
const INDEX_TABLE_FIELD_LIMIT = 10_000;
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
    if (/(?:^|\/)focus(?:es)?(?:\/|$)|national_focus|continuous_focus/u.test(sourcePath)) {
      kinds.add('focus_tree');
      kinds.add('focus');
      kinds.add('continuous_focus_palette');
      kinds.add('continuous_focus');
    }
    if (sourcePath.startsWith('events/')) kinds.add('event');
    if (sourcePath.startsWith('common/scripted_effects/')) kinds.add('scripted_effect');
    if (sourcePath.startsWith('common/scripted_triggers/')) kinds.add('scripted_trigger');
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

function splitDelimitedBounded(value: string, delimiter: string, maximumFields: number): string[] {
  const result: string[] = [];
  let start = 0;
  while (result.length + 1 < maximumFields) {
    const next = value.indexOf(delimiter, start);
    if (next < 0) break;
    result.push(value.slice(start, next));
    start = next + delimiter.length;
  }
  result.push(value.slice(start));
  return result;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function scalars(block: BlockNode): string[] {
  return block.entries.filter((entry) => entry.type === 'scalar').map((entry) => entry.value);
}

function normalizedRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function sourceIdentity(file: Pick<ScannedFile, 'rootKind' | 'loadOrder'>): string {
  return `${file.rootKind}:${file.loadOrder}`;
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
  readonly #indexNestingBlocked = new Set<string>();
  readonly #skippedSourcePaths = new Set<string>();
  readonly #skippedPossibleSymbolKinds = new Set<SymbolKind>();
  #currentFileShadowed = false;
  #complete = true;
  #skippedSourceCount = 0;
  #symbolLimitReported = false;
  #referenceLimitReported = false;
  #diagnosticsTruncated = false;

  static build(files: readonly ScannedFile[]): SymbolIndex {
    const index = new SymbolIndex();
    const definitionSelection = selectedDefinitionFiles(files);
    for (const displayPath of definitionSelection.selected) index.#definitionFiles.add(displayPath);
    for (const skipped of definitionSelection.skipped) {
      index.recordSkippedSource(skipped.file, skipped.diagnostics);
    }
    for (const file of [...files].sort(
      (a, b) => a.loadOrder - b.loadOrder || compareCodeUnits(a.displayPath, b.displayPath),
    )) {
      index.files.set(file.displayPath, file);
      index.indexFile(file);
    }
    index.finalize();
    return index;
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
    this.#skippedSourcePaths.add(file.displayPath);
    this.#complete = false;
    this.#skippedSourceCount += 1;
    const reasonCodes = [...new Set(diagnostics.map(({ code }) => code))].sort((left, right) =>
      compareCodeUnits(left, right),
    );
    const candidates = possibleSymbolKinds(file, this.#definitionFiles);
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

  private indexFile(file: ScannedFile): void {
    this.#currentFileShadowed = file.shadowedBy !== undefined;
    const diagnosticStart = this.diagnostics.length;
    const referenceStart = this.references.length;
    const lower = file.relativePath.toLowerCase();
    if (lower.endsWith('.yml')) {
      const document = parseLocalisation(file.bytes, file.displayPath);
      const limitDiagnostics = sourcePartialLimitDiagnostics(document.diagnostics);
      if (limitDiagnostics.length > 0) {
        this.recordSkippedSource(file, limitDiagnostics);
        return;
      }
      this.addDiagnostics(document.diagnostics);
      for (const entry of document.entries) {
        this.addSymbol({
          kind: 'localisation',
          id: `${entry.language}:${entry.key}`,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: locationFor(file.displayPath, document.lineIndex, entry.start, entry.end),
          metadata: { language: entry.language, key: entry.key, value: entry.value },
        });
      }
      if (this.#currentFileShadowed) this.diagnostics.splice(diagnosticStart);
      return;
    }
    if (this.#definitionFiles.has(file.displayPath)) {
      this.indexDefinitions(file);
      return;
    }
    if (lower.endsWith('adjacencies.csv')) {
      this.indexAdjacencies(file);
      return;
    }
    if (lower.endsWith('supply_nodes.txt') || lower.endsWith('railways.txt')) {
      this.indexNetwork(file, lower.endsWith('supply_nodes.txt') ? 'supply_node' : 'railway');
      return;
    }
    if (!/\.(?:txt|gui|gfx)$/u.test(lower)) return;
    // Map position/network tables can be very large but are not Clausewitz
    // assignment sources. Their domain model is built by Agent Nudger.
    if (!file.bytes.includes(0x3d)) return;
    const document = parseClausewitz(file.bytes, file.displayPath);
    const limitDiagnostics = sourcePartialLimitDiagnostics(document.diagnostics);
    if (limitDiagnostics.length > 0) {
      this.recordSkippedSource(file, limitDiagnostics);
      return;
    }
    this.addDiagnostics(document.diagnostics);
    this.walkBlock(document, document.root, file, []);
    if (this.#currentFileShadowed) {
      this.diagnostics.splice(diagnosticStart);
      this.references.splice(referenceStart);
    }
  }

  private walkBlock(
    document: SourceDocument,
    block: BlockNode,
    file: ScannedFile,
    ancestors: string[],
  ): void {
    if (ancestors.length > SOURCE_MAX_NESTING) {
      this.#complete = false;
      const sourceAlreadyBlocked = document.diagnostics.some(
        ({ code }) => code === 'SOURCE_NESTING_LIMIT' || code === 'SOURCE_DIAGNOSTICS_TRUNCATED',
      );
      if (!sourceAlreadyBlocked && !this.#indexNestingBlocked.has(file.displayPath)) {
        this.#indexNestingBlocked.add(file.displayPath);
        this.addDiagnostic({
          code: 'SOURCE_INDEX_NESTING_LIMIT',
          severity: 'blocker',
          category: 'syntax',
          message: `Source index traversal exceeds the supported nesting limit of ${SOURCE_MAX_NESTING}`,
          location: nodeLocation(document, block),
          details: { limit: SOURCE_MAX_NESTING },
        });
      }
      return;
    }
    const sourcePath = file.relativePath.replaceAll('\\', '/').toLowerCase();
    for (const assignment of assignments(block)) {
      const key = assignment.key.value;
      if (assignment.value.type !== 'block') continue;
      const child = assignment.value;
      const id = firstScalar(child, 'id')?.value;
      if (key === 'focus_tree' && id !== undefined) {
        this.addSymbol({
          kind: 'focus_tree',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: {},
        });
      } else if (key === 'continuous_focus_palette' && id !== undefined) {
        this.addSymbol({
          kind: 'continuous_focus_palette',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: {},
        });
      } else if (
        key === 'focus' &&
        id !== undefined &&
        ancestors.at(-1) === 'continuous_focus_palette'
      ) {
        this.addSymbol({
          kind: 'continuous_focus',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: {},
        });
        const icon = firstScalar(child, 'icon');
        if (icon !== undefined)
          this.addReference({
            kind: 'continuous_focus_icon',
            from: id,
            toKind: 'sprite',
            to: icon.value,
            path: file.displayPath,
            location: nodeLocation(document, icon, id),
          });
      } else if (key === 'focus' && id !== undefined && ancestors.at(-1) === 'focus_tree') {
        this.addSymbol({
          kind: 'focus',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: {
            x: numeric(firstScalar(child, 'x')?.value),
            y: numeric(firstScalar(child, 'y')?.value),
          },
        });
        for (const prerequisite of childBlocks(child, 'prerequisite')) {
          for (const target of assignments(prerequisite, 'focus')) {
            if (target.value.type === 'scalar')
              this.addReference({
                kind: 'focus_prerequisite',
                from: id,
                toKind: 'focus',
                to: target.value.value,
                path: file.displayPath,
                location: nodeLocation(document, target, id),
              });
          }
        }
        for (const exclusion of childBlocks(child, 'mutually_exclusive')) {
          for (const target of assignments(exclusion, 'focus')) {
            if (target.value.type === 'scalar')
              this.addReference({
                kind: 'focus_exclusion',
                from: id,
                toKind: 'focus',
                to: target.value.value,
                path: file.displayPath,
                location: nodeLocation(document, target, id),
              });
          }
        }
        const relative = firstScalar(child, 'relative_position_id');
        if (relative !== undefined)
          this.addReference({
            kind: 'focus_relative_position',
            from: id,
            toKind: 'focus',
            to: relative.value,
            path: file.displayPath,
            location: nodeLocation(document, relative, id),
          });
        const icon = firstScalar(child, 'icon');
        if (icon !== undefined)
          this.addReference({
            kind: 'focus_icon',
            from: id,
            toKind: 'sprite',
            to: icon.value,
            path: file.displayPath,
            location: nodeLocation(document, icon, id),
          });
      } else if (
        sourcePath.startsWith('events/') &&
        ancestors.length === 0 &&
        eventBlockKeys.has(key) &&
        id !== undefined
      ) {
        this.addSymbol({
          kind: 'event',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: { eventType: key },
        });
      } else if (sourcePath.startsWith('common/scripted_effects/') && ancestors.length === 0) {
        this.addSymbol({
          kind: 'scripted_effect',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: {},
        });
      } else if (sourcePath.startsWith('common/scripted_triggers/') && ancestors.length === 0) {
        this.addSymbol({
          kind: 'scripted_trigger',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: {},
        });
      } else if (sourcePath.startsWith('common/decisions/') && ancestors.length === 0) {
        this.addSymbol({
          kind: 'decision_category',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: {},
        });
      } else if (
        sourcePath.startsWith('common/decisions/') &&
        !sourcePath.startsWith('common/decisions/categories/') &&
        ancestors.length === 1 &&
        !decisionCategoryFields.has(key)
      ) {
        this.addSymbol({
          kind: 'decision',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: { category: ancestors[0] },
        });
        if (
          /formable|form_country/iu.test(`${sourcePath}:${ancestors[0] ?? ''}`) ||
          /^form_/iu.test(key)
        ) {
          this.addSymbol({
            kind: 'formable',
            id: key,
            path: file.displayPath,
            rootKind: file.rootKind,
            loadOrder: file.loadOrder,
            location: nodeLocation(document, assignment, key),
            metadata: { decision: key },
          });
        }
      } else if (
        sourcePath.startsWith('common/ideas/') &&
        ancestors.length === 2 &&
        ancestors[0] === 'ideas'
      ) {
        this.addSymbol({
          kind: 'idea',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: { category: ancestors[1] },
        });
      } else if (
        sourcePath.startsWith('common/characters/') &&
        ancestors.length === 1 &&
        ancestors[0] === 'characters'
      ) {
        this.addSymbol({
          kind: 'leader',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: {},
        });
      } else if (
        (key === 'spriteType' || key === 'frameAnimatedSpriteType') &&
        firstScalar(child, 'name') !== undefined
      ) {
        const name = firstScalar(child, 'name')!;
        const texture = firstScalar(child, 'texturefile');
        this.addSymbol({
          kind: 'sprite',
          id: name.value,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, name.value),
          metadata: {
            spriteType: key,
            texture: texture?.value,
            frames:
              numeric(firstScalar(child, 'noOfFrames')?.value) ??
              numeric(firstScalar(child, 'noofframes')?.value),
          },
        });
        if (texture !== undefined)
          this.addSymbol({
            kind: 'texture',
            id: texture.value,
            path: file.displayPath,
            rootKind: file.rootKind,
            loadOrder: file.loadOrder,
            location: nodeLocation(document, texture, texture.value),
            metadata: { sprite: name.value },
          });
      } else if (guiElementKeys.has(key) && firstScalar(child, 'name') !== undefined) {
        const name = firstScalar(child, 'name')!;
        this.addSymbol({
          kind: 'gui_element',
          id: name.value,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, name.value),
          metadata: { elementType: key, ancestors },
        });
        const sprite = firstScalar(child, 'spriteType');
        if (sprite !== undefined)
          this.addReference({
            kind: 'gui_sprite',
            from: name.value,
            toKind: 'sprite',
            to: sprite.value,
            path: file.displayPath,
            location: nodeLocation(document, sprite, name.value),
          });
      } else if (ancestors.at(-1) === 'scripted_gui') {
        this.addSymbol({
          kind: 'scripted_gui',
          id: key,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, key),
          metadata: {
            context: firstScalar(child, 'context_type')?.value,
            window: firstScalar(child, 'window_name')?.value,
          },
        });
        const window = firstScalar(child, 'window_name');
        if (window !== undefined)
          this.addReference({
            kind: 'scripted_gui_window',
            from: key,
            toKind: 'gui_element',
            to: window.value,
            path: file.displayPath,
            location: nodeLocation(document, window, key),
          });
      } else if (key === 'state' && id !== undefined) {
        const provinces = childBlocks(child, 'provinces').flatMap(scalars);
        this.addSymbol({
          kind: 'state',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: { provinces, name: firstScalar(child, 'name')?.value },
        });
        for (const province of provinces)
          this.addReference({
            kind: 'state_province',
            from: id,
            toKind: 'province',
            to: province,
            path: file.displayPath,
            location: nodeLocation(document, assignment, id),
          });
      } else if (
        (key === 'strategic_region' || key === 'strategic_region_template') &&
        id !== undefined
      ) {
        const provinces = childBlocks(child, 'provinces').flatMap(scalars);
        this.addSymbol({
          kind: 'strategic_region',
          id,
          path: file.displayPath,
          rootKind: file.rootKind,
          loadOrder: file.loadOrder,
          location: nodeLocation(document, assignment, id),
          metadata: { provinces, name: firstScalar(child, 'name')?.value },
        });
      }
      this.walkBlock(document, child, file, [...ancestors, key]);
    }
  }

  private *tableLines(file: ScannedFile): Generator<{ text: string; line: number }> {
    if (file.bytes.length > SOURCE_MAX_BYTES) {
      this.recordSkippedSource(file, [
        {
          code: 'INDEX_TABLE_FILE_LIMIT',
          severity: 'blocker',
          category: 'reference',
          message: 'Shared-index map table exceeds the fixed parsing-byte limit',
          details: { path: file.displayPath, limit: SOURCE_MAX_BYTES },
        },
      ]);
      return;
    }
    const text = file.bytes.toString('utf8');
    let start = 0;
    let line = 1;
    while (start <= text.length) {
      if (line > INDEX_TABLE_RECORD_LIMIT) {
        this.#complete = false;
        this.addDiagnostic({
          code: 'INDEX_TABLE_RECORD_LIMIT',
          severity: 'blocker',
          category: 'reference',
          message: 'Shared-index map table exceeds the fixed record limit',
          details: { path: file.displayPath, limit: INDEX_TABLE_RECORD_LIMIT },
        });
        return;
      }
      let end = start;
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1;
      yield { text: text.slice(start, end), line };
      if (end >= text.length) return;
      start = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
      line += 1;
    }
  }

  private whitespaceFields(file: ScannedFile, value: string, line: number): string[] | undefined {
    const fields: string[] = [];
    const matcher = /\S+/gu;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(value)) !== null) {
      if (fields.length >= INDEX_TABLE_FIELD_LIMIT) {
        this.#complete = false;
        this.addDiagnostic({
          code: 'INDEX_TABLE_FIELD_LIMIT',
          severity: 'blocker',
          category: 'reference',
          message: 'Shared-index map-table row exceeds the fixed field limit',
          details: { path: file.displayPath, line, limit: INDEX_TABLE_FIELD_LIMIT },
        });
        return undefined;
      }
      fields.push(match[0]);
    }
    return fields;
  }

  private indexDefinitions(file: ScannedFile): void {
    for (const { text, line } of this.tableLines(file)) {
      const parts = splitDelimitedBounded(text, ';', 8);
      if (parts.length < 4 || !/^\d+$/u.test(parts[0]!)) continue;
      const id = parts[0]!;
      const color = `${parts[1]},${parts[2]},${parts[3]}`;
      this.addSymbol({
        kind: 'province',
        id,
        path: file.displayPath,
        rootKind: file.rootKind,
        loadOrder: file.loadOrder,
        metadata: {
          color,
          type: parts[4],
          coastal: parts[5],
          terrain: parts[6],
          continent: parts[7],
          line,
        },
      });
      this.addSymbol({
        kind: 'province_color',
        id: color,
        path: file.displayPath,
        rootKind: file.rootKind,
        loadOrder: file.loadOrder,
        metadata: { provinceId: id, line },
      });
    }
  }

  private indexAdjacencies(file: ScannedFile): void {
    for (const { text, line } of this.tableLines(file)) {
      if (line === 1) continue;
      const parts = splitDelimitedBounded(text, ';', 4);
      if (parts.length < 3 || !/^\d+$/u.test(parts[0]!) || !/^\d+$/u.test(parts[1]!)) continue;
      const id = `${parts[0]}:${parts[1]}:${parts[2]}:${line}`;
      this.addSymbol({
        kind: 'adjacency',
        id,
        path: file.displayPath,
        rootKind: file.rootKind,
        loadOrder: file.loadOrder,
        metadata: {
          from: parts[0],
          to: parts[1],
          type: parts[2],
          through: parts[3],
          line,
        },
      });
    }
  }

  private indexNetwork(file: ScannedFile, kind: 'supply_node' | 'railway'): void {
    for (const { text, line } of this.tableLines(file)) {
      const values = this.whitespaceFields(file, text, line);
      if (values === undefined) continue;
      if (values.length < 2 || values.some((value) => !/^\d+$/u.test(value))) continue;
      this.addSymbol({
        kind,
        id: `${line}:${values.join(':')}`,
        path: file.displayPath,
        rootKind: file.rootKind,
        loadOrder: file.loadOrder,
        metadata: { values, line },
      });
    }
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
      const additiveCategory = active.kind === 'decision_category';
      for (const candidate of group) {
        candidate.overridden = additiveCategory ? candidate.sourceShadowed : candidate !== active;
      }
      const sameLevel = candidates.filter(({ loadOrder }) => loadOrder === active.loadOrder);
      if (!additiveCategory && sameLevel.length > 1) {
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
    for (const reference of this.unresolvedReferences()) {
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
          from: reference.from,
          ...(mayResolveFromSkippedSource ? { skippedSourceCount: this.#skippedSourceCount } : {}),
        },
      });
    }
    const sorted = sortDiagnostics(this.diagnostics);
    this.diagnostics.splice(0, this.diagnostics.length, ...sorted);
  }
}

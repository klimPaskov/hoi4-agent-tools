/**
 * Map references in script: the states, provinces and strategic regions that events, focuses,
 * decisions, scripted helpers, on-actions, ideas, country and unit history, and AI areas name by
 * number. Map edits use this to find references a split, merge, removal or renumbering leaves
 * dangling, and to rewrite them, including in game files the mod overrides.
 */
import { compareCodeUnits } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  nodeLocation,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type ScalarNode,
  type SourceDocument,
  type SourceEntry,
} from '../core/source/index.js';

export type MapReferenceEntity = 'state' | 'province' | 'strategic-region';

/** How a reference names its target. */
export type MapReferenceForm =
  /** `owns_state = 64` */
  | 'field'
  /** `64 = { add_core_of = ROOT }`: a numeric key opens a state scope */
  | 'scope'
  /** `strategic_regions = { 12 13 }` */
  | 'list';

export interface MapScriptReference {
  entity: MapReferenceEntity;
  id: number;
  key: string;
  form: MapReferenceForm;
  file: ScannedFile;
  document: SourceDocument;
  /** The number itself: the scalar value, list item, or scope key. */
  node: ScalarNode;
  /** The enclosing assignment, which a one-to-many remap duplicates. */
  assignment: AssignmentNode;
}

/** Folders whose script names map entities by number. */
export const MAP_REFERENCE_SCRIPT_PATTERNS = [
  'events/**/*.txt',
  'common/national_focus/**/*.txt',
  'common/decisions/**/*.txt',
  'common/scripted_effects/**/*.txt',
  'common/scripted_triggers/**/*.txt',
  'common/on_actions/**/*.txt',
  'common/ideas/**/*.txt',
  'common/characters/**/*.txt',
  'common/ai_strategy/**/*.txt',
  'common/ai_areas/**/*.txt',
  'history/countries/**/*.txt',
  'history/units/**/*.txt',
  'common/country_tags/*.txt',
] as const;

const SCRIPT_FILE =
  /^(?:events|common\/(?:national_focus|decisions|scripted_effects|scripted_triggers|on_actions|ideas|characters|ai_strategy|ai_areas)|history\/(?:countries|units))\/.+\.txt$/iu;

export function mapReferenceScriptFile(relativePath: string): boolean {
  return SCRIPT_FILE.test(relativePath.replaceAll('\\', '/'));
}

const FIELD_KEYS: Record<MapReferenceEntity, ReadonlySet<string>> = {
  state: new Set([
    'state',
    'state_id',
    'start_state',
    'target_state',
    'owns_state',
    'controls_state',
    'transfer_state',
    'transfer_state_to',
    'add_state_core',
    'add_state_claim',
    'remove_state_core',
    'remove_state_claim',
  ]),
  province: new Set([
    'province',
    'province_id',
    'start_province',
    'target_province',
    'controls_province',
  ]),
  'strategic-region': new Set(['strategic_region', 'strategic_region_id']),
};

/** Keys whose meaning depends on the folder they appear in. */
function folderFieldEntity(relativePath: string, key: string): MapReferenceEntity | undefined {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  if (normalized.startsWith('history/countries/') && key === 'capital') return 'state';
  if (normalized.startsWith('history/units/') && (key === 'location' || key === 'base'))
    return 'province';
  return undefined;
}

function fieldEntity(relativePath: string, key: string): MapReferenceEntity | undefined {
  const byFolder = folderFieldEntity(relativePath, key);
  if (byFolder !== undefined) return byFolder;
  for (const [entity, keys] of Object.entries(FIELD_KEYS) as Array<
    [MapReferenceEntity, ReadonlySet<string>]
  >)
    if (keys.has(key)) return entity;
  return undefined;
}

/** Blocks whose numeric keys are weights, not state scopes. */
const WEIGHTED_BLOCKS = new Set(['random_list', 'random_events', 'random']);

const NUMBER = /^\d+$/u;

export interface CollectedMapReferences {
  references: MapScriptReference[];
  /** Script files whose syntax errors make their references uncertain. */
  unparsable: Array<{ file: ScannedFile; diagnostics: Diagnostic[] }>;
}

/** Collect every numbered map reference in the active (unshadowed) script files given. */
export function collectMapScriptReferences(files: readonly ScannedFile[]): CollectedMapReferences {
  const references: MapScriptReference[] = [];
  const unparsable: CollectedMapReferences['unparsable'] = [];
  const active = files
    .filter((file) => file.shadowedBy === undefined && mapReferenceScriptFile(file.relativePath))
    .sort(
      (left, right) =>
        left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
    );
  for (const file of active) {
    const document = parseClausewitz(file.bytes, file.displayPath);
    if (document.diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'))
      unparsable.push({ file, diagnostics: document.diagnostics });
    const aiAreas = file.relativePath
      .replaceAll('\\', '/')
      .toLowerCase()
      .startsWith('common/ai_areas/');
    const visit = (entry: SourceEntry, weighted: boolean): void => {
      if (entry.type === 'block') {
        for (const child of entry.entries) visit(child, weighted);
        return;
      }
      if (entry.type !== 'assignment') return;
      const key = entry.key.value;
      if (entry.value.type === 'block') {
        if (!weighted && NUMBER.test(key) && !aiAreas)
          references.push({
            entity: 'state',
            id: Number(key),
            key,
            form: 'scope',
            file,
            document,
            node: entry.key,
            assignment: entry,
          });
        if (aiAreas && key === 'strategic_regions')
          for (const item of entry.value.entries)
            if (item.type === 'scalar' && NUMBER.test(item.value))
              references.push({
                entity: 'strategic-region',
                id: Number(item.value),
                key,
                form: 'list',
                file,
                document,
                node: item,
                assignment: entry,
              });
        const childWeighted = WEIGHTED_BLOCKS.has(key);
        for (const child of entry.value.entries) visit(child, childWeighted);
        return;
      }
      if (!NUMBER.test(entry.value.value)) return;
      const entity = fieldEntity(file.relativePath, key);
      if (entity === undefined) return;
      references.push({
        entity,
        id: Number(entry.value.value),
        key,
        form: 'field',
        file,
        document,
        node: entry.value,
        assignment: entry,
      });
    };
    visit(document.root, false);
  }
  return { references, unparsable };
}

/** References that name an entity the map does not define. */
export function missingMapReferenceDiagnostics(
  references: readonly MapScriptReference[],
  exists: Record<MapReferenceEntity, (id: number) => boolean>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const reference of references) {
    if (exists[reference.entity](reference.id)) continue;
    const owned = reference.file.rootKind === 'mod' || reference.file.rootKind === 'fixture';
    diagnostics.push({
      code: 'MAP_SCRIPT_REFERENCE_MISSING',
      severity: owned ? 'error' : 'warning',
      category: 'map',
      message: `${reference.file.relativePath} names ${reference.entity} ${reference.id} (${reference.key}), which the map does not define; remap it with map_rewrite remap_map_references`,
      location: nodeLocation(reference.document, reference.node),
      details: {
        entity: reference.entity,
        id: reference.id,
        key: reference.key,
        form: reference.form,
        layer: reference.file.rootKind,
      },
    });
  }
  return diagnostics;
}

/** The block that directly contains an assignment, for duplication and removal. */
export function containingBlock(root: BlockNode, target: AssignmentNode): BlockNode | undefined {
  const search = (block: BlockNode): BlockNode | undefined => {
    for (const entry of block.entries) {
      if (entry === target) return block;
      const child =
        entry.type === 'block'
          ? entry
          : entry.type === 'assignment' && entry.value.type === 'block'
            ? entry.value
            : undefined;
      if (child !== undefined) {
        const found = search(child);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return search(root);
}

export interface ReferenceRemapRequest {
  entity: MapReferenceEntity;
  /** `to` null removes the reference's assignment; a list duplicates it once per target. */
  mapping: ReadonlyArray<{ from: number; to: number | readonly number[] | null }>;
  /** Game and dependency files cannot be edited; override copies them into the mod. */
  readOnlySources: 'refuse' | 'override';
  pathPrefixes?: readonly string[];
}

export interface ReferenceRemapPlan {
  files: Array<{ relativePath: string; content: Buffer; overridesReadOnly: boolean }>;
  rewritten: number;
  duplicated: number;
  removed: number;
}

export interface ReplacementLike {
  start: number;
  end: number;
  text: string;
  description: string;
}

export class ReferenceRemapError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

function indentBefore(text: string, offset: number): string {
  const lineStart =
    Math.max(
      text.lastIndexOf('\n', Math.max(0, offset - 1)),
      text.lastIndexOf('\r', Math.max(0, offset - 1)),
    ) + 1;
  return /^[\t ]*/u.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

function within(
  node: { start: number; end: number },
  range: { start: number; end: number },
): boolean {
  return node.start >= range.start && node.end <= range.end;
}

/**
 * Rewrite the references of one entity kind after a map change. Each mapped number is replaced;
 * a reference mapped to several targets keeps its first target and gains a copy of its whole
 * assignment for each further target (so `64 = { add_core_of = ROOT }` becomes one block per
 * successor state); a reference mapped to null loses its assignment.
 */
export function planReferenceRemap(
  files: readonly ScannedFile[],
  request: ReferenceRemapRequest,
  replace: (document: SourceDocument, replacements: ReplacementLike[]) => Buffer,
): ReferenceRemapPlan {
  const mapping = new Map<number, number[] | null>();
  for (const { from, to } of request.mapping)
    mapping.set(from, to === null ? null : typeof to === 'number' ? [to] : [...to]);
  const prefixes = (request.pathPrefixes ?? []).map((prefix) =>
    prefix.replaceAll('\\', '/').toLowerCase(),
  );
  // Parse only the scripts that mention a mapped number at all; a large mod has thousands.
  const numbers = new RegExp(`(?<![\\w.])(?:${[...mapping.keys()].join('|')})(?![\\w.])`, 'u');
  const candidates = files.filter(
    (file) =>
      mapReferenceScriptFile(file.relativePath) && numbers.test(file.bytes.toString('latin1')),
  );
  const { references, unparsable } = collectMapScriptReferences(candidates);
  const selected = references.filter(
    (reference) =>
      reference.entity === request.entity &&
      mapping.has(reference.id) &&
      (prefixes.length === 0 ||
        prefixes.some((prefix) =>
          reference.file.relativePath.replaceAll('\\', '/').toLowerCase().startsWith(prefix),
        )),
  );
  const blocked = unparsable.filter(({ file }) =>
    selected.some((reference) => reference.file === file),
  );
  if (blocked.length > 0)
    throw new ReferenceRemapError(
      'MAP_EXTERNAL_SCRIPT_PARSE_BLOCKED',
      'A script with map references has syntax errors; fix them before remapping',
      { files: blocked.slice(0, 20).map(({ file }) => file.relativePath) },
    );
  const readOnly = [
    ...new Set(
      selected
        .filter(({ file }) => file.rootKind !== 'mod' && file.rootKind !== 'fixture')
        .map(({ file }) => file.relativePath),
    ),
  ].sort(compareCodeUnits);
  if (readOnly.length > 0 && request.readOnlySources !== 'override')
    throw new ReferenceRemapError(
      'MAP_EXTERNAL_REFERENCE_READ_ONLY',
      `${readOnly.length} game or dependency file(s) reference the remapped ${request.entity}s; set readOnlySources to override to copy them into the mod with the references changed`,
      { files: readOnly.slice(0, 20), total: readOnly.length },
    );
  const byFile = new Map<ScannedFile, MapScriptReference[]>();
  for (const reference of selected) {
    const list = byFile.get(reference.file) ?? [];
    list.push(reference);
    byFile.set(reference.file, list);
  }
  const plan: ReferenceRemapPlan = { files: [], rewritten: 0, duplicated: 0, removed: 0 };
  for (const [file, fileReferences] of [...byFile].sort(([left], [right]) =>
    compareCodeUnits(left.relativePath, right.relativePath),
  )) {
    const document = fileReferences[0]!.document;
    const text = document.text;
    const removedRanges = fileReferences
      .filter(({ id }) => mapping.get(id) === null)
      .map(({ assignment }) => assignment);
    const duplicating = fileReferences.filter(({ id }) => (mapping.get(id)?.length ?? 0) > 1);
    for (const outer of duplicating)
      for (const inner of duplicating)
        if (inner.assignment !== outer.assignment && within(inner.assignment, outer.assignment))
          throw new ReferenceRemapError(
            'MAP_REFERENCE_REMAP_NESTED',
            'A reference mapped to several targets lies inside another one; remap them in two operations',
            { relativePath: file.relativePath, outer: outer.id, inner: inner.id },
          );
    // Point substitutions to each reference's first target, outside removed assignments.
    const points = fileReferences.filter(
      (reference) =>
        mapping.get(reference.id) !== null &&
        !removedRanges.some((range) => within(reference.node, range)),
    );
    const replacements: ReplacementLike[] = points.map((reference) => ({
      start: reference.node.start,
      end: reference.node.end,
      text: String(mapping.get(reference.id)![0]),
      description: `Remap ${reference.entity} ${reference.id}`,
    }));
    plan.rewritten += points.length;
    // Removal of whole assignments; a nested removal is covered by the outermost one.
    for (const range of removedRanges) {
      if (removedRanges.some((other) => other !== range && within(range, other))) continue;
      replacements.push({
        start: range.start,
        end: range.end,
        text: '',
        description: 'Remove a reference to a removed map entity',
      });
      plan.removed += 1;
    }
    // Copies for further targets: the assignment's own text with every point substitution
    // inside it applied, and this reference set to the extra target.
    for (const reference of duplicating) {
      const { assignment } = reference;
      const targets = mapping.get(reference.id)!;
      const innerPoints = points.filter(
        (point) => point !== reference && within(point.node, assignment),
      );
      for (const target of targets.slice(1)) {
        const substitutions = [
          ...innerPoints.map((point) => ({
            node: point.node,
            text: String(mapping.get(point.id)![0]),
          })),
          { node: reference.node, text: String(target) },
        ].sort((left, right) => left.node.start - right.node.start);
        const pieces: string[] = [];
        let cursor = assignment.start;
        for (const substitution of substitutions) {
          pieces.push(text.slice(cursor, substitution.node.start), substitution.text);
          cursor = substitution.node.end;
        }
        pieces.push(text.slice(cursor, assignment.end));
        replacements.push({
          start: assignment.end,
          end: assignment.end,
          text: `${document.newline}${indentBefore(text, assignment.start)}${pieces.join('')}`,
          description: `Copy the ${reference.entity} reference for ${target}`,
        });
        plan.duplicated += 1;
      }
    }
    plan.files.push({
      relativePath: file.relativePath,
      content: replace(document, replacements),
      overridesReadOnly: file.rootKind !== 'mod' && file.rootKind !== 'fixture',
    });
  }
  return plan;
}

/** Country tags declared in `common/country_tags`, or undefined when none were scanned. */
export function declaredCountryTags(files: readonly ScannedFile[]): Set<string> | undefined {
  const tagFiles = files.filter(
    (file) =>
      file.shadowedBy === undefined &&
      /^common\/country_tags\/[^/]+\.txt$/iu.test(file.relativePath.replaceAll('\\', '/')),
  );
  if (tagFiles.length === 0) return undefined;
  const tags = new Set<string>();
  for (const file of tagFiles) {
    const document = parseClausewitz(file.bytes, file.displayPath);
    for (const entry of document.root.entries)
      if (entry.type === 'assignment' && /^[A-Z0-9]{3}$/u.test(entry.key.value))
        tags.add(entry.key.value);
  }
  return tags;
}

export interface MapConsistencyIndex {
  sourceFiles: readonly ScannedFile[];
  states: ReadonlyArray<{
    id: number;
    owner?: string;
    controller?: string;
    cores: readonly string[];
    claims: readonly string[];
    file: ScannedFile;
  }>;
  statesById: ReadonlyMap<number, { owner?: string }>;
  definitionsById: ReadonlyMap<number, unknown>;
  regionsById: ReadonlyMap<number, unknown>;
}

/**
 * Checks that need the scripts around the map: references to states, provinces and regions that
 * do not exist, state owners, controllers, cores and claims with undeclared tags, and country
 * capitals in states the country does not own.
 */
export function mapScriptConsistency(index: MapConsistencyIndex): {
  diagnostics: Diagnostic[];
  references: number;
  missing: number;
} {
  const { references } = collectMapScriptReferences(index.sourceFiles);
  const diagnostics = missingMapReferenceDiagnostics(references, {
    state: (id) => index.statesById.has(id),
    province: (id) => index.definitionsById.has(id),
    'strategic-region': (id) => index.regionsById.has(id),
  });
  const missing = diagnostics.length;
  const tags = declaredCountryTags(index.sourceFiles);
  if (tags !== undefined)
    for (const state of index.states) {
      const used = [
        ...(state.owner === undefined ? [] : [['owner', state.owner] as const]),
        ...(state.controller === undefined ? [] : [['controller', state.controller] as const]),
        ...state.cores.map((tag) => ['core', tag] as const),
        ...state.claims.map((tag) => ['claim', tag] as const),
      ];
      for (const [role, tag] of used)
        if (!tags.has(tag))
          diagnostics.push({
            code: 'MAP_STATE_TAG_UNKNOWN',
            severity: 'error',
            category: 'map',
            message: `State ${state.id} names ${tag} as its ${role}, but no common/country_tags file declares ${tag}`,
            location: {
              path: state.file.displayPath,
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            details: { stateId: state.id, tag, role },
          });
    }
  // Releasable countries keep capitals in states they do not own; only countries that start
  // with land must own their capital.
  const owners = new Set(index.states.flatMap(({ owner }) => (owner === undefined ? [] : [owner])));
  for (const reference of references) {
    if (reference.form !== 'field' || reference.key !== 'capital') continue;
    const tag = /^([A-Z0-9]{3})\b/u.exec(
      reference.file.relativePath.replaceAll('\\', '/').split('/').at(-1) ?? '',
    )?.[1];
    const owner = index.statesById.get(reference.id)?.owner;
    if (tag === undefined || owner === undefined || owner === tag || !owners.has(tag)) continue;
    diagnostics.push({
      code: 'MAP_COUNTRY_CAPITAL_NOT_OWNED',
      severity: 'warning',
      category: 'map',
      message: `${tag} has its capital in state ${reference.id}, which ${owner} owns at the start`,
      location: nodeLocation(reference.document, reference.node),
      details: { tag, stateId: reference.id, owner },
    });
  }
  return { diagnostics, references: references.length, missing };
}

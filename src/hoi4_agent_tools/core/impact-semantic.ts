import { compareCodeUnits } from './canonical.js';
import type { SourceLocation } from './diagnostics.js';
import type { ScanSnapshot } from './engine.js';
import type { ReferenceRecord, SymbolKind } from './index.js';
import type { ScannedFile } from './scanner.js';
import {
  assignments,
  firstScalar,
  nodeLocation,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
} from './source/index.js';

export interface ImpactSemanticResult {
  references: ReferenceRecord[];
  unresolved: Array<{ path: string; location?: SourceLocation; reason: string }>;
  scannedFiles: number;
  complete: boolean;
}

interface Owner {
  kind: SymbolKind;
  id: string;
}

const eventKeys = new Set([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

const scalarTargets = new Map<string, SymbolKind>([
  ['activate_decision', 'decision'],
  ['remove_decision', 'decision'],
  ['complete_decision', 'decision'],
  ['add_ideas', 'idea'],
  ['remove_ideas', 'idea'],
  ['has_idea', 'idea'],
  ['has_completed_focus', 'focus'],
  ['load_focus_tree', 'focus_tree'],
  ['has_tech', 'technology'],
  ['country_event', 'event'],
  ['news_event', 'event'],
  ['state_event', 'event'],
]);

const stateKeyOperations = new Map<
  string,
  { kind: 'variable' | 'flag' | 'event_target'; role: 'read' | 'write'; scope?: string }
>([
  ['set_variable', { kind: 'variable', role: 'write' }],
  ['add_to_variable', { kind: 'variable', role: 'write' }],
  ['subtract_from_variable', { kind: 'variable', role: 'write' }],
  ['multiply_variable', { kind: 'variable', role: 'write' }],
  ['divide_variable', { kind: 'variable', role: 'write' }],
  ['check_variable', { kind: 'variable', role: 'read' }],
  ['has_variable', { kind: 'variable', role: 'read' }],
  ['set_country_flag', { kind: 'flag', role: 'write', scope: 'country' }],
  ['clr_country_flag', { kind: 'flag', role: 'write', scope: 'country' }],
  ['has_country_flag', { kind: 'flag', role: 'read', scope: 'country' }],
  ['set_state_flag', { kind: 'flag', role: 'write', scope: 'state' }],
  ['clr_state_flag', { kind: 'flag', role: 'write', scope: 'state' }],
  ['has_state_flag', { kind: 'flag', role: 'read', scope: 'state' }],
  ['set_global_flag', { kind: 'flag', role: 'write', scope: 'global' }],
  ['clr_global_flag', { kind: 'flag', role: 'write', scope: 'global' }],
  ['has_global_flag', { kind: 'flag', role: 'read', scope: 'global' }],
  ['save_event_target_as', { kind: 'event_target', role: 'write' }],
  ['save_global_event_target_as', { kind: 'event_target', role: 'write' }],
  ['clear_global_event_target', { kind: 'event_target', role: 'write' }],
  ['has_event_target', { kind: 'event_target', role: 'read' }],
]);

function stateKeyTarget(assignment: AssignmentNode, kind: SymbolKind): string | undefined {
  if (assignment.value.type === 'scalar') return assignment.value.value;
  if (kind !== 'variable') return undefined;
  const explicit = firstScalar(assignment.value, 'var');
  if (explicit !== undefined) return explicit.value;
  return assignments(assignment.value).find(
    ({ key }) => !['compare', 'value', 'tooltip', 'var', 'value_name'].includes(key.value),
  )?.key.value;
}

function normalized(file: ScannedFile): string {
  return file.relativePath.replaceAll('\\', '/').toLowerCase();
}

function ownerFor(
  snapshot: ScanSnapshot,
  file: ScannedFile,
  assignment: AssignmentNode,
  ancestors: readonly string[],
): Owner | undefined {
  if (assignment.value.type !== 'block') return undefined;
  const key = assignment.key.value;
  const sourcePath = normalized(file);
  let owner: Owner | undefined;
  if (sourcePath.startsWith('events/') && ancestors.length === 0 && eventKeys.has(key)) {
    const id = firstScalar(assignment.value, 'id')?.value;
    if (id !== undefined) owner = { kind: 'event', id };
  } else if (key === 'focus') {
    const id = firstScalar(assignment.value, 'id')?.value;
    if (id !== undefined)
      owner = {
        kind: ancestors.includes('continuous_focus_palette') ? 'continuous_focus' : 'focus',
        id,
      };
  } else if (
    sourcePath.startsWith('common/decisions/') &&
    !sourcePath.startsWith('common/decisions/categories/') &&
    ancestors.length === 1
  ) {
    owner = { kind: 'decision', id: key };
  } else if (sourcePath.startsWith('common/decisions/categories/') && ancestors.length === 0) {
    owner = { kind: 'decision_category', id: key };
  } else if (
    sourcePath.startsWith('common/ideas/') &&
    ancestors.length === 2 &&
    ancestors[0] === 'ideas'
  ) {
    owner = { kind: 'idea', id: key };
  } else if (
    sourcePath.startsWith('common/technologies/') &&
    ancestors.length === 1 &&
    ancestors[0] === 'technologies'
  ) {
    owner = { kind: 'technology', id: key };
  } else if (sourcePath.startsWith('common/scripted_effects/') && ancestors.length === 0) {
    owner = { kind: 'scripted_effect', id: key };
  } else if (sourcePath.startsWith('common/scripted_triggers/') && ancestors.length === 0) {
    owner = { kind: 'scripted_trigger', id: key };
  } else if (
    sourcePath.startsWith('common/scripted_guis/') &&
    ancestors.length === 1 &&
    ancestors[0] === 'scripted_gui'
  ) {
    owner = { kind: 'scripted_gui', id: key };
  }
  return owner === undefined || snapshot.index.find(owner.kind, owner.id)?.path !== file.displayPath
    ? undefined
    : owner;
}

function staticTarget(value: string): boolean {
  return (
    /^[A-Za-z0-9_.:-]+$/u.test(value) &&
    !/^(?:event_target|scope|var|constant):/iu.test(value) &&
    !/^(?:ROOT|FROM|PREV|THIS)$/iu.test(value)
  );
}

/** Extracts typed script edges while preserving unknown dynamic references. */
export function scanImpactSemanticReferences(
  snapshot: ScanSnapshot,
  maxReferences = 200_000,
): ImpactSemanticResult {
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 1_000_000)
    throw new RangeError('Semantic reference limit is outside the supported range');
  const references: ReferenceRecord[] = [];
  const unresolved: ImpactSemanticResult['unresolved'] = [];
  let scannedFiles = 0;
  let complete = true;
  const emit = (
    file: ScannedFile,
    document: SourceDocument,
    node: AssignmentNode,
    owner: Owner,
    toKind: SymbolKind,
    target: string,
    referenceKind: string,
  ): void => {
    if (!staticTarget(target)) {
      if (unresolved.length < maxReferences)
        unresolved.push({
          path: file.displayPath,
          location: nodeLocation(document, node, owner.id),
          reason: `Dynamic ${referenceKind} target ${target} cannot be resolved statically`,
        });
      else complete = false;
      return;
    }
    if (references.length >= maxReferences) {
      complete = false;
      return;
    }
    references.push({
      kind: referenceKind,
      from: owner.id,
      toKind,
      to: target,
      path: file.displayPath,
      location: nodeLocation(document, node, owner.id),
    });
  };
  const walk = (
    file: ScannedFile,
    document: SourceDocument,
    block: BlockNode,
    ancestors: readonly string[],
    owner?: Owner,
  ): void => {
    for (const assignment of assignments(block)) {
      const identified = ownerFor(snapshot, file, assignment, ancestors);
      const current = identified ?? owner;
      if (identified?.kind === 'decision' && ancestors.length === 1)
        emit(
          file,
          document,
          assignment,
          identified,
          'decision_category',
          ancestors[0]!,
          'decision_category_membership',
        );
      if (current !== undefined && identified === undefined) {
        const key = assignment.key.value;
        if (assignment.value.type === 'scalar') {
          const value = assignment.value.value;
          const localisation =
            (current.kind === 'event' &&
              (key === 'title' ||
                key === 'desc' ||
                (key === 'name' && ancestors.includes('option')) ||
                (key === 'text' && ancestors.includes('desc')))) ||
            key === 'custom_effect_tooltip';
          if (localisation)
            emit(file, document, assignment, current, 'localisation', value, 'localisation_key');
          if (
            (key === 'picture' ||
              (key === 'icon' && ['decision', 'decision_category'].includes(current.kind))) &&
            value.startsWith('GFX_')
          )
            emit(file, document, assignment, current, 'sprite', value, 'display_sprite');
          if (key === 'scripted_gui' && ['decision', 'decision_category'].includes(current.kind))
            emit(
              file,
              document,
              assignment,
              current,
              'scripted_gui',
              value,
              'scripted_gui_binding',
            );
          if (current.kind === 'scripted_gui' && key === 'parent_window_window')
            emit(file, document, assignment, current, 'gui_element', value, key);
          if (current.kind === 'scripted_gui' && key === 'parent_scripted_gui')
            emit(file, document, assignment, current, 'scripted_gui', value, key);
        }
        if (key.startsWith('event_target:'))
          emit(
            file,
            document,
            assignment,
            current,
            'event_target',
            key.slice('event_target:'.length),
            'event_target_read',
          );
        const stateOperation = stateKeyOperations.get(key);
        if (stateOperation !== undefined) {
          const target = stateKeyTarget(assignment, stateOperation.kind);
          if (target === undefined) {
            if (unresolved.length < maxReferences)
              unresolved.push({
                path: file.displayPath,
                location: nodeLocation(document, assignment, current.id),
                reason: `Cannot identify ${key} state key`,
              });
            else complete = false;
          } else
            emit(
              file,
              document,
              assignment,
              current,
              stateOperation.kind,
              stateOperation.scope === undefined ? target : `${stateOperation.scope}:${target}`,
              `${stateOperation.kind}_${stateOperation.role}`,
            );
        }
        const targetKind = scalarTargets.get(key);
        if (key === 'set_technology' && assignment.value.type === 'block')
          for (const technology of assignments(assignment.value))
            if (technology.key.value !== 'popup')
              emit(
                file,
                document,
                technology,
                current,
                'technology',
                technology.key.value,
                'set_technology',
              );
        if (targetKind !== undefined) {
          if (assignment.value.type === 'scalar') {
            emit(file, document, assignment, current, targetKind, assignment.value.value, key);
          } else {
            const id =
              firstScalar(assignment.value, 'id') ?? firstScalar(assignment.value, 'decision');
            if (id !== undefined)
              emit(file, document, assignment, current, targetKind, id.value, key);
            else
              for (const entry of assignment.value.entries)
                if (entry.type === 'scalar')
                  emit(file, document, assignment, current, targetKind, entry.value, key);
          }
        }
        const helperKind =
          snapshot.index.find('scripted_effect', key) !== undefined
            ? 'scripted_effect'
            : snapshot.index.find('scripted_trigger', key) !== undefined
              ? 'scripted_trigger'
              : undefined;
        if (helperKind !== undefined)
          emit(file, document, assignment, current, helperKind, key, 'scripted_helper_call');
      }
      if (assignment.value.type === 'block')
        walk(file, document, assignment.value, [...ancestors, assignment.key.value], current);
    }
  };
  for (const file of snapshot.files) {
    if (file.shadowedBy !== undefined) continue;
    const path = normalized(file);
    if (
      !path.endsWith('.txt') ||
      !(
        path.startsWith('events/') ||
        path.startsWith('common/national_focus/') ||
        path.startsWith('common/continuous_focus/') ||
        path.startsWith('common/decisions/') ||
        path.startsWith('common/ideas/') ||
        path.startsWith('common/technologies/') ||
        path.startsWith('common/scripted_effects/') ||
        path.startsWith('common/scripted_triggers/') ||
        path.startsWith('common/scripted_guis/')
      )
    )
      continue;
    if (snapshot.index.isSourceSkipped(file.displayPath)) {
      complete = false;
      continue;
    }
    scannedFiles += 1;
    const document = parseClausewitz(file.bytes, file.displayPath);
    walk(file, document, document.root, []);
  }
  references.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.from, right.from) ||
      compareCodeUnits(left.toKind, right.toKind) ||
      compareCodeUnits(left.to, right.to) ||
      compareCodeUnits(left.kind, right.kind),
  );
  return { references, unresolved, scannedFiles, complete };
}

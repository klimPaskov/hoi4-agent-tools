import { ServiceError } from '../core/result.js';
import {
  assignments,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
} from '../core/source/index.js';
import type { SourceReplacement } from '../core/source/rewrite.js';
import { guiElementAttributeFidelity } from './source-graph.js';

export interface GuardedGuiSourceReplacement extends SourceReplacement {
  expectedText: string;
}

const coordinateFields = new Set(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']);

function editableScalarField(key: string): boolean {
  return (
    coordinateFields.has(key.toLowerCase()) ||
    ['modelled', 'ignored'].includes(guiElementAttributeFidelity(key))
  );
}

function allAssignments(block: BlockNode): AssignmentNode[] {
  return assignments(block).flatMap((assignment) => [
    assignment,
    ...(assignment.value.type === 'block' ? allAssignments(assignment.value) : []),
  ]);
}

function allBlocks(block: BlockNode): BlockNode[] {
  return [
    block,
    ...assignments(block).flatMap((assignment) =>
      assignment.value.type === 'block' ? allBlocks(assignment.value) : [],
    ),
  ];
}

function parseReplacementAssignment(key: string, text: string): AssignmentNode | undefined {
  if (text.trim().length === 0) return undefined;
  const parsed = parseClausewitz(Buffer.from(`__guard = {\n${text}\n}\n`), 'memory:gui-patch');
  if (parsed.diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'))
    return undefined;
  const wrapper = assignments(parsed.root)[0];
  if (wrapper?.key.value !== '__guard' || wrapper.value.type !== 'block') return undefined;
  const entries = assignments(wrapper.value);
  if (entries.length !== 1 || wrapper.value.entries.length !== 1) return undefined;
  const replacement = entries[0];
  return replacement?.key.value.toLowerCase() === key.toLowerCase() ? replacement : undefined;
}

function validScalarValue(key: string, text: string): boolean {
  const replacement = parseReplacementAssignment(key, `${key} = ${text}`);
  return replacement?.value.type === 'scalar';
}

function validAssignmentReplacement(assignment: AssignmentNode, text: string): boolean {
  if (text.trim().length === 0) return true;
  const replacement = parseReplacementAssignment(assignment.key.value, text);
  return replacement?.value.type === 'scalar';
}

function validInsertion(text: string): boolean {
  if (text.trim().length === 0) return false;
  const parsed = parseClausewitz(Buffer.from(`__guard = {\n${text}\n}\n`), 'memory:gui-insert');
  if (parsed.diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'))
    return false;
  const wrapper = assignments(parsed.root)[0];
  return (
    wrapper?.key.value === '__guard' &&
    wrapper.value.type === 'block' &&
    wrapper.value.entries.length > 0 &&
    assignments(wrapper.value).length === wrapper.value.entries.length
  );
}

/**
 * Restrict existing-file GUI patches to scalar assignments/values or a
 * syntactically complete insertion immediately before a parsed block close.
 * This prevents a caller from presenting an entire file as a "targeted" patch
 * while retaining a useful targeted editing surface.
 */
export function assertGuiSourcePatchesSafe(
  document: SourceDocument,
  patches: readonly GuardedGuiSourceReplacement[],
): void {
  const sourceAssignments = allAssignments(document.root);
  const insertionOffsets = new Set(
    allBlocks(document.root)
      .filter((block) => block !== document.root)
      .flatMap(({ close }) => (close === undefined ? [] : [close.start])),
  );
  for (const patch of patches) {
    if (patch.start === 0 && patch.end === document.text.length)
      throw new ServiceError(
        'GUI_UNSAFE_PATCH_RANGE',
        'A targeted GUI patch cannot replace the complete source file',
      );
    if (patch.start === patch.end) {
      if (insertionOffsets.has(patch.start) && validInsertion(patch.text)) continue;
      throw new ServiceError(
        'GUI_UNSAFE_PATCH_RANGE',
        'GUI insertions must contain valid Clausewitz entries at a parsed block close',
        { start: patch.start },
      );
    }
    const exactAssignment = sourceAssignments.find(
      ({ start, end }) => start === patch.start && end === patch.end,
    );
    if (
      exactAssignment?.value.type === 'scalar' &&
      editableScalarField(exactAssignment.key.value) &&
      validAssignmentReplacement(exactAssignment, patch.text)
    )
      continue;
    const scalarOwner = sourceAssignments.find(
      ({ value }) =>
        value.type === 'scalar' && value.start === patch.start && value.end === patch.end,
    );
    if (
      scalarOwner !== undefined &&
      editableScalarField(scalarOwner.key.value) &&
      validScalarValue(scalarOwner.key.value, patch.text)
    )
      continue;
    throw new ServiceError(
      'GUI_UNSAFE_PATCH_RANGE',
      'GUI patches may change one known scalar assignment/value or insert complete entries at a parsed block close',
      { start: patch.start, end: patch.end },
    );
  }
}

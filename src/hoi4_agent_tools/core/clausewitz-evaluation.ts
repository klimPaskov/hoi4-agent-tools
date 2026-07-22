import { compareCodeUnits } from './canonical.js';
import type { ScanSnapshot } from './engine.js';
import type { ScannedFile } from './scanner.js';
import {
  assignments,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
} from './source/index.js';

const definitionCache = new WeakMap<ScanSnapshot, ClausewitzEvaluationDefinitions>();

export interface ClausewitzDefinition<T> {
  id: string;
  value: T;
  node: AssignmentNode | BlockNode;
  file: ScannedFile;
  document: SourceDocument;
}

function activeTextFiles(snapshot: ScanSnapshot, prefix: string): ScannedFile[] {
  return snapshot.files
    .filter(
      ({ relativePath, shadowedBy }) =>
        shadowedBy === undefined &&
        relativePath.replaceAll('\\', '/').toLowerCase().startsWith(prefix) &&
        relativePath.toLowerCase().endsWith('.txt'),
    )
    .sort(
      (left, right) =>
        left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
    );
}

function scalarAssignments(block: BlockNode): AssignmentNode[] {
  return assignments(block).filter(({ value }) => value.type === 'scalar');
}

function flattenConstants(
  block: BlockNode,
  prefix: string,
  output: Map<string, ClausewitzDefinition<string>>,
  file: ScannedFile,
  document: SourceDocument,
): void {
  for (const assignment of assignments(block)) {
    if (assignment.key.value === 'schema') continue;
    const id = prefix === '' ? assignment.key.value : `${prefix}.${assignment.key.value}`;
    if (assignment.value.type === 'scalar') {
      output.set(id, { id, value: assignment.value.value, node: assignment, file, document });
    } else {
      flattenConstants(assignment.value, id, output, file, document);
    }
  }
}

/** Shared, source-linked definitions used by analysis domains. */
export class ClausewitzEvaluationDefinitions {
  public readonly scriptConstants = new Map<string, ClausewitzDefinition<string>>();
  public readonly mtthVariables = new Map<string, ClausewitzDefinition<BlockNode>>();
  public readonly scriptedTriggers = new Map<string, ClausewitzDefinition<BlockNode>>();
  public readonly localConstants = new Map<string, Map<string, ClausewitzDefinition<string>>>();

  public static build(snapshot: ScanSnapshot): ClausewitzEvaluationDefinitions {
    const cached = definitionCache.get(snapshot);
    if (cached !== undefined) return cached;
    const result = new ClausewitzEvaluationDefinitions();
    for (const file of snapshot.files.filter(
      ({ shadowedBy, relativePath }) =>
        shadowedBy === undefined && relativePath.toLowerCase().endsWith('.txt'),
    )) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      const locals = new Map<string, ClausewitzDefinition<string>>();
      for (const assignment of scalarAssignments(document.root)) {
        if (!assignment.key.value.startsWith('@') || assignment.value.type !== 'scalar') continue;
        locals.set(assignment.key.value, {
          id: assignment.key.value,
          value: assignment.value.value,
          node: assignment,
          file,
          document,
        });
      }
      if (locals.size > 0) result.localConstants.set(file.displayPath, locals);
    }
    for (const file of activeTextFiles(snapshot, 'common/script_constants/')) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      flattenConstants(document.root, '', result.scriptConstants, file, document);
    }
    for (const file of activeTextFiles(snapshot, 'common/mtth/')) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      for (const assignment of assignments(document.root)) {
        if (assignment.value.type !== 'block' || assignment.key.value.startsWith('@')) continue;
        result.mtthVariables.set(assignment.key.value, {
          id: assignment.key.value,
          value: assignment.value,
          node: assignment,
          file,
          document,
        });
      }
    }
    for (const file of activeTextFiles(snapshot, 'common/scripted_triggers/')) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      for (const assignment of assignments(document.root)) {
        if (assignment.value.type !== 'block') continue;
        result.scriptedTriggers.set(assignment.key.value, {
          id: assignment.key.value,
          value: assignment.value,
          node: assignment,
          file,
          document,
        });
      }
    }
    definitionCache.set(snapshot, result);
    return result;
  }
}

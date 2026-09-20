import { compareCodeUnits } from '../core/canonical.js';
import type { SourceLocation } from '../core/diagnostics.js';
import type { ScanSnapshot } from '../core/engine.js';
import type { SymbolRecord } from '../core/index.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  assignments,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
} from '../core/source/index.js';

export const decisionFieldNames = [
  'allowed',
  'visible',
  'available',
  'targets',
  'target_array',
  'state_trigger',
  'target_root_trigger',
  'target_trigger',
  'cost',
  'custom_cost_trigger',
  'custom_cost_text',
  'complete_effect',
  'fire_only_once',
  'days_re_enable',
  'days_remove',
  'remove_trigger',
  'remove_effect',
  'cancel_trigger',
  'cancel_if_not_visible',
  'cancel_effect',
  'days_mission_timeout',
  'timeout_effect',
  'activation',
  'selectable_mission',
  'ai_will_do',
] as const;

export type DecisionFieldName = (typeof decisionFieldNames)[number];
export type DecisionFields = Record<DecisionFieldName, AssignmentNode[]>;

export interface DecisionSource {
  id: string;
  category: string;
  kind: 'decision' | 'mission';
  path: string;
  rootKind: ScannedFile['rootKind'];
  loadOrder: number;
  sourceHash: string;
  location?: SourceLocation;
  document: SourceDocument;
  block: BlockNode;
  fields: DecisionFields;
}

export interface DecisionCategorySource {
  id: string;
  path: string;
  rootKind: ScannedFile['rootKind'];
  loadOrder: number;
  sourceHash: string;
  location?: SourceLocation;
  document: SourceDocument;
  block: BlockNode;
  fields: DecisionFields;
}

export interface DecisionTargetCatalog {
  targeted: boolean;
  explicitTargets: string[];
  targetArrays: string[];
  stateFilters: string[];
  hasTargetRootTrigger: boolean;
  hasTargetTrigger: boolean;
}

/** Static targeting declarations; scenario evaluation determines whether a target qualifies. */
export function decisionTargetCatalog(source: DecisionSource): DecisionTargetCatalog {
  const explicitTargets = source.fields.targets.flatMap((assignment) => {
    if (assignment.value.type !== 'block') return [];
    return [
      ...assignment.value.entries
        .filter((entry) => entry.type === 'scalar')
        .map((entry) => entry.value),
      ...assignments(assignment.value, 'state')
        .filter((entry) => entry.value.type === 'scalar')
        .map((entry) => (entry.value as { value: string }).value),
    ];
  });
  const targetArrays = source.fields.target_array.flatMap((assignment) =>
    assignment.value.type === 'scalar' ? [assignment.value.value] : [],
  );
  const stateFilters = source.fields.state_trigger.flatMap((assignment) =>
    assignment.value.type === 'scalar' ? [assignment.value.value] : [],
  );
  const hasTargetRootTrigger = source.fields.target_root_trigger.length > 0;
  const hasTargetTrigger = source.fields.target_trigger.length > 0;
  return {
    targeted:
      explicitTargets.length > 0 ||
      targetArrays.length > 0 ||
      stateFilters.some((filter) => filter !== 'no') ||
      hasTargetRootTrigger ||
      hasTargetTrigger,
    explicitTargets,
    targetArrays,
    stateFilters,
    hasTargetRootTrigger,
    hasTargetTrigger,
  };
}

export interface DecisionSourceInventory {
  sourceRevision: string;
  complete: boolean;
  skippedSourceCount: number;
  decisions: DecisionSource[];
  categories: DecisionCategorySource[];
  overrides: Array<
    Pick<
      SymbolRecord,
      'kind' | 'id' | 'path' | 'rootKind' | 'loadOrder' | 'location' | 'sourceShadowed'
    >
  >;
  unresolvedDefinitions: Array<{
    kind: 'decision' | 'decision_category';
    id: string;
    path: string;
    reason: string;
  }>;
}

function fields(block: BlockNode): DecisionFields {
  return Object.fromEntries(
    decisionFieldNames.map((name) => [name, assignments(block, name)]),
  ) as unknown as DecisionFields;
}

function sourceDocument(
  file: ScannedFile | undefined,
  documents: Map<string, SourceDocument>,
): SourceDocument | undefined {
  if (file === undefined) return undefined;
  const existing = documents.get(file.displayPath);
  if (existing !== undefined) return existing;
  const parsed = parseClausewitz(file.bytes, file.displayPath);
  documents.set(file.displayPath, parsed);
  return parsed;
}

function categoryBlock(document: SourceDocument, id: string): BlockNode | undefined {
  return assignments(document.root, id).find((assignment) => assignment.value.type === 'block')
    ?.value as BlockNode | undefined;
}

function sourceOrder(
  left: Pick<SymbolRecord, 'id' | 'path' | 'loadOrder'>,
  right: Pick<SymbolRecord, 'id' | 'path' | 'loadOrder'>,
): number {
  return (
    compareCodeUnits(left.id, right.id) ||
    right.loadOrder - left.loadOrder ||
    compareCodeUnits(left.path, right.path)
  );
}

/** Reuses the shared index's active/overridden selection and source inventory. */
export function decisionSourceInventory(
  snapshot: Pick<ScanSnapshot, 'revision' | 'files' | 'index' | 'complete' | 'skippedSourceCount'>,
): DecisionSourceInventory {
  const files = new Map(snapshot.files.map((file) => [file.displayPath, file]));
  const documents = new Map<string, SourceDocument>();
  const unresolvedDefinitions: DecisionSourceInventory['unresolvedDefinitions'] = [];
  const categories: DecisionCategorySource[] = [];
  const decisions: DecisionSource[] = [];
  const overrides = [
    ...snapshot.index.findAll('decision_category'),
    ...snapshot.index.findAll('decision'),
  ]
    .filter(({ overridden }) => overridden)
    .sort(sourceOrder)
    .map(({ kind, id, path, rootKind, loadOrder, location, sourceShadowed }) => ({
      kind,
      id,
      path,
      rootKind,
      loadOrder,
      ...(location === undefined ? {} : { location }),
      sourceShadowed,
    }));

  for (const symbol of snapshot.index
    .findAll('decision_category')
    .filter(({ overridden }) => !overridden)
    .sort(sourceOrder)) {
    const file = files.get(symbol.path);
    const document = sourceDocument(file, documents);
    const block = document === undefined ? undefined : categoryBlock(document, symbol.id);
    if (file === undefined || document === undefined || block === undefined) {
      unresolvedDefinitions.push({
        kind: 'decision_category',
        id: symbol.id,
        path: symbol.path,
        reason: 'Active category index entry could not be matched to a source block',
      });
      continue;
    }
    categories.push({
      id: symbol.id,
      path: symbol.path,
      rootKind: file.rootKind,
      loadOrder: file.loadOrder,
      sourceHash: file.sha256,
      ...(symbol.location === undefined ? {} : { location: symbol.location }),
      document,
      block,
      fields: fields(block),
    });
  }

  for (const symbol of snapshot.index
    .findAll('decision')
    .filter(({ overridden }) => !overridden)
    .sort(sourceOrder)) {
    const category =
      typeof symbol.metadata.category === 'string' ? symbol.metadata.category : undefined;
    const file = files.get(symbol.path);
    const document = sourceDocument(file, documents);
    const categoryNode =
      document === undefined || category === undefined
        ? undefined
        : categoryBlock(document, category);
    const decisionNode =
      categoryNode === undefined
        ? undefined
        : assignments(categoryNode, symbol.id).find(
            (assignment) => assignment.value.type === 'block',
          )?.value;
    if (
      file === undefined ||
      document === undefined ||
      category === undefined ||
      decisionNode?.type !== 'block'
    ) {
      unresolvedDefinitions.push({
        kind: 'decision',
        id: symbol.id,
        path: symbol.path,
        reason: 'Active decision index entry could not be matched to a source block',
      });
      continue;
    }
    const decisionFields = fields(decisionNode);
    decisions.push({
      id: symbol.id,
      category,
      kind: decisionFields.days_mission_timeout.length > 0 ? 'mission' : 'decision',
      path: symbol.path,
      rootKind: file.rootKind,
      loadOrder: file.loadOrder,
      sourceHash: file.sha256,
      ...(symbol.location === undefined ? {} : { location: symbol.location }),
      document,
      block: decisionNode,
      fields: decisionFields,
    });
  }

  return {
    sourceRevision: snapshot.revision,
    complete: snapshot.complete && unresolvedDefinitions.length === 0,
    skippedSourceCount: snapshot.skippedSourceCount,
    decisions,
    categories,
    overrides,
    unresolvedDefinitions,
  };
}

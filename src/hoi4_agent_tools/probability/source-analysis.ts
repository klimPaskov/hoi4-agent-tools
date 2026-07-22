import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type { ScanSnapshot } from '../core/engine.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  assignments,
  astPathFor,
  childBlocks,
  firstScalar,
  nodeLocation,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
} from '../core/source/index.js';
import { probabilityAdapter } from './adapters.js';
import type {
  ProbabilityAdapterId,
  ParentRandomPool,
  ProbabilitySourceInput,
  ProbabilitySourceProvenance,
  ProbabilityUnresolved,
  WeightedCandidate,
  WeightedSurface,
} from './model.js';

interface SourceContext {
  file: ScannedFile;
  document: SourceDocument;
}

interface WalkedAssignment {
  assignment: AssignmentNode;
  ancestors: Array<{ key: string; block: BlockNode; assignment: AssignmentNode }>;
}

const eventKeys = new Set([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function walkAssignments(
  block: BlockNode,
  ancestors: Array<{ key: string; block: BlockNode; assignment: AssignmentNode }> = [],
  output: WalkedAssignment[] = [],
): WalkedAssignment[] {
  for (const assignment of assignments(block)) {
    output.push({ assignment, ancestors });
    if (assignment.value.type === 'block') {
      walkAssignments(
        assignment.value,
        [...ancestors, { key: assignment.key.value, block, assignment }],
        output,
      );
    }
  }
  return output;
}

function provenance(
  context: SourceContext,
  node: AssignmentNode | BlockNode,
  symbol?: string,
): ProbabilitySourceProvenance {
  return {
    path: context.file.displayPath,
    rootKind: context.file.rootKind,
    loadOrder: context.file.loadOrder,
    sourceHash: context.file.sha256,
    location: nodeLocation(context.document, node, symbol),
    ...(astPathFor(context.document, node) === undefined
      ? {}
      : { astPath: astPathFor(context.document, node)! }),
    ...(symbol === undefined ? {} : { symbol }),
  };
}

function weightCandidate(
  adapterId: ProbabilityAdapterId,
  id: string,
  sourceKind: string,
  defaultValue: string,
  context: SourceContext,
  definition: AssignmentNode | BlockNode,
  options: {
    weightBlock?: BlockNode;
    eligibilityBlock?: BlockNode;
    valueExpression?: string;
    metadata?: Record<string, unknown>;
    parentRandomPools?: ParentRandomPool[];
  } = {},
): WeightedCandidate {
  return {
    id,
    adapterId,
    sourceKind,
    defaultValue,
    ...(options.valueExpression === undefined ? {} : { valueExpression: options.valueExpression }),
    ...(options.weightBlock === undefined ? {} : { weightBlock: options.weightBlock }),
    ...(options.eligibilityBlock === undefined
      ? {}
      : { eligibilityBlock: options.eligibilityBlock }),
    document: context.document,
    provenance: [provenance(context, definition, id)],
    metadata: options.metadata ?? {},
    ...(options.parentRandomPools === undefined
      ? {}
      : { parentRandomPools: options.parentRandomPools }),
  };
}

function eventCandidates(
  context: SourceContext,
  adapterId: 'event_mean_time_to_happen' | 'event_option_ai_chance',
): WeightedCandidate[] {
  const output: WeightedCandidate[] = [];
  for (const { assignment, ancestors } of walkAssignments(context.document.root)) {
    if (
      assignment.value.type !== 'block' ||
      ancestors.length !== 0 ||
      !eventKeys.has(assignment.key.value) ||
      firstScalar(assignment.value, 'id') === undefined
    )
      continue;
    const event = assignment.value;
    const eventId = firstScalar(event, 'id')!.value;
    if (adapterId === 'event_mean_time_to_happen') {
      const mtth = childBlocks(event, 'mean_time_to_happen')[0];
      if (mtth === undefined) continue;
      output.push(
        weightCandidate(adapterId, eventId, assignment.key.value, '0', context, assignment, {
          weightBlock: mtth,
          ...(childBlocks(event, 'trigger')[0] === undefined
            ? {}
            : { eligibilityBlock: childBlocks(event, 'trigger')[0] }),
          metadata: { eventId },
        }),
      );
      continue;
    }
    const options = childBlocks(event, 'option');
    for (const [index, option] of options.entries()) {
      const chance = childBlocks(option, 'ai_chance')[0];
      const name = firstScalar(option, 'name')?.value ?? `${eventId}.option.${index + 1}`;
      output.push(
        weightCandidate(adapterId, name, 'event_option', '1', context, option, {
          ...(chance === undefined ? {} : { weightBlock: chance }),
          ...(childBlocks(option, 'trigger')[0] === undefined
            ? {}
            : { eligibilityBlock: childBlocks(option, 'trigger')[0] }),
          metadata: { eventId, optionIndex: index },
        }),
      );
    }
  }
  return output;
}

function focusCandidates(context: SourceContext): WeightedCandidate[] {
  const output: WeightedCandidate[] = [];
  for (const { assignment, ancestors } of walkAssignments(context.document.root)) {
    if (
      assignment.key.value !== 'focus' ||
      assignment.value.type !== 'block' ||
      ancestors.at(-1)?.key !== 'focus_tree'
    )
      continue;
    const id = firstScalar(assignment.value, 'id')?.value;
    if (id === undefined) continue;
    const weight = childBlocks(assignment.value, 'ai_will_do')[0];
    output.push(
      weightCandidate('national_focus_ai_will_do', id, 'focus', '1', context, assignment, {
        ...(weight === undefined ? {} : { weightBlock: weight }),
        ...(childBlocks(assignment.value, 'available')[0] === undefined
          ? {}
          : { eligibilityBlock: childBlocks(assignment.value, 'available')[0] }),
        metadata: {
          prerequisiteBlocks: childBlocks(assignment.value, 'prerequisite').length,
          hasBypass: childBlocks(assignment.value, 'bypass').length > 0,
        },
      }),
    );
  }
  return output;
}

function decisionCandidates(
  context: SourceContext,
  adapterId: 'decision_ai_will_do' | 'mission_ai_will_do',
): WeightedCandidate[] {
  const output: WeightedCandidate[] = [];
  const ignored = new Set([
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
  for (const { assignment, ancestors } of walkAssignments(context.document.root)) {
    if (
      assignment.value.type !== 'block' ||
      ancestors.length !== 1 ||
      ignored.has(assignment.key.value)
    )
      continue;
    const mission =
      firstScalar(assignment.value, 'is_mission')?.value === 'yes' ||
      firstScalar(assignment.value, 'days_mission_timeout') !== undefined ||
      firstScalar(assignment.value, 'days_remove') !== undefined;
    if ((adapterId === 'mission_ai_will_do') !== mission) continue;
    const weight = childBlocks(assignment.value, 'ai_will_do')[0];
    if (weight === undefined) continue;
    output.push(
      weightCandidate(
        adapterId,
        assignment.key.value,
        mission ? 'mission' : 'decision',
        '1',
        context,
        assignment,
        {
          weightBlock: weight,
          ...(childBlocks(assignment.value, 'available')[0] === undefined
            ? {}
            : { eligibilityBlock: childBlocks(assignment.value, 'available')[0] }),
          metadata: { category: ancestors[0]!.key },
        },
      ),
    );
  }
  return output;
}

function technologyCandidates(
  context: SourceContext,
  adapterId: 'technology_ai_will_do' | 'doctrine_ai_will_do',
): WeightedCandidate[] {
  const output: WeightedCandidate[] = [];
  const sourcePath = normalized(context.file.relativePath);
  for (const { assignment, ancestors } of walkAssignments(context.document.root)) {
    if (assignment.value.type !== 'block') continue;
    const classic =
      adapterId === 'technology_ai_will_do' &&
      sourcePath.startsWith('common/technologies/') &&
      ancestors.length === 1 &&
      ancestors[0]?.key === 'technologies' &&
      !assignment.key.value.startsWith('@');
    const doctrine =
      adapterId === 'doctrine_ai_will_do' &&
      sourcePath.startsWith('common/doctrines/') &&
      ancestors.length === 0 &&
      !assignment.key.value.startsWith('@');
    if (!classic && !doctrine) continue;
    const weight = childBlocks(assignment.value, 'ai_will_do')[0];
    if (weight === undefined) continue;
    output.push(
      weightCandidate(
        adapterId,
        assignment.key.value,
        doctrine ? 'doctrine' : 'technology',
        '1',
        context,
        assignment,
        {
          weightBlock: weight,
          ...((childBlocks(assignment.value, 'allow')[0] ??
            childBlocks(assignment.value, 'available')[0]) === undefined
            ? {}
            : {
                eligibilityBlock:
                  childBlocks(assignment.value, 'allow')[0] ??
                  childBlocks(assignment.value, 'available')[0]!,
              }),
          metadata: { sourcePath },
        },
      ),
    );
  }
  return output;
}

function randomListEntryCandidates(
  context: SourceContext,
  list: AssignmentNode,
): WeightedCandidate[] {
  if (list.value.type !== 'block') return [];
  const location = nodeLocation(context.document, list);
  const blockId = `${context.file.relativePath}:${location.start.line}`;
  return assignments(list.value).flatMap((entry, index) => {
    if (entry.value.type !== 'block') return [];
    const trigger = childBlocks(entry.value, 'trigger')[0] ?? childBlocks(entry.value, 'limit')[0];
    return [
      weightCandidate(
        'random_list',
        `${blockId}.entry.${index + 1}`,
        'random_list_entry',
        entry.key.value,
        context,
        entry,
        {
          weightBlock: entry.value,
          ...(trigger === undefined ? {} : { eligibilityBlock: trigger }),
          metadata: {
            randomListId: blockId,
            entryIndex: index,
            poolStartLine: location.start.line,
            poolEndLine: location.end.line,
          },
        },
      ),
    ];
  });
}

function parentRandomPools(
  context: SourceContext,
  ancestors: WalkedAssignment['ancestors'],
): ParentRandomPool[] {
  const output: ParentRandomPool[] = [];
  for (let index = 0; index + 1 < ancestors.length; index += 1) {
    const list = ancestors[index]!.assignment;
    const selectedEntry = ancestors[index + 1]!.assignment;
    if (list.key.value !== 'random_list' || list.value.type !== 'block') continue;
    const entries = assignments(list.value).filter(({ value }) => value.type === 'block');
    const selectedEntryIndex = entries.indexOf(selectedEntry);
    if (selectedEntryIndex < 0) continue;
    const candidates = randomListEntryCandidates(context, list);
    const randomListId = candidates[0]?.metadata.randomListId;
    output.push({
      id: typeof randomListId === 'string' ? randomListId : `random-list-${index}`,
      selectedEntryIndex,
      candidates,
    });
  }
  return output;
}

function randomCandidates(
  context: SourceContext,
  adapterId: 'direct_random' | 'random_list',
): WeightedCandidate[] {
  const output: WeightedCandidate[] = [];
  for (const { assignment, ancestors } of walkAssignments(context.document.root)) {
    if (assignment.key.value !== (adapterId === 'direct_random' ? 'random' : 'random_list'))
      continue;
    if (assignment.value.type !== 'block') continue;
    const location = nodeLocation(context.document, assignment);
    const blockId = `${context.file.relativePath}:${location.start.line}`;
    if (adapterId === 'direct_random') {
      const chance = firstScalar(assignment.value, 'chance');
      if (chance === undefined) continue;
      output.push(
        weightCandidate(adapterId, blockId, 'random', '0', context, assignment, {
          valueExpression: chance.value,
          metadata: { randomBlockId: blockId },
        }),
      );
      continue;
    }
    const parents = parentRandomPools(context, ancestors);
    output.push(
      ...randomListEntryCandidates(context, assignment).map((candidate) => ({
        ...candidate,
        ...(parents.length === 0 ? {} : { parentRandomPools: parents }),
      })),
    );
  }
  return output;
}

function aiStrategyCandidates(context: SourceContext): WeightedCandidate[] {
  const output: WeightedCandidate[] = [];
  for (const { assignment } of walkAssignments(context.document.root)) {
    if (assignment.value.type !== 'block') continue;
    const type = firstScalar(assignment.value, 'type')?.value;
    if (type !== 'research_weight_factor' && type !== 'research_tech' && type !== 'focus') continue;
    const value = firstScalar(assignment.value, 'value');
    if (value === undefined) continue;
    const target = firstScalar(assignment.value, 'id')?.value ?? 'unspecified';
    const location = nodeLocation(context.document, assignment);
    const id = `${type}:${target}:${context.file.relativePath}:${location.start.line}`;
    output.push(
      weightCandidate('ai_strategy_factor', id, 'ai_strategy', '0', context, assignment, {
        valueExpression: value.value,
        metadata: { strategyType: type, target },
      }),
    );
  }
  return output;
}

function candidatesFor(
  context: SourceContext,
  adapterId: ProbabilityAdapterId,
): WeightedCandidate[] {
  switch (adapterId) {
    case 'event_mean_time_to_happen':
    case 'event_option_ai_chance':
      return eventCandidates(context, adapterId);
    case 'decision_ai_will_do':
    case 'mission_ai_will_do':
      return decisionCandidates(context, adapterId);
    case 'national_focus_ai_will_do':
      return focusCandidates(context);
    case 'technology_ai_will_do':
    case 'doctrine_ai_will_do':
      return technologyCandidates(context, adapterId);
    case 'direct_random':
    case 'random_list':
      return randomCandidates(context, adapterId);
    case 'ai_strategy_factor':
      return aiStrategyCandidates(context);
    case 'custom_weighted_pool':
      return [];
  }
}

function sourceContexts(snapshot: ScanSnapshot, source: ProbabilitySourceInput): SourceContext[] {
  if (source.inlineClausewitz !== undefined || source.virtualPatch !== undefined) {
    const text = source.virtualPatch ?? source.inlineClausewitz ?? '';
    const bytes = Buffer.from(text, 'utf8');
    const sourceHash = hashCanonical({ text });
    const file: ScannedFile = {
      absolutePath: '<inline>',
      displayPath: 'proposed:inline-probability-source.txt',
      relativePath: 'proposed/inline-probability-source.txt',
      rootKind: 'fixture',
      loadOrder: Number.MAX_SAFE_INTEGER,
      size: bytes.length,
      modifiedMs: 0,
      sha256: sourceHash,
      bytes,
    };
    return [{ file, document: parseClausewitz(bytes, file.displayPath) }];
  }
  const requestedPath = source.path === undefined ? undefined : normalized(source.path);
  const selected = snapshot.files.filter(({ relativePath, shadowedBy }) => {
    if (shadowedBy !== undefined || !relativePath.toLowerCase().endsWith('.txt')) return false;
    if (requestedPath === undefined) return true;
    const relative = normalized(relativePath);
    return relative === requestedPath || relative.endsWith(`/${requestedPath}`);
  });
  if (requestedPath !== undefined && selected.length === 0)
    throw new ServiceError(
      'PROBABILITY_SOURCE_NOT_FOUND',
      'Probability source path was not found',
      {
        path: source.path,
      },
    );
  if (
    source.expectedSourceHash !== undefined &&
    selected.some(({ sha256 }) => sha256 !== source.expectedSourceHash)
  )
    throw new ServiceError('PROBABILITY_SOURCE_STALE', 'Probability source hash is stale', {
      expectedSourceHash: source.expectedSourceHash,
      actualSourceHashes: selected.map(({ sha256 }) => sha256),
    });
  return selected.map((file) => ({
    file,
    document: parseClausewitz(file.bytes, file.displayPath),
  }));
}

function identifierMatches(candidate: WeightedCandidate, identifier: string): boolean {
  if (candidate.id === identifier) return true;
  return Object.values(candidate.metadata).some((value) => value === identifier);
}

function samePool(candidate: WeightedCandidate, selected: WeightedCandidate): boolean {
  if (candidate.adapterId === 'event_option_ai_chance')
    return candidate.metadata.eventId === selected.metadata.eventId;
  if (candidate.adapterId === 'random_list')
    return candidate.metadata.randomListId === selected.metadata.randomListId;
  return candidate.id === selected.id;
}

export function discoverWeightedSurface(
  snapshot: ScanSnapshot,
  adapterId: ProbabilityAdapterId,
  source: ProbabilitySourceInput,
  candidatePool: readonly string[] = [],
): WeightedSurface {
  const contexts = sourceContexts(snapshot, source);
  let candidates = contexts.flatMap((context) => candidatesFor(context, adapterId));
  candidates.sort((left, right) => compareCodeUnits(left.id, right.id));
  if (source.line !== undefined) {
    candidates = candidates.filter(({ metadata, provenance: [first] }) => {
      const location = first?.location;
      const poolStartLine = metadata.poolStartLine;
      const poolEndLine = metadata.poolEndLine;
      return (
        (location !== undefined &&
          source.line! >= location.start.line &&
          source.line! <= location.end.line) ||
        (typeof poolStartLine === 'number' &&
          typeof poolEndLine === 'number' &&
          source.line! >= poolStartLine &&
          source.line! <= poolEndLine)
      );
    });
    if (adapterId === 'event_option_ai_chance' || adapterId === 'random_list') {
      const poolProperty = adapterId === 'event_option_ai_chance' ? 'eventId' : 'randomListId';
      const pools = new Map<unknown, { span: number }>();
      for (const candidate of candidates) {
        const start = candidate.metadata.poolStartLine;
        const end = candidate.metadata.poolEndLine;
        const span =
          typeof start === 'number' && typeof end === 'number'
            ? end - start
            : Number.MAX_SAFE_INTEGER;
        const key = candidate.metadata[poolProperty];
        const existing = pools.get(key);
        if (existing === undefined || span < existing.span) pools.set(key, { span });
      }
      const selectedPool = [...pools].sort(
        ([leftKey, left], [rightKey, right]) =>
          left.span - right.span || compareCodeUnits(String(leftKey), String(rightKey)),
      )[0]?.[0];
      if (selectedPool !== undefined)
        candidates = candidates.filter(
          (candidate) => candidate.metadata[poolProperty] === selectedPool,
        );
    }
  }
  const localCategoricalPool =
    adapterId === 'event_option_ai_chance' || adapterId === 'random_list';
  let completeLocalPoolIds: Set<string> | undefined;
  if (source.identifier !== undefined) {
    const selected = candidates.find((candidate) =>
      identifierMatches(candidate, source.identifier!),
    );
    if (selected === undefined)
      throw new ServiceError(
        'PROBABILITY_IDENTIFIER_NOT_FOUND',
        'No weighted source matched the requested identifier',
        { identifier: source.identifier, adapterId },
      );
    if (localCategoricalPool) {
      candidates = candidates.filter((candidate) => samePool(candidate, selected));
      completeLocalPoolIds = new Set(candidates.map(({ id }) => id));
    } else if (candidatePool.length === 0) candidates = [selected];
  }
  const candidatesBeforeExplicitPool = candidates;
  if (candidatePool.length > 0) {
    const wanted = new Set(candidatePool);
    candidates = candidates.filter(({ id }) => wanted.has(id));
  }
  if (candidates.length === 0 && adapterId !== 'custom_weighted_pool')
    throw new ServiceError('PROBABILITY_SURFACE_EMPTY', 'No weighted blocks matched this request', {
      adapterId,
      source,
    });
  const missingCandidates = candidatePool.filter(
    (id) => !candidates.some((candidate) => candidate.id === id),
  );
  const unsupported: ProbabilityUnresolved[] = missingCandidates.map((candidateId) => ({
    code: 'CANDIDATE_NOT_FOUND',
    message: 'Declared candidate was not found in active source',
    candidateId,
  }));
  const inherentPool = adapterId === 'direct_random' || adapterId === 'event_mean_time_to_happen';
  if (localCategoricalPool && completeLocalPoolIds === undefined) {
    const poolKey = (candidate: WeightedCandidate): string =>
      String(
        adapterId === 'event_option_ai_chance'
          ? candidate.metadata.eventId
          : candidate.metadata.randomListId,
      );
    const selectedKeys = new Set(candidates.map(poolKey));
    if (selectedKeys.size === 1) {
      const [selectedKey] = selectedKeys;
      completeLocalPoolIds = new Set(
        candidatesBeforeExplicitPool
          .filter((candidate) => poolKey(candidate) === selectedKey)
          .map(({ id }) => id),
      );
    } else
      unsupported.push({
        code: 'MULTIPLE_CATEGORICAL_POOLS',
        message:
          'Select one event-option or random-list pool before requesting normalized probabilities',
      });
  }
  const localPoolIds = completeLocalPoolIds;
  const localPoolComplete =
    localPoolIds?.size === candidates.length && candidates.every(({ id }) => localPoolIds.has(id));
  const poolComplete =
    missingCandidates.length === 0 &&
    (inherentPool ||
      (localCategoricalPool && localPoolComplete) ||
      (!localCategoricalPool &&
        candidatePool.length > 0 &&
        candidates.length === candidatePool.length));
  const hashes = Object.fromEntries(
    contexts.map(({ file }) => [file.displayPath, file.sha256] as const),
  );
  return {
    id: source.identifier ?? source.path ?? `${adapterId}-workspace-scan`,
    adapter: probabilityAdapter(adapterId),
    candidates,
    poolComplete,
    sourceRevision: snapshot.revision,
    sourceHash: hashCanonical(hashes),
    filesScanned: contexts.map(({ file }) => file.displayPath),
    unsupported,
  };
}

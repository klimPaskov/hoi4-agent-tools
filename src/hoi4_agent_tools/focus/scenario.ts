import { compareCodeUnits } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type { FocusRouteLock, FocusTreePlan } from './model.js';

export interface FocusScenarioCase {
  focusId: string;
  status: 'completed' | 'blocked' | 'unresolved' | 'structural_candidate';
  missingPrerequisiteGroups: string[][];
  blockedRouteLockIds: string[];
  exclusiveWithCompletedIds: string[];
  unresolvedFields: string[];
}

export interface FocusScenarioEvidence {
  treeId: string;
  completedFocusIds: string[];
  focuses: FocusScenarioCase[];
  mutualExclusionConflicts: Array<{ leftFocusId: string; rightFocusId: string }>;
  counts: { completed: number; blocked: number; unresolved: number; structuralCandidates: number };
}

function routeLockSatisfied(lock: FocusRouteLock, completed: ReadonlySet<string>): boolean {
  const predicates = [
    ...lock.requiredFocusIds.map((id) => completed.has(id)),
    ...lock.excludedFocusIds.map((id) => !completed.has(id)),
    ...(lock.alwaysImpossible === true ? [false] : []),
  ];
  return lock.mode === 'any' ? predicates.some(Boolean) : predicates.every(Boolean);
}

/** Reports only structural evidence. Unsupported runtime triggers remain unresolved. */
export function inspectFocusScenario(
  plan: FocusTreePlan,
  completedFocusIds: readonly string[],
): FocusScenarioEvidence {
  const known = new Set(plan.focuses.map(({ id }) => id));
  const completed = new Set(completedFocusIds);
  const excludedBy = new Map<string, string[]>();
  for (const focus of plan.focuses)
    for (const excluded of focus.mutuallyExclusive) {
      const owners = excludedBy.get(excluded) ?? [];
      owners.push(focus.id);
      excludedBy.set(excluded, owners);
    }
  for (const id of completed)
    if (!known.has(id))
      throw new ServiceError('FOCUS_SCENARIO_UNKNOWN_FOCUS', 'Scenario names an unknown focus', {
        treeId: plan.id,
        focusId: id,
      });
  const focuses = [...plan.focuses]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((focus): FocusScenarioCase => {
      const missingPrerequisiteGroups = focus.prerequisites.groups
        .filter(({ focusIds }) => !focusIds.some((id) => completed.has(id)))
        .map(({ focusIds }) => [...focusIds].sort(compareCodeUnits));
      const blockedRouteLockIds = focus.routeLocks
        .filter((lock) => !routeLockSatisfied(lock, completed))
        .map(({ id }) => id)
        .sort(compareCodeUnits);
      const exclusiveWithCompletedIds = [
        ...new Set([...focus.mutuallyExclusive, ...(excludedBy.get(focus.id) ?? [])]),
      ]
        .filter((id) => completed.has(id))
        .sort(compareCodeUnits);
      const unresolvedFields = [
        ...(focus.availability === undefined ? [] : ['available']),
        ...(focus.allowBranch === undefined ? [] : ['allow_branch']),
        ...(focus.bypass === undefined ? [] : ['bypass']),
        ...(focus.visibility === 'normal' ||
        (focus.reveal?.kind === 'allow_branch' &&
          focus.routeLocks.some(({ field }) => field === 'allow_branch'))
          ? []
          : ['visibility']),
      ];
      const blocked =
        missingPrerequisiteGroups.length > 0 ||
        blockedRouteLockIds.length > 0 ||
        exclusiveWithCompletedIds.length > 0;
      const status = completed.has(focus.id)
        ? 'completed'
        : blocked
          ? 'blocked'
          : unresolvedFields.length > 0
            ? 'unresolved'
            : 'structural_candidate';
      return {
        focusId: focus.id,
        status,
        missingPrerequisiteGroups,
        blockedRouteLockIds,
        exclusiveWithCompletedIds,
        unresolvedFields,
      };
    });
  const conflicts = new Set<string>();
  for (const focus of plan.focuses) {
    if (!completed.has(focus.id)) continue;
    for (const other of focus.mutuallyExclusive) {
      if (!completed.has(other)) continue;
      conflicts.add([focus.id, other].sort(compareCodeUnits).join('\0'));
    }
  }
  const mutualExclusionConflicts = [...conflicts].sort(compareCodeUnits).map((pair) => {
    const [leftFocusId, rightFocusId] = pair.split('\0');
    return { leftFocusId: leftFocusId!, rightFocusId: rightFocusId! };
  });
  return {
    treeId: plan.id,
    completedFocusIds: [...completed].sort(compareCodeUnits),
    focuses,
    mutualExclusionConflicts,
    counts: {
      completed: focuses.filter(({ status }) => status === 'completed').length,
      blocked: focuses.filter(({ status }) => status === 'blocked').length,
      unresolved: focuses.filter(({ status }) => status === 'unresolved').length,
      structuralCandidates: focuses.filter(({ status }) => status === 'structural_candidate')
        .length,
    },
  };
}

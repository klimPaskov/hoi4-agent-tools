import { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { resolveConditionNumber } from '../core/condition-evaluator.js';
import type { ConditionScenario } from '../core/condition-model.js';
import type { ScanSnapshot } from '../core/engine.js';
import { rootScopeContext } from '../core/scenario-state.js';
import type { AssignmentNode } from '../core/source/index.js';
import type { DecisionSource } from './source-inventory.js';

export interface DecisionDuration {
  expression: string | null;
  days: number | null;
}

export interface DecisionLifecycleInspection {
  kind: 'decision' | 'mission';
  fireOnlyOnce: boolean | null;
  selectableMission: boolean | null;
  cooldown: DecisionDuration | null;
  removal: DecisionDuration | null;
  missionTimeout: DecisionDuration | null;
  hasActivation: boolean;
  hasCompletionEffect: boolean;
  hasRemovalTrigger: boolean;
  hasRemovalEffect: boolean;
  hasCancellationTrigger: boolean;
  hasCancellationEffect: boolean;
  hasTimeoutEffect: boolean;
  ignoredMissionVisible: boolean;
  unresolved: string[];
}

function scalar(assignment: AssignmentNode | undefined): string | undefined {
  return assignment?.value.type === 'scalar' ? assignment.value.value : undefined;
}

function boolean(value: string | undefined): boolean | null {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

/** Static lifecycle paths and durations, with no claim that a campaign reached them. */
export function inspectDecisionLifecycle(
  snapshot: ScanSnapshot,
  source: DecisionSource,
  scenario: ConditionScenario,
): DecisionLifecycleInspection {
  const definitions = ClausewitzEvaluationDefinitions.build(snapshot);
  const unresolved: string[] = [];
  const duration = (
    field: 'days_re_enable' | 'days_remove' | 'days_mission_timeout',
  ): DecisionDuration | null => {
    const entries = source.fields[field];
    if (entries.length === 0) return null;
    if (entries.length > 1) unresolved.push(`Multiple ${field} values in ${source.path}`);
    const expression = scalar(entries[0]);
    const days =
      expression === undefined
        ? undefined
        : resolveConditionNumber(
            expression,
            scenario,
            rootScopeContext(scenario),
            definitions,
            source.path,
          );
    if (
      days === undefined ||
      !Number.isInteger(days) ||
      (field === 'days_remove' ? days < -1 : days < 0)
    )
      unresolved.push(`${field} is not a supported day count`);
    return { expression: expression ?? null, days: days ?? null };
  };
  const fireOnlyOnceExpression = scalar(source.fields.fire_only_once[0]);
  const selectableExpression = scalar(source.fields.selectable_mission[0]);
  const fireOnlyOnce =
    fireOnlyOnceExpression === undefined ? false : boolean(fireOnlyOnceExpression);
  const selectableMission =
    selectableExpression === undefined ? false : boolean(selectableExpression);
  if (source.fields.fire_only_once.length > 1 || (fireOnlyOnceExpression && fireOnlyOnce === null))
    unresolved.push('fire_only_once is repeated or not a recognized Boolean');
  if (
    source.fields.selectable_mission.length > 1 ||
    (selectableExpression && selectableMission === null)
  )
    unresolved.push('selectable_mission is repeated or not a recognized Boolean');
  const cooldown = duration('days_re_enable');
  const removal = duration('days_remove');
  const missionTimeout = duration('days_mission_timeout');
  if (source.kind === 'mission' && missionTimeout === null)
    unresolved.push('Mission classification has no timeout');
  if (source.kind !== 'mission' && source.fields.timeout_effect.length > 0)
    unresolved.push('A non-mission declares timeout_effect');
  return {
    kind: source.kind,
    fireOnlyOnce,
    selectableMission: source.kind === 'mission' ? selectableMission : null,
    cooldown,
    removal,
    missionTimeout,
    hasActivation: source.fields.activation.length > 0,
    hasCompletionEffect: source.fields.complete_effect.length > 0,
    hasRemovalTrigger: source.fields.remove_trigger.length > 0,
    hasRemovalEffect: source.fields.remove_effect.length > 0,
    hasCancellationTrigger: source.fields.cancel_trigger.length > 0,
    hasCancellationEffect: source.fields.cancel_effect.length > 0,
    hasTimeoutEffect: source.fields.timeout_effect.length > 0,
    ignoredMissionVisible: source.kind === 'mission' && source.fields.visible.length > 0,
    unresolved,
  };
}

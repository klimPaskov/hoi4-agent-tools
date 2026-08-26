import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import {
  childBlocks,
  parseClausewitz,
  type BlockNode,
  type SourceDocument,
} from '../core/source/index.js';
import type {
  ProbabilityScenario,
  ProbabilityScopeBinding,
  ProbabilityScopePool,
  ProbabilityUnresolved,
  ScopePoolAnalysis,
  ScopePoolCandidateAnalysis,
  WeightedCandidate,
} from './model.js';
import { Rational, sumRationals } from './rational.js';
import {
  rootScopeContext,
  scopedExpressionValue,
  type ProbabilityScopeContext,
} from './scenario-state.js';
import { evaluateTriggerBlock } from './trigger-evaluator.js';

interface ParsedPoolFilter {
  document?: SourceDocument;
  block?: BlockNode;
  sourceHash: string;
  unresolved: ProbabilityUnresolved[];
}

function filterSource(pool: ProbabilityScopePool): string | undefined {
  if (pool.filter?.scriptedTrigger !== undefined)
    return `filter = { ${pool.filter.scriptedTrigger} = yes }`;
  const inline = pool.filter?.inlineClausewitz?.trim();
  if (inline === undefined) return undefined;
  if (/^filter\s*=/iu.test(inline)) return inline;
  return inline.startsWith('{') ? `filter = ${inline}` : `filter = { ${inline} }`;
}

function parseFilter(scenario: ProbabilityScenario, pool: ProbabilityScopePool): ParsedPoolFilter {
  const source = filterSource(pool);
  const sourceHash = hashCanonical({ scenarioId: scenario.id, poolId: pool.id, source });
  if (source === undefined) return { sourceHash, unresolved: [] };
  const path = `scenario:${scenario.id}/scope-pool:${pool.id}`;
  try {
    const document = parseClausewitz(Buffer.from(source, 'utf8'), path);
    const block = childBlocks(document.root, 'filter')[0];
    if (block !== undefined) return { document, block, sourceHash, unresolved: [] };
  } catch (error) {
    return {
      sourceHash,
      unresolved: [
        {
          code: 'SCOPE_POOL_FILTER_INVALID',
          message: `Scope pool ${pool.id} filter could not be parsed`,
          path: pool.id,
          details: { reason: error instanceof Error ? error.message : String(error) },
        },
      ],
    };
  }
  return {
    sourceHash,
    unresolved: [
      {
        code: 'SCOPE_POOL_FILTER_INVALID',
        message: `Scope pool ${pool.id} filter does not contain a trigger block`,
        path: pool.id,
      },
    ],
  };
}

function scopedScenario(
  scenario: ProbabilityScenario,
  pool: ProbabilityScopePool,
  binding: ProbabilityScopeBinding,
): { scenario: ProbabilityScenario; context: ProbabilityScopeContext } {
  const bindAs = pool.bindAs ?? 'THIS';
  if (bindAs === 'ROOT') {
    const root: ProbabilityScenario = {
      ...scenario,
      actor: binding.actor ?? binding.id,
      state: binding.state,
      ...(binding.flags === undefined ? {} : { flags: binding.flags }),
      ...(binding.eventTargets === undefined ? {} : { eventTargets: binding.eventTargets }),
      scopes: { ...scenario.scopes, ROOT: binding, THIS: binding },
    };
    return { scenario: root, context: rootScopeContext(root) };
  }
  const selected: ProbabilityScenario = {
    ...scenario,
    scopes: {
      ...scenario.scopes,
      THIS: binding,
      [bindAs]: binding,
    },
  };
  return {
    scenario: selected,
    context: {
      expression: 'THIS',
      binding,
      parent: rootScopeContext(scenario),
    },
  };
}

function candidateFor(
  scenario: ProbabilityScenario,
  pool: ProbabilityScopePool,
  binding: ProbabilityScopeBinding,
  filter: ParsedPoolFilter,
): WeightedCandidate {
  return {
    id: binding.id,
    adapterId: 'custom_weighted_pool',
    sourceKind: 'dynamic_scope_pool_candidate',
    defaultValue: '1',
    ...(filter.document === undefined ? {} : { document: filter.document }),
    provenance: [
      {
        path: `scenario:${scenario.id}/scope-pool:${pool.id}`,
        rootKind: 'scenario',
        loadOrder: 0,
        sourceHash: filter.sourceHash,
        symbol: binding.id,
      },
    ],
    metadata: { poolId: pool.id, bindAs: pool.bindAs ?? 'THIS' },
  };
}

function poolWeight(
  pool: ProbabilityScopePool,
  binding: ProbabilityScopeBinding,
  scenario: ProbabilityScenario,
): Rational | undefined {
  if (pool.selection === 'uniform') return Rational.one;
  const expression = binding.weight ?? 1;
  const direct = Rational.parse(expression);
  if (direct !== undefined) return direct.compare(Rational.zero) < 0 ? undefined : direct;
  if (typeof expression !== 'string') return undefined;
  const value =
    binding.state[expression] ??
    binding.state[`variable.${expression}`] ??
    scopedExpressionValue(scenario, expression) ??
    scenario.state[expression] ??
    scenario.state[`variable.${expression}`];
  const parsed =
    typeof value === 'number' || typeof value === 'string' ? Rational.parse(value) : undefined;
  return parsed !== undefined && parsed.compare(Rational.zero) >= 0 ? parsed : undefined;
}

function evaluatePool(
  scenario: ProbabilityScenario,
  pool: ProbabilityScopePool,
  definitions: ClausewitzEvaluationDefinitions,
): ScopePoolAnalysis {
  const filter = parseFilter(scenario, pool);
  const candidates = [...pool.candidates]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((binding): ScopePoolCandidateAnalysis => {
      const selected = scopedScenario(scenario, pool, binding);
      const candidate = candidateFor(scenario, pool, binding, filter);
      const eligibility =
        filter.unresolved.length > 0
          ? { state: 'unresolved' as const, unresolved: filter.unresolved }
          : evaluateTriggerBlock(
              filter.block,
              selected.scenario,
              candidate,
              definitions,
              [],
              selected.context,
            );
      const unresolved = [...eligibility.unresolved];
      const weight =
        pool.selection === 'enumeration' ? undefined : poolWeight(pool, binding, selected.scenario);
      if (pool.selection !== 'enumeration' && weight === undefined)
        unresolved.push({
          code: 'SCOPE_POOL_WEIGHT_UNRESOLVED',
          message: `Scope pool ${pool.id} candidate ${binding.id} has an unresolved weight`,
          path: pool.id,
          candidateId: binding.id,
          details: { weight: binding.weight ?? 1 },
        });
      return {
        id: binding.id,
        eligibility: eligibility.state,
        ...(weight === undefined ? {} : { weight: weight.toJSON() }),
        trace: eligibility.trace ?? [],
        unresolved,
      };
    });

  const unresolved: ProbabilityUnresolved[] = [
    ...filter.unresolved,
    ...candidates.flatMap(({ unresolved: items }) => items),
  ];
  if (pool.selection !== 'enumeration' && !pool.complete)
    unresolved.push({
      code: 'SCOPE_POOL_INCOMPLETE',
      message: `Scope pool ${pool.id} can be enumerated, but normalized probabilities require a complete candidate catalog`,
      path: pool.id,
    });
  const resolved = candidates.every(
    ({ eligibility, weight }) =>
      eligibility !== 'unresolved' && (pool.selection === 'enumeration' || weight !== undefined),
  );
  const eligibleWeights = candidates.flatMap((candidate) =>
    candidate.eligibility === 'true' && candidate.weight !== undefined
      ? [Rational.parse(candidate.weight.decimal)!]
      : [],
  );
  const total = sumRationals(eligibleWeights);
  if (
    pool.selection !== 'enumeration' &&
    pool.complete &&
    resolved &&
    total.compare(Rational.zero) > 0
  ) {
    for (const candidate of candidates) {
      const probability =
        candidate.eligibility === 'true' && candidate.weight !== undefined
          ? Rational.parse(candidate.weight.decimal)!.divide(total)
          : Rational.zero;
      candidate.conditionalProbability = probability.toNumber();
      candidate.exactConditionalProbability = probability.toJSON();
    }
  } else if (pool.selection !== 'enumeration' && pool.complete && resolved && total.isZero())
    unresolved.push({
      code: 'SCOPE_POOL_ZERO_TOTAL',
      message: `Scope pool ${pool.id} has no positive eligible weight`,
      path: pool.id,
    });

  return {
    id: pool.id,
    bindAs: pool.bindAs ?? 'THIS',
    selection: pool.selection,
    poolComplete: pool.complete,
    candidates,
    eligibleCandidateIds: candidates
      .filter(({ eligibility }) => eligibility === 'true')
      .map(({ id }) => id),
    unresolvedCandidateIds: candidates
      .filter(
        ({ eligibility, unresolved: items }) => eligibility === 'unresolved' || items.length > 0,
      )
      .map(({ id }) => id),
    ...(pool.selection !== 'enumeration' && resolved ? { poolTotal: total.toJSON() } : {}),
    unresolved,
  };
}

export function evaluateScopePools(
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
): ScopePoolAnalysis[] {
  return [...(scenario.scopePools ?? [])]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((pool) => evaluatePool(scenario, pool, definitions));
}

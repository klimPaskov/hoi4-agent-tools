import type { z } from 'zod/v4';
import { defaultPatterns, type CoreEngine } from '../core/engine.js';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { closureEngineResponseSchema } from '../schemas/mod-tools.js';
import type { scriptValidateDataSchema } from '../schemas/script-validation.js';
import { modIndexEngineRequest, SOURCE_ROOT_KINDS } from './mod-index.js';

type Output = z.infer<typeof scriptValidateDataSchema>;
type Closure = NonNullable<Output['closure']>;

const CLOSURE_REQUEST_SCHEMA = 'hoi4-closure-request/1';
/** A cold index of the game, its DLC and a large mod, plus the semantic scan of the mod's sources. */
const CLOSURE_TIMEOUT_MS = 180_000;

/** One plain sentence on the closure, for the validation message. */
export function closureMessage(closure: Closure): string {
  const { resolved, unresolved, unknown } = closure.totals;
  return `Closure ${closure.verdict}: ${resolved} resolved, ${unresolved} unresolved, ${unknown} unknown references in ${closure.sources} sources`;
}

/**
 * The closure option of `hoi4.script_validate` (ADR 0083): whether the definitions the mod's own
 * sources point at exist. The shared Rust engine indexes the game, its DLC and the mod, counts the
 * mod's references per target kind and decides the verdict; a missing engine is
 * `ENGINE_UNAVAILABLE`, never a TypeScript scan.
 */
export async function checkClosure(
  engine: CoreEngine,
  workspaceId: string,
  principal?: string,
  signal?: AbortSignal,
): Promise<Output> {
  signal?.throwIfAborted();
  await engine.resolver.refreshDescriptors(workspaceId, principal);
  const workspace = engine.resolver.get(workspaceId, principal);
  const answered = await runEngineCommand(
    'closure',
    {
      ...modIndexEngineRequest(workspace, engine.resolver.config(), SOURCE_ROOT_KINDS),
      schema: CLOSURE_REQUEST_SCHEMA,
      patterns: defaultPatterns(workspace),
    },
    closureEngineResponseSchema,
    { timeoutMs: CLOSURE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  if (!answered.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', answered.message, { reason: answered.reason });
  if (answered.outcome === 'invalid_request')
    throw new ServiceError(answered.error.code, answered.error.message);
  const response = answered.response;
  const reasons: string[] = [];
  if (response.totals.unknown > 0)
    reasons.push(
      `${response.totals.unknown} references cannot be decided: their target is dynamic, a skipped source may define it, or a variable, flag or event target is read with no visible writer`,
    );
  if (!response.complete)
    reasons.push(
      `The index skipped ${response.skippedSourceCount} sources that exceed a parsing limit, so a definition may be missing`,
    );
  if (!response.semanticComplete)
    reasons.push('The reference scan skipped a source or reached its ceiling');
  const closure: Closure = {
    verdict: response.verdict,
    revision: response.revision,
    complete: response.complete,
    semanticComplete: response.semanticComplete,
    skippedSourceCount: response.skippedSourceCount,
    sources: response.sources,
    totals: response.totals,
    kinds: response.kinds,
  };
  return {
    valid: response.verdict === 'closed' ? true : response.verdict === 'unresolved' ? false : null,
    checksPerformed: ['closure'],
    parametersChecked: false,
    findings: [],
    totalFindings: 0,
    omittedFindings: 0,
    checkedCommands: 0,
    unresolvedCount: 0,
    truncated: false,
    argumentBlocksUnchecked: 0,
    ...(reasons.length === 0 ? {} : { partialReasons: reasons.slice(0, 5) }),
    closure,
  };
}

import { compareCodeUnits } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine } from '../core/engine.js';
import { emptyServiceResult, type ServiceResult } from '../core/result.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import type { ProposedFileChange, TransactionManifest } from '../core/transactions.js';
import {
  localisationWriteDataSchema,
  type LocalisationWriteData,
  type LocalisationWriteRequest,
} from '../schemas/localisation-write.js';
import { documentDiff } from './write-diff.js';
import {
  planAdd,
  planFix,
  type ChangeKind,
  type LocalisationPlan,
  type PlanOptions,
  type PlannedFile,
} from './write-plan.js';

export interface LocalisationOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
  /** Replaces the engine query for keys the script uses and no language defines (tests). */
  undefinedKeys?: PlanOptions['undefinedKeys'];
}

const SHOWN_FILES = 10;
const SHOWN_CHANGES = 6;
const SHOWN_LISTED = 15;
const DIFF_BUDGET_TOTAL = 10_000;
/** The whole result must stay under the 32 KiB wire budget with its envelope. */
const DATA_BUDGET_BYTES = 22_000;
const MAX_INLINE_ARTIFACTS = 2;
const MAX_INLINE_PATHS = 64;
const MAX_CONSULTED_DEPENDENCIES = 8_000;

export async function computeLocalisationPlan(
  engine: CoreEngine,
  input: LocalisationWriteRequest,
  context: LocalisationOperationContext,
): Promise<LocalisationPlan> {
  const options: PlanOptions = {
    workspace: engine.resolver.get(context.workspaceId, context.principal),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.undefinedKeys === undefined ? {} : { undefinedKeys: context.undefinedKeys }),
  };
  return input.mode === 'add' ? planAdd(options, input) : planFix(options, input);
}

function summarizeFile(
  file: PlannedFile,
  diffBudget: number,
): LocalisationWriteData['files'][number] {
  const { diff, truncated } = documentDiff(file.document, file.path, diffBudget);
  const shown = file.changes.slice(0, SHOWN_CHANGES);
  return {
    path: file.path,
    action: file.action,
    diff,
    diffTruncated: truncated,
    changes: shown.map(({ kind, key, line }) => ({
      kind,
      ...(key === undefined ? {} : { key }),
      ...(line === undefined ? {} : { line }),
    })),
    changesOmitted: file.changes.length - shown.length,
  };
}

/** The tool's data, bounded so the whole result stays under the wire budget. */
export function summarizePlan(
  mode: 'add' | 'fix',
  plan: LocalisationPlan,
  applied: boolean,
): LocalisationWriteData {
  const shownFiles = plan.files.slice(0, SHOWN_FILES);
  let budget = Math.floor(DIFF_BUDGET_TOTAL / Math.max(1, shownFiles.length));
  const build = (diffBudget: number): LocalisationWriteData => ({
    mode,
    applied,
    files: shownFiles.map((file) => summarizeFile(file, diffBudget)),
    skipped: plan.skipped.slice(0, SHOWN_LISTED).map(({ key, reason }) => ({
      key,
      reason: reason.slice(0, 300),
    })),
    unfixable: plan.unfixable.slice(0, SHOWN_LISTED).map((item) => ({
      kind: item.kind,
      ...(item.path === undefined ? {} : { path: item.path.slice(0, 1024) }),
      ...(item.key === undefined ? {} : { key: item.key }),
      reason: item.reason.slice(0, 300),
    })),
    notes: plan.notes.slice(0, 10).map((note) => note.slice(0, 400)),
    counts: {
      filesChanged: plan.files.length,
      filesCreated: plan.files.filter(({ action }) => action === 'create').length,
      filesOmitted: plan.files.length - shownFiles.length,
      keysAdded: plan.counts.keysAdded,
      keysReplaced: plan.counts.keysReplaced,
      keysOverridden: plan.counts.keysOverridden,
      keysSkipped: plan.skipped.length,
      skippedOmitted: Math.max(0, plan.skipped.length - SHOWN_LISTED),
      bomsAdded: plan.counts.bomsAdded,
      quotesFixed: plan.counts.quotesFixed,
      keysCopied: plan.counts.keysCopied,
      unfixable: plan.unfixable.length,
      unfixableOmitted: Math.max(0, plan.unfixable.length - SHOWN_LISTED),
    },
  });
  let data = build(budget);
  for (let round = 0; round < 5 && JSON.stringify(data).length > DATA_BUDGET_BYTES; round += 1) {
    budget = Math.floor(budget / 2);
    data = build(budget);
  }
  return localisationWriteDataSchema.parse(data);
}

function inlineDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const hard = (diagnostic: Diagnostic): boolean =>
    diagnostic.severity === 'error' || diagnostic.severity === 'blocker';
  return [...diagnostics.filter(hard), ...diagnostics.filter((entry) => !hard(entry))].slice(0, 20);
}

export type LocalisationOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: LocalisationWriteData,
  paths: readonly string[],
  outcome: LocalisationOutcome,
): ServiceResult<LocalisationWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? paths.length === 0
        ? 'LOCALISATION_NOTHING_TO_CHANGE'
        : 'LOCALISATION_PREVIEW'
      : outcome === 'applied'
        ? 'LOCALISATION_CHANGES_APPLIED'
        : outcome === 'unchanged'
          ? 'LOCALISATION_CHANGES_UNCHANGED'
          : 'LOCALISATION_CHANGES_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = paths.slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of every file the call would change, and nothing written. */
export async function previewLocalisationWrite(
  engine: CoreEngine,
  input: LocalisationWriteRequest,
  context: LocalisationOperationContext,
): Promise<ServiceResult<LocalisationWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's localisation");
  const plan = await computeLocalisationPlan(engine, input, context);
  const result = resultFor(
    context.workspaceId,
    summarizePlan(input.mode, plan, false),
    plan.files.map(({ path }) => path),
    'preview',
  );
  await context.progress?.(2, 2, 'Localisation preview ready');
  return result;
}

export interface LocalisationRecipe {
  data: LocalisationWriteData;
  paths: string[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareLocalisationWrite(
  engine: CoreEngine,
  input: LocalisationWriteRequest,
  context: LocalisationOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<LocalisationWriteData> }
  | { transaction: TransactionManifest; recipe: LocalisationRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's localisation");
  const plan = await computeLocalisationPlan(engine, input, context);
  const data = summarizePlan(input.mode, plan, true);
  const paths = plan.files.map(({ path }) => path);
  if (plan.files.length === 0)
    return {
      readOnlyPreview: resultFor(
        context.workspaceId,
        { ...data, applied: false },
        paths,
        'unchanged',
      ),
    };

  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const kinds = new Map<ChangeKind, number>();
  const changes: ProposedFileChange[] = plan.files.map((file) => {
    for (const change of file.changes) kinds.set(change.kind, (kinds.get(change.kind) ?? 0) + 1);
    return {
      relativePath: file.path,
      content: file.after,
      operationIds: [...new Set(file.changes.map(({ kind }) => `localisation-${kind}`))].sort(
        compareCodeUnits,
      ),
      mediaType: 'text/plain',
    };
  });
  const changedPaths = new Set(paths);
  const consulted = plan.consulted.filter(({ path }) =>
    plan.consulted.length <= MAX_CONSULTED_DEPENDENCIES ? true : changedPaths.has(path),
  );
  await context.progress?.(1, 3, 'Preparing the localisation transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'localisation-changes',
    operations: [...kinds]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([kind, count]) => ({
        id: `localisation-${kind}`,
        kind: `localisation-${kind}`,
        summary: `${kind.replaceAll('_', ' ')}: ${count}`,
        data: { count },
      })),
    changes,
    readDependencies: consulted.map(({ path, sha256 }) => ({
      rootKind: 'mod' as const,
      loadOrder: modRoot?.loadOrder ?? 0,
      relativePath: path,
      sha256,
    })),
    validate: (proposed, signal) => {
      signal?.throwIfAborted();
      const matches = changes.every(({ relativePath, content }) => {
        const bytes = proposed.get(relativePath);
        return (
          bytes !== undefined &&
          bytes !== null &&
          content !== null &&
          Buffer.from(bytes).equals(Buffer.from(content))
        );
      });
      return Promise.resolve({
        diagnostics: matches
          ? []
          : [
              {
                code: 'LOCALISATION_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned localisation files',
              },
            ],
        checks: [
          {
            id: 'localisation-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned localisation files'
              : 'Transaction bytes differ from the planned localisation files',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Localisation change prepared for journaled application');
  return { transaction, recipe: { data, paths } };
}

export function completeLocalisationWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<LocalisationWriteData> {
  const parsed = recipe as LocalisationRecipe;
  const data = localisationWriteDataSchema.parse({
    ...parsed.data,
    applied: execution.outcome === 'applied',
  });
  const transaction = execution.transaction;
  const result = resultFor(workspaceId, data, parsed.paths, execution.outcome);
  result.status = transaction.validation.passed ? 'ok' : 'blocked';
  result.changedFiles = transaction.appliedFiles.slice(0, MAX_INLINE_PATHS);
  result.diagnostics = inlineDiagnostics(transaction.diagnostics);
  result.artifacts = autonomousResultArtifacts(execution).slice(0, MAX_INLINE_ARTIFACTS);
  result.validation = transaction.validation;
  result.blockers = transaction.diagnostics
    .filter(({ severity }) => severity === 'error' || severity === 'blocker')
    .slice(0, 20)
    .map(({ code, message, details }) => ({
      code,
      message,
      ...(details === undefined ? {} : { details }),
    }));
  return result;
}

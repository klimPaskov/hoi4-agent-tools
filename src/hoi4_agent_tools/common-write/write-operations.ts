import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { emptyServiceResult, ServiceError, type ServiceResult } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import type { TransactionManifest } from '../core/transactions.js';
import {
  commonWriteDataSchema,
  type CommonWriteData,
  type CommonWriteRequest,
} from '../schemas/common-write.js';
import { documentedLists } from './documented-lists.js';
import {
  planCommonWrite,
  planNewCommonFile,
  type CommonWriteKind,
  type CommonWritePlan,
  type CommonWritePlanInput,
} from './write-plan.js';

export interface CommonWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;

/**
 * Where each kind lives, for choosing the file. The engine's descriptor owns the folder rule and
 * refuses a path outside it; this table only narrows the scan to the kind's files.
 */
const FOLDERS: Record<CommonWriteKind, string> = {
  bop: 'common/bop/',
  ai_strategy: 'common/ai_strategy/',
  ai_strategy_plan: 'common/ai_strategy_plans/',
  on_action: 'common/on_actions/',
};

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

function normalized(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

/** The mod files of the kind, the ones this tool may write. */
function modFiles(snapshot: ScanSnapshot, kind: CommonWriteKind): ScannedFile[] {
  return snapshot.files.filter(
    ({ rootKind, shadowedBy, relativePath }) =>
      rootKind === 'mod' &&
      shadowedBy === undefined &&
      normalized(relativePath).startsWith(FOLDERS[kind]) &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

type CommonWriteTarget = { file: ScannedFile } | { newPath: string };

/**
 * The mod files that define the id, found by asking the engine to plan a removal of it from each:
 * a file without the id answers "not found", a file that cannot be read answers nothing about it.
 */
async function holders(files: ScannedFile[], input: CommonWriteRequest): Promise<ScannedFile[]> {
  const found: ScannedFile[] = [];
  for (const file of files) {
    try {
      await planCommonWrite(
        { bytes: file.bytes, path: file.relativePath },
        { kind: input.kind, operation: 'remove', id: input.id },
      );
      found.push(file);
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      if (error.code === 'COMMON_WRITE_NOT_FOUND' || error.code === 'COMMON_WRITE_SOURCE_INVALID')
        continue;
      found.push(file);
    }
  }
  return found;
}

async function targetFile(
  snapshot: ScanSnapshot,
  input: CommonWriteRequest,
): Promise<CommonWriteTarget> {
  const files = modFiles(snapshot, input.kind);
  const folder = FOLDERS[input.kind];
  const listed = files.map(({ relativePath }) => relativePath).slice(0, 20);
  if (input.createFile === true && input.operation !== 'add')
    fail('COMMON_WRITE_FILE_UNEXPECTED', 'createFile applies to add only', {});
  if (input.file !== undefined) {
    const named = files.find(
      ({ relativePath }) => normalized(relativePath) === normalized(input.file!),
    );
    if (named !== undefined) {
      if (input.createFile === true)
        // The file exists, so the flag has nothing to create; refusing keeps a wrong guess visible.
        fail(
          'COMMON_WRITE_FILE_EXISTS',
          `${named.relativePath} already exists; drop createFile to add to it`,
          { file: named.relativePath },
        );
      return { file: named };
    }
    if (input.operation !== 'add' || input.createFile !== true)
      fail(
        'COMMON_WRITE_FILE_NOT_FOUND',
        `${input.file} is not a ${folder} file of the mod${input.operation === 'add' ? '; pass createFile: true to create it' : ''}`,
        { file: input.file, files: listed },
      );
    return { newPath: input.file.replaceAll('\\', '/').replace(/^\.\//u, '') };
  }
  const holding = await holders(files, input);
  if (input.operation === 'add') {
    if (input.createFile === true)
      fail('COMMON_WRITE_FILE_REQUIRED', 'createFile needs file, the path of the new file', {
        files: listed,
      });
    if (holding.length > 0 && input.kind !== 'on_action')
      fail('COMMON_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: holding[0]?.relativePath,
      });
    const choices = holding.length > 0 ? holding : files;
    if (choices.length === 1) return { file: choices[0]! };
    fail(
      'COMMON_WRITE_FILE_REQUIRED',
      choices.length === 0
        ? `The mod has no ${folder} file; name a new one with file and createFile: true`
        : `${choices.length} files of the mod could hold ${input.id}; name one with file`,
      { files: choices.map(({ relativePath }) => relativePath).slice(0, 20) },
    );
  }
  if (holding.length === 0)
    fail('COMMON_WRITE_NOT_FOUND', `${input.id} is not defined in a ${folder} file of the mod`, {
      id: input.id,
      files: listed,
    });
  if (holding.length > 1)
    fail(
      'COMMON_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${holding.length} files; name one with file`,
      { files: holding.map(({ relativePath }) => relativePath) },
    );
  return { file: holding[0]! };
}

export interface CommonWriteComputed {
  plan: CommonWritePlan;
  /** The file the write changes; absent when the call creates the file. */
  file: ScannedFile | undefined;
  data: CommonWriteData;
  diagnostics: Diagnostic[];
}

export async function computeCommonWrite(
  engine: CoreEngine,
  input: CommonWriteRequest,
  context: CommonWriteOperationContext,
  applied: boolean,
): Promise<CommonWriteComputed> {
  const snapshot = await engine.scan(
    context.workspaceId,
    {
      patterns: [
        `${FOLDERS[input.kind]}**/*.txt`,
        'common/decisions/**/*.txt',
        'common/national_focus/**/*.txt',
        'interface/**/*.gfx',
        'localisation/english/**/*.{yml,yaml}',
        'localisation/*.{yml,yaml}',
      ],
    },
    context.principal,
    context.signal,
  );
  const lists =
    input.operation === 'remove'
      ? { tokens: undefined, names: undefined }
      : await documentedLists(engine, context.workspaceId, context.principal, context.signal);
  const planInput: CommonWritePlanInput = {
    kind: input.kind,
    operation: input.operation,
    id: input.id,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.blockIndex === undefined ? {} : { blockIndex: input.blockIndex }),
    ...(input.kind === 'ai_strategy' && lists.tokens !== undefined
      ? { knownTokens: lists.tokens }
      : {}),
    ...(input.kind === 'on_action' && lists.names !== undefined ? { knownNames: lists.names } : {}),
  };
  const target = await targetFile(snapshot, input);
  let file: ScannedFile | undefined;
  let plan: CommonWritePlan;
  if ('file' in target) {
    file = target.file;
    plan = await planCommonWrite({ bytes: file.bytes, path: file.relativePath }, planInput);
  } else {
    plan = await planNewCommonFile(target.newPath, planInput);
  }
  const missing: CommonWriteData['missing'] = {
    localisation: [],
    sprites: [],
    categories: [],
    focuses: [],
  };
  const diagnostics: Diagnostic[] = plan.findings.map(({ code, severity, message }) => ({
    code: `COMMON_WRITE_${code}`,
    severity,
    category: 'reference',
    message,
    details: { id: plan.id },
  }));
  if (input.operation !== 'remove') {
    for (const key of plan.references.localisation)
      if (snapshot.index.find('localisation', `l_english:${key}`) === undefined)
        missing.localisation.push(key);
    for (const sprite of plan.references.sprites)
      if (snapshot.index.find('sprite', sprite) === undefined) missing.sprites.push(sprite);
    for (const category of plan.references.categories)
      if (snapshot.index.find('decision_category', category) === undefined)
        missing.categories.push(category);
    for (const focus of plan.references.focuses)
      if (snapshot.index.find('focus', focus) === undefined) missing.focuses.push(focus);
    const lines: Array<[keyof CommonWriteData['missing'], string, string]> = [
      [
        'localisation',
        'LOCALISATION_MISSING',
        'No English text is defined for the localisation key',
      ],
      ['sprites', 'SPRITE_UNDEFINED', 'The sprite is not defined:'],
      ['categories', 'CATEGORY_UNDEFINED', 'No decision category is defined with the name'],
      ['focuses', 'FOCUS_UNDEFINED', 'No focus is defined with the id'],
    ];
    for (const [field, code, text] of lines)
      for (const name of missing[field])
        diagnostics.push({
          code: `COMMON_WRITE_${code}`,
          severity: 'warning',
          category: 'reference',
          message: `${text} ${name}`,
          details: { name },
        });
  }
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = commonWriteDataSchema.parse({
    operation: plan.operation,
    kind: plan.kind,
    id: plan.id,
    path: plan.path,
    applied,
    diff: budget ? `${plan.diff.slice(0, DIFF_BUDGET_BYTES)}\n` : plan.diff,
    diffTruncated: budget,
    untouchedDefinitions: plan.untouchedDefinitions,
    findings: plan.findings,
    missing,
  });
  return { plan, file, data, diagnostics };
}

export type CommonWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: CommonWriteData,
  outcome: CommonWriteOutcome,
): ServiceResult<CommonWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'COMMON_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'COMMON_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'COMMON_WRITE_UNCHANGED'
          : 'COMMON_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewCommonWrite(
  engine: CoreEngine,
  input: CommonWriteRequest,
  context: CommonWriteOperationContext,
): Promise<ServiceResult<CommonWriteData>> {
  await context.progress?.(0, 2, 'Reading the definitions of the mod');
  const computed = await computeCommonWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.file !== undefined && computed.plan.bytes.equals(computed.file.bytes)
      ? 'unchanged'
      : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Definition preview ready');
  return result;
}

export interface CommonWriteRecipe {
  data: CommonWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareCommonWrite(
  engine: CoreEngine,
  input: CommonWriteRequest,
  context: CommonWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<CommonWriteData> }
  | { transaction: TransactionManifest; recipe: CommonWriteRecipe }
> {
  await context.progress?.(0, 3, 'Reading the definitions of the mod');
  const computed = await computeCommonWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (file !== undefined && plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `common-${plan.kind}-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the definition transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'common-changes',
    operations: [
      {
        id: operationId,
        kind: operationId,
        summary: `${plan.operation} ${plan.id} (${plan.kind})`,
        data: { id: plan.id, kind: plan.kind },
      },
    ],
    changes: [
      {
        relativePath: plan.path,
        content: plan.bytes,
        operationIds: [operationId],
        mediaType: 'text/plain',
      },
    ],
    readDependencies:
      file === undefined
        ? []
        : [
            {
              rootKind: 'mod' as const,
              loadOrder: modRoot?.loadOrder ?? 0,
              relativePath: file.relativePath,
              sha256: file.sha256,
            },
          ],
    validate: (proposed, signal) => {
      signal?.throwIfAborted();
      const bytes = proposed.get(plan.path);
      const matches =
        bytes !== undefined && bytes !== null && Buffer.from(bytes).equals(plan.bytes);
      return Promise.resolve({
        diagnostics: matches
          ? []
          : [
              {
                code: 'COMMON_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned file',
              },
            ],
        checks: [
          {
            id: 'common-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned file'
              : 'Transaction bytes differ from the planned file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Definition change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeCommonWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<CommonWriteData> {
  const parsed = recipe as CommonWriteRecipe;
  const data = commonWriteDataSchema.parse({
    ...parsed.data,
    applied: execution.outcome === 'applied',
  });
  const transaction = execution.transaction;
  const result = resultFor(workspaceId, data, execution.outcome);
  result.status = transaction.validation.passed ? 'ok' : 'blocked';
  result.changedFiles = transaction.appliedFiles.slice(0, MAX_INLINE_PATHS);
  const hard = transaction.diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  result.diagnostics = [...hard, ...parsed.diagnostics].slice(0, 20);
  result.artifacts = autonomousResultArtifacts(execution).slice(0, MAX_INLINE_ARTIFACTS);
  result.validation = transaction.validation;
  result.blockers = hard.slice(0, 20).map(({ code, message, details }) => ({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  }));
  return result;
}

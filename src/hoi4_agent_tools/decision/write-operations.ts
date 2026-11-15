import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { emptyServiceResult, ServiceError, type ServiceResult } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { assignments, parseClausewitz } from '../core/source/index.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import type { TransactionManifest } from '../core/transactions.js';
import {
  decisionWriteDataSchema,
  type DecisionWriteData,
  type DecisionWriteRequest,
} from '../schemas/decision-write.js';
import {
  decisionCategories,
  planDecisionWrite,
  planNewDecisionFile,
  type DecisionWritePlan,
} from './write-plan.js';

export interface DecisionWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;
/** The sources a write needs: the mod's decisions, and the sprites and English text it refers to. */
const WRITE_PATTERNS = [
  'common/decisions/**/*.txt',
  'interface/**/*.gfx',
  'localisation/english/**/*.{yml,yaml}',
  'localisation/*.{yml,yaml}',
];

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

function normalized(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

/** The mod's own `common/decisions` files, the ones this tool may write. */
function modDecisionFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files.filter(
    ({ rootKind, shadowedBy, relativePath }) =>
      rootKind === 'mod' &&
      shadowedBy === undefined &&
      normalized(relativePath).startsWith('common/decisions/') &&
      !normalized(relativePath).startsWith('common/decisions/categories/') &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

/** The file the operation writes: an existing mod file, or the path of one createFile makes. */
type DecisionWriteTarget = { file: ScannedFile } | { newPath: string };

/** A path createFile may make: a .txt file under common/decisions, inside the mod. */
function newDecisionFilePath(file: string): string {
  const path = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    !normalized(path).startsWith('common/decisions/') ||
    normalized(path).startsWith('common/decisions/categories/') ||
    !path.toLowerCase().endsWith('.txt') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail(
      'DECISION_WRITE_FILE_INVALID',
      `${file} is not a .txt file under common/decisions (outside categories), so a new decision file cannot go there`,
      { file },
    );
  return path;
}

/** The file the operation writes: the one named, the one that defines the decision, or the one with the category. */
function targetFile(snapshot: ScanSnapshot, input: DecisionWriteRequest): DecisionWriteTarget {
  const files = modDecisionFiles(snapshot);
  if (input.file !== undefined) {
    const named = files.find(
      ({ relativePath }) => normalized(relativePath) === normalized(input.file!),
    );
    if (named !== undefined) {
      if (input.operation === 'add' && input.createFile === true)
        // The file exists, so the flag has nothing to create; refusing keeps a wrong guess visible.
        fail(
          'DECISION_WRITE_FILE_EXISTS',
          `${named.relativePath} already exists; drop createFile to add to it`,
          { file: named.relativePath },
        );
      return { file: named };
    }
    if (input.operation !== 'add' || input.createFile !== true)
      fail(
        'DECISION_WRITE_FILE_NOT_FOUND',
        `${input.file} is not a common/decisions file of the mod${input.operation === 'add' ? '; pass createFile: true to create it' : ''}`,
        { file: input.file, files: files.map(({ relativePath }) => relativePath).slice(0, 20) },
      );
    return { newPath: newDecisionFilePath(input.file) };
  }
  const definitions = snapshot.index.findAll('decision', input.id);
  const inMod = definitions.filter(({ path }) => path.startsWith('mod:'));
  if (input.operation === 'add') {
    if (inMod.length > 0)
      fail('DECISION_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod[0]?.path,
      });
    if (input.category === undefined)
      fail('DECISION_WRITE_CATEGORY_REQUIRED', 'add needs the category block the decision goes in');
    const category = input.category;
    const holding = files.filter(({ bytes, relativePath }) =>
      decisionCategories({ bytes, path: relativePath }).includes(category),
    );
    if (holding.length === 0) {
      if (input.createCategory === true) {
        if (files.length === 1) return { file: files[0]! };
        fail(
          'DECISION_WRITE_FILE_REQUIRED',
          files.length === 0
            ? 'The mod has no common/decisions file; name a new one with file and createFile: true'
            : `${files.length} files of the mod could hold the new ${category} category; name one with file`,
          { files: files.map(({ relativePath }) => relativePath).slice(0, 20) },
        );
      }
      fail(
        'DECISION_WRITE_CATEGORY_NOT_FOUND',
        `No common/decisions file of the mod has a ${category} category; pass createCategory: true to create it`,
        {
          category,
          categories: [
            ...new Set(
              files.flatMap(({ bytes, relativePath }) =>
                decisionCategories({ bytes, path: relativePath }),
              ),
            ),
          ],
        },
      );
    }
    if (holding.length > 1)
      fail(
        'DECISION_WRITE_FILE_REQUIRED',
        `${holding.length} files of the mod have a ${category} category; name one with file`,
        {
          files: holding.map(({ relativePath }) => relativePath),
        },
      );
    return { file: holding[0]! };
  }
  if (inMod.length === 0) {
    if (definitions.length > 0)
      fail(
        'DECISION_WRITE_NOT_IN_MOD',
        `${input.id} is defined in the game files, not in the mod; add it to a mod file to override it`,
        { id: input.id, path: definitions[0]?.path },
      );
    fail('DECISION_WRITE_NOT_FOUND', `${input.id} is not defined`, { id: input.id });
  }
  const paths = [...new Set(inMod.map(({ path }) => path))];
  if (paths.length > 1)
    fail(
      'DECISION_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${paths.length} files; name one with file`,
      {
        files: paths,
      },
    );
  const found = files.find(({ displayPath }) => displayPath === paths[0]);
  if (found === undefined)
    fail('DECISION_WRITE_NOT_FOUND', `${input.id} is not in an active mod file`, {
      path: paths[0],
    });
  return { file: found };
}

/**
 * The localisation key and the icon sprite the body names, from the body itself. A decision's name
 * and description keys are its id and `<id>_desc`, unless the body names a `name`.
 */
function referencesOf(id: string, body: string): { name: string; icon: string | undefined } {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'decision-body');
  const block = assignments(probe.root, id)[0]?.value;
  const scalar = (key: string): string | undefined => {
    const entry = block?.type === 'block' ? assignments(block, key)[0] : undefined;
    return entry?.value.type === 'scalar' ? entry.value.value : undefined;
  };
  const icon = scalar('icon');
  return {
    name: scalar('name') ?? id,
    icon: icon === undefined ? undefined : icon.startsWith('GFX_') ? icon : `GFX_decision_${icon}`,
  };
}

export interface DecisionWriteComputed {
  plan: DecisionWritePlan;
  /** The file the write changes; absent when the call creates the file. */
  file: ScannedFile | undefined;
  data: DecisionWriteData;
  diagnostics: Diagnostic[];
}

export async function computeDecisionWrite(
  engine: CoreEngine,
  input: DecisionWriteRequest,
  context: DecisionWriteOperationContext,
  applied: boolean,
): Promise<DecisionWriteComputed> {
  const snapshot = await engine.scan(
    context.workspaceId,
    { patterns: WRITE_PATTERNS },
    context.principal,
    context.signal,
  );
  const target = targetFile(snapshot, input);
  const planInput = {
    operation: input.operation,
    id: input.id,
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.createCategory === undefined ? {} : { createCategory: input.createCategory }),
    ...(input.body === undefined ? {} : { body: input.body }),
  };
  let file: ScannedFile | undefined;
  let plan: DecisionWritePlan;
  if ('file' in target) {
    file = target.file;
    plan = planDecisionWrite({ bytes: file.bytes, path: file.relativePath }, planInput);
  } else {
    const inMod = snapshot.index
      .findAll('decision', input.id)
      .find(({ path }) => path.startsWith('mod:'));
    if (inMod !== undefined)
      fail('DECISION_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod.path,
      });
    plan = planNewDecisionFile(target.newPath, planInput);
  }
  const missing: DecisionWriteData['missing'] = { localisation: [], icon: [], category: [] };
  const diagnostics: Diagnostic[] = [];
  if (
    input.operation === 'add' &&
    snapshot.index.find('decision_category', plan.category) === undefined
  ) {
    missing.category.push(plan.category);
    diagnostics.push({
      code: 'DECISION_WRITE_CATEGORY_UNDEFINED',
      severity: 'warning',
      category: 'reference',
      message: `No decision category ${plan.category} is defined in common/decisions/categories, so the game will not show these decisions`,
      details: { category: plan.category },
    });
  }
  if (input.operation !== 'remove' && input.body !== undefined) {
    const { name, icon } = referencesOf(input.id, input.body);
    if (snapshot.index.find('localisation', `l_english:${name}`) === undefined) {
      missing.localisation.push(name);
      diagnostics.push({
        code: 'DECISION_WRITE_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `No English text is defined for the localisation key ${name}; hoi4.localisation_write adds it`,
        details: { key: name },
      });
    }
    if (icon !== undefined && snapshot.index.find('sprite', icon) === undefined) {
      missing.icon.push(icon);
      diagnostics.push({
        code: 'DECISION_WRITE_ICON_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The sprite ${icon} is not defined, so the decision shows no icon`,
        details: { sprite: icon },
      });
    }
  }
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = decisionWriteDataSchema.parse({
    operation: plan.operation,
    id: plan.id,
    category: plan.category,
    path: plan.path,
    applied,
    diff: budget ? `${plan.diff.slice(0, DIFF_BUDGET_BYTES)}\n` : plan.diff,
    diffTruncated: budget,
    untouchedDefinitions: plan.untouchedDefinitions,
    missing,
  });
  return { plan, file, data, diagnostics };
}

export type DecisionWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: DecisionWriteData,
  outcome: DecisionWriteOutcome,
): ServiceResult<DecisionWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'DECISION_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'DECISION_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'DECISION_WRITE_UNCHANGED'
          : 'DECISION_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewDecisionWrite(
  engine: CoreEngine,
  input: DecisionWriteRequest,
  context: DecisionWriteOperationContext,
): Promise<ServiceResult<DecisionWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's decisions");
  const computed = await computeDecisionWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.file !== undefined && computed.plan.bytes.equals(computed.file.bytes)
      ? 'unchanged'
      : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Decision preview ready');
  return result;
}

export interface DecisionWriteRecipe {
  data: DecisionWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareDecisionWrite(
  engine: CoreEngine,
  input: DecisionWriteRequest,
  context: DecisionWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<DecisionWriteData> }
  | { transaction: TransactionManifest; recipe: DecisionWriteRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's decisions");
  const computed = await computeDecisionWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (file !== undefined && plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `decision-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the decision transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'decision-changes',
    operations: [
      {
        id: operationId,
        kind: operationId,
        summary: `${plan.operation} ${plan.id} in ${plan.category}`,
        data: { id: plan.id, category: plan.category },
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
                code: 'DECISION_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned decision file',
              },
            ],
        checks: [
          {
            id: 'decision-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned decision file'
              : 'Transaction bytes differ from the planned decision file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Decision change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeDecisionWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<DecisionWriteData> {
  const parsed = recipe as DecisionWriteRecipe;
  const data = decisionWriteDataSchema.parse({
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

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
  ideaWriteDataSchema,
  type IdeaWriteData,
  type IdeaWriteRequest,
} from '../schemas/idea-write.js';
import { ideaCategories, planIdeaWrite, type IdeaWritePlan } from './write-plan.js';

export interface IdeaWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;
/** The sources a write needs: the mod's ideas, and the sprites and English text it refers to. */
const WRITE_PATTERNS = [
  'common/ideas/**/*.txt',
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

/** The mod's own `common/ideas` files, the ones this tool may write. */
function modIdeaFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files.filter(
    ({ rootKind, shadowedBy, relativePath }) =>
      rootKind === 'mod' &&
      shadowedBy === undefined &&
      normalized(relativePath).startsWith('common/ideas/') &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

/** The file the operation writes: the one named, the one that defines the idea, or the one with the category. */
function targetFile(snapshot: ScanSnapshot, input: IdeaWriteRequest): ScannedFile {
  const files = modIdeaFiles(snapshot);
  if (input.file !== undefined) {
    const named = files.find(
      ({ relativePath }) => normalized(relativePath) === normalized(input.file!),
    );
    if (named === undefined)
      fail(
        'IDEA_WRITE_FILE_NOT_FOUND',
        `${input.file} is not a common/ideas file of the mod; creating a new file is not supported yet`,
        { file: input.file, files: files.map(({ relativePath }) => relativePath).slice(0, 20) },
      );
    return named;
  }
  const definitions = snapshot.index.findAll('idea', input.id);
  const inMod = definitions.filter(({ path }) => path.startsWith('mod:'));
  if (input.operation === 'add') {
    if (inMod.length > 0)
      fail('IDEA_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod[0]?.path,
      });
    if (input.category === undefined)
      fail('IDEA_WRITE_CATEGORY_REQUIRED', 'add needs the category block the idea goes in');
    const category = input.category;
    const holding = files.filter(({ bytes, relativePath }) =>
      ideaCategories({ bytes, path: relativePath }).includes(category),
    );
    if (holding.length === 0)
      fail(
        'IDEA_WRITE_CATEGORY_NOT_FOUND',
        `No common/ideas file of the mod has a ${category} category, and creating one is not supported yet`,
        {
          category,
          categories: [
            ...new Set(
              files.flatMap(({ bytes, relativePath }) =>
                ideaCategories({ bytes, path: relativePath }),
              ),
            ),
          ],
        },
      );
    if (holding.length > 1)
      fail(
        'IDEA_WRITE_FILE_REQUIRED',
        `${holding.length} files of the mod have a ${category} category; name one with file`,
        {
          files: holding.map(({ relativePath }) => relativePath),
        },
      );
    return holding[0]!;
  }
  if (inMod.length === 0) {
    if (definitions.length > 0)
      fail(
        'IDEA_WRITE_NOT_IN_MOD',
        `${input.id} is defined in the game files, not in the mod; add it to a mod file to override it`,
        { id: input.id, path: definitions[0]?.path },
      );
    fail('IDEA_WRITE_NOT_FOUND', `${input.id} is not defined`, { id: input.id });
  }
  const paths = [...new Set(inMod.map(({ path }) => path))];
  if (paths.length > 1)
    fail(
      'IDEA_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${paths.length} files; name one with file`,
      {
        files: paths,
      },
    );
  const found = files.find(({ displayPath }) => displayPath === paths[0]);
  if (found === undefined)
    fail('IDEA_WRITE_NOT_FOUND', `${input.id} is not in an active mod file`, { path: paths[0] });
  return found;
}

/** The localisation key and the picture the body names, from the body itself. */
function referencesOf(id: string, body: string): { name: string; picture: string | undefined } {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'idea-body');
  const block = assignments(probe.root, id)[0]?.value;
  const scalar = (key: string): string | undefined => {
    const entry = block?.type === 'block' ? assignments(block, key)[0] : undefined;
    return entry?.value.type === 'scalar' ? entry.value.value : undefined;
  };
  return { name: scalar('name') ?? id, picture: scalar('picture') };
}

export interface IdeaWriteComputed {
  plan: IdeaWritePlan;
  file: ScannedFile;
  data: IdeaWriteData;
  diagnostics: Diagnostic[];
}

export async function computeIdeaWrite(
  engine: CoreEngine,
  input: IdeaWriteRequest,
  context: IdeaWriteOperationContext,
  applied: boolean,
): Promise<IdeaWriteComputed> {
  const snapshot = await engine.scan(
    context.workspaceId,
    { patterns: WRITE_PATTERNS },
    context.principal,
    context.signal,
  );
  const file = targetFile(snapshot, input);
  const plan = planIdeaWrite(
    { bytes: file.bytes, path: file.relativePath },
    {
      operation: input.operation,
      id: input.id,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.body === undefined ? {} : { body: input.body }),
    },
  );
  const missing: IdeaWriteData['missing'] = { localisation: [], picture: [] };
  const diagnostics: Diagnostic[] = [];
  if (input.operation !== 'remove' && input.body !== undefined) {
    const { name, picture } = referencesOf(input.id, input.body);
    if (snapshot.index.find('localisation', `l_english:${name}`) === undefined) {
      missing.localisation.push(name);
      diagnostics.push({
        code: 'IDEA_WRITE_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `No English text is defined for the localisation key ${name}; hoi4.localisation_write adds it`,
        details: { key: name },
      });
    }
    if (
      picture !== undefined &&
      snapshot.index.find('sprite', `GFX_idea_${picture}`) === undefined
    ) {
      missing.picture.push(`GFX_idea_${picture}`);
      diagnostics.push({
        code: 'IDEA_WRITE_PICTURE_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The sprite GFX_idea_${picture} is not defined, so the idea shows no picture`,
        details: { sprite: `GFX_idea_${picture}` },
      });
    }
  }
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = ideaWriteDataSchema.parse({
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

export type IdeaWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: IdeaWriteData,
  outcome: IdeaWriteOutcome,
): ServiceResult<IdeaWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'IDEA_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'IDEA_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'IDEA_WRITE_UNCHANGED'
          : 'IDEA_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewIdeaWrite(
  engine: CoreEngine,
  input: IdeaWriteRequest,
  context: IdeaWriteOperationContext,
): Promise<ServiceResult<IdeaWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's ideas");
  const computed = await computeIdeaWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.plan.bytes.equals(computed.file.bytes) ? 'unchanged' : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Idea preview ready');
  return result;
}

export interface IdeaWriteRecipe {
  data: IdeaWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareIdeaWrite(
  engine: CoreEngine,
  input: IdeaWriteRequest,
  context: IdeaWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<IdeaWriteData> }
  | { transaction: TransactionManifest; recipe: IdeaWriteRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's ideas");
  const computed = await computeIdeaWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `idea-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the idea transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'idea-changes',
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
    readDependencies: [
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
                code: 'IDEA_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned idea file',
              },
            ],
        checks: [
          {
            id: 'idea-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned idea file'
              : 'Transaction bytes differ from the planned idea file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Idea change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeIdeaWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<IdeaWriteData> {
  const parsed = recipe as IdeaWriteRecipe;
  const data = ideaWriteDataSchema.parse({
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

import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { emptyServiceResult, ServiceError, type ServiceResult } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { assignments, parseClausewitz, type BlockNode } from '../core/source/index.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import type { TransactionManifest } from '../core/transactions.js';
import {
  characterWriteDataSchema,
  type CharacterWriteData,
  type CharacterWriteRequest,
} from '../schemas/character-write.js';
import { planCharacterWrite, planNewCharacterFile, type CharacterWritePlan } from './write-plan.js';

export interface CharacterWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;
const MAX_PORTRAITS = 10;
/** The sources a write needs: the mod's characters, and the sprites and English text they refer to. */
const WRITE_PATTERNS = [
  'common/characters/**/*.txt',
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

/** The mod's own `common/characters` files, the ones this tool may write. */
function modCharacterFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files.filter(
    ({ rootKind, shadowedBy, relativePath }) =>
      rootKind === 'mod' &&
      shadowedBy === undefined &&
      normalized(relativePath).startsWith('common/characters/') &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

/** The file the operation writes: an existing mod file, or the path of one createFile makes. */
type CharacterWriteTarget = { file: ScannedFile } | { newPath: string };

/** A path createFile may make: a .txt file under common/characters, inside the mod. */
function newCharacterFilePath(file: string): string {
  const path = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    !normalized(path).startsWith('common/characters/') ||
    !path.toLowerCase().endsWith('.txt') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail(
      'CHARACTER_WRITE_FILE_INVALID',
      `${file} is not a .txt file under common/characters, so a new character file cannot go there`,
      { file },
    );
  return path;
}

/** The file the operation writes: the one named, the one that defines the character, or the mod's only one. */
function targetFile(snapshot: ScanSnapshot, input: CharacterWriteRequest): CharacterWriteTarget {
  const files = modCharacterFiles(snapshot);
  const names = files.map(({ relativePath }) => relativePath).slice(0, 20);
  if (input.file !== undefined) {
    const named = files.find(
      ({ relativePath }) => normalized(relativePath) === normalized(input.file!),
    );
    if (named !== undefined) {
      if (input.operation === 'add' && input.createFile === true)
        // The file exists, so the flag has nothing to create; refusing keeps a wrong guess visible.
        fail(
          'CHARACTER_WRITE_FILE_EXISTS',
          `${named.relativePath} already exists; drop createFile to add to it`,
          { file: named.relativePath },
        );
      return { file: named };
    }
    if (input.operation !== 'add' || input.createFile !== true)
      fail(
        'CHARACTER_WRITE_FILE_NOT_FOUND',
        `${input.file} is not a common/characters file of the mod${input.operation === 'add' ? '; pass createFile: true to create it' : ''}`,
        { file: input.file, files: names },
      );
    return { newPath: newCharacterFilePath(input.file) };
  }
  const definitions = snapshot.index.findAll('leader', input.id);
  const inMod = definitions.filter(({ path }) => path.startsWith('mod:'));
  if (input.operation === 'add') {
    if (inMod.length > 0)
      fail('CHARACTER_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod[0]?.path,
      });
    if (files.length === 1) return { file: files[0]! };
    fail(
      'CHARACTER_WRITE_FILE_REQUIRED',
      files.length === 0
        ? 'The mod has no common/characters file; name a new one with file and createFile: true'
        : `${files.length} files of the mod hold characters; name one with file`,
      { files: names },
    );
  }
  if (inMod.length === 0) {
    if (definitions.length > 0)
      fail(
        'CHARACTER_WRITE_NOT_IN_MOD',
        `${input.id} is defined in the game files, not in the mod; add it to a mod file to override it`,
        { id: input.id, path: definitions[0]?.path },
      );
    fail('CHARACTER_WRITE_NOT_FOUND', `${input.id} is not defined`, { id: input.id });
  }
  const paths = [...new Set(inMod.map(({ path }) => path))];
  if (paths.length > 1)
    fail(
      'CHARACTER_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${paths.length} files; name one with file`,
      { files: paths },
    );
  const found = files.find(({ displayPath }) => displayPath === paths[0]);
  if (found === undefined)
    fail('CHARACTER_WRITE_NOT_FOUND', `${input.id} is not in an active mod file`, {
      path: paths[0],
    });
  return { file: found };
}

/** The localisation key and the portrait sprites the body names, from the body itself. */
function referencesOf(id: string, body: string): { name: string | undefined; portraits: string[] } {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'character-body');
  const block = assignments(probe.root, id)[0]?.value;
  const portraits = new Set<string>();
  const walk = (node: BlockNode, inPortraits: boolean): void => {
    for (const entry of assignments(node)) {
      if (entry.value.type === 'block') {
        walk(entry.value, inPortraits || entry.key.value === 'portraits');
      } else if (
        inPortraits &&
        (entry.key.value === 'large' || entry.key.value === 'small') &&
        entry.value.value.startsWith('GFX_')
      )
        portraits.add(entry.value.value);
    }
  };
  if (block?.type === 'block') walk(block, false);
  const name = block?.type === 'block' ? assignments(block, 'name')[0] : undefined;
  return {
    name: name?.value.type === 'scalar' ? name.value.value : undefined,
    portraits: [...portraits],
  };
}

export interface CharacterWriteComputed {
  plan: CharacterWritePlan;
  /** The file the write changes; absent when the call creates the file. */
  file: ScannedFile | undefined;
  data: CharacterWriteData;
  diagnostics: Diagnostic[];
}

export async function computeCharacterWrite(
  engine: CoreEngine,
  input: CharacterWriteRequest,
  context: CharacterWriteOperationContext,
  applied: boolean,
): Promise<CharacterWriteComputed> {
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
    ...(input.body === undefined ? {} : { body: input.body }),
  };
  let file: ScannedFile | undefined;
  let plan: CharacterWritePlan;
  if ('file' in target) {
    file = target.file;
    plan = planCharacterWrite({ bytes: file.bytes, path: file.relativePath }, planInput);
  } else {
    const inMod = snapshot.index
      .findAll('leader', input.id)
      .find(({ path }) => path.startsWith('mod:'));
    if (inMod !== undefined)
      fail('CHARACTER_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod.path,
      });
    plan = planNewCharacterFile(target.newPath, planInput);
  }
  const missing: CharacterWriteData['missing'] = { localisation: [], portrait: [] };
  const diagnostics: Diagnostic[] = [];
  if (input.operation !== 'remove' && input.body !== undefined) {
    const { name, portraits } = referencesOf(input.id, input.body);
    if (
      name !== undefined &&
      snapshot.index.find('localisation', `l_english:${name}`) === undefined
    ) {
      missing.localisation.push(name);
      diagnostics.push({
        code: 'CHARACTER_WRITE_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `No English text is defined for the localisation key ${name}; hoi4.localisation_write adds it`,
        details: { key: name },
      });
    }
    for (const sprite of portraits.slice(0, MAX_PORTRAITS)) {
      if (snapshot.index.find('sprite', sprite) !== undefined) continue;
      missing.portrait.push(sprite);
      diagnostics.push({
        code: 'CHARACTER_WRITE_PORTRAIT_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The sprite ${sprite} is not defined, so the character shows no portrait`,
        details: { sprite },
      });
    }
  }
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = characterWriteDataSchema.parse({
    operation: plan.operation,
    id: plan.id,
    path: plan.path,
    applied,
    diff: budget ? `${plan.diff.slice(0, DIFF_BUDGET_BYTES)}\n` : plan.diff,
    diffTruncated: budget,
    untouchedDefinitions: plan.untouchedDefinitions,
    missing,
  });
  return { plan, file, data, diagnostics };
}

export type CharacterWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: CharacterWriteData,
  outcome: CharacterWriteOutcome,
): ServiceResult<CharacterWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'CHARACTER_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'CHARACTER_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'CHARACTER_WRITE_UNCHANGED'
          : 'CHARACTER_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewCharacterWrite(
  engine: CoreEngine,
  input: CharacterWriteRequest,
  context: CharacterWriteOperationContext,
): Promise<ServiceResult<CharacterWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's characters");
  const computed = await computeCharacterWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.file !== undefined && computed.plan.bytes.equals(computed.file.bytes)
      ? 'unchanged'
      : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Character preview ready');
  return result;
}

export interface CharacterWriteRecipe {
  data: CharacterWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareCharacterWrite(
  engine: CoreEngine,
  input: CharacterWriteRequest,
  context: CharacterWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<CharacterWriteData> }
  | { transaction: TransactionManifest; recipe: CharacterWriteRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's characters");
  const computed = await computeCharacterWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (file !== undefined && plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `character-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the character transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'character-changes',
    operations: [
      {
        id: operationId,
        kind: operationId,
        summary: `${plan.operation} ${plan.id}`,
        data: { id: plan.id },
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
                code: 'CHARACTER_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned character file',
              },
            ],
        checks: [
          {
            id: 'character-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned character file'
              : 'Transaction bytes differ from the planned character file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Character change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeCharacterWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<CharacterWriteData> {
  const parsed = recipe as CharacterWriteRecipe;
  const data = characterWriteDataSchema.parse({
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

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
  eventWriteDataSchema,
  type EventWriteData,
  type EventWriteRequest,
} from '../schemas/event-write.js';
import {
  eventFileContents,
  namespaceOf,
  planEventWrite,
  planNewEventFile,
  type EventWritePlan,
} from './write-plan.js';

export interface EventWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;
const MAX_KEYS = 20;
/** The sources a write needs: the mod's events, and the sprites and English text they refer to. */
const WRITE_PATTERNS = [
  'events/**/*.txt',
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

interface ModEventFile {
  file: ScannedFile;
  ids: string[];
  namespaces: string[];
}

/** The mod's own `events` files, the ones this tool may write, with what each holds. */
function modEventFiles(snapshot: ScanSnapshot): ModEventFile[] {
  return snapshot.files
    .filter(
      ({ rootKind, shadowedBy, relativePath }) =>
        rootKind === 'mod' &&
        shadowedBy === undefined &&
        normalized(relativePath).startsWith('events/') &&
        relativePath.toLowerCase().endsWith('.txt'),
    )
    .map((file) => ({
      file,
      ...eventFileContents({ bytes: file.bytes, path: file.relativePath }),
    }));
}

/** The file the operation writes: an existing mod file, or the path of one createFile makes. */
type EventWriteTarget = { file: ScannedFile } | { newPath: string };

/** A path createFile may make: a .txt file under events, inside the mod. */
function newEventFilePath(file: string): string {
  const path = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    !normalized(path).startsWith('events/') ||
    !path.toLowerCase().endsWith('.txt') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail(
      'EVENT_WRITE_FILE_INVALID',
      `${file} is not a .txt file under events, so a new event file cannot go there`,
      { file },
    );
  return path;
}

function targetFile(
  snapshot: ScanSnapshot,
  files: readonly ModEventFile[],
  input: EventWriteRequest,
): EventWriteTarget {
  const names = files.map(({ file }) => file.relativePath).slice(0, 20);
  if (input.file !== undefined) {
    const named = files.find(
      ({ file }) => normalized(file.relativePath) === normalized(input.file!),
    );
    if (named !== undefined) {
      if (input.operation === 'add' && input.createFile === true)
        // The file exists, so the flag has nothing to create; refusing keeps a wrong guess visible.
        fail(
          'EVENT_WRITE_FILE_EXISTS',
          `${named.file.relativePath} already exists; drop createFile to add to it`,
          { file: named.file.relativePath },
        );
      return { file: named.file };
    }
    if (input.operation !== 'add' || input.createFile !== true)
      fail(
        'EVENT_WRITE_FILE_NOT_FOUND',
        `${input.file} is not an events file of the mod${input.operation === 'add' ? '; pass createFile: true to create it' : ''}`,
        { file: input.file, files: names },
      );
    return { newPath: newEventFilePath(input.file) };
  }
  const definitions = snapshot.index.findAll('event', input.id);
  const inMod = definitions.filter(({ path }) => path.startsWith('mod:'));
  if (input.operation === 'add') {
    if (inMod.length > 0)
      fail('EVENT_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod[0]?.path,
      });
    const namespace = namespaceOf(input.id);
    const sameNamespace = files.filter(({ ids }) =>
      ids.some((id) => namespaceOf(id) === namespace),
    );
    if (sameNamespace.length === 1) return { file: sameNamespace[0]!.file };
    if (sameNamespace.length === 0) {
      const declaring = files.filter(({ namespaces }) => namespaces.includes(namespace));
      if (declaring.length === 1) return { file: declaring[0]!.file };
      if (declaring.length === 0 && files.length === 1) return { file: files[0]!.file };
    }
    fail(
      'EVENT_WRITE_FILE_REQUIRED',
      files.length === 0
        ? 'The mod has no events file; name a new one with file and createFile: true'
        : sameNamespace.length > 1
          ? `${sameNamespace.length} files of the mod hold events of the namespace ${namespace}; name one with file`
          : `No single file of the mod holds the namespace ${namespace}; name one with file`,
      { files: names },
    );
  }
  if (inMod.length === 0) {
    if (definitions.length > 0)
      fail(
        'EVENT_WRITE_NOT_IN_MOD',
        `${input.id} is defined in the game files, not in the mod; add it to a mod file to override it`,
        { id: input.id, path: definitions[0]?.path },
      );
    fail('EVENT_WRITE_NOT_FOUND', `${input.id} is not defined`, { id: input.id });
  }
  const paths = [...new Set(inMod.map(({ path }) => path))];
  if (paths.length > 1)
    fail(
      'EVENT_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${paths.length} files; name one with file`,
      { files: paths },
    );
  const found = files.find(({ file }) => file.displayPath === paths[0]);
  if (found === undefined)
    fail('EVENT_WRITE_NOT_FOUND', `${input.id} is not in an active mod file`, { path: paths[0] });
  return { file: found.file };
}

/** The localisation keys and the picture sprite the body names, from the body itself. */
function referencesOf(kind: string, body: string): { keys: string[]; pictures: string[] } {
  const probe = parseClausewitz(Buffer.from(`${kind} = {\n${body}\n}\n`, 'utf8'), 'event-body');
  const block = assignments(probe.root, kind)[0]?.value;
  const keys = new Set<string>();
  const pictures = new Set<string>();
  const textKeys = (node: BlockNode): void => {
    for (const entry of assignments(node)) {
      if (entry.value.type === 'block') textKeys(entry.value);
      else if (entry.key.value === 'text') keys.add(entry.value.value);
    }
  };
  const addKey = (entry: ReturnType<typeof assignments>[number]): void => {
    if (entry.value.type === 'scalar') keys.add(entry.value.value);
    else textKeys(entry.value);
  };
  if (block?.type === 'block') {
    for (const entry of assignments(block)) {
      const key = entry.key.value;
      if (key === 'title' || key === 'desc') addKey(entry);
      else if (key === 'picture' && entry.value.type === 'scalar') pictures.add(entry.value.value);
      else if (key === 'option' && entry.value.type === 'block')
        for (const name of assignments(entry.value, 'name')) addKey(name);
    }
  }
  return {
    keys: [...keys].filter((key) => /^[A-Za-z0-9_.:-]+$/u.test(key)),
    pictures: [...pictures].filter((picture) => picture.startsWith('GFX_')),
  };
}

export interface EventWriteComputed {
  plan: EventWritePlan;
  /** The file the write changes; absent when the call creates the file. */
  file: ScannedFile | undefined;
  data: EventWriteData;
  diagnostics: Diagnostic[];
}

export async function computeEventWrite(
  engine: CoreEngine,
  input: EventWriteRequest,
  context: EventWriteOperationContext,
  applied: boolean,
): Promise<EventWriteComputed> {
  const snapshot = await engine.scan(
    context.workspaceId,
    { patterns: WRITE_PATTERNS },
    context.principal,
    context.signal,
  );
  const files = modEventFiles(snapshot);
  const target = targetFile(snapshot, files, input);
  const namespace = namespaceOf(input.id);
  const planInput = {
    operation: input.operation,
    id: input.id,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.createNamespace === undefined ? {} : { createNamespace: input.createNamespace }),
    namespaceDeclared: files.some((entry) => entry.namespaces.includes(namespace)),
  };
  let file: ScannedFile | undefined;
  let plan: EventWritePlan;
  if ('file' in target) {
    file = target.file;
    plan = planEventWrite({ bytes: file.bytes, path: file.relativePath }, planInput);
  } else {
    const inMod = snapshot.index
      .findAll('event', input.id)
      .find(({ path }) => path.startsWith('mod:'));
    if (inMod !== undefined)
      fail('EVENT_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod.path,
      });
    plan = planNewEventFile(target.newPath, planInput);
  }
  const missing: EventWriteData['missing'] = { localisation: [], picture: [] };
  const diagnostics: Diagnostic[] = [];
  if (input.operation !== 'remove' && input.body !== undefined) {
    const { keys, pictures } = referencesOf(plan.kind, input.body);
    for (const key of keys.slice(0, MAX_KEYS)) {
      if (snapshot.index.find('localisation', `l_english:${key}`) !== undefined) continue;
      missing.localisation.push(key);
      diagnostics.push({
        code: 'EVENT_WRITE_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `No English text is defined for the localisation key ${key}; hoi4.localisation_write adds it`,
        details: { key },
      });
    }
    for (const sprite of pictures.slice(0, 5)) {
      if (snapshot.index.find('sprite', sprite) !== undefined) continue;
      missing.picture.push(sprite);
      diagnostics.push({
        code: 'EVENT_WRITE_PICTURE_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The sprite ${sprite} is not defined, so the event shows no picture`,
        details: { sprite },
      });
    }
  }
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = eventWriteDataSchema.parse({
    operation: plan.operation,
    id: plan.id,
    kind: plan.kind,
    path: plan.path,
    applied,
    diff: budget ? `${plan.diff.slice(0, DIFF_BUDGET_BYTES)}\n` : plan.diff,
    diffTruncated: budget,
    untouchedDefinitions: plan.untouchedDefinitions,
    namespaceAdded: plan.namespaceAdded,
    missing,
  });
  return { plan, file, data, diagnostics };
}

export type EventWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: EventWriteData,
  outcome: EventWriteOutcome,
): ServiceResult<EventWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'EVENT_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'EVENT_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'EVENT_WRITE_UNCHANGED'
          : 'EVENT_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewEventWrite(
  engine: CoreEngine,
  input: EventWriteRequest,
  context: EventWriteOperationContext,
): Promise<ServiceResult<EventWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's events");
  const computed = await computeEventWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.file !== undefined && computed.plan.bytes.equals(computed.file.bytes)
      ? 'unchanged'
      : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Event preview ready');
  return result;
}

export interface EventWriteRecipe {
  data: EventWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareEventWrite(
  engine: CoreEngine,
  input: EventWriteRequest,
  context: EventWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<EventWriteData> }
  | { transaction: TransactionManifest; recipe: EventWriteRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's events");
  const computed = await computeEventWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (file !== undefined && plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `event-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the event transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'event-changes',
    operations: [
      {
        id: operationId,
        kind: operationId,
        summary: `${plan.operation} ${plan.id}`,
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
                code: 'EVENT_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned event file',
              },
            ],
        checks: [
          {
            id: 'event-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned event file'
              : 'Transaction bytes differ from the planned event file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Event change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeEventWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<EventWriteData> {
  const parsed = recipe as EventWriteRecipe;
  const data = eventWriteDataSchema.parse({
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

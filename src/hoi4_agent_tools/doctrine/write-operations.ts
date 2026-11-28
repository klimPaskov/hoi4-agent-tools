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
  doctrineWriteDataSchema,
  type DoctrineWriteData,
  type DoctrineWriteRequest,
} from '../schemas/doctrine-write.js';
import { planDoctrineWrite, planNewDoctrineFile, type DoctrineWritePlan } from './write-plan.js';

export interface DoctrineWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

type DoctrineKind = NonNullable<DoctrineWriteRequest['kind']>;

/** The folder each kind of doctrine lives in, and the index kind its ids are recorded under. */
const KINDS: Record<
  DoctrineKind,
  { directory: string; indexKind: 'grand_doctrine' | 'doctrine_track' | 'subdoctrine' }
> = {
  grand_doctrine: { directory: 'common/doctrines/grand_doctrines/', indexKind: 'grand_doctrine' },
  track: { directory: 'common/doctrines/tracks/', indexKind: 'doctrine_track' },
  subdoctrine: { directory: 'common/doctrines/subdoctrines/', indexKind: 'subdoctrine' },
};
const KIND_NAMES = Object.keys(KINDS) as DoctrineKind[];

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;
const MAX_TRACKS = 20;
/** The sources a write needs: the doctrines and their folders, and the sprites and English text. */
const WRITE_PATTERNS = [
  'common/doctrines/**/*.txt',
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

/** The kind whose folder a path is under, if any. */
function kindOfPath(path: string): DoctrineKind | undefined {
  const lower = normalized(path);
  return KIND_NAMES.find((kind) => lower.startsWith(KINDS[kind].directory));
}

/** The mod's own doctrine files, the ones this tool may write. */
function modDoctrineFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files.filter(
    ({ rootKind, shadowedBy, relativePath }) =>
      rootKind === 'mod' &&
      shadowedBy === undefined &&
      relativePath.toLowerCase().endsWith('.txt') &&
      kindOfPath(relativePath) !== undefined,
  );
}

/** The file the operation writes and the kind of doctrine it holds. */
type DoctrineWriteTarget =
  { file: ScannedFile; kind: DoctrineKind } | { newPath: string; kind: DoctrineKind };

/** A path createFile may make: a .txt file under the folder of the kind, inside the mod. */
function newDoctrineFilePath(file: string, kind: DoctrineKind): string {
  const path = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    !normalized(path).startsWith(KINDS[kind].directory) ||
    !path.toLowerCase().endsWith('.txt') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail(
      'DOCTRINE_WRITE_FILE_INVALID',
      `${file} is not a .txt file under ${KINDS[kind].directory}, so a new ${kind} file cannot go there`,
      { file, kind },
    );
  return path;
}

function targetFile(snapshot: ScanSnapshot, input: DoctrineWriteRequest): DoctrineWriteTarget {
  const files = modDoctrineFiles(snapshot);
  const names = files.map(({ relativePath }) => relativePath).slice(0, 20);
  if (input.file !== undefined) {
    const named = files.find(
      ({ relativePath }) => normalized(relativePath) === normalized(input.file!),
    );
    if (named !== undefined) {
      if (input.operation === 'add' && input.createFile === true)
        // The file exists, so the flag has nothing to create; refusing keeps a wrong guess visible.
        fail(
          'DOCTRINE_WRITE_FILE_EXISTS',
          `${named.relativePath} already exists; drop createFile to add to it`,
          { file: named.relativePath },
        );
      const kind = kindOfPath(named.relativePath)!;
      if (input.kind !== undefined && input.kind !== kind)
        fail(
          'DOCTRINE_WRITE_KIND_MISMATCH',
          `${named.relativePath} holds ${kind} definitions, not ${input.kind}`,
          { file: named.relativePath, kind },
        );
      return { file: named, kind };
    }
    if (input.operation !== 'add' || input.createFile !== true)
      fail(
        'DOCTRINE_WRITE_FILE_NOT_FOUND',
        `${input.file} is not a doctrine file of the mod${input.operation === 'add' ? '; pass createFile: true to create it' : ''}`,
        { file: input.file, files: names },
      );
    const kind = input.kind ?? kindOfPath(input.file);
    if (kind === undefined)
      fail(
        'DOCTRINE_WRITE_KIND_REQUIRED',
        'a new file needs kind, or a path under grand_doctrines, tracks or subdoctrines',
      );
    return { newPath: newDoctrineFilePath(input.file, kind), kind };
  }
  if (input.operation === 'add') {
    if (input.kind === undefined)
      fail('DOCTRINE_WRITE_KIND_REQUIRED', 'add needs kind, or file naming where it goes');
    const kind = input.kind;
    const inMod = snapshot.index
      .findAll(KINDS[kind].indexKind, input.id)
      .filter(({ path }) => path.startsWith('mod:'));
    if (inMod.length > 0)
      fail('DOCTRINE_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod[0]?.path,
      });
    const ofKind = files.filter(({ relativePath }) => kindOfPath(relativePath) === kind);
    if (ofKind.length === 1) return { file: ofKind[0]!, kind };
    fail(
      'DOCTRINE_WRITE_FILE_REQUIRED',
      ofKind.length === 0
        ? `The mod has no ${kind} file; name a new one with file and createFile: true`
        : `${ofKind.length} files of the mod hold ${kind} definitions; name one with file`,
      { files: names },
    );
  }
  const found = KIND_NAMES.flatMap((kind) =>
    snapshot.index.findAll(KINDS[kind].indexKind, input.id).map((definition) => ({
      kind,
      path: definition.path,
    })),
  );
  const inMod = found.filter(({ path }) => path.startsWith('mod:'));
  if (inMod.length === 0) {
    if (found.length > 0)
      fail(
        'DOCTRINE_WRITE_NOT_IN_MOD',
        `${input.id} is defined in the game files, not in the mod; add it to a mod file to override it`,
        { id: input.id, path: found[0]?.path },
      );
    fail('DOCTRINE_WRITE_NOT_FOUND', `${input.id} is not defined`, { id: input.id });
  }
  const paths = [...new Set(inMod.map(({ path }) => path))];
  if (paths.length > 1)
    fail(
      'DOCTRINE_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${paths.length} files; name one with file`,
      { files: paths },
    );
  const file = files.find(({ displayPath }) => displayPath === paths[0]);
  if (file === undefined)
    fail('DOCTRINE_WRITE_NOT_FOUND', `${input.id} is not in an active mod file`, {
      path: paths[0],
    });
  return { file, kind: inMod[0]!.kind };
}

interface DoctrineReferences {
  name: string | undefined;
  icon: string | undefined;
  folder: string | undefined;
  tracks: string[];
}

/** What the body names that the index can check: the name key, the icon, the folder and the tracks. */
function referencesOf(id: string, body: string): DoctrineReferences {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'doctrine-body');
  const block = assignments(probe.root, id)[0]?.value;
  const references: DoctrineReferences = {
    name: undefined,
    icon: undefined,
    folder: undefined,
    tracks: [],
  };
  if (block?.type !== 'block') return references;
  const scalar = (key: string): string | undefined => {
    const entry = assignments(block, key)[0];
    return entry?.value.type === 'scalar' ? entry.value.value : undefined;
  };
  references.name = scalar('name');
  references.icon = scalar('icon');
  references.folder = scalar('folder');
  for (const list of assignments(block, 'tracks'))
    if (list.value.type === 'block')
      for (const entry of list.value.entries)
        if (entry.type === 'scalar') references.tracks.push(entry.value);
  return references;
}

export interface DoctrineWriteComputed {
  plan: DoctrineWritePlan;
  kind: DoctrineKind;
  /** The file the write changes; absent when the call creates the file. */
  file: ScannedFile | undefined;
  data: DoctrineWriteData;
  diagnostics: Diagnostic[];
}

export async function computeDoctrineWrite(
  engine: CoreEngine,
  input: DoctrineWriteRequest,
  context: DoctrineWriteOperationContext,
  applied: boolean,
): Promise<DoctrineWriteComputed> {
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
  let plan: DoctrineWritePlan;
  if ('file' in target) {
    file = target.file;
    plan = await planDoctrineWrite({ bytes: file.bytes, path: file.relativePath }, planInput);
  } else {
    const inMod = snapshot.index
      .findAll(KINDS[target.kind].indexKind, input.id)
      .find(({ path }) => path.startsWith('mod:'));
    if (inMod !== undefined)
      fail('DOCTRINE_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod.path,
      });
    plan = await planNewDoctrineFile(target.newPath, planInput);
  }
  const missing: DoctrineWriteData['missing'] = {
    localisation: [],
    icon: [],
    folder: [],
    track: [],
  };
  const diagnostics: Diagnostic[] = [];
  if (input.operation !== 'remove' && input.body !== undefined) {
    const references = referencesOf(input.id, input.body);
    if (
      references.name !== undefined &&
      snapshot.index.find('localisation', `l_english:${references.name}`) === undefined
    ) {
      missing.localisation.push(references.name);
      diagnostics.push({
        code: 'DOCTRINE_WRITE_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `No English text is defined for the localisation key ${references.name}; hoi4.localisation_write adds it`,
        details: { key: references.name },
      });
    }
    if (
      references.icon !== undefined &&
      snapshot.index.find('sprite', references.icon) === undefined
    ) {
      missing.icon.push(references.icon);
      diagnostics.push({
        code: 'DOCTRINE_WRITE_ICON_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The sprite ${references.icon} is not defined, so the doctrine shows no icon`,
        details: { sprite: references.icon },
      });
    }
    if (
      references.folder !== undefined &&
      snapshot.index.find('doctrine_folder', references.folder) === undefined
    ) {
      missing.folder.push(references.folder);
      diagnostics.push({
        code: 'DOCTRINE_WRITE_FOLDER_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `No doctrine folder ${references.folder} is defined, so the doctrine has no tree to sit in`,
        details: { folder: references.folder },
      });
    }
    for (const track of references.tracks.slice(0, MAX_TRACKS)) {
      if (snapshot.index.find('doctrine_track', track) !== undefined) continue;
      missing.track.push(track);
      diagnostics.push({
        code: 'DOCTRINE_WRITE_TRACK_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The track ${track} that the doctrine lists is not defined`,
        details: { track },
      });
    }
  }
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = doctrineWriteDataSchema.parse({
    operation: plan.operation,
    id: plan.id,
    kind: target.kind,
    path: plan.path,
    applied,
    diff: budget ? `${plan.diff.slice(0, DIFF_BUDGET_BYTES)}\n` : plan.diff,
    diffTruncated: budget,
    untouchedDefinitions: plan.untouchedDefinitions,
    missing,
  });
  return { plan, kind: target.kind, file, data, diagnostics };
}

export type DoctrineWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: DoctrineWriteData,
  outcome: DoctrineWriteOutcome,
): ServiceResult<DoctrineWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'DOCTRINE_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'DOCTRINE_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'DOCTRINE_WRITE_UNCHANGED'
          : 'DOCTRINE_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewDoctrineWrite(
  engine: CoreEngine,
  input: DoctrineWriteRequest,
  context: DoctrineWriteOperationContext,
): Promise<ServiceResult<DoctrineWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's doctrines");
  const computed = await computeDoctrineWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.file !== undefined && computed.plan.bytes.equals(computed.file.bytes)
      ? 'unchanged'
      : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Doctrine preview ready');
  return result;
}

export interface DoctrineWriteRecipe {
  data: DoctrineWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareDoctrineWrite(
  engine: CoreEngine,
  input: DoctrineWriteRequest,
  context: DoctrineWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<DoctrineWriteData> }
  | { transaction: TransactionManifest; recipe: DoctrineWriteRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's doctrines");
  const computed = await computeDoctrineWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (file !== undefined && plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `doctrine-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the doctrine transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'doctrine-changes',
    operations: [
      {
        id: operationId,
        kind: operationId,
        summary: `${plan.operation} ${plan.id}`,
        data: { id: plan.id, kind: computed.kind },
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
                code: 'DOCTRINE_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned doctrine file',
              },
            ],
        checks: [
          {
            id: 'doctrine-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned doctrine file'
              : 'Transaction bytes differ from the planned doctrine file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Doctrine change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeDoctrineWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<DoctrineWriteData> {
  const parsed = recipe as DoctrineWriteRecipe;
  const data = doctrineWriteDataSchema.parse({
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

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
  techWriteDataSchema,
  type TechWriteData,
  type TechWriteRequest,
} from '../schemas/tech-write.js';
import { planTechWrite, planNewTechFile, type TechWritePlan } from './write-plan.js';
import { TechnologyTreeViewer } from './service.js';
import { techPlacementReport } from './write-placement.js';

export interface TechWriteOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  /** The viewer a placement report compares with; a worker shares one so its graph is cached. */
  placementViewer?: TechnologyTreeViewer;
  progress?(completed: number, total: number, message: string): Promise<void>;
}

const DIFF_BUDGET_BYTES = 8_000;
const MAX_INLINE_PATHS = 8;
const MAX_INLINE_ARTIFACTS = 2;
const MAX_UNLOCKS = 20;
/**
 * The sources a write needs: the mod's technologies, the folders they sit in, the equipment, modules
 * and sub-units they unlock, and the sprites and English text they refer to.
 */
const WRITE_PATTERNS = [
  'common/technologies/**/*.txt',
  'common/technology_tags/**/*.txt',
  'common/units/**/*.txt',
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

/** The mod's own `common/technologies` files, the ones this tool may write. */
function modTechFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files.filter(
    ({ rootKind, shadowedBy, relativePath }) =>
      rootKind === 'mod' &&
      shadowedBy === undefined &&
      normalized(relativePath).startsWith('common/technologies/') &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

/** The file the operation writes: an existing mod file, or the path of one createFile makes. */
type TechWriteTarget = { file: ScannedFile } | { newPath: string };

/** A path createFile may make: a .txt file under common/technologies, inside the mod. */
function newTechFilePath(file: string): string {
  const path = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    !normalized(path).startsWith('common/technologies/') ||
    !path.toLowerCase().endsWith('.txt') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail(
      'TECH_WRITE_FILE_INVALID',
      `${file} is not a .txt file under common/technologies, so a new technology file cannot go there`,
      { file },
    );
  return path;
}

/** The file the operation writes: the one named, the one that defines the tech, or the mod's only one. */
function targetFile(snapshot: ScanSnapshot, input: TechWriteRequest): TechWriteTarget {
  const files = modTechFiles(snapshot);
  const names = files.map(({ relativePath }) => relativePath).slice(0, 20);
  if (input.file !== undefined) {
    const named = files.find(
      ({ relativePath }) => normalized(relativePath) === normalized(input.file!),
    );
    if (named !== undefined) {
      if (input.operation === 'add' && input.createFile === true)
        // The file exists, so the flag has nothing to create; refusing keeps a wrong guess visible.
        fail(
          'TECH_WRITE_FILE_EXISTS',
          `${named.relativePath} already exists; drop createFile to add to it`,
          { file: named.relativePath },
        );
      return { file: named };
    }
    if (input.operation !== 'add' || input.createFile !== true)
      fail(
        'TECH_WRITE_FILE_NOT_FOUND',
        `${input.file} is not a common/technologies file of the mod${input.operation === 'add' ? '; pass createFile: true to create it' : ''}`,
        { file: input.file, files: names },
      );
    return { newPath: newTechFilePath(input.file) };
  }
  const definitions = snapshot.index.findAll('technology', input.id);
  const inMod = definitions.filter(({ path }) => path.startsWith('mod:'));
  if (input.operation === 'add') {
    if (inMod.length > 0)
      fail('TECH_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod[0]?.path,
      });
    if (files.length === 1) return { file: files[0]! };
    fail(
      'TECH_WRITE_FILE_REQUIRED',
      files.length === 0
        ? 'The mod has no common/technologies file; name a new one with file and createFile: true'
        : `${files.length} files of the mod hold technologies; name one with file`,
      { files: names },
    );
  }
  if (inMod.length === 0) {
    if (definitions.length > 0)
      fail(
        'TECH_WRITE_NOT_IN_MOD',
        `${input.id} is defined in the game files, not in the mod; add it to a mod file to override it`,
        { id: input.id, path: definitions[0]?.path },
      );
    fail('TECH_WRITE_NOT_FOUND', `${input.id} is not defined`, { id: input.id });
  }
  const paths = [...new Set(inMod.map(({ path }) => path))];
  if (paths.length > 1)
    fail(
      'TECH_WRITE_FILE_REQUIRED',
      `${input.id} is defined in ${paths.length} files; name one with file`,
      { files: paths },
    );
  const found = files.find(({ displayPath }) => displayPath === paths[0]);
  if (found === undefined)
    fail('TECH_WRITE_NOT_FOUND', `${input.id} is not in an active mod file`, {
      path: paths[0],
    });
  return { file: found };
}

/** The unlock lists of a technology and the index kind each entry must resolve to. */
const UNLOCKS: ReadonlyArray<readonly [string, 'equipment' | 'equipment_module' | 'sub_unit']> = [
  ['enable_equipments', 'equipment'],
  ['enable_equipment_modules', 'equipment_module'],
  ['enable_subunits', 'sub_unit'],
];

interface TechReferences {
  /** The default icon sprite, unless the body names its own picture. */
  sprite: string | undefined;
  folder: string | undefined;
  unlocks: Array<{ kind: 'equipment' | 'equipment_module' | 'sub_unit'; name: string }>;
}

/** What the body names that the index can check: unlocks, the tree folder, and the icon sprite. */
function referencesOf(id: string, body: string): TechReferences {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'tech-body');
  const block = assignments(probe.root, id)[0]?.value;
  const references: TechReferences = {
    sprite: undefined,
    folder: undefined,
    unlocks: [],
  };
  if (block?.type !== 'block') return references;
  if (assignments(block, 'picture').length === 0) references.sprite = `GFX_${id}_medium`;
  const folder = assignments(block, 'folder')[0]?.value;
  if (folder?.type === 'block') {
    const name = assignments(folder, 'name')[0]?.value;
    if (name?.type === 'scalar') references.folder = name.value;
  }
  for (const [key, kind] of UNLOCKS)
    for (const list of assignments(block, key))
      if (list.value.type === 'block')
        for (const entry of list.value.entries)
          if (entry.type === 'scalar') references.unlocks.push({ kind, name: entry.value });
  return references;
}

export interface TechWriteComputed {
  plan: TechWritePlan;
  /** The file the write changes; absent when the call creates the file. */
  file: ScannedFile | undefined;
  data: TechWriteData;
  diagnostics: Diagnostic[];
}

export async function computeTechWrite(
  engine: CoreEngine,
  input: TechWriteRequest,
  context: TechWriteOperationContext,
  applied: boolean,
): Promise<TechWriteComputed> {
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
  let plan: TechWritePlan;
  if ('file' in target) {
    file = target.file;
    plan = planTechWrite({ bytes: file.bytes, path: file.relativePath }, planInput);
  } else {
    const inMod = snapshot.index
      .findAll('technology', input.id)
      .find(({ path }) => path.startsWith('mod:'));
    if (inMod !== undefined)
      fail('TECH_WRITE_DUPLICATE_ID', `${input.id} is already defined in the mod`, {
        id: input.id,
        path: inMod.path,
      });
    plan = planNewTechFile(target.newPath, planInput);
  }
  const missing: TechWriteData['missing'] = {
    localisation: [],
    sprite: [],
    unlock: [],
    folder: [],
  };
  const diagnostics: Diagnostic[] = [];
  if (input.operation !== 'remove' && input.body !== undefined) {
    const references = referencesOf(input.id, input.body);
    for (const key of [input.id, `${input.id}_desc`]) {
      if (snapshot.index.find('localisation', `l_english:${key}`) !== undefined) continue;
      missing.localisation.push(key);
      diagnostics.push({
        code: 'TECH_WRITE_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `No English text is defined for the localisation key ${key}; hoi4.localisation_write adds it`,
        details: { key },
      });
    }
    if (
      references.sprite !== undefined &&
      snapshot.index.find('sprite', references.sprite) === undefined
    ) {
      missing.sprite.push(references.sprite);
      diagnostics.push({
        code: 'TECH_WRITE_SPRITE_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `The sprite ${references.sprite} is not defined, so the technology shows no icon`,
        details: { sprite: references.sprite },
      });
    }
    if (
      references.folder !== undefined &&
      snapshot.index.find('technology_folder', references.folder) === undefined
    ) {
      missing.folder.push(references.folder);
      diagnostics.push({
        code: 'TECH_WRITE_FOLDER_UNDEFINED',
        severity: 'warning',
        category: 'reference',
        message: `No technology folder ${references.folder} is defined, so the technology has no tree to sit in`,
        details: { folder: references.folder },
      });
    }
    for (const { kind, name } of references.unlocks.slice(0, MAX_UNLOCKS)) {
      if (snapshot.index.find(kind, name) !== undefined) continue;
      missing.unlock.push(name);
      diagnostics.push({
        code: 'TECH_WRITE_UNLOCK_UNRESOLVED',
        severity: 'warning',
        category: 'reference',
        message: `The ${kind.replace('_', ' ')} ${name} that the technology unlocks is not defined`,
        details: { kind, name },
      });
    }
  }
  const placement =
    input.placement === true
      ? await techPlacementReport(
          context.placementViewer ?? new TechnologyTreeViewer(engine),
          {
            workspaceId: context.workspaceId,
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
          { path: plan.path, text: plan.text, sourceHash: file?.sha256 },
        )
      : undefined;
  if (placement?.computed === false)
    diagnostics.push({
      code: 'TECH_WRITE_PLACEMENT_UNAVAILABLE',
      severity: 'warning',
      category: 'reference',
      message: `The effect on the technology trees could not be computed (${placement.reason ?? 'unknown'}); the edit is not affected`,
    });
  const budget = plan.diff.length > DIFF_BUDGET_BYTES;
  const data = techWriteDataSchema.parse({
    operation: plan.operation,
    id: plan.id,
    path: plan.path,
    applied,
    diff: budget ? `${plan.diff.slice(0, DIFF_BUDGET_BYTES)}\n` : plan.diff,
    diffTruncated: budget,
    untouchedDefinitions: plan.untouchedDefinitions,
    ...(placement === undefined ? {} : { placement }),
    missing,
  });
  return { plan, file, data, diagnostics };
}

export type TechWriteOutcome = 'preview' | 'applied' | 'unchanged' | 'blocked';

function resultFor(
  workspaceId: string,
  data: TechWriteData,
  outcome: TechWriteOutcome,
): ServiceResult<TechWriteData> {
  const result = emptyServiceResult(workspaceId, data);
  result.code =
    outcome === 'preview'
      ? 'TECH_WRITE_PREVIEW'
      : outcome === 'applied'
        ? 'TECH_WRITE_APPLIED'
        : outcome === 'unchanged'
          ? 'TECH_WRITE_UNCHANGED'
          : 'TECH_WRITE_BLOCKED';
  result.status = outcome === 'blocked' ? 'blocked' : 'ok';
  result.proposedFiles = [data.path].slice(0, MAX_INLINE_PATHS);
  return result;
}

/** `apply: false`: the diff of the one file the call would change, and nothing written. */
export async function previewTechWrite(
  engine: CoreEngine,
  input: TechWriteRequest,
  context: TechWriteOperationContext,
): Promise<ServiceResult<TechWriteData>> {
  await context.progress?.(0, 2, "Reading the mod's technologies");
  const computed = await computeTechWrite(engine, input, context, false);
  const result = resultFor(
    context.workspaceId,
    computed.data,
    computed.file !== undefined && computed.plan.bytes.equals(computed.file.bytes)
      ? 'unchanged'
      : 'preview',
  );
  result.diagnostics = computed.diagnostics;
  await context.progress?.(2, 2, 'Tech preview ready');
  return result;
}

export interface TechWriteRecipe {
  data: TechWriteData;
  diagnostics: Diagnostic[];
}

/** `apply: true`: the same plan, as one validated transaction for atomic replacement. */
export async function prepareTechWrite(
  engine: CoreEngine,
  input: TechWriteRequest,
  context: TechWriteOperationContext,
): Promise<
  | { readOnlyPreview: ServiceResult<TechWriteData> }
  | { transaction: TransactionManifest; recipe: TechWriteRecipe }
> {
  await context.progress?.(0, 3, "Reading the mod's technologies");
  const computed = await computeTechWrite(engine, input, context, true);
  const { plan, file, data, diagnostics } = computed;
  if (file !== undefined && plan.bytes.equals(file.bytes)) {
    const result = resultFor(context.workspaceId, { ...data, applied: false }, 'unchanged');
    result.diagnostics = diagnostics;
    return { readOnlyPreview: result };
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const modRoot = workspace.roots.find((root) => root.kind === 'mod');
  const operationId = `tech-${plan.operation}`;
  await context.progress?.(1, 3, 'Preparing the technology transaction');
  const transaction = await engine.transactions.plan({
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    operationKind: 'tech-changes',
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
                code: 'TECH_WRITE_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the planned tech file',
              },
            ],
        checks: [
          {
            id: 'tech-proposed-bytes-match',
            passed: matches,
            message: matches
              ? 'Transaction bytes exactly match the planned tech file'
              : 'Transaction bytes differ from the planned tech file',
          },
        ],
      });
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress?.(2, 3, 'Tech change prepared for journaled application');
  return { transaction, recipe: { data, diagnostics } };
}

export function completeTechWrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
): ServiceResult<TechWriteData> {
  const parsed = recipe as TechWriteRecipe;
  const data = techWriteDataSchema.parse({
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

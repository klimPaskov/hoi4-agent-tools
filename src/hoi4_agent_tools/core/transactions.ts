import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { hostname } from 'node:os';
import { ArtifactStore, publicArtifactLink, type ArtifactWrite } from './artifacts.js';
import {
  compareCodeUnits,
  canonicalJson,
  hashCanonical,
  secureId,
  sha256Bytes,
} from './canonical.js';
import type { Diagnostic } from './diagnostics.js';
import { binaryDiff, unifiedTextDiff } from './diff.js';
import type { ScannedFile } from './scanner.js';
import type { ServerState } from './server-state.js';
import type { ArtifactLink, ValidationSummary } from './result.js';
import { ServiceError } from './result.js';
import { decodeSource } from './source/encoding.js';
import type { ResolvedWorkspace, WorkspaceResolver } from './workspace.js';
import type { RootKind } from './workspace.js';
import { containedGeneratedPath, isWithin } from './workspace.js';
import {
  TRANSACTION_MAX_ARTIFACTS,
  TRANSACTION_MAX_DIAGNOSTICS,
  TRANSACTION_MAX_FILES,
  TRANSACTION_MAX_MANIFEST_BYTES,
  TRANSACTION_MAX_OPERATIONS,
  TRANSACTION_MAX_READ_DEPENDENCIES,
  TRANSACTION_MAX_VALIDATION_CHECKS,
} from './transaction-limits.js';
import { PACKAGE_VERSION, TRANSACTION_VERSION } from '../version.js';
import { transactionManifestSchema } from '../schemas/transaction.js';

export type TransactionState =
  'planned' | 'applying' | 'applied' | 'rolling_back' | 'rolled_back' | 'failed';

export interface ProposedFileChange {
  relativePath: string;
  content: Uint8Array | null;
  operationIds: string[];
  mediaType?: string;
}

export interface TransactionFileChange {
  relativePath: string;
  operationIds: string[];
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeSize: number | null;
  afterSize: number | null;
  beforeBlob: string | null;
  afterBlob: string | null;
  mediaType: string;
  diffArtifact?: ArtifactLink;
}

export interface TransactionReadDependency {
  rootKind: RootKind;
  loadOrder: number;
  relativePath: string;
  sha256: string;
}

export function readDependenciesFromScannedFiles(
  files: readonly Pick<ScannedFile, 'rootKind' | 'loadOrder' | 'relativePath' | 'sha256'>[],
): TransactionReadDependency[] {
  const unique = new Map<string, TransactionReadDependency>();
  for (const file of files) {
    const dependency = {
      rootKind: file.rootKind,
      loadOrder: file.loadOrder,
      relativePath: file.relativePath.replaceAll('\\', '/'),
      sha256: file.sha256,
    };
    unique.set(
      `${dependency.rootKind}:${dependency.loadOrder}:${dependency.relativePath}`,
      dependency,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.loadOrder - right.loadOrder ||
      compareCodeUnits(left.rootKind, right.rootKind) ||
      compareCodeUnits(left.relativePath, right.relativePath),
  );
}

export interface TransactionManifest {
  version: number;
  revision: number;
  transactionId: string;
  workspaceId: string;
  principal?: string;
  rootFingerprint: string;
  createdAt: string;
  expiresAt: string;
  state: TransactionState;
  planPayload: TransactionPlanPayload;
  planHash: string;
  integrityHash: string;
  authenticationTag: string;
  operationKind: string;
  operations: Array<{ id: string; kind: string; summary: string; data: Record<string, unknown> }>;
  readDependencies: TransactionReadDependency[];
  files: TransactionFileChange[];
  diagnostics: Diagnostic[];
  validation: ValidationSummary;
  artifacts: ArtifactLink[];
  appliedFiles: string[];
  rollbackStatus: 'available' | 'applied' | 'failed';
  failure?: { code: string; message: string };
}

export interface TransactionPlanPayload {
  version: number;
  workspaceId: string;
  principal: string | null;
  rootFingerprint: string;
  operationKind: string;
  operations: TransactionManifest['operations'];
  readDependencies: TransactionReadDependency[];
  files: Array<Omit<TransactionFileChange, 'diffArtifact'>>;
  diagnostics: Diagnostic[];
  validation: ValidationSummary;
  artifacts: ArtifactLink[];
}

type ManifestHeadMode = 'verify' | 'reconcile' | 'none';

interface TransactionManifestFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface TransactionManifestByteCacheEntry {
  identity: TransactionManifestFileIdentity;
  bytes: Buffer;
  principal: string | null;
  revision: number;
  authenticationTag: string;
  manifestHash: string;
}

const transactionManifestRangeMaxBytes = 1_048_576;
const transactionManifestCacheMaxBytes = TRANSACTION_MAX_MANIFEST_BYTES;
const transactionManifestCacheMaxEntries = 8;

function transactionManifestFileIdentity(value: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): TransactionManifestFileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameTransactionManifestIdentity(
  left: TransactionManifestFileIdentity,
  right: TransactionManifestFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export interface TransactionValidation {
  diagnostics: Diagnostic[];
  checks: ValidationSummary['checks'];
}

export interface PlanTransactionInput {
  workspaceId: string;
  principal?: string;
  operationKind: string;
  operations: TransactionManifest['operations'];
  changes: ProposedFileChange[];
  readDependencies?: TransactionReadDependency[];
  artifacts?: ArtifactLink[];
  diagnostics?: Diagnostic[];
  validate: (
    proposed: ReadonlyMap<string, Buffer | null>,
    signal?: AbortSignal,
  ) => Promise<TransactionValidation>;
  signal?: AbortSignal;
}

export interface TransactionHooks {
  afterStage?: (relativePath: string, index: number) => Promise<void>;
  afterBackup?: (relativePath: string, index: number) => Promise<void>;
  afterReplace?: (relativePath: string, index: number) => Promise<void>;
  beforePostValidation?: () => Promise<void>;
  beforeManifestCacheWrite?: () => Promise<void>;
  afterManifestCacheWrite?: () => Promise<void>;
  beforeProtectedHeadCommit?: () => Promise<void>;
  afterProtectedHeadCommit?: () => Promise<void>;
}

export interface ApplyTransactionOptions {
  principal?: string;
  postValidate: (
    manifest: TransactionManifest,
    signal?: AbortSignal,
  ) => Promise<TransactionValidation>;
  hooks?: TransactionHooks;
  signal?: AbortSignal;
}

const transactionIdPattern = /^txn_[0-9a-f-]{36}$/u;
const lockOwnerGraceMs = 30_000;
const lockHost = hostname().toLowerCase();
const lockInstanceId = secureId('instance');
const lockProcessStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function inferMediaType(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.png') return 'image/png';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.json') return 'application/json';
  if (['.txt', '.gui', '.gfx', '.yml', '.csv', '.md'].includes(extension)) return 'text/plain';
  return 'application/octet-stream';
}

function isText(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json';
}

function sourceDiffText(bytes: Buffer | null): string {
  if (bytes === null) return '';
  const decoded = decodeSource(bytes);
  return `${decoded.encoding === 'utf8-bom' ? '\ufeff' : ''}${decoded.text}`;
}

async function durableWrite(filePath: string, content: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${secureId('tmp')}`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function manifestPlanPayload(
  manifest: Omit<
    TransactionManifest,
    'planHash' | 'planPayload' | 'integrityHash' | 'authenticationTag'
  >,
): TransactionPlanPayload {
  return {
    version: manifest.version,
    workspaceId: manifest.workspaceId,
    principal: manifest.principal ?? null,
    rootFingerprint: manifest.rootFingerprint,
    operationKind: manifest.operationKind,
    operations: manifest.operations,
    readDependencies: manifest.readDependencies,
    files: manifest.files.map(({ diffArtifact: _diffArtifact, ...file }) => file),
    diagnostics: manifest.diagnostics,
    validation: manifest.validation,
    artifacts: manifest.artifacts,
  };
}

function immutablePlanPayload(
  payload: TransactionPlanPayload,
): Omit<TransactionPlanPayload, 'diagnostics' | 'validation'> {
  const { diagnostics: _diagnostics, validation: _validation, ...immutable } = payload;
  return immutable;
}

function manifestIntegrityPayload(manifest: TransactionManifest): unknown {
  const {
    integrityHash: _integrityHash,
    authenticationTag: _authenticationTag,
    ...payload
  } = manifest;
  return payload;
}

function manifestAuthenticationPayload(manifest: TransactionManifest): unknown {
  const { authenticationTag: _authenticationTag, ...payload } = manifest;
  return payload;
}

export function transactionRootFingerprint(workspace: ResolvedWorkspace): string {
  return workspace.workspaceIdentity;
}

export class TransactionManager {
  readonly #manifestByteCache = new Map<string, TransactionManifestByteCacheEntry>();
  #manifestByteCacheBytes = 0;

  public constructor(
    private readonly resolver: WorkspaceResolver,
    private readonly artifacts = new ArtifactStore(),
    private readonly ttlSeconds = 3600,
    private readonly maxJournalBytes = 536_870_912,
    private readonly maxJournals = 128,
    private readonly serverState: ServerState | undefined = resolver.serverState(),
  ) {}

  async plan(input: PlanTransactionInput): Promise<TransactionManifest> {
    input.signal?.throwIfAborted();
    if (
      input.changes.length > TRANSACTION_MAX_FILES ||
      input.operations.length > TRANSACTION_MAX_OPERATIONS ||
      (input.readDependencies?.length ?? 0) > TRANSACTION_MAX_READ_DEPENDENCIES ||
      (input.artifacts?.length ?? 0) > TRANSACTION_MAX_ARTIFACTS ||
      (input.diagnostics?.length ?? 0) > TRANSACTION_MAX_DIAGNOSTICS
    ) {
      throw new ServiceError(
        'TRANSACTION_STRUCTURE_LIMIT',
        'Transaction input exceeds the supported review structure limits',
      );
    }
    if (typeof input.validate !== 'function') {
      throw new ServiceError(
        'TRANSACTION_DRY_RUN_VALIDATION_REQUIRED',
        'Every transaction plan requires in-memory validation',
      );
    }
    const workspace = this.resolver.get(input.workspaceId, input.principal);
    const sortedChanges = [...input.changes].sort((a, b) =>
      compareCodeUnits(a.relativePath, b.relativePath),
    );
    const seen = new Set<string>();
    const seenTargets = new Map<string, string>();
    const resolvedChanges: Array<{
      change: ProposedFileChange;
      resolved: Awaited<ReturnType<WorkspaceResolver['resolvePath']>>;
    }> = [];
    for (const change of sortedChanges) {
      input.signal?.throwIfAborted();
      if (seen.has(change.relativePath)) {
        throw new ServiceError(
          'TRANSACTION_DUPLICATE_FILE',
          `Transaction changes a file more than once: ${change.relativePath}`,
        );
      }
      seen.add(change.relativePath);
      const resolved = await this.resolver.resolvePath(
        input.workspaceId,
        change.relativePath,
        'write',
        ['mod'],
        input.principal,
      );
      const targetKey =
        process.platform === 'win32' ? resolved.path.toLocaleLowerCase('en-US') : resolved.path;
      const targetAlias = seenTargets.get(targetKey);
      if (targetAlias !== undefined) {
        throw new ServiceError(
          'TRANSACTION_DUPLICATE_FILE',
          `Transaction path aliases target the same file: ${targetAlias} and ${change.relativePath}`,
        );
      }
      seenTargets.set(targetKey, change.relativePath);
      if (!isWithin(workspace.modRoot, resolved.path)) {
        throw new ServiceError(
          'TRANSACTION_PATH_OUTSIDE_MOD',
          'Transaction targets a path outside the mod root',
        );
      }
      resolvedChanges.push({ change, resolved });
    }
    const transactionId = secureId('txn');
    const pendingBlobs = new Map<string, Buffer>();
    let pendingBlobBytes = 0;
    const rememberBlob = (bytes: Buffer): string => {
      const hash = sha256Bytes(bytes);
      if (!pendingBlobs.has(hash)) {
        pendingBlobBytes += bytes.length;
        if (!Number.isSafeInteger(pendingBlobBytes) || pendingBlobBytes > this.maxJournalBytes) {
          throw new ServiceError(
            'TRANSACTION_JOURNAL_LIMIT',
            'Proposed rollback data exceeds the configured transaction-journal budget',
          );
        }
        pendingBlobs.set(hash, bytes);
      }
      return path.join('blobs', hash).replaceAll('\\', '/');
    };
    const proposed = new Map<string, Buffer | null>();
    const files: TransactionFileChange[] = [];
    const suppliedArtifacts: ArtifactLink[] = (input.artifacts ?? []).map(publicArtifactLink);
    const pendingDiffs: Array<{
      relativePath: string;
      before: Buffer | null;
      after: Buffer | null;
    }> = [];

    for (const { change, resolved } of resolvedChanges) {
      input.signal?.throwIfAborted();
      const before = (await fileExists(resolved.path)) ? await readFile(resolved.path) : null;
      const after = change.content === null ? null : Buffer.from(change.content);
      if (before !== null && after !== null && before.equals(after)) continue;
      if (before === null && after === null) continue;
      proposed.set(change.relativePath, after);
      const beforeSha256 = before === null ? null : sha256Bytes(before);
      const afterSha256 = after === null ? null : sha256Bytes(after);
      const beforeBlob = before === null ? null : rememberBlob(before);
      const afterBlob = after === null ? null : rememberBlob(after);
      const mediaType = change.mediaType ?? inferMediaType(change.relativePath);
      pendingDiffs.push({ relativePath: change.relativePath, before, after });
      files.push({
        relativePath: change.relativePath,
        operationIds: [...change.operationIds].sort((a, b) => compareCodeUnits(a, b)),
        beforeSha256,
        afterSha256,
        beforeSize: before?.length ?? null,
        afterSize: after?.length ?? null,
        beforeBlob,
        afterBlob,
        mediaType,
      });
    }

    const validation = await input.validate(proposed, input.signal);
    if (validation.checks.length === 0) {
      throw new ServiceError(
        'TRANSACTION_DRY_RUN_VALIDATION_REQUIRED',
        'Dry-run validation must report at least one explicit check',
      );
    }
    const diagnostics = [...(input.diagnostics ?? []), ...validation.diagnostics];
    if (
      validation.checks.length > TRANSACTION_MAX_VALIDATION_CHECKS ||
      diagnostics.length > TRANSACTION_MAX_DIAGNOSTICS ||
      suppliedArtifacts.length + files.length > TRANSACTION_MAX_ARTIFACTS
    ) {
      throw new ServiceError(
        'TRANSACTION_STRUCTURE_LIMIT',
        'Transaction validation or evidence exceeds the supported review structure limits',
      );
    }
    const passed =
      !diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker') &&
      validation.checks.every(({ passed }) => passed);
    input.signal?.throwIfAborted();
    const diffWrites: ArtifactWrite[] = files.map((file, index) => {
      const pending = pendingDiffs[index]!;
      const sourceHashes = {
        ...(file.beforeSha256 === null ? {} : { before: file.beforeSha256 }),
        ...(file.afterSha256 === null ? {} : { after: file.afterSha256 }),
      };
      const sourceStateMetadata = {
        beforeState: file.beforeSha256 === null ? 'missing' : 'present',
        afterState: file.afterSha256 === null ? 'deleted' : 'present',
      };
      if (isText(file.mediaType)) {
        return {
          name: `${path.basename(pending.relativePath)}.diff`,
          mimeType: 'text/x-diff',
          content: unifiedTextDiff(
            sourceDiffText(pending.before),
            sourceDiffText(pending.after),
            `a/${pending.relativePath}`,
            `b/${pending.relativePath}`,
            { ...(input.signal === undefined ? {} : { signal: input.signal }) },
          ),
          provenance: {
            kind: 'source-diff',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'transaction.v1',
            sourceHashes,
            metadata: sourceStateMetadata,
          },
        };
      }
      return {
        name: `${path.basename(pending.relativePath)}.binary-diff.json`,
        mimeType: 'application/json',
        content: `${canonicalJson(
          binaryDiff(pending.before ?? Buffer.alloc(0), pending.after ?? Buffer.alloc(0)),
        )}\n`,
        provenance: {
          kind: 'binary-diff',
          toolVersion: PACKAGE_VERSION,
          schemaVersion: 'transaction.v1',
          sourceHashes,
          metadata: sourceStateMetadata,
        },
      };
    });

    return this.artifacts.withAtomicWrites(
      workspace,
      diffWrites,
      async (storedDiffs) => {
        input.signal?.throwIfAborted();
        const diffArtifacts = storedDiffs.map(publicArtifactLink);
        const filesWithDiffs = files.map((file, index) => ({
          ...file,
          diffArtifact: diffArtifacts[index]!,
        }));
        const artifacts = [...suppliedArtifacts, ...diffArtifacts];
        const now = Date.now();
        const manifestWithoutHashes: Omit<
          TransactionManifest,
          'planHash' | 'planPayload' | 'integrityHash' | 'authenticationTag'
        > = {
          version: TRANSACTION_VERSION,
          revision: 1,
          transactionId,
          workspaceId: input.workspaceId,
          ...(input.principal === undefined ? {} : { principal: input.principal }),
          rootFingerprint: this.rootFingerprint(workspace),
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString(),
          state: 'planned',
          operationKind: input.operationKind,
          operations: input.operations,
          readDependencies: [...(input.readDependencies ?? [])].sort(
            (left, right) =>
              left.loadOrder - right.loadOrder ||
              compareCodeUnits(left.rootKind, right.rootKind) ||
              compareCodeUnits(left.relativePath, right.relativePath),
          ),
          files: filesWithDiffs,
          diagnostics,
          validation: { passed, checks: validation.checks },
          artifacts,
          appliedFiles: [],
          rollbackStatus: 'available',
        };
        const planPayload = manifestPlanPayload(manifestWithoutHashes);
        const manifest: TransactionManifest = {
          ...manifestWithoutHashes,
          planPayload,
          planHash: hashCanonical(planPayload),
          integrityHash: '',
          authenticationTag: '',
        };
        await this.commitPlannedJournal(workspace, manifest, pendingBlobs);
        return manifest;
      },
      input.signal,
    );
  }

  async apply(
    workspaceId: string,
    transactionId: string,
    expectedPlanHash: string,
    options: ApplyTransactionOptions,
  ): Promise<TransactionManifest>;
  async apply(
    workspaceId: string,
    transactionId: string,
    expectedPlanHash: string,
    options?: ApplyTransactionOptions,
  ): Promise<TransactionManifest> {
    if (options === undefined || typeof options.postValidate !== 'function') {
      throw new ServiceError(
        'TRANSACTION_POST_VALIDATION_REQUIRED',
        'Every transaction apply requires post-write validation',
      );
    }
    options.signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, options.principal);
    if (!workspace.writeEnabled)
      throw new ServiceError('WRITE_POLICY_DISABLED', 'Workspace writes are not enabled');
    const manifest = await this.load(workspace, transactionId, {
      headMode: 'reconcile',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.assertBinding(manifest, workspace, expectedPlanHash, options.principal);
    if (!manifest.planPayload.validation.passed)
      throw new ServiceError('TRANSACTION_VALIDATION_BLOCKED', 'Dry-run validation did not pass');
    if (manifest.files.length === 0)
      throw new ServiceError('TRANSACTION_NO_CHANGES', 'Transaction contains no file changes');
    if (manifest.state !== 'planned')
      throw new ServiceError('TRANSACTION_STATE_INVALID', `Transaction is ${manifest.state}`);
    if (Date.parse(manifest.expiresAt) <= Date.now())
      throw new ServiceError('TRANSACTION_EXPIRED', 'Transaction has expired');

    return this.withWorkspaceLock(workspace, transactionId, async () => {
      await this.verifyReadDependencies(workspace, manifest, options.principal, options.signal);
      await this.verifyCurrentFiles(
        workspace,
        manifest,
        'before',
        options.principal,
        options.signal,
      );
      const targets: Array<{ target: string; staged: string | null; backup: string }> = [];
      try {
        manifest.state = 'applying';
        await this.writeManifest(workspace, manifest, options.hooks);
        for (const [index, file] of manifest.files.entries()) {
          options.signal?.throwIfAborted();
          const { path: target } = await this.resolver.resolvePath(
            workspaceId,
            file.relativePath,
            'write',
            ['mod'],
            options.principal,
          );
          await mkdir(path.dirname(target), { recursive: true });
          const staged =
            file.afterBlob === null ? null : `${target}.hoi4-agent-${transactionId}.stage`;
          const backup = `${target}.hoi4-agent-${transactionId}.backup`;
          if (staged !== null && file.afterBlob !== null) {
            const bytes = await this.readVerifiedBlob(workspace, manifest, file, 'after');
            await durableWrite(staged, bytes);
          }
          targets.push({ target, staged, backup });
          await options.hooks?.afterStage?.(file.relativePath, index);
        }

        for (const [index, file] of manifest.files.entries()) {
          options.signal?.throwIfAborted();
          const target = targets[index]!;
          const existsBeforeReplace = await fileExists(target.target);
          const actualBeforeReplace = existsBeforeReplace
            ? sha256Bytes(await readFile(target.target))
            : null;
          if (actualBeforeReplace !== file.beforeSha256) {
            throw new ServiceError(
              'TRANSACTION_STALE',
              'Source changed while transaction output was being staged',
            );
          }
          if (existsBeforeReplace) await rename(target.target, target.backup);
          await options.hooks?.afterBackup?.(file.relativePath, index);
          if (target.staged !== null) {
            if (await fileExists(target.target)) {
              throw new ServiceError(
                'TRANSACTION_STALE',
                'Source target was recreated during atomic replacement',
              );
            }
            await rename(target.staged, target.target);
          }
          manifest.appliedFiles.push(file.relativePath);
          await this.writeManifest(workspace, manifest, options.hooks);
          await options.hooks?.afterReplace?.(file.relativePath, index);
        }

        await options.hooks?.beforePostValidation?.();
        const result = await options.postValidate(manifest, options.signal);
        if (result.checks.length === 0) {
          throw new ServiceError(
            'TRANSACTION_POST_VALIDATION_REQUIRED',
            'Post-write validation must report at least one explicit check',
          );
        }
        if (
          manifest.diagnostics.length + result.diagnostics.length > TRANSACTION_MAX_DIAGNOSTICS ||
          manifest.validation.checks.length + result.checks.length >
            TRANSACTION_MAX_VALIDATION_CHECKS
        ) {
          throw new ServiceError(
            'TRANSACTION_STRUCTURE_LIMIT',
            'Post-write validation exceeds the supported transaction review structure limits',
          );
        }
        manifest.diagnostics.push(...result.diagnostics);
        manifest.validation.checks.push(...result.checks);
        manifest.validation.passed =
          manifest.validation.passed &&
          result.checks.every(({ passed }) => passed) &&
          !result.diagnostics.some(
            ({ severity }) => severity === 'error' || severity === 'blocker',
          );
        if (!manifest.validation.passed) {
          throw new ServiceError(
            'TRANSACTION_POST_VALIDATION_FAILED',
            'Post-write validation failed',
          );
        }
        await this.verifyCurrentFiles(
          workspace,
          manifest,
          'after',
          options.principal,
          options.signal,
        );
        for (const target of targets) {
          if (await fileExists(target.backup)) await unlink(target.backup);
        }
        manifest.state = 'applied';
        await this.writeManifest(workspace, manifest, options.hooks);
        return manifest;
      } catch (error) {
        manifest.failure = this.safeFailure(
          error,
          'TRANSACTION_APPLY_FAILED',
          'Transaction apply failed',
        );
        let rollbackError: unknown;
        try {
          await this.restoreBeforeState(workspace, manifest, options.principal, options.hooks);
        } catch (caught) {
          rollbackError = caught;
          manifest.rollbackStatus = 'failed';
          manifest.failure = this.safeFailure(
            caught,
            'TRANSACTION_ROLLBACK_FAILED',
            'Automatic rollback could not safely complete',
          );
        }
        manifest.state = manifest.rollbackStatus === 'applied' ? 'rolled_back' : 'failed';
        await this.writeManifest(workspace, manifest, options.hooks);
        if (rollbackError instanceof ServiceError) throw rollbackError;
        if (rollbackError !== undefined) {
          throw new ServiceError(
            'TRANSACTION_ROLLBACK_FAILED',
            'Automatic rollback could not safely complete',
          );
        }
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('TRANSACTION_APPLY_FAILED', 'Transaction apply failed');
      }
    });
  }

  async rollback(
    workspaceId: string,
    transactionId: string,
    expectedPlanHash: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<TransactionManifest> {
    signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, principal);
    if (!workspace.writeEnabled)
      throw new ServiceError('WRITE_POLICY_DISABLED', 'Workspace writes are not enabled');
    const manifest = await this.load(workspace, transactionId, {
      headMode: 'reconcile',
      ...(signal === undefined ? {} : { signal }),
    });
    this.assertBinding(manifest, workspace, expectedPlanHash, principal);
    if (manifest.state !== 'applied')
      throw new ServiceError(
        'TRANSACTION_NOT_APPLIED',
        'Only applied transactions can be rolled back',
      );
    return this.withWorkspaceLock(workspace, transactionId, async () => {
      signal?.throwIfAborted();
      await this.verifyCurrentFiles(workspace, manifest, 'after', principal, signal);
      signal?.throwIfAborted();
      // Restoring source bytes and advancing the authenticated journal are one
      // non-cancellable critical phase once preflight has completed.
      await this.restoreBeforeState(workspace, manifest, principal);
      manifest.state = 'rolled_back';
      await this.writeManifest(workspace, manifest);
      return manifest;
    });
  }

  async status(
    workspaceId: string,
    transactionId: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<TransactionManifest> {
    signal?.throwIfAborted();
    const manifest = await this.load(this.resolver.get(workspaceId, principal), transactionId, {
      ...(signal === undefined ? {} : { signal }),
    });
    if ((manifest.principal ?? null) !== (principal ?? null)) {
      throw new ServiceError(
        'TRANSACTION_PRINCIPAL_MISMATCH',
        'Transaction belongs to another principal',
      );
    }
    return manifest;
  }

  async readManifestRange(
    workspaceId: string,
    transactionId: string,
    range: { offset: number; length: number },
    principal?: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; totalSize: number }> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(range.offset) ||
      !Number.isSafeInteger(range.length) ||
      range.offset < 0 ||
      range.length < 1 ||
      range.length > transactionManifestRangeMaxBytes
    ) {
      throw new ServiceError(
        'TRANSACTION_RANGE_INVALID',
        `Transaction manifest ranges must request 1 through ${transactionManifestRangeMaxBytes} bytes`,
      );
    }
    const workspace = this.resolver.get(workspaceId, principal);
    const cacheKey = this.manifestCacheKey(workspace, transactionId);
    const manifestPath = await this.manifestPath(workspace, transactionId);
    signal?.throwIfAborted();
    let metadata;
    try {
      metadata = transactionManifestFileIdentity(await stat(manifestPath));
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      this.removeManifestByteCache(cacheKey);
      throw new ServiceError('TRANSACTION_NOT_FOUND', 'Transaction was not found');
    }
    signal?.throwIfAborted();
    let cached = this.#manifestByteCache.get(cacheKey);
    if (cached !== undefined && sameTransactionManifestIdentity(cached.identity, metadata)) {
      if (cached.principal !== (principal ?? null)) {
        throw new ServiceError(
          'TRANSACTION_PRINCIPAL_MISMATCH',
          'Transaction belongs to another principal',
        );
      }
      await this.requireServerState().verifyJournalHead(
        {
          workspaceIdentity: workspace.workspaceIdentity,
          transactionId,
          revision: cached.revision,
          authenticationTag: cached.authenticationTag,
          manifestHash: cached.manifestHash,
        },
        signal,
      );
      this.#manifestByteCache.delete(cacheKey);
      this.#manifestByteCache.set(cacheKey, cached);
    } else {
      this.removeManifestByteCache(cacheKey);
      const manifest = await this.load(workspace, transactionId, {
        cacheBytes: true,
        ...(signal === undefined ? {} : { signal }),
      });
      if ((manifest.principal ?? null) !== (principal ?? null)) {
        throw new ServiceError(
          'TRANSACTION_PRINCIPAL_MISMATCH',
          'Transaction belongs to another principal',
        );
      }
      cached = this.#manifestByteCache.get(cacheKey);
      if (cached === undefined) {
        throw new ServiceError(
          'TRANSACTION_MANIFEST_INVALID',
          'Transaction manifest could not be prepared for bounded resource access',
        );
      }
    }
    signal?.throwIfAborted();
    const start = Math.min(range.offset, cached.bytes.length);
    return {
      bytes: Buffer.from(
        cached.bytes.subarray(start, Math.min(cached.bytes.length, start + range.length)),
      ),
      totalSize: cached.bytes.length,
    };
  }

  async recover(
    workspaceId: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<TransactionManifest[]> {
    signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, principal);
    const directory = await containedGeneratedPath(workspace.cacheRoot, 'transactions');
    signal?.throwIfAborted();
    if (!(await fileExists(directory))) {
      signal?.throwIfAborted();
      await this.removeOrphanJournalHeads(workspace, new Set(), signal);
      return [];
    }
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    signal?.throwIfAborted();
    const transactionIds = new Set(
      directoryEntries
        .filter((entry) => entry.isDirectory() && transactionIdPattern.test(entry.name))
        .map((entry) => entry.name),
    );
    await this.removeOrphanJournalHeads(workspace, transactionIds, signal);
    const recovered: TransactionManifest[] = [];
    for (const entry of directoryEntries.filter((value) => value.isDirectory())) {
      signal?.throwIfAborted();
      if (!transactionIdPattern.test(entry.name)) continue;
      const manifest = await this.load(workspace, entry.name, {
        headMode: 'reconcile',
        ...(signal === undefined ? {} : { signal }),
      });
      if (principal !== undefined && (manifest.principal ?? null) !== principal) {
        throw new ServiceError(
          'TRANSACTION_PRINCIPAL_MISMATCH',
          'Transaction recovery belongs to another principal',
        );
      }
      if (manifest.state !== 'applying' && manifest.state !== 'rolling_back') continue;
      await this.withWorkspaceLock(workspace, manifest.transactionId, async () => {
        signal?.throwIfAborted();
        // Once source restoration starts, recovery and authenticated journal
        // advancement form a non-cancellable critical phase.
        try {
          await this.restoreBeforeState(workspace, manifest, principal);
          manifest.state = 'rolled_back';
          manifest.failure = {
            code: 'TRANSACTION_RECOVERED',
            message: 'Incomplete transaction was rolled back during recovery',
          };
          await this.writeManifest(workspace, manifest);
        } catch (error) {
          manifest.rollbackStatus = 'failed';
          manifest.state = 'failed';
          manifest.failure = this.safeFailure(
            error,
            'TRANSACTION_RECOVERY_FAILED',
            'Interrupted transaction could not be recovered safely',
          );
          await this.writeManifest(workspace, manifest);
          if (error instanceof ServiceError) throw error;
          throw new ServiceError(
            'TRANSACTION_RECOVERY_FAILED',
            'Interrupted transaction could not be recovered safely',
          );
        }
      });
      recovered.push(manifest);
    }
    return recovered;
  }

  private async restoreBeforeState(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    principal?: string,
    hooks?: TransactionHooks,
  ): Promise<void> {
    const restorations: Array<{
      file: TransactionFileChange;
      target: string;
      backup: string;
      staged: string;
      mode: 'backup' | 'blob' | 'delete' | 'keep';
      bytes?: Buffer;
    }> = [];
    // Prove that every required rollback source is intact before changing any
    // current file. This keeps a corrupt cache from turning a safe refusal into
    // source loss halfway through rollback.
    for (const file of manifest.files) {
      const { path: target } = await this.resolver.resolvePath(
        workspace.id,
        file.relativePath,
        'write',
        ['mod'],
        principal,
      );
      const backup = `${target}.hoi4-agent-${manifest.transactionId}.backup`;
      const staged = `${target}.hoi4-agent-${manifest.transactionId}.stage`;
      const current = (await fileExists(target)) ? await readFile(target) : null;
      const currentHash = current === null ? null : sha256Bytes(current);
      const backupExists = await fileExists(backup);
      let backupValid = false;
      if (backupExists) {
        if (file.beforeSha256 === null) {
          throw new ServiceError(
            'TRANSACTION_ROLLBACK_STALE',
            'Rollback encountered unexpected backup state',
          );
        }
        const backupBytes = await readFile(backup);
        if (sha256Bytes(backupBytes) !== file.beforeSha256) {
          throw new ServiceError(
            'TRANSACTION_BLOB_INTEGRITY_FAILED',
            'Rollback backup failed integrity validation',
          );
        }
        backupValid = true;
      }
      if (currentHash === file.beforeSha256) {
        restorations.push({ file, target, backup, staged, mode: 'keep' });
        continue;
      }
      const matchesAfter = currentHash === file.afterSha256;
      const missingAfterBackup = currentHash === null && file.afterSha256 !== null && backupValid;
      // Versions before the atomic replacement fix could crash after unlinking an
      // applied target but before restoring its persisted before-blob. A durable
      // rolling_back manifest proves rollback had already started; the verified
      // before-blob is therefore the only safe recovery source when no backup is
      // present. Never grant this exception to applying or terminal journals.
      const missingDuringBlobRollback =
        manifest.state === 'rolling_back' &&
        currentHash === null &&
        file.beforeSha256 !== null &&
        !backupValid;
      if (!matchesAfter && !missingAfterBackup && !missingDuringBlobRollback) {
        throw new ServiceError(
          'TRANSACTION_ROLLBACK_STALE',
          'Rollback refused to overwrite source bytes not produced by this transaction',
        );
      }
      if (file.beforeSha256 === null) {
        restorations.push({ file, target, backup, staged, mode: 'delete' });
        continue;
      }
      if (backupValid) {
        restorations.push({ file, target, backup, staged, mode: 'backup' });
        continue;
      }
      restorations.push({
        file,
        target,
        backup,
        staged,
        mode: 'blob',
        bytes: await this.readVerifiedBlob(workspace, manifest, file, 'before'),
      });
    }
    manifest.state = 'rolling_back';
    await this.writeManifest(workspace, manifest, hooks);
    for (const restoration of restorations.reverse()) {
      if (restoration.mode === 'backup') {
        // Renaming over the target is the atomic replacement primitive. The
        // verified backup remains available if replacement fails or the process
        // stops before the rename completes.
        await rename(restoration.backup, restoration.target);
      } else if (restoration.mode === 'blob') {
        // durableWrite stages and fsyncs a same-directory temporary before an
        // atomic rename over the target. Do not unlink first: doing so creates a
        // crash window in which neither old nor restored bytes occupy the path.
        await durableWrite(restoration.target, restoration.bytes!);
        if (await fileExists(restoration.backup)) await unlink(restoration.backup);
      } else if (restoration.mode === 'delete') {
        if (await fileExists(restoration.target)) await unlink(restoration.target);
        if (await fileExists(restoration.backup)) await unlink(restoration.backup);
      } else if (await fileExists(restoration.backup)) {
        await unlink(restoration.backup);
      }
      if (await fileExists(restoration.staged)) await unlink(restoration.staged);
    }
    await this.verifyCurrentFiles(workspace, manifest, 'before', principal);
    manifest.rollbackStatus = 'applied';
  }

  private safeFailure(
    error: unknown,
    fallbackCode: string,
    message: string,
  ): { code: string; message: string } {
    return {
      code: error instanceof ServiceError ? error.code : fallbackCode,
      message,
    };
  }

  private assertBinding(
    manifest: TransactionManifest,
    workspace: ResolvedWorkspace,
    expectedPlanHash: string,
    principal?: string,
  ): void {
    if (manifest.workspaceId !== workspace.id)
      throw new ServiceError(
        'TRANSACTION_WORKSPACE_MISMATCH',
        'Transaction belongs to another workspace',
      );
    if (manifest.planHash !== expectedPlanHash)
      throw new ServiceError(
        'TRANSACTION_PLAN_HASH_MISMATCH',
        'Expected plan hash does not match transaction',
      );
    if (manifest.rootFingerprint !== this.rootFingerprint(workspace))
      throw new ServiceError(
        'TRANSACTION_ROOT_CHANGED',
        'Workspace root configuration changed after planning',
      );
    if ((manifest.principal ?? null) !== (principal ?? null))
      throw new ServiceError(
        'TRANSACTION_PRINCIPAL_MISMATCH',
        'Transaction belongs to another principal',
      );
  }

  private async verifyCurrentFiles(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    phase: 'before' | 'after',
    principal?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const { path: target } = await this.resolver.resolvePath(
        workspace.id,
        file.relativePath,
        'write',
        ['mod'],
        principal,
      );
      const exists = await fileExists(target);
      const actual = exists ? sha256Bytes(await readFile(target)) : null;
      const expected = phase === 'before' ? file.beforeSha256 : file.afterSha256;
      if (actual !== expected) {
        throw new ServiceError(
          phase === 'before' ? 'TRANSACTION_STALE' : 'TRANSACTION_WRITE_MISMATCH',
          `${file.relativePath} does not match the ${phase} hash`,
          { relativePath: file.relativePath, expected, actual },
        );
      }
    }
  }

  private async verifyReadDependencies(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const dependency of manifest.readDependencies) {
      signal?.throwIfAborted();
      let actual: string | null;
      try {
        const resolved = await this.resolver.resolvePathInRoot(
          workspace.id,
          dependency.relativePath,
          dependency.rootKind,
          dependency.loadOrder,
          principal,
        );
        const bytes =
          signal === undefined
            ? await readFile(resolved.path)
            : await readFile(resolved.path, { signal });
        signal?.throwIfAborted();
        actual = sha256Bytes(bytes);
      } catch (error) {
        if (error instanceof ServiceError && error.code.startsWith('PATH_')) actual = null;
        else throw error;
      }
      if (actual !== dependency.sha256) {
        throw new ServiceError(
          'TRANSACTION_SOURCE_STALE',
          `${dependency.relativePath} changed in a source root after planning`,
          {
            relativePath: dependency.relativePath,
            rootKind: dependency.rootKind,
            loadOrder: dependency.loadOrder,
            expected: dependency.sha256,
            actual,
          },
        );
      }
    }
  }

  private async commitPlannedJournal(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    blobs: ReadonlyMap<string, Buffer>,
  ): Promise<void> {
    await this.withWorkspaceLock(workspace, manifest.transactionId, async () => {
      let transactionsDirectory = await containedGeneratedPath(workspace.cacheRoot, 'transactions');
      await mkdir(transactionsDirectory, { recursive: true });
      transactionsDirectory = await containedGeneratedPath(workspace.cacheRoot, 'transactions');
      await this.pruneExpiredJournals(workspace, transactionsDirectory);
      const usage = await this.journalUsage(transactionsDirectory);

      this.authenticateManifest(manifest);
      const serializedManifest = `${canonicalJson(manifest)}\n`;
      if (Buffer.byteLength(serializedManifest, 'utf8') > TRANSACTION_MAX_MANIFEST_BYTES) {
        throw new ServiceError(
          'TRANSACTION_MANIFEST_LIMIT',
          'Transaction manifest exceeds its fixed byte limit',
        );
      }
      const blobBytes = [...blobs.values()].reduce((total, bytes) => total + bytes.length, 0);
      const prospectiveBytes = blobBytes + Buffer.byteLength(serializedManifest, 'utf8');
      const replacementBytes = manifest.files.reduce(
        (total, file) => total + (file.beforeSize ?? 0) + (file.afterSize ?? 0),
        0,
      );
      const transactionWorkBytes = prospectiveBytes + replacementBytes;
      if (
        !Number.isSafeInteger(prospectiveBytes) ||
        !Number.isSafeInteger(transactionWorkBytes) ||
        usage.count >= this.maxJournals ||
        transactionWorkBytes > this.maxJournalBytes ||
        usage.bytes > this.maxJournalBytes - prospectiveBytes
      ) {
        throw new ServiceError(
          'TRANSACTION_JOURNAL_LIMIT',
          'Transaction journal retention limit has been reached',
        );
      }

      const transactionDirectory = await this.transactionDirectory(
        workspace,
        manifest.transactionId,
      );
      try {
        const blobsDirectory = await containedGeneratedPath(transactionDirectory, 'blobs');
        await mkdir(blobsDirectory, { recursive: true });
        for (const [hash, bytes] of blobs) {
          await durableWrite(await containedGeneratedPath(blobsDirectory, hash), bytes);
        }
        await durableWrite(
          await containedGeneratedPath(transactionDirectory, 'manifest.json'),
          serializedManifest,
        );
        await this.recordInitialManifestHead(workspace, manifest);
      } catch (error) {
        await rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  private async pruneExpiredJournals(
    workspace: ResolvedWorkspace,
    transactionsDirectory: string,
  ): Promise<void> {
    const now = Date.now();
    const entries = await readdir(transactionsDirectory, { withFileTypes: true });
    const cacheTransactionIds = new Set(
      entries.filter((entry) => transactionIdPattern.test(entry.name)).map((entry) => entry.name),
    );
    await this.removeOrphanJournalHeads(workspace, cacheTransactionIds);
    for (const entry of entries) {
      if (!transactionIdPattern.test(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        throw new ServiceError(
          'TRANSACTION_JOURNAL_UNSAFE',
          'Transaction journal contains a symbolic link or junction',
        );
      }
      if (!entry.isDirectory()) continue;
      const directory = await this.transactionDirectory(workspace, entry.name);
      const manifestPath = await containedGeneratedPath(directory, 'manifest.json');
      if (!(await fileExists(manifestPath))) {
        const metadata = await stat(directory);
        if (now - metadata.mtimeMs > this.ttlSeconds * 1000) {
          await this.requireServerState().removeJournalHead(
            workspace.workspaceIdentity,
            entry.name,
          );
          await rm(directory, { recursive: true, force: true });
        }
        continue;
      }
      let manifest: TransactionManifest;
      try {
        manifest = await this.load(workspace, entry.name, { headMode: 'reconcile' });
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'TRANSACTION_HEAD_MISSING') {
          try {
            const orphan = await this.load(workspace, entry.name, { headMode: 'none' });
            if (orphan.state === 'planned' || orphan.state === 'rolled_back') {
              await rm(directory, { recursive: true, force: true });
              continue;
            }
          } catch {
            // Malformed or unauthenticated orphan journals remain visible to quota accounting.
          }
        }
        continue;
      }
      if (
        Date.parse(manifest.expiresAt) <= now &&
        (manifest.state === 'planned' || manifest.state === 'rolled_back')
      ) {
        // Removing protected state first makes a crash or later cache replay fail closed.
        await this.requireServerState().removeJournalHead(workspace.workspaceIdentity, entry.name);
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  private async removeOrphanJournalHeads(
    workspace: ResolvedWorkspace,
    cacheTransactionIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.serverState === undefined) return;
    for (const transactionId of await this.serverState.listJournalHeadTransactionIds(
      workspace.workspaceIdentity,
      signal,
    )) {
      signal?.throwIfAborted();
      if (!cacheTransactionIds.has(transactionId)) {
        await this.requireServerState().removeJournalHead(
          workspace.workspaceIdentity,
          transactionId,
        );
      }
    }
  }

  private async journalUsage(
    transactionsDirectory: string,
  ): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    for (const entry of await readdir(transactionsDirectory, { withFileTypes: true })) {
      if (!transactionIdPattern.test(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        throw new ServiceError(
          'TRANSACTION_JOURNAL_UNSAFE',
          'Transaction journal contains a symbolic link or junction',
        );
      }
      if (!entry.isDirectory()) continue;
      count += 1;
      bytes += await this.directoryBytes(
        await containedGeneratedPath(transactionsDirectory, entry.name),
      );
      if (!Number.isSafeInteger(bytes)) {
        throw new ServiceError(
          'TRANSACTION_JOURNAL_LIMIT',
          'Transaction journal size cannot be represented safely',
        );
      }
    }
    return { count, bytes };
  }

  private async directoryBytes(directory: string): Promise<number> {
    let bytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new ServiceError(
          'TRANSACTION_JOURNAL_UNSAFE',
          'Transaction journal contains a symbolic link or junction',
        );
      }
      const candidate = await containedGeneratedPath(directory, entry.name);
      if (entry.isDirectory()) bytes += await this.directoryBytes(candidate);
      else if (entry.isFile()) bytes += (await stat(candidate)).size;
      if (!Number.isSafeInteger(bytes)) {
        throw new ServiceError(
          'TRANSACTION_JOURNAL_LIMIT',
          'Transaction journal size cannot be represented safely',
        );
      }
    }
    return bytes;
  }

  private async readVerifiedBlob(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    file: TransactionFileChange,
    phase: 'before' | 'after',
  ): Promise<Buffer> {
    const expectedHash = phase === 'before' ? file.beforeSha256 : file.afterSha256;
    const expectedSize = phase === 'before' ? file.beforeSize : file.afterSize;
    const blob = phase === 'before' ? file.beforeBlob : file.afterBlob;
    if (expectedHash === null || expectedSize === null || blob === null) {
      throw new ServiceError(
        'TRANSACTION_BLOB_REFERENCE_INVALID',
        `${file.relativePath} has an incomplete ${phase} blob reference`,
        { relativePath: file.relativePath, phase },
      );
    }
    const expectedBlob = path.join('blobs', expectedHash).replaceAll('\\', '/');
    if (blob !== expectedBlob) {
      throw new ServiceError(
        'TRANSACTION_BLOB_REFERENCE_INVALID',
        `${file.relativePath} has an invalid ${phase} blob path`,
        { relativePath: file.relativePath, phase },
      );
    }
    let bytes: Buffer;
    try {
      const transactionDirectory = await this.transactionDirectory(
        workspace,
        manifest.transactionId,
      );
      bytes = await readFile(await containedGeneratedPath(transactionDirectory, blob));
    } catch (_error) {
      throw new ServiceError(
        'TRANSACTION_BLOB_INTEGRITY_FAILED',
        `${file.relativePath} ${phase} rollback data is missing`,
        {
          relativePath: file.relativePath,
          phase,
        },
      );
    }
    if (bytes.length !== expectedSize || sha256Bytes(bytes) !== expectedHash) {
      throw new ServiceError(
        'TRANSACTION_BLOB_INTEGRITY_FAILED',
        `${file.relativePath} ${phase} rollback data failed integrity validation`,
        { relativePath: file.relativePath, phase },
      );
    }
    return bytes;
  }

  private rootFingerprint(workspace: ResolvedWorkspace): string {
    return transactionRootFingerprint(workspace);
  }

  private requireServerState(): ServerState {
    if (this.serverState === undefined) {
      throw new ServiceError(
        'TRANSACTION_AUTHENTICATION_UNAVAILABLE',
        'Authenticated transaction journals require an operator-controlled server state root',
      );
    }
    return this.serverState;
  }

  private authenticateManifest(manifest: TransactionManifest): void {
    manifest.integrityHash = hashCanonical(manifestIntegrityPayload(manifest));
    manifest.authenticationTag = this.requireServerState().authenticateJournal(
      manifestAuthenticationPayload(manifest),
    );
  }

  private journalHeadInput(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    manifestHash = hashCanonical(manifest),
  ) {
    return {
      workspaceIdentity: workspace.workspaceIdentity,
      transactionId: manifest.transactionId,
      revision: manifest.revision,
      authenticationTag: manifest.authenticationTag,
      manifestHash,
    };
  }

  private async recordInitialManifestHead(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
  ): Promise<void> {
    await this.requireServerState().recordInitialJournalHead(
      this.journalHeadInput(workspace, manifest),
    );
  }

  private async recordManifestSuccessor(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
  ): Promise<void> {
    await this.requireServerState().recordJournalSuccessor(
      this.journalHeadInput(workspace, manifest),
    );
  }

  private async verifyManifestHead(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    mode: Exclude<ManifestHeadMode, 'none'>,
    signal?: AbortSignal,
    manifestHash?: string,
  ): Promise<void> {
    const input = this.journalHeadInput(workspace, manifest, manifestHash);
    if (mode === 'reconcile') {
      await this.requireServerState().verifyOrReconcileJournalHead(input, signal);
      return;
    }
    await this.requireServerState().verifyJournalHead(input, signal);
  }

  private async transactionDirectory(
    workspace: ResolvedWorkspace,
    transactionId: string,
  ): Promise<string> {
    if (!transactionIdPattern.test(transactionId))
      throw new ServiceError('TRANSACTION_ID_INVALID', 'Invalid transaction ID');
    return containedGeneratedPath(workspace.cacheRoot, 'transactions', transactionId);
  }

  private async manifestPath(workspace: ResolvedWorkspace, transactionId: string): Promise<string> {
    return containedGeneratedPath(
      await this.transactionDirectory(workspace, transactionId),
      'manifest.json',
    );
  }

  private manifestCacheKey(workspace: ResolvedWorkspace, transactionId: string): string {
    return `${workspace.workspaceIdentity}\0${transactionId}`;
  }

  private removeManifestByteCache(cacheKey: string): void {
    const existing = this.#manifestByteCache.get(cacheKey);
    if (existing === undefined) return;
    this.#manifestByteCache.delete(cacheKey);
    this.#manifestByteCacheBytes -= existing.bytes.length;
  }

  private storeManifestByteCache(cacheKey: string, entry: TransactionManifestByteCacheEntry): void {
    this.removeManifestByteCache(cacheKey);
    this.#manifestByteCache.set(cacheKey, entry);
    this.#manifestByteCacheBytes += entry.bytes.length;
    while (
      this.#manifestByteCache.size > transactionManifestCacheMaxEntries ||
      this.#manifestByteCacheBytes > transactionManifestCacheMaxBytes
    ) {
      const oldest = this.#manifestByteCache.keys().next().value;
      if (oldest === undefined) break;
      this.removeManifestByteCache(oldest);
    }
  }

  private async writeManifest(
    workspace: ResolvedWorkspace,
    manifest: TransactionManifest,
    hooks?: TransactionHooks,
  ): Promise<void> {
    const candidate = structuredClone(manifest);
    candidate.revision += 1;
    this.authenticateManifest(candidate);
    const serializedCandidate = `${canonicalJson(candidate)}\n`;
    if (Buffer.byteLength(serializedCandidate, 'utf8') > TRANSACTION_MAX_MANIFEST_BYTES) {
      throw new ServiceError(
        'TRANSACTION_MANIFEST_LIMIT',
        'Transaction manifest exceeds its fixed byte limit',
      );
    }
    const transactionDirectory = await this.transactionDirectory(
      workspace,
      candidate.transactionId,
    );
    await hooks?.beforeManifestCacheWrite?.();
    this.removeManifestByteCache(this.manifestCacheKey(workspace, candidate.transactionId));
    await durableWrite(
      await containedGeneratedPath(transactionDirectory, 'manifest.json'),
      serializedCandidate,
    );
    await hooks?.afterManifestCacheWrite?.();
    await hooks?.beforeProtectedHeadCommit?.();
    await this.recordManifestSuccessor(workspace, candidate);
    Object.assign(manifest, candidate);
    await hooks?.afterProtectedHeadCommit?.();
  }

  private async load(
    workspace: ResolvedWorkspace,
    transactionId: string,
    options: { headMode?: ManifestHeadMode; signal?: AbortSignal; cacheBytes?: boolean } = {},
  ): Promise<TransactionManifest> {
    const { headMode = 'verify', signal, cacheBytes = false } = options;
    signal?.throwIfAborted();
    let manifestText: string;
    let manifestPath: string;
    let manifestIdentity: TransactionManifestFileIdentity;
    try {
      const transactionDirectory = await this.transactionDirectory(workspace, transactionId);
      signal?.throwIfAborted();
      manifestPath = await containedGeneratedPath(transactionDirectory, 'manifest.json');
      const metadata = await stat(manifestPath);
      manifestIdentity = transactionManifestFileIdentity(metadata);
      signal?.throwIfAborted();
      if (!metadata.isFile() || metadata.size > TRANSACTION_MAX_MANIFEST_BYTES) {
        throw new ServiceError(
          'TRANSACTION_MANIFEST_LIMIT',
          'Transaction manifest exceeds its fixed byte limit',
        );
      }
      manifestText =
        signal === undefined
          ? await readFile(manifestPath, 'utf8')
          : await readFile(manifestPath, { encoding: 'utf8', signal });
      const afterReadIdentity = transactionManifestFileIdentity(await stat(manifestPath));
      if (!sameTransactionManifestIdentity(manifestIdentity, afterReadIdentity)) {
        throw new ServiceError(
          'TRANSACTION_MANIFEST_CHANGED',
          'Transaction manifest changed while it was being verified',
        );
      }
    } catch (error) {
      if (error instanceof ServiceError || (error as Error).name === 'AbortError') throw error;
      throw new ServiceError('TRANSACTION_NOT_FOUND', 'Transaction was not found');
    }
    signal?.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText) as unknown;
    } catch {
      throw new ServiceError('TRANSACTION_MANIFEST_INVALID', 'Transaction manifest is invalid');
    }
    signal?.throwIfAborted();
    const validated = transactionManifestSchema.safeParse(parsed);
    signal?.throwIfAborted();
    if (!validated.success) {
      throw new ServiceError('TRANSACTION_MANIFEST_INVALID', 'Transaction manifest is invalid', {
        issues: validated.error.issues,
      });
    }
    const manifest = validated.data as unknown as TransactionManifest;
    signal?.throwIfAborted();
    if (
      !this.requireServerState().verifyJournal(
        manifestAuthenticationPayload(manifest),
        manifest.authenticationTag,
      )
    ) {
      throw new ServiceError(
        'TRANSACTION_MANIFEST_AUTHENTICATION_FAILED',
        `Transaction manifest authentication failed: ${transactionId}`,
      );
    }
    signal?.throwIfAborted();
    if (manifest.transactionId !== transactionId || manifest.workspaceId !== workspace.id) {
      throw new ServiceError(
        'TRANSACTION_WORKSPACE_MISMATCH',
        'Transaction manifest identity does not match its workspace or journal directory',
      );
    }
    if (manifest.rootFingerprint !== this.rootFingerprint(workspace)) {
      throw new ServiceError(
        'TRANSACTION_ROOT_CHANGED',
        'Workspace root configuration changed after planning',
      );
    }
    if (hashCanonical(manifestIntegrityPayload(manifest)) !== manifest.integrityHash) {
      throw new ServiceError(
        'TRANSACTION_MANIFEST_INTEGRITY_FAILED',
        `Transaction manifest integrity failed: ${transactionId}`,
      );
    }
    signal?.throwIfAborted();
    if (hashCanonical(manifest.planPayload) !== manifest.planHash) {
      throw new ServiceError(
        'TRANSACTION_PLAN_INTEGRITY_FAILED',
        `Transaction plan hash no longer matches its persisted payload: ${transactionId}`,
      );
    }
    signal?.throwIfAborted();
    const currentPayload = manifestPlanPayload(manifest);
    if (
      hashCanonical(immutablePlanPayload(currentPayload)) !==
      hashCanonical(immutablePlanPayload(manifest.planPayload))
    ) {
      throw new ServiceError(
        'TRANSACTION_PLAN_INTEGRITY_FAILED',
        `Transaction manifest no longer matches its hash-bound plan: ${transactionId}`,
      );
    }
    if (manifest.state === 'planned' && hashCanonical(currentPayload) !== manifest.planHash) {
      throw new ServiceError(
        'TRANSACTION_PLAN_INTEGRITY_FAILED',
        `Planned transaction content no longer matches its plan hash: ${transactionId}`,
      );
    }
    signal?.throwIfAborted();
    const manifestHash = hashCanonical(manifest);
    signal?.throwIfAborted();
    if (headMode !== 'none') {
      await this.verifyManifestHead(workspace, manifest, headMode, signal, manifestHash);
    }
    signal?.throwIfAborted();
    if (cacheBytes) {
      const canonicalBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
      if (canonicalBytes.length > TRANSACTION_MAX_MANIFEST_BYTES) {
        throw new ServiceError(
          'TRANSACTION_MANIFEST_LIMIT',
          'Transaction manifest exceeds its fixed byte limit',
        );
      }
      this.storeManifestByteCache(this.manifestCacheKey(workspace, transactionId), {
        identity: manifestIdentity,
        bytes: canonicalBytes,
        principal: manifest.principal ?? null,
        revision: manifest.revision,
        authenticationTag: manifest.authenticationTag,
        manifestHash,
      });
    }
    return manifest;
  }

  private async withWorkspaceLock<T>(
    workspace: ResolvedWorkspace,
    transactionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let locksDirectory = await containedGeneratedPath(workspace.cacheRoot, 'locks');
    await mkdir(locksDirectory, { recursive: true });
    locksDirectory = await containedGeneratedPath(workspace.cacheRoot, 'locks');
    const lock = await containedGeneratedPath(locksDirectory, 'write.lock');
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const cleared = await this.clearCrashedProcessLock(lock);
        if (!cleared) {
          throw new ServiceError(
            'TRANSACTION_LOCKED',
            'Another write transaction owns the workspace lock',
          );
        }
        try {
          await mkdir(lock);
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ServiceError(
              'TRANSACTION_LOCKED',
              'Another write transaction acquired the workspace lock during recovery',
            );
          }
          throw retryError;
        }
      } else throw error;
    }
    try {
      await durableWrite(
        await containedGeneratedPath(lock, 'owner.json'),
        `${canonicalJson({
          transactionId,
          pid: process.pid,
          host: lockHost,
          instanceId: lockInstanceId,
          processStartedAt: lockProcessStartedAt,
        })}\n`,
      );
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async clearCrashedProcessLock(lock: string): Promise<boolean> {
    let owner: unknown;
    try {
      owner = JSON.parse(
        await readFile(await containedGeneratedPath(lock, 'owner.json'), 'utf8'),
      ) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt or unrecognized owner evidence is never cleared automatically.
        return false;
      }
      // mkdir is the exclusive primitive, so there is necessarily a small window
      // before owner.json is durably renamed into place. Only an ownerless lock
      // older than a generous grace period is evidence of a crash in that window.
      try {
        const metadata = await stat(lock);
        if (Date.now() - metadata.mtimeMs < lockOwnerGraceMs) return false;
      } catch {
        return false;
      }
      await rm(lock, { recursive: true, force: true });
      return true;
    }
    if (
      typeof owner !== 'object' ||
      owner === null ||
      !('pid' in owner) ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !('host' in owner) ||
      typeof owner.host !== 'string' ||
      !('instanceId' in owner) ||
      typeof owner.instanceId !== 'string' ||
      !('processStartedAt' in owner) ||
      typeof owner.processStartedAt !== 'string'
    ) {
      return false;
    }
    // A PID has meaning only on the host that wrote it. Shared-filesystem locks
    // from another or unknown host require explicit operator coordination.
    if (owner.host.toLowerCase() !== lockHost) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    await rm(lock, { recursive: true, force: true });
    return true;
  }
}

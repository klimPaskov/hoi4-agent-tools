import type { CoreEngine } from '../../core/engine.js';
import { canonicalJson } from '../../core/canonical.js';
import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import type { ArtifactLink, ServiceResult } from '../../core/result.js';
import { ServiceError } from '../../core/result.js';
import type { TransactionManifest } from '../../core/transactions.js';
import { PACKAGE_VERSION } from '../../version.js';
import { postValidateTransaction } from './base-tools.js';
import { MAX_INLINE_ARTIFACT_LINKS } from './result.js';

export type TransactionExecutionOutcome = 'applied' | 'blocked' | 'unchanged';

export class AutonomousRewriteError extends ServiceError {
  public constructor(
    cause: ServiceError,
    public readonly manifest: TransactionManifest,
    public readonly artifacts: ArtifactLink[] = [],
  ) {
    const restored = manifest.state === 'rolled_back' && manifest.rollbackStatus === 'applied';
    const code = cause.code.startsWith('TRANSACTION_')
      ? `REWRITE_${cause.code.slice('TRANSACTION_'.length)}`
      : cause.code;
    super(
      code,
      restored
        ? 'Rewrite verification failed and the original files were restored'
        : 'Rewrite failed and automatic recovery could not be completed',
      {
        execution: 'failed',
        automaticRecovery: restored ? 'restored' : 'incomplete',
      },
    );
    this.name = 'AutonomousRewriteError';
  }
}

export interface AutonomousFailureContext {
  proposedFiles?: string[];
  changedFiles?: string[];
  artifacts?: ServiceResult['artifacts'];
  validation?: ServiceResult['validation'];
}

async function storeAutonomousValidationEvidence(
  engine: CoreEngine,
  manifest: TransactionManifest,
  postValidation: Awaited<ReturnType<typeof postValidateTransaction>>,
  principal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ArtifactLink> {
  const diagnostics = [...manifest.diagnostics, ...postValidation.diagnostics];
  const checks = [...manifest.validation.checks, ...postValidation.checks];
  const passed =
    manifest.validation.passed &&
    checks.every((check) => check.passed) &&
    !diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker');
  const sourceEvidence = boundedSourceHashEvidence(
    Object.fromEntries(
      manifest.files.flatMap(({ relativePath, afterSha256 }) =>
        afterSha256 === null ? [] : [[relativePath, afterSha256]],
      ),
    ),
  );
  const artifact = await engine.artifacts.putChunked(
    engine.resolver.get(manifest.workspaceId, principal),
    `${manifest.operationKind}.execution-validation.json`,
    'application/json',
    `${canonicalJson({
      schemaVersion: 1,
      execution: passed ? 'post-validation-passed' : 'post-validation-failed',
      operationKind: manifest.operationKind,
      files: manifest.files.map(({ relativePath, afterSha256, afterSize, mediaType }) => ({
        relativePath,
        afterSha256,
        afterSize,
        mediaType,
      })),
      validation: { passed, checks },
      diagnostics,
      resources: postValidation.artifacts,
    })}\n`,
    {
      kind: 'autonomous-rewrite-execution-validation',
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'autonomous-rewrite-execution-validation.v1',
      sourceHashes: sourceEvidence.sourceHashes,
      metadata: {
        operationKind: manifest.operationKind,
        fileCount: manifest.files.length,
        checkCount: checks.length,
        diagnosticCount: diagnostics.length,
        sourceHashInventory: sourceEvidence.inventory,
      },
    },
    'Complete rewrite and post-write validation evidence',
    signal,
  );
  return publicArtifactLink(artifact);
}

function uniqueArtifacts(artifacts: readonly ArtifactLink[]): ArtifactLink[] {
  const unique = new Map<string, ArtifactLink>();
  for (const artifact of artifacts) unique.set(artifact.uri, artifact);
  return [...unique.values()].slice(0, MAX_INLINE_ARTIFACT_LINKS);
}

export function autonomousResultArtifacts(execution: TransactionExecutionResult): ArtifactLink[] {
  return uniqueArtifacts([...execution.artifacts, ...execution.transaction.artifacts]);
}

export interface TransactionExecutionResult {
  transaction: TransactionManifest;
  outcome: TransactionExecutionOutcome;
  artifacts: ArtifactLink[];
}

/**
 * Complete a validated domain rewrite inside one MCP tool call. Hash checks, durable recovery,
 * post-write validation, and automatic failure recovery remain internal guarantees.
 */
export async function executePlannedTransaction(
  engine: CoreEngine,
  transaction: TransactionManifest,
  principal?: string,
  signal?: AbortSignal,
): Promise<TransactionExecutionResult> {
  if (!transaction.validation.passed) {
    return { transaction, outcome: 'blocked', artifacts: [] };
  }
  if (transaction.files.length === 0) return { transaction, outcome: 'unchanged', artifacts: [] };
  let executionArtifacts: ArtifactLink[] = [];
  try {
    const applied = await engine.transactions.apply(
      transaction.workspaceId,
      transaction.transactionId,
      transaction.planHash,
      {
        ...(principal === undefined ? {} : { principal }),
        ...(signal === undefined ? {} : { signal }),
        postValidate: async (manifest, validationSignal) => {
          const validation = await postValidateTransaction(
            engine,
            manifest,
            principal,
            validationSignal,
          );
          executionArtifacts = [...validation.artifacts];
          executionArtifacts.unshift(
            await storeAutonomousValidationEvidence(
              engine,
              manifest,
              validation,
              principal,
              validationSignal,
            ),
          );
          return validation;
        },
      },
    );
    // Post-validation already invalidates and rebuilds the shared index before apply can succeed.
    return { transaction: applied, outcome: 'applied', artifacts: executionArtifacts };
  } catch (error) {
    engine.invalidate(transaction.workspaceId);
    try {
      const manifest = await engine.transactions.status(
        transaction.workspaceId,
        transaction.transactionId,
        principal,
      );
      const cause =
        error instanceof ServiceError
          ? error
          : new ServiceError('AUTONOMOUS_REWRITE_FAILED', 'Autonomous rewrite failed');
      throw new AutonomousRewriteError(cause, manifest, executionArtifacts);
    } catch (statusError) {
      if (statusError instanceof AutonomousRewriteError) throw statusError;
      throw error;
    }
  }
}

export function autonomousFailureContext(error: unknown): AutonomousFailureContext | undefined {
  if (!(error instanceof AutonomousRewriteError)) return undefined;
  const manifest = error.manifest;
  return {
    proposedFiles: manifest.files.slice(0, 100).map(({ relativePath }) => relativePath),
    changedFiles:
      manifest.rollbackStatus === 'failed'
        ? manifest.files.slice(0, 100).map(({ relativePath }) => relativePath)
        : [],
    artifacts: uniqueArtifacts([...error.artifacts, ...manifest.artifacts]),
    validation: manifest.validation,
  };
}

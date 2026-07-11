import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { compareCodeUnits, canonicalJson, sha256Bytes } from '../../core/canonical.js';
import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import { workspaceRegistrationSchema } from '../../core/configuration.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import type { CoreEngine, WorkspaceStatus } from '../../core/engine.js';
import { emptyServiceResult, ServiceError } from '../../core/result.js';
import { parseClausewitz } from '../../core/source/index.js';
import type { TransactionManifest } from '../../core/transactions.js';
import {
  importContinuousFocusPalettes,
  importFocusTrees,
  layoutFocusTreeAsync,
  lintContinuousFocusPalette,
  lintFocusTree,
  type FocusReferenceCatalog,
} from '../../focus/index.js';
import { ScriptedGuiStudio } from '../../gui/index.js';
import { AgentNudger, attributeMapValidationDiagnostics } from '../../map/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import {
  artifactDescriptionSchema,
  indexSkippedSourceSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
  transactionIdSchema,
  transactionStateDataSchema,
  transactionStateSchema,
  WORKSPACE_INLINE_OWNER_PATHS,
  WORKSPACE_INLINE_REPLACE_PATHS,
  workspaceStatusSchema,
} from './output-schemas.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from './result.js';
import { progressReporter } from './progress.js';
import { artifactLinkSchema } from '../../schemas/transaction.js';

const projectRegisterOutputSchema = strictOperationResultSchema(
  z.object({ workspace: workspaceStatusSchema }).strict(),
);
const projectStatusOutputSchema = strictOperationResultSchema(
  z
    .object({
      count: nonNegativeIntegerSchema,
      returned: nonNegativeIntegerSchema,
      workspaces: z.array(workspaceStatusSchema).max(1),
      nextCursor: z.string().max(4096).optional(),
    })
    .strict(),
);
const projectScanOutputSchema = strictOperationResultSchema(
  z
    .object({
      revision: sha256Schema,
      complete: z.boolean(),
      skippedSourceCount: nonNegativeIntegerSchema,
      skippedSources: z.array(indexSkippedSourceSchema).max(100),
      symbols: nonNegativeIntegerSchema,
      references: nonNegativeIntegerSchema,
      unresolvedReferences: nonNegativeIntegerSchema,
      symbolCounts: z.record(z.string().max(256), nonNegativeIntegerSchema),
    })
    .strict(),
);
const transactionStatusOutputSchema = strictOperationResultSchema(
  z
    .object({
      manifest: z
        .object({
          version: z.number().int().positive(),
          transactionId: transactionIdSchema,
          createdAt: z.iso.datetime(),
          expiresAt: z.iso.datetime(),
          state: transactionStateSchema,
          operationKind: z.string().min(1).max(256),
          operationCount: nonNegativeIntegerSchema,
          readDependencyCount: nonNegativeIntegerSchema,
          fileCount: nonNegativeIntegerSchema,
          diagnosticCount: nonNegativeIntegerSchema,
          artifactCount: nonNegativeIntegerSchema,
          appliedFileCount: nonNegativeIntegerSchema,
          rollbackStatus: z.enum(['available', 'applied', 'failed']),
          failure: z
            .object({ code: z.string().max(256), message: z.string().max(4096) })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
);
const transactionDiffOutputSchema = strictOperationResultSchema(
  z
    .object({
      files: z
        .array(
          z
            .object({
              relativePath: z.string().min(1).max(1024),
              operationIdCount: nonNegativeIntegerSchema,
              operationIds: z.array(z.string().min(1).max(256)).max(20),
              beforeSha256: sha256Schema.nullable(),
              afterSha256: sha256Schema.nullable(),
              beforeSize: nonNegativeIntegerSchema.nullable(),
              afterSize: nonNegativeIntegerSchema.nullable(),
              mediaType: z.string().min(1).max(255),
              diffArtifact: artifactLinkSchema.optional(),
            })
            .strict(),
        )
        .max(20),
      operations: z
        .array(
          z
            .object({
              id: z.string().min(1).max(256),
              kind: z.string().min(1).max(256),
              summary: z.string().max(4096),
            })
            .strict(),
        )
        .max(20),
      fileCount: nonNegativeIntegerSchema,
      operationCount: nonNegativeIntegerSchema,
      artifactCount: nonNegativeIntegerSchema,
      returnedFiles: nonNegativeIntegerSchema,
      returnedOperations: nonNegativeIntegerSchema,
      returnedArtifacts: nonNegativeIntegerSchema,
      nextCursor: z.string().max(4096).optional(),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
);
const transactionMutationOutputSchema = strictOperationResultSchema(
  transactionStateDataSchema
    .extend({
      fileCount: nonNegativeIntegerSchema.optional(),
      appliedFileCount: nonNegativeIntegerSchema.optional(),
      artifactCount: nonNegativeIntegerSchema.optional(),
    })
    .strict(),
);
const artifactListOutputSchema = strictOperationResultSchema(
  z
    .object({
      count: nonNegativeIntegerSchema,
      returned: nonNegativeIntegerSchema,
      nextCursor: z.string().max(4096).optional(),
    })
    .strict(),
);
const artifactDescribeOutputSchema = strictOperationResultSchema(
  z.object({ artifact: artifactDescriptionSchema }).strict(),
);

export interface ServerContext {
  principal?: string;
  scopes?: readonly string[];
}

export function requireServerScope(context: ServerContext, scope: string): void {
  if (context.scopes !== undefined && !context.scopes.includes(scope)) {
    throw new ServiceError('AUTH_SCOPE_REQUIRED', `This operation requires the ${scope} scope`, {
      requiredScope: scope,
    });
  }
}

const workspaceInput = z.object({ workspaceId: z.string().min(1).max(64) }).strict();
const transactionInput = workspaceInput
  .extend({ transactionId: transactionIdSchema, expectedPlanHash: sha256Schema })
  .strict();

function sourcePathComparisonKey(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const artifactCursorSchema = z
  .object({ version: z.literal(1), revision: sha256Schema, after: z.string().min(1).max(2048) })
  .strict();
const workspaceCursorSchema = z
  .object({ version: z.literal(1), revision: sha256Schema, after: z.string().min(1).max(64) })
  .strict();
const transactionDiffCursorSchema = z
  .object({
    version: z.literal(1),
    planHash: sha256Schema,
    fileOffset: nonNegativeIntegerSchema,
    operationOffset: nonNegativeIntegerSchema,
    artifactOffset: nonNegativeIntegerSchema,
  })
  .strict();

function encodeArtifactCursor(revision: string, after: string): string {
  return Buffer.from(canonicalJson({ version: 1, revision, after }), 'utf8').toString('base64url');
}

function decodeArtifactCursor(cursor: string): z.infer<typeof artifactCursorSchema> {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('invalid base64url');
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error('non-canonical base64url');
    return artifactCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
  } catch {
    throw new ServiceError('ARTIFACT_CURSOR_INVALID', 'Artifact list cursor is invalid');
  }
}

function encodeWorkspaceCursor(revision: string, after: string): string {
  return Buffer.from(canonicalJson({ version: 1, revision, after }), 'utf8').toString('base64url');
}

function decodeWorkspaceCursor(cursor: string): z.infer<typeof workspaceCursorSchema> {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('invalid base64url');
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error('non-canonical base64url');
    return workspaceCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
  } catch {
    throw new ServiceError('WORKSPACE_CURSOR_INVALID', 'Workspace status cursor is invalid');
  }
}

function encodeTransactionDiffCursor(
  planHash: string,
  fileOffset: number,
  operationOffset: number,
  artifactOffset: number,
): string {
  return Buffer.from(
    canonicalJson({
      version: 1,
      planHash,
      fileOffset,
      operationOffset,
      artifactOffset,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeTransactionDiffCursor(cursor: string): z.infer<typeof transactionDiffCursorSchema> {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('invalid base64url');
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error('non-canonical base64url');
    return transactionDiffCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
  } catch {
    throw new ServiceError('TRANSACTION_CURSOR_INVALID', 'Transaction diff cursor is invalid');
  }
}

export function transactionResourceLink(manifest: TransactionManifest) {
  return {
    uri: `hoi4-agent://workspace/${encodeURIComponent(manifest.workspaceId)}/transaction/${encodeURIComponent(manifest.transactionId)}`,
    name: `${manifest.transactionId}.manifest.json`,
    mimeType: 'application/json',
    description: 'Complete authenticated transaction manifest and rollback status',
  };
}

export function compactWorkspaceStatus(status: WorkspaceStatus) {
  return {
    ...status,
    replacePathCount: status.replacePaths.length,
    replacePaths: status.replacePaths.slice(0, WORKSPACE_INLINE_REPLACE_PATHS),
    replacePathsTruncated: status.replacePaths.length > WORKSPACE_INLINE_REPLACE_PATHS,
    replacementOwners: status.replacementOwners.map((owner) => ({
      ...owner,
      pathCount: owner.paths.length,
      paths: owner.paths.slice(0, WORKSPACE_INLINE_OWNER_PATHS),
      pathsTruncated: owner.paths.length > WORKSPACE_INLINE_OWNER_PATHS,
    })),
  };
}

function transactionSummary(manifest: TransactionManifest) {
  return {
    version: manifest.version,
    transactionId: manifest.transactionId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    state: manifest.state,
    operationKind: manifest.operationKind,
    operationCount: manifest.operations.length,
    readDependencyCount: manifest.readDependencies.length,
    fileCount: manifest.files.length,
    diagnosticCount: manifest.diagnostics.length,
    artifactCount: manifest.artifacts.length,
    appliedFileCount: manifest.appliedFiles.length,
    rollbackStatus: manifest.rollbackStatus,
    failure: manifest.failure ?? null,
  };
}

function focusReferences(
  engineSnapshot: Awaited<ReturnType<CoreEngine['scan']>>,
): FocusReferenceCatalog {
  const active = (kind: Parameters<typeof engineSnapshot.index.findAll>[0]): string[] =>
    engineSnapshot.index
      .findAll(kind)
      .filter(({ overridden }) => !overridden)
      .map(({ id }) => id);
  return {
    decision: active('decision'),
    decision_category: active('decision_category'),
    event: active('event'),
    idea: active('idea'),
    leader: active('leader'),
    formable: active('formable'),
    helper: active('scripted_effect'),
  };
}

async function postValidateTransaction(
  engine: CoreEngine,
  transaction: TransactionManifest,
  principal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  diagnostics: Diagnostic[];
  checks: { id: string; passed: boolean; message: string }[];
}> {
  engine.invalidate(transaction.workspaceId);
  const snapshot = await engine.scan(transaction.workspaceId, {}, principal, signal);
  const changed = new Set(
    transaction.files.map(({ relativePath }) => sourcePathComparisonKey(relativePath)),
  );
  const diagnostics = snapshot.diagnostics.filter(({ location }) => {
    if (location === undefined) return false;
    const sourcePath = sourcePathComparisonKey(location.path);
    return [...changed].some((relativePath) => sourcePath.endsWith(`:${relativePath}`));
  });
  const checks: { id: string; passed: boolean; message: string }[] = [];

  if (transaction.operationKind === 'focus-plan-changes') {
    const catalog = focusReferences(snapshot);
    for (const file of snapshot.files.filter(
      ({ shadowedBy, relativePath }) =>
        shadowedBy === undefined && changed.has(sourcePathComparisonKey(relativePath)),
    )) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      const imported = importFocusTrees(document, { references: catalog });
      diagnostics.push(...imported.diagnostics);
      for (const plan of imported.plans) {
        const layout = await layoutFocusTreeAsync(plan, signal === undefined ? {} : { signal });
        diagnostics.push(
          ...lintFocusTree(plan, {
            index: snapshot.index,
            references: catalog,
            layout,
          }),
        );
      }
    }
    const passed = !diagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    checks.push({
      id: 'post-write-focus',
      passed,
      message: passed
        ? 'Applied focus source re-imported, laid out, and linted successfully'
        : 'Applied focus source failed post-write import or lint',
    });
  } else if (transaction.operationKind === 'continuous-focus-plan-changes') {
    for (const file of snapshot.files.filter(
      ({ shadowedBy, relativePath }) =>
        shadowedBy === undefined && changed.has(sourcePathComparisonKey(relativePath)),
    )) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      const imported = importContinuousFocusPalettes(document);
      diagnostics.push(...imported.diagnostics);
      for (const plan of imported.continuousFocusPalettes)
        diagnostics.push(...lintContinuousFocusPalette(plan));
    }
    const passed = !diagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    checks.push({
      id: 'post-write-continuous-focus',
      passed,
      message: passed
        ? 'Applied continuous focus source re-imported and linted successfully'
        : 'Applied continuous focus source failed post-write import or lint',
    });
  } else if (
    transaction.operationKind === 'gui-source-change' ||
    transaction.operationKind === 'gui-helper-compilation'
  ) {
    const studio = new ScriptedGuiStudio(engine);
    const scanned = await studio.scan(transaction.workspaceId, principal, signal);
    diagnostics.push(...scanned.graph.diagnostics);
    const passed = !scanned.graph.diagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    checks.push({
      id: 'post-write-gui-graph',
      passed,
      message: passed
        ? 'Applied GUI source graph rebuilt successfully'
        : 'Applied GUI source graph has blocking diagnostics',
    });
  } else if (transaction.operationKind === 'agent-nudger-map-changes') {
    const nudger = new AgentNudger(engine);
    const validated = await nudger.validate(transaction.workspaceId, principal, signal);
    const mapDiagnostics = attributeMapValidationDiagnostics({
      diagnostics: [...diagnostics, ...validated.validation.diagnostics],
      operations: transaction.operations,
      changes: transaction.files,
    });
    diagnostics.length = 0;
    diagnostics.push(...mapDiagnostics);
    checks.push(...validated.validation.checks);
    checks.push({
      id: 'post-write-map',
      passed: validated.validation.passed,
      message: validated.validation.passed
        ? 'Applied map sources rescanned and validated successfully'
        : 'Applied map sources failed post-write validation',
    });
  }

  const passed = !diagnostics.some(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  checks.unshift({
    id: 'post-write-shared-index',
    passed,
    message: passed
      ? 'Changed source reparsed and reindexed successfully'
      : 'Changed source has blocking post-write diagnostics',
  });
  return { diagnostics, checks };
}

export function registerBaseTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  server.registerTool(
    'hoi4.project_register',
    {
      title: 'Register HOI4 workspace',
      description:
        'Register one server-side workspace under a configured registration root; does not edit MCP clients.',
      inputSchema: workspaceRegistrationSchema,
      outputSchema: projectRegisterOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (registration, extra) => {
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        progress.signal.throwIfAborted();
        const status = await engine.register(registration, context.principal, progress.signal);
        const result = emptyServiceResult(status.id, { workspace: compactWorkspaceStatus(status) });
        result.code = 'WORKSPACE_REGISTERED';
        return toolResult(result);
      } catch (error) {
        return errorResult(error, registration.id);
      }
    },
  );

  server.registerTool(
    'hoi4.project_status',
    {
      title: 'Inspect HOI4 workspace status',
      description:
        'Return registered workspace capabilities without exposing canonical server paths.',
      inputSchema: z
        .object({
          workspaceId: z.string().min(1).max(64).optional(),
          cursor: z.string().min(1).max(4096).optional(),
        })
        .strict()
        .superRefine((value, issue) => {
          if (value.workspaceId !== undefined && value.cursor !== undefined) {
            issue.addIssue({
              code: 'custom',
              message: 'cursor is only valid when listing all authorized workspaces',
              path: ['cursor'],
            });
          }
        }),
      outputSchema: projectStatusOutputSchema,
      annotations: readOnly,
    },
    ({ workspaceId, cursor }) => {
      try {
        const statuses =
          workspaceId === undefined
            ? engine
                .list(context.principal)
                .sort((left, right) => compareCodeUnits(left.id, right.id))
            : [engine.status(workspaceId, context.principal)];
        const revision = sha256Bytes(
          Buffer.from(canonicalJson(statuses.map(({ id }) => id)), 'utf8'),
        );
        let offset = 0;
        if (cursor !== undefined) {
          const decoded = decodeWorkspaceCursor(cursor);
          const afterIndex = statuses.findIndex(({ id }) => id === decoded.after);
          if (decoded.revision !== revision || afterIndex < 0) {
            throw new ServiceError(
              'WORKSPACE_CURSOR_STALE',
              'Workspace inventory changed; restart pagination without a cursor',
            );
          }
          offset = afterIndex + 1;
        }
        const page = statuses.slice(offset, offset + 1);
        const last = page.at(-1);
        const nextCursor =
          offset + page.length < statuses.length && last !== undefined
            ? encodeWorkspaceCursor(revision, last.id)
            : undefined;
        const result = emptyServiceResult(workspaceId ?? '', {
          count: statuses.length,
          returned: page.length,
          workspaces: page.map(compactWorkspaceStatus),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        });
        result.code = 'WORKSPACE_STATUS';
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId ?? '');
      }
    },
  );

  server.registerTool(
    'hoi4.project_scan',
    {
      title: 'Scan HOI4 workspace',
      description:
        'Build the shared source/index snapshot across game, dependencies, and mod load order.',
      inputSchema: workspaceInput
        .extend({
          maxFiles: z.number().int().min(1).max(1_000_000).optional(),
          maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
      outputSchema: projectScanOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, maxFiles, maxBytes }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Resolving workspace');
        const snapshot = await engine.scan(
          workspaceId,
          {
            ...(maxFiles === undefined ? {} : { maxFiles }),
            ...(maxBytes === undefined ? {} : { maxBytes }),
          },
          context.principal,
          progress.signal,
        );
        await progress.report(2, 3, 'Writing diagnostics artifact');
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const sourceEvidence = boundedSourceHashEvidence(
          Object.fromEntries(
            snapshot.files.map(({ displayPath, sha256 }) => [displayPath, sha256]),
          ),
        );
        const diagnosticsArtifact = await engine.artifacts.putChunked(
          workspace,
          'diagnostics.json',
          'application/json',
          `${canonicalJson({
            revision: snapshot.revision,
            complete: snapshot.complete,
            skippedSourceCount: snapshot.skippedSourceCount,
            skippedSources: snapshot.skippedSources,
            files: snapshot.files.map(({ displayPath, sha256 }) => ({ displayPath, sha256 })),
            diagnostics: snapshot.diagnostics,
          })}\n`,
          {
            kind: 'diagnostics',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'diagnostics.v1',
            sourceHashes: sourceEvidence.sourceHashes,
            metadata: { sourceHashInventory: sourceEvidence.inventory },
          },
          'Source-linked diagnostics and bounded shared-index completeness report',
          progress.signal,
        );
        const result = emptyServiceResult(workspaceId, {
          revision: snapshot.revision,
          complete: snapshot.complete,
          skippedSourceCount: snapshot.skippedSourceCount,
          skippedSources: snapshot.skippedSources,
          symbols: snapshot.index.symbols.length,
          references: snapshot.index.references.length,
          unresolvedReferences: snapshot.index.unresolvedReferences().length,
          symbolCounts: Object.fromEntries(
            [...new Set(snapshot.index.symbols.map(({ kind }) => kind))]
              .sort((a, b) => compareCodeUnits(a, b))
              .map((kind) => [
                kind,
                snapshot.index.symbols.filter((symbol) => symbol.kind === kind).length,
              ]),
          ),
        });
        result.code = snapshot.complete ? 'WORKSPACE_SCANNED' : 'WORKSPACE_SCANNED_PARTIAL';
        setInlineFilesScanned(
          result,
          snapshot.files.map(({ displayPath }) => displayPath),
        );
        result.diagnostics = snapshot.diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(diagnosticsArtifact)];
        result.validation = {
          passed: !snapshot.diagnostics.some(
            ({ severity }) => severity === 'error' || severity === 'blocker',
          ),
          checks: [
            {
              id: 'shared-index',
              passed: true,
              message: snapshot.complete
                ? `${snapshot.index.symbols.length} symbols indexed from a complete inventory`
                : `${snapshot.index.symbols.length} symbols indexed from an incomplete inventory; ${snapshot.skippedSourceCount} over-limit source(s) were recorded and aggregate index ceilings may also apply`,
            },
          ],
        };
        await progress.report(3, 3, 'Scan complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.transaction_status',
    {
      title: 'Inspect transaction',
      description:
        'Return compact dry-run/apply/rollback counts and current state with a complete manifest resource.',
      inputSchema: workspaceInput.extend({ transactionId: transactionIdSchema }).strict(),
      outputSchema: transactionStatusOutputSchema,
      annotations: readOnly,
    },
    async ({ workspaceId, transactionId }, extra) => {
      try {
        const progress = progressReporter(extra);
        progress.signal.throwIfAborted();
        const manifest = await engine.transactions.status(
          workspaceId,
          transactionId,
          context.principal,
          progress.signal,
        );
        progress.signal.throwIfAborted();
        const result = emptyServiceResult(workspaceId, { manifest: transactionSummary(manifest) });
        result.code = 'TRANSACTION_STATUS';
        result.transactionId = manifest.transactionId;
        result.planHash = manifest.planHash;
        result.proposedFiles = manifest.files.slice(0, 100).map(({ relativePath }) => relativePath);
        result.changedFiles = manifest.appliedFiles.slice(0, 100);
        result.artifacts = [transactionResourceLink(manifest)];
        result.validation = manifest.validation;
        result.rollbackStatus = manifest.rollbackStatus;
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.transaction_diff',
    {
      title: 'Review transaction diff',
      description:
        'Page through the complete affected-file set, operation summaries, and source/binary artifact links before apply.',
      inputSchema: workspaceInput
        .extend({
          transactionId: transactionIdSchema,
          limit: z.number().int().min(1).max(20).default(20),
          cursor: z.string().min(1).max(4096).optional(),
        })
        .strict(),
      outputSchema: transactionDiffOutputSchema,
      annotations: readOnly,
    },
    async ({ workspaceId, transactionId, limit, cursor }, extra) => {
      try {
        const progress = progressReporter(extra);
        progress.signal.throwIfAborted();
        const manifest = await engine.transactions.status(
          workspaceId,
          transactionId,
          context.principal,
          progress.signal,
        );
        progress.signal.throwIfAborted();
        let fileOffset = 0;
        let operationOffset = 0;
        let artifactOffset = 0;
        if (cursor !== undefined) {
          const decoded = decodeTransactionDiffCursor(cursor);
          if (
            decoded.planHash !== manifest.planHash ||
            decoded.fileOffset > manifest.files.length ||
            decoded.operationOffset > manifest.operations.length ||
            decoded.artifactOffset > manifest.artifacts.length
          ) {
            throw new ServiceError(
              'TRANSACTION_CURSOR_STALE',
              'Transaction plan changed or the diff cursor is stale',
            );
          }
          fileOffset = decoded.fileOffset;
          operationOffset = decoded.operationOffset;
          artifactOffset = decoded.artifactOffset;
        }
        const manifestFiles = manifest.files.slice(fileOffset, fileOffset + limit);
        const files = manifestFiles.map(
          ({
            relativePath,
            operationIds,
            beforeSha256,
            afterSha256,
            beforeSize,
            afterSize,
            mediaType,
            diffArtifact,
          }) => ({
            relativePath,
            operationIdCount: operationIds.length,
            operationIds: operationIds.slice(0, 20),
            beforeSha256,
            afterSha256,
            beforeSize,
            afterSize,
            mediaType,
            ...(diffArtifact === undefined ? {} : { diffArtifact }),
          }),
        );
        const operations = manifest.operations.slice(operationOffset, operationOffset + limit);
        const artifacts = manifest.artifacts.slice(artifactOffset, artifactOffset + limit);
        const nextFileOffset = fileOffset + manifestFiles.length;
        const nextOperationOffset = operationOffset + operations.length;
        const nextArtifactOffset = artifactOffset + artifacts.length;
        const nextCursor =
          nextFileOffset < manifest.files.length ||
          nextOperationOffset < manifest.operations.length ||
          nextArtifactOffset < manifest.artifacts.length
            ? encodeTransactionDiffCursor(
                manifest.planHash,
                nextFileOffset,
                nextOperationOffset,
                nextArtifactOffset,
              )
            : undefined;
        const result = emptyServiceResult(workspaceId, {
          files,
          operations: operations.map(({ id, kind, summary }) => ({ id, kind, summary })),
          fileCount: manifest.files.length,
          operationCount: manifest.operations.length,
          artifactCount: manifest.artifacts.length,
          returnedFiles: files.length,
          returnedOperations: operations.length,
          returnedArtifacts: artifacts.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          expiresAt: manifest.expiresAt,
        });
        result.code = 'TRANSACTION_DIFF';
        result.transactionId = manifest.transactionId;
        result.planHash = manifest.planHash;
        result.proposedFiles = files.map(({ relativePath }) => relativePath);
        result.artifacts = [transactionResourceLink(manifest), ...artifacts];
        result.validation = manifest.validation;
        result.rollbackStatus = manifest.rollbackStatus;
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.transaction_apply',
    {
      title: 'Apply reviewed transaction',
      description:
        'Apply a completed dry run only when transaction ID, workspace, principal, source hashes, and expected plan hash still match.',
      inputSchema: transactionInput,
      outputSchema: transactionMutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, transactionId, expectedPlanHash }, extra) => {
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Checking transaction preconditions');
        const manifest = await engine.transactions.apply(
          workspaceId,
          transactionId,
          expectedPlanHash,
          {
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            signal: progress.signal,
            postValidate: (transaction, signal) =>
              postValidateTransaction(engine, transaction, context.principal, signal),
          },
        );
        engine.invalidate(workspaceId);
        await engine.scan(workspaceId, {}, context.principal, progress.signal);
        await progress.report(3, 3, 'Apply and index rebuild complete');
        const result = emptyServiceResult(workspaceId, {
          state: manifest.state,
          fileCount: manifest.files.length,
          appliedFileCount: manifest.appliedFiles.length,
          artifactCount: manifest.artifacts.length,
        });
        result.code = 'TRANSACTION_APPLIED';
        result.transactionId = manifest.transactionId;
        result.planHash = manifest.planHash;
        result.proposedFiles = manifest.files.slice(0, 100).map(({ relativePath }) => relativePath);
        result.changedFiles = manifest.appliedFiles.slice(0, 100);
        result.artifacts = [transactionResourceLink(manifest)];
        result.validation = manifest.validation;
        result.rollbackStatus = manifest.rollbackStatus;
        return toolResult(result);
      } catch (error) {
        engine.invalidate(workspaceId);
        try {
          const failed = await engine.transactions.status(
            workspaceId,
            transactionId,
            context.principal,
          );
          return errorResult(error, workspaceId, {
            transactionId: failed.transactionId,
            planHash: failed.planHash,
            proposedFiles: failed.files.slice(0, 100).map(({ relativePath }) => relativePath),
            changedFiles: failed.state === 'applied' ? failed.appliedFiles.slice(0, 100) : [],
            artifacts: [transactionResourceLink(failed)],
            validation: failed.validation,
            rollbackStatus: failed.rollbackStatus,
            data: { state: failed.state, failure: failed.failure ?? null },
          });
        } catch {
          // A forged or cross-workspace transaction ID intentionally reveals no manifest details.
        }
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.transaction_rollback',
    {
      title: 'Roll back applied transaction',
      description:
        'Restore exact original bytes when the applied result still matches rollback preconditions.',
      inputSchema: transactionInput,
      outputSchema: transactionMutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, transactionId, expectedPlanHash }, extra) => {
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 2, 'Checking rollback preconditions');
        progress.signal.throwIfAborted();
        const manifest = await engine.transactions.rollback(
          workspaceId,
          transactionId,
          expectedPlanHash,
          context.principal,
          progress.signal,
        );
        engine.invalidate(workspaceId);
        const result = emptyServiceResult(workspaceId, {
          state: manifest.state,
          fileCount: manifest.files.length,
          appliedFileCount: manifest.appliedFiles.length,
          artifactCount: manifest.artifacts.length,
        });
        result.code = 'TRANSACTION_ROLLED_BACK';
        result.transactionId = manifest.transactionId;
        result.planHash = manifest.planHash;
        result.changedFiles = manifest.files.slice(0, 100).map(({ relativePath }) => relativePath);
        result.artifacts = [transactionResourceLink(manifest)];
        result.validation = manifest.validation;
        result.rollbackStatus = manifest.rollbackStatus;
        await progress.report(2, 2, 'Atomic rollback complete');
        return toolResult(result);
      } catch (error) {
        try {
          const failed = await engine.transactions.status(
            workspaceId,
            transactionId,
            context.principal,
          );
          return errorResult(error, workspaceId, {
            transactionId: failed.transactionId,
            planHash: failed.planHash,
            proposedFiles: failed.files.slice(0, 100).map(({ relativePath }) => relativePath),
            changedFiles: failed.state === 'applied' ? failed.appliedFiles.slice(0, 100) : [],
            artifacts: [transactionResourceLink(failed)],
            validation: failed.validation,
            rollbackStatus: failed.rollbackStatus,
            data: { state: failed.state, failure: failed.failure ?? null },
          });
        } catch {
          // Invalid or inaccessible transaction IDs intentionally reveal no manifest details.
        }
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.artifact_list',
    {
      title: 'List workspace artifacts',
      description: 'List content-addressed artifacts without exposing filesystem paths.',
      inputSchema: workspaceInput
        .extend({
          limit: z.number().int().min(1).max(100).default(100),
          cursor: z.string().min(1).max(4096).optional(),
        })
        .strict(),
      outputSchema: artifactListOutputSchema,
      annotations: readOnly,
    },
    async ({ workspaceId, limit, cursor }, extra) => {
      try {
        const progress = progressReporter(extra);
        progress.signal.throwIfAborted();
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const decoded = cursor === undefined ? undefined : decodeArtifactCursor(cursor);
        const listing = await engine.artifacts.listPage(
          workspace,
          {
            limit,
            ...(decoded === undefined ? {} : { afterUri: decoded.after }),
          },
          progress.signal,
        );
        progress.signal.throwIfAborted();
        if (
          decoded !== undefined &&
          (decoded.revision !== listing.revision || !listing.afterFound)
        ) {
          throw new ServiceError(
            'ARTIFACT_CURSOR_STALE',
            'Artifact inventory changed; restart pagination without a cursor',
          );
        }
        const last = listing.artifacts.at(-1);
        const nextCursor =
          listing.hasMore && last !== undefined
            ? encodeArtifactCursor(listing.revision, last.uri)
            : undefined;
        const result = emptyServiceResult(workspaceId, {
          count: listing.total,
          returned: listing.artifacts.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        });
        result.code = 'ARTIFACT_LIST';
        result.artifacts = listing.artifacts;
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.artifact_describe',
    {
      title: 'Describe workspace artifact',
      description: 'Return artifact integrity and provenance metadata for an authorized workspace.',
      inputSchema: workspaceInput.extend({ uri: z.url().max(4096) }).strict(),
      outputSchema: artifactDescribeOutputSchema,
      annotations: readOnly,
    },
    async ({ workspaceId, uri }, extra) => {
      try {
        const progress = progressReporter(extra);
        progress.signal.throwIfAborted();
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const artifact = await engine.artifacts.describe(workspace, uri, progress.signal);
        progress.signal.throwIfAborted();
        const sourceHashes = Object.entries(artifact.provenance.sourceHashes).sort(
          ([left], [right]) => compareCodeUnits(left, right),
        );
        const description = {
          uri: artifact.uri,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
          sha256: artifact.sha256,
          provenanceHash: artifact.provenanceHash,
          ...(artifact.description === undefined
            ? {}
            : { description: artifact.description.slice(0, 1_024) }),
          descriptionTruncated: (artifact.description?.length ?? 0) > 1_024,
          provenance: {
            kind: artifact.provenance.kind,
            toolVersion: artifact.provenance.toolVersion,
            schemaVersion: artifact.provenance.schemaVersion,
            sourceHashCount: sourceHashes.length,
            sourceHashes: sourceHashes.slice(0, 100).map(([path, sha256]) => ({ path, sha256 })),
            sourceHashesTruncated: sourceHashes.length > 100,
            hasRenderProfile: artifact.provenance.renderProfile !== undefined,
            hasMetadata: artifact.provenance.metadata !== undefined,
          },
        };
        const manifestUri = new URL(artifact.uri);
        manifestUri.searchParams.set('metadata', 'manifest');
        const result = emptyServiceResult(workspaceId, { artifact: description });
        result.code = 'ARTIFACT_DESCRIBE';
        result.artifacts = [
          publicArtifactLink(artifact),
          {
            uri: manifestUri.href,
            name: `${artifact.name}.manifest.json`,
            mimeType: 'application/json',
            description: 'Complete public provenance manifest for this artifact',
          },
        ];
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}

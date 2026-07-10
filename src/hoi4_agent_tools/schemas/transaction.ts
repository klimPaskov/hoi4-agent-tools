import { z } from 'zod/v4';
import {
  TRANSACTION_MAX_APPLIED_FILES,
  TRANSACTION_MAX_ARTIFACTS,
  TRANSACTION_MAX_DIAGNOSTICS,
  TRANSACTION_MAX_FILES,
  TRANSACTION_MAX_OPERATIONS,
  TRANSACTION_MAX_READ_DEPENDENCIES,
  TRANSACTION_MAX_VALIDATION_CHECKS,
} from '../core/transaction-limits.js';
import { TRANSACTION_VERSION } from '../version.js';
import { diagnosticSchema, workspaceIdSchema, workspaceRelativePathSchema } from './common.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(1).max(256);
const summarySchema = z.string().max(4096);
const mediaTypeSchema = z.string().min(1).max(255);

export const artifactLinkSchema = z
  .object({
    uri: z.url().max(4096),
    name: z.string().min(1).max(255),
    mimeType: mediaTypeSchema,
    size: z.number().int().min(0).optional(),
    sha256: sha256Schema.optional(),
    description: z.string().max(4096).optional(),
  })
  .strict();

export const validationSummarySchema = z
  .object({
    passed: z.boolean(),
    checks: z
      .array(
        z.object({ id: identifierSchema, passed: z.boolean(), message: summarySchema }).strict(),
      )
      .max(TRANSACTION_MAX_VALIDATION_CHECKS),
  })
  .strict();

const transactionOperationSchema = z
  .object({
    id: identifierSchema,
    kind: identifierSchema,
    summary: summarySchema,
    data: z.record(z.string().max(256), z.unknown()),
  })
  .strict();

const transactionReadDependencySchema = z
  .object({
    rootKind: z.enum(['mod', 'game', 'dependency', 'artifact', 'cache', 'fixture']),
    loadOrder: z.number().int().min(0),
    relativePath: workspaceRelativePathSchema,
    sha256: sha256Schema,
  })
  .strict();

const transactionFileSchema = z
  .object({
    relativePath: workspaceRelativePathSchema,
    operationIds: z.array(identifierSchema).max(TRANSACTION_MAX_OPERATIONS),
    beforeSha256: sha256Schema.nullable(),
    afterSha256: sha256Schema.nullable(),
    beforeSize: z.number().int().min(0).nullable(),
    afterSize: z.number().int().min(0).nullable(),
    beforeBlob: workspaceRelativePathSchema.nullable(),
    afterBlob: workspaceRelativePathSchema.nullable(),
    mediaType: mediaTypeSchema,
  })
  .strict();

const transactionPlanPayloadSchema = z
  .object({
    version: z.literal(TRANSACTION_VERSION),
    workspaceId: workspaceIdSchema,
    principal: z.string().max(1024).nullable(),
    rootFingerprint: sha256Schema,
    operationKind: identifierSchema,
    operations: z.array(transactionOperationSchema).max(TRANSACTION_MAX_OPERATIONS),
    readDependencies: z
      .array(transactionReadDependencySchema)
      .max(TRANSACTION_MAX_READ_DEPENDENCIES),
    files: z.array(transactionFileSchema).max(TRANSACTION_MAX_FILES),
    diagnostics: z.array(diagnosticSchema).max(TRANSACTION_MAX_DIAGNOSTICS),
    validation: validationSummarySchema,
    artifacts: z.array(artifactLinkSchema).max(TRANSACTION_MAX_ARTIFACTS),
  })
  .strict();

export const transactionManifestSchema = z
  .object({
    version: z.literal(TRANSACTION_VERSION),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    transactionId: z.string().regex(/^txn_[0-9a-f-]{36}$/u),
    workspaceId: workspaceIdSchema,
    principal: z.string().max(1024).optional(),
    rootFingerprint: sha256Schema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    state: z.enum(['planned', 'applying', 'applied', 'rolling_back', 'rolled_back', 'failed']),
    planPayload: transactionPlanPayloadSchema,
    planHash: sha256Schema,
    integrityHash: sha256Schema,
    authenticationTag: sha256Schema,
    operationKind: identifierSchema,
    operations: z.array(transactionOperationSchema).max(TRANSACTION_MAX_OPERATIONS),
    readDependencies: z
      .array(transactionReadDependencySchema)
      .max(TRANSACTION_MAX_READ_DEPENDENCIES),
    files: z
      .array(transactionFileSchema.extend({ diffArtifact: artifactLinkSchema.optional() }).strict())
      .max(TRANSACTION_MAX_FILES),
    diagnostics: z.array(diagnosticSchema).max(TRANSACTION_MAX_DIAGNOSTICS),
    validation: validationSummarySchema,
    artifacts: z.array(artifactLinkSchema).max(TRANSACTION_MAX_ARTIFACTS),
    appliedFiles: z.array(workspaceRelativePathSchema).max(TRANSACTION_MAX_APPLIED_FILES),
    rollbackStatus: z.enum(['available', 'applied', 'failed']),
    failure: z.object({ code: identifierSchema, message: summarySchema }).strict().optional(),
  })
  .strict();

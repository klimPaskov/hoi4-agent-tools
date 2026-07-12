import { z } from 'zod/v4';
import { canonicalJson } from '../../core/canonical.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import type { ServiceResult } from '../../core/result.js';
import { ServiceError } from '../../core/result.js';
import { diagnosticSchema } from '../../schemas/common.js';
import { artifactLinkSchema, validationSummarySchema } from '../../schemas/transaction.js';

export const MAX_INLINE_FILES_SCANNED = 1_000;
export const MAX_INLINE_PROPOSED_FILES = 1_000;
export const MAX_INLINE_CHANGED_FILES = 1_000;
export const MAX_INLINE_DIAGNOSTICS = 100;
export const MAX_INLINE_ARTIFACT_LINKS = 512;
export const MAX_INLINE_BLOCKERS = 100;
export const MAX_INLINE_VALIDATION_CHECKS = 5;
// Leave headroom for the enclosing JSON-RPC response and transport metadata.
export const MAX_TOOL_RESULT_BYTES = 500_000;
const deferredFilesDiagnostic = Symbol('deferredFilesDiagnostic');

const operationResultBaseSchema = z
  .object({
    status: z.enum(['ok', 'blocked', 'error']),
    code: z.string().max(256),
    workspaceId: z.string().max(64),
    filesScanned: z.array(z.string().max(4096)).max(MAX_INLINE_FILES_SCANNED),
    proposedFiles: z.array(z.string().max(1024)).max(MAX_INLINE_PROPOSED_FILES),
    changedFiles: z.array(z.string().max(1024)).max(MAX_INLINE_CHANGED_FILES),
    diagnostics: z.array(diagnosticSchema).max(MAX_INLINE_DIAGNOSTICS),
    transactionId: z.string().max(128).optional(),
    planHash: z.string().max(128).optional(),
    artifacts: z.array(artifactLinkSchema).max(MAX_INLINE_ARTIFACT_LINKS),
    validation: validationSummarySchema,
    blockers: z
      .array(
        z
          .object({
            code: z.string().max(256),
            message: z.string().max(4096),
            details: z.record(z.string().max(256), z.unknown()).optional(),
          })
          .strict(),
      )
      .max(MAX_INLINE_BLOCKERS),
    rollbackStatus: z.enum(['not-required', 'available', 'applied', 'failed']).optional(),
  })
  .strict();

export const operationResultSchema = operationResultBaseSchema
  .extend({ data: z.record(z.string().max(256), z.unknown()) })
  .strict();

const emptyToolDataSchema = z.object({}).strict();

/**
 * Advertise an exact success payload for one tool while retaining the shared empty error payload.
 * The generic operation-result schema remains available for stored envelopes, but is never used as
 * a public tool output contract.
 */
export function strictOperationResultSchema<T extends z.ZodType>(successDataSchema: T) {
  return operationResultBaseSchema
    .extend({ data: z.union([emptyToolDataSchema, successDataSchema]) })
    .strict();
}

/** Keep source inventories compact; complete inventories belong in linked resources. */
export function setInlineFilesScanned(
  result: ServiceResult<unknown>,
  files: readonly string[],
): void {
  result.filesScanned = files.slice(0, MAX_INLINE_FILES_SCANNED);
  if (files.length <= MAX_INLINE_FILES_SCANNED) return;
  const truncation: Diagnostic = {
    code: 'MCP_INLINE_FILES_TRUNCATED',
    severity: 'info',
    category: 'configuration',
    message: `Inline source inventory is limited to ${MAX_INLINE_FILES_SCANNED} paths; use the linked resource for the complete inventory`,
    details: {
      total: files.length,
      returned: MAX_INLINE_FILES_SCANNED,
    },
  };
  Object.defineProperty(result, deferredFilesDiagnostic, {
    value: truncation,
    enumerable: false,
    configurable: true,
  });
  result.diagnostics = [truncation, ...result.diagnostics].slice(0, MAX_INLINE_DIAGNOSTICS);
}

function preserveDeferredFilesDiagnostic(result: ServiceResult<unknown>): ServiceResult<unknown> {
  const deferred = (result as ServiceResult<unknown> & { [deferredFilesDiagnostic]?: Diagnostic })[
    deferredFilesDiagnostic
  ];
  if (deferred === undefined || result.diagnostics.some(({ code }) => code === deferred.code)) {
    return result;
  }
  return {
    ...result,
    diagnostics: [deferred, ...result.diagnostics].slice(0, MAX_INLINE_DIAGNOSTICS),
  };
}

function boundedResult(
  result: ServiceResult<unknown>,
  actualBytes: number,
): ServiceResult<unknown> {
  const transactionArtifact =
    result.transactionId === undefined
      ? undefined
      : {
          uri: `hoi4-agent://workspace/${encodeURIComponent(result.workspaceId)}/transaction/${encodeURIComponent(result.transactionId)}`,
          name: `${result.transactionId}.manifest.json`,
          mimeType: 'application/json',
          description: 'Complete authenticated transaction manifest and rollback status',
        };
  const truncationDiagnostic: Diagnostic = {
    code: 'MCP_RESPONSE_TRUNCATED',
    severity: 'warning',
    category: 'configuration',
    message:
      'Tool output exceeded the wire budget; complete details remain available through linked resources',
    details: { actualBytes, maxBytes: MAX_TOOL_RESULT_BYTES },
  };
  return {
    status: result.status,
    code: result.code.slice(0, 256),
    workspaceId: result.workspaceId.slice(0, 64),
    filesScanned: [],
    proposedFiles: [],
    changedFiles: [],
    diagnostics: [truncationDiagnostic],
    ...(result.transactionId === undefined
      ? {}
      : { transactionId: result.transactionId.slice(0, 128) }),
    ...(result.planHash === undefined ? {} : { planHash: result.planHash.slice(0, 128) }),
    artifacts:
      transactionArtifact === undefined
        ? result.artifacts.slice(0, 1).map(({ description: _description, ...artifact }) => artifact)
        : [transactionArtifact],
    validation: { passed: result.validation.passed, checks: [] },
    blockers:
      result.status === 'ok'
        ? []
        : [
            {
              code: 'MCP_RESPONSE_TRUNCATED',
              message:
                'Tool output exceeded the wire budget; inspect the linked resource for complete details',
              details: {
                actualBytes,
                maxBytes: MAX_TOOL_RESULT_BYTES,
                artifactLinksTotal: result.artifacts.length,
              },
            },
          ],
    rollbackStatus: result.rollbackStatus ?? 'not-required',
    data: {},
  };
}

interface ToolResultOutput {
  [key: string]: unknown;
  content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'resource_link';
        uri: string;
        name: string;
        mimeType: string;
        description?: string;
        size?: number;
      }
  >;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function jsonStringBytes(value: string): number {
  let bytes = 2 + Buffer.byteLength(value, 'utf8');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 1;
    else if (code <= 0x1f) bytes += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else bytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 3;
  }
  return bytes;
}

function jsonBytesWithin(value: unknown, budget: number): boolean {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const maximumDepth = 128;
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= budget;
  };
  const visit = (candidate: unknown, depth = 0): boolean => {
    if (depth > maximumDepth) return false;
    if (candidate === null) return add(4);
    if (typeof candidate === 'string') return add(jsonStringBytes(candidate));
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return false;
      return add(String(Object.is(candidate, -0) ? 0 : candidate).length);
    }
    if (typeof candidate === 'boolean') return add(candidate ? 4 : 5);
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      try {
        if (!add(2 + Math.max(0, candidate.length - 1))) return false;
        return candidate.every((entry) => visit(entry, depth + 1));
      } finally {
        seen.delete(candidate);
      }
    }
    if (typeof candidate === 'object') {
      const object = candidate as Record<string, unknown>;
      if (seen.has(object)) return false;
      seen.add(object);
      try {
        const entries = Object.entries(object).filter(([, entry]) => entry !== undefined);
        if (!add(2 + Math.max(0, entries.length - 1))) return false;
        for (const [key, entry] of entries) {
          if (!add(jsonStringBytes(key) + 1) || !visit(entry, depth + 1)) return false;
        }
        return true;
      } finally {
        seen.delete(object);
      }
    }
    return false;
  };
  return visit(value);
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return jsonBytesWithin(details, 4_096) ? details : { truncated: true };
}

function compactDescriptions(result: ServiceResult<unknown>): ServiceResult<unknown> {
  const compactLocation = (location: Diagnostic['location']) =>
    location === undefined
      ? undefined
      : {
          ...location,
          path: location.path.slice(0, 4_096),
          ...(location.symbol === undefined ? {} : { symbol: location.symbol.slice(0, 1_024) }),
        };
  const validationTruncation: Diagnostic | undefined =
    result.validation.checks.length > MAX_INLINE_VALIDATION_CHECKS
      ? {
          code: 'MCP_INLINE_VALIDATION_TRUNCATED',
          severity: 'info',
          category: 'configuration',
          message: `Inline validation is limited to ${MAX_INLINE_VALIDATION_CHECKS} checks; use the linked artifact or transaction manifest for the complete validation record`,
          details: {
            total: result.validation.checks.length,
            returned: MAX_INLINE_VALIDATION_CHECKS,
          },
        }
      : undefined;
  const compactDiagnostics = result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    code: diagnostic.code.slice(0, 256),
    message: diagnostic.message.slice(0, 4_096),
    ...(diagnostic.operationId === undefined
      ? {}
      : { operationId: diagnostic.operationId.slice(0, 256) }),
    ...(diagnostic.location === undefined
      ? {}
      : { location: compactLocation(diagnostic.location)! }),
    ...(diagnostic.related === undefined
      ? {}
      : {
          related: diagnostic.related.slice(0, 5).map((location) => compactLocation(location)!),
        }),
    ...(diagnostic.details === undefined ? {} : { details: compactDetails(diagnostic.details) }),
  }));
  return {
    ...result,
    diagnostics:
      validationTruncation === undefined
        ? compactDiagnostics
        : [validationTruncation, ...compactDiagnostics].slice(0, MAX_INLINE_DIAGNOSTICS),
    validation: {
      ...result.validation,
      checks: result.validation.checks.slice(0, MAX_INLINE_VALIDATION_CHECKS).map((check) => ({
        ...check,
        id: check.id.slice(0, 256),
        message: check.message.slice(0, 4_096),
      })),
    },
    blockers: result.blockers.map((blocker) => ({
      ...blocker,
      code: blocker.code.slice(0, 256),
      message: blocker.message.slice(0, 4_096),
      ...(blocker.details === undefined ? {} : { details: compactDetails(blocker.details) }),
    })),
    artifacts: result.artifacts.map((artifact) => ({
      ...artifact,
      ...(artifact.description === undefined
        ? {}
        : { description: artifact.description.slice(0, 1_024) }),
    })),
  };
}

function buildToolResult(selected: ServiceResult<unknown>): ToolResultOutput {
  const structuredContent = operationResultSchema.parse(selected) as Record<string, unknown>;
  const links = selected.artifacts.map((artifact) => ({
    type: 'resource_link' as const,
    uri: artifact.uri,
    name: artifact.name,
    mimeType: artifact.mimeType,
    ...(artifact.description === undefined ? {} : { description: artifact.description }),
    ...(artifact.size === undefined ? {} : { size: artifact.size }),
  }));
  const summary = canonicalJson({
    status: selected.status,
    code: selected.code,
    workspaceId: selected.workspaceId,
    ...(selected.transactionId === undefined ? {} : { transactionId: selected.transactionId }),
    ...(selected.planHash === undefined ? {} : { planHash: selected.planHash }),
    artifactCount: selected.artifacts.length,
  });
  return {
    content: [{ type: 'text', text: summary }, ...links],
    structuredContent,
    ...(selected.status === 'error' ? { isError: true } : {}),
  };
}

export function toolResult(result: ServiceResult<unknown>): ToolResultOutput {
  const completeResult = preserveDeferredFilesDiagnostic(result);
  const exceedsArrayBudget =
    completeResult.filesScanned.length > MAX_INLINE_FILES_SCANNED ||
    completeResult.proposedFiles.length > MAX_INLINE_PROPOSED_FILES ||
    completeResult.changedFiles.length > MAX_INLINE_CHANGED_FILES ||
    completeResult.diagnostics.length > MAX_INLINE_DIAGNOSTICS ||
    completeResult.artifacts.length > MAX_INLINE_ARTIFACT_LINKS ||
    completeResult.blockers.length > MAX_INLINE_BLOCKERS;
  const compact = compactDescriptions(completeResult);
  const estimatedBytes = jsonBytesWithin(compact, MAX_TOOL_RESULT_BYTES)
    ? Buffer.byteLength(canonicalJson(compact), 'utf8')
    : MAX_TOOL_RESULT_BYTES + 1;
  const selected =
    estimatedBytes > MAX_TOOL_RESULT_BYTES || exceedsArrayBudget
      ? boundedResult(completeResult, estimatedBytes)
      : compact;
  let output = buildToolResult(selected);
  const wireBytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  if (wireBytes > MAX_TOOL_RESULT_BYTES) {
    output = buildToolResult(boundedResult(completeResult, wireBytes));
  }
  const finalBytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  if (finalBytes > MAX_TOOL_RESULT_BYTES) {
    throw new Error('Constant MCP response-limit result exceeded its wire budget');
  }
  return output;
}

export function errorResult(
  error: unknown,
  workspaceId = '',
  context: {
    transactionId?: string;
    planHash?: string;
    proposedFiles?: string[];
    changedFiles?: string[];
    artifacts?: ServiceResult['artifacts'];
    validation?: ServiceResult['validation'];
    rollbackStatus?: ServiceResult['rollbackStatus'];
    data?: unknown;
  } = {},
): ReturnType<typeof toolResult> {
  const serviceError =
    error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL_ERROR', 'Unexpected internal error');
  const publicDetails = Object.fromEntries(
    Object.entries(serviceError.details).filter(
      ([key]) => !['cause', 'stack', 'absolutePath'].includes(key),
    ),
  );
  return toolResult({
    status: serviceError.code.includes('BLOCKED') ? 'blocked' : 'error',
    code: serviceError.code,
    workspaceId,
    filesScanned: [],
    proposedFiles: context.proposedFiles ?? [],
    changedFiles: context.changedFiles ?? [],
    diagnostics: [],
    ...(context.transactionId === undefined ? {} : { transactionId: context.transactionId }),
    ...(context.planHash === undefined ? {} : { planHash: context.planHash }),
    artifacts: context.artifacts ?? [],
    validation: context.validation ?? { passed: false, checks: [] },
    blockers: [{ code: serviceError.code, message: serviceError.message, details: publicDetails }],
    ...(context.rollbackStatus === undefined ? {} : { rollbackStatus: context.rollbackStatus }),
    data: context.data ?? {},
  });
}

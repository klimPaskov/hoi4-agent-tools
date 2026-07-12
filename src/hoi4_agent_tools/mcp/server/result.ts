import { z } from 'zod/v4';
import { canonicalJson } from '../../core/canonical.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import type { ServiceResult } from '../../core/result.js';
import { ServiceError } from '../../core/result.js';
import { diagnosticSchema } from '../../schemas/common.js';
import { artifactLinkSchema, validationSummarySchema } from '../../schemas/transaction.js';

export const MAX_INLINE_FILES_SCANNED = 64;
export const MAX_INLINE_PROPOSED_FILES = 64;
export const MAX_INLINE_CHANGED_FILES = 64;
export const MAX_INLINE_DIAGNOSTICS = 20;
export const MAX_INLINE_ARTIFACT_LINKS = 32;
export const MAX_INLINE_BLOCKERS = 20;
export const MAX_INLINE_VALIDATION_CHECKS = 5;
// Leave headroom for the enclosing JSON-RPC response and transport metadata.
export const MAX_TOOL_RESULT_BYTES = 32_768;
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
  })
  .strict();

export const operationResultSchema = operationResultBaseSchema
  .extend({ data: z.record(z.string().max(256), z.unknown()) })
  .strict();

const emptyToolDataSchema = z.object({}).strict();
const compactPublicOperationResultSchema = z
  .object({
    status: z.enum(['ok', 'blocked', 'error']),
    code: z.string().max(256),
    workspaceId: z.string().max(64),
    filesScanned: z.array(z.string().max(4096)).max(MAX_INLINE_FILES_SCANNED),
    proposedFiles: z.array(z.string().max(1024)).max(MAX_INLINE_PROPOSED_FILES),
    changedFiles: z.array(z.string().max(1024)).max(MAX_INLINE_CHANGED_FILES),
    diagnostics: z.array(z.unknown()).max(MAX_INLINE_DIAGNOSTICS),
    artifacts: z.array(z.unknown()).max(MAX_INLINE_ARTIFACT_LINKS),
    validation: z
      .object({
        passed: z.boolean(),
        checks: z.array(z.unknown()).max(MAX_INLINE_VALIDATION_CHECKS),
      })
      .strict(),
    blockers: z.array(z.unknown()).max(MAX_INLINE_BLOCKERS),
    data: z.record(z.string().max(256), z.unknown()),
  })
  .strict()
  .describe('Stable operation envelope; data is tool-specific and artifacts link bulk evidence.');

/**
 * Advertise one compact operation envelope while retaining exact per-tool runtime validation.
 * The generic operation-result schema remains available for stored envelopes.
 */
export function strictOperationResultSchema(successDataSchema: z.ZodType) {
  const exactSchema = operationResultBaseSchema
    .extend({ data: z.union([emptyToolDataSchema, successDataSchema]) })
    .strict();
  return compactPublicOperationResultSchema.superRefine((value, context) => {
    const parsed = exactSchema.safeParse(value);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });
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
  const hasLinkedEvidence = result.artifacts.length > 0;
  const truncationDiagnostic: Diagnostic = {
    code: 'MCP_RESPONSE_TRUNCATED',
    severity: 'warning',
    category: 'configuration',
    message: hasLinkedEvidence
      ? 'Tool output exceeded the wire budget; inspect the linked evidence for complete details'
      : 'Tool output exceeded the wire budget; nonessential inline details were omitted',
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
    artifacts: result.artifacts
      .slice(0, 1)
      .map(({ description: _description, ...artifact }) => artifact),
    validation: { passed: result.validation.passed, checks: [] },
    blockers:
      result.status === 'ok'
        ? []
        : [
            {
              code: 'MCP_RESPONSE_TRUNCATED',
              message: hasLinkedEvidence
                ? 'Tool output exceeded the wire budget; inspect the linked evidence for complete details'
                : 'Tool output exceeded the wire budget; nonessential inline details were omitted',
              details: {
                actualBytes,
                maxBytes: MAX_TOOL_RESULT_BYTES,
                artifactLinksTotal: result.artifacts.length,
              },
            },
          ],
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
  return jsonBytesWithin(details, 2_048) ? details : { truncated: true };
}

function compactDescriptions(result: ServiceResult<unknown>): ServiceResult<unknown> {
  const compactLocation = (location: Diagnostic['location']) =>
    location === undefined
      ? undefined
      : {
          ...location,
          path: location.path.slice(0, 1_024),
          ...(location.symbol === undefined ? {} : { symbol: location.symbol.slice(0, 256) }),
        };
  const collectionTotals = {
    filesScanned: result.filesScanned.length,
    proposedFiles: result.proposedFiles.length,
    changedFiles: result.changedFiles.length,
    diagnostics: result.diagnostics.length,
    artifacts: result.artifacts.length,
    validationChecks: result.validation.checks.length,
    blockers: result.blockers.length,
  };
  const collectionLimits = {
    filesScanned: MAX_INLINE_FILES_SCANNED,
    proposedFiles: MAX_INLINE_PROPOSED_FILES,
    changedFiles: MAX_INLINE_CHANGED_FILES,
    diagnostics: MAX_INLINE_DIAGNOSTICS,
    artifacts: MAX_INLINE_ARTIFACT_LINKS,
    validationChecks: MAX_INLINE_VALIDATION_CHECKS,
    blockers: MAX_INLINE_BLOCKERS,
  };
  const truncatedCollections: Record<string, { total: number; limit: number }> = Object.fromEntries(
    Object.entries(collectionTotals).flatMap(([name, total]) => {
      const limit = collectionLimits[name as keyof typeof collectionLimits];
      return total > limit ? [[name, { total, limit }]] : [];
    }),
  );
  if (
    Object.keys(truncatedCollections).length > 0 &&
    result.diagnostics.length > MAX_INLINE_DIAGNOSTICS - 1
  ) {
    truncatedCollections.diagnostics = {
      total: result.diagnostics.length,
      limit: MAX_INLINE_DIAGNOSTICS - 1,
    };
  }
  const needsTruncationDiagnostic = Object.keys(truncatedCollections).length > 0;
  const diagnosticSlots = Math.max(0, MAX_INLINE_DIAGNOSTICS - (needsTruncationDiagnostic ? 1 : 0));
  const hardDiagnostics = result.diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  const priorityDiagnostics = result.diagnostics.filter(
    ({ code, severity }) =>
      severity === 'error' || severity === 'blocker' || code === 'MCP_INLINE_FILES_TRUNCATED',
  );
  const otherDiagnostics = result.diagnostics.filter(
    (diagnostic) => !priorityDiagnostics.includes(diagnostic),
  );
  const retainedPriorityDiagnostics = priorityDiagnostics.slice(0, diagnosticSlots);
  const retainedDiagnostics = [
    ...retainedPriorityDiagnostics,
    ...otherDiagnostics.slice(0, diagnosticSlots - retainedPriorityDiagnostics.length),
  ];
  const omittedHardDiagnostics = hardDiagnostics.filter(
    (diagnostic) => !retainedDiagnostics.includes(diagnostic),
  ).length;
  const compactDiagnostics = retainedDiagnostics.map((diagnostic) => ({
    ...diagnostic,
    code: diagnostic.code.slice(0, 256),
    message: diagnostic.message.slice(0, 1_024),
    ...(diagnostic.operationId === undefined
      ? {}
      : { operationId: diagnostic.operationId.slice(0, 256) }),
    ...(diagnostic.location === undefined
      ? {}
      : { location: compactLocation(diagnostic.location)! }),
    ...(diagnostic.related === undefined
      ? {}
      : {
          related: diagnostic.related.slice(0, 3).map((location) => compactLocation(location)!),
        }),
    ...(diagnostic.details === undefined ? {} : { details: compactDetails(diagnostic.details) }),
  }));
  const truncationDiagnostic: Diagnostic | undefined = needsTruncationDiagnostic
    ? {
        code: 'MCP_INLINE_COLLECTIONS_TRUNCATED',
        severity: omittedHardDiagnostics > 0 ? 'blocker' : 'info',
        category: 'configuration',
        message:
          result.artifacts.length > 0
            ? 'Large collections were bounded inline; linked resources retain bulk evidence'
            : 'Large collections were bounded inline',
        details: {
          collections: truncatedCollections,
          diagnosticsReturned: retainedDiagnostics.length,
          omittedHardDiagnostics,
        },
      }
    : undefined;
  return {
    ...result,
    filesScanned: result.filesScanned.slice(0, MAX_INLINE_FILES_SCANNED),
    proposedFiles: result.proposedFiles.slice(0, MAX_INLINE_PROPOSED_FILES),
    changedFiles: result.changedFiles.slice(0, MAX_INLINE_CHANGED_FILES),
    diagnostics:
      truncationDiagnostic === undefined
        ? compactDiagnostics
        : [truncationDiagnostic, ...compactDiagnostics],
    artifacts: result.artifacts.slice(0, MAX_INLINE_ARTIFACT_LINKS).map((artifact) => ({
      ...artifact,
      ...(artifact.description === undefined
        ? {}
        : { description: artifact.description.slice(0, 256) }),
    })),
    validation: {
      ...result.validation,
      checks: result.validation.checks.slice(0, MAX_INLINE_VALIDATION_CHECKS).map((check) => ({
        ...check,
        id: check.id.slice(0, 256),
        message: check.message.slice(0, 1_024),
      })),
    },
    blockers: result.blockers.slice(0, MAX_INLINE_BLOCKERS).map((blocker) => ({
      ...blocker,
      code: blocker.code.slice(0, 256),
      message: blocker.message.slice(0, 1_024),
      ...(blocker.details === undefined ? {} : { details: compactDetails(blocker.details) }),
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
  const compact = compactDescriptions(completeResult);
  const estimatedBytes = jsonBytesWithin(compact, MAX_TOOL_RESULT_BYTES)
    ? Buffer.byteLength(canonicalJson(compact), 'utf8')
    : MAX_TOOL_RESULT_BYTES + 1;
  const selected =
    estimatedBytes > MAX_TOOL_RESULT_BYTES ? boundedResult(compact, estimatedBytes) : compact;
  let output = buildToolResult(selected);
  const wireBytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  if (wireBytes > MAX_TOOL_RESULT_BYTES) {
    output = buildToolResult(boundedResult(compact, wireBytes));
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
    proposedFiles?: string[];
    changedFiles?: string[];
    artifacts?: ServiceResult['artifacts'];
    validation?: ServiceResult['validation'];
    data?: unknown;
  } = {},
): ReturnType<typeof toolResult> {
  const serviceError =
    error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL_ERROR', 'Unexpected internal error');
  const internalWriteError = serviceError.code.startsWith('TRANSACTION_');
  const publicCode = internalWriteError
    ? `REWRITE_${serviceError.code.slice('TRANSACTION_'.length)}`
    : serviceError.code;
  const publicMessage = internalWriteError
    ? 'Rewrite could not be completed'
    : serviceError.message;
  const publicDetails = internalWriteError
    ? {}
    : Object.fromEntries(
        Object.entries(serviceError.details).filter(
          ([key]) =>
            ![
              'cause',
              'stack',
              'absolutePath',
              'transactionId',
              'planHash',
              'rollbackStatus',
            ].includes(key),
        ),
      );
  return toolResult({
    status: publicCode.includes('BLOCKED') ? 'blocked' : 'error',
    code: publicCode,
    workspaceId,
    filesScanned: [],
    proposedFiles: context.proposedFiles ?? [],
    changedFiles: context.changedFiles ?? [],
    diagnostics: [],
    artifacts: context.artifacts ?? [],
    validation: context.validation ?? { passed: false, checks: [] },
    blockers: [{ code: publicCode, message: publicMessage, details: publicDetails }],
    data: context.data ?? {},
  });
}

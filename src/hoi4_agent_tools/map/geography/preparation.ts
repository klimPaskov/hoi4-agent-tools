import type { ReferenceSourceEvidence } from '../../core/bounded-source.js';
import { canonicalJson, canonicalJsonByteLength, sha256Bytes } from '../../core/canonical.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { ServiceError } from '../../core/result.js';
import { prepareSource, readBoundedFile, verifySource } from '../../core/scanner.js';
import type { WorkspaceResolver } from '../../core/workspace.js';
import {
  GEOGRAPHY_SOURCE_MAX_BYTES,
  geographyModelSchema,
  type GeographyModelInput,
} from '../../schemas/geography.js';
import type { GeographyFrame } from './model.js';
import { resolveGeography, type GeographyEdgePolicy, type GeographyResolution } from './resolve.js';

/** The part of a `create_world` operation geography preparation reads. */
export interface GeographyOperationInput {
  id: string;
  width?: number | undefined;
  height?: number | undefined;
  geography?: GeographyModelInput | undefined;
  geographyPath?: string | undefined;
  reference?: unknown;
  edge?: GeographyEdgePolicy | undefined;
}

export interface PreparedGeography extends GeographyResolution {
  operationId: string;
  source:
    | { kind: 'inline'; bytes: number; sha256: string }
    | { kind: 'file'; bytes: number; sha256: string; evidence: ReferenceSourceEvidence };
  frame: GeographyFrame;
  /** True when a reference image also supplies the coast. */
  hasReference: boolean;
}

/** Default world size, mirroring `create_world` for worlds without a reference image. */
export const GEOGRAPHY_DEFAULT_FRAME: GeographyFrame = { width: 1_024, height: 512 };
/** Default size of a world built from a reference image. */
export const GEOGRAPHY_REFERENCE_FRAME: GeographyFrame = { width: 5_632, height: 2_048 };

export function operationHasGeography(operation: {
  geography?: unknown;
  geographyPath?: unknown;
}): boolean {
  return operation.geography !== undefined || operation.geographyPath !== undefined;
}

function schemaFailure(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): ServiceError {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return new ServiceError(
    'MAP_GEOGRAPHY_SCHEMA_INVALID',
    `The geography model does not match schema version 1: ${issues
      .slice(0, 3)
      .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
      .join('; ')}${error.issues.length > 3 ? ` (and ${error.issues.length - 3} more)` : ''}`,
    { issueCount: error.issues.length, issues },
  );
}

/**
 * Read a geography model from the authorized mod workspace. The same canonical-path guard as
 * `reference.imagePath` applies: workspace-relative `.json` only, resolved against the principal's
 * grants, opened once, size-bounded, hashed from the very bytes that are parsed (no second read, so
 * no swap between hash and use), and re-verified against the opened identity afterwards. The
 * returned evidence is recorded as a transaction read dependency, so a changed file blocks the
 * write as stale.
 */
export async function readGeographyModelSource(
  resolver: WorkspaceResolver,
  workspaceId: string,
  requestedPath: string,
  principal?: string,
  signal?: AbortSignal,
): Promise<{ model: GeographyModelInput; evidence: ReferenceSourceEvidence; bytes: number }> {
  // Backslashes separate directories on every platform, so the same request resolves the same way everywhere.
  const relativePath = requestedPath.replaceAll('\\', '/');
  if (!/\.json$/iu.test(relativePath) || relativePath.includes(':'))
    throw new ServiceError(
      'MAP_GEOGRAPHY_PATH_INVALID',
      'Geography must name a workspace-relative .json file',
    );
  const resolved = await resolver.resolvePath(
    workspaceId,
    relativePath,
    'read',
    ['mod'],
    principal,
  );
  const source = await prepareSource(resolved.root, relativePath, signal);
  try {
    if (!source.metadata.isFile())
      throw new ServiceError('SOURCE_NOT_REGULAR_FILE', 'Geography source must be a regular file');
    if (source.metadata.size < 1 || source.metadata.size > GEOGRAPHY_SOURCE_MAX_BYTES)
      throw new ServiceError(
        'MAP_GEOGRAPHY_SOURCE_TOO_LARGE',
        `Geography source must hold between 1 byte and ${GEOGRAPHY_SOURCE_MAX_BYTES} bytes`,
        { limit: GEOGRAPHY_SOURCE_MAX_BYTES },
      );
    const bytes = await readBoundedFile(source.handle, GEOGRAPHY_SOURCE_MAX_BYTES, signal);
    await verifySource(resolved.root, source);
    const sha256 = sha256Bytes(bytes);
    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ServiceError('MAP_GEOGRAPHY_JSON_INVALID', 'Geography source is not valid JSON');
    }
    const result = geographyModelSchema.safeParse(parsed);
    if (!result.success) throw schemaFailure(result.error);
    return {
      model: result.data,
      bytes: bytes.length,
      evidence: {
        absolutePath: source.canonicalPath,
        displayPath: `mod:${relativePath.replaceAll('\\', '/')}`,
        relativePath: relativePath.replaceAll('\\', '/'),
        rootKind: resolved.root.kind,
        loadOrder: resolved.root.loadOrder,
        size: source.metadata.size,
        modifiedMs: source.metadata.mtimeMs,
        sha256,
      },
    };
  } finally {
    await source.handle.close();
  }
}

/**
 * Load (inline or from a workspace file), resolve and validate the geography of one `create_world`
 * operation. Model defects are returned as diagnostics, not thrown; only unusable input (bad path,
 * bad JSON, schema mismatch, oversize, both sources given) throws.
 */
export async function prepareGeography(
  resolver: WorkspaceResolver,
  workspaceId: string,
  operation: GeographyOperationInput,
  principal?: string,
  signal?: AbortSignal,
): Promise<PreparedGeography> {
  if (operation.geography !== undefined && operation.geographyPath !== undefined)
    throw new ServiceError(
      'MAP_GEOGRAPHY_SOURCE_AMBIGUOUS',
      'Give the geography inline (geography) or by file (geographyPath), not both',
    );
  const hasReference = operation.reference !== undefined;
  const frame: GeographyFrame = {
    width:
      operation.width ?? (hasReference ? GEOGRAPHY_REFERENCE_FRAME : GEOGRAPHY_DEFAULT_FRAME).width,
    height:
      operation.height ??
      (hasReference ? GEOGRAPHY_REFERENCE_FRAME : GEOGRAPHY_DEFAULT_FRAME).height,
  };
  let model: GeographyModelInput;
  let source: PreparedGeography['source'];
  if (operation.geographyPath !== undefined) {
    const loaded = await readGeographyModelSource(
      resolver,
      workspaceId,
      operation.geographyPath,
      principal,
      signal,
    );
    model = loaded.model;
    source = {
      kind: 'file',
      bytes: loaded.bytes,
      sha256: loaded.evidence.sha256,
      evidence: loaded.evidence,
    };
  } else {
    model = operation.geography!;
    const bytes = canonicalJsonByteLength(model, GEOGRAPHY_SOURCE_MAX_BYTES);
    if (bytes === undefined)
      throw new ServiceError(
        'MAP_GEOGRAPHY_SOURCE_TOO_LARGE',
        `The inline geography exceeds ${GEOGRAPHY_SOURCE_MAX_BYTES} bytes; write it to a workspace file and pass geographyPath`,
        { limit: GEOGRAPHY_SOURCE_MAX_BYTES },
      );
    source = { kind: 'inline', bytes, sha256: sha256Bytes(canonicalJson(model)) };
  }
  signal?.throwIfAborted();
  const resolution = resolveGeography(model, {
    frame,
    hasReference,
    ...(operation.edge === undefined ? {} : { edge: operation.edge }),
    operationId: operation.id,
  });
  const diagnostics: Diagnostic[] = resolution.diagnostics;
  return { ...resolution, diagnostics, operationId: operation.id, source, frame, hasReference };
}

import type { ReferenceSourceEvidence } from './bounded-source.js';
import { sha256Bytes } from './canonical.js';
import { ServiceError } from './result.js';
import { prepareSource, readBoundedFile, verifySource } from './scanner.js';
import type { WorkspaceResolver } from './workspace.js';

/** Error codes a caller gives for its kind of document, so diagnostics name the input. */
export interface WorkspaceJsonCodes {
  pathInvalid: string;
  tooLarge: string;
  jsonInvalid: string;
  label: string;
}

/**
 * Read one JSON document from the authorized mod workspace: workspace-relative `.json` only,
 * resolved against the principal's grants, opened once, size-bounded, hashed from the very bytes
 * that are parsed and re-verified against the opened identity afterwards. The evidence is a
 * transaction read dependency, so a changed file blocks a write as stale. The caller validates
 * the parsed value with its own schema.
 */
export async function readWorkspaceJsonSource(
  resolver: WorkspaceResolver,
  workspaceId: string,
  requestedPath: string,
  maxBytes: number,
  codes: WorkspaceJsonCodes,
  principal?: string,
  signal?: AbortSignal,
): Promise<{ value: unknown; evidence: ReferenceSourceEvidence; bytes: number }> {
  // Backslashes separate directories on every platform, so a request resolves the same everywhere.
  const relativePath = requestedPath.replaceAll('\\', '/');
  if (!/\.json$/iu.test(relativePath) || relativePath.includes(':'))
    throw new ServiceError(
      codes.pathInvalid,
      `${codes.label} must name a workspace-relative .json file`,
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
      throw new ServiceError('SOURCE_NOT_REGULAR_FILE', `${codes.label} must be a regular file`);
    if (source.metadata.size < 1 || source.metadata.size > maxBytes)
      throw new ServiceError(
        codes.tooLarge,
        `${codes.label} must hold between 1 byte and ${maxBytes} bytes`,
        { limit: maxBytes },
      );
    const bytes = await readBoundedFile(source.handle, maxBytes, signal);
    await verifySource(resolved.root, source);
    const sha256 = sha256Bytes(bytes);
    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ServiceError(codes.jsonInvalid, `${codes.label} is not valid JSON`);
    }
    return {
      value,
      bytes: bytes.length,
      evidence: {
        absolutePath: source.canonicalPath,
        displayPath: `mod:${relativePath}`,
        relativePath,
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

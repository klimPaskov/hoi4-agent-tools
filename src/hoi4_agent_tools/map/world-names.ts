/**
 * Names a caller gives to the states, victory points and strategic regions of a generated world,
 * by world pixel (ZR-22). A name wins over every name the world would derive from its model,
 * reference labels or placeholders; features the caller does not name keep the derived names.
 */
import type { ReferenceSourceEvidence } from '../core/bounded-source.js';
import { canonicalJson, canonicalJsonByteLength, sha256Bytes } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import { prepareSource, readBoundedFile, verifySource } from '../core/scanner.js';
import type { WorkspaceResolver } from '../core/workspace.js';
import { worldNamesSchema, type WorldNamesInput } from '../schemas/map.js';

/** Largest names source, inline or on disk. */
export const WORLD_NAMES_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
/** Examples listed in one diagnostic; the counts stay complete. */
const EXAMPLE_LIMIT = 50;

export interface PreparedWorldNames {
  names: WorldNamesInput;
  source:
    | { kind: 'inline'; bytes: number; sha256: string }
    | { kind: 'file'; bytes: number; sha256: string; evidence: ReferenceSourceEvidence };
}

export interface WorldNameNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

/** What name matching needs to know about the generated world. */
export interface WorldNameView {
  width: number;
  height: number;
  /** Province index of every world pixel, row by row. */
  pixel: Int32Array;
  /** The state of a province index, if it is land in a state. */
  stateOf: (province: number) => number | undefined;
  /** The strategic region of a province index. */
  regionOf: (province: number) => number | undefined;
}

export interface MatchedWorldNames {
  states: Map<number, string>;
  regions: Map<number, string>;
  /** Names for victory points by province index; a province that gets no victory point is unmatched. */
  victory: Map<number, string>;
  /** The pixel each victory name was given at, for the report of names that found no victory point. */
  victoryAt: Map<number, { x: number; y: number }>;
  /** Names on no feature of their kind; the world adds victory names whose province gets none. */
  unmatched: Array<{ kind: string; x: number; y: number; name: string }>;
  notes: WorldNameNote[];
}

type Kind = 'states' | 'victoryPoints' | 'regions';
const KIND_LABEL: Record<Kind, string> = {
  states: 'state',
  victoryPoints: 'victory point',
  regions: 'strategic region',
};

/** Load the names of one `create_world` operation, inline or from a workspace `.json` file. */
export async function prepareWorldNames(
  resolver: WorkspaceResolver,
  workspaceId: string,
  operation: { names?: WorldNamesInput | undefined; namesPath?: string | undefined },
  principal?: string,
  signal?: AbortSignal,
): Promise<PreparedWorldNames | undefined> {
  if (operation.names !== undefined && operation.namesPath !== undefined)
    throw new ServiceError(
      'MAP_NAMES_SOURCE_AMBIGUOUS',
      'Give the names inline (names) or by file (namesPath), not both',
    );
  if (operation.names !== undefined) {
    const bytes = canonicalJsonByteLength(operation.names, WORLD_NAMES_SOURCE_MAX_BYTES);
    if (bytes === undefined)
      throw new ServiceError(
        'MAP_NAMES_SOURCE_TOO_LARGE',
        `The inline names exceed ${WORLD_NAMES_SOURCE_MAX_BYTES} bytes; write them to a workspace file and pass namesPath`,
        { limit: WORLD_NAMES_SOURCE_MAX_BYTES },
      );
    return {
      names: operation.names,
      source: { kind: 'inline', bytes, sha256: sha256Bytes(canonicalJson(operation.names)) },
    };
  }
  if (operation.namesPath === undefined) return undefined;
  // Backslashes separate directories on every platform, so the same request resolves the same way everywhere.
  const relativePath = operation.namesPath.replaceAll('\\', '/');
  if (!/\.json$/iu.test(relativePath) || relativePath.includes(':'))
    throw new ServiceError(
      'MAP_NAMES_PATH_INVALID',
      'Names must name a workspace-relative .json file',
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
      throw new ServiceError('SOURCE_NOT_REGULAR_FILE', 'Names source must be a regular file');
    if (source.metadata.size < 1 || source.metadata.size > WORLD_NAMES_SOURCE_MAX_BYTES)
      throw new ServiceError(
        'MAP_NAMES_SOURCE_TOO_LARGE',
        `Names source must hold between 1 byte and ${WORLD_NAMES_SOURCE_MAX_BYTES} bytes`,
        { limit: WORLD_NAMES_SOURCE_MAX_BYTES },
      );
    const bytes = await readBoundedFile(source.handle, WORLD_NAMES_SOURCE_MAX_BYTES, signal);
    await verifySource(resolved.root, source);
    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ServiceError('MAP_NAMES_JSON_INVALID', 'Names source is not valid JSON');
    }
    const result = worldNamesSchema.safeParse(parsed);
    if (!result.success)
      throw new ServiceError('MAP_NAMES_INVALID', 'Names source does not match the names schema', {
        issues: result.error.issues.slice(0, 20).map(({ path, message }) => ({
          path: path.map(String).join('.'),
          message,
        })),
      });
    const sha256 = sha256Bytes(bytes);
    return {
      names: result.data,
      source: {
        kind: 'file',
        bytes: bytes.length,
        sha256,
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
      },
    };
  } finally {
    await source.handle.close();
  }
}

/**
 * Match each named pixel to the feature it lies in. A point outside the world or on no feature of
 * its kind is unmatched; a second name for a feature already named is a point duplicate and is
 * dropped (the first in the list wins); the same text on two features of one kind is reported.
 */
export function matchWorldNames(names: WorldNamesInput, view: WorldNameView): MatchedWorldNames {
  const result: MatchedWorldNames = {
    states: new Map(),
    regions: new Map(),
    victory: new Map(),
    victoryAt: new Map(),
    unmatched: [],
    notes: [],
  };
  const unmatched = result.unmatched;
  const pointDuplicates: Array<{ kind: string; x: number; y: number; name: string; kept: string }> =
    [];
  const targets: Record<Kind, Map<number, string>> = {
    states: result.states,
    victoryPoints: result.victory,
    regions: result.regions,
  };
  for (const kind of ['states', 'victoryPoints', 'regions'] as const) {
    const target = targets[kind];
    for (const { at, name } of names[kind] ?? []) {
      const inside = at.x < view.width && at.y < view.height;
      const province = inside ? view.pixel[at.y * view.width + at.x]! : -1;
      const feature =
        province < 0
          ? undefined
          : kind === 'states'
            ? view.stateOf(province)
            : kind === 'regions'
              ? view.regionOf(province)
              : view.stateOf(province) === undefined
                ? undefined
                : province;
      if (feature === undefined) {
        unmatched.push({ kind: KIND_LABEL[kind], x: at.x, y: at.y, name });
        continue;
      }
      const kept = target.get(feature);
      if (kept !== undefined) {
        pointDuplicates.push({ kind: KIND_LABEL[kind], x: at.x, y: at.y, name, kept });
        continue;
      }
      target.set(feature, name);
      if (kind === 'victoryPoints') result.victoryAt.set(feature, at);
    }
  }
  if (pointDuplicates.length > 0)
    result.notes.push({
      code: 'MAP_NAME_POINT_DUPLICATE',
      severity: 'warning',
      message: `${pointDuplicates.length} name(s) fall on a feature another name already names; the first name in the list is kept`,
      details: { count: pointDuplicates.length, examples: pointDuplicates.slice(0, EXAMPLE_LIMIT) },
    });
  const duplicates: Array<{ kind: string; name: string; features: number }> = [];
  for (const kind of ['states', 'victoryPoints', 'regions'] as const) {
    const uses = new Map<string, number>();
    for (const name of targets[kind].values()) uses.set(name, (uses.get(name) ?? 0) + 1);
    for (const [name, features] of [...uses].sort((left, right) => (left[0] < right[0] ? -1 : 1)))
      if (features > 1) duplicates.push({ kind: KIND_LABEL[kind], name, features });
  }
  if (duplicates.length > 0)
    result.notes.push({
      code: 'MAP_NAME_DUPLICATE',
      severity: 'warning',
      message: `${duplicates.length} name(s) are given to more than one feature of the same kind`,
      details: { count: duplicates.length, examples: duplicates.slice(0, EXAMPLE_LIMIT) },
    });
  return result;
}

/** The note for names whose pixel lies on no feature of their kind. */
export function unmatchedNote(
  unmatched: ReadonlyArray<{ kind: string; x: number; y: number; name: string }>,
): WorldNameNote {
  return {
    code: 'MAP_NAME_UNMATCHED',
    severity: 'warning',
    message: `${unmatched.length} name(s) lie on no province of the kind they name (a state or region province, or a victory-point province) and were not used`,
    details: { count: unmatched.length, examples: unmatched.slice(0, EXAMPLE_LIMIT) },
  };
}

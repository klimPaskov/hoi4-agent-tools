import { hashCanonical } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { PACKAGE_VERSION } from '../version.js';
import type { MapWorkspaceIndex, ProvinceDefinition } from './model.js';

/**
 * A stated map baseline (ADR 0090, issue 272). A map write that states the fingerprint of the
 * untouched source, as a prior full validation returned it, may leave pre-existing errors in place
 * when it touches none of the objects they belong to. Without a stated fingerprint every error
 * blocks, as before.
 */

/** The validation detail ceiling of a write with a stated baseline: the comparison needs every finding. */
export const MAP_BASELINE_DIAGNOSTIC_LIMIT = 50_000;

/** Pattern of a stated baseline fingerprint (a SHA-256 in lowercase hex). */
export const MAP_BASELINE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * The fingerprint of the map's untouched source: the tool version and the hash of every scanned
 * map source. The findings of a full validation follow from exactly these, so equal fingerprints
 * mean equal findings, however many of them a result lists.
 */
export function mapBaselineFingerprint(
  sources: readonly { displayPath: string; loadOrder: number; sha256: string }[],
): string {
  return hashCanonical({
    schema: 'hoi4.map-baseline.v1',
    toolVersion: PACKAGE_VERSION,
    sources: sources
      .map(({ displayPath, loadOrder, sha256 }) => ({ displayPath, loadOrder, sha256 }))
      .sort(
        (left, right) =>
          left.loadOrder - right.loadOrder ||
          (left.displayPath < right.displayPath
            ? -1
            : left.displayPath > right.displayPath
              ? 1
              : 0),
      ),
  });
}

/** Keys of diagnostic details that name provinces by id. */
const PROVINCE_DETAIL_KEYS = new Set(['province', 'provinceId', 'provinceIds', 'provinces']);

/** The objects a map write changes, and whether a finding belongs to any of them. */
export interface MapWriteFootprint {
  /** Workspace-relative paths the write changes, normalized as diagnostic paths are. */
  readonly changedPaths: ReadonlySet<string>;
  /** Provinces whose definition row or pixels the write changes, added or removed included. */
  readonly touchedProvinces: ReadonlySet<number>;
  /** Whether every province counts as touched (the bitmap changed size or could not be compared). */
  readonly allProvinces: boolean;
  touches(diagnostic: Diagnostic, paths: ReadonlySet<string>): boolean;
}

function sameDefinition(left: ProvinceDefinition, right: ProvinceDefinition): boolean {
  return (
    left.color.r === right.color.r &&
    left.color.g === right.color.g &&
    left.color.b === right.color.b &&
    left.type === right.type &&
    left.coastal === right.coastal &&
    left.terrain === right.terrain &&
    left.continent === right.continent
  );
}

function provinceIdsIn(value: unknown, into: number[]): void {
  if (typeof value === 'number' && Number.isInteger(value)) into.push(value);
  else if (Array.isArray(value)) for (const entry of value) provinceIdsIn(entry, into);
}

/**
 * The footprint of a write that turns `before` into `after` by changing `changedPaths`.
 *
 * A finding belongs to the objects its location and related locations name, and to the provinces
 * its details name. A location in an unchanged file is untouched. A location in a changed
 * province definition file is the province on that row, untouched when the write changes neither
 * that row nor that province's pixels. Every other location in a changed file is touched, and so
 * is a finding that names no object at all: what cannot be shown to lie outside the write lies
 * inside it.
 */
export function mapWriteFootprint(
  before: MapWorkspaceIndex,
  after: MapWorkspaceIndex,
  changedPaths: ReadonlySet<string>,
  normalizePath: (value: string) => string | undefined,
): MapWriteFootprint {
  const touchedProvinces = new Set<number>();
  for (const [id, definition] of after.definitionsById) {
    const previous = before.definitionsById.get(id);
    if (previous === undefined || !sameDefinition(previous, definition)) touchedProvinces.add(id);
  }
  for (const id of before.definitionsById.keys())
    if (!after.definitionsById.has(id)) touchedProvinces.add(id);
  const bitmapChanged =
    before.provinceBitmapFile?.sha256 !== after.provinceBitmapFile?.sha256 ||
    before.provinceBitmapFile?.displayPath !== after.provinceBitmapFile?.displayPath;
  let allProvinces = false;
  if (bitmapChanged) {
    const left = before.raster;
    const right = after.raster;
    if (right === undefined || left?.width !== right.width || left.height !== right.height) {
      allProvinces = true;
    } else {
      for (let pixel = 0; pixel < right.provinceIds.length; pixel += 1) {
        const was = left.provinceIds[pixel]!;
        const is = right.provinceIds[pixel]!;
        if (was === is) continue;
        if (was >= 0) touchedProvinces.add(was);
        if (is >= 0) touchedProvinces.add(is);
      }
    }
  }
  // The rows of every definition file, by path and one-based line, in the source after the write.
  const definitionRows = new Map<string, Map<number, number>>();
  for (const definition of after.definitionsAcrossRoots) {
    const path = normalizePath(definition.document.file.displayPath);
    if (path === undefined) continue;
    const rows = definitionRows.get(path) ?? new Map<number, number>();
    rows.set(definition.line, definition.id);
    definitionRows.set(path, rows);
  }
  const provinceTouched = (id: number): boolean => allProvinces || touchedProvinces.has(id);
  return {
    changedPaths,
    touchedProvinces,
    allProvinces,
    touches(diagnostic, paths) {
      const locations = [
        ...(diagnostic.location === undefined ? [] : [diagnostic.location]),
        ...(diagnostic.related ?? []),
      ];
      const named: number[] = [];
      for (const [key, value] of Object.entries(diagnostic.details ?? {}))
        if (PROVINCE_DETAIL_KEYS.has(key)) provinceIdsIn(value, named);
      if (locations.length === 0 && named.length === 0) return true;
      if (named.some(provinceTouched)) return true;
      const located = new Set<string>();
      for (const location of locations) {
        const path = normalizePath(location.path);
        if (path === undefined) {
          // A location that is no workspace path cannot be matched against the write.
          if (changedPaths.size > 0) return true;
          continue;
        }
        located.add(path);
        if (!changedPaths.has(path)) continue;
        const province = definitionRows.get(path)?.get(location.start.line);
        if (province === undefined || provinceTouched(province)) return true;
      }
      // Paths named only in the details (not as a location) are whole files.
      for (const path of paths) if (!located.has(path) && changedPaths.has(path)) return true;
      return false;
    },
  };
}

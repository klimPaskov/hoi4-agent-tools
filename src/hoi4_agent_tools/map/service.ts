import path from 'node:path';
import fg from 'fast-glob';
import {
  ArtifactStore,
  boundedSourceHashEvidence,
  publicArtifactLink,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import type { ArtifactLink } from '../core/result.js';
import { canonicalJson, compareCodeUnits, hashCanonical, sha256Bytes } from '../core/canonical.js';
import { sortDiagnostics, type Diagnostic } from '../core/diagnostics.js';
import { CoreEngine } from '../core/engine.js';
import { RenderBudget } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { WorkspaceScanner } from '../core/scanner.js';
import {
  readDependenciesFromScannedFiles,
  type ProposedFileChange,
  type TransactionManager,
  type TransactionManifest,
} from '../core/transactions.js';
import type { WorkspaceResolver } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT,
  MAP_SELECTED_OFFSET_BYTES,
  MAP_SELECTED_PIXEL_LIMIT,
} from './limits.js';
import {
  defaultMapSelectorValue,
  MapWorkspaceIndex,
  type ProvinceGeometry,
  type ProvinceRaster,
} from './model.js';
import { planMapOperationsAsync, type MapOperation, type MapOperationPlan } from './operations.js';
import {
  renderMap,
  renderMapDiff,
  type MapDiffBundle,
  type MapDiffReviewContext,
  type MapRenderBundle,
  type MapRenderOptions,
} from './render.js';
import { validateMapAsync, type MapValidationResult } from './validation.js';

export interface MapScanSnapshot {
  workspaceId: string;
  revision: string;
  files: ScannedFile[];
  index: MapWorkspaceIndex;
}

export interface MapPlanInput {
  workspaceId: string;
  operations: MapOperation[];
  artifacts?: ArtifactLink[];
  principal?: string;
  signal?: AbortSignal;
}

export interface MapPlanResult {
  transaction: TransactionManifest;
  plan: MapOperationPlan;
  validation: MapValidationResult;
}

export interface StoredMapRender {
  bundle: MapRenderBundle;
  artifacts: StoredArtifact[];
  revision: string;
  filesScanned: string[];
}

export interface StoredMapDiff {
  bundle: MapDiffBundle;
  beforeBundle: MapRenderBundle;
  proposedBundle: MapRenderBundle;
  plan: MapOperationPlan;
  artifacts: StoredArtifact[];
  revision: string;
  filesScanned: string[];
}

export interface MapRewritePlanInput {
  workspaceId: string;
  operations: MapOperation[];
  diffScale?: number;
  principal?: string;
  signal?: AbortSignal;
}

export interface MapRewritePlanResult extends MapPlanResult, StoredMapDiff {}

interface PreparedMapOperations {
  snapshot: MapScanSnapshot;
  plan: MapOperationPlan;
  validation: MapValidationResult;
}

export interface MapValidationAttributionInput {
  diagnostics: readonly Diagnostic[];
  operations: ReadonlyArray<MapOperationPlan['operations'][number]>;
  changes: readonly Pick<ProposedFileChange, 'relativePath' | 'operationIds'>[];
  baselineDiagnostics?: readonly Diagnostic[];
}

export type ProvinceGeometryRowRun = readonly [y: number, startX: number, endXExclusive: number];

export interface ProvinceGeometryRowRuns {
  provinceId: number;
  pixelCount: number;
  bounds: {
    minX: number;
    minY: number;
    maxXExclusive: number;
    maxYExclusive: number;
  };
  rowRunCount: number;
  rowRuns: ProvinceGeometryRowRun[];
}

export interface ProvinceGeometryRowRunExport {
  width: number;
  height: number;
  requestedProvinceIds: number[];
  unknownProvinceIds: number[];
  missingGeometryProvinceIds: number[];
  pixelCount: number;
  rowRunCount: number;
  provinces: ProvinceGeometryRowRuns[];
}

export interface ProvinceGeometryExportSource {
  definitionsById: ReadonlyMap<number, unknown>;
  raster: Pick<ProvinceRaster, 'width' | 'height' | 'provinceIds' | 'geometry'> | undefined;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function exactGeometryBounds(geometry: ProvinceGeometry): ProvinceGeometryRowRuns['bounds'] {
  return {
    minX: geometry.minX,
    minY: geometry.minY,
    maxXExclusive: geometry.maxX + 1,
    maxYExclusive: geometry.maxY + 1,
  };
}

function assertProvinceGeometryExportPixelBudget(pixelCount: number): void {
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 0) {
    throw new ServiceError(
      'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
      'Province geometry export declares an invalid selected-pixel count',
      {
        source: 'Province geometry export',
        selectedPixels: pixelCount,
        maximumSelectedPixels: MAP_SELECTED_PIXEL_LIMIT,
      },
    );
  }
  if (pixelCount > MAP_SELECTED_PIXEL_LIMIT) {
    throw new ServiceError(
      'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
      'Province geometry export exceeds the fixed selected-pixel memory budget',
      {
        source: 'Province geometry export',
        selectedPixels: pixelCount,
        maximumSelectedPixels: MAP_SELECTED_PIXEL_LIMIT,
        maximumOffsetBytes: MAP_SELECTED_PIXEL_LIMIT * MAP_SELECTED_OFFSET_BYTES,
      },
    );
  }
}

/**
 * Export maximal, canonical row runs from the same raster used by map rewrites.
 * Runs are collected in raster order, so every province's tuples are sorted by
 * y and then startX without a second, memory-heavy sort.
 */
export async function exportProvinceGeometryRowRuns(
  source: ProvinceGeometryExportSource,
  provinceIds: readonly number[],
  signal?: AbortSignal,
): Promise<ProvinceGeometryRowRunExport> {
  signal?.throwIfAborted();
  if (provinceIds.length > MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT) {
    throw new ServiceError(
      'MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT',
      `Province geometry inspection accepts at most ${MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT} IDs`,
      {
        requestedProvinceCount: provinceIds.length,
        maximumProvinceCount: MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT,
      },
    );
  }
  if (provinceIds.some((provinceId) => !Number.isSafeInteger(provinceId) || provinceId < 0)) {
    throw new ServiceError(
      'MAP_PROVINCE_GEOMETRY_SELECTOR_INVALID',
      'Province geometry inspection IDs must be non-negative safe integers',
    );
  }
  const raster = source.raster;
  if (raster === undefined) {
    throw new ServiceError(
      'MAP_PROVINCE_BITMAP_MISSING',
      'Exact province geometry inspection requires provinces.bmp',
    );
  }

  const requestedProvinceIds = [...new Set(provinceIds)].sort(compareNumbers);
  const unknownProvinceIds = requestedProvinceIds.filter(
    (provinceId) => !source.definitionsById.has(provinceId),
  );
  const missingGeometryProvinceIds = requestedProvinceIds.filter(
    (provinceId) => source.definitionsById.has(provinceId) && !raster.geometry.has(provinceId),
  );
  const exportableProvinceIds = requestedProvinceIds.filter(
    (provinceId) => source.definitionsById.has(provinceId) && raster.geometry.has(provinceId),
  );
  let pixelCount = 0;
  for (const provinceId of exportableProvinceIds) {
    const geometry = raster.geometry.get(provinceId);
    if (geometry === undefined) continue;
    pixelCount += geometry.pixelCount;
    assertProvinceGeometryExportPixelBudget(pixelCount);
  }

  const rowRunsByProvince = new Map<number, ProvinceGeometryRowRun[]>(
    exportableProvinceIds.map((provinceId) => [provinceId, []]),
  );
  const observedPixelCounts = new Map<number, number>(
    exportableProvinceIds.map((provinceId) => [provinceId, 0]),
  );
  for (let y = 0; y < raster.height; y += 1) {
    if (y % 32 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
    let x = 0;
    while (x < raster.width) {
      const provinceId = raster.provinceIds[y * raster.width + x] ?? -1;
      const startX = x;
      x += 1;
      while (x < raster.width && (raster.provinceIds[y * raster.width + x] ?? -1) === provinceId) {
        x += 1;
      }
      const runs = rowRunsByProvince.get(provinceId);
      if (runs === undefined) continue;
      runs.push([y, startX, x]);
      observedPixelCounts.set(provinceId, (observedPixelCounts.get(provinceId) ?? 0) + x - startX);
    }
  }
  signal?.throwIfAborted();

  const provinces = exportableProvinceIds.map((provinceId) => {
    const geometry = raster.geometry.get(provinceId);
    if (geometry === undefined) {
      throw new ServiceError(
        'MAP_RASTER_GEOMETRY_MISMATCH',
        'Province geometry disappeared during exact row-run export',
        { provinceId },
      );
    }
    const observedPixelCount = observedPixelCounts.get(provinceId) ?? 0;
    if (observedPixelCount !== geometry.pixelCount) {
      throw new ServiceError(
        'MAP_RASTER_GEOMETRY_MISMATCH',
        'Exact province row runs do not match the indexed province pixel count',
        {
          provinceId,
          expectedPixelCount: geometry.pixelCount,
          observedPixelCount,
        },
      );
    }
    const rowRuns = rowRunsByProvince.get(provinceId) ?? [];
    return {
      provinceId,
      pixelCount: observedPixelCount,
      bounds: exactGeometryBounds(geometry),
      rowRunCount: rowRuns.length,
      rowRuns,
    };
  });

  return {
    width: raster.width,
    height: raster.height,
    requestedProvinceIds,
    unknownProvinceIds,
    missingGeometryProvinceIds,
    pixelCount,
    rowRunCount: provinces.reduce((count, province) => count + province.rowRunCount, 0),
    provinces,
  };
}

const provinceOperationKinds = new Set([
  'split_province',
  'create_province',
  'merge_provinces',
  'remove_province',
  'update_province_definition',
  'add_normal_adjacency',
  'remove_normal_adjacency',
]);
const stateOperationKinds = new Set([
  'move_state_provinces',
  'update_state',
  'split_state',
  'create_state',
  'merge_states',
  ...provinceOperationKinds,
]);

function normalizedDiagnosticPath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  const displayPath = /^(?:mod|dependency|game|fixture):(.*)$/u.exec(normalized)?.[1];
  const candidate = displayPath ?? normalized;
  if (
    candidate.length === 0 ||
    candidate.includes('://') ||
    !candidate.includes('/') ||
    candidate.startsWith('/')
  ) {
    return undefined;
  }
  return candidate.replace(/^\.\//u, '').toLowerCase();
}

function diagnosticPaths(diagnostic: Diagnostic): Set<string> {
  const paths = new Set<string>();
  const add = (value: string): void => {
    const normalized = normalizedDiagnosticPath(value);
    if (normalized !== undefined) paths.add(normalized);
  };
  if (diagnostic.location !== undefined) add(diagnostic.location.path);
  for (const related of diagnostic.related ?? []) add(related.path);
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const entry of Object.values(value as Record<string, unknown>)) visit(entry);
    }
  };
  visit(diagnostic.details);
  return paths;
}

function diagnosticFingerprint(diagnostic: Diagnostic): string {
  return hashCanonical({
    code: diagnostic.code,
    message: diagnostic.message,
    path:
      diagnostic.location === undefined
        ? null
        : (normalizedDiagnosticPath(diagnostic.location.path) ?? diagnostic.location.path),
    symbol: diagnostic.location?.symbol ?? null,
  });
}

function operationKindsForDiagnostic(code: string): ReadonlySet<string> | undefined {
  if (
    code.startsWith('MAP_BMP_') ||
    code.startsWith('MAP_BITMAP_') ||
    code.startsWith('MAP_PROVINCES_') ||
    code.startsWith('MAP_DEFINITION_') ||
    code.startsWith('MAP_PROVINCE_ID_') ||
    code.startsWith('MAP_PROVINCE_COLOR_') ||
    code.startsWith('MAP_PROVINCE_TOO_') ||
    code.startsWith('MAP_PROVINCE_LARGE_') ||
    code.startsWith('MAP_PROVINCE_DISCONNECTED_') ||
    code.startsWith('MAP_PROVINCE_THIN_') ||
    code.startsWith('MAP_COASTAL_') ||
    code.startsWith('MAP_LAND_CONTINENT_') ||
    code.startsWith('MAP_SEA_TERRAIN_') ||
    code.startsWith('MAP_LAKE_TERRAIN_') ||
    code.startsWith('MAP_DIMENSIONS_') ||
    code.startsWith('MAP_AREA_') ||
    code.startsWith('MAP_INVALID_X_') ||
    code.startsWith('MAP_PIXELS_')
  ) {
    return provinceOperationKinds;
  }
  if (
    code.startsWith('MAP_STATE_') ||
    code.startsWith('MAP_NEW_STATE_') ||
    code.startsWith('MAP_LAND_PROVINCE_STATE_') ||
    code.startsWith('MAP_PROVINCE_STATE_') ||
    code.startsWith('MAP_SEA_PROVINCE_IN_STATE') ||
    code.startsWith('MAP_LAKE_PROVINCE_IN_STATE') ||
    code.startsWith('MAP_VICTORY_POINT_') ||
    code.startsWith('MAP_PROVINCE_BUILDING_')
  ) {
    return stateOperationKinds;
  }
  if (
    code.startsWith('MAP_STRATEGIC_REGION_') ||
    code.startsWith('MAP_REGION_') ||
    code.startsWith('MAP_PROVINCE_REGION_')
  ) {
    return new Set(['move_region_provinces', ...provinceOperationKinds]);
  }
  if (
    code.startsWith('MAP_ADJACENCY_') ||
    code.startsWith('MAP_IMPASSABLE_') ||
    code.startsWith('MAP_SEA_ADJACENCY_')
  ) {
    return new Set([
      'add_adjacency',
      'remove_adjacency',
      'add_normal_adjacency',
      'remove_normal_adjacency',
      ...provinceOperationKinds,
    ]);
  }
  if (code.startsWith('MAP_SUPPLY_NODE_'))
    return new Set(['add_supply_node', 'remove_supply_node', ...provinceOperationKinds]);
  if (code.startsWith('MAP_RAILWAY_'))
    return new Set(['add_railway', 'remove_railway', ...provinceOperationKinds]);
  if (code.startsWith('MAP_BUILDING_') || code.startsWith('MAP_PORT_'))
    return new Set([
      'upsert_building_position',
      'remove_building_position',
      ...stateOperationKinds,
    ]);
  if (code.startsWith('MAP_UNIT_POSITION_'))
    return new Set(['upsert_unit_position', 'remove_unit_position', ...provinceOperationKinds]);
  if (code.startsWith('MAP_WEATHER_'))
    return new Set(['upsert_weather_position', 'remove_weather_position', 'move_region_provinces']);
  if (code.startsWith('MAP_ENTITY_LOCATOR_')) return new Set(['update_entity_locator']);
  return undefined;
}

/**
 * Bind every post-operation validation error to the last manifest operation
 * that owns its changed source. Pre-existing or otherwise unowned errors gain
 * an explicit blocking ownership diagnostic rather than being guessed.
 */
export function attributeMapValidationDiagnostics(
  input: MapValidationAttributionInput,
): Diagnostic[] {
  const order = new Map(input.operations.map(({ id }, index) => [id, index]));
  const operationKinds = new Map(input.operations.map(({ id, kind }) => [id, kind]));
  const changedOperationIds = new Set(input.changes.flatMap(({ operationIds }) => operationIds));
  const ownersByPath = new Map<string, Set<string>>();
  for (const change of input.changes) {
    const relativePath = change.relativePath.replaceAll('\\', '/').toLowerCase();
    const owners = ownersByPath.get(relativePath) ?? new Set<string>();
    for (const operationId of change.operationIds) owners.add(operationId);
    ownersByPath.set(relativePath, owners);
  }
  const baselineErrors = new Set(
    (input.baselineDiagnostics ?? [])
      .filter(({ severity }) => severity === 'error' || severity === 'blocker')
      .map(diagnosticFingerprint),
  );
  const attributed: Diagnostic[] = [];
  for (const diagnostic of input.diagnostics) {
    if (
      diagnostic.operationId !== undefined ||
      (diagnostic.severity !== 'error' && diagnostic.severity !== 'blocker')
    ) {
      attributed.push(diagnostic);
      continue;
    }
    const fingerprint = diagnosticFingerprint(diagnostic);
    if (baselineErrors.has(fingerprint)) {
      attributed.push({
        ...diagnostic,
        details: { ...diagnostic.details, attributionStatus: 'pre-existing-baseline' },
      });
      attributed.push({
        code: 'MAP_VALIDATION_OPERATION_UNOWNED',
        severity: 'blocker',
        category: 'validation',
        message: `${diagnostic.code} already existed before the manifest and has no originating operation`,
        ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
        ...(diagnostic.related === undefined ? {} : { related: diagnostic.related }),
        details: {
          sourceDiagnosticCode: diagnostic.code,
          sourceDiagnosticFingerprint: fingerprint,
          attributionStatus: 'pre-existing-baseline',
        },
      });
      continue;
    }
    const pathCandidates = new Set<string>();
    for (const diagnosticPath of diagnosticPaths(diagnostic)) {
      for (const owner of ownersByPath.get(diagnosticPath) ?? []) pathCandidates.add(owner);
    }
    const allowedKinds = operationKindsForDiagnostic(diagnostic.code);
    const familyCandidates = new Set(
      [...changedOperationIds].filter((operationId) => {
        const kind = operationKinds.get(operationId);
        return kind !== undefined && allowedKinds?.has(kind) === true;
      }),
    );
    let candidates = pathCandidates;
    if (pathCandidates.size > 0 && familyCandidates.size > 0) {
      const intersection = new Set(
        [...pathCandidates].filter((operationId) => familyCandidates.has(operationId)),
      );
      if (intersection.size > 0) candidates = intersection;
    } else if (pathCandidates.size === 0 && familyCandidates.size > 0) {
      candidates = familyCandidates;
    } else if (pathCandidates.size === 0 && changedOperationIds.size === 1) {
      candidates = new Set(changedOperationIds);
    }
    const orderedCandidates = [...candidates].sort(
      (left, right) =>
        (order.get(left) ?? -1) - (order.get(right) ?? -1) || compareCodeUnits(left, right),
    );
    const owner = orderedCandidates.at(-1);
    if (owner !== undefined) {
      attributed.push({
        ...diagnostic,
        operationId: owner,
        details: {
          ...diagnostic.details,
          attributionStrategy:
            pathCandidates.size > 0
              ? 'last-operation-owning-diagnostic-source'
              : 'last-compatible-map-operation',
          attributionCandidateOperationIds: orderedCandidates,
        },
      });
      continue;
    }
    attributed.push({
      ...diagnostic,
      details: { ...diagnostic.details, attributionStatus: 'no-owning-operation' },
    });
    attributed.push({
      code: 'MAP_VALIDATION_OPERATION_UNOWNED',
      severity: 'blocker',
      category: 'validation',
      message: `${diagnostic.code} cannot be attributed to any manifest operation`,
      ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
      ...(diagnostic.related === undefined ? {} : { related: diagnostic.related }),
      details: {
        sourceDiagnosticCode: diagnostic.code,
        sourceDiagnosticFingerprint: fingerprint,
        attributionStatus: 'no-owning-operation',
      },
    });
  }
  return sortDiagnostics(attributed);
}

function normalizeSourceRoot(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function defaultMapPatterns(roots: { map: readonly string[] }): string[] {
  return roots.map.map((root) => `${normalizeSourceRoot(root)}/default.map`);
}

function sourceTextPatterns(roots: {
  map: readonly string[];
  states: readonly string[];
  localisation: readonly string[];
}): string[] {
  return [
    ...roots.map.flatMap((root) => {
      const normalized = normalizeSourceRoot(root);
      return ['map', 'csv', 'txt'].map((extension) => `${normalized}/**/*.${extension}`);
    }),
    ...roots.states.map((root) => `${normalizeSourceRoot(root)}/**/*.txt`),
    ...roots.localisation.flatMap((root) => {
      const normalized = normalizeSourceRoot(root);
      return [`${normalized}/english/**/*.{yml,yaml}`, `${normalized}/*.{yml,yaml}`];
    }),
    '**/*.asset',
  ];
}

function provinceBitmapPatterns(
  defaultMaps: readonly ScannedFile[],
  mapRoots: readonly string[],
): string[] {
  const activeByPath = new Map(
    defaultMaps
      .filter(({ shadowedBy }) => shadowedBy === undefined)
      .map((file) => [file.relativePath.replaceAll('\\', '/').toLowerCase(), file] as const),
  );
  let activeName = 'provinces.bmp';
  for (const root of mapRoots) {
    const relativePath = `${normalizeSourceRoot(root)}/default.map`.toLowerCase();
    const active = activeByPath.get(relativePath);
    if (active === undefined) continue;
    activeName = defaultMapSelectorValue(active, 'provinces', activeName);
    break;
  }
  const names = new Set([activeName]);
  for (const file of defaultMaps) {
    names.add(defaultMapSelectorValue(file, 'provinces', activeName));
  }
  const patterns = new Set<string>();
  for (const root of mapRoots) {
    const normalizedRoot = normalizeSourceRoot(root);
    for (const name of names) {
      const candidate = name.replaceAll('\\', '/');
      if (
        candidate.trim() === '' ||
        candidate.includes('\0') ||
        candidate.includes(':') ||
        path.posix.isAbsolute(candidate) ||
        path.win32.isAbsolute(name) ||
        candidate.split('/').includes('..')
      )
        continue;
      const normalizedName = path.posix.normalize(candidate).replace(/^\.\//u, '');
      if (normalizedName === '.' || normalizedName === '') continue;
      const selectedPath = path.posix.normalize(path.posix.join(normalizedRoot, normalizedName));
      if (selectedPath !== normalizedRoot && !selectedPath.startsWith(`${normalizedRoot}/`))
        continue;
      patterns.add(fg.posix.escapePath(selectedPath));
    }
  }
  return [...patterns].sort((left, right) => compareCodeUnits(left, right));
}

function sourceHashes(snapshot: MapScanSnapshot): Record<string, string> {
  return Object.fromEntries(snapshot.files.map(({ displayPath, sha256 }) => [displayPath, sha256]));
}

function mapBundleWithSourceHashes<T extends MapRenderBundle>(
  bundle: T,
  completeSourceHashes: Readonly<Record<string, string>>,
): T {
  const parsed = JSON.parse(bundle.json) as Record<string, unknown>;
  const json = `${canonicalJson({ ...parsed, sourceHashes: completeSourceHashes })}\n`;
  return {
    ...bundle,
    json,
    hashes: { ...bundle.hashes, json: sha256Bytes(json) },
  };
}

function validationWithPlan(
  validation: MapValidationResult,
  plan: MapOperationPlan,
): MapValidationResult {
  const diagnostics = sortDiagnostics([...plan.diagnostics, ...validation.diagnostics]);
  const choicesPassed = plan.blockers.length === 0;
  const checks = [
    {
      id: 'map-operation-choices',
      passed: choicesPassed,
      message: 'Every declarative map operation has complete, resolvable policies',
    },
    ...validation.checks,
  ];
  return {
    passed:
      choicesPassed &&
      validation.passed &&
      !diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'),
    diagnostics,
    checks,
  };
}

export class AgentNudger {
  private readonly engine: CoreEngine;
  private readonly resolver: WorkspaceResolver;
  readonly scanner: WorkspaceScanner;
  readonly transactions: TransactionManager;
  readonly artifacts: ArtifactStore;

  public constructor(engine: CoreEngine);
  public constructor(
    resolver: WorkspaceResolver,
    transactions?: TransactionManager,
    artifacts?: ArtifactStore,
    scanner?: WorkspaceScanner,
  );
  public constructor(
    engineOrResolver: CoreEngine | WorkspaceResolver,
    transactions?: TransactionManager,
    artifacts = new ArtifactStore(),
    scanner = new WorkspaceScanner(),
  ) {
    this.engine =
      engineOrResolver instanceof CoreEngine
        ? engineOrResolver
        : new CoreEngine(engineOrResolver, {
            scanner,
            artifacts,
            ...(transactions === undefined ? {} : { transactions }),
          });
    this.resolver = this.engine.resolver;
    this.artifacts = this.engine.artifacts;
    this.scanner = this.engine.scanner;
    this.transactions = this.engine.transactions;
  }

  async scan(
    workspaceId: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<MapScanSnapshot> {
    signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, principal);
    const sourceRoots = {
      map: workspace.registration.roots.map,
      states: workspace.registration.roots.states,
      localisation: workspace.registration.roots.localisation,
    };
    const selectorSnapshot = await this.engine.scan(
      workspaceId,
      { patterns: defaultMapPatterns(sourceRoots) },
      principal,
      signal,
    );
    const bitmapPatterns = provinceBitmapPatterns(selectorSnapshot.files, sourceRoots.map);
    const contentSnapshot = await this.engine.scan(
      workspaceId,
      { patterns: [...sourceTextPatterns(sourceRoots), ...bitmapPatterns] },
      principal,
      signal,
    );
    signal?.throwIfAborted();
    const files = contentSnapshot.files;
    const revision = hashCanonical(
      files.map(({ displayPath, loadOrder, sha256 }) => ({ displayPath, loadOrder, sha256 })),
    );
    return {
      workspaceId,
      revision,
      files,
      index: MapWorkspaceIndex.build(files, sourceRoots, contentSnapshot.index),
    };
  }

  async validate(
    workspaceId: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<{ snapshot: MapScanSnapshot; validation: MapValidationResult }> {
    const snapshot = await this.scan(workspaceId, principal, signal);
    return {
      snapshot,
      validation: await validateMapAsync(snapshot.index, signal === undefined ? {} : { signal }),
    };
  }

  private async prepareOperations(
    workspaceId: string,
    operations: readonly MapOperation[],
    principal?: string,
    signal?: AbortSignal,
  ): Promise<PreparedMapOperations> {
    signal?.throwIfAborted();
    const snapshot = await this.scan(workspaceId, principal, signal);
    const plan = await planMapOperationsAsync(snapshot.index, operations, signal);
    const baselineValidation = await validateMapAsync(
      snapshot.index,
      signal === undefined ? {} : { signal },
    );
    const rawValidation = await validateMapAsync(plan.finalIndex, {
      baseline: snapshot.index,
      ...(signal === undefined ? {} : { signal }),
      ...(plan.expectedChangedBounds === undefined
        ? {}
        : { expectedChangedBounds: plan.expectedChangedBounds }),
    });
    const attributedValidation: MapValidationResult = {
      ...rawValidation,
      diagnostics: attributeMapValidationDiagnostics({
        diagnostics: rawValidation.diagnostics,
        operations: plan.operations,
        changes: plan.changes,
        baselineDiagnostics: baselineValidation.diagnostics,
      }),
    };
    return {
      snapshot,
      plan,
      validation: validationWithPlan(attributedValidation, plan),
    };
  }

  async plan(input: MapPlanInput): Promise<MapPlanResult> {
    const prepared = await this.prepareOperations(
      input.workspaceId,
      input.operations,
      input.principal,
      input.signal,
    );
    return this.planPrepared(input, prepared);
  }

  private async planPrepared(
    input: MapPlanInput,
    prepared: PreparedMapOperations,
  ): Promise<MapPlanResult> {
    input.signal?.throwIfAborted();
    const { snapshot, plan, validation } = prepared;
    if (snapshot.workspaceId !== input.workspaceId) {
      throw new ServiceError(
        'MAP_PREPARED_WORKSPACE_MISMATCH',
        'Prepared map operations belong to another workspace',
      );
    }
    const transaction = await this.transactions.plan({
      workspaceId: input.workspaceId,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      operationKind: 'agent-nudger-map-changes',
      operations: plan.operations,
      changes: plan.changes,
      readDependencies: readDependenciesFromScannedFiles(snapshot.files),
      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
      diagnostics: plan.diagnostics,
      validate: (proposed, signal) => {
        signal?.throwIfAborted();
        const expected = new Map(
          plan.changes.map((change) => [change.relativePath, change.content]),
        );
        const current = new Map(
          snapshot.files
            .filter(({ rootKind, shadowedBy }) => rootKind === 'mod' && shadowedBy === undefined)
            .map(({ relativePath, bytes }) => [relativePath, bytes] as const),
        );
        const exactProposedBytes =
          proposed.size <= expected.size &&
          [...expected].every(([relativePath, planned]) => {
            const content = proposed.has(relativePath)
              ? proposed.get(relativePath)
              : (current.get(relativePath) ?? null);
            if (content === undefined) return false;
            if (content === null || planned === null) return content === planned;
            return Buffer.from(content).equals(Buffer.from(planned));
          }) &&
          [...proposed.keys()].every((relativePath) => expected.has(relativePath));
        const diagnostics = exactProposedBytes
          ? validation.diagnostics
          : [
              ...validation.diagnostics,
              {
                code: 'MAP_TRANSACTION_BYTES_MISMATCH',
                severity: 'blocker' as const,
                category: 'validation' as const,
                message: 'Transaction dry-run bytes differ from the validated map operation plan',
              },
            ];
        return Promise.resolve({
          diagnostics,
          checks: [
            {
              id: 'map-proposed-bytes-match',
              passed: exactProposedBytes,
              message: exactProposedBytes
                ? 'Transaction bytes exactly match the validated in-memory map plan'
                : 'Transaction bytes differ from the validated in-memory map plan',
            },
            ...validation.checks,
          ],
        });
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { transaction, plan, validation };
  }

  async renderAndStore(
    workspaceId: string,
    options: MapRenderOptions & { principal?: string; signal?: AbortSignal } = {},
  ): Promise<StoredMapRender> {
    const snapshot = await this.scan(workspaceId, options.principal, options.signal);
    const rawBundle = await renderMap(snapshot.index, {
      ...options,
      budget: options.budget ?? new RenderBudget(),
    });
    const completeSourceHashes = sourceHashes(snapshot);
    const sourceEvidence = boundedSourceHashEvidence(completeSourceHashes);
    const bundle = mapBundleWithSourceHashes(rawBundle, completeSourceHashes);
    const workspace = this.resolver.get(workspaceId, options.principal);
    const layer = options.layer ?? 'province';
    const provenance = {
      kind: 'map-render',
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'map-render.v1',
      sourceHashes: sourceEvidence.sourceHashes,
      renderProfile: {
        offline: true,
        layer,
        overlays: [...new Set(options.overlays ?? [])].sort(),
        scale: options.scale ?? 1,
      },
      metadata: { sourceHashInventory: sourceEvidence.inventory },
    };
    const writes: ArtifactWrite[] = [
      {
        name: `map-${layer}.png`,
        mimeType: 'image/png',
        content: bundle.png,
        provenance,
      },
      {
        name: `map-${layer}.json`,
        mimeType: 'application/json',
        content: bundle.json,
        provenance,
      },
      {
        name: `map-${layer}.html`,
        mimeType: 'text/html',
        content: bundle.html,
        provenance,
      },
    ];
    const artifacts = await this.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (stored) => Promise.resolve([...stored]),
      options.signal,
    );
    return {
      bundle,
      artifacts,
      revision: snapshot.revision,
      filesScanned: snapshot.files.map(({ displayPath }) => displayPath),
    };
  }

  async renderDiffAndStore(
    workspaceId: string,
    operations: readonly MapOperation[],
    options: Pick<MapRenderOptions, 'scale'> & { principal?: string; signal?: AbortSignal } = {},
  ): Promise<StoredMapDiff> {
    const prepared = await this.prepareOperations(
      workspaceId,
      operations,
      options.principal,
      options.signal,
    );
    return this.renderPreparedDiffAndStore(prepared, operations, options);
  }

  /**
   * Build review evidence and a hash-bound transaction from one immutable scan and operation plan.
   * Any source edit after this preparation is rejected by the transaction read-dependency checks.
   */
  async planRewriteWithDiff(input: MapRewritePlanInput): Promise<MapRewritePlanResult> {
    const prepared = await this.prepareOperations(
      input.workspaceId,
      input.operations,
      input.principal,
      input.signal,
    );
    const diff = await this.renderPreparedDiffAndStore(prepared, input.operations, {
      ...(input.diffScale === undefined ? {} : { scale: input.diffScale }),
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const planned = await this.planPrepared(
      {
        workspaceId: input.workspaceId,
        operations: input.operations,
        artifacts: diff.artifacts.map(publicArtifactLink),
        ...(input.principal === undefined ? {} : { principal: input.principal }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      prepared,
    );
    return { ...diff, ...planned };
  }

  private async renderPreparedDiffAndStore(
    prepared: PreparedMapOperations,
    operations: readonly MapOperation[],
    options: Pick<MapRenderOptions, 'scale'> & { principal?: string; signal?: AbortSignal },
  ): Promise<StoredMapDiff> {
    const budget = new RenderBudget();
    const { snapshot, plan, validation } = prepared;
    const review: MapDiffReviewContext = {
      operationIds: plan.operations.map(({ id }) => id),
      affectedFiles: plan.changes.map(({ relativePath, operationIds, mediaType, content }) => ({
        relativePath,
        operationIds: [...operationIds],
        ...(mediaType === undefined ? {} : { mediaType }),
        deletion: content === null,
      })),
      unresolvedChoices: plan.blockers.map(({ code, message, operationId, details }) => ({
        code,
        message,
        operationId,
        ...(details === undefined ? {} : { details }),
      })),
      allocations: plan.allocations,
      validation,
    };
    const comparisonOverlays = [
      'adjacencies',
      'building-positions',
      'coastlines',
      'ports',
      'province-buildings',
      'railways',
      'resources',
      'state-buildings',
      'supply-nodes',
      'unit-positions',
      'victory-points',
      'weather-positions',
    ] as const;
    const [rawBundle, rawBeforeBundle, rawProposedBundle] = await Promise.all([
      renderMapDiff(snapshot.index, plan.finalIndex, {
        ...(options.scale === undefined ? {} : { scale: options.scale }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        budget,
        review,
      }),
      renderMap(snapshot.index, {
        layer: 'state',
        overlays: [...comparisonOverlays],
        ...(options.scale === undefined ? {} : { scale: options.scale }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        budget,
      }),
      renderMap(plan.finalIndex, {
        layer: 'state',
        overlays: [...comparisonOverlays],
        ...(options.scale === undefined ? {} : { scale: options.scale }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        budget,
      }),
    ]);
    const completeSourceHashes = sourceHashes(snapshot);
    const sourceEvidence = boundedSourceHashEvidence(completeSourceHashes);
    const bundle = mapBundleWithSourceHashes(rawBundle, completeSourceHashes);
    const beforeBundle = mapBundleWithSourceHashes(rawBeforeBundle, completeSourceHashes);
    const proposedBundle = mapBundleWithSourceHashes(rawProposedBundle, completeSourceHashes);
    const workspace = this.resolver.get(snapshot.workspaceId, options.principal);
    const provenance = {
      kind: 'map-diff-render',
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'map-diff.v1',
      sourceHashes: sourceEvidence.sourceHashes,
      renderProfile: { offline: true, scale: options.scale ?? 1 },
      metadata: {
        sourceHashInventory: sourceEvidence.inventory,
        operationIds: operations.map(({ id }) => id).sort(),
        blockers: plan.blockers.map(({ code, operationId }) => ({ code, operationId })),
        binding: 'artifact links and content hashes are included in the transaction plan hash',
      },
    };
    const comparisonProvenance = (phase: 'before' | 'proposed') => ({
      ...provenance,
      kind: 'map-comparison-render',
      schemaVersion: 'map-render.v1',
      renderProfile: {
        offline: true,
        phase,
        layer: 'state',
        overlays: comparisonOverlays,
        scale: options.scale ?? 1,
      },
      metadata: {
        ...provenance.metadata,
        phase,
        proposedFiles: plan.changes.map(({ relativePath }) => relativePath).sort(),
      },
    });
    const writes: ArtifactWrite[] = [
      {
        name: 'map-diff.png',
        mimeType: 'image/png',
        content: bundle.png,
        provenance,
      },
      {
        name: 'map-diff.json',
        mimeType: 'application/json',
        content: bundle.json,
        provenance,
      },
      {
        name: 'map-diff.html',
        mimeType: 'text/html',
        content: bundle.html,
        provenance,
      },
      {
        name: 'map-before.png',
        mimeType: 'image/png',
        content: beforeBundle.png,
        provenance: comparisonProvenance('before'),
      },
      {
        name: 'map-before.json',
        mimeType: 'application/json',
        content: beforeBundle.json,
        provenance: comparisonProvenance('before'),
      },
      {
        name: 'map-before.html',
        mimeType: 'text/html',
        content: beforeBundle.html,
        provenance: comparisonProvenance('before'),
      },
      {
        name: 'map-proposed.png',
        mimeType: 'image/png',
        content: proposedBundle.png,
        provenance: comparisonProvenance('proposed'),
      },
      {
        name: 'map-proposed.json',
        mimeType: 'application/json',
        content: proposedBundle.json,
        provenance: comparisonProvenance('proposed'),
      },
      {
        name: 'map-proposed.html',
        mimeType: 'text/html',
        content: proposedBundle.html,
        provenance: comparisonProvenance('proposed'),
      },
    ];
    const artifacts = await this.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (stored) => Promise.resolve([...stored]),
      options.signal,
    );
    return {
      bundle,
      beforeBundle,
      proposedBundle,
      plan,
      artifacts,
      revision: snapshot.revision,
      filesScanned: snapshot.files.map(({ displayPath }) => displayPath),
    };
  }
}

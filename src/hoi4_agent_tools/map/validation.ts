import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { assertRenderDimensions } from '../core/render-budget.js';
import { addActiveMapDiagnostic, addMapDiagnostic } from './diagnostic-limit.js';
import type { ValidationSummary } from '../core/result.js';
import { rgbKey } from './bmp.js';
import { MAP_PROVINCE_ENGINE_MAX_PIXELS } from './model.js';
import type {
  ProvinceDefinition,
  ProvinceRaster,
  StateRecord,
  StrategicRegionRecord,
  TextFileDocument,
} from './model.js';
import type { MapWorkspaceIndex } from './model.js';

export interface MapValidationOptions {
  operationId?: string;
  expectedChangedBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  baseline?: MapWorkspaceIndex;
  includeBaselineDiagnostics?: boolean;
  signal?: AbortSignal;
}

export interface MapValidationResult {
  passed: boolean;
  diagnostics: Diagnostic[];
  checks: ValidationSummary['checks'];
}

type MapValidationSteps<T> = Generator<void, T, void>;
const MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT = 100;

function* cancellationCheckpoint(
  signal: AbortSignal | undefined,
  iteration = 0,
  stride = 1,
): MapValidationSteps<void> {
  if (iteration % stride !== 0) return;
  signal?.throwIfAborted();
  yield;
}

function completeSynchronously<T>(steps: MapValidationSteps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function completeCooperatively<T>(
  steps: MapValidationSteps<T>,
  signal?: AbortSignal,
): Promise<T> {
  let yieldDeadline = performance.now() + 8;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    signal?.throwIfAborted();
    if (performance.now() < yieldDeadline) continue;
    await yieldToEventLoop();
    signal?.throwIfAborted();
    yieldDeadline = performance.now() + 8;
  }
}

function lineLocation(
  document: TextFileDocument,
  oneBasedLine: number,
): SourceLocation | undefined {
  const line = document.lines[oneBasedLine - 1];
  if (line === undefined) return undefined;
  return {
    path: document.file.displayPath,
    start: { line: oneBasedLine, column: 1, offset: line.start },
    end: { line: oneBasedLine, column: line.text.length + 1, offset: line.end },
  };
}

function requiredLineLocation(document: TextFileDocument, oneBasedLine: number): SourceLocation {
  return (
    lineLocation(document, oneBasedLine) ?? {
      path: document.file.displayPath,
      start: { line: oneBasedLine, column: 1, offset: 0 },
      end: { line: oneBasedLine, column: 1, offset: 0 },
    }
  );
}

function definitionLocation(definition: ProvinceDefinition): SourceLocation {
  return requiredLineLocation(definition.document, definition.line);
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  options: MapValidationOptions,
  diagnostic: Diagnostic,
): void {
  const add =
    options.includeBaselineDiagnostics === true ? addActiveMapDiagnostic : addMapDiagnostic;
  add(diagnostics, {
    ...diagnostic,
    ...(diagnostic.operationId !== undefined || options.operationId === undefined
      ? {}
      : { operationId: options.operationId }),
  });
}

function duplicateValues<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const group = groups.get(id) ?? [];
    group.push(value);
    groups.set(id, group);
  }
  return new Map([...groups].filter(([, group]) => group.length > 1));
}

function contiguousMissing(
  ids: readonly number[],
  start: number,
): { sample: number[]; total: number } {
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  const sample: number[] = [];
  let total = 0;
  let expected = start;
  for (const id of sorted) {
    if (!Number.isSafeInteger(id) || id < expected) continue;
    if (id > expected) {
      const gap = id - expected;
      total += gap;
      for (let missing = expected; missing < id && sample.length < 100; missing += 1) {
        sample.push(missing);
      }
    }
    expected = id + 1;
  }
  return { sample, total };
}

function stateLocation(state: StateRecord): SourceLocation {
  return {
    path: state.file.displayPath,
    start: {
      line: state.assignment.key.token.line,
      column: state.assignment.key.token.column,
      offset: state.assignment.start,
    },
    end: {
      line: state.assignment.key.token.line,
      column: state.assignment.key.token.column + state.assignment.key.token.text.length,
      offset: state.assignment.end,
    },
    symbol: String(state.id),
  };
}

function regionLocation(region: StrategicRegionRecord): SourceLocation {
  return {
    path: region.file.displayPath,
    start: {
      line: region.assignment.key.token.line,
      column: region.assignment.key.token.column,
      offset: region.assignment.start,
    },
    end: {
      line: region.assignment.key.token.line,
      column: region.assignment.key.token.column + region.assignment.key.token.text.length,
      offset: region.assignment.end,
    },
    symbol: String(region.id),
  };
}

function* provinceComponents(
  raster: ProvinceRaster,
  signal?: AbortSignal,
): MapValidationSteps<Map<number, number>> {
  assertRenderDimensions(raster.width, raster.height, 'map validation raster');
  const visited = new Uint8Array(raster.provinceIds.length);
  const counts = new Map<number, number>();
  const queue = new Int32Array(raster.provinceIds.length);
  for (let start = 0; start < raster.provinceIds.length; start += 1) {
    yield* cancellationCheckpoint(signal, start, 4096);
    const id = raster.provinceIds[start] ?? -1;
    if (id < 0 || visited[start] === 1) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      yield* cancellationCheckpoint(signal, head, 4096);
      const offset = queue[head++] ?? -1;
      const x = offset % raster.width;
      const y = Math.floor(offset / raster.width);
      const neighbors = [
        y * raster.width + (x === 0 ? raster.width - 1 : x - 1),
        y * raster.width + (x === raster.width - 1 ? 0 : x + 1),
        y === 0 ? -1 : offset - raster.width,
        y === raster.height - 1 ? -1 : offset + raster.width,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] === 1 || raster.provinceIds[neighbor] !== id)
          continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
  }
  return counts;
}

function* provinceThinPixels(
  raster: ProvinceRaster,
  signal?: AbortSignal,
): MapValidationSteps<Set<number>> {
  const result = new Set<number>();
  for (let y = 1; y < raster.height - 1; y += 1) {
    yield* cancellationCheckpoint(signal, y, 16);
    for (let x = 0; x < raster.width; x += 1) {
      const offset = y * raster.width + x;
      const id = raster.provinceIds[offset] ?? -1;
      if (id < 0) continue;
      const left =
        raster.provinceIds[y * raster.width + (x === 0 ? raster.width - 1 : x - 1)] === id;
      const right =
        raster.provinceIds[y * raster.width + (x === raster.width - 1 ? 0 : x + 1)] === id;
      const up = raster.provinceIds[offset - raster.width] === id;
      const down = raster.provinceIds[offset + raster.width] === id;
      if ((left && right && !up && !down) || (!left && !right && up && down)) result.add(id);
    }
  }
  return result;
}

interface ProvinceEulerSamples {
  one: number;
  three: number;
  diagonal: number;
}

function addEulerSample(
  samples: Map<number, ProvinceEulerSamples>,
  id: number,
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
): void {
  if (id <= 0) return;
  const matches =
    Number(topLeft === id) +
    Number(topRight === id) +
    Number(bottomLeft === id) +
    Number(bottomRight === id);
  if (matches !== 1 && matches !== 3 && matches !== 2) return;
  const current = samples.get(id) ?? { one: 0, three: 0, diagonal: 0 };
  if (matches === 1) current.one += 1;
  else if (matches === 3) current.three += 1;
  else if (
    (topLeft === id && bottomRight === id && topRight !== id && bottomLeft !== id) ||
    (topRight === id && bottomLeft === id && topLeft !== id && bottomRight !== id)
  ) {
    current.diagonal += 1;
  }
  samples.set(id, current);
}

/**
 * Count enclosed background components with the 4-connected digital Euler
 * characteristic. One padded 2x2 pass covers every province, avoiding a
 * province-by-province flood fill. Provinces touching the horizontally wrapping
 * map seam are omitted because planar padding cannot model their cylindrical
 * topology without inventing a boundary.
 */
function* provinceHoleCounts(
  raster: ProvinceRaster,
  components: ReadonlyMap<number, number>,
  signal?: AbortSignal,
): MapValidationSteps<Map<number, number>> {
  const samples = new Map<number, ProvinceEulerSamples>();
  const at = (x: number, y: number): number =>
    x < 0 || x >= raster.width || y < 0 || y >= raster.height
      ? -1
      : (raster.provinceIds[y * raster.width + x] ?? -1);
  for (let y = -1; y < raster.height; y += 1) {
    yield* cancellationCheckpoint(signal, y + 1, 16);
    for (let x = -1; x < raster.width; x += 1) {
      const topLeft = at(x, y);
      const topRight = at(x + 1, y);
      const bottomLeft = at(x, y + 1);
      const bottomRight = at(x + 1, y + 1);
      addEulerSample(samples, topLeft, topLeft, topRight, bottomLeft, bottomRight);
      if (topRight !== topLeft)
        addEulerSample(samples, topRight, topLeft, topRight, bottomLeft, bottomRight);
      if (bottomLeft !== topLeft && bottomLeft !== topRight)
        addEulerSample(samples, bottomLeft, topLeft, topRight, bottomLeft, bottomRight);
      if (bottomRight !== topLeft && bottomRight !== topRight && bottomRight !== bottomLeft) {
        addEulerSample(samples, bottomRight, topLeft, topRight, bottomLeft, bottomRight);
      }
    }
  }
  const holes = new Map<number, number>();
  for (const [id, sample] of samples) {
    const geometry = raster.geometry.get(id);
    if (geometry === undefined || geometry.minX === 0 || geometry.maxX === raster.width - 1)
      continue;
    const eulerCharacteristic = Math.round((sample.one - sample.three - 2 * sample.diagonal) / 4);
    const count = (components.get(id) ?? 0) - eulerCharacteristic;
    if (count > 0) holes.set(id, count);
  }
  return holes;
}

function* validateGeometry(
  index: MapWorkspaceIndex,
  diagnostics: Diagnostic[],
  options: MapValidationOptions,
): MapValidationSteps<void> {
  yield* cancellationCheckpoint(options.signal);
  const bitmap = index.provinceBitmap;
  const raster = index.raster;
  if (bitmap === undefined || raster === undefined) return;
  const baselineBitmap = options.baseline?.provinceBitmap;
  if (baselineBitmap !== undefined) {
    const formatChanges: {
      changed: boolean;
      code: string;
      message: string;
      before: unknown;
      after: unknown;
    }[] = [
      {
        changed: baselineBitmap.width !== bitmap.width || baselineBitmap.height !== bitmap.height,
        code: 'MAP_BMP_DIMENSIONS_CHANGED',
        message: 'Province bitmap dimensions changed from the baseline',
        before: { width: baselineBitmap.width, height: baselineBitmap.height },
        after: { width: bitmap.width, height: bitmap.height },
      },
      {
        changed: baselineBitmap.dibSize !== bitmap.dibSize,
        code: 'MAP_BMP_DIB_CHANGED',
        message: 'Province bitmap DIB header type changed from the baseline',
        before: baselineBitmap.dibSize,
        after: bitmap.dibSize,
      },
      {
        changed: baselineBitmap.topDown !== bitmap.topDown,
        code: 'MAP_BMP_ORIENTATION_CHANGED',
        message: 'Province bitmap row orientation changed from the baseline',
        before: baselineBitmap.topDown ? 'top-down' : 'bottom-up',
        after: bitmap.topDown ? 'top-down' : 'bottom-up',
      },
      {
        changed: baselineBitmap.pixelOffset !== bitmap.pixelOffset,
        code: 'MAP_BMP_PIXEL_OFFSET_CHANGED',
        message: 'Province bitmap pixel-array offset changed from the baseline',
        before: baselineBitmap.pixelOffset,
        after: bitmap.pixelOffset,
      },
      {
        changed: baselineBitmap.bitsPerPixel !== bitmap.bitsPerPixel,
        code: 'MAP_BMP_BIT_DEPTH_CHANGED',
        message: 'Province bitmap bit depth changed from the baseline',
        before: baselineBitmap.bitsPerPixel,
        after: bitmap.bitsPerPixel,
      },
      {
        changed:
          JSON.stringify(baselineBitmap.palette.map(rgbKey)) !==
          JSON.stringify(bitmap.palette.map(rgbKey)),
        code: 'MAP_BMP_PALETTE_CHANGED',
        message: 'Province bitmap palette changed from the baseline',
        before: baselineBitmap.palette.map(rgbKey),
        after: bitmap.palette.map(rgbKey),
      },
      {
        changed: !baselineBitmap.bytes
          .subarray(0, baselineBitmap.pixelOffset)
          .equals(bitmap.bytes.subarray(0, bitmap.pixelOffset)),
        code: 'MAP_BMP_HEADER_CHANGED',
        message: 'Province bitmap file/DIB header bytes changed from the baseline',
        before: { bytes: baselineBitmap.pixelOffset },
        after: { bytes: bitmap.pixelOffset },
      },
    ];
    for (const change of formatChanges) {
      if (!change.changed) continue;
      addDiagnostic(diagnostics, options, {
        code: change.code,
        severity: 'blocker',
        category: 'map',
        message: change.message,
        details: { before: change.before, after: change.after },
      });
    }
  }
  if (bitmap.bitsPerPixel !== 24) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_PROVINCES_BPP_INVALID',
      severity: 'error',
      category: 'map',
      message: 'provinces.bmp must be an uncompressed 24-bit RGB bitmap',
    });
  }
  if (bitmap.width % 256 !== 0 || bitmap.height % 256 !== 0) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_DIMENSIONS_NOT_MULTIPLE_256',
      severity: 'error',
      category: 'map',
      message: 'Province bitmap width and height must be multiples of 256',
      details: { width: bitmap.width, height: bitmap.height },
    });
  }
  if (bitmap.width * bitmap.height > MAP_PROVINCE_ENGINE_MAX_PIXELS) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_AREA_ENGINE_LIMIT',
      severity: 'error',
      category: 'map',
      message: 'Province bitmap exceeds the documented engine area limit',
      details: { pixels: bitmap.width * bitmap.height },
    });
  }
  for (const unknown of raster.unknownColors) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_BITMAP_COLOR_UNREGISTERED',
      severity: 'error',
      category: 'map',
      message: `Bitmap color ${rgbKey(unknown.color)} has no definition`,
      details: {
        color: rgbKey(unknown.color),
        count: unknown.count,
        firstX: unknown.firstX,
        firstY: unknown.firstY,
      },
    });
  }
  if (raster.unknownColorCount > raster.unknownColors.length) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_BITMAP_COLOR_SAMPLE_LIMIT',
      severity: 'blocker',
      category: 'map',
      message: 'Bitmap contains more undefined colors than can be reported individually',
      details: {
        distinctColors: raster.unknownColorCount,
        retainedSamples: raster.unknownColors.length,
      },
    });
  }
  const components = yield* provinceComponents(raster, options.signal);
  const holes = yield* provinceHoleCounts(raster, components, options.signal);
  const thin = yield* provinceThinPixels(raster, options.signal);
  for (const definition of index.definitions) {
    if (definition.id === 0) continue;
    const geometry = raster.geometry.get(definition.id);
    if (geometry === undefined) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_DEFINITION_UNUSED',
        severity: 'error',
        category: 'map',
        message: `Province ${definition.id} has no pixels in provinces.bmp`,
        location: definitionLocation(definition),
      });
      continue;
    }
    if (geometry.pixelCount <= 8) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_TOO_SMALL',
        severity: 'warning',
        category: 'map',
        message: `Province ${definition.id} has only ${geometry.pixelCount} pixels`,
        location: definitionLocation(definition),
      });
    }
    if (
      geometry.maxX - geometry.minX + 1 > bitmap.width / 8 ||
      geometry.maxY - geometry.minY + 1 > bitmap.height / 8
    ) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_LARGE_BOUNDS',
        severity: 'warning',
        category: 'map',
        message: `Province ${definition.id} spans more than one eighth of a map dimension`,
        location: definitionLocation(definition),
      });
    }
    if ((components.get(definition.id) ?? 0) > 1) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_DISCONNECTED_REVIEW',
        severity: 'warning',
        category: 'map',
        message: `Province ${definition.id} has multiple disconnected components; review islands intentionally`,
        location: definitionLocation(definition),
        details: { components: components.get(definition.id) ?? 0 },
      });
    }
    if ((holes.get(definition.id) ?? 0) > 0) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_HOLE_REVIEW',
        severity: 'warning',
        category: 'map',
        message: `Province ${definition.id} encloses one or more holes; review enclaves and inland regions intentionally`,
        location: definitionLocation(definition),
        details: { holes: holes.get(definition.id) ?? 0 },
      });
    }
    if (thin.has(definition.id)) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_THIN_CORRIDOR_REVIEW',
        severity: 'warning',
        category: 'map',
        message: `Province ${definition.id} contains a one-pixel corridor`,
        location: definitionLocation(definition),
      });
    }
    const derivedCoastal = raster.coastalProvinceIds.has(definition.id);
    if (
      (definition.type === 'land' || definition.type === 'sea') &&
      definition.coastal !== derivedCoastal
    ) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_COASTAL_MISMATCH',
        severity: 'error',
        category: 'map',
        message: `Province ${definition.id} coastal field disagrees with bitmap adjacency`,
        location: definitionLocation(definition),
        details: { declared: definition.coastal, derived: derivedCoastal },
      });
    }
  }
  for (let y = 0; y + 1 < raster.height; y += 1) {
    yield* cancellationCheckpoint(options.signal, y, 16);
    for (let x = 0; x < raster.width; x += 1) {
      const right = x === raster.width - 1 ? 0 : x + 1;
      const ids = new Set<number>([
        raster.provinceIds[y * raster.width + x] ?? -1,
        raster.provinceIds[y * raster.width + right] ?? -1,
        raster.provinceIds[(y + 1) * raster.width + x] ?? -1,
        raster.provinceIds[(y + 1) * raster.width + right] ?? -1,
      ]);
      ids.delete(-1);
      if (ids.size === 4) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_INVALID_X_CROSSING',
          severity: 'error',
          category: 'map',
          message: `Four provinces meet at one pixel corner near ${x},${y}`,
          details: { x, y, provinceIds: [...ids].sort((left, rightId) => left - rightId) },
        });
      }
    }
  }
  if (baselineBitmap !== undefined && options.expectedChangedBounds !== undefined) {
    const bounds =
      baselineBitmap.width === bitmap.width && baselineBitmap.height === bitmap.height
        ? baselineBitmap.diffBounds(bitmap)
        : undefined;
    if (
      bounds !== undefined &&
      (bounds.minX < options.expectedChangedBounds.minX ||
        bounds.minY < options.expectedChangedBounds.minY ||
        bounds.maxX > options.expectedChangedBounds.maxX ||
        bounds.maxY > options.expectedChangedBounds.maxY)
    ) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PIXELS_CHANGED_OUTSIDE_OPERATION',
        severity: 'blocker',
        category: 'map',
        message: 'Province bitmap changed outside the operation bounds',
        details: { actual: bounds, expected: options.expectedChangedBounds },
      });
    }
  }
}

function* validateDefinitions(
  index: MapWorkspaceIndex,
  diagnostics: Diagnostic[],
  options: MapValidationOptions,
): MapValidationSteps<void> {
  yield* cancellationCheckpoint(options.signal);
  if (index.definitionFile === undefined) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_DEFINITION_FILE_MISSING',
      severity: 'error',
      category: 'map',
      message: 'The active definition.csv file is missing',
    });
  }
  if (index.provinceBitmapFile === undefined) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_PROVINCE_BITMAP_MISSING',
      severity: 'error',
      category: 'map',
      message: 'The active provinces.bmp file is missing',
    });
  }
  for (const [id, definitions] of index.duplicateDefinitionIds) {
    if (definitions.length < 2) continue;
    const firstDefinition = definitions[0];
    if (firstDefinition === undefined) continue;
    const relatedDefinitions = definitions
      .slice(1, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT + 1)
      .map(definitionLocation);
    addDiagnostic(diagnostics, options, {
      code: 'MAP_PROVINCE_ID_DUPLICATE',
      severity: 'error',
      category: 'map',
      message: `Province ID ${id} is defined more than once`,
      location: definitionLocation(firstDefinition),
      related: relatedDefinitions,
      details: { duplicateLocations: definitions.length - 1 },
    });
  }
  for (const [color, definitions] of index.duplicateColors) {
    if (definitions.length < 2) continue;
    const firstDefinition = definitions[0];
    if (firstDefinition === undefined) continue;
    addDiagnostic(diagnostics, options, {
      code: 'MAP_PROVINCE_COLOR_DUPLICATE',
      severity: 'error',
      category: 'map',
      message: `Province color ${color} is assigned more than once`,
      location: definitionLocation(firstDefinition),
    });
  }
  const missing = contiguousMissing(
    index.definitions.map(({ id }) => id),
    0,
  );
  if (missing.total > 0) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_PROVINCE_ID_GAP',
      severity: 'error',
      category: 'map',
      message: 'Province IDs must remain contiguous from zero',
      details: { missing: missing.sample, total: missing.total },
    });
  }
  for (const [definitionIndex, definition] of index.definitions.entries()) {
    yield* cancellationCheckpoint(options.signal, definitionIndex, 256);
    if (definition.type === 'land' && definition.continent === 0) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_LAND_CONTINENT_MISSING',
        severity: 'error',
        category: 'map',
        message: `Land province ${definition.id} has continent zero`,
        location: definitionLocation(definition),
      });
    }
    if (definition.type === 'sea' && definition.terrain !== 'ocean') {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_SEA_TERRAIN_INVALID',
        severity: 'error',
        category: 'map',
        message: `Sea province ${definition.id} must use ocean terrain`,
        location: definitionLocation(definition),
      });
    }
    if (definition.type === 'lake' && definition.terrain !== 'lakes') {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_LAKE_TERRAIN_INVALID',
        severity: 'error',
        category: 'map',
        message: `Lake province ${definition.id} must use lakes terrain`,
        location: definitionLocation(definition),
      });
    }
  }
}

function* validateStatesAndRegions(
  index: MapWorkspaceIndex,
  diagnostics: Diagnostic[],
  options: MapValidationOptions,
): MapValidationSteps<void> {
  yield* cancellationCheckpoint(options.signal);
  for (const [id, states] of duplicateValues(index.states, (state) => String(state.id))) {
    const firstState = states[0];
    if (firstState === undefined) continue;
    const relatedStates = states
      .slice(1, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT + 1)
      .map(stateLocation);
    addDiagnostic(diagnostics, options, {
      code: 'MAP_STATE_ID_DUPLICATE',
      severity: 'error',
      category: 'map',
      message: `State ID ${id} is defined more than once`,
      location: stateLocation(firstState),
      related: relatedStates,
      details: { duplicateLocations: states.length - 1 },
    });
  }
  const stateMembership = new Map<number, StateRecord[]>();
  for (const [stateIndex, state] of index.states.entries()) {
    yield* cancellationCheckpoint(options.signal, stateIndex, 64);
    if (state.owner === undefined) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_STATE_OWNER_MISSING',
        severity: 'warning',
        category: 'map',
        message: `State ${state.id} has no owner and is unsafe for many effects`,
        location: stateLocation(state),
      });
    }
    if (state.controller !== undefined && state.owner === undefined) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_STATE_CONTROLLER_WITHOUT_OWNER',
        severity: 'error',
        category: 'map',
        message: `State ${state.id} defines a controller without an owner`,
        location: stateLocation(state),
      });
    }
    if (!index.localisationKeys.has(`l_english:${state.name}`)) {
      const proposedState =
        options.baseline !== undefined && !options.baseline.statesById.has(state.id);
      addDiagnostic(diagnostics, options, {
        code: proposedState
          ? 'MAP_NEW_STATE_LOCALISATION_MISSING'
          : 'MAP_STATE_LOCALISATION_MISSING',
        severity: proposedState ? 'error' : 'warning',
        category: 'map',
        message: `${proposedState ? 'Proposed' : 'Existing'} state ${state.id} name key ${state.name} has no English localisation`,
        location: stateLocation(state),
      });
    }
    if (state.capital !== undefined && !state.provinces.includes(state.capital)) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_STATE_CAPITAL_OUTSIDE_STATE',
        severity: 'error',
        category: 'map',
        message: `State ${state.id} capital ${state.capital} is not a member province`,
        location: stateLocation(state),
      });
    }
    for (const province of state.provinces) {
      const membership = stateMembership.get(province) ?? [];
      membership.push(state);
      stateMembership.set(province, membership);
      if (!index.definitionsById.has(province)) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_STATE_PROVINCE_INVALID',
          severity: 'error',
          category: 'map',
          message: `State ${state.id} refers to missing province ${province}`,
          location: stateLocation(state),
        });
      }
    }
    for (const victoryPoint of state.victoryPoints) {
      if (!state.provinces.includes(victoryPoint.provinceId)) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_VICTORY_POINT_OUTSIDE_STATE',
          severity: 'error',
          category: 'map',
          message: `Victory point ${victoryPoint.provinceId} is not in state ${state.id}`,
          location: stateLocation(state),
        });
      }
    }
    for (const province of state.provinceBuildings.keys()) {
      if (!state.provinces.includes(province)) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_PROVINCE_BUILDING_OUTSIDE_STATE',
          severity: 'error',
          category: 'map',
          message: `Province building entry ${province} is not in state ${state.id}`,
          location: stateLocation(state),
        });
      }
    }
  }
  for (const [definitionIndex, definition] of index.definitions.entries()) {
    yield* cancellationCheckpoint(options.signal, definitionIndex, 256);
    if (definition.id === 0) continue;
    const memberships = stateMembership.get(definition.id) ?? [];
    if (definition.type === 'land' && memberships.length === 0) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_LAND_PROVINCE_STATE_MISSING',
        severity: 'error',
        category: 'map',
        message: `Land province ${definition.id} is in no state`,
        location: definitionLocation(definition),
      });
    }
    if (memberships.length > 1) {
      const relatedStates = memberships
        .slice(0, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT)
        .map(stateLocation);
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_STATE_DUPLICATE',
        severity: 'error',
        category: 'map',
        message: `Province ${definition.id} is assigned to multiple states`,
        location: definitionLocation(definition),
        related: relatedStates,
        details: { memberships: memberships.length },
      });
    }
    if ((definition.type === 'sea' || definition.type === 'lake') && memberships.length > 0) {
      addDiagnostic(diagnostics, options, {
        code:
          definition.type === 'sea' ? 'MAP_SEA_PROVINCE_IN_STATE' : 'MAP_LAKE_PROVINCE_IN_STATE',
        severity: 'error',
        category: 'map',
        message: `${definition.type === 'sea' ? 'Sea' : 'Lake'} province ${definition.id} must not be assigned to a state`,
        location: definitionLocation(definition),
      });
    }
  }
  for (const [id, regions] of duplicateValues(index.regions, (region) => String(region.id))) {
    const firstRegion = regions[0];
    if (firstRegion === undefined) continue;
    const relatedRegions = regions
      .slice(1, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT + 1)
      .map(regionLocation);
    addDiagnostic(diagnostics, options, {
      code: 'MAP_STRATEGIC_REGION_ID_DUPLICATE',
      severity: 'error',
      category: 'map',
      message: `Strategic region ID ${id} is defined more than once`,
      location: regionLocation(firstRegion),
      related: relatedRegions,
      details: { duplicateLocations: regions.length - 1 },
    });
  }
  const regionMembership = new Map<number, StrategicRegionRecord[]>();
  for (const [regionIndex, region] of index.regions.entries()) {
    yield* cancellationCheckpoint(options.signal, regionIndex, 64);
    for (const province of region.provinces) {
      const membership = regionMembership.get(province) ?? [];
      membership.push(region);
      regionMembership.set(province, membership);
      if (!index.definitionsById.has(province)) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_REGION_PROVINCE_INVALID',
          severity: 'error',
          category: 'map',
          message: `Strategic region ${region.id} refers to missing province ${province}`,
          location: regionLocation(region),
        });
      }
    }
  }
  for (const [definitionIndex, definition] of index.definitions.entries()) {
    yield* cancellationCheckpoint(options.signal, definitionIndex, 256);
    if (definition.id === 0) continue;
    const memberships = regionMembership.get(definition.id) ?? [];
    if (memberships.length === 0) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_REGION_MISSING',
        severity: 'error',
        category: 'map',
        message: `Province ${definition.id} is in no strategic region`,
        location: definitionLocation(definition),
      });
    } else if (memberships.length > 1) {
      const relatedRegions = memberships
        .slice(0, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT)
        .map(regionLocation);
      addDiagnostic(diagnostics, options, {
        code: 'MAP_PROVINCE_REGION_DUPLICATE',
        severity: 'error',
        category: 'map',
        message: `Province ${definition.id} is in multiple strategic regions`,
        location: definitionLocation(definition),
        related: relatedRegions,
        details: { memberships: memberships.length },
      });
    }
  }
  for (const [stateIndex, state] of index.states.entries()) {
    yield* cancellationCheckpoint(options.signal, stateIndex, 64);
    const regionIds = new Set(
      state.provinces.flatMap((province) =>
        (regionMembership.get(province) ?? []).map(({ id }) => id),
      ),
    );
    if (regionIds.size > 1) {
      const regionIdList = [...regionIds].sort((left, right) => left - right);
      addDiagnostic(diagnostics, options, {
        code: 'MAP_STATE_CROSSES_STRATEGIC_REGIONS',
        severity: 'error',
        category: 'map',
        message: `State ${state.id} spans multiple strategic regions`,
        location: stateLocation(state),
        details: {
          strategicRegionIds: regionIdList.slice(0, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT),
          strategicRegionCount: regionIdList.length,
        },
      });
    }
  }
}

function* validateNetworksAndAdjacencies(
  index: MapWorkspaceIndex,
  diagnostics: Diagnostic[],
  options: MapValidationOptions,
): MapValidationSteps<void> {
  yield* cancellationCheckpoint(options.signal);
  const specialPairs = new Set(
    index.adjacencies
      .filter(({ type }) => type === 'sea')
      .flatMap(({ from, to }) => [`${from}:${to}`, `${to}:${from}`]),
  );
  for (const [adjacencyIndex, adjacency] of index.adjacencies.entries()) {
    yield* cancellationCheckpoint(options.signal, adjacencyIndex, 128);
    const location = lineLocation(adjacency.document, adjacency.line);
    const from = index.definitionsById.get(adjacency.from);
    const to = index.definitionsById.get(adjacency.to);
    if (from === undefined || to === undefined || adjacency.from === adjacency.to) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_ADJACENCY_PROVINCE_INVALID',
        severity: 'error',
        category: 'map',
        message: `Adjacency ${adjacency.from}-${adjacency.to} has invalid endpoints`,
        ...(location === undefined ? {} : { location }),
      });
      continue;
    }
    if (adjacency.type === 'sea') {
      if (from.type !== to.type) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_SEA_ADJACENCY_TYPE_MISMATCH',
          severity: 'error',
          category: 'map',
          message: 'Sea adjacency endpoints must have the same province type',
          ...(location === undefined ? {} : { location }),
        });
      }
      const directlyAdjacent =
        index.raster?.adjacency.get(adjacency.from)?.has(adjacency.to) ?? false;
      if (!directlyAdjacent && adjacency.through < 0) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_ADJACENCY_THROUGH_MISSING',
          severity: 'error',
          category: 'map',
          message: 'Non-border sea adjacency requires a through province',
          ...(location === undefined ? {} : { location }),
        });
      }
      if (adjacency.through >= 0 && !index.definitionsById.has(adjacency.through)) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_ADJACENCY_THROUGH_INVALID',
          severity: 'error',
          category: 'map',
          message: `Adjacency through province ${adjacency.through} does not exist`,
          ...(location === undefined ? {} : { location }),
        });
      }
    } else if (adjacency.type === 'impassable') {
      if (
        adjacency.through !== -1 ||
        adjacency.startX !== -1 ||
        adjacency.startY !== -1 ||
        adjacency.stopX !== -1 ||
        adjacency.stopY !== -1 ||
        adjacency.rule !== ''
      ) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_IMPASSABLE_FIELDS_INVALID',
          severity: 'error',
          category: 'map',
          message: 'Impassable adjacency must leave through, coordinates, and rule unset',
          ...(location === undefined ? {} : { location }),
        });
      }
    } else {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_ADJACENCY_TYPE_UNKNOWN',
        severity: 'error',
        category: 'map',
        message: `Unknown adjacency type ${adjacency.type}`,
        ...(location === undefined ? {} : { location }),
      });
    }
  }
  const supplyDuplicates = duplicateValues(index.supplyNodes, ({ provinceId }) =>
    String(provinceId),
  );
  for (const [province, nodes] of supplyDuplicates) {
    const firstNode = nodes[0];
    if (firstNode === undefined) continue;
    addDiagnostic(diagnostics, options, {
      code: 'MAP_SUPPLY_NODE_DUPLICATE',
      severity: 'error',
      category: 'map',
      message: `Province ${province} contains multiple starting supply nodes`,
      location: requiredLineLocation(firstNode.document, firstNode.line),
    });
  }
  for (const [nodeIndex, node] of index.supplyNodes.entries()) {
    yield* cancellationCheckpoint(options.signal, nodeIndex, 128);
    const definition = index.definitionsById.get(node.provinceId);
    if (
      node.level !== 1 ||
      definition?.type !== 'land' ||
      index.stateForProvince(node.provinceId).length !== 1
    ) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_SUPPLY_NODE_INVALID',
        severity: 'error',
        category: 'map',
        message: `Supply node ${node.provinceId} must be level 1 in one stateful land province`,
        location: requiredLineLocation(node.document, node.line),
      });
    }
  }
  for (const [railwayIndex, railway] of index.railways.entries()) {
    yield* cancellationCheckpoint(options.signal, railwayIndex, 64);
    const location = lineLocation(railway.document, railway.line);
    if (
      railway.level < 1 ||
      railway.level > 5 ||
      railway.declaredCount !== railway.provinces.length ||
      railway.provinces.length < 2
    ) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_RAILWAY_HEADER_INVALID',
        severity: 'error',
        category: 'map',
        message: 'Railway level, count, or length is invalid',
        ...(location === undefined ? {} : { location }),
      });
    }
    for (const province of railway.provinces) {
      if (
        index.definitionsById.get(province)?.type !== 'land' ||
        index.stateForProvince(province).length !== 1
      ) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_RAILWAY_PROVINCE_INVALID',
          severity: 'error',
          category: 'map',
          message: `Railway uses missing or stateless non-land province ${province}`,
          ...(location === undefined ? {} : { location }),
        });
      }
    }
    for (let offset = 1; offset < railway.provinces.length; offset += 1) {
      const left = railway.provinces[offset - 1];
      const right = railway.provinces[offset];
      if (left === undefined || right === undefined) continue;
      if (
        !(index.raster?.adjacency.get(left)?.has(right) ?? false) &&
        !specialPairs.has(`${left}:${right}`)
      ) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_RAILWAY_DISJOINT',
          severity: 'error',
          category: 'map',
          message: `Railway jumps between non-adjacent provinces ${left} and ${right}`,
          ...(location === undefined ? {} : { location }),
        });
      }
    }
  }
}

function* validatePositions(
  index: MapWorkspaceIndex,
  diagnostics: Diagnostic[],
  options: MapValidationOptions,
): MapValidationSteps<void> {
  yield* cancellationCheckpoint(options.signal);
  if (
    index.activeFiles.byRelativePath.has('map/buildings.txt') &&
    index.buildingPositions.length === 0
  ) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_BUILDINGS_FILE_EMPTY',
      severity: 'error',
      category: 'map',
      message: 'buildings.txt must not be entirely empty',
    });
  }
  const navalLocatorProvinces = new Set<number>();
  for (const [positionIndex, position] of index.buildingPositions.entries()) {
    yield* cancellationCheckpoint(options.signal, positionIndex, 128);
    const location = lineLocation(position.document, position.line);
    const state = index.statesById.get(position.stateId);
    const province = index.provinceAtMapCoordinate(position.x, position.z);
    if (state === undefined || province === undefined || !state.provinces.includes(province)) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_BUILDING_POSITION_INVALID',
        severity: 'error',
        category: 'map',
        message: `Building position does not resolve inside state ${position.stateId}`,
        ...(location === undefined ? {} : { location }),
        details: { resolvedProvince: province },
      });
    }
    if (position.building === 'naval_base_spawn' || position.building === 'floating_harbor') {
      if (province !== undefined) navalLocatorProvinces.add(province);
      const adjacent = index.definitionsById.get(position.adjacentSeaProvince);
      if (adjacent?.type !== 'sea') {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_PORT_ADJACENT_SEA_INVALID',
          severity: 'error',
          category: 'map',
          message: `${position.building} must identify an adjacent sea province`,
          ...(location === undefined ? {} : { location }),
        });
      } else if (
        province !== undefined &&
        !(index.raster?.adjacency.get(province)?.has(position.adjacentSeaProvince) ?? false)
      ) {
        addDiagnostic(diagnostics, options, {
          code: 'MAP_PORT_SEA_NOT_ADJACENT',
          severity: 'error',
          category: 'map',
          message: `Port position sea ${position.adjacentSeaProvince} does not border province ${province}`,
          ...(location === undefined ? {} : { location }),
        });
      }
    } else if (position.adjacentSeaProvince !== 0) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_NON_PORT_ADJACENT_SEA_SET',
        severity: 'warning',
        category: 'map',
        message: `${position.building} should leave adjacent sea province at zero`,
        ...(location === undefined ? {} : { location }),
      });
    }
  }
  for (const [stateIndex, state] of index.states.entries()) {
    yield* cancellationCheckpoint(options.signal, stateIndex, 64);
    for (const [province, buildings] of state.provinceBuildings) {
      if ((buildings.get('naval_base') ?? 0) > 0) {
        if (!(index.raster?.coastalProvinceIds.has(province) ?? false)) {
          addDiagnostic(diagnostics, options, {
            code: 'MAP_PORT_NOT_COASTAL',
            severity: 'error',
            category: 'map',
            message: `Naval base province ${province} is not coastal`,
            location: stateLocation(state),
          });
        }
        if (!navalLocatorProvinces.has(province)) {
          addDiagnostic(diagnostics, options, {
            code: 'MAP_PORT_LOCATOR_MISSING',
            severity: 'error',
            category: 'map',
            message: `Naval base province ${province} has no naval_base_spawn entry`,
            location: stateLocation(state),
          });
        }
      }
    }
  }
  for (const [positionIndex, position] of index.unitPositions.entries()) {
    yield* cancellationCheckpoint(options.signal, positionIndex, 128);
    const location = lineLocation(position.document, position.line);
    const resolved = index.provinceAtMapCoordinate(position.x, position.z);
    if (!index.definitionsById.has(position.provinceId) || resolved !== position.provinceId) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_UNIT_POSITION_INVALID',
        severity: 'error',
        category: 'map',
        message: `Unit position for province ${position.provinceId} resolves to ${resolved ?? 'no province'}`,
        ...(location === undefined ? {} : { location }),
      });
    }
    if (position.type < 0 || position.type > 38 || !Number.isInteger(position.type)) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_UNIT_POSITION_TYPE_INVALID',
        severity: 'error',
        category: 'map',
        message: `Unit position type ${position.type} is outside 0..38`,
        ...(location === undefined ? {} : { location }),
      });
    }
  }
  let hasSmallWeather = false;
  let hasBigWeather = false;
  for (const [positionIndex, position] of index.weatherPositions.entries()) {
    yield* cancellationCheckpoint(options.signal, positionIndex, 128);
    if (!index.regionsById.has(position.strategicRegionId)) {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_WEATHER_REGION_INVALID',
        severity: 'error',
        category: 'map',
        message: `Weather position refers to missing region ${position.strategicRegionId}`,
        location: requiredLineLocation(position.document, position.line),
      });
    }
    hasSmallWeather ||= position.size === 'small';
    hasBigWeather ||= position.size === 'big';
    if (position.size !== 'small' && position.size !== 'big') {
      addDiagnostic(diagnostics, options, {
        code: 'MAP_WEATHER_SIZE_INVALID',
        severity: 'error',
        category: 'map',
        message: `Weather position size must be small or big, not ${position.size}`,
        location: requiredLineLocation(position.document, position.line),
      });
    }
  }
  if (index.weatherPositions.length > 0 && (!hasSmallWeather || !hasBigWeather)) {
    addDiagnostic(diagnostics, options, {
      code: 'MAP_WEATHER_SIZE_CLASS_MISSING',
      severity: 'error',
      category: 'map',
      message: 'weatherpositions.txt must contain at least one small and one big object',
    });
  }
  for (const [key, locators] of duplicateValues(
    index.entityLocators,
    ({ entity, name }) => `${entity}:${name}`,
  )) {
    const files = locators
      .slice(0, MAP_DIAGNOSTIC_DETAIL_SAMPLE_LIMIT)
      .map(({ file }) => file.displayPath);
    addDiagnostic(diagnostics, options, {
      code: 'MAP_ENTITY_LOCATOR_DUPLICATE',
      severity: 'error',
      category: 'map',
      message: `Entity locator ${key} is defined more than once in the same indexed set`,
      details: { files, fileCount: locators.length },
    });
  }
}

function* validateMapSteps(
  index: MapWorkspaceIndex,
  options: MapValidationOptions = {},
): MapValidationSteps<MapValidationResult> {
  yield* cancellationCheckpoint(options.signal);
  const diagnostics = [...index.diagnostics];
  yield* validateDefinitions(index, diagnostics, options);
  yield* cancellationCheckpoint(options.signal);
  yield* validateGeometry(index, diagnostics, options);
  yield* cancellationCheckpoint(options.signal);
  yield* validateStatesAndRegions(index, diagnostics, options);
  yield* cancellationCheckpoint(options.signal);
  yield* validateNetworksAndAdjacencies(index, diagnostics, options);
  yield* cancellationCheckpoint(options.signal);
  yield* validatePositions(index, diagnostics, options);
  yield* cancellationCheckpoint(options.signal);
  const sorted = sortDiagnostics(diagnostics);
  const checks = [
    {
      id: 'map-files-and-definitions',
      passed: !sorted.some(({ code, severity }) =>
        severity === 'error' || severity === 'blocker'
          ? code.startsWith('MAP_DEFINITION') ||
            code.startsWith('MAP_PROVINCE_ID') ||
            code.startsWith('MAP_PROVINCE_COLOR') ||
            code === 'MAP_PROVINCE_BITMAP_MISSING'
          : false,
      ),
      message: 'Province definitions, IDs, colors, and required files are valid',
    },
    {
      id: 'map-bitmap-geometry',
      passed: !sorted.some(
        ({ code, severity }) =>
          (severity === 'error' || severity === 'blocker') &&
          (code.startsWith('MAP_BMP') ||
            code.startsWith('MAP_BITMAP') ||
            code.startsWith('MAP_INVALID_X') ||
            code.startsWith('MAP_DIMENSIONS') ||
            code.startsWith('MAP_PIXELS')),
      ),
      message: 'Bitmap format and province geometry are valid',
    },
    {
      id: 'map-state-region-membership',
      passed: !sorted.some(
        ({ code, severity }) =>
          (severity === 'error' || severity === 'blocker') &&
          (code.startsWith('MAP_STATE') ||
            code.startsWith('MAP_LAND_PROVINCE_STATE') ||
            code.startsWith('MAP_PROVINCE_STATE') ||
            code.startsWith('MAP_PROVINCE_REGION') ||
            code.startsWith('MAP_STRATEGIC_REGION')),
      ),
      message: 'State and strategic-region memberships are valid',
    },
    {
      id: 'map-networks-adjacencies',
      passed: !sorted.some(
        ({ code, severity }) =>
          (severity === 'error' || severity === 'blocker') &&
          (code.startsWith('MAP_ADJACENCY') ||
            code.startsWith('MAP_IMPASSABLE') ||
            code.startsWith('MAP_SEA_ADJACENCY') ||
            code.startsWith('MAP_SUPPLY') ||
            code.startsWith('MAP_RAILWAY')),
      ),
      message: 'Adjacencies, supply nodes, and railways are valid',
    },
    {
      id: 'map-positions-locators',
      passed: !sorted.some(
        ({ code, severity }) =>
          (severity === 'error' || severity === 'blocker') &&
          (code.startsWith('MAP_BUILDING') ||
            code.startsWith('MAP_PORT') ||
            code.startsWith('MAP_UNIT_POSITION') ||
            code.startsWith('MAP_WEATHER') ||
            code.startsWith('MAP_ENTITY_LOCATOR')),
      ),
      message: 'Map positions, ports, and entity locators are valid',
    },
  ];
  const passed =
    checks.every((check) => check.passed) &&
    !sorted.some(({ severity }) => severity === 'error' || severity === 'blocker');
  return { passed, diagnostics: sorted, checks };
}

export function validateMap(
  index: MapWorkspaceIndex,
  options: MapValidationOptions = {},
): MapValidationResult {
  return completeSynchronously(validateMapSteps(index, options));
}

/** Validates map geometry and records while yielding so protocol cancellation can be delivered. */
export async function validateMapAsync(
  index: MapWorkspaceIndex,
  options: MapValidationOptions = {},
): Promise<MapValidationResult> {
  return completeCooperatively(validateMapSteps(index, options), options.signal);
}
